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
import { segmentEvent, estimateTokens, isS1capInjected } from './segmenter.js';
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
/**
 * A step that was ingested and deliberately not assembled ([`ObserveStepInput.assemble`]).
 *
 * It is a third state and not a flavour of the two above, because the difference is the whole point of the flag:
 * `assembled` means the walk ran, `empty` means it could not, and `ingested` means nobody asked for it. Collapsing
 * this into `empty` would report a skip as a failure of the segmenter, which is the opposite of what happened.
 *
 * The counts are here so a caller can prove the step was still *read*: `segments` is what this step contributed to
 * the graph, and `messages` is how many messages the payload carried (0 is the usual number - the harness claims
 * its messages in the decision, not in this payload).
 */
                                          
                   
                                                                                    
                      
                                                               
                 
                                                         
                   
                        
 

                                       
                
                                                                      
                 
                                                        
                   
     
                                                                                                              
                                                                                                               
                                            
     
                        
 

export async function observeStep(
  input                  ,
)                                                                            {
  const { events, report } = adaptMessages(input.messages, {
    sessionId: input.sessionId,
    startSeq: input.seq,
    now: input.now,
    ...(input.reasoningPartTypes !== undefined ? { reasoningPartTypes: input.reasoningPartTypes } : {}),
  });

  // segmentEvent applies the I2 gate (provenance.ts): a control-plane record can never become a segment.
  //
  // One more gate here, and it is the important one. A block S1CAP delivered is appended to the session log by
  // the harness, so it comes back through the session-event stream as an ordinary user message. Letting it in
  // would put S1CAP's own output into the graph, and from there into three places at once: the recall
  // candidates (so relevance re-selects a summary of the conversation as the most relevant thing in it), the
  // verbatim tail (so we re-present our own text as if it were a recent turn), and `fullTokens` — which is the
  // denominator of `wouldSaveTokens`. The last is the one that makes the headline number self-referential: the
  // tokens "saved" would be measured against a baseline S1CAP itself inflated. The method is about which of the
  // harness's own context is in the prompt and in what order, so its own text does not belong in that accounting.
  //
  // The host keeps its copy in the log and builds the request from the log, so the model still reads what was
  // delivered; what stops is S1CAP measuring, recalling or re-delivering it.
  const ingestable = events.filter((ev) => !isS1capInjected(ev.id));
  const segments            = ingestable.flatMap((ev) => segmentEvent(ev));
  input.graph.addSegments(segments);
  // The pinned prefix, built before the skip below rather than after it.
  //
  // It is two statements and it belongs to neither half: a rendered system prompt is part of what the *session*
  // carries, and the reason it is added to `pinned` rather than to the graph is that it has to stay byte-stable
  // at the front of the prompt and may never be a recall candidate. Keeping it here means a skipped step's
  // segments are exactly `segments` - one list, one meaning - instead of a list that silently grew a pin.
  const pinned = segments.filter((s) => s.kind === 'systemPinned');
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
  // The step is read, and nothing about the model view is decided. Everything below this line is assembly work,
  // and assembly work on a step that cannot receive context is what this flag exists to stop paying for (see
  // `ObserveStepInput.assemble`). The graph write above is deliberately *not* skipped: a segment belongs to the
  // session from the moment the harness carries it, and only the view is optional.
  //
  // It sits above the scoring branch as well. That branch exists to keep the System-1 scoring to whichever caller
  // reaches it first, and a skip is not a caller asking for anything: scoring on a step that assembles nothing
  // would take the pairs away from upkeep - the lane that is still scoring for the steps that do assemble - which
  // is the failure `scoreOnStepPath` was added to fix, arrived at from the other side.
  if (input.assemble === false) {
    return {
      kind: 'ingested',
      segments,
      reason:
        'the decision carried no messages, so the step was ingested and not assembled: ' +
        'there is nothing to insert a block into, and the walk would be paid for and thrown away',
      messages: input.messages.length,
      report,
    };
  }
  // recall.window = w: only segments that arrived since the previous step are scored, each against
  // the most recent w segments. Segments outside the window keep their edges and stay reachable.
  //
  // `scoreOnStepPath` exists because there are two callers of this function and they are not the same call. In the
  // plugin, the synchronous pre-step path and the asynchronous upkeep path both add segments to the same graph, and
  // `scoreNew` advances a cursor: whoever gets there first owns the scoring for those segments. Left to itself, the
  // pre-step path won every time and scored every pair with the local lexical scorer, so upkeep later found nothing
  // new to score and the System-1 association backend was asked nothing at all - `upkeepScoredPairs: 0` with a
  // healthy-looking graph, which is what a live session actually measured.
  //
  // Routing the scoring to upkeep is also the only reading consistent with the policy: `rgMaintenance` is declared
  // `async`, and a measured System-1 call costs 400-1500 ms against a 250 ms assembly deadline. A step that waited
  // on scoring would either blow its own budget or answer from a scorer that never ran.
  if (input.scoreOnStepPath !== false) {
    await input.graph.scoreNew({
      windowN: input.policy.recall.window,
      threshold: input.policy.recall.threshold,
      ...(input.scoreBatch !== undefined ? { scoreBatch: input.scoreBatch } : {}),
    });
  }

  // Where the model view is taken from, and which segment is the step's own question.
  //
  // This used to say: the payload's segments when it has any, the graph's append order otherwise, because the
  // graph is a superset and "using it never loses a segment the payload carried". The conclusion was right and
  // the direction was backwards, and the cost has now been measured. The graph IS a superset — which means
  // using the *payload* is the lossy choice, not the graph. At a turn-opening step the payload holds exactly one
  // new user message, so the pool is that message, `history` is empty, and there is nothing for relevance to
  // select: a live C2 run delivered the state proxy on 4 steps, every one of them with `blocks.recalled = 0`,
  // while the five steps that did have history (836 to 5243 tokens of it) were the steps the harness claims
  // nothing for - so recall and delivery fired on disjoint steps.
  //
  // (Those "steps the harness claims nothing for" were previously described here as steps where "no request is
  // made at all". That is false, and the packaged harness says so unconditionally: the request is built from the
  // session log and streamed whatever `decision.messages` holds (`dsh-agent-loop` L1061/L1063/L1072), and the
  // round's own 277 `step/start` against 277 `assistant/message` confirm it. The empty decision is the harness's
  // turn-*termination* signal - L962/L963 - which is why the caller still declines to assemble on it; see
  // `ObserveStepInput.assemble` for the whole rule. What the disjointness above measures is the *claimed list*,
  // not the existence of a request.)
  //
  // The graph's ordered segments are the session's own append order, so they include everything the payload
  // carried and everything before it. That is the window a model call needs.
  //
  // The anchor is the newest `user` segment *in that window*, and finding it is where a whole run's recall
  // silently pointed at the wrong turn. The line above computes a position inside the payload's segment list;
  // this one used to apply it to the graph's array (`window[anchor]`). The two index spaces coincide only when
  // the graph's order begins where the payload's does, which is the rare case: the payload holds the current
  // question *after* the payload's own first segment, so a payload whose last user turn sits at index 2 indexed
  // the graph's third-oldest segment. Measured over the same diagnostic round: 273 of 277 invocations rooted the
  // walk on `34b2115f-…-#3`, the tail chunk of turn 1's AGENTS.md block, and the task's own three chunks were
  // re-offered as candidates 190, 189 and 188 times. The tree was a faithful account of a walk from the wrong
  // question, and no counting of its nodes could have shown that.
  //
  // Resolved in the graph, and not by looking the payload's own last user segment up in the graph, because the
  // payload is the lossy list (the comment above): a step whose payload carries only an older message would then
  // anchor on that older message, which is the same defect one turn smaller. The window is append-ordered and
  // holds everything the step carries, so its last `user` segment IS the newest question this step has; every
  // other block is written relative to it (`pool` below excludes it, `unjudgedWithin` looks back from it), and
  // assembling from any other segment would describe a prompt nobody is going to send.
  const window            = input.graph.orderedSegments();
  const windowAnchor = lastIndexWhere(window, (s) => s.kind === 'user');
  // The payload's own anchor is still computed, and is now used for one thing only: a diagnostic when the two
  // disagree. Silence there would leave the next reader of this file to rediscover which space each index lives
  // in, which is what this fix cost.
  const anchor = lastIndexWhere(segments, (s) => s.kind === 'user');
  // The payload's own anchor is used for one thing only, now that the walk is rooted in the graph: a diagnostic
  // when the two disagree. Silence there would leave the next reader of this file to rediscover which space each
  // index lives in, which is what this fix cost.
  if (anchor >= 0 && windowAnchor >= 0 && windowAnchor !== anchor) {
    const idAt = (list                    , i        )         => list[i]?.id ?? '';
    try {
      input.onAnchorMismatch?.({
        payloadAnchor: anchor,
        windowAnchor,
        payloadId: idAt(segments, anchor),
        windowId: idAt(window, windowAnchor),
      });
    } catch {
      /* a diagnostic that cannot be recorded costs the diagnostic, never the step */
    }
  }
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
  // The bounded anchor wait, before anything is assembled from the graph.
  //
  // It sits here, and not earlier, because `current.id` is only known once the anchor has been chosen; and not
  // later, because `assemble()` is the first reader of the anchor's scored edges - a wait after it would be a
  // measurement of nothing. `observeStep` stays a pure function of its input and owns no clock, so the waiting
  // itself is the caller's: this only hands over the id and continues.
  //
  // Contained, and deliberately quiet: this function has no diagnostic sink of its own (it is pure by design, see
  // the header) and the plugin's wait is written never to throw. A throw here is a caller bug, and the same
  // fail-open rule that admits unjudged pairs is what makes swallowing it safe - the step assembles with whatever
  // the graph has, and `unknownAdmitted` reports the difference. It must not cost the step.
  try {
    await input.beforeAssemble?.(current.id);
  } catch {
    /* the wait failed: assemble from the graph as it stands, which is the fail-open path */
  }
  // Everything in the window except the anchor, the anchor's own sibling chunks, and the pinned prefix, in
  // append order.
  //
  // This used to be "the segments before the anchor", which looked equivalent and was not: the anchor is the
  // last user segment, and the model's output for the current task - its messages, tool calls and tool results -
  // arrives *after* it in the append-only log. Slicing before the anchor therefore discarded exactly the newest
  // turns, and `tail` came out empty in every live record (blocks.tail = 0 across a whole run) while the k most
  // relevant verbatim turns were quietly not in the prompt at all.
  //
  // The sibling exclusion is the seed fix's other half. The anchor is the *last chunk* of its event, not the
  // event: a long user message is split into chunks sharing a `chunkOf` parent (`segmenter.ts`), so the question
  // the model is answering currently sits in the graph as several segments and exactly one of them is the anchor.
  // Without this line the rest are ordinary history - in `tail` when they are the last k, in `history` and
  // therefore in the fallback otherwise - and a recall hit on one is delivered as "an earlier user turn, quoted
  // verbatim" naming the question's own id. Measured in round `20261002-2037`: both of the run's deliveries quote
  // the task prompt, and the delivered body is its middle chunk; `recall-C2.txt` shows the prompt's three chunks
  // offered as candidates 190 / 189 / 188 times. Re-quoting the current question is both false and redundant, so
  // the exclusion is on the identity of the parent (`chunkOf ?? id`) rather than on the chunk.
  const anchorParent = current.chunkOf ?? current.id;
  const pool = window.filter(
    (s) => s.id !== current.id && (s.chunkOf ?? s.id) !== anchorParent && s.kind !== 'systemPinned',
  );
  // The same exclusion has to reach the assembler, and this is not redundancy: the walk draws its candidates
  // from the *graph*, not from this list, so a sibling chunk is still selectable there even with `pool` clean.
  // `excludeIds` is that half (see `AssembleInput`), and it is also what keeps a sibling out of the recency
  // fallback, whose candidate list is `history` minus `excluded`.
  const siblingIds = window
    .filter((s) => (s.chunkOf ?? s.id) === anchorParent && s.id !== current.id)
    .map((s) => s.id);
  // `tail` is the k most recent turns, verbatim. Which side of x they end up on is the layout's business and not
  // the selector's: with x last they sit immediately before it, with x first immediately after it.
  const tailCount = Math.max(0, Math.min(input.policy.tail.k, pool.length));
  const tail = tailCount > 0 ? pool.slice(pool.length - tailCount) : [];
  const history = pool
    .slice(0, pool.length - tailCount)
    // Our own delivered blocks are excluded from the recall candidates as well. The ingestion gate above is
    // where this normally happens; this line is the second lock on the same door, and it is here because the
    // graph is also filled by replay and by upkeep, neither of which goes through that one statement. A block
    // that summarizes the conversation is among the most relevant things in it, so re-selecting it is not a
    // cosmetic problem. Excluding here covers both the S1 selection and the recency fallback, since the
    // assembler draws candidates from `history` in both cases.
    .filter((s) => !isS1capInjected(s.id));
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
    // The anchor's sibling chunks, so a *graph* hit on one of them is dropped too: the walk does not read `pool`.
    excludeIds: siblingIds,
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
    // And of those, the ones the backend actually answered. Read together, `scoredPairs - judgedPairs` is the
    // number of pairs the window paid for and did not get, which is the only way a silent slide into lexical
    // scoring shows up in a record that otherwise looks healthy.
    judgedPairs: graphStats.judgedPairs,
    // And the pairs the window did *not* offer, because the backend was saturated and the scorer held them back
    // (`S1_DEFERRED`). A third number rather than a bigger denominator: `scoredPairs` counts what was put to a
    // scorer, `deferredPairs` counts what was not, and adding the second to the first would report a coverage
    // ratio over work the run declined to do. A record that carries only the first two cannot tell "the backend
    // answered a third of what it was asked" from "the run stopped asking", and round `20261002-2037` is exactly
    // that ambiguity: 4 152 judged of 860 672 offered, with 3 859 refusals in between and nothing on the record
    // saying how much of the remainder was ever attempted.
    deferredPairs: graphStats.deferredPairs,
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
    // The structure this step's recall produced, straight from the assembler: the tree the walk actually made,
    // ids only. Unconditional, unlike `fallback` below, because `{}` is a reading - recall found nothing - and
    // not the absence of one.
    recallTree: result.recallTree,
    ...(result.fallback !== undefined ? { fallback: result.fallback } : {}),
    // The fail-open admission count, copied verbatim from the assembler and omitted when it is zero for the same
    // reason `fallback` is: no admission is the ordinary case, and `{}` vs absent is the convention this record
    // already uses for `recallTree`. It was computed and dropped on the floor for a whole round - see
    // `AssemblyEvent.unknownAdmitted`, which is where the consequence is written down.
    ...(result.unknownAdmitted !== undefined ? { unknownAdmitted: result.unknownAdmitted } : {}),
    // Unconditional, unlike the two above: a dropped session event is content loss, so "0 dropped" has to be a
    // reading a later round can make rather than an absent field it has to interpret. Undefined means the caller
    // did not supply the counter at all (a local or test caller), which is a third state and stays absent.
    ...(input.upkeepDropped !== undefined ? { upkeepDropped: input.upkeepDropped } : {}),
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
