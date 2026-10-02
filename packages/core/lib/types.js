/**
 * S1CAP core types — the contract shared by every package.
 * Mirrors docs/AGENT_BRIEF.md §4. Field names are versioned contracts:
 * add fields, never rename (see docs/AGENT_BRIEF.md §0 rule 5).
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
                                                                               

                                  
               
             
                                        
            
                                          
                 
                     
                     
                                                             
                     
 

                                      

                                                                               

                                 
             
     
                                                                                     
                                                                                  
                                                                                     
                                                                                 
     
                             
                                                                                                               
                             
     
                                                                                    
                                                                                      
                                                                   
     
                                                        
     
                                                                                            
                                                                                           
                                                                    
     
          
                                                                                                                                    
                                                        
                                                                                                                 
                        
    
        
                
                                                    
                      
                                                                     
                                        
    
           
                                
                                                         
                        
         
                                                                                                    
                                                                                                 
                                                                                                     
         
                     
         
                                                                                                             
                  
        
                                                             
        
                                                                                                            
                                                                                                                  
                                                                                                                 
                                                                                                               
                                                                                                                   
                                                                                                                   
                                                                 
        
                                                                                                                 
                                                                                                                  
                                                                                                 
         
                           
                              
                  
                                      
                   
       
                                                                                                                   
                           
      
                                                                                                             
                                                                                                         
                               
                                                                                                               
                                                                                                                 
                                                                                                                 
                                                                                                                
                                                                                                                  
                                                                                         
      
                                                                                               
                                                                                                             
                                                                                                                    
                                                   
       
                        
       
                                                                                                           
                                                                                                                  
                                                                                                                 
                                                                                                              
                                                                                           
       
                        
                                                                     
                        
       
                                                                                                              
                                                                    
      
                                                                                                                
                                                                                                                 
                                                                                                                 
                                                                                                                  
                                                                                    
      
                                                                                                       
                                                                                                                 
       
                             
       
                                                                                           
      
                                                                                                               
                                                                                                               
                                                                                                                 
                                                                                                        
       
                                
    
                      
     
                                                                
    
                                                                                                               
                                                                                                     
                                                                                                            
                                                                                                         
    
                                                                                                                
                                                                                                              
                                                                                       
     
                  
     
                                                      
    
                                                                                                                 
                                                                                                              
                                                                                                                  
                                                                     
    
                                                                                                                  
                                                                                                        
                                                                                                                
                                                                                                                  
                                                                                                            
                                                                                                          
                                                                                                               
                                                                                                                
                                                                                                         
    
                                                                                                                  
                                                                                                                   
                                                                                                           
                                                                                                                  
                                                                                                                 
                                                                                            ﻿                     
                                                                           
     
                   
    
                                                                                     
    
                                                                                                   
                                                                                                              
                                                                                                               
                                                                                                               
                                                                                                             
                                                                                                                
                                                                                                                
                                                                                                                
                                                                                                            
                        
    
                                                                                                           
                                                                                                                
                                                                                                              
                                                                                                             
                                                                                                             
                                                                                                                 
                                                                                                             
                                                                                                               
                                                                                                               
                                                                     
     
       
                             
                                                                          
                     
                                                                      
                   
                                                                                                         
                    
       
                                                                                                            
                                                                                                            
                                                                                                             
                                                                                                            
       
                                                               
                             
       
                                                                                                              
                                                                                                                 
      
                                                                                                    
                                                                                                              
                                                                                                                  
                                                                                                        
                                                                                                            
                                                                    
      
                                                                                                                  
                                                               
       
                          
       
                                                                                                               
      
                                                                                                       
                                                                                                      
                                                                                                                  
                                                                                                              
      
                                                                                                                 
                                                                                                                 
                                                                                                               
                                                                                                           
                                                                                                                
                                                                                                        
      
                                                                                                               
                                                                                                                  
                                                                                                                 
                                                                                                            
       
                           
    
 

/** The blocks of one model-view context, in the order they were laid out. */
                                 
                    
                                                          
                      
                      
                  
                                                                   
                  
     
                                                                                                            
                                                                                                         
                                                                         
     
                  
 

                                 
                         
           
                  
                 
                                    
    
                              
     
                                                                                                               
                                                                             
    
                                                                                                               
                                                                                                                   
                                                                                                               
    
                                                                                                               
                                                                                                              
                                                                          
     
                           
                                                                            
                   
                                                                                       
                               
       
                                                                                                             
                                                                                                             
                                                                                    
       
                               
                                                                                           
                          
       
                                                                                                                
                                                                                                              
                                  
       
                           
    
                                         
           
                       
                     
                     
       
                                                                                                             
                                                                                                               
                                                                                          
       
                             
    
     
                                                     
    
                                                                                                                 
                                                                                                                  
                                                                                                  
    
                                                                                                                
                                                                                                            
                                                                                                         
     
                                      
 

                                
             
                  
 

                            
             
                                                
               
                     
 

                                   
                                    
                  
                                                              
                                
                                                                  
                     
 

/**
 * Default policy = the full configuration (cell C2), which is also the base the other two cells are derived from
 * by toggles. `deliver` is the one switch the base leaves off — a policy that assembles a layout nobody receives
 * is the safe default — and `cellPolicy('C2')` is the only cell that turns it on, because C2 is the only cell whose
 * recalled block can be non-empty (see `AssemblyPolicy.deliver`).
 */
export function defaultPolicy()                 {
  return {
    cell: 'C2',
    termination: 'model-owned',
    assemblyDeadlineMs: 250,
    rgMaintenance: { mode: 'async', maxLagTurns: 2 },
    cache: { reselectPolicy: 'perTask', blockTokens: 64 },
    tas: { on: true, tMaxChars: 8000, updatePolicy: 'perTask' },
    recall: {
      threshold: 0.55,
    window: 1024,
      anchorWaitMs: 10_000,
      depth: 2,
      fanout: 8,
      tier1: 's1',
      embedModel: '',
      budgetRatio: 0.35,
      minRecalledShare: 0,
      minRecalledSegments: 1,
    },
    tail: { k: 3 },
    xFirst: true,
    deliver: false,
    s1: { provider: 'jev', baseUrl: '', model: '', apiKey: '', questionsPerCall: 20, retryAttempts: 1, admissionLimit: 8 },
  };
}

/**
 * Ablation cell presets (docs/AGENT_BRIEF.md §9.1): C0 baseline, C1 second control arm (the TAS switches are
 * recorded configuration and nothing is delivered), C2 the full configuration and the only delivering cell.
 */
export function cellPolicy(cell      )                 {
  const p = defaultPolicy();
  p.cell = cell;
  switch (cell) {
    case 'C0': // baseline: chronological append, native compaction only
      p.tas.on = false;
      p.recall.tier1 = 'off';
      // The baseline is the one cell that does not take history management away from the harness: it delivers
      // nothing, so what it measures is the harness doing what it would have done anyway. C1 delivers nothing as
      // well, for a structural reason rather than a chosen one (see `case 'C1'`), so `deliver` is not what
      // separates the baseline from the other arms: C2 is the only cell that delivers, and the contrast the
      // registered rule tests is C0 against C2.
      p.deliver = false;
      // The baseline is chronological, so x goes last. Leaving this at the default made the baseline carry the
      // position intervention the ablation is meant to isolate: the one knob that distinguishes it from the two
      // ordering cells was pinned to the same value in every cell and the layout axis could not be read at all.
      p.xFirst = false;
      break;
    case 'C1': // second control arm: the TAS switches are recorded configuration, nothing is delivered
      p.tas.on = true;
      p.recall.tier1 = 'off';
      // This arm carried `deliver: true` until 2026-10-02 and it could never fire. Delivery inserts the `recalled`
      // block and nothing else (`T` is deliberately never sent), and with `tier1: 'off'` that block is empty by
      // construction, because the whole recall path sits behind one guard in `assemble()`. So the harness's own
      // decision reached the model untouched, and `tas.on`/`xFirst` reached it in neither this arm nor C0: the
      // model read the same list in both. Measured in round `20261002-2037` (76 assemblies, 0 with a non-empty
      // recalled block) and in round `20261001-1300` (13 assemblies, 13 refusals, 0 `delivered: true`).
      //
      // Kept as a second control arm rather than deleted, because a placebo is worth running: C0 vs C1 must now
      // show no difference, and a difference there is the instrument rather than the method. Its TAS switches stay
      // as recorded configuration, because what is kept is the record of what this arm was configured to do; what
      // they produce is recorded, not delivered.
      p.deliver = false;
      p.xFirst = true;
      break;
    case 'C2':
      // the full configuration: TAS ordering plus S1 governance (recall selection), x-first layout. The second
      // half of that governance used to be a plan gate; it is gone, and the comment above `s1` says why.
      //
      // `tier1: 's1'` is stated here as well as in `defaultPolicy()` because it is the half that decides whether
      // this cell has anything to deliver at all: `'s1'` is the tier-1 mode that exists (one batched `noul` call),
      // and until 2026-10-02 the preset said `'embed'` - a mode with no implementation anywhere, read by exactly
      // one test (`!== 'off'`). The cell that *is* the full configuration must name the mechanism it runs.
      p.recall.tier1 = 's1';
      p.deliver = true;
      p.xFirst = true;
      break;
  }
  return p;
}