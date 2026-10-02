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

                                           

                        
               
                  
                     
 

                                   
              
                  
                  
                    
                                                   
                         
 

const CELLS                  = ['C0', 'C1', 'C2'];

                      
               
              
              
                    
 

/** Numeric bounds: thresholds, budgets, caps and timings. */
export const NUMBER_RULES                        = [
  // NOT ENFORCED. The type calls this "hard deadline for the synchronous per-call assembly hook; on expiry the
  // call passes through unmodified", and nothing enforces a deadline: the value is read once, to print on `/s1`
  // and in the status route's `effective` block. The documented entry comment beside it says 250 ms, and the
  // bounded wait that actually runs is `recall.anchorWaitMs` - 10 000 ms by default, forty times larger - so the
  // two numbers in one policy object contradict each other. See `UNENFORCED_KNOBS` below, which is the one place
  // this is stated in a form a test can check.
  { path: 'assemblyDeadlineMs', min: 1, max: 10_000, integer: true },
  // NOT ENFORCED as a lag in turns. Read as "how far the graph may lag the session, in turns", and the queue
  // compares it against a count of *pending events*, which nothing acts on. See `UNENFORCED_KNOBS`.
  { path: 'rgMaintenance.maxLagTurns', min: 0, max: 100, integer: true },
  // NOT ENFORCED. `alignToCacheBlocks(tokens, blockTokens)` exists and is called by nothing; the assembler
  // records cache-stability numbers and never aligns to a block boundary. See `UNENFORCED_KNOBS`.
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
  { path: 's1.questionsPerCall', min: 1, max: 64, integer: true },
  // attempts for one refused System-1 call; 1 is the single attempt this used to be, 5 is the ceiling because a
  // refusal costs a wait each time and the harness has to stay responsive
  { path: 's1.retryAttempts', min: 1, max: 5, integer: true },
  // Requests this cell may have in flight at once. 64 is a ceiling rather than a recommendation - the local Laya
  // admits 16 and refuses the rest - and it is here so that a mis-set value is an error rather than a cell that
  // quietly recreates the 64.4%-refused run this field exists to prevent. See `AssemblyPolicy.s1.admissionLimit`.
  { path: 's1.admissionLimit', min: 1, max: 64, integer: true },
];

export const ENUM_RULES                                                         = [
  { path: 'cell', values: CELLS },
  { path: 'tas.updatePolicy', values: ['perTask', 'perTurn'] },
  // The implemented tier-1 values, and only those. `embed` is the designed third mode and this build does not have
  // it: no embedder exists, `source: 'embed'` is never assigned to an edge, `recall.embedModel` is read by nothing,
  // and the only behavioural read of the field anywhere is `assembler.ts`'s `!== 'off'` - so a cell that declared
  // `embed` ran the `noul` batch and was described by a mechanism it did not use. The failure mode closed here is
  // not "unknown string" but **silently treated as on**, so `embed` is rejected with its own message
  // (`LEGACY_TIER1`, applied in the enum loop below) rather than accepted as an alias for `s1`: an alias is still
  // a recipe naming something the build lacks. As of 2026-10-02 the policy default, the type union and C2's preset
  // all say `s1` - the mode that runs - and `'off'` keeps its meaning (no recall *selection*; association-graph
  // upkeep is not gated on it).
  { path: 'recall.tier1', values: ['s1', 'off'] },
  // NOT ENFORCED. `decideReselect()` exists for this value and is called by nothing in `packages/*/src` or
  // `scripts/`; the assembler records `cacheStability` numbers and never re-selects on a policy. See
  // `UNENFORCED_KNOBS`.
  { path: 'cache.reselectPolicy', values: ['perTask', 'perTurn', 'threshold'] },
  { path: 's1.provider', values: ['jev', 'laya-serve', 'edgejev', 'kev', 'none'] },
];

/**
 * Values a config may still carry that named something this build does not have (2026-10-02).
 *
 * The case this table exists for is `recall.tier1: 'embed'`. It was an accepted value and C2's own preset carried
 * it, and the only behavioural read of the field in the whole implementation was
 * `policy.recall.tier1 !== 'off'` (`packages/core/src/assembler.ts`) - so the cell ran the `noul` batch and was
 * described by a mode nothing implements. It is an **error** now, with its own sentence rather than the generic
 * enum message: the defect was never "unknown string", it was being treated as on, and an explicit retirement
 * survives someone adding `embed` back to `ENUM_RULES` by reflex.
 */
export const LEGACY_TIER1                                                              = [
  {
    path: 'recall.tier1',
    value: 'embed',
    message:
      'tier-1 "embed" is not implemented: no embedder or ANN index exists, `source: "embed"` is never written to ' +
      'an edge, and this field was read only as `!== "off"`. The implemented values are "s1" (one batched `noul` ' +
      'call - what every selecting cell has run) and "off" (no recall selection at all). The cell\'s own value is ' +
      'kept; see packages/core/src/types.ts (`recall.tier1`) for the measurement',
  },
];

/**
 * The knobs this build **accepts, composes, records and does not enforce** - as a registry, because a comment is
 * not a thing a test can check and a knob that composes and does nothing is the defect this exists to remove.
 *
 * The list is closed on purpose. Every entry says what it would take to enforce the knob; anything not in the
 * list is a knob with a live reader, and `core/test/config.test.ts` fails if the two sets drift apart (the test
 * reads the declarations and asserts the registry matches exactly). `cache.reselectPolicy` and
 * `cache.blockTokens` share one entry because they are one mechanism - the assembler prices a re-selection with
 * `cache-policy.ts` and never makes one, so the policy that would decide it and the block size it would align to
 * are unenforced together.
 *
 * Precedent, and why this is a registry rather than five more comments: the plan gate was removed for exactly
 * this shape - a field the full-configuration cell carried and no code read - and its removal was swept for in
 * the presets, the schema and the report. Nothing swept for the rest, so three of these survived the pass that
 * deleted the gate, and the fourth, `recall.tier1: 'embed'`, sat in the cell whose whole purpose is to be the full
 * configuration until 2026-10-02, when it was answered by naming what runs instead: the value is rejected, and the
 * mode's one remaining trace in the policy - `recall.embedModel`, which nothing loads a model for - is the entry
 * below. The registry is what makes the sweep mechanical rather than another reading.
 */
                                 
                                                                                               
                  
                                                          
                 
                                                           
                    
 

export const UNENFORCED_KNOBS                                           = {
  assemblyDeadlineMs: {
    enforced: false,
    claims: 'a hard deadline for the synchronous per-call assembly hook, on expiry of which the call passes through unmodified',
    wouldNeed:
      'the hook to race the assembly against a timer and return the untouched decision on expiry; read today only to be ' +
      'printed on `/s1`. The bound that actually runs is `recall.anchorWaitMs`, which is 10 000 ms by default - forty ' +
      'times this number, in the same policy object',
  },
  'cache.reselectPolicy': {
    enforced: false,
    claims: 'whether a selected context is re-selected per task, per turn, or when the break-even test says it pays',
    wouldNeed:
      'a caller for `cache-policy.ts#decideReselect`, which nothing in `packages/*/src` or `scripts/` calls; the assembler ' +
      'records `cacheStability` and never re-selects on a policy',
  },
  'cache.blockTokens': {
    enforced: false,
    claims: 'the prefix-cache block size a selection is aligned to',
    wouldNeed:
      'a caller for `cache-policy.ts#alignToCacheBlocks`; the same missing mechanism as `cache.reselectPolicy` above',
  },
  'rgMaintenance.maxLagTurns': {
    enforced: false,
    claims: 'how far the association graph may lag the session, in turns',
    wouldNeed:
      'a lag measured in turns. `upkeep-queue.ts` compares it against a count of *pending session events* and nothing acts ' +
      'on the comparison. The bound that does bound scoring concurrency is `s1.admissionLimit`',
  },
  'recall.embedModel': {
    enforced: false,
    claims: "the tier-1 embedding model's own default, used by the `embed` mode",
    wouldNeed:
      'an embedder. Tier-1 `embed` is not implemented and is not an accepted value (`LEGACY_TIER1` above rejects ' +
      'it), so nothing loads a model here; a non-empty value is warned about at the end of `validatePolicy`, and a ' +
      'profile that sets one is naming a mechanism this build does not have',
  },
};

/**
 * Boolean policy paths a profile patch may set.
 *
 * `deliver` is here for a measured reason. It was added to the policy in the N6 commit and *not* here, and a
 * live run then reported `policy.deliver is off` on all twelve steps of a session whose cell was C2 — with 8 of
 * 12 assemblies carrying a non-empty recalled block and 12 of 12 carrying a state proxy. The content was there and
 * the switch was off, because a knob missing from this list is not read from the cell preset, cannot be set
 * from a profile, and is reported as an unknown path. A flag that exists in the type and in the cell, and in
 * neither of the two places that decide it, is worse than a flag that does not exist: it looks configured.
 */
export const BOOLEAN_PATHS                    = ['tas.on', 'xFirst', 'deliver'];

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
 * The starting policy for a raw config: the cell preset when the config names a real cell, else C2.
 *
 * This was `defaultPolicy()` unconditionally, and that is a measurement bug, not a style choice. `defaultPolicy`
 * *is* C2, and `cellPolicy()` was called from tests only — so a profile patched to `cell: C0` ran C2's TAS,
 * tier1, plan gate and x-first layout while `/s1` reported the cell as C0. Nothing in the log said so, because
 * the record carries the cell name, not the policy that ran. A live run of this exact mistake is in N6: twelve
 * steps of a C2 session all reported `policy.deliver is off` because `deliver` had been added to the policy and
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
    // function looked at any override, so a bad value costs an error and falls back to C2 rather than a
    // half-applied cell.
    if (typeof value !== 'string' || !rule.values.includes(value)) {
      // A value this build used to advertise and never implemented gets its own sentence instead of the generic
      // list: the reader needs to know the *mode* is missing, not that a string is not in an array.
      const legacy = LEGACY_TIER1.find((r) => r.path === rule.path && r.value === value);
      issues.push({
        path: rule.path,
        message: legacy ? legacy.message : `must be one of ${rule.values.join(' | ')} (got ${JSON.stringify(value)})`,
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

  // The pairing a measured round found to be the worst of the four arms it ran, warned about and never rejected.
  //
  // The pairing is `tas.on: false` with recall selection on (`recall.tier1: 's1'`, the only selecting value): recall
  // selection running without the state proxy that keeps the head of the prompt byte-stable. Round `20261001-1300`
  // measured that combination per step at
  // 3 625 uncached input tokens against the baseline's 2 595, 2 574 output tokens against 1 523 and a 79.2% cache
  // hit rate against 86.7%; its counterpart - the stabiliser on with recall off (cell C1) - measured 1 783 uncached
  // input tokens per step, the fewest in the table, and 1 493 output tokens against the baseline's 1 523. No cell
  // names this pairing any more - it was the fourth arm, dropped - so it is reachable only by setting the two knobs
  // in a profile, which is where a warning earns its place: a combination no cell selects on purpose must not be
  // selected by accident. It stays a warning rather than an error: `ok` stays true, no value is changed, and a
  // session never fails over a combination of two legal settings.
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
        `tokens against 1 523. Set tas.on true, or recall.tier1 "off", unless the pairing is what is under test`,
      severity: 'warning',
    });
  }

  // `recall.tier1: 'embed'` used to be accepted here and resolved as an alias for the System-1 tier. It is an
  // error now (`LEGACY_TIER1`, applied in the enum loop above), because the defect was not the missing mechanism
  // on its own - it was that a cell could *declare* the embed mode and be read as "not off". The value that runs
  // is the one the recipe states: `s1` or `off`.

  // What is left of that mode in the policy is its model name, and nothing reads it (`UNENFORCED_KNOBS`). A
  // non-empty value is reported - the "composes, appears in every dump, never read" pattern this repository keeps
  // finding - while the empty string, which `cordis.patch.yml` ships and every `STRING_PATHS` entry treats as
  // "not set", stays silent. A warning rather than an error for the same reason `planGate`'s leftover key is one:
  // a key with no reader costs a session nothing, and the session must not fail over a config it ignores.
  const embedModel = getPath(source, 'recall.embedModel');
  if (typeof embedModel === 'string' && embedModel !== '') {
    issues.push({
      path: 'recall.embedModel',
      message:
        `no reader: tier-1 "embed" is not implemented (see recall.tier1), so nothing loads this model ` +
        `(${JSON.stringify(embedModel)}). The key is accepted and ignored; remove it from the profile`,
      severity: 'warning',
    });
  }

  return finish();
}
