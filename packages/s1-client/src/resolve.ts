/**
 * Backend resolution: turn `s1` + `laya` config into exactly one usable System-1 endpoint.
 *
 * Rule enforced here (docs/AGENT_BRIEF.md §0.9): **one S1 backend at a time**. Enabling the local
 * Laya runtime while selecting a cloud provider (or the reverse) is a configuration error rather
 * than a silent priority decision, because a session that quietly switches governors makes its own
 * measurements meaningless.
 */
import type { S1ProviderName } from '@s1cap/core';
import { PROVIDERS } from './providers.ts';

export interface S1ConfigInput {
  provider: S1ProviderName;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}

/** The subset of the Laya runtime config that affects the endpoint. */
export interface LayaEndpointInput {
  enabled: boolean;
  host: string;
  port: number;
  model?: string;
  /**
   * The interpreter the user supplied for the local backend, e.g. `path/to/laya_py/env/python.exe`.
   *
   * Required when Laya is the chosen backend, and required to be *explicit*. Discovery can still report a
   * candidate — that is how the settings panel offers a value to paste — but a candidate is not a configuration:
   * two machines with the same profile would then pick different interpreters, and a run that cannot be
   * reproduced is not a measurement. The machine-specific half lives in the profile, never in this repository.
   */
  pythonPath?: string;
}

export interface ResolvedS1Backend {
  provider: S1ProviderName;
  mode: 'cloud' | 'local' | 'none';
  baseUrl?: string;
  model?: string;
  /** present only when the provider needs one and it was supplied */
  apiKey?: string;
}

export type EnvLike = Record<string, string | undefined>;

/** Redact a key for logs and status output: never print a usable credential. */
export function redactKey(key: string | undefined): string {
  if (!key) return '(none)';
  if (key.length <= 8) return `**** (${key.length} chars)`;
  return `${key.slice(0, 4)}…${key.slice(-2)} (${key.length} chars)`;
}

/** Configuration conflicts that must be fixed by the user, not silently resolved. */
export function singleBackendIssues(s1: S1ConfigInput, laya?: LayaEndpointInput): string[] {
  const issues: string[] = [];
  if (!laya) return issues;

  // One backend, one choice. Jev and Laya are the two options, and a profile that names both is a configuration
  // error rather than a preference: the two would answer the same questions from different models, and the
  // ablation cells are defined by which one is running.
  if (laya.enabled && s1.provider === 'none') {
    issues.push('laya.enabled is true but s1.provider is "none" — enable one backend or disable Laya');
  } else if (laya.enabled && !PROVIDERS[s1.provider as Exclude<S1ProviderName, 'none'>]?.local) {
    // `else if`, because "enabled with no provider" is already reported above: saying it twice, in two
    // different words, is one conflict told as two and makes the count in the log mean nothing.
    issues.push(
      `only one S1 backend may be active: laya.enabled=true conflicts with s1.provider="${s1.provider}" (set provider to "laya-serve", or disable Laya)`,
    );
  }
  if (!laya.enabled && s1.provider === 'laya-serve') {
    issues.push('s1.provider is "laya-serve" but laya.enabled is false — the local server would never start');
  }
  // Choosing Laya means committing to an interpreter the user typed, not one a probe happened to find.
  //
  // This is a conflict rather than a warning on purpose: a conflict drops the session to provider=none, which
  // makes System-1 calls go through the tier-0 path and says so in `/s1` and the log. That is the right failure —
  // the harness keeps working, and the run cannot quietly be something other than what was configured. The
  // path is the interpreter that owns the environment (for example `path/to/laya_py/env/python.exe`), from which
  // the console script is derived, so a wrong one is not a slow start but a different program or none at all.
  const layaActive = laya.enabled || s1.provider === 'laya-serve';
  if (layaActive && (laya.pythonPath ?? '') === '') {
    issues.push(
      'Laya is selected but laya.pythonPath is empty — fill in the interpreter path in the settings panel (the ' +
        'python.exe of the laya_py environment, e.g. path/to/laya_py/env/python.exe)',
    );
  }
  return issues;
}

/**
 * Resolve the single active backend. Precedence for the key: explicit config, then the
 * provider's environment variables (never the other way round, so a profile patch can pin a
 * dedicated key).
 */
export function resolveS1Backend(
  s1: S1ConfigInput,
  laya?: LayaEndpointInput,
  env: EnvLike = process.env as EnvLike,
): ResolvedS1Backend {
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
export function describeS1Backend(resolved: ResolvedS1Backend): string {
  if (resolved.mode === 'none') return 'provider=none (S1CAP observes only, no System-1 calls)';
  const key = resolved.mode === 'cloud' ? `, key=${redactKey(resolved.apiKey)}` : '';
  return `provider=${resolved.provider} (${resolved.mode}), baseUrl=${String(resolved.baseUrl)}, model=${String(resolved.model)}${key}`;
}
