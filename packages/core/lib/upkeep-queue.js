/**
 * UPKEEP QUEUE — the asynchronous side of the loop (docs/ARCHITECTURE.md §4).
 *
 * Association-graph upkeep never runs inside the per-call hook: new session events are enqueued as they
 * arrive and folded into the graph on a later tick. The per-call assembly therefore has a hard, small
 * latency budget.
 *
 * **What this type actually guarantees, corrected - the header used to claim more.**
 *
 *   - `flush()` is bounded: at most `maxPerFlush` events per tick, so a burst cannot stall the loop. That bound
 *     holds for `flush()` and **not** for `drain()`, which empties the queue by design and runs on the live path
 *     (the anchor wait in `step-observer.ts` and every `turn/end`). `drain()` is not a bug to be bounded; it is
 *     the caller saying "the turn is over, nothing is waiting on this work".
 *   - nothing throws at the caller: a failing handler is counted and the event is dropped, because a
 *     half-built governor must never be able to break the harness.
 *   - events are folded in arrival order, and **the handler is NOT awaited between them**. An earlier version of
 *     this header claimed the opposite - "the promise is awaited before the next event starts, so ... a burst
 *     cannot interleave two scorers over one window" - and the opposite is what the code does: `runOne` calls
 *     `onEvent`, attaches a `.catch` and returns, while `run()` shifts the next event immediately. With an async
 *     handler (the System-1 scorer is a network call) N handlers are therefore in flight at once, and the
 *     ordering guarantee that survives is the graph's own scoring cursor, not this queue's drain loop. That
 *     distinction is load-bearing and was measured: round `20261002-2037` sent 5 992 requests at 2.70/s, 64.4 %
 *     of them refused, because several `scoreNew` loops ran concurrently over one backend. The bound that exists
 *     for it is `s1.admissionLimit` in `s1-backpressure.ts`, which is where the concurrency is actually governed.
 *
 * `maxLagTurns` is accepted, bounded and reported, and **it does not bound anything** - see `overLag` below and
 * `UNENFORCED_KNOBS` in `config.ts`, which is the registry of knobs in this state.
 */

                                        
                                                                                                 
                       
     
                                                                              
    
                                                                                                             
                                                                                                          
                                                                                                                  
                                             
     
                    
     
                                                                                                            
    
                                                                                                                 
                                                                                                                  
                                                                                                                  
                                                                                                                  
     
                       
                                                                                                             
                                          
                                 
 

                                   
                                
                   
                              
                  
                                           
                  
                                                   
                 
                             
                  
                          
                  
     
                                                                  
    
                                                                                              
                                                                                                                 
                                                                                                               
                                                                                                                 
                                                                                                           
     
                   
                      
 

                                 
                          
                                                                    
                  
     
                                                                                                               
                                                                                                               
                                                                                   
     
                  
                
                            
 

export function createUpkeepQueue   (opts                       )                 {
  const maxPerFlush = Math.max(1, opts.maxPerFlush ?? 8);
  const capacity = Math.max(1, opts.capacity ?? 256);
  const maxLagTurns = Math.max(0, opts.maxLagTurns ?? 2);
  const queue      = [];
  let enqueued = 0;
  let applied = 0;
  let dropped = 0;
  let errors = 0;
  let flushes = 0;

  function runOne(event   )       {
    // A handler may be async now that the System-1 scorer is a network call. The promise is **not** awaited before
    // the next event starts (see the header): the `.catch` is what keeps a rejection from reaching the harness, and
    // `applied` counts the event as folded the moment its handler is entered. The ordering guarantee the graph
    // relies on is its own scoring cursor, and the bound on how many handlers may be in flight is the admission
    // gate in the caller, not this function. A rejection is caught exactly like a synchronous throw: counted,
    // reported, and the event is dropped - the harness is never allowed to see it.
    try {
      const result = opts.onEvent(event)                        ;
      if (result !== undefined && typeof (result                 ).then === 'function') {
        applied += 1;
        void (result                 ).catch((err         ) => {
          errors += 1;
          opts.onWarn?.(`upkeep handler failed (ignored): ${String(err)}`);
        });
        return;
      }
      applied += 1;
    } catch (err) {
      errors += 1;
      opts.onWarn?.(`upkeep handler failed (ignored): ${String(err)}`);
    }
  }

  function run(limit        )         {
    let done = 0;
    while (done < limit && queue.length > 0) {
      const next = queue.shift();
      if (next === undefined) break;
      runOne(next);
      done += 1;
    }
    if (done > 0) flushes += 1;
    return done;
  }

  return {
    enqueue(event   )       {
      if (queue.length >= capacity) {
        queue.shift();
        dropped += 1;
        if (dropped === 1) {
          // Once per session, on the transition, because this is the moment the graph acquires a hole: the event
          // dropped here - and every one dropped after it, silently - never becomes a segment, so every recall
          // measurement over this session is over a session missing content. The warning is the live half; the
          // persisted half is `AssemblyEvent.upkeepDropped`, which the caller copies from `stats().dropped` onto
          // the next assembly record.
          opts.onWarn?.(
            `upkeep queue is full (capacity ${capacity}); the oldest session events are being dropped, so the ` +
              'graph is losing segments (the total is reported as `upkeepDropped` on the assembly records)',
          );
        }
      }
      queue.push(event);
      enqueued += 1;
    },
    flush()         {
      return run(maxPerFlush);
    },
    drain()         {
      return run(queue.length);
    },
    clear()       {
      queue.length = 0;
    },
    stats()                   {
      return {
        enqueued,
        applied,
        dropped,
        errors,
        pending: queue.length,
        flushes,
        // The comparison, stated as what it is: pending *events* against a bound named in *turns*. Both are
        // reported so the unit mismatch is visible in the record rather than only in this comment.
        overLag: queue.length > maxLagTurns,
        maxLagTurns,
      };
    },
  };
}
