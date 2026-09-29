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

export interface CredentialReadResult {
  key?: string;
  /** which entry point answered; undefined when none did */
  method?: string;
  /** the entry points attempted, in order */
  tried: string[];
}

export interface CredentialReadOptions {
  /** `"<scope>/<id>"` */
  ref: string;
  /** the service object, as returned by `ctx.get('credentials')`, if any */
  service: unknown;
  /** diagnostic channel (a probe line); never receives the key itself */
  report?(line: Record<string, unknown>): void;
}

const READ_ENTRY_POINTS = ['resolve', 'readRecord', 'get', 'read', 'describeRecord'] as const;

/** Accept a plain string, or an object that carries the secret in a conventional field. */
function unwrap(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value;
  if (value === null || typeof value !== 'object') return undefined;
  const record = value as { value?: unknown; secret?: unknown; text?: unknown; key?: unknown };
  for (const field of ['value', 'secret', 'text', 'key'] as const) {
    const candidate = record[field];
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate;
  }
  return undefined;
}

/**
 * Try to read one credential. Never throws: an unusable service is reported, not escalated, because a plugin
 * must not be able to break a session over an optional secret.
 */
export async function readCredential(opts: CredentialReadOptions): Promise<CredentialReadResult> {
  const tried: string[] = [];
  const service = opts.service;
  if (service === null || typeof service !== 'object') {
    opts.report?.({ schema: 0, kind: 'credential', result: 'no credentials service', ref: opts.ref });
    return { tried };
  }

  for (const name of READ_ENTRY_POINTS) {
    const candidate = (service as Record<string, unknown>)[name];
    if (typeof candidate !== 'function') continue;
    tried.push(name);
    try {
      const raw = await (candidate as (ref: string) => unknown).call(service, opts.ref);
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

export interface Tuning {
  depth?: number;
  relevanceThreshold?: number;
  /** S1 scoring window w (recall.window): integer >= 64, default 1024, no upper bound */
  window?: number;
}

/**
 * Parse the tuning string the panel writes.
 *
 * **Fail-safe, and deliberately not clamping:** a field outside its stated range (`d` an integer > 0, `0 <= r <= 1`)
 * is *dropped* so the policy default stands. Clamping would silently run a cell at a value the researcher never
 * chose, which is the one thing an ablation must never do.
 */
export function parseTuning(value: string | undefined): Tuning {
  const out: Tuning = {};
  if (typeof value !== 'string') return out;
  const parts = value.trim().split(/\s+/);
  const depth = Number(parts[0]);
  if (Number.isInteger(depth) && depth > 0) out.depth = depth;
  const relevanceThreshold = Number(parts[1]);
  if (Number.isFinite(relevanceThreshold) && relevanceThreshold >= 0 && relevanceThreshold <= 1) out.relevanceThreshold = relevanceThreshold;
  const window = Number(parts[2]);
  if (Number.isInteger(window) && window >= 64) out.window = window;
  return out;
}
/**
 * Parse a tuning command line. Accepts `3 0.7`, `d=3 r=0.7`, `depth=3 relevanceThreshold=0.7`, or either field alone; the same
 * two rules apply (d an integer > 0, 0 <= r <= 1) and anything else is dropped rather than clamped.
 */
export function parseTuningArgs(input: string | undefined): Tuning {
  if (typeof input !== 'string') return {};
  const out: Tuning = {};
  const assign = (key: string, raw: string): void => {
    const value = Number(raw);
    if (key === 'depth' || key === 'd') {
      if (Number.isInteger(value) && value > 0) out.depth = value;
      return;
    }
    if (key === 'window' || key === 'w') {
      if (Number.isInteger(value) && value >= 64) out.window = value;
      return;
    }
    if (key === 'relevanceThreshold' || key === 'r') {
      if (Number.isFinite(value) && value >= 0 && value <= 1) out.relevanceThreshold = value;
    }
  };
  const positional: string[] = [];
  for (const token of input.trim().split(/\s+/)) {
    if (token === '') continue;
    const match = /^(depth|d|relevanceThreshold|r|window|w)\s*=\s*(\S+)$/.exec(token);
    if (match && match[1] !== undefined && match[2] !== undefined) assign(match[1], match[2]);
    else positional.push(token);
  }
  if (positional[0] !== undefined) assign('depth', positional[0]);
  if (positional[1] !== undefined) assign('relevanceThreshold', positional[1]);
  if (positional[2] !== undefined) assign('window', positional[2]);
  return out;
}