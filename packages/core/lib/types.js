/**
 * S1CAP core types — the contract shared by every package.
 * Mirrors docs/AGENT_BRIEF.md §4.
 *
 * **Field names are contracts with the rounds already recorded, not promises that a name never changes.** That is
 * the rule this tree follows, and it replaced "add fields, never rename" (docs/AGENT_BRIEF.md §0 rule 5) on
 * 2026-10-05, when this session renamed two fields and deleted a third: a rule the code violates is worse than no
 * rule, because the next reader has to work out which of the two the tree means. A field may be **renamed or
 * removed** when all three of these hold:
 *
 *   1. the old spelling is still read, and reported, rather than silently reinterpreted — `LEGACY_LAYOUT_KEYS` in
 *      `config.ts` translates the old key to its successor and refuses, with its own sentence, a value this build
 *      cannot honour (`xFirst: true` is the worked example: the layout it asked for was deleted, so it is an error
 *      and not a dropped key);
 *   2. a recorded round stays interpretable without the field, from the round's own artifacts — every assembly
 *      carries the literal `layoutOrder` and the resolved values it ran with (`AssemblyEvent`, `observer.ts`), so
 *      deleting a policy field never removes the evidence of what a round recorded;
 *   3. the *reason* is written beside the type, not only in the commit that did it, because the reason is what
 *      stops the removed idea coming back under a new name.
 *
 * The counter-rule is unchanged and is what makes point 1 load-bearing: a field may not be dropped *silently*.
 * Deleting a config path that a profile still writes is this project's most-repeated failure (a key that looks
 * configured and resolves to nothing), which is why every removal here leaves a reader behind.
 */

export const CORE_SCHEMA_VERSION = 1         ;

                         
          
               
           
              
                
                   

                          
             
                    
                                                
              
                    
                
                                                                                     
                 
               
             
                   
                                                                      
                   
 

/**
 * Where an edge's weight came from. `lexical` is a first-class value, not an absence: the
 * association graph keeps working when no System-1 backend answers, and an edge it produced by
 * itself must never be indistinguishable from one a model scored. Before this distinction existed
 * the window scorer wrote the literal `'s1'` for every edge it made, including the ones produced
 * by the lexical fallback - which made `/s1 why` claim System-1 provenance for scores no System-1
 * had ever seen, and made the paper's central comparison unmeasurable.
 */
                                                                               

                                  
               
             
                                        
            
                                          
                 
                     
                     
                                                             
                     
 

                                      

                                                                               

/**
 * Which steps run the assembly at all — the type of `AssemblyPolicy.assemblyTrigger`, and the whole argument for
 * both of its values.
 *
 * `'every-step'` is the default since 2026-10-04, on the originating brief's own requirement. Idea 3 says the
 * recall is driven by "the user input *or* the model's own self-directed input", and idea 2 says every new session
 * event segment - "user input x, or LLM output o, tool results, etc." - feeds the association graph. A step that
 * claims no messages is still a step whose input the model chose, so `'claimed-only'` satisfied the first half of
 * that requirement and silently dropped the second: round `20261004-0205` measured C2 at **2 assemblies in 53
 * steps**, i.e. 51 steps of self-directed input with no recall at all. That is a mechanism not running as
 * specified, not a tuning preference, which is why the default moved rather than a round opting in.
 *
 * `'claimed-only'` is retained as a value, and the measurements that argued for it are retained with it.
 * `agent/pre-step` hands over `inbox.claim(target, turn)`, which is one user message on a turn's first step and an
 * empty array on every step after it (`docs/STATUS-ARCHIVE.md`, fault 2: "the step payload carries no history"), so
 * under `'claimed-only'` the walk, the anchor wait and T's rebuild ran on about one step per turn while the model
 * was called on every step. Round `20261003-2104` measures the consequence rather than the claim: **33 model
 * calls, 2 assemblies**, and only one of the two performed a real BFS walk (`bfsDepth 2`, `candidates 17`).
 *
 * `'every-step'` assembles on every step that will issue a request. At the hook the only facts that separate
 * such a step from the two that cannot receive anything are `decision.kind === 'reject'` and
 * `decision.signal.aborted === true`, both of which keep refusing under either value. The packaged loop appends
 * the decision and then builds and streams the request from the session log regardless of what
 * `decision.messages` holds (`dsh-agent-loop` L1061 / L1063 / L1072), and the measured round shows what that
 * means here: 33 steps, 33 `LLM calls`, one per step, turn ended `1:completed` — so an empty decision did not
 * mean "no request" in it. The one step left out is `step === 1` with nothing claimed: the harness's own guard
 * treats that as no step at all, the host's instructions plugin declines there too, and the evidence for
 * `'every-step'` is about the steps after the first.
 *
 * **The counter-argument is retained, and it is now a risk to watch rather than a reason for the default.** The
 * empty decision is also how the loop decides the turn is over (`if (turnEnds && decision.messages.length === 0)
 * break`, L962), and `turnEnds` is a local of the loop that the payload does not carry — so a plugin cannot tell a
 * terminal pre-step from an ordinary one. Returning a message at a terminal step would prevent the turn from
 * ending, and repeated, that is a livelock; `termination: 'model-owned'` says no S1CAP output may prolong or veto
 * the model's exit. `DEFECT-GATE.md` records this as D1's correction: the refusal on an empty decision was a design
 * decision, not a capability limit. Two things bound the exposure and neither removes it. The payload-id guard
 * refuses a step whose delivered text is byte-identical to one already sent, and `tas.updatePolicy: 'perTask'`
 * holds `T` still within a task — so a terminal step with no new selection is refused. A terminal step whose
 * selection *did* move produces a new payload and is delivered. So: **a round running `'every-step'` must read its
 * own turn/end count against its step count**, and a turn that fails to end where it ended under `'claimed-only'`
 * is this risk materialising, not a harness fault. The first such round is `20261004-0205`'s successor.
 *
 * No cell sets it — `cellPolicy()` leaves all three arms on the default on purpose, so that no measurement round
 * is confounded by a preset.
 */
                                                            

/**
 * Which of the paper's two second-pass arms the recorded layout is — the type of `AssemblyPolicy.tracePlacement`,
 * and the **only** layout axis.
 *
 * The paper (arXiv:2609.02702 §3.2–4.1) runs three conditions over the same collected reasoning trace `T`, the
 * same long context `x` and the same question `q`, and it holds `q` fixed at the end of every one of them:
 *
 *     baseline:         M([x, q])
 *     Trace as State:   M([T, x, q])   the trace BEFORE the long context — the method
 *     Trace Append:     M([x, T, q])   the same trace AFTER the long context — the control
 *
 * "trace as state and trace append use the same long context x and the same textual task state proxy T, **with
 * order as the only difference**", and "**the question appears at the end of the prompt** … in every input". So the
 * variable is where `T` sits relative to `x`, `q` never moves, and this enum has exactly the paper's two values
 * rather than a description of the mechanism: `'trace-as-state'` *is* `M([T, x, q])` and `'trace-append'` *is*
 * `M([x, T, q])`, and neither name can be read for anything else.
 *
 * **`'trace-as-state'` is the default because it is the method this project is testing**, not because it happened
 * to be what ran before. It is worth recording how it became reachable, because the previous arrangement was
 * self-blocking: this axis used to carry the mechanism-named values `'before-context' | 'after-context'` and to
 * compose with a second axis — a boolean `xFirst`, renamed `questionPlacement: 'first' | 'last'` for a day — that
 * moved `q` in front of the context. Every cell preset set it, so the two combinations that existed on disk were
 * `[T, q, x]` (all three cells) and `[q, x]` (none), and **`M([T, x, q])` was unreachable without a non-default
 * override no cell ever set**: the project's two named arms were `M([T, x, q])` and `M([x, T, q])`, and round after
 * round it ran a third layout that is neither.
 *
 * **The second axis is deleted, not renamed (2026-10-05), and this enum is the only layout axis.** `q` is last by
 * construction — the paper fixes it there in every condition — so no setting can put it anywhere else, and the
 * value that used to ask for `q` first is refused rather than translated, because there is no layout here for it to
 * mean (`LEGACY_LAYOUT_KEYS` in `config.ts`). Renaming that axis to `questionPlacement` kept the wrong idea alive:
 * it left "the question's position is a variable" expressible, and its `'first'` value produced `[T, q, x]`, which
 * is neither of the paper's two arms. A field whose other value produces a layout the paper does not have is not a
 * variable, so it is removed rather than labelled.
 *
 * What the field does **not** do: decide whether `T` exists at all (`tas.on` does; with TAS off there is no `T` to
 * move and the recorded order is the paper's baseline `M([x, q])` under either value, which is the honest reading
 * rather than a silently inert setting).
 */
                                                               

                                 
             
     
                                                                                     
                                                                                  
                                                                                     
                                                                                 
     
                             
                                                                                                               
                             
     
                                                                                                   
                                                                                                 
                                                                                                       
                         
     
                                                        
     
                                                                                            
                                                                                           
                                                                    
     
          
                                                                                                                                    
                                                        
                                                                                                                 
                        
    
        
                
       
                                                 
      
                                                                                                                    
                                                                                                             
                                                                                                           
                                                                                                                  
                                                                                             
      
                                                                                                                   
                                                                                                                   
                                                                                                                 
                                                                                                                    
                                                                                                                         
                                                                       
       
                      
                                                                     
                                        
    
           
                                
                                                         
                        
         
                                                                                                    
                                                                                                 
                                                                                                     
        
                                                                                                              
                                                                                                                    
                                                                                                                  
                                                                                                          
                                                                                                                  
                                                                                                                   
                                                                                                                   
                                                                                                                 
                                                                            
        
                                                                                                                      
                                                                                                                
                                                                                                                   
                                                                                                                
                                                                                                                   
                                                                                                                    
                                                                                                                    
                                                                                                                 
                                                                                                      
        
                                                                                                              
                                                                                                                   
                                                                                                               
                                                                                                                     
                                                                                                               
                                                                                                                    
                                                                                                                   
                                                                                              
         
                     
         
                                                                                                             
                  
        
                                                             
        
                                                                                                            
                                                                                                                 
                                                                                                               
                                                                                                         
                                                                                                                
                                                                                
        
                                                                                                                 
                                                                                                                 
                                                                                                               
                                                                                                                
                                                                             
        
                                                                                                              
                                                                                                                    
                                                                                                                    
                                                                                                             
                                                                                                                   
                                                                                                              
                                                                                                               
                                                                                                                    
                     
        
                                                                                                                 
                                                                                                                 
                                                                                                            
                                                                                                               
                                 
         
                           
       
                                                                                                               
                                                                                                                     
                                                                                                                    
                                                                                                                 
                                                                                                              
                                                                                                            
      
                                                                                                                    
                                                                                                      
      
                                                                                                                      
                                                                                                                  
                                                                                           
                                                                                                                  
                                                                                                                  
                                                                                                                 
                                                                                                                   
                                                                                                                 
                                                                                                                    
                                                                                                                     
                                                                                                     
      
                                                                                                                  
                                                                                                                    
                                                                                                                  
                                                                                                                 
                                                                                                                  
                                                                                                                    
                                                                                                         
      
                                                                                       
                          
                                
                                   
                                   
                                   
                                    
      
                                                                                                                  
                                                                                                                   
                                                                                                               
                                                                                                         
                                                                                                                 
                                                                                                                   
                                                                                                                   
                                                                                                                  
                                                                                                               
                                                                  
      
                                                                                                               
                                                                                                           
                                                                                                                
                                                                                                      
      
                                                                                                               
                                                                                                                   
                                                                                                                     
                                                                                      
       
                  
       
                                                                                                           
      
                                                                                                               
                                                                                                                  
                                                                          
                                                                                                               
                                                                                                               
                                                                                            
                                                                                                              
                                                                                          
                                                                                                           
                                                                                                             
                                                                                                            
                                                                                
      
                                                                                                              
                                                                                                              
                                                                                          
                                                                                                                
                                                                                                              
                                                                                                             
                                                                                                             
                                                                                                          
                                                                                                             
                                                                                       
      
                                                                                                       
                                                                                                               
                                                                                                                
                                                                
      
                                                                                                            
                                                                                                             
                                                                                                               
                                                                                                    
                                                                                                             
                                                                                                               
                             
       
       
                                                                                                                   
                           
      
                                                                                                             
                                                                                                         
                               
                                                                                                               
                                                                                                                 
                                                                                                                 
                                                                                                                
                                                                                                                  
                                                                                         
      
                                                                                               
                                                                                                             
                                                                                                                    
                                                   
       
                        
       
                                                                                                           
                                                                                                                  
                                                                                                                 
                                                                                                              
                                                                                           
       
                        
      
                                                                                                               
      
                                                                                                              
                                                                                                                    
                                                                                                                  
                                                                                                              
                                                                                                                    
                                                                                                                
                                                                                                                 
                                                                     
      
                                                                                                                    
                                                                                                                
                                                                                                                 
                                                                                            
      
                                                                                                                    
                                                                                                   
                                                                                                                  
                                                                                                        
      
                                                                                                                  
                                                                                                                   
                                                                                                              
                                                                                                                    
                                                                                                           
       
       
                                                                                                              
                                                                    
      
                                                                                                                
                                                                                                                 
                                                                                                                 
                                                                                                                  
                                                                                    
      
                                                                                                                   
                                                                                                                   
                                                                                                                  
                                                                                                                  
                                                                                                        
      
                                                                                                       
                                                                                                                 
       
                             
       
                                                                                           
      
                                                                                                               
                                                                                                               
                                                                                                                 
                                                                                                        
       
                                
    
                      
     
                                                                                                             
                                                                                                                  
                                                                                                                 
                                                                                                               
                                                                
    
                                                                                                                   
                                                                                                                 
                                                                                                                   
                                                                                                                  
           
     
                                 
     
                                                      
    
                                                                                                                  
                                                                                                             
                                                                                                                  
                                               
    
                                                                                                             
                                                                                                                 
                                                                                                          
                                                                                                              
                                                                                                                  
                                                                        
    
                                                                                                                   
                                                                                                                 
                                                                                                            
                                                   
    
                                                                                           
                                                                                              
                                                                                                 
                                                                                                 
                                                                                                 
    
                                                                                                                 
                                                                                  
    
                                                                                                             
                                                                                                            
                                                                                                   
                                                                                                  ﻿ 
                                                                                                                
                                                                                                                  
                                                                                                                  
                                       
     
                   
                                   
    
                                                                                     
    
                                                                                                   
                                                                                                              
                                                                                                               
                                                                                                               
                                                                                                             
                                                                                                                
                                                                                                                
                                                                                                                
                                                                                                            
                        
    
                                                                                                           
                                                                                                                
                                                                                                              
                                                                                                             
                                                                                                             
                                                                                                                 
                                                                                                             
                                                                                                               
                                                                                                               
                                                                     
     
       
                             
                                                                          
                     
                                                                      
                   
                                                                                                         
                    
       
                                                                                                            
                                                                                                            
                                                                                                                
                                                                                                                   
                                                                                                              
                                                                                                                 
                                                                                                                  
                                                                      
       
                                                               
                             
       
                                                                                                              
                                                                                                                 
      
                                                                                                    
                                                                                                              
                                                                                                                  
                                                                                                        
                                                                                                            
                                                                    
      
                                                                                                                  
                                                               
       
                          
       
                                                                                                               
      
                                                                                                       
                                                                                                      
                                                                                                                  
                                                                                                              
      
                                                                                                                 
                                                                                                                 
                                                                                                               
                                                                                                           
                                                                                                                
                                                                                                        
      
                                                                                                               
                                                                                                                  
                                                                                                                 
                                                                                                            
       
                           
    
 

/** The blocks of one model-view context, in the order they were laid out. */
                                 
                    
                                                          
                      
                      
                  
     
                                                                                                                   
                                                                                                              
                                                             
    
                                                                                                                   
                                                                                                          
                                                                                                        
     
                  
     
                                                                                                            
                                                                                                        
    
                                                                                                                         
                                                                                                                         
                                                                                                                         
                                                                                                                         
                                                                                                                         
    
                                                                                                                 
                                                                                                           
                                                                                                                 
                                                                
    
                                                                                                                   
                                                                                                                   
                                                                                                                  
                                                                                                             
                                                                                                                   
                                                                                                                 
                                                                                                                  
                                                                                                              
                                                                                                                    
                                                                                                                  
                                           
    
                                                                                                              
                                                                                                              
                                                                                                               
                                                                                                                   
                                                                                                                   
                                                                                                                 
                                                                                                            
                                                                                                                 
                                                                    
     
                  
 

                                 
                         
     
                                                                                    
    
                                                                                                                    
                                                                                                              
                                                                                                                   
                                               
    
                                                                                                                   
                                                                                                                   
                                                                                                                    
                                                                                                              
                                                                                                                   
                                                                                                         
     
           
                  
                 
                                    
    
                              
     
                                                                                                               
                                                                             
    
                                                                                                               
                                                                                                                   
                                                                                                               
    
                                                                                                               
                                                                                                              
                                                                          
     
                           
                                                                            
                   
                                                                                       
                               
       
                                                                                                             
                                                                                        
                                                                                                      
                                                                                                                
                       
      
                                                                                                                   
                                                                                                                   
                                                                                                                    
                                                                                                                    
                                                                                                                    
                                                          
       
                               
       
                                                                                        
      
                                                                                                                     
                                                                                                                  
                                                                  
       
                          
       
                                                                                                                
                                                                                                                 
                                                                                                                
                                                                      
       
                           
    
                                         
           
                       
                     
                     
       
                                                                                                             
                                                                                                                     
                                                                                                
       
                             
    
     
                                                     
    
                                                                                                                 
                                                                                                                  
                                                                                                  
    
                                                                                                              
                                                                                                             
                                                                                                                   
           
     
                                      
 

                                
             
                  
 

                            
             
                                                
               
                     
 

                                   
                                    
                  
                                                              
                                
                                                                  
                     
 

/**
 * Default policy = the full configuration (cell C2), which is also the base the other two cells are derived from
 * by toggles. `deliver` is the one switch the base leaves off — a policy that assembles a layout nobody receives
 * is the safe default — and it is a *base* default rather than a C2 claim: `cellPolicy` turns it on for C1 and C2
 * and leaves it off for C0, which is the delivery axis of the ablation (see `AssemblyPolicy.deliver`).
 */
export function defaultPolicy()                 {
  return {
    cell: 'C2',
    termination: 'model-owned',
    assemblyDeadlineMs: 250,
    rgMaintenance: { mode: 'async', maxLagTurns: 2 },
    cache: { reselectPolicy: 'perTask', blockTokens: 64 },
    tas: { on: true, tMaxChars: 50_000, updatePolicy: 'perTask' },
    recall: {
      threshold: 0.55,
      // 16, not 1024: the window does nothing until it is below the session's segment count, and on the round the
      // lane was measured against (`20261004-1239`, 228 segments) `1024` offered every pair while costing 26.7 min
      // of lane against a 6.2 min session. `AssemblyPolicy.recall.window` above carries the arithmetic.
      window: 16,
      anchorWaitMs: 10_000,
      // 16, not 2: what a bounded walk reaches is `w x d`, so the window's reduction is paid back here rather than
      // by restoring a window that cost quadratic pair scoring - and `d` costs the lane nothing (the pair count
      // contains no `d`). See `AssemblyPolicy.recall.depth`.
      depth: 16,
      tier1: 's1',
      embedModel: '',
      minRecalledShare: 0,
      minRecalledSegments: 1,
    },
    tail: { k: 3 },
    // **The method under test, and therefore the default — and the only layout axis.** `'trace-as-state'` is
    // `M([T, x, q])` — the trace in front of the long context, which is what "Trace as State" names and what the
    // project exists to measure. `'trace-append'` is the paper's own control (`M([x, T, q])`, the same two elements
    // with order as the only difference). It stays a value and no cell preset sets it for the reason
    // `assemblyTrigger` is left alone: the contrast is measured by *running both arms*, so a preset carrying one
    // side would redefine which arm that cell is - and a round that wants the control writes one key in its own
    // profile patch.
    //
    // The question is not a field here any more, and its absence is the correction: `q` is the last block of
    // `layout.order` unconditionally, because the paper separates the question from the long context and places it
    // "at the end of every input" (arXiv:2609.02702 §4.1) in all three of its conditions. Until 2026-10-05 a second
    // axis - a boolean `xFirst`, renamed `questionPlacement` for a day - could move it, and its default put the
    // question *second* (`[T, q, x]`) in all three cells: a layout the paper does not have, while the two orders
    // the project named its arms after were both unreachable without an override no preset wrote. Deleting the
    // axis, rather than renaming it, is what makes `tracePlacement` the only thing a round can vary about the
    // order.
    tracePlacement: 'trace-as-state',
    deliver: false,
    // The project's own requirement, not a tuning value: the originating brief says recall is driven by "the user
    // input *or* the model's own self-directed input" (idea 3) and that every new session event segment - "user
    // input x, or LLM output o, tool results, etc." - feeds the association graph (idea 2). A step that claims no
    // messages is still a step whose input the model chose, so `'claimed-only'` assembles on the user's turn and
    // then goes quiet for the rest of it: round `20261004-0205` measured that as **2 assemblies in 53 steps** in
    // C2, i.e. 51 steps of self-directed input with no recall at all. `'every-step'` is therefore the default.
    // `'claimed-only'` is kept as a value because the round that measured it is on disk and has to stay readable.
    assemblyTrigger: 'every-step',
    s1: { provider: 'jev', baseUrl: '', model: '', apiKey: '', questionsPerCall: 20, retryAttempts: 1, admissionLimit: 2 },
  };
}

/**
 * Ablation cell presets (docs/AGENT_BRIEF.md §9.1): C0 the baseline, C1 the paper's arm (the trace is delivered,
 * with no recall selection and no System-1 lane), C2 the full configuration.
 *
 * **The registered contrasts are `C0 → C1` and `C1 → C2`**, the paper's own two steps: what the trace's presence
 * buys, and what the recall selection buys on top of it. `C0 → C2` alone conflated them once `T` became
 * deliverable, which is why C1 was re-opened on 2026-10-04 after a day's re-registration as a placebo.
 *
 * `assemblyTrigger` is deliberately absent from every case below: all three arms run the default
 * `'every-step'`, which the brief requires, so that no cell silently runs a half-mechanism
 * and not a cell. `authority.test.ts` fails if a preset ever starts carrying it.
 *
 * **`tracePlacement` is the only layout axis, and `q` is last in every cell by construction.** Neither is set
 * below, so every cell lays out the paper's arrangement: the question last — the last block of `layout.order` is
 * `anchor` whatever the cell is, because the paper separates the question from the long context and places it "at
 * the end of every input" (arXiv:2609.02702 §4.1), with `[T, x, q]` and `[x, T, q]` as its two literal orders — and
 * the trace in front of the long context (`tracePlacement: 'trace-as-state'`, which is `M([T, x, q])`, the method).
 * Before 2026-10-05 each cell set a boolean `xFirst: true` that moved the anchor instead, so all three recorded
 * `[T, q, x]` — a layout the paper does not have, while the two names the project used for its arms
 * (`[T, x, q]` and `[x, T, q]`) were both unreachable without an override no cell ever wrote.
 *
 * The correction **deleted the second axis rather than renaming it**. Renaming it to
 * `questionPlacement: 'first' | 'last'` kept the wrong idea alive: it left "the question's position is a variable"
 * expressible, and `'first'` produced `[T, q, x]`, which is neither paper arm. A field whose only other value lays
 * out a condition the paper does not have is not a variable, so a profile that still spells the old key is read
 * and reported (`LEGACY_LAYOUT_KEYS` in `config.ts`) and the value that asked for `q` first is refused there
 * rather than translated. `authority.test.ts` asserts the arm and the recorded order for all three cells.
 *
 * `tracePlacement` itself stays out of the presets for the reason `assemblyTrigger` does: it is the paper's
 * Trace-as-State vs Trace-Append contrast, and that contrast is only measured by running both arms. A preset
 * carrying a value would put a cell on one side of the paper's own control and quietly redefine which arm that cell
 * *is*; a round that wants the control writes `tracePlacement: trace-append` in one profile.
 */
export function cellPolicy(cell      )                 {
  const p = defaultPolicy();
  p.cell = cell;
  switch (cell) {
    case 'C0': // baseline: chronological append, native compaction only
      p.tas.on = false;
      p.recall.tier1 = 'off';
      // **`deliver` is not set here any more (2026-10-05), and its absence is the point rather than a gap.** The
      // baseline is the one cell that does not take context management away from the harness: it delivers nothing
      // at all, so what it measures is the harness doing what it would have done anyway. That value now comes from
      // `bench/cells/C0.json` (`deliver: false`), because a switch the cell *is* belongs in the file a reader
      // compares against the run - and because this function is code, it could not be changed by a researcher, not
      // even through the panel. The wiring record carries the result and `cellPreset.fromPreset` names where it came
      // from, so "which value ran" is readable without opening this file.
      // No layout line, and the absence is the point: the baseline is `M([x, q])` — the long context, then the
      // question — which is what the defaults lay out with TAS off. The `xFirst = false` that used to sit here was
      // written to make the baseline chronological, and it recorded `pinned, anchor, recalled, tail`: the question
      // *first*, which is the baseline of no paper arm either. The paper's baseline ends in `q` like its two other
      // conditions, and this cell now does too — with the second axis deleted, `layout.order` here ends in `anchor`
      // and there is no setting that can say otherwise.
      break;
    case 'C1': // the paper's Trace-as-State arm: the trace reaches the model, no recall selection and no System-1 lane
      p.tas.on = true;
      p.recall.tier1 = 'off';
      // **Re-opened 2026-10-04**, reversing the 2026-10-02 re-registration, because the reason that closed it is
      // gone. It was closed on a fact that is no longer true: delivery inserted the `recalled` block and nothing
      // else (`T` was deliberately never sent), so with `tier1: 'off'` this arm's channel was empty by
      // construction, every assembly refused with "nothing to insert", and the model read what C0's model read -
      // two rounds agreeing (20261002-2037: 76 assemblies, 0 with a non-empty recalled block; 20261001-1300: 13
      // assemblies, 13 refusals, 0 `delivered: true`). C1 then became a second control arm: a placebo.
      //
      // `tas.on` now implies `T` is delivered (`packages/dsh-plugin/src/context-delivery.ts`), so this arm's
      // channel carries the trace alone and fires. That is what makes it the arm the whole scheme was missing:
      // `C0 -> C1` is the paper's Trace-as-State contrast with the System-1 lane **absent** (`s1.provider: 'none'`
      // stays, so the TAS claim is measurable with the lane out rather than merely unscoped), and `C1 -> C2` is
      // S1CAP's recall contribution on top of it. Leaving this arm closed would conflate those two variables in
      // every C0-vs-C2 comparison, because C2 now differs from C0 in the recall selection *and* in `T`.
      //
      // The honest part that survives: **the layout axis reaches the model in no arm.** The one insertion channel
      // appends, so the injected message is `T` followed by the recalled turns whatever the recorded order was; the
      // layout axis is measured in `layout.order`, not in the delivered text. C1 is a control over *recall
      // selection* and over the lane, not over the layout.
      //
      // `deliver: true` is not set here any more (2026-10-05); `bench/cells/C1.json` carries it. This arm and C2 are
      // the two that own context management, and the file says so where a reader can change it.
      break;
    case 'C2':
      // the full configuration: the paper's Trace-as-State ordering plus S1 governance (recall selection). The
      // second half of that governance used to be a plan gate; it is gone, and the comment above `s1` says why.
      //
      // `tier1: 's1'` is stated here as well as in `defaultPolicy()` because it is the half that decides whether
      // this cell has anything to deliver at all: `'s1'` is the tier-1 mode that exists (one batched `noul` call),
      // and until 2026-10-02 the preset said `'embed'` - a mode with no implementation anywhere, read by exactly
      // one test (`!== 'off'`). The cell that *is* the full configuration must name the mechanism it runs.
      p.recall.tier1 = 's1';
      // `deliver: true` likewise comes from `bench/cells/C2.json` since 2026-10-05.
      break;
  }
  return p;
}