/**
 * Provider matrix for the decision-model wire protocol (`POST {baseUrl}/v1/systemone`).
 *
 * Exactly one provider is active at a time (docs/AGENT_BRIEF.md §0.9): S1CAP speaks to a single
 * System-1 backend per session, chosen by `s1.provider`. Local runtimes are reachable through
 * `laya-runtime`; the cloud Jev deployment needs an API key.
 */
                                                  

                                   
                  
                
                                                                        
                 
                                                                 
                            
 

export const PROVIDERS                                                            = {
  jev: {
    baseUrl: 'https://api.typesafe.ai',
    model: 'jev-latest',
    local: false,
    keyEnv: ['TYPESAFE_API_KEY', 'S1CAP_API_KEY'],
  },
  'laya-serve': {
    baseUrl: 'http://127.0.0.1:8008',
    model: 'laya-typed-decisions',
    local: true,
    keyEnv: ['LAYA_API_KEY', 'S1CAP_API_KEY'],
  },
  edgejev: {
    baseUrl: 'http://127.0.0.1:8008',
    model: 'laya-mmbert-322m-int8',
    local: true,
    keyEnv: ['S1CAP_API_KEY'],
  },
  kev: {
    baseUrl: 'http://127.0.0.1:8008',
    model: 'kev-4b',
    local: true,
    keyEnv: ['S1CAP_API_KEY'],
  },
};

export const S1_PROVIDERS                            = ['jev', 'laya-serve', 'edgejev', 'kev', 'none'];
