/**
 * Policy validation and normalisation (docs/AGENT_BRIEF.md §4).
 *
 * Zero-dependency so `node --test` runs it without an install step; the DSH production path
 * mirrors exactly these rules in a schemastery schema (M1).
 *
 * Fail-safe by design: an invalid value is reported and the default is kept, because a live
 * harness must never break a session over a typo in config.
 */
                                                       
import { defaultPolicy } from './types.js';

                                           

                        
               
                  
                     
 

                                   
              
                  
                  
                    
                                                   
                         
 

const CELLS                  = ['C1', 'C2', 'C3', 'C4'];

                      
               
              
              
                    
 

/** Numeric bounds: thresholds, budgets, caps and timings. */
export const NUMBER_RULES                        = [
  { path: 'assemblyDeadlineMs', min: 1, max: 10_000, integer: true },
  { path: 'rgMaintenance.maxLagTurns', min: 0, max: 100, integer: true },
  { path: 'cache.blockTokens', min: 1, max: 4096, integer: true },
  { path: 'tas.tMaxChars', min: 0, max: 200_000, integer: true },
  { path: 'recall.releTao', min: 0, max: 1 },
  { path: 'recall.window', min: 1, max: 1048576, integer: true },
  { path: 'recall.depth', min: 1, max: 6, integer: true },
  { path: 'recall.fanout', min: 1, max: 64, integer: true },
  { path: 'recall.budgetRatio', min: 0.05, max: 0.95 },
  { path: 'recall.minRecalledShare', min: 0, max: 1 },
  { path: 'tail.k', min: 0, max: 20, integer: true },
  { path: 'planGate.maxPlans', min: 1, max: 8, integer: true },
  { path: 'planGate.attemptCap', min: 1, max: 8, integer: true },
  { path: 'planGate.abstainConfidence', min: 0, max: 1 },
  { path: 's1.timeoutMs', min: 50, max: 60_000, integer: true },
  { path: 's1.questionsPerCall', min: 1, max: 64, integer: true },
];

export const ENUM_RULES                                                         = [
  { path: 'cell', values: CELLS },
  { path: 'tas.updatePolicy', values: ['perTask', 'perTurn'] },
  { path: 'recall.tier1', values: ['embed', 's1', 'off'] },
  { path: 'cache.reselectPolicy', values: ['perTask', 'perTurn', 'threshold'] },
  { path: 's1.provider', values: ['jev', 'laya-serve', 'edgejev', 'kev', 'none'] },
];

export const BOOLEAN_PATHS                    = ['tas.on', 'planGate.on'];

/**
 * Fixed by design, not configuration: the harness owns termination, and association-graph
 * upkeep is asynchronous (docs/ARCHITECTURE.md §6). A different value is an error, not a toggle.
 */
export const LITERAL_RULES                                             = [
  { path: 'termination', value: 'model-owned' },
  { path: 'rgMaintenance.mode', value: 'async' },
];

/** Optional string fields on the policy (empty string means "not set"). */
export const STRING_PATHS                    = [
  's1.baseUrl',
  's1.model',
  's1.apiKey',
  'recall.embedModel',
];

/** Everything a profile patch may set (used to warn about typos). */
export const KNOWN_PATHS                    = [
  ...NUMBER_RULES.map((r) => r.path),
  ...ENUM_RULES.map((r) => r.path),
  ...BOOLEAN_PATHS,
  ...LITERAL_RULES.map((r) => r.path),
  ...STRING_PATHS,
];

const KNOWN_TOP_LEVEL                    = [
  'cell',
  'termination',
  'assemblyDeadlineMs',
  'rgMaintenance',
  'cache',
  'tas',
  'recall',
  'tail',
  'planGate',
  's1',
  'telemetry',
];

function getPath(root         , path        )          {
  let cursor          = root;
  for (const part of path.split('.')) {
    if (typeof cursor !== 'object' || cursor === null) return undefined;
    cursor = (cursor                           )[part];
  }
  return cursor;
}

function setPath(target                         , path        , value         )       {
  const parts = path.split('.');
  let cursor                          = target;
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part];
    if (typeof next !== 'object' || next === null) {
      cursor[part] = {};
    }
    cursor = cursor[part]                           ;
  }
  cursor[parts[parts.length - 1]          ] = value;
}

function present(root         , path        )          {
  return getPath(root, path) !== undefined;
}

function looksLikeUrl(value        )          {
  return /^https?:\/\/[^\s]+$/i.test(value);
}

/**
 * Validate a raw config object (typically the `config:` block of the plugin's profile patch)
 * and return defaults plus every accepted override.
 *
 * @param extraAllowedKeys plugin-level keys that are not policy fields (e.g. `laya`)
 */
export function validatePolicy(raw         , extraAllowedKeys                    = [])                   {
  const policy = defaultPolicy();
  const issues          = [];
  const target = policy                                      ;

  const finish = ()                   => {
    const errors = issues.filter((i) => i.severity === 'error');
    const warnings = issues.filter((i) => i.severity === 'warning');
    return { ok: errors.length === 0, issues, errors, warnings, policy };
  };

  if (raw === undefined || raw === null) return finish();
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    issues.push({ path: '', message: 'config must be an object', severity: 'error' });
    return finish();
  }

  const source = raw                           ;
  const allowedTop = [...KNOWN_TOP_LEVEL, ...extraAllowedKeys];
  for (const key of Object.keys(source)) {
    if (!allowedTop.includes(key)) {
      issues.push({ path: key, message: `unknown config key (ignored)`, severity: 'warning' });
    }
  }

  for (const rule of LITERAL_RULES) {
    if (!present(source, rule.path)) continue;
    const value = getPath(source, rule.path);
    if (value !== rule.value) {
      issues.push({
        path: rule.path,
        message: `must be "${rule.value}" — this is fixed by design, not configurable (got ${JSON.stringify(value)})`,
        severity: 'error',
      });
      continue;
    }
    setPath(target, rule.path, value);
  }

  for (const rule of ENUM_RULES) {
    if (!present(source, rule.path)) continue;
    const value = getPath(source, rule.path);
    // cell C1-C3 is also shortened by cellPolicy() below, but the value must be a real cell
    if (typeof value !== 'string' || !rule.values.includes(value)) {
      issues.push({
        path: rule.path,
        message: `must be one of ${rule.values.join(' | ')} (got ${JSON.stringify(value)})`,
        severity: 'error',
      });
      continue;
    }
    setPath(target, rule.path, value);
  }

  for (const path of BOOLEAN_PATHS) {
    if (!present(source, path)) continue;
    const value = getPath(source, path);
    if (typeof value !== 'boolean') {
      issues.push({ path, message: `must be a boolean (got ${JSON.stringify(value)})`, severity: 'error' });
      continue;
    }
    setPath(target, path, value);
  }

  for (const rule of NUMBER_RULES) {
    if (!present(source, rule.path)) continue;
    const value = getPath(source, rule.path);
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      issues.push({ path: rule.path, message: `must be a number (got ${JSON.stringify(value)})`, severity: 'error' });
      continue;
    }
    if (rule.integer && !Number.isInteger(value)) {
      issues.push({ path: rule.path, message: `must be an integer (got ${value})`, severity: 'error' });
      continue;
    }
    if (value < rule.min || value > rule.max) {
      issues.push({
        path: rule.path,
        message: `must be within ${rule.min}..${rule.max} (got ${value})`,
        severity: 'error',
      });
      continue;
    }
    setPath(target, rule.path, value);
  }

  for (const path of STRING_PATHS) {
    if (!present(source, path)) continue;
    const value = getPath(source, path);
    if (typeof value !== 'string') {
      issues.push({ path, message: `must be a string (got ${JSON.stringify(value)})`, severity: 'error' });
      continue;
    }
    if (path === 's1.baseUrl' && value !== '' && !looksLikeUrl(value)) {
      issues.push({ path, message: `must be an http(s) URL or "" (got ${JSON.stringify(value)})`, severity: 'error' });
      continue;
    }
    setPath(target, path, value);
  }

  return finish();
}
