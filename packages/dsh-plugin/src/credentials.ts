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
