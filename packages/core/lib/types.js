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
                                                                               

                                  
               
             
                                        
            
                                          
                 
                     
                     
                                                             
                     
 

                                      

                                                                               

                                 
             
     
                                                                                     
                                                                                  
                                                                                     
                                                                                 
     
                             
                                                                                                               
                             
     
                                                                                    
                                                                                      
                                                                   
     
                                                        
     
                                                                                            
                                                                                           
                                                                    
     
          
                                                                                                                                    
                                                        
                                                                                                                 
                        
    
        
                
                                                    
                      
                                                                     
                                        
    
           
                                
                                                         
                        
         
                                                                                                    
                                                                                                 
                                                                                                     
         
                     
         
                                                                                                             
                  
        
                                                             
        
                                                                                                            
                                                                                                                  
                                                                                                                 
                                                                                                               
                                                                                                                   
                                                                                                                   
                                                                 
        
                                                                                                                 
                                                                                                                  
                                                                                                 
         
                           
                              
                  
                                      
                   
                                  
                        
                                                                     
                        
       
                                                                                                              
                                                                    
      
                                                                                                                
                                                                                                                 
                                                                                                                 
                                                                                                                  
                                                                                    
      
                                                                                                       
                                                                                                                 
       
                             
       
                                                                                           
      
                                                                                                               
                                                                                                               
                                                                                                                 
                                                                                                        
       
                                
    
                      
     
                                                                
    
                                                                                                               
                                                                                                     
                                                                                                            
                                                                                                         
    
                                                                                                                
                                                                                                              
                                                                                       
     
                  
     
                                                      
    
                                                                                                                 
                                                                                                              
                                                                                                                  
                                                                     
    
                                                                                                              
                                                                                                              
                                                                                            
     
                   
             
                
                                   
                     
                               
                       
                              
    
       
                             
                                                                          
                     
                                                                      
                   
                                                                                                         
                    
       
                                                                                                            
                                                                                                            
                                                                                                             
                                                                                                            
       
                                                               
                             
       
                                                                                                              
                                                                                                                 
      
                                                                                                    
                                                                                                              
                                                                                                                  
                                                                                                        
                                                                                                            
                                                                    
      
                                                                                                                  
                                                               
       
                          
    
 

/** The blocks of one model-view context, in the order they were laid out. */
                                 
                    
                                                          
                      
                      
                  
                                                                   
                  
     
                                                                                                            
                                                                                                         
                                                                         
     
                  
 

                                 
                         
           
                  
                 
                                    
    
                              
     
                                                                                                               
                                                                             
    
                                                                                                               
                                                                                                                   
                                                                                                               
    
                                                                                                               
                                                                                                              
                                                                          
     
                           
                                                                            
                   
                                                                                       
                               
       
                                                                                                             
                                                                                                             
                                                                                    
       
                               
                                                                                           
                          
       
                                                                                                                
                                                                                                              
                                  
       
                           
    
                                         
           
                       
                     
                     
       
                                                                                                             
                                                                                                               
                                                                                          
       
                             
    
     
                                                     
    
                                                                                                                 
                                                                                                                  
                                                                                                  
    
                                                                                                                
                                                                                                            
                                                                                                         
     
                                      
 

                                
             
                  
 

                            
             
                                                
               
                     
 

                                   
                                    
                  
                                                              
                                
                                                                  
                     
 

/**
 * Default policy = the full configuration (cell C2), which is also the base the other two cells are derived from
 * by toggles. `deliver` is the one switch the base leaves off — a policy that assembles a layout nobody receives
 * is the safe default — and each cell turns delivery on for itself.
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
      tier1: 'embed',
      embedModel: '',
      budgetRatio: 0.35,
      minRecalledShare: 0,
      minRecalledSegments: 1,
    },
    tail: { k: 3 },
    xFirst: true,
    deliver: false,
    planGate: { on: true, maxPlans: 3, attemptCap: 2, abstainConfidence: 0.5 },
    s1: { provider: 'jev', baseUrl: '', model: '', apiKey: '', questionsPerCall: 20, retryAttempts: 1 },
  };
}

/** Ablation cell presets (docs/AGENT_BRIEF.md §9.1): C0 baseline, C1 TAS alone, C2 the full configuration. */
export function cellPolicy(cell      )                 {
  const p = defaultPolicy();
  p.cell = cell;
  switch (cell) {
    case 'C0': // baseline: chronological append, native compaction only
      p.tas.on = false;
      p.recall.tier1 = 'off';
      p.planGate.on = false;
      // The baseline is the one cell that does not take history management away from the harness: it delivers
      // nothing, so what it measures is the harness doing what it would have done anyway. The other two cells
      // deliver their assembled view, because "TAS alone" and the full configuration are statements about what
      // the model is shown - a cell that assembles a layout nobody receives is not an ablation arm.
      p.deliver = false;
      // The baseline is chronological, so x goes last. Leaving this at the default made the baseline carry the
      // position intervention the ablation is meant to isolate: the one knob that distinguishes it from the two
      // ordering cells was pinned to the same value in every cell and the layout axis could not be read at all.
      p.xFirst = false;
      break;
    case 'C1': // TAS alone: the state proxy exists and x sits before recalled history, no System-1 selection
      p.tas.on = true;
      p.recall.tier1 = 'off';
      p.planGate.on = false;
      p.deliver = true;
      p.xFirst = true;
      break;
    case 'C2':
      // the full configuration: TAS ordering plus S1 governance (recall selection + plan gate), x-first layout
      p.deliver = true;
      p.xFirst = true;
      break;
  }
  return p;
}