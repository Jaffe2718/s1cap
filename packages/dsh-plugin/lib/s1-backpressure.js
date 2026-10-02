/**
 * S1 BACKPRESSURE — stop asking a backend that is refusing, and start again when it is not.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THIS EXISTS, IN MEASURED NUMBERS
 *
 * Round `20261002-2037`, cell C2, from the cell's own control plane (`evidence/C2/control.jsonl`):
 * 5 992 `s1_call` records, 3 859 of them refused (64.4 %) - 3 792 `503 {"detail":"server busy"}`
 * and 67 `TypeError: fetch failed` - over a 2 219.7 s span, which is **2.70 requests/second**.
 * The refusals are not a burst: every one of the run's 74 thirty-second buckets carries them, and
 * the refusal rate never falls below roughly a third. The backend's admission limit is 16 concurrent
 * requests and it *refuses* rather than queues (docs/LAYA_RUNTIME.md §6b). One cell saturated it by
 * itself and then kept asking at the same rate for 37 minutes while being told no.
 *
 * The mechanism that allowed that is not the pair count. `createUpkeepQueue` drains up to
 * `maxPerFlush` events per tick and *does not await the async handler* between them
 * (`packages/core/src/upkeep-queue.ts`, `runOne`), so N queued segments mean N `scoreNew` loops in
 * flight, each issuing its own requests. Serialising within one segment - which
 * `packages/dsh-plugin/src/s1-relevance.ts` already does, one batch at a time - therefore bounds
 * nothing across segments. That is the shape the admission limit punishes.
 *
 * Retrying was already correct and is unchanged: `s1.retryAttempts` is handed to the client, which
 * waits the server's own `Retry-After` (measured: 1 s) before its second attempt, and every attempt
 * is recorded in `attempts`/`waitedMs` on the `s1_call` record. A retry is the right answer to *one*
 * refusal. It is the wrong answer to a backend that is refusing *everything*, because the retry is
 * another request in the same admission window; that is what this module is for.
 *
 * ---------------------------------------------------------------------------------------------
 * THE POLICY, AND WHAT IT DELIBERATELY DOES NOT DO
 *
 *   - **Nothing is queued.** The backend refuses rather than queues; a local queue would only move
 *     the refusal to a place where it costs memory and latency instead of a line. A caller that
 *     cannot be admitted is told so immediately and defers its work.
 *   - **Concurrency is capped** by `s1.admissionLimit`, which is the backend's own property (16 for
 *     the Laya server this project runs) and is in the config for that reason.
 *   - **A refusal streak opens the breaker.** After `openAfterRefusals` consecutive refusals - or
 *     `openAfterRefusals` refusals inside a `windowMs` window, which catches the interleaved case
 *     the round actually produced - no request is sent for `cooldownMs`. Then exactly **one** probe
 *     is admitted. If it answers, the breaker closes and the streak is cleared; if it is refused,
 *     the cooldown restarts. When the backend comes back, the next probe finds it.
 *   - **It never decides what a pair is worth.** Deferral does not score anything lexically, does not
 *     drop a pair and does not mark it irrelevant: it leaves the work for the next tick, and the
 *     graph's cursor does not advance over it (`AssociationGraph.scoreNew`). A refused pair is
 *     therefore *not* counted in `scoredPairs`, which is what keeps `judgedPairs / scoredPairs` an
 *     honest coverage ratio rather than one inflated by work the run declined to offer. What was
 *     left out is counted in `deferredPairs`, which is written on the assembly record beside it.
 *
 * Time is injected, so the whole state machine is testable without sleeping.
 */

/**
 * The thresholds a gate uses when the caller names none.
 *
 * Exported because they are *governance*: a round that did not state `openAfterRefusals` still ran with
 * a number, and "which knobs actually governed this run" has to be answerable from the round's own
 * artifacts rather than from reading this file at the time (F4 in `s1cap-audit-lane.md`).
 */
export const BACKPRESSURE_DEFAULTS = {
  openAfterRefusals: 5,
  windowMs: 15_000,
  cooldownMs: 15_000,
}         ;

/** Configured facts about the backend, and the thresholds at which it is treated as saturated. */
                                      
     
                                                                                                    
                                                                                                  
                                                                                      
     
                       
                                                               
                             
                                                                                 
                    
                                                                                 
                      
                           
                 
                                 
     
                                                      
    
                                                                                                     
                                                                                                  
                                                                                                   
                                                                                                      
                                                          
     
                                                     
 

/** One state change of the breaker, with the counters that were standing when it happened. */
                                    
                                          
             
                      
                                                                    
                 
                                                                                            
                     
                   
                          
                            
                        
                                                                                        
                   
 

                                                         

/** Why a request was not admitted. Both reasons are reported; neither is a failure of the backend. */
                                                                

                                                                             

                                    
                                          
                   
                                               
               
                                                                                                     
             
                                                                              
                  
     
                                                                                                           
                                                                                           
    
                                                                                                                  
                                                                                                                  
                                                                                                                  
                                                                                                                
                                                                                                            
                                                                                                                  
                                                                                                               
    
                                                                                                                 
                                                                                                            
                                                                                                      
     
                            
                                          
                          
                            
                                                                                      
                 
                    
                      
                                                                                            
                        
                   
                      
                                                                                
                   
     
                                                                            
    
                                                                                                         
                                                                                                           
                                                                                                          
                                                                                                      
            
     
                      
 

                               
     
                                                                                                    
                                     
     
                          
                                                                            
                        
                                                                                   
                        
     
                                                                                                                  
                      
    
                                                                                                              
                                                                                                               
                                                                                                         
                                                                                                               
                                                                                                              
                                                                                                 
                                                                                                              
     
                                 
     
                                                                         
    
                                                                                                         
                                                                                                        
                                                                                                         
                                              
     
                     
                             
                                                                       
                                                                                                     
                                                                     
                       
 

export function createBackpressure(opts                      = {})               {
  const maxInFlight = Math.max(1, Math.trunc(opts.maxInFlight ?? 8));
  const openAfterRefusals = Math.max(1, Math.trunc(opts.openAfterRefusals ?? BACKPRESSURE_DEFAULTS.openAfterRefusals));
  const windowMs = Math.max(0, opts.windowMs ?? BACKPRESSURE_DEFAULTS.windowMs);
  const cooldownMs = Math.max(0, opts.cooldownMs ?? BACKPRESSURE_DEFAULTS.cooldownMs);
  const clock = opts.now ?? Date.now;

  const refusals           = [];
  let state               = 'closed';
  let openedAt = 0;
  let inFlight = 0;
  const stats                    = {
    attempts: 0,
    sent: 0,
    ok: 0,
    refused: 0,
    transportFailures: 0,
    deferredByLimit: 0,
    deferredByBreaker: 0,
    opened: 0,
    recovered: 0,
    state: 'closed',
    refusalStreak: 0,
    inFlight: 0,
    maxInFlight,
    openedAt: 0,
    slotsLeaked: 0,
  };

  /** Refusals inside the window, oldest first. Pruned on every read, so the streak is a real measure. */
  const recentRefusals = (at        )         => {
    while (refusals.length > 0 && at - (refusals[0]          ) > windowMs) refusals.shift();
    return refusals.length;
  };

  /**
   * Move the breaker and report it.
   *
   * Every assignment to `state` goes through here, so a new branch cannot change the state without the
   * transition being reported: the single exit is what makes "no `s1-gate` line for a run that opened the
   * breaker" impossible rather than merely unlikely.
   */
  const move = (to              , from              , at        , reason        )       => {
    state = to;
    stats.state = to;
    if (to === 'open') {
      openedAt = at;
      stats.openedAt = at;
    } else {
      // The gauge follows the state machine: `openedAt` is "when the breaker was last opened" and it is
      // zero again once the breaker is not open. `stats()` copies the object, so the reset reaches `/s1`.
      stats.openedAt = 0;
    }
    opts.onTransition?.({
      at,
      state: to,
      from,
      reason,
      inFlight,
      deferredByLimit: stats.deferredByLimit,
      deferredByBreaker: stats.deferredByBreaker,
      refusalStreak: stats.refusalStreak,
      openedAt,
    });
  };

  const open = (at        , why        )       => {
    const from = state;
    stats.opened += 1;
    move('open', from, at, why);
    opts.onWarn?.(
      `[s1cap] System-1 backend is refusing (${why}): pausing asks for ${cooldownMs}ms, then one probe. ` +
        'Pairs that are not asked about are deferred, not scored lexically, and are reported as `deferredPairs`.',
    );
  };

  return {
    tryAcquire()            {
      stats.attempts += 1;
      const at = clock();
      if (state !== 'closed') {
        // `open` waits out the cooldown; `probing` is the single in-flight probe and admits nobody else.
        if (state === 'open' && at - openedAt >= cooldownMs) {
          stats.refusalStreak = recentRefusals(at);
          move('probing', 'open', at, `the ${cooldownMs}ms cooldown elapsed; admitting one probe`);
        } else {
          stats.deferredByBreaker += 1;
          return { ok: false, reason: 'breaker-open' };
        }
      }
      if (inFlight >= maxInFlight) {
        stats.deferredByLimit += 1;
        return { ok: false, reason: 'in-flight-limit' };
      }
      inFlight += 1;
      stats.sent += 1;
      stats.inFlight = inFlight;
      return { ok: true };
    },

    recordSuccess()       {
      inFlight = Math.max(0, inFlight - 1);
      stats.inFlight = inFlight;
      stats.ok += 1;
      refusals.length = 0;
      stats.refusalStreak = 0;
      if (state !== 'closed') {
        stats.recovered += 1;
        move('closed', state, clock(), 'the backend answered; resuming at the configured rate');
        opts.onWarn?.('[s1cap] the System-1 backend is answering again: resuming at the configured rate');
      } else {
        state = 'closed';
        stats.state = 'closed';
      }
    },

    recordRefusal()       {
      inFlight = Math.max(0, inFlight - 1);
      stats.inFlight = inFlight;
      stats.refused += 1;
      const at = clock();
      refusals.push(at);
      const inWindow = recentRefusals(at);
      stats.refusalStreak = inWindow;
      if (state === 'probing') {
        // The probe was refused: the backend is still saturated, so the pause restarts in full rather
        // than degrading into a poll. A probe that cannot change the answer is a request per cooldown.
        open(at, 'the recovery probe was refused');
        return;
      }
      if (state === 'closed' && inWindow >= openAfterRefusals) {
        open(at, `${inWindow} refusal(s) within ${windowMs}ms`);
      }
    },

    recordTransportFailure()       {
      inFlight = Math.max(0, inFlight - 1);
      stats.inFlight = inFlight;
      stats.transportFailures += 1;
    },

    recordLeak()       {
      // Named for what it is: a slot came back without a request having been sent for it. It is not a
      // refusal (the backend said nothing) and not a success (nothing answered), so it gets its own
      // counter rather than being folded into either.
      inFlight = Math.max(0, inFlight - 1);
      stats.inFlight = inFlight;
      stats.slotsLeaked += 1;
    },

    stats()                    {
      return { ...stats };
    },

    policy() {
      return { maxInFlight, openAfterRefusals, windowMs, cooldownMs };
    },

    isBlocked()          {
      if (state === 'probing') return true;
      if (state !== 'open') return false;
      if (clock() - openedAt >= cooldownMs) return false; // the next tryAcquire() becomes the probe
      return true;
    },
  };
}
