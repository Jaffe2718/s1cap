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

  if (laya.enabled && s1.provider === 'none') {
    issues.push('laya.enabled is true but s1.provider is "none" — enable one backend or disable Laya');
  }
  if (laya.enabled && !PROVIDERS[s1.provider as Exclude<S1ProviderName, 'none'>]?.local) {
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
