/**
 * The cell preset: `bench/cells/<cell>.json` as a layer of the policy rather than a description of one.
 *
 * ## Why this module exists
 *
 * The presets have been documentation since they were written. `basePolicyFor` in `config.ts` resolves a cell by
 * calling `cellPolicy(cell)` — code — and never opens the file; `setup.mjs` copies the profile and writes `cell`,
 * the telemetry paths and the `s1`/`laya` recipe, and never reads the preset either. So the JSON and the build can
 * disagree without anything saying so, and they did: on 2026-10-05 `bench/cells/C2.json` was given
 * `recall.threshold: 0.6` and the round that followed ran **0.55**, because the value lived in a file nothing
 * loaded. The same shape appears one level up — `scripts/check-doc-pointers.mjs`'s `effectivePolicy()` merges the
 * preset over `cellPolicy(cell)` and calls the result "the policy a cell actually runs", so the doc checker was
 * verifying every documented value against a policy the runtime does not have.
 *
 * This module is the layer that closes that gap at the level where mistakes are cheap to catch: it turns a parsed
 * preset plus the profile's own config into **one raw config object**, so the single rule table in `config.ts`
 * validates both. Nothing here re-implements a bound or a type — if this file ever grows a range check, the two
 * surfaces have started to drift and the rule belongs in `NUMBER_RULES`.
 *
 * ## Precedence
 *
 * `defaultPolicy()` < cell preset < explicit config in the profile patch
 *
 * The middle step is the new one and the point of the objective: the JSON wins over the hardcoded cell, so a value
 * a researcher writes in `bench/cells/<cell>.json` reaches the session. The last step is unchanged and is the
 * documented rule (`config.ts`, `basePolicyFor`): a knob set in the patch still wins, so an experiment can deviate
 * from its cell on purpose and say so in the patch rather than in a second place.
 *
 * ## What it refuses to do silently
 *
 * - A preset whose `cell` field names a different cell is an **error**. The preset is looked up by the cell the
 *   profile asks for, so a mismatch means the two disagree about which arm this is, and a run that quietly used
 *   one of them would be the drift this module exists to stop.
 * - Every key the preset supplies is reported in `fromPreset`, and every key the profile patch overrides is
 *   reported in `overridden`. A value that reaches the policy from the preset and is then replaced by the patch
 *   is exactly the case where "which value ran" was unknowable before.
 */

/** The preset's own bookkeeping. Never policy, and never carried into the merged config. */
export const CELL_PRESET_META_KEY = '_meta';

// The one list of policy paths this build has. Imported rather than restated: a second copy is the drift this module
// exists to remove, and a path added to `NUMBER_RULES` must become preset-writable without a second edit.
import { KNOWN_PATHS } from './config.js';

                                  
                                                                                                      
                               
                                                                                     
                                
                                                                                  
                                
                                                                
                      
                                     
 

                                  
                                                               
               
                  
     
                                                                                                                 
                                                                                                                  
                                                                                                                    
                                                              
     
                    
 

function isPlainObject(value         )                                   {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deep merge for the preset layer only: objects merge, arrays and scalars replace. */
function mergeLayer(base                         , over                         )                          {
  const out                          = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const prior = out[key];
    out[key] = isPlainObject(prior) && isPlainObject(value) ? mergeLayer(prior, value) : value;
  }
  return out;
}

/** Every dotted path an object supplies, so two layers can be compared leaf by leaf. */
function pathsOf(value         , prefix = '')           {
  if (!isPlainObject(value)) return prefix ? [prefix] : [];
  const out           = [];
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(child)) out.push(...pathsOf(child, path));
    else out.push(path);
  }
  return out;
}

                                    
     
                                                                                                                
                                                                                                          
    
                                                                                                               
                                                                                                                    
                                                                          
     
                                    
 

/**
 * Fold a parsed cell preset into the profile's raw config.
 *
 * @param config the profile patch's `config:` object, verbatim (`{ cell: 'C2', ... }`), or undefined
 * @param preset the parsed contents of `bench/cells/<cell>.json`, verbatim — `_meta` included, since stripping it
 *   is this function's job and not the caller's
 */
export function mergeCellPreset(config         , preset         , options                    = {})                  {
  const issues                    = [];
  const cfg = isPlainObject(config) ? config : {};
  if (config !== undefined && !isPlainObject(config)) {
    issues.push({ path: '', message: 'the profile config is not an object, so no preset could be folded into it', severity: 'error' });
  }

  if (!isPlainObject(preset)) {
    // Absent is not an error — a profile that names no preset runs the cell and the defaults, which is the state
    // every round before this one was in. A preset that is present but not an object is a different thing and is
    // reported, because the caller believed it had one.
    if (preset !== undefined) {
      issues.push({ path: '', message: `the cell preset is ${JSON.stringify(preset)} rather than an object`, severity: 'error' });
    }
    return { raw: { ...cfg }, fromPreset: [], overridden: [], cell: cellOf(cfg, null), issues };
  }

  const supplied                          = {};
  for (const [key, value] of Object.entries(preset)) {
    if (key === CELL_PRESET_META_KEY) continue;
    supplied[key] = value;
  }

  const presetCell = typeof supplied['cell'] === 'string' ? (supplied['cell']          ) : null;
  const cfgCell = typeof cfg['cell'] === 'string' ? (cfg['cell']          ) : null;
  if (presetCell !== null && cfgCell !== null && presetCell !== cfgCell) {
    issues.push({
      path: 'cell',
      severity: 'error',
      message:
        `the preset says cell ${presetCell} but the profile asks for ${cfgCell} — the file and the profile disagree ` +
        'about which arm this is, and a run that picked one of them silently would be unreadable afterwards',
    });
  }

  const merged = mergeLayer(supplied, cfg);
  const fromPreset = pathsOf(supplied).sort();
  const extraTops = new Set(options.extraTopLevel ?? []);
  const known = new Set(KNOWN_PATHS);
  for (const path of fromPreset) {
    // `cell` names the file; it is the one key whose value is checked by identity above rather than by rule.
    if (path === 'cell') continue;
    if (known.has(path) || extraTops.has(path.split('.')[0]          )) continue;
    issues.push({
      path,
      severity: 'error',
      message:
        `the preset supplies \`${path}\`, which is not a policy path this build has — it would be dropped without ` +
        'changing anything, so a preset edited against a different build would run a policy nobody wrote',
    });
  }

  const cfgPaths = new Set(pathsOf(cfg));
  const overridden = fromPreset.filter((p) => p !== 'cell' && cfgPaths.has(p)).sort();

  return { raw: merged, fromPreset, overridden, cell: cellOf(cfg, supplied), issues };
}

function cellOf(cfg                         , supplied                                )                {
  const fromCfg = typeof cfg['cell'] === 'string' ? (cfg['cell']          ) : null;
  if (fromCfg !== null) return fromCfg;
  const fromPreset = supplied && typeof supplied['cell'] === 'string' ? (supplied['cell']          ) : null;
  return fromPreset;
}
