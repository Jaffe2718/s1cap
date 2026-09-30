/**
 * Credential intake (N4).
 *
 * User decision: the Jev key is typed by the user in a settings panel and stored by DSH's credential service —
 * never baked into a profile patch, never read from a file this repository authors.
 *
 * What is verified about that service (`scripts/scan-dsh-asar.cjs --members`):
 *   - `dsh-credentials` registers a Cordis Service named `credentials` and is the **dispatch** layer
 *     (`fanOut`, `notifyUpdated`, `notifyRecordUpdated`, `warnListenerFailure`), with keys shaped `"<scope>/<id>"`;
 *   - `dsh-credentials-local` is the **read/write** store and declares `readRecord`, `write`, `resolve`, `set`,
 *     `unset`, `describe`, `describeRecord`, `listRecords`, `modifyRecord`, `reconcileFromDisk`, `refresh`.
 * What is *not* verified is which of those the service exposes to a plugin, and how it layers the process
 * environment, the provider-managed store and a file. This module therefore does not assume a contract: it
 * tries the plausible read entry points in order, reports which one answered (or that none did), and returns
 * `undefined` otherwise. The report is what turns the next real run into the definitive answer — the same
 * technique that closed N1 and N2.
 *
 * A key that is never read is never printed: callers only ever surface it through `redactKey()`.
 */
                                                  
import { S1_PROVIDERS } from '@s1cap/s1-client';

                                       
               
                                                            
                  
                                             
                  
 

                                        
                         
              
                                                                            
                   
                                                                         
                                               
 

const READ_ENTRY_POINTS = ['resolve', 'readRecord', 'get', 'read', 'describeRecord']         ;

/** Accept a plain string, or an object that carries the secret in a conventional field. */
function unwrap(value         )                     {
  if (typeof value === 'string' && value.trim() !== '') return value;
  if (value === null || typeof value !== 'object') return undefined;
  const record = value                                                                        ;
  for (const field of ['value', 'secret', 'text', 'key']         ) {
    const candidate = record[field];
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate;
  }
  return undefined;
}

/**
 * Try to read one credential. Never throws: an unusable service is reported, not escalated, because a plugin
 * must not be able to break a session over an optional secret.
 */
export async function readCredential(opts                       )                                {
  const tried           = [];
  const service = opts.service;
  if (service === null || typeof service !== 'object') {
    opts.report?.({ schema: 0, kind: 'credential', result: 'no credentials service', ref: opts.ref });
    return { tried };
  }

  for (const name of READ_ENTRY_POINTS) {
    const candidate = (service                           )[name];
    if (typeof candidate !== 'function') continue;
    tried.push(name);
    try {
      const raw = await (candidate                            ).call(service, opts.ref);
      const key = unwrap(raw);
      if (key !== undefined) {
        opts.report?.({ schema: 0, kind: 'credential', result: 'read', method: name, ref: opts.ref });
        return { key, method: name, tried };
      }
    } catch (err) {
      // try the next entry point; the caller decides whether the absence matters
      opts.report?.({
        schema: 0,
        kind: 'credential',
        result: 'entry point threw',
        method: name,
        ref: opts.ref,
        error: String(err),
      });
    }
  }

  opts.report?.({
    schema: 0,
    kind: 'credential',
    result: 'not found',
    ref: opts.ref,
    tried,
    available: Object.getOwnPropertyNames(Object.getPrototypeOf(service)).slice(0, 30),
  });
  return { tried };
}
/**
 * Where the settings panel keeps the two recall knobs. Not a secret, but the same store is the only host-side
 * key/value surface this plugin has verified, so the tuning rides along with the key rather than inventing an
 * unverified transport. Value format: `"<depth> <relevanceThreshold>"`, e.g. `"2 0.55"`.
 */
export const TUNING_REF = 's1cap/tuning';

                         
                 
                              
                                                                                         
                  
     
                                                                                                                  
                                    
    
                                                                                                                    
                                                                                                                     
                                                                
     
                        
     
                                                                                                   
    
                                                                                                          
                                                                                                     
     
                   
     
                                                                                        
    
                                                                                                                  
                                                                                                                    
                                                                                                                
                                                                                                                
                                                                             
     
                          
                                                                                             
                               
                                                                          
                             
     
                                                                                                        
    
                                                                                                             
                                                                                                              
                                                                                                             
                                                                                            
    
                                                                                                               
                                                                                                                
                                                      
     
                            
 

/** Read a boolean tuning token. Returns undefined for anything unrecognized, so a typo never flips a layout. */
function parseSwitch(token                    )                      {
  if (token === undefined) return undefined;
  const t = token.trim().toLowerCase();
  if (t === '1' || t === 'on' || t === 'true' || t === 'yes') return true;
  if (t === '0' || t === 'off' || t === 'false' || t === 'no') return false;
  return undefined;
}

/**
 * Parse the tuning string the panel writes.
 *
 * **Fail-safe, and deliberately not clamping:** a field outside its stated range (`d` an integer > 0, `0 <= r <= 1`)
 * is *dropped* so the policy default stands. Clamping would silently run a cell at a value the researcher never
 * chose, which is the one thing an ablation must never do.
 *
 * This reads the legacy `"<d> <r> <w> <xFirst>"` credential string, which is why it takes no `wait`: that field was
 * added after the panel moved to the HTTP route and the keyed command line, and appending a fifth positional here
 * would silently reinterpret an `xFirst` token that an old write already put in slot four. `parseTuningArgs` is the
 * surface that owns it.
 */
export function parseTuning(value                    )         {
  const out         = {};
  if (typeof value !== 'string') return out;
  const parts = value.trim().split(/\s+/);
  const depth = Number(parts[0]);
  if (Number.isInteger(depth) && depth > 0) out.depth = depth;
  const relevanceThreshold = Number(parts[1]);
  if (Number.isFinite(relevanceThreshold) && relevanceThreshold >= 0 && relevanceThreshold <= 1) out.relevanceThreshold = relevanceThreshold;
  const window = Number(parts[2]);
  if (Number.isInteger(window) && window >= 64) out.window = window;
  const xFirst = parseSwitch(parts[3]);
  if (xFirst !== undefined) out.xFirst = xFirst;
  return out;
}
/**
 * A path-looking string, or nothing.
 *
 * Deliberately loose: this does not check that the file exists, because the panel writes a path on a machine
 * where the file may not be there yet (a venv being created, a network drive being mounted) and refusing it would
 * make the field unusable for the case it exists for. It rejects only what cannot be a path at all — empty,
 * whitespace, or a bare token with no separator — so a mistyped field falls back to the default instead of
 * becoming a launch-time failure with a message nobody reads.
 */
export function parsePath(value                    )                     {
  if (typeof value !== 'string') return undefined;
  const trimmed = unquote(value).trim();
  if (trimmed === '') return undefined;
  if (!/[\\/]/.test(trimmed)) return undefined;
  return trimmed;
}

/** A plausible environment-variable name: letters, digits and underscores, starting with a letter or underscore. */
export function parseEnvName(value                    )                     {
  if (typeof value !== 'string') return undefined;
  const trimmed = unquote(value).trim();
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed) ? trimmed : undefined;
}

/**
 * The provider names the panel may send, in the two spellings a human types.
 *
 * `laya` is the short name the radio shows next to "Laya (local)"; the policy calls the same backend
 * `laya-serve` (`PROVIDERS` in `@s1cap/s1-client`, `S1ProviderName` in core). The alias is resolved *before* the
 * membership test, so the accepted set stays exactly the policy's list and not a second one maintained here.
 */
const PROVIDER_ALIASES                                   = { laya: 'laya-serve' };

/**
 * One provider name, canonicalised, or nothing.
 *
 * Fail-safe like the rest of this file: an unknown provider is dropped rather than clamped to the nearest known
 * one, because a value the researcher never chose must not decide which backend answers. The set is the policy's
 * own `S1_PROVIDERS`, so a provider added there is settable from the panel the same day.
 */
export function parseProvider(value                    )                             {
  if (typeof value !== 'string') return undefined;
  const name = unquote(value).trim().toLowerCase();
  if (name === '') return undefined;
  const canonical = PROVIDER_ALIASES[name] ?? name;
  return (S1_PROVIDERS                     ).includes(canonical) ? (canonical                  ) : undefined;
}

/**
 * Split the tuning string into tokens, honouring double quotes anywhere inside a token.
 *
 * Quoting is not a nicety here — it is load-bearing on this machine. The interpreter this plugin is most likely to
 * be pointed at is the one DSH ships, and that path is `D:\Program Files\DeepSeek Harness\resources\...`. A plain
 * space-separated split cuts it into three tokens, so the panel would store nothing at all and the required field
 * would stay empty with no error anywhere. Found by a test written for an unrelated reason.
 *
 * The pattern matters: a token is a run of non-space characters *in which a quoted section counts as one unit*.
 * A plain `\S+` alternative loses, because the scan starts at the key and the opening quote is swallowed along
 * with the first word — the first version of this cut `laya="D:/Program Files/…"` down to `D:/Program`.
 */
function tokenize(input        )           {
  return input.match(/(?:[^\s"]|"[^"]*")+/g) ?? [];
}

/** Drop one layer of surrounding double quotes, which the tokenizer keeps so quoted sections stay together. */
function unquote(value        )         {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

/**
 * Parse a tuning command line. Accepts `3 0.7`, `d=3 r=0.7`, `depth=3 relevanceThreshold=0.7`, or either field alone; the same
 * two rules apply (d an integer > 0, 0 <= r <= 1) and anything else is dropped rather than clamped. `wait=` carries
 * the bounded anchor wait (an integer 0..60000, where 0 turns it off) and has no positional slot, for the reason
 * given on `parseTuning`.
 *
 * `provider=` selects the System-1 backend (`jev`, `laya-serve` or `none`; `laya` is accepted as the short spelling
 * the radio shows). It has no positional slot either: the first four tokens are the legacy `d r w xFirst` order an
 * older write already used, and a provider name landing in one of those would be silently dropped anyway.
 */
export function parseTuningArgs(input                    )         {
  if (typeof input !== 'string') return {};
  const out         = {};
  const assign = (key        , raw        )       => {
    const value = Number(raw);
    if (key === 'depth' || key === 'd') {
      if (Number.isInteger(value) && value > 0) out.depth = value;
      return;
    }
    if (key === 'window' || key === 'w') {
      if (Number.isInteger(value) && value >= 64) out.window = value;
      return;
    }
    // The bounded anchor wait. `Number('')` is 0, which is a *legal* value here - it turns the wait off - so an
    // empty token like `wait=` would silently disable the wait it was meant to set. It has to be rejected before the
    // coercion, and that is the only reason this branch is shaped differently from the two above.
    if (key === 'anchorWaitMs' || key === 'wait') {
      if (raw.trim() === '') return;
      const ms = Number(raw);
      if (Number.isInteger(ms) && ms >= 0 && ms <= 60_000) out.anchorWaitMs = ms;
      return;
    }
    if (key === 'relevanceThreshold' || key === 'r') {
      if (Number.isFinite(value) && value >= 0 && value <= 1) out.relevanceThreshold = value;
      return;
    }
    if (key === 'xFirst' || key === 'xf') {
      const flag = parseSwitch(raw);
      if (flag !== undefined) out.xFirst = flag;
      return;
    }
    // The Laya fields are strings, so they are read before the numeric coercion above could swallow them.
    if (key === 'layaPythonPath' || key === 'laya' || key === 'py') {
      const path = parsePath(raw);
      if (path !== undefined) out.layaPythonPath = path;
      return;
    }
    if (key === 'layaWeightsCacheDir' || key === 'weights') {
      const path = parsePath(raw);
      if (path !== undefined) out.layaWeightsCacheDir = path;
      return;
    }
    if (key === 'layaWeightsEnvVar' || key === 'weightsEnv') {
      const name = parseEnvName(raw);
      if (name !== undefined) out.layaWeightsEnvVar = name;
      return;
    }
    // The backend the radio selects. Not numeric, so it is read here and not by the coercion above; an unknown
    // name is dropped rather than clamped, on this file's usual rule.
    if (key === 'provider') {
      const provider = parseProvider(raw);
      if (provider !== undefined) out.provider = provider;
    }
  };
  const positional           = [];
  for (const token of tokenize(input)) {
    if (token === '') continue;
    // The value runs to the end of the token, not to the next space: `tokenize` has already made a quoted path
    // one token, and a `(\S+)` here would silently store `D:/Program` out of `D:/Program Files/...`.
    const match =
      /^(depth|d|relevanceThreshold|r|window|w|anchorWaitMs|wait|xFirst|xf|layaPythonPath|laya|py|layaWeightsCacheDir|weights|layaWeightsEnvVar|weightsEnv|provider)\s*=\s*(.+)$/.exec(
        token,
      );
    if (match && match[1] !== undefined && match[2] !== undefined) assign(match[1], match[2]);
    else positional.push(token);
  }
  if (positional[0] !== undefined) assign('depth', positional[0]);
  if (positional[1] !== undefined) assign('relevanceThreshold', positional[1]);
  if (positional[2] !== undefined) assign('window', positional[2]);
  if (positional[3] !== undefined) assign('xFirst', positional[3]);
  return out;
}