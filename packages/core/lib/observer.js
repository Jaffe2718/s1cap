/**
 * OBSERVER — read-only, per-LLM-call context accounting.
 *
 * M1 runs S1CAP in observation mode: the segmenter, the association graph and the assembler all run for
 * real, and the *result* is recorded in the control plane, but the prompt the model receives is returned
 * untouched. That is what makes the first milestone safe to run against a live session: nothing here can
 * change a single token the model sees, while the numbers we will later optimise are already measurable
 * (candidates, selected blocks, budget, cache-stable prefix, and the token delta against the full history).
 *
 * Everything is a pure function of its inputs — no clock reads, no randomness, no mutation of the caller's
 * messages — so a replay of the same step produces the same observation byte for byte
 * (`packages/core/test/observer.test.ts`).
 */
                                                                          
import { AssociationGraph } from './assoc-graph.js';
import { segmentEvent, estimateTokens } from './segmenter.js';
import { assemble, totalTokens } from './assembler.js';
import { adaptMessages } from './harness-adapter.js';
                                                          
import { TELEMETRY_SCHEMA_VERSION } from './telemetry.js';
import { buildStateProxy } from './state-proxy.js';
                                                    

                                   
                    
                                                                     
               
                                                                
              
                                                                                             
                               
     
                                                                                                          
                                                                                                     
                                                                                                
     
                        
                         
              
     
                                                                                                                
                                                                                                       
     
                
                     
                                   
                                                      
     
                                                                                                              
                                                                                                                
                                                                         
     
                                            
                        
                              
                              
                   
     
                                                                                                        
                                                                                                      
                                                                                               
     
                          
                                         
 

/** a step that produced an assembly and a control-plane record */
                                  
                    
                                                              
                       
                                              
                      
                                                                                         
                        
     
                                                                                                               
                                                                                                                
                                                          
     
                         
                     
                         
                                                                                
                          
                        
                                                                                     
                    
 

/**
 * A step that produced no assembly at all.
 *
 * This is a real shape, not a defensive fiction: a live `agent/pre-step` payload whose messages carry nothing the
 * adapter turns into a segment leaves the segment list empty, and there is then no "current" segment to anchor an
 * assembly on. The earlier code asserted non-null with `segments[segments.length - 1]!` and threw
 * `Cannot read properties of undefined (reading 'tokens')` from the assembler - once per step, swallowed by the
 * observer's own guard. It looked like a working install: the plugin stayed inert, the harness was fine, and the
 * control-plane log kept exactly one record from the primer. Reporting the case is what makes it visible.
 */
                                       
                
                                                                      
                 
                                                        
                   
     
                                                                                                              
                                                                                                               
                                            
     
                        
 

export async function observeStep(
  input                  ,
)                                                  {
  const { events, report } = adaptMessages(input.messages, {
    sessionId: input.sessionId,
    startSeq: input.seq,
    now: input.now,
    ...(input.reasoningPartTypes !== undefined ? { reasoningPartTypes: input.reasoningPartTypes } : {}),
  });

  // segmentEvent applies the I2 gate (provenance.ts): a control-plane record can never become a segment.
  const segments            = events.flatMap((ev) => segmentEvent(ev));
  input.graph.addSegments(segments);
  // recall.window = w: only segments that arrived since the previous step are scored, each against
  // the most recent w segments. Segments outside the window keep their edges and stay reachable. The result is
  // not read here - the graph keeps the running total - but the scoring itself must still happen, or the
  // segments this step added would stay unconnected to the window.
  await input.graph.scoreNew({
    windowN: input.policy.recall.window,
    threshold: input.policy.recall.relevanceThreshold,
    ...(input.scoreBatch !== undefined ? { scoreBatch: input.scoreBatch } : {}),
  });

  const pinned = segments.filter((s) => s.kind === 'systemPinned');
  // The rendered system prompt is pinned, never a recall candidate: it has to stay byte-stable at the front
  // of the prompt (that is what the prefix cache hits on) and relevance may not drop it.
  const promptText = input.systemPrompt?.trim() ?? '';
  if (promptText !== '') {
    pinned.unshift({
      id: 'system-prompt',
      sessionId: input.sessionId,
      kind: 'systemPinned',
      seq: input.seq,
      ts: input.now,
      tokens: estimateTokens(promptText),
      text: promptText,
    });
  }
  const anchor = lastIndexWhere(segments, (s) => s.kind === 'user');
  // Where the model view is taken from.
  //
  // This used to say: the payload's segments when it has any, the graph's append order otherwise, because the
  // graph is a superset and "using it never loses a segment the payload carried". The conclusion was right and
  // the direction was backwards, and the cost has now been measured. The graph IS a superset — which means
  // using the *payload* is the lossy choice, not the graph. At a turn-opening step the payload holds exactly one
  // new user message, so the pool is that message, `history` is empty, and there is nothing for relevance to
  // select: a live C4 run delivered the state proxy on 4 steps, every one of them with `blocks.recalled = 0`,
  // while the five steps that did have history (836 to 5243 tokens of it) were the steps the harness claims
  // nothing for — and an empty `decision.messages` means no request is made at all. Recall and delivery fired on
  // disjoint steps.
  //
  // The graph's ordered segments are the session's own append order, so they include everything the payload
  // carried and everything before it. That is the window a model call needs.
  const window            = input.graph.orderedSegments();
  const windowAnchor = anchor >= 0 ? anchor : lastIndexWhere(window, (s) => s.kind === 'user');
  const current = windowAnchor >= 0 ? window[windowAnchor] : window[window.length - 1];
  if (current === undefined) {
    // The counts are in the message on purpose. "No segment" alone was not enough to tell which stage dropped
    // the step, and guessing at it cost a whole session.
    return {
      kind: 'empty',
      reason:
        'no segment to assemble ' +
        `(messages=${input.messages.length} events=${events.length} reported=${report.messages} ` +
        `emptyMessages=${report.empty} parts=${report.parts} rawParts=${report.rawParts} ` +
        `graphSegments=${input.graph.stats().segments} ` +
        `unknownRoles=[${report.unknownRoles.join(',')}] unknownParts=[${report.unknownPartTypes.join(',')}])`,
      messages: input.messages.length,
      report,
    };
  }
  // Everything in the window except the anchor and the pinned prefix, in append order.
  //
  // This used to be "the segments before the anchor", which looked equivalent and was not: the anchor is the
  // last user segment, and the model's output for the current task - its messages, tool calls and tool results -
  // arrives *after* it in the append-only log. Slicing before the anchor therefore discarded exactly the newest
  // turns, and `tail` came out empty in every live record (blocks.tail = 0 across a whole run) while the k most
  // relevant verbatim turns were quietly not in the prompt at all.
  const pool = window.filter((s) => s.id !== current.id && s.kind !== 'systemPinned');
  // `tail` is the k most recent turns, verbatim. Which side of x they end up on is the layout's business and not
  // the selector's: with x last they sit immediately before it, with x first immediately after it.
  const tailCount = Math.max(0, Math.min(input.policy.tail.k, pool.length));
  const tail = tailCount > 0 ? pool.slice(pool.length - tailCount) : [];
  const history = pool.slice(0, pool.length - tailCount);
  // One-entry memo of the last built T. `perTask` is the default policy precisely so this can be a single slot:
  // within a task T does not change, and when the task changes the anchor id changes with it.
  const proxyCache = input.proxyCache ?? { id: '', text: '' };
  // `perTask` reuses the memo across the steps of one task; `perTurn` rebuilds every step, which is what that
  // policy means and is not free.
  const reuseProxy = input.policy.tas.updatePolicy === 'perTask' && proxyCache.id === current.id;
  const proxyText = reuseProxy
    ? proxyCache.text
    : buildStateProxy({
        segments: window,
        anchorId: current.id,
        maxChars: input.policy.tas.tMaxChars,
        updatePolicy: input.policy.tas.updatePolicy,
        now: input.now,
      });
  // Write the memo back only for `perTask`. A `perTurn` policy would find a matching id and reuse a proxy it was
  // supposed to rebuild, which is the one way a cache this cheap can be wrong rather than merely redundant.
  if (input.proxyCache !== undefined && input.policy.tas.updatePolicy === 'perTask' && !reuseProxy) {
    input.proxyCache.id = current.id;
    input.proxyCache.text = proxyText;
  }

  const result = assemble({
    graph: input.graph,
    policy: input.policy,
    pinned,
    tail,
    current,
    // T, the serialized task state, replaces the raw trace in front of the moving blocks. Its stability is what
    // lets it sit in the cache-stable head.
    stateProxy: proxyText,
    contextWindow: input.contextWindow,
    reserveOutputTokens: input.reserveOutputTokens,
    fixedOverheadTokens: input.fixedOverheadTokens,
    now: input.now,
    lambdaMs: input.lambdaMs,
    history,
  });

  // Measured against the window the view was actually taken from, not the payload: with an empty payload the
  // payload's tokens are zero, and "what the full history would have cost" would be reported as free.
  const fullTokens = totalTokens(window);
  const selectedTokens = result.budget.used;
  const graphStats = input.graph.stats();
  const event                = {
    windowN: input.policy.recall.window,
    // Cumulative, because the pairs are no longer all scored here: upkeep scores each new session segment as
    // it arrives, so a per-call number would report only this step's own segment and hide every pair the
    // window actually cost. The graph is the single place that knows the running total.
    scoredPairs: graphStats.scoredPairs,
    type: 'assembly',
    schema: TELEMETRY_SCHEMA_VERSION,
    ts: input.now,
    sessionId: input.sessionId,
    seq: input.seq,
    candidates: result.recall.candidates,
    selected: result.recall.selected,
    bfsDepth: result.recall.bfsDepth,
    budgetUsed: result.budget.used,
    budgetTotal: result.budget.total,
    blocks: result.budget.byBlock,
    prefixTokensStable: result.cacheStability.prefixTokensStable,
    layoutOrder: result.layout.order,
    xFirst: input.policy.xFirst,
    layoutStableTokens: result.cacheStability.layoutStableTokens,
    cutAfterBlock: result.cacheStability.cutAfterBlock,
    tokensAfterCut: result.cacheStability.tokensAfterCut,
    ...(result.fallback !== undefined ? { fallback: result.fallback } : {}),
  };

  return {
    kind: 'assembled',
    event,
    layout: result.layout,
    segments,
    selectedIds: result.layout.recalled.map((s) => s.id),
    fullTokens,
    selectedTokens,
    wouldSaveTokens: Math.max(0, fullTokens - selectedTokens),
    report,
    observeMs: 0,
  };
}

function lastIndexWhere   (items              , predicate                      )         {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item !== undefined && predicate(item)) return i;
  }
  return -1;
}
