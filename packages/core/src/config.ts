/**
 * Policy validation and normalisation (docs/AGENT_BRIEF.md §4).
 *
 * Zero-dependency so `node --test` runs it without an install step; the DSH production path
 * mirrors exactly these rules in a schemastery schema (M1).
 *
 * Fail-safe by design: an invalid value is reported and the default is kept, because a live
 * harness must never break a session over a typo in config.
 */
import type { AssemblyPolicy, Cell } from './types.ts';
import { cellPolicy, defaultPolicy } from './types.ts';

export type Severity = 'error' | 'warning';

export interface Issue {
  path: string;
  message: string;
  severity: Severity;
}

export interface ValidationResult {
  ok: boolean;
  issues: Issue[];
  errors: Issue[];
  warnings: Issue[];
  /** defaults with every valid override applied */
  policy: AssemblyPolicy;
}

const CELLS: readonly Cell[] = ['C1', 'C2', 'C3', 'C4'];

interface NumberRule {
  path: string;
  min: number;
  max: number;
  integer?: boolean;
}

/** Numeric bounds: thresholds, budgets, caps and timings. */
export const NUMBER_RULES: readonly NumberRule[] = [
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
  { path: 'tail.k', min: 0, max: 20, integer: true },
  { path: 'planGate.maxPlans', min: 1, max: 8, integer: true },
  { path: 'planGate.attemptCap', min: 1, max: 8, integer: true },
  { path: 'planGate.abstainConfidence', min: 0, max: 1 },
  { path: 's1.questionsPerCall', min: 1, max: 64, integer: true },
];

export const ENUM_RULES: readonly { path: string; values: readonly string[] }[] = [
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
export const BOOLEAN_PATHS: readonly string[] = ['tas.on', 'planGate.on', 'xFirst', 'deliver'];

/**
 * Fixed by design, not configuration: the harness owns termination, and association-graph
 * upkeep is asynchronous (docs/ARCHITECTURE.md §6). A different value is an error, not a toggle.
 */
export const LITERAL_RULES: readonly { path: string; value: string }[] = [
  { path: 'termination', value: 'model-owned' },
  { path: 'rgMaintenance.mode', value: 'async' },
];

/** Optional string fields on the policy (empty string means "not set"). */
export const STRING_PATHS: readonly string[] = [
  's1.baseUrl',
  's1.model',
  's1.apiKey',
  'recall.embedModel',
];

/** Everything a profile patch may set (used to warn about typos). */
export const KNOWN_PATHS: readonly string[] = [
  ...NUMBER_RULES.map((r) => r.path),
  ...ENUM_RULES.map((r) => r.path),
  ...BOOLEAN_PATHS,
  ...LITERAL_RULES.map((r) => r.path),
  ...STRING_PATHS,
];

const KNOWN_TOP_LEVEL: readonly string[] = [
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

function getPath(root: unknown, path: string): unknown {
  let cursor: unknown = root;
  for (const part of path.split('.')) {
    if (typeof cursor !== 'object' || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cursor: Record<string, unknown> = target;
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part];
    if (typeof next !== 'object' || next === null) {
      cursor[part] = {};
    }
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1] as string] = value;
}

function present(root: unknown, path: string): boolean {
  return getPath(root, path) !== undefined;
}

function looksLikeUrl(value: string): boolean {
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
function basePolicyFor(raw: unknown): AssemblyPolicy {
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const cell = (raw as Record<string, unknown>)['cell'];
    if (typeof cell === 'string' && (CELLS as readonly string[]).includes(cell)) {
      return cellPolicy(cell as Cell);
    }
  }
  return defaultPolicy();
}

export function validatePolicy(raw: unknown, extraAllowedKeys: readonly string[] = []): ValidationResult {
  const policy = basePolicyFor(raw);
  const issues: Issue[] = [];
  const target = policy as unknown as Record<string, unknown>;

  const finish = (): ValidationResult => {
    const errors = issues.filter((i) => i.severity === 'error');
    const warnings = issues.filter((i) => i.severity === 'warning');
    return { ok: errors.length === 0, issues, errors, warnings, policy };
  };

  if (raw === undefined || raw === null) return finish();
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    issues.push({ path: '', message: 'config must be an object', severity: 'error' });
    return finish();
  }

  const source = raw as Record<string, unknown>;
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

  return finish();
}
