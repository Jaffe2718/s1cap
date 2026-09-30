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
                                 
                    
                                                          
                      
                      
                  
                                                                   
                  
     
                                                                                                            
                                                                                                         
                                                                         
     
                  
 

                                 
                         
           
                  
                 
                                    
    
                              
                                                                            
                   
                                                                                       
                               
       
                                                                                                             
                                                                                                             
                                                                                    
       
                               
                                                                                           
                          
       
                                                                                                                
                                                                                                              
                                  
       
                           
    
                                         
           
                       
                     
                     
       
                                                                                                             
                                                                                                               
                                                                                          
       
                             
    
 

                                
             
                  
 

                            
             
                                                
               
                     
 

                                   
                                    
                  
                                                              
                                
                                                                  
                     
 

/** Default policy = cell C4 (full system). Cells C1–C3 are derived by toggles. */
export function defaultPolicy()                 {
  return {
    cell: 'C4',
    termination: 'model-owned',
    assemblyDeadlineMs: 250,
    rgMaintenance: { mode: 'async', maxLagTurns: 2 },
    cache: { reselectPolicy: 'perTask', blockTokens: 64 },
    tas: { on: true, tMaxChars: 8000, updatePolicy: 'perTask' },
    recall: {
      relevanceThreshold: 0.55,
    window: 1024,
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
    s1: { provider: 'jev', baseUrl: '', model: '', apiKey: '', timeoutMs: 2500, questionsPerCall: 20 },
  };
}

/** 2×2 ablation cell presets (docs/AGENT_BRIEF.md §9.1). */
export function cellPolicy(cell      )                 {
  const p = defaultPolicy();
  p.cell = cell;
  switch (cell) {
    case 'C1': // baseline: chronological append, native compaction only
      p.tas.on = false;
      p.recall.tier1 = 'off';
      p.planGate.on = false;
      // The baseline is the one cell that does not take history management away from the harness: it delivers
      // nothing, so what it measures is the harness doing what it would have done anyway. Every other cell
      // delivers its assembled view, because "ordering only" and "S1 governance only" are statements about what
      // the model is shown - a cell that assembles a layout nobody receives is not an ablation arm.
      p.deliver = false;
      // The baseline is chronological, so x goes last. Leaving this at the default made C1 and C3 carry the
      // position intervention the ablation is meant to isolate, so the one knob that distinguishes them from
      // C2 and C4 was pinned to the same value in all four cells and the layout axis could not be read at all.
      p.xFirst = false;
      break;
    case 'C2': // +TAS ordering only
      p.tas.on = true;
      p.recall.tier1 = 'off';
      p.planGate.on = false;
      p.deliver = true;
      p.xFirst = true;
      break;
    case 'C3': // +S1 governance only (selection + plan gate), chronological layout
      p.tas.on = false;
      p.recall.tier1 = 'embed';
      p.planGate.on = true;
      p.deliver = true;
      p.xFirst = false;
      break;
    case 'C4':
      // full method: TAS ordering, S1 governance, x-first layout
      p.deliver = true;
      p.xFirst = true;
      break;
  }
  return p;
}