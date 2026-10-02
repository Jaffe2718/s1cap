/**
 * Telemetry schema v1 (docs/AGENT_BRIEF.md §8).
 * Field names are frozen once the first benchmark run starts: add, never rename.
 */

export const TELEMETRY_SCHEMA_VERSION = 1         ;

/** USD per 1M tokens. Verified 2026-09-28 (docs/AGENT_BRIEF.md §1.7). */
                              
              
               
              
 

export const PRICES = {
  'deepseek-flash-peak': { hit: 0.006, miss: 0.3, out: 1.2 },
  'deepseek-flash-offpeak': { hit: 0.003, miss: 0.15, out: 0.6 },
  'deepseek-v4-pro-peak': { hit: 0.044, miss: 1.32, out: 3.96 },
  'glm-5.3': { hit: 0.26, miss: 1.4, out: 4.4 },
  'glm-5.3-flash': { hit: 0.03, miss: 0.15, out: 0.5 },
}                                               ;

                                           

/** Jev: $0.042 per 1M input tokens, output free. */
export const S1_PRICE_PER_M_INPUT = 0.042;

                               
                   
                                          
             
                    
                  
               
                
              
                       
                         
                          
                       
                           
                                           
                 
                                                                        
                         
                                                                                     
                       
                                                          
                                                                              
 

                              
                  
                                          
             
                   
                                                                    
                           
                                    
                    
                      
                       
             
                                                                              
                  
                                                                    
                              
                                                                                              
                       
     
                                                                                                
                                                                                                  
                                                                                          
     
                    
     
                                                                                
                                                                                               
                                                                                                  
     
                
     
                                                                                     
    
                                                                                                              
                                                                                                               
                                                                                           
     
                    
                    
     
                                                                                                   
                                                                                                   
                                    
     
               
                                                                               
                 
 

                                
                    
                                          
             
               
             
              
                         
 

                                
                   
                                          
             
                                                                                                                                            
                     
                                                                             
                   
                                                                                                               
                       
     
                                                                                                                
                                                                                                                 
                                                                                                          
     
                       
     
                                                                                                               
                                                  
    
                                                                                                                  
                                                                                                                  
                                                                                                             
                                                                                                                
                                                    
     
                         
              
                     
                   
                   
                     
                      
                                 
                             
     
                                                                                                           
    
                                                                                                               
                                                                                                             
                                               
     
                         
                                                    
                   
                                                                                                
                              
                                                                                         
                         
                                                                
                          
                    
     
                                                                                         
    
                                                                                                                 
                                                                                                                  
                                                                                                                
                                                                                                               
                                                                     
    
                                                                                                                 
     
                                       
 

                                
                    
                                          
             
                  
                  
                       
                  
                     
                     
                    
                         
 

                            
                
               
                 
                 
                 
                         

/**
 * What the model was actually shown, per step.
 *
 * This record exists because "assembled" and "delivered" are different states, and every counter in this project
 * used to report the first while the experiment needed the second: a layout that is computed, recorded with its
 * token counts, and never put in front of the model is a claim in a JSONL file. One record per `agent/pre-step`
 * says which of the two happened, and why not when it did not.
 */
                                       
                           
                                          
             
                     
                                       
                
                                                                                       
               
                                                                                
                     
                                                                    
                 
                                                                     
                         
                        
                                                                                             
               
                                                             
                  
                                                                                  
                   
                                                                                             
                   
                                                                                            
                    
                                                      
                  
 

/** Cost of one LLM call in USD. */
export function llmCallCost(e              , prices             )         {
  return (
    (e.cacheHitTokens * prices.hit + e.cacheMissTokens * prices.miss + e.outputTokens * prices.out) /
    1_000_000
  );
}

/** Cost of one System-1 call in USD (output is free on Jev). */
export function s1CallCost(inputTokens        , pricePerMInput         = S1_PRICE_PER_M_INPUT)         {
  return (inputTokens * pricePerMInput) / 1_000_000;
}

                                  
                 
                
                   
                                                     
                       
                   
                  
                 
                   
               
 

/** Aggregate every event of one task into the metrics the paper reports. */
export function summarizeTask(events                           , prices             )                  {
  let llmUsd = 0;
  let s1Usd = 0;
  let hit = 0;
  let miss = 0;
  let out = 0;
  let llmCalls = 0;
  let s1Calls = 0;
  let toolMs = 0;
  let netLlmMs = 0;
  let s1Ms = 0;

  for (const e of events) {
    switch (e.type) {
      case 'llm_call':
        llmUsd += llmCallCost(e, prices);
        hit += e.cacheHitTokens;
        miss += e.cacheMissTokens;
        out += e.outputTokens;
        netLlmMs += e.netLatencyMs;
        llmCalls += 1;
        break;
      case 's1_call':
        s1Usd += s1CallCost(e.inputTokens);
        s1Ms += e.ms;
        s1Calls += 1;
        break;
      case 'tool_call':
        toolMs += e.ms;
        break;
      case 'assembly':
      case 'plan_gate':
        break;
    }
  }

  const promptTokens = hit + miss;
  return {
    llmUsd,
    s1Usd,
    totalUsd: llmUsd + s1Usd,
    tokens: { hit, miss, out },
    cacheHitRate: promptTokens > 0 ? hit / promptTokens : 0,
    llmCalls,
    s1Calls,
    toolMs,
    netLlmMs,
    s1Ms,
  };
}

/** Append-only JSONL sink; the caller owns the file handle. */
export class JsonlSink {
  #write                        ;

  constructor(write                        ) {
    this.#write = write;
  }

  emit(event                )       {
    this.#write(`${JSON.stringify(event)}\n`);
  }
}
