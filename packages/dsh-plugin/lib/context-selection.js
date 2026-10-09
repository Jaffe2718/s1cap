import { adaptMessages, segmentEvent } from '@s1cap/core';
                                                            

const record = (value         )                                   => typeof value === 'object' && value !== null;

/** Apply S1 selection through DSH's durable surface, preserving native tool pairs.
 * Only older, single-text tool results can be shortened. Instructions, original
 * user messages, assistant calls, recent results, selected and unjudged chunks
 * stay intact. No model request or transcript array is patched in memory.
 */
export function selectToolContext(payload         , observation                 ,
  rejected                    , recentMessages        )                                                            {
  const skip = (reason        ) => ({ changed: 0, removedChars: 0, reason });
  if (!record(payload) || !record(payload['agent']) || !record(payload['agent']['session'])) return skip('no session');
  const session = payload['agent']['session'];
  if (!record(session['surface']) || !Array.isArray(session['surface']['nodes']) ||
      typeof session['eventAt'] !== 'function' || typeof session['deriveEventMessage'] !== 'function' ||
      typeof session['append'] !== 'function') return skip('host has no durable surface replacement API');
  const nodes = session['surface']['nodes'].slice()            ;
  const protectedIds = new Set([...observation.layout.tail, observation.layout.anchor]
    .map((segment) => segment.chunkOf ?? segment.id));
  const selectedIds = new Set(observation.layout.recalled.map((segment) => segment.id));
  const rejectedText = new Map(rejected.filter((segment) => segment.kind === 'toolResult')
    .map((segment) => [segment.id, segment.text]));
  if (rejectedText.size === 0) return skip('no explicit S1 tool-output rejections');
  const eventAt = session['eventAt']                            ;
  const derive = session['deriveEventMessage']                               ;
  const append = session['append']                                                             ;
  let changed = 0, removedChars = 0;
  const older = nodes.slice(0, Math.max(0, nodes.length - Math.max(3, recentMessages)));
  for (const seq of older) {
    const event = eventAt.call(session, seq);
    if (!record(event) || event['type'] !== 'tool/result' || !record(event['data']) ||
        !record(event['data']['message'])) continue;
    const message = derive.call(session, event);
    if (!record(message) || typeof message['id'] !== 'string' || protectedIds.has(message['id']) ||
        !Array.isArray(message['content']) || message['content'].length !== 1) continue;
    const part = message['content'][0];
    if (!record(part) || part['type'] !== 'text' || typeof part['text'] !== 'string') continue;
    // Compare current chunk text too: a retained id after native compaction or
    // an earlier rewrite must never turn a score for old text into a deletion.
    const chunks = adaptMessages([message], { sessionId: observation.event.sessionId, startSeq: seq, now: 0 })
      .events.flatMap((raw) => segmentEvent(raw));
    if (chunks.length < 2) continue;
    const kept = chunks.filter((chunk) => selectedIds.has(chunk.id) || rejectedText.get(chunk.id) !== chunk.text);
    if (kept.length === 0 || kept.length === chunks.length) continue;
    const text = kept.map((chunk) => `## tool result excerpt · ${chunk.id}\n${chunk.text}`).join('\n\n');
    if (text.length >= part['text'].length) continue;
    // The shipped DSH contract permits changing ONLY message.content here.
    // Original turn/step/source/id/toolCallId/error metadata remain verbatim.
    try {
      append.call(session, 'tool/result', { ...event['data'], message: {
        ...event['data']['message'], content: [{ ...part, text }],
      } }, { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] });
    } catch {
      return { changed, removedChars, reason: 'host rejected replacement; remaining content preserved' };
    }
    changed++;
    removedChars += part['text'].length - text.length;
  }
  return { changed, removedChars, reason: changed > 0 ? 'S1 selected tool output on the durable surface' : 'protected or unchanged content' };
}
