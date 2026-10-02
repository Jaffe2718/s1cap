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
 * One LLM call, priced.
 *
 * THERE IS NO `flags` FIELD HERE, AND THERE IS NO `planGate` ANYWHERE (2026-10-02, revised after the audit).
 *
 * This interface carried `flags: { tas, sel, planGate, degraded }` as a **required** field. Nothing in
 * `packages/*&#47;src` ever assigned it, no round's artifacts carry it, and one of the four names described a
 * component the policy no longer has: a required field that is never populated is a lie in the type, and the
 * build is pure type erasure (`scripts/build-packages.mjs` strips types; `typescript` is not installed), so
 * nothing would ever have reported it. `packages/dsh-plugin/test/observer.test.ts` records the same lesson for a
 * runtime property that did not exist on its declared type.
 *
 * The audit names this field as `S1CallEvent.flags` (`s1cap-audit-lane.md`, F13); it is `LlmCallEvent`'s, and
 * `S1CallEvent` has never had one. The substance is stronger than the finding says: nothing emits an `llm_call`
 * record at all — round `20261002-2037`'s control planes hold only `assembly`, `context_delivery` and `s1_call` —
 * so the bucket had no producer anywhere, and `core.test.ts` now pins its absence because the type checker that
 * would otherwise notice cannot run.
 *
 * The field was described to the reader as "which interventions were active for this call". Two of the three
 * survivors could not answer that either: `tas` is true whenever TAS assembled a layout, whether or not the
 * layout was delivered, and `deliver` is the switch that decides whether the model saw it (see the C1 finding in
 * `s1cap-audit-lane.md`). A flag that is set from the policy rather than from the delivery would repeat exactly
 * the defect it was meant to record.
 *
 * What replaces it, if this type is ever emitted: derive the flags from the *outcome* the lane already records -
 * `assembly.layoutOrder` contains the state proxy, `context_delivery.delivered` says whether it reached the model,
 * and `s1_call.judgedPairs` covers selection - so a reader can check them against a record instead of trusting a
 * policy read. Nothing emits an `llm_call` record today; the cells' own token account is read from
 * `assistant/message.usage` by `scripts/cell-report.mjs`, which is why this removal changes no artifact.
 */
                               
                   
                                          
             
                    
                  
               
                
              
                       
                         
                          
                       
                           
                                           
                 
                                                                        
                         
                                                                                     
                       
                                                          
 

                              
                  
                                          
             
                   
                                                                    
                           
                                    
                    
                      
                       
             
                                                                              
                  
                                                                    
                              
                                                                                              
                       
     
                                                                                                
                                                                                                  
                                                                                          
     
                    
     
                                                                                
                                                                                               
                                                                                                  
     
                
     
                                                                                     
    
                                                                                                              
                                                                                                               
                                                                                           
     
                    
                    
     
                                                                                                   
                                                                                                   
                                    
     
               
                                                                               
                 
 

                                
                    
                                          
             
               
             
              
                         
 

                                
                   
                                          
             
                                                                                                                                            
                     
                                                                             
                   
     
                                                                                                                 
                                                                      
    
                                                                                                              
                                                                                                             
                                                                                                           
                                                                                                         
                                                                                                                
                                                                                                            
                                                                                                 
     
                       
     
                                                                                                              
                                                                  
    
                                                                                                                 
                                                                                                             
                                            
     
                       
     
                                                                                                               
                                                                                                            
                         
    
                                                                                                                  
                                                                                                                  
                                                                                                             
                                                                                                                
                                                    
     
                         
     
                                                                                                          
    
                                                                                             
    
                                                                                                              
                                                                                                                 
                                                                                                           
                                                                                                                
                                                                                                                
                                                                                                    
     
                         
              
                     
                   
                   
                     
                      
                                 
                             
     
                                                                                                           
    
                                                                                                               
                                                                                                             
                                               
     
                         
                                                    
                   
                                                                                                
                              
                                                                                         
                         
                                                                
                          
     
                                                                                                                 
                                
    
                                                                                                             
                                                                                                           
                                                                                                                
                                                                                                                  
                                                                                                              
                                                                                                          
                                                                                                                 
                                                                                                          
     
                    
     
                                                                                                               
                                     
    
                                                                                                                
                                                                                                               
                                                                                                         
                                                                                                               
                                                                                                        
                                                                                                                  
                                                                                                             
                                                                                        
    
                                                                                                                 
                                                                                                                 
                                                                                                             
                                                                                                      
                   
     
                           
     
                                                                                         
    
                                                                                                                 
                                                                                                                  
                                                                                                                
                                                                                                               
                                                                     
    
                                                                                                                 
     
                                       
 

                                
                    
                                          
             
                  
                  
                       
                  
                     
                     
                    
                         
 

                            
                
               
                 
                 
                 
                         

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
