/**
 * Laya runtime configuration — the machine-specific half lives in the DSH profile
 * (`~/.dsh/profiles/<name>/cordis.patch.yml`), never in this repository.
 */

                             
                                                       
                   
                                                                   
                      
                                                                          
                    
                                                      
                     
                                                        
                             
                                                                                    
                               
     
                                                                                                       
                                                                                                       
                                                                                                    
     
                           
     
                                                                       
    
                                                                                                             
                                                                                                           
                                                                                                            
                                                                                                            
                                           
     
                         
                                                        
                        
                                                 
                       
               
               
                                                                               
                     
                                               
                 
                                               
                     
                                                            
                           
                                                     
                         
                                                                                            
                               
                                                 
               
 

export function defaultLayaConfig()             {
  return {
    enabled: false,
    preferConsoleScript: true,
    host: '127.0.0.1',
    port: 8008,
    healthPath: '/health',
    autoStart: true,
    startupTimeoutMs: 120_000,
    pollIntervalMs: 500,
  };
}

/** Base URL the System-1 client should talk to for this configuration. */
export function layaBaseUrl(cfg                                   )         {
  return `http://${cfg.host}:${cfg.port}`;
}
