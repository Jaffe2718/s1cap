/**
 * STEP OBSERVER — the plugin's read-only wiring of M1.
 *
 * Contains the logic (capture the system prompt, keep the graph fresh off the critical path, run the
 * observer, emit the record, keep counters) with no Cordis, no filesystem and no clock of its own: the clock,
 * the scheduler and the emit function are injected. That keeps the plugin's tests deterministic and the
 * wiring in `index.ts` a few lines.
 *
 * Nothing here can change a round: `observe()` never throws, never rewrites the payload, and is called
 * *after* the harness's own middleware chain produced its decision. Upkeep never runs inside it — new session
 * events go into a bounded queue and are folded into the graph on a later tick.
 */
import { AssociationGraph, CONTENT_EVENT_TYPES, adaptSessionEvent, createUpkeepQueue, estimateTokens, extractSystemPrompt, observeStep, segmentEvent } from '@s1cap/core';
                                                                                              

                                      
                         
                                    
                
                                                                                                         
                        
                              
                              
                   
                                                                                            
                       
     
                                                                                                              
                                                                                                             
     
                
                     
                                   
                                                      
     
                                                                                                                
                                                                                                           
     
              
                                                                              
    
                     
                                 
                                     
                                                               
                                                
                                                                                       
                                                                                              
     
                                                                                                                 
                                                                                                                 
                                                                                                               
                                                                                                                
                                                                                                 
     
                                         
                                                                                  
                                    
 

                                    
                            
                
                                     
                   
                                                                  
                  
                                                                                                              
                
                                                                                        
                       
                                                                        
                      
                                                                                         
                         
                                                                 
                            
                                                      
                 
                                                                               
                              
                       
                         
                       
                        
                    
                                                                                           
                             
                                              
                 
                             
                         
                        
                     
                           
 

                               
     
                                                            
    
                                                                                                              
                                                                                                 
     
                                           
                                                                                               
                                         
                                                                                              
                                                       
                                                                                                          
                                             
                                                    
                        
                             
 

function readMessages(payload         )                                 {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const messages = (payload                          ).messages;
  return Array.isArray(messages) ? messages : undefined;
}

function readStep(payload         )         {
  if (typeof payload !== 'object' || payload === null) return 0;
  const step = (payload                      ).step;
  return typeof step === 'number' && Number.isFinite(step) ? step : 0;
}

/**
 * Opportunistic session id: the payload carries `agent`, and a session exposes an id. Read defensively — an
 * absent id only costs correlation in the control-plane log, never correctness.
 */
function readSessionId(payload         , fallback        )         {
  if (typeof payload !== 'object' || payload === null) return fallback;
  const agent = (payload                       ).agent;
  if (typeof agent !== 'object' || agent === null) return fallback;
  const session = (agent                         ).session;
  if (typeof session !== 'object' || session === null) return fallback;
  const id = (session                    ).id;
  return typeof id === 'string' && id !== '' ? id : fallback;
}

/** The session event's own type, e.g. `turn/end`. Absent for a payload that is not a session event. */
function readEventType(event         )                     {
  if (typeof event !== 'object' || event === null) return undefined;
  const type = (event                      ).type;
  return typeof type === 'string' && type !== '' ? type : undefined;
}

export function createStepObserver(opts                     )               {
  const graph = new AssociationGraph();
  // T's one-entry memo, alive for as long as the observer is. The observer is created once per activation and
  // outlives a session, so the memo is also correct across sessions: the anchor id is a segment id, and a new
  // session's task has a new one.
  const proxyCache = { id: '', text: '' };
  let systemPrompt                    ;
  let systemPromptTokens = 0;
  let scheduled = false;
  const stats                    = {
    steps: 0,
    observed: 0,
    skipped: 0,
    errors: 0,
    lastWouldSaveTokens: 0,
    lastSelected: 0,
    lastCandidates: 0,
    lastSegments: 0,
    lastObserveMs: 0,
    sessionId: opts.sessionId ?? 'unassigned',
    systemPromptTokens: 0,
    probes: 0,
    unknownPartTypes: [],
    unknownRoles: [],
    empty: 0,
    upkeepEvents: 0,
    upkeepEmpty: 0,
    upkeepSegments: 0,
    upkeepScoredPairs: 0,
    graphSegments: 0,
    graphEdges: 0,
    upkeep: {
      enqueued: 0,
      applied: 0,
      dropped: 0,
      errors: 0,
      pending: 0,
      flushes: 0,
      overLag: false,
      maxLagTurns: opts.maxLagTurns ?? 2,
    },
  };
  /** own monotonic sequence: the harness's session-log sequence is not exposed on the pre-step payload */
  let seq = 0;
  let announcedShapes = false;
  let eventProbes = 0;
  /** session-event types already probed; one shape line each, so the budget lands on distinct shapes */
  const probedTypes = new Set        ();

  const schedule =
    opts.schedule ??
    ((tick            )       => {
      const timer = setTimeout(tick, 0);
      // never hold the process open just to drain a queue
      if (typeof (timer                          ).unref === 'function') (timer                         ).unref();
    });

  const queue = createUpkeepQueue         ({
    maxLagTurns: opts.maxLagTurns ?? 2,
    onWarn: (message) => opts.onWarn?.(message),
    onEvent: async (event) => {
      // Asynchronous upkeep, which is what the session-event stream is FOR: adapt, segment, fold into the
      // graph, score the new segment against the last w. No assemble happens here - this is not a step, and
      // assembling per event would be both wrong and expensive. The model view is assembled once, at pre-step.
      //
      // The previous version ran a full observeStep() per event on the raw event wrapper. That could only ever
      // produce zero segments - a session event has no `role`, so the adapter reported the shape as unknown and
      // dropped it - which is why the graph was empty in live sessions and every recall count read zero.
      const now = opts.now();
      const { events: raw, report } = adaptSessionEvent(event, {
        sessionId: stats.sessionId,
        startSeq: seq,
        now,
      });
      for (const type of report.unknownPartTypes) {
        if (!stats.unknownPartTypes.includes(type)) stats.unknownPartTypes.push(type);
      }
      for (const role of report.unknownRoles) {
        if (!stats.unknownRoles.includes(role)) stats.unknownRoles.push(role);
      }
      if (raw.length === 0) {
        // Lifecycle events (step/start, turn/end, request/header, delivery notices) land here by design.
        stats.upkeepEmpty += 1;
        return;
      }
      const segments = raw.flatMap((ev) => segmentEvent(ev));
      graph.addSegments(segments);
      // The session-content stream, written from the same RawEvents that just entered the graph, so the file and
      // the graph can never disagree about what the session said. A throw here costs the stream line, not the
      // segment or the round - the same containment every other optional surface gets.
      if (opts.onSessionEvent !== undefined) {
        for (const ev of raw) {
          try {
            opts.onSessionEvent(ev);
          } catch (err) {
            stats.errors += 1;
            opts.onWarn?.(`[s1cap] session stream write failed (ignored): ${String(err)}`);
          }
        }
      }
      // Upkeep is where most pairs are scored now, so it is also where most S1 calls happen. It stays off the
      // critical path: the queue already defers this to a timer, and a failure here must cost the edges, not
      // the session - so a backend that is down degrades to no edges for that segment rather than throwing.
      let scored                                         = { scoredPairs: 0, edges: 0 };
      try {
        scored = await graph.scoreNew({
          windowN: opts.policy.recall.window,
          threshold: opts.policy.recall.relevanceThreshold,
          ...(opts.scoreBatch !== undefined ? { scoreBatch: opts.scoreBatch } : {}),
        });
      } catch (err) {
        stats.errors += 1;
        opts.onWarn?.(`[s1cap] upkeep scoring failed for a new ${segments.length}-segment batch: ${String(err)}`);
      }
      stats.upkeepEvents += 1;
      stats.upkeepSegments += segments.length;
      stats.upkeepScoredPairs += scored.scoredPairs;
      seq += raw.length;

      // The plan gate reads the model's own step list out of its own output. It runs here, after the segments
      // are in the graph, because that output is where both arrive, and its failure is contained here for the
      // same reason the scoring is: an advisory order that cannot be computed must not cost the session a
      // segment.
      //
      // Both kinds count, and that is the correction of a real bug: a message whose parts are only text adapts
      // to `assistant`, but a message carrying reasoning *and* text - which is what this model actually emits -
      // adapts to `trace`, with the reasoning and the answer merged. Filtering on `assistant` alone silently
      // inspected nothing: the gate reported `inspected: 0` for a whole session while the model was writing
      // numbered plans the entire time.
      if (opts.planGate !== undefined) {
        for (const ev of raw) {
          if (ev.kind !== 'assistant' && ev.kind !== 'trace') continue;
          try {
            await opts.planGate.consider(ev.text, stats.sessionId, stats.upkeepEvents);
          } catch (err) {
            stats.errors += 1;
            opts.onWarn?.(`[s1cap] plan gate failed (ignored): ${String(err)}`);
          }
        }
      }
    },
  });

  function tick()       {
    scheduled = false;
    // The queue is synchronous in shape (bounded drain, counted failures) and its handler may be async. The
    // handler's own promise is caught inside the queue, so nothing escapes this timer.
    queue.flush();
  }

  return {
    async observe(payload         )                {
      stats.steps += 1;
      const messages = readMessages(payload);
      if (messages === undefined) {
        stats.skipped += 1;
        return;
      }
      const started = opts.now();
      try {
        const sessionId = readSessionId(payload, opts.sessionId ?? 'unassigned');
        const observation = await observeStep({
          sessionId,
          step: readStep(payload),
          seq,
          messages,
          systemPrompt,
          policy: opts.policy,
          now: started,
          contextWindow: opts.contextWindow,
          reserveOutputTokens: opts.reserveOutputTokens,
          fixedOverheadTokens: opts.fixedOverheadTokens,
          lambdaMs: opts.lambdaMs,
          graph,
          // One slot for the whole observer, so T survives between steps. It is created here rather than inside
          // observeStep because that function is pure: a per-call cache would rebuild T every step, and T's
          // stability across steps is the property the whole block placement rests on.
          proxyCache,
        });
        seq += messages.length;

        const elapsed = Math.max(0, opts.now() - started);
        // The tape is written first, on purpose: it records what the harness actually sent, and that is worth
        // most exactly when the adapter could make no sense of it. Skipping it for empty steps would delete the
        // only evidence of the shape we do not understand yet.
        opts.onTape?.(readStep(payload), messages, systemPrompt);
        // Nothing to assemble: no record is emitted, and the step is counted as empty rather than as an
        // observation. It used to throw from the assembler and be swallowed, which is why a real session could
        // log exactly one record (the primer's) while looking perfectly healthy.
        if (observation.kind === 'empty') {
          stats.empty += 1;
          opts.onWarn?.(`[s1cap] step ${readStep(payload)} observed nothing: ${observation.reason}`);
          return;
        }
        opts.emit(observation.event);

        stats.observed += 1;
        stats.sessionId = sessionId;
        stats.lastWouldSaveTokens = observation.wouldSaveTokens;
        stats.lastSelected = observation.event.selected;
        stats.lastCandidates = observation.event.candidates;
        stats.lastSegments = observation.segments.length;
        stats.lastObserveMs = elapsed;
        for (const type of observation.report.unknownPartTypes) {
          if (!stats.unknownPartTypes.includes(type)) stats.unknownPartTypes.push(type);
        }
        for (const role of observation.report.unknownRoles) {
          if (!stats.unknownRoles.includes(role)) stats.unknownRoles.push(role);
        }

        opts.onObserved?.(
          `step ${readStep(payload)}: ${observation.segments.length} segments, ` +
            `${observation.event.selected} recalled of ${observation.event.candidates} candidates, ` +
            `${observation.wouldSaveTokens} tokens below the full history, ${elapsed}ms`,
        );
        if (!announcedShapes && (stats.unknownPartTypes.length > 0 || stats.unknownRoles.length > 0)) {
          announcedShapes = true;
          opts.onWarn?.(
            `harness shapes without a rule — parts: ${stats.unknownPartTypes.join(', ') || 'none'}; ` +
              `roles: ${stats.unknownRoles.join(', ') || 'none'} (kept and reported, never dropped)`,
          );
        }
      } catch (err) {
        stats.errors += 1;
        opts.onWarn?.(`observation failed (ignored): ${String(err)}`);
      }
    },

    noteSessionEvent(event         )       {
      try {
        const prompt = extractSystemPrompt(event);
        if (prompt !== undefined && prompt !== systemPrompt) {
          systemPrompt = prompt;
          systemPromptTokens = estimateTokens(prompt);
          stats.systemPromptTokens = systemPromptTokens;
        }
        // Probe the first event of each type, and spend the budget on the content types first.
        //
        // Two corrections are folded in here, both from the same mistake. The first rule spent its whole budget
        // on `turn/start`, `step/start` and `agent/inbox/spliced` - the lifecycle events that arrive first and
        // carry nothing - so the shapes that matter were never recorded while the question looked answered. The
        // second rule fixed that by type but still raced: a session emits eight distinct lifecycle types before
        // it emits `tool/call`, so the two tool shapes were still never seen. Content types now get the budget
        // first and the lifecycle ones only take what is left.
        const eventType = readEventType(event);
        const isContent = eventType !== undefined && CONTENT_EVENT_TYPES.includes(eventType);
        const budgetLeft = probedTypes.size < (isContent ? 12 : 6);
        if (eventType !== undefined && !probedTypes.has(eventType) && budgetLeft) {
          probedTypes.add(eventType);
          eventProbes += 1;
          // `data` is the envelope this host actually uses: measured keys are `type, seq, time, data, surfaceOp`,
          // so the harness message is not at the top level and a reader looking for `message` finds nothing at
          // all. Probing one level in is what turns "the stream carries no content" into "the reader is looking
          // in the wrong place", and the two look identical from every counter.
          const record = typeof event === 'object' && event !== null ? (event                      ) : undefined;
          const data = record?.data;
          // For an assistant message, also probe the nested `data.usage` shape: `llm_call` needs promptTokens,
          // cacheHit/cacheMiss and output token fields, and the field names are the host's contract, not ours.
          // Measuring them is the only honest next step for cost accounting; until a live probe reports the
          // keys, `llm_call` stays unwired rather than filled with guessed field names.
          const usage =
            typeof data === 'object' && data !== null ? (data                       ).usage : undefined;
          const shape =
            typeof event === 'object' && event !== null
              ? {
                  type: eventType,
                  keys: Object.keys(event          ).slice(0, 14),
                  ...(typeof data === 'object' && data !== null
                    ? {
                        dataKeys: Object.keys(data          ).slice(0, 14),
                        ...(typeof usage === 'object' && usage !== null
                          ? { usageKeys: Object.keys(usage          ).slice(0, 14) }
                          : {}),
                      }
                    : { dataType: typeof data }),
                }
              : { type: typeof event };
          this.probe({ schema: 0, kind: 'session-event-probe', ...shape });
        }
        queue.enqueue(event);
        if (!scheduled) {
          scheduled = true;
          schedule(tick);
        }
        // A turn boundary drains the queue, and it is free to do so: the turn is over, nothing is waiting on
        // this work, and the alternative is what a live session actually did - the model's own message sat in
        // the queue while the session ended, so the plan gate never saw the plan it was built to reorder, and
        // the graph carried every event of the turn except its last. `maxLagTurns` bounds the lag by counting;
        // this bounds it by ending it.
        //
        // `queue.drain()` and not the `flushUpkeep` method: that is a property of the object being returned, not
        // a binding in this scope, so calling it by name threw a ReferenceError straight into the catch below -
        // where it was counted as a bad event and swallowed. The queue stayed full and nothing said so.
        if (readEventType(event) === 'turn/end') queue.drain();
      } catch (err) {
        stats.errors += 1;
        opts.onWarn?.(`session event ignored: ${String(err)}`);
      }
    },

    probe(line                         )       {
      stats.probes += 1;
      opts.onProbe?.(line);
    },

    setSystemPrompt(text        , tokens         )       {
      const trimmed = text.trim();
      if (trimmed === '' || trimmed === systemPrompt) return;
      systemPrompt = trimmed;
      systemPromptTokens = tokens ?? estimateTokens(trimmed);
      stats.systemPromptTokens = systemPromptTokens;
      opts.onWarn?.(`[s1cap] system prompt pinned: ${systemPromptTokens} tokens`);
    },

    flushUpkeep()         {
      return queue.drain();
    },

    stats()                    {
      const graphStats = graph.stats();
      return {
        ...stats,
        systemPromptTokens,
        graphSegments: graphStats.segments,
        graphEdges: graphStats.edges,
        upkeep: queue.stats(),
      };
    },
  };
}
