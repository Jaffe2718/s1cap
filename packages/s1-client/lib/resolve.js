/**
 * Backend resolution: turn `s1` + `laya` config into exactly one usable System-1 endpoint.
 *
 * Rule enforced here (docs/AGENT_BRIEF.md §0.9): **one S1 backend at a time**. Enabling the local
 * Laya runtime while selecting a cloud provider (or the reverse) is a configuration error rather
 * than a silent priority decision, because a session that quietly switches governors makes its own
 * measurements meaningless.
 */
                                                  
import { PROVIDERS } from './providers.js';

                                
                           
                   
                 
                  
 

/** The subset of the Laya runtime config that affects the endpoint. */
                                    
                   
               
               
                 
 

                                    
                           
                                   
                   
                 
                                                                     
                  
 

                                                         

/** Redact a key for logs and status output: never print a usable credential. */
export function redactKey(key                    )         {
  if (!key) return '(none)';
  if (key.length <= 8) return `**** (${key.length} chars)`;
  return `${key.slice(0, 4)}…${key.slice(-2)} (${key.length} chars)`;
}

/** Configuration conflicts that must be fixed by the user, not silently resolved. */
export function singleBackendIssues(s1               , laya                    )           {
  const issues           = [];
  if (!laya) return issues;

  if (laya.enabled && s1.provider === 'none') {
    issues.push('laya.enabled is true but s1.provider is "none" — enable one backend or disable Laya');
  }
  if (laya.enabled && !PROVIDERS[s1.provider                                   ]?.local) {
    issues.push(
      `only one S1 backend may be active: laya.enabled=true conflicts with s1.provider="${s1.provider}" (set provider to "laya-serve", or disable Laya)`,
    );
  }
  if (!laya.enabled && s1.provider === 'laya-serve') {
    issues.push('s1.provider is "laya-serve" but laya.enabled is false — the local server would never start');
  }
  return issues;
}

/**
 * Resolve the single active backend. Precedence for the key: explicit config, then the
 * provider's environment variables (never the other way round, so a profile patch can pin a
 * dedicated key).
 */
export function resolveS1Backend(
  s1               ,
  laya                    ,
  env          = process.env           ,
)                    {
  if (s1.provider === 'none') return { provider: 'none', mode: 'none' };

  const defaults = PROVIDERS[s1.provider];
  const isLaya = s1.provider === 'laya-serve';

  let baseUrl = s1.baseUrl && s1.baseUrl !== '' ? s1.baseUrl : undefined;
  if (!baseUrl && isLaya && laya) baseUrl = `http://${laya.host}:${laya.port}`;
  if (!baseUrl) baseUrl = defaults.baseUrl;

  const model = s1.model && s1.model !== '' ? s1.model : (isLaya && laya?.model ? laya.model : defaults.model);

  let apiKey = s1.apiKey && s1.apiKey !== '' ? s1.apiKey : undefined;
  if (!apiKey) {
    for (const name of defaults.keyEnv) {
      const value = env[name];
      if (value && value !== '') {
        apiKey = value;
        break;
      }
    }
  }

  return {
    provider: s1.provider,
    mode: defaults.local ? 'local' : 'cloud',
    baseUrl: baseUrl.replace(/\/+$/, ''),
    model,
    ...(apiKey ? { apiKey } : {}),
  };
}

/** Human-readable, credential-free summary for `/s1 status` and logs. */
export function describeS1Backend(resolved                   )         {
  if (resolved.mode === 'none') return 'provider=none (S1CAP observes only, no System-1 calls)';
  const key = resolved.mode === 'cloud' ? `, key=${redactKey(resolved.apiKey)}` : '';
  return `provider=${resolved.provider} (${resolved.mode}), baseUrl=${String(resolved.baseUrl)}, model=${String(resolved.model)}${key}`;
}
