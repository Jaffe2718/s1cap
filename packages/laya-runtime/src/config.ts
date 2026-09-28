/**
 * Laya runtime config validation. Same fail-safe contract as `@s1cap/core` policy validation:
 * report the problem, keep the default, never break the session over a typo.
 */
import type { LayaConfig } from './types.ts';
import { defaultLayaConfig } from './types.ts';

export interface LayaIssue {
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface LayaValidation {
  ok: boolean;
  issues: LayaIssue[];
  errors: LayaIssue[];
  warnings: LayaIssue[];
  config: LayaConfig;
}

const BOOLEAN_KEYS = ['enabled', 'preferConsoleScript', 'autoStart'] as const;
const STRING_KEYS = [
  'pythonPath',
  'condaEnv',
  'condaPath',
  'serveCommand',
  'host',
  'healthPath',
  'model',
  'cwd',
] as const;
const NUMBER_KEYS: readonly { key: 'port' | 'startupTimeoutMs' | 'pollIntervalMs'; min: number; max: number }[] = [
  { key: 'port', min: 1, max: 65_535 },
  { key: 'startupTimeoutMs', min: 1_000, max: 3_600_000 },
  { key: 'pollIntervalMs', min: 50, max: 60_000 },
];
const STRING_ARRAY_KEYS = ['extraCandidates', 'serveArgs'] as const;
const KNOWN_KEYS: readonly string[] = [
  ...BOOLEAN_KEYS,
  ...STRING_KEYS,
  ...NUMBER_KEYS.map((r) => r.key),
  ...STRING_ARRAY_KEYS,
  'env',
];

export function validateLayaConfig(raw: unknown): LayaValidation {
  const config = defaultLayaConfig();
  const issues: LayaIssue[] = [];
  const target = config as unknown as Record<string, unknown>;

  const finish = (): LayaValidation => ({
    ok: !issues.some((i) => i.severity === 'error'),
    issues,
    errors: issues.filter((i) => i.severity === 'error'),
    warnings: issues.filter((i) => i.severity === 'warning'),
    config,
  });

  if (raw === undefined || raw === null) return finish();
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    issues.push({ path: 'laya', message: 'must be an object', severity: 'error' });
    return finish();
  }

  const source = raw as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (!KNOWN_KEYS.includes(key)) {
      issues.push({ path: `laya.${key}`, message: 'unknown key (ignored)', severity: 'warning' });
    }
  }

  for (const key of BOOLEAN_KEYS) {
    if (source[key] === undefined) continue;
    if (typeof source[key] !== 'boolean') {
      issues.push({ path: `laya.${key}`, message: `must be a boolean (got ${JSON.stringify(source[key])})`, severity: 'error' });
      continue;
    }
    target[key] = source[key];
  }

  for (const key of STRING_KEYS) {
    if (source[key] === undefined) continue;
    const value = source[key];
    if (typeof value !== 'string') {
      issues.push({ path: `laya.${key}`, message: `must be a string (got ${JSON.stringify(value)})`, severity: 'error' });
      continue;
    }
    if (key === 'host' && value.trim() === '') {
      issues.push({ path: 'laya.host', message: 'must not be empty', severity: 'error' });
      continue;
    }
    if (key === 'healthPath' && !value.startsWith('/')) {
      issues.push({ path: 'laya.healthPath', message: `must start with "/" (got ${JSON.stringify(value)})`, severity: 'error' });
      continue;
    }
    target[key] = value;
  }

  for (const rule of NUMBER_KEYS) {
    const value = source[rule.key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      issues.push({ path: `laya.${rule.key}`, message: `must be an integer (got ${JSON.stringify(value)})`, severity: 'error' });
      continue;
    }
    if (value < rule.min || value > rule.max) {
      issues.push({ path: `laya.${rule.key}`, message: `must be within ${rule.min}..${rule.max} (got ${value})`, severity: 'error' });
      continue;
    }
    target[rule.key] = value;
  }

  for (const key of STRING_ARRAY_KEYS) {
    const value = source[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
      issues.push({ path: `laya.${key}`, message: 'must be an array of strings', severity: 'error' });
      continue;
    }
    target[key] = value;
  }

  if (source.env !== undefined) {
    const env = source.env;
    if (typeof env !== 'object' || env === null || Array.isArray(env)) {
      issues.push({ path: 'laya.env', message: 'must be an object of strings', severity: 'error' });
    } else if (Object.values(env as Record<string, unknown>).some((v) => typeof v !== 'string')) {
      issues.push({ path: 'laya.env', message: 'every value must be a string (quote numbers: LAYA_THREADS: "8")', severity: 'error' });
    } else {
      target.env = env;
    }
  }

  return finish();
}
