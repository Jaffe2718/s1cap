/**
 * REPLAY — the gate before the plugin is ever allowed to rewrite a prompt.
 *
 * A tape is a JSONL file with one line per LLM call: `{ "step": n, "messages": [ …harness messages… ] }`.
 * Replaying one through the same pure pipeline must reproduce the same records, field for field. If it does
 * not, no later result can be attributed to S1CAP rather than to noise, which is exactly why this exists
 * before the rewrite switch (docs/STATUS.md, item N3).
 *
 * The digest is deliberately **not** cryptographic: it is an equality check for replays, cheap and
 * dependency-free, over a stable serialisation of the records.
 */
                                                 
import { AssociationGraph } from './assoc-graph.js';
import { observeStep } from './observer.js';
                                                     
                                                    

export const TAPE_SCHEMA_VERSION = 1         ;

                           
               
                               
                        
 

                       
                                     
                    
                    
 

                                
                         
                                                          
              
                        
                              
                              
                   
 

                               
                           
                          
                            
                                                                                                  
                     
                 
 

/** Key-order-independent serialisation, so a digest cannot change because a field moved. */
export function stableStringify(value         )         {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value                           )
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/** FNV-1a, 32-bit. Non-cryptographic on purpose: an equality check, not a signature. */
export function fnv1a(text        )         {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function digestRecords(records                          )         {
  return fnv1a(records.map((record) => stableStringify(record)).join('\n'));
}

/** Parse a tape, skipping blank lines and refusing anything that is not a step. */
export function parseTape(text        , fallbackSessionId = 'tape')       {
  const steps             = [];
  let sessionId = fallbackSessionId;
  let explicitSessionId                    ;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const lineNumber = index + 1;
    let parsed         ;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error(`Tape line ${lineNumber}: invalid JSON`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Tape line ${lineNumber}: expected a step object`);
    }
    const record = parsed                           ;
    if (record['schema'] !== undefined && record['schema'] !== TAPE_SCHEMA_VERSION) {
      throw new Error(`Tape line ${lineNumber}: unsupported schema ${String(record['schema'])}`);
    }
    if (record['sessionId'] !== undefined) {
      if (typeof record['sessionId'] !== 'string' || record['sessionId'] === '') {
        throw new Error(`Tape line ${lineNumber}: invalid sessionId`);
      }
      if (explicitSessionId !== undefined && record['sessionId'] !== explicitSessionId) {
        throw new Error(`Tape line ${lineNumber}: sessionId changed`);
      }
      explicitSessionId = record['sessionId'];
      sessionId = record['sessionId'];
    }
    const messages = record['messages'];
    if (!Array.isArray(messages)) throw new Error(`Tape line ${lineNumber}: messages must be an array`);
    if (record['step'] !== undefined && (typeof record['step'] !== 'number' || !Number.isSafeInteger(record['step']) || record['step'] < 0)) {
      throw new Error(`Tape line ${lineNumber}: step must be a non-negative integer`);
    }
    steps.push({
      step: typeof record['step'] === 'number' ? record['step'] : steps.length + 1,
      messages,
      ...(typeof record['systemPrompt'] === 'string' ? { systemPrompt: record['systemPrompt'] } : {}),
    });
  }
  return { schema: TAPE_SCHEMA_VERSION, sessionId, steps };
}

/** Replay a tape through the pipeline. Pure: the same tape and options give the same digest. */
export async function replayTape(tape      , opts               )                        {
  const graph = new AssociationGraph();
  const records                  = [];
  const selectedIds             = [];
  const wouldSaveTokens           = [];
  let seq = 0;
  let emptySteps = 0;
  // the rendered prompt persists across calls, so a step that does not tape its own inherits the last one
  let carriedPrompt                    ;

  for (const step of tape.steps) {
    if (step.systemPrompt !== undefined) carriedPrompt = step.systemPrompt;
    const observation = await observeStep({
      sessionId: tape.sessionId,
      step: step.step,
      seq,
      messages: step.messages,
      ...(carriedPrompt !== undefined ? { systemPrompt: carriedPrompt } : {}),
      policy: opts.policy,
      now: opts.now,
      contextWindow: opts.contextWindow,
      reserveOutputTokens: opts.reserveOutputTokens,
      fixedOverheadTokens: opts.fixedOverheadTokens,
      lambdaMs: opts.lambdaMs,
      graph,
    });
    seq += step.messages.length;
    // A step that produced no segment has no record to replay. Counted rather than dropped silently, because a
    // tape that assembled nothing is a finding about the tape, not a gap in the report.
    if (observation.kind === 'empty') {
      emptySteps += 1;
      continue;
    }
    records.push(observation.event);
    selectedIds.push(observation.selectedIds);
    wouldSaveTokens.push(observation.wouldSaveTokens);
  }

  return { records, selectedIds, wouldSaveTokens, emptySteps, digest: digestRecords(records) };
}
