/**
 * S1CAP core types — the contract shared by every package.
 * Mirrors docs/AGENT_BRIEF.md §4. Field names are versioned contracts:
 * add fields, never rename (see docs/AGENT_BRIEF.md §0 rule 5).
 */

export const CORE_SCHEMA_VERSION = 1         ;

                         
          
               
           
              
                
                   

                          
             
                    
                                                
              
                    
                
                                                                                     
                 
               
             
                   
                                                                      
                   
 

                                                                   

                                  
               
             
                                        
            
                                          
                 
                     
                     
                                                             
                     
 

                                             

                                                                               

                                 
             
     
                                                                                     
                                                                                  
                                                                                     
                                                                                 
     
                             
                                                                                                               
                             
     
                                                                                    
                                                                                      
                                                                   
     
                                                        
     
                                                                                            
                                                                                           
                                                                    
     
          
                                                                                                                                    
                                                        
                                                                                                                 
                        
    
        
                
                                                    
                      
                                                                     
                                        
    
           
                                
                                                                  
                                 
         
                                                                                                    
                                                                                                 
                                                                                                     
         
                     
                              
                  
                                      
                   
                                  
                        
                                                                     
                        
                                                               
                             
    
                      
     
                                                                
    
                                                                                                               
                                                                                                     
                                                                                                            
                                                                                                         
    
                                                                                                                
                                                                                                              
                                                                                       
     
                  
             
                
                                   
                     
                               
                       
                              
    
       
                             
                                                                          
                     
                                                                      
                   
                                                                                                         
                    
                      
                                                               
                             
    
 

                                 
           
                      
                                                            
                        
                        
                    
                                                                     
                    
       
                                                                                                              
                                                                                                           
                                                                           
       
                    
    
           
                  
                 
                                    
    
                              
                                                                            
                   
                                                                                       
                               
       
                                                                                                             
                                                                                                             
                                                                                    
       
                               
                                                                                           
                          
       
                                                                                                                
                                                                                                              
                                  
       
                           
    
                                         
           
                       
                     
                     
       
                                                                                                             
                                                                                                               
                                                                                          
       
                             
    
 

                                
             
                  
 

                            
             
                                                
               
                     
 

                                   
                                    
                  
                                                              
                                
                                                                  
                     
 

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
      minRecalledShare: 0.25,
    },
    tail: { k: 3 },
    xFirst: true,
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
      // The baseline is chronological, so x goes last. Leaving this at the default made C1 and C3 carry the
      // position intervention the ablation is meant to isolate, so the one knob that distinguishes them from
      // C2 and C4 was pinned to the same value in all four cells and the layout axis could not be read at all.
      p.xFirst = false;
      break;
    case 'C2': // +TAS ordering only
      p.tas.on = true;
      p.recall.tier1 = 'off';
      p.planGate.on = false;
      p.xFirst = true;
      break;
    case 'C3': // +S1 governance only (selection + plan gate), chronological layout
      p.tas.on = false;
      p.recall.tier1 = 'embed';
      p.planGate.on = true;
      p.xFirst = false;
      break;
    case 'C4':
      // full method: TAS ordering, S1 governance, x-first layout
      p.xFirst = true;
      break;
  }
  return p;
}