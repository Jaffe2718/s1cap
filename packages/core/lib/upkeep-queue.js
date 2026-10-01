/**
 * UPKEEP QUEUE — the asynchronous side of the loop (docs/ARCHITECTURE.md §4).
 *
 * Association-graph upkeep never runs inside the per-call hook: new session events are enqueued as they
 * arrive and folded into the graph on a later tick. The per-call assembly therefore has a hard, small
 * latency budget, and the graph is allowed to lag the session by at most `maxLagTurns` turns.
 *
 * Two properties this type has to guarantee:
 *   - `flush()` is bounded: at most `maxPerFlush` events per tick, so a burst cannot stall the loop;
 *   - nothing throws at the caller: a failing handler is counted and the event is dropped, because a
 *     half-built governor must never be able to break the harness.
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
    // A handler may be async now that the System-1 scorer is a network call. The promise is awaited before the
    // next event starts, so the graph is folded in the order the events arrived and a burst cannot interleave
    // two scorers over one window. A rejection is caught exactly like a synchronous throw: counted, reported,
    // and the event is dropped - the harness is never allowed to see it.
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
          opts.onWarn?.(`upkeep queue is full (capacity ${capacity}); dropping the oldest events`);
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
        overLag: queue.length > maxLagTurns,
        maxLagTurns,
      };
    },
  };
}
