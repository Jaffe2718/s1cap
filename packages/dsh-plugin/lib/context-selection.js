import { adaptMessages, estimateTokens, segmentEvent } from '@s1cap/core';
                                                            
                                                    

const record = (value         )                                   => typeof value === 'object' && value !== null;

/** Apply S1 selection through DSH's durable surface, preserving native tool pairs.
 * Only older, single-text tool results can be shortened. Instructions, original
 * user messages, assistant calls, recent results, selected and unjudged chunks
 * stay intact. No model request or transcript array is patched in memory.
 * Scoring and graph upkeep have already run. Only the destructive write-back is
 * gated here: preserve short histories and require substantial net savings.
 */
export function selectToolContext(payload         , observation                 ,
  rejected                    , recentMessages        , options                                                     = {}) {
  const measurements                                                                                                                            = {};
  const skip = (reason        ) => ({ ...measurements, changed: 0, removedChars: 0, reason });
  if (!record(payload) || !record(payload['agent']) || !record(payload['agent']['session'])) return skip('no session');
  const session = payload['agent']['session'];
  if (!record(session['surface']) || !Array.isArray(session['surface']['nodes']) ||
      typeof session['eventAt'] !== 'function' || typeof session['deriveEventMessage'] !== 'function' ||
      typeof session['append'] !== 'function') return skip('host has no durable surface replacement API');
  const nodes = session['surface']['nodes'].slice()            ;
  const eventAt = session['eventAt']                            ;
  const derive = session['deriveEventMessage']                               ;
  const append = session['append']                                                             ;
  const sessionId = observation.event.sessionId;
  if (typeof sessionId !== 'string') return skip('session identity unavailable');
  const availableTokens = observation.event.budgetTotal;
  if (!Number.isFinite(availableTokens) || availableTokens <= 0) return skip('context budget unavailable; original evidence preserved');
  // The assembled/selected view is not the native request history. Count only
  // current surface nodes, excluding replaced/compacted log entries. Include
  // serialized structured parts (reasoning and tool arguments), not just text.
  const visible = new Map                                                                              ();
  let contextTokens = 0;
  for (const seq of nodes) {
    const event = eventAt.call(session, seq);
    if (!record(event)) return skip('surface event unavailable; original evidence preserved');
    const message = derive.call(session, event);
    if (!record(message) || !Array.isArray(message['content'])) return skip('surface content unavailable; original evidence preserved');
    visible.set(seq, { event, message });
    contextTokens += estimateTokens(JSON.stringify(message['content'])) + 8;
  }
  const contextThresholdTokens = Math.max(0, Math.min(options.shortContextTokens ?? 32_768, Math.floor(availableTokens / 2)));
  const minimumSavingTokens = Math.max(1_024, Math.ceil(contextTokens * 0.05));
  Object.assign(measurements, { contextTokens, contextThresholdTokens, minimumSavingTokens, potentialSavingTokens: 0 });
  if (contextTokens < contextThresholdTokens) return skip('short context; original evidence preserved');
  const protectedIds = new Set([...observation.layout.tail, observation.layout.anchor]
    .map((segment) => segment.chunkOf ?? segment.id));
  const selectedIds = new Set(observation.layout.recalled.map((segment) => segment.id));
  const rejectedText = new Map(rejected.filter((segment) => segment.kind === 'toolResult')
    .map((segment) => [segment.id, segment.text]));
  if (rejectedText.size === 0) return skip('no explicit S1 tool-output rejections');
  let changed = 0, removedChars = 0;
  const replacements                                                                                                                      = [];
  const older = nodes.slice(0, Math.max(0, nodes.length - Math.max(3, recentMessages)));
  for (const seq of older) {
    const { event, message } = visible.get(seq) ;
    if (event['type'] !== 'tool/result' || !record(event['data']) ||
        !record(event['data']['message'])) continue;
    if (typeof message['id'] !== 'string' || protectedIds.has(message['id']) ||
        !Array.isArray(message['content']) || message['content'].length !== 1) continue;
    const part = message['content'][0];
    if (!record(part) || part['type'] !== 'text' || typeof part['text'] !== 'string') continue;
    // Compare current chunk text too: a retained id after native compaction or
    // an earlier rewrite must never turn a score for old text into a deletion.
    const chunks = adaptMessages([{ ...message, id: message['id'] }], { sessionId, startSeq: seq, now: 0 })
      .events.flatMap((raw) => segmentEvent(raw, options));
    if (chunks.length < 2) continue;
    const kept = chunks.filter((chunk) => selectedIds.has(chunk.id) || rejectedText.get(chunk.id) !== chunk.text);
    if (kept.length === 0 || kept.length === chunks.length) continue;
    const text = kept.map((chunk) => `## tool result excerpt · ${chunk.id}\n${chunk.text}`).join('\n\n');
    if (text.length >= part['text'].length) continue;
    const saving = estimateTokens(part['text']) - estimateTokens(text);
    if (saving <= 0) continue;
    replacements.push({ seq, data: event['data'], part, text, removedChars: part['text'].length - text.length });
    measurements.potentialSavingTokens  += saving;
  }
  if (replacements.length === 0) return skip('protected or unchanged content');
  if (measurements.potentialSavingTokens  < minimumSavingTokens) return skip('insufficient net savings; original evidence preserved');
  for (const { seq, data, part, text, removedChars: savingChars } of replacements) {
    // The shipped DSH contract permits changing ONLY message.content here.
    // Original turn/step/source/id/toolCallId/error metadata remain verbatim.
    try {
      append.call(session, 'tool/result', { ...data, message: {
        ...(data['message']                           ), content: [{ ...part, text }],
      } }, { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] });
    } catch {
      return { ...measurements, changed, removedChars, reason: 'host rejected replacement; remaining content preserved' };
    }
    changed++;
    removedChars += savingChars;
  }
  return { ...measurements, changed, removedChars, reason: 'S1 selected tool output on the durable surface' };
}
