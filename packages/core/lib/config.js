/**
 * Policy validation and normalisation (docs/AGENT_BRIEF.md §4).
 *
 * Zero-dependency so `node --test` runs it without an install step; the DSH production path
 * mirrors exactly these rules in a schemastery schema (M1).
 *
 * Fail-safe by design: an invalid value is reported and the default is kept, because a live
 * harness must never break a session over a typo in config.
 */
                                                       
import { cellPolicy, defaultPolicy } from './types.js';

                                           

                        
               
                  
                     
 

                                   
              
                  
                  
                    
                                                   
                         
 

const CELLS                  = ['C1', 'C2', 'C3', 'C4'];

                      
               
              
              
                    
 

/** Numeric bounds: thresholds, budgets, caps and timings. */
export const NUMBER_RULES                        = [
  { path: 'assemblyDeadlineMs', min: 1, max: 10_000, integer: true },
  { path: 'rgMaintenance.maxLagTurns', min: 0, max: 100, integer: true },
  { path: 'cache.blockTokens', min: 1, max: 4096, integer: true },
  { path: 'tas.tMaxChars', min: 0, max: 200_000, integer: true },
  { path: 'recall.threshold', min: 0, max: 1 },
  { path: 'recall.window', min: 64, max: 1048576, integer: true },
  // the bounded wait for the anchor's own row before assembly; 0 disables it
  { path: 'recall.anchorWaitMs', min: 0, max: 60_000, integer: true },
  { path: 'recall.depth', min: 1, max: 6, integer: true },
  { path: 'recall.fanout', min: 1, max: 64, integer: true },
  { path: 'recall.budgetRatio', min: 0.05, max: 0.95 },
  { path: 'recall.minRecalledShare', min: 0, max: 1 },
  // the count floor under a recall selection (assembler.ts): fewer segments than this and the block falls back to
  // the recency window. 1 is the least that is still a selection, and it is the floor rather than 0 because the
  // type documents this rule as the guard against a *broken* selector - a value that switches the guard off is not
  // a setting this harness supports. 8 is the ceiling for the reason the plan-gate caps stop there too: the guard
  // exists to catch a selector that returned nothing, so a bound large enough to act as a selection quota would
  // make the fallback the normal path and discard confident selections, which is what `minRecalledShare` did at
  // 0.25 - it fired on 9 of 9 steps of a live run. Eight segments is already far past "nothing was selected".
  { path: 'recall.minRecalledSegments', min: 1, max: 8, integer: true },
  { path: 'tail.k', min: 0, max: 20, integer: true },
  { path: 'planGate.maxPlans', min: 1, max: 8, integer: true },
  { path: 'planGate.attemptCap', min: 1, max: 8, integer: true },
  { path: 'planGate.abstainConfidence', min: 0, max: 1 },
  { path: 's1.questionsPerCall', min: 1, max: 64, integer: true },
  // attempts for one refused System-1 call; 1 is the single attempt this used to be, 5 is the ceiling because a
  // refusal costs a wait each time and the harness has to stay responsive
  { path: 's1.retryAttempts', min: 1, max: 5, integer: true },
];

export const ENUM_RULES                                                         = [
  { path: 'cell', values: CELLS },
  { path: 'tas.updatePolicy', values: ['perTask', 'perTurn'] },
  { path: 'recall.tier1', values: ['embed', 's1', 'off'] },
  { path: 'cache.reselectPolicy', values: ['perTask', 'perTurn', 'threshold'] },
  { path: 's1.provider', values: ['jev', 'laya-serve', 'edgejev', 'kev', 'none'] },
];

/**
 * Boolean policy paths a profile patch may set.
 *
 * `deliver` is here for a measured reason. It was added to the policy in the N6 commit and *not* here, and a
 * live run then reported `policy.deliver is off` on all twelve steps of a session whose cell was C4 — with 8 of
 * 12 assemblies carrying a non-empty recalled block and 12 of 12 carrying a state proxy. The content was there and
 * the switch was off, because a knob missing from this list is not read from the cell preset, cannot be set
 * from a profile, and is reported as an unknown path. A flag that exists in the type and in the cell, and in
 * neither of the two places that decide it, is worse than a flag that does not exist: it looks configured.
 */
export const BOOLEAN_PATHS                    = ['tas.on', 'planGate.on', 'xFirst', 'deliver'];

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
/**
 * The starting policy for a raw config: the cell preset when the config names a real cell, else C4.
 *
 * This was `defaultPolicy()` unconditionally, and that is a measurement bug, not a style choice. `defaultPolicy`
 * *is* C4, and `cellPolicy()` was called from tests only — so a profile patched to `cell: C1` ran C4's TAS,
 * tier1, plan gate and x-first layout while `/s1` reported the cell as C1. Nothing in the log said so, because
 * the record carries the cell name, not the policy that ran. A live run of this exact mistake is in N6: twelve
 * steps of a C4 session all reported `policy.deliver is off` because `deliver` had been added to the policy and
 * to `cellPolicy`, but the runtime never consulted the cell.
 *
 * Precedence, unchanged and already the documented rule: cell preset < explicit config in the profile patch.
 * A knob set in the patch still wins, so an experiment can deviate from its cell on purpose and say so in the
 * patch rather than in a second place.
 */
function basePolicyFor(raw         )                 {
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const cell = (raw                           )['cell'];
    if (typeof cell === 'string' && (CELLS                     ).includes(cell)) {
      return cellPolicy(cell        );
    }
  }
  return defaultPolicy();
}

export function validatePolicy(raw         , extraAllowedKeys                    = [])                   {
  const policy = basePolicyFor(raw);
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
    // The value must be a real cell; the preset itself was already applied by basePolicyFor() before this
    // function looked at any override, so a bad value costs an error and falls back to C4 rather than a
    // half-applied cell.
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

  // The pairing a measured round found to be the worst of the four, warned about and never rejected.
  //
  // C3 is `tas.on: false` with `recall.tier1: 'embed'`: recall selection running without the state proxy that
  // keeps the head of the prompt byte-stable. Round `20261001-1300` measured that cell per step at 3 625 uncached
  // input tokens against the baseline's 2 595, 2 574 output tokens against 1 523 and a 79.2% cache hit rate against
  // 86.7%; its counterpart - the stabiliser on with recall off (C2) - measured 1 783 uncached input tokens per
  // step, the fewest in the table, and 1 493 output tokens against the baseline's 1 523. So the pairing is one a
  // cell may select on purpose and must not select by accident, and that is a warning rather than an error: `ok`
  // stays true, no value is changed, and a session never fails over a combination of two legal settings.
  //
  // Stated as token counts per step, never as a share of a priced total: the three token types carry three prices
  // and the prices differ per model and per provider, so a weighted share of a bill describes a price list rather
  // than the system. The pairs are also per step on purpose - the cells ran different numbers of steps, so their
  // absolute totals rank differently and are not comparable.
  if (policy.tas.on === false && policy.recall.tier1 !== 'off') {
    issues.push({
      path: 'recall.tier1',
      message:
        `recall selection is on ("${policy.recall.tier1}") while tas.on is off, and that pairing measured worse ` +
        `than the baseline in round 20261001-1300, per step: 79.2% cache hit against 86.7%, 3 625 uncached input ` +
        `tokens against 2 595 and 2 574 output tokens against 1 523. With the stabiliser on and recall off the ` +
        `same run measured 1 783 uncached input tokens per step against the baseline's 2 595 and 1 493 output ` +
        `tokens against 1 523. Set tas.on true, or recall.tier1 "off", unless this cell is the pairing under test`,
      severity: 'warning',
    });
  }

  return finish();
}
