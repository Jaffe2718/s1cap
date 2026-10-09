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
import type { S1ProviderName, TracePlacement } from '@s1cap/core';
import { S1_PROVIDERS } from '@s1cap/s1-client';

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

/**
 * A spelling this build read and cannot honour.
 *
 * It travels with the parse rather than being dropped, because every surface that writes a tuning value can still
 * carry the deleted layout axis — `q=first` on a command line, `xFirst=on` in a saved credential string, a stored
 * `tuning.json` from before 2026-10-05 — and a value that is silently dropped is how a researcher's saved line turns
 * into a different layout without a word. `applyTuning` refuses the whole save and prints `message`.
 */
export interface TuningRefusal {
  /** the spelling that was read, e.g. `q=first` or `the fourth field ("on")` */
  key: string;
  /** the token itself, verbatim */
  value: string;
  /** the sentence the researcher gets: the retired value, the layout it asked for, and the paper sentence */
  message: string;
}

export interface Tuning {
  chunkTokens?: number;
  overlapTokens?: number;
  shortContextTokens?: number;
  /**
   * `recall.depth` (d): the BFS walk's hop bound, and since 2026-10-05 the knob that carries the walk's reach.
   *
   * Bounds 1..16, default 16 (`AssemblyPolicy.recall.depth`, packages/core/src/types.ts, carries the measurement).
   * The panel's ceiling mirrors the validator's (`packages/core/src/config.ts`, `NUMBER_RULES`: `recall.depth` is
   * 1..16), so what the panel accepts and what a profile may write are the same set.
   */
  depth?: number;
  relevanceThreshold?: number;
  /**
   * S1 scoring window w (`recall.window`): integer >= 4, default 16, no upper bound.
   *
   * The floor is **4** since 2026-10-05, down from 64: a window at or above the session's segment count does
   * nothing, and the old floor was 64/1024ths of the ceiling rather than a measurement - see
   * `AssemblyPolicy.recall.window` (`packages/core/src/types.ts`) for the pairs each value offers and the round the
   * numbers come from. The value is mirrored by the core validator's own floor (`packages/core/src/config.ts`), so
   * the panel and a profile agree on the smallest window either will honour.
   */
  window?: number;
  /**
   * `recall.anchorWaitMs`: how long a step may wait, in milliseconds, for the step's newest input event's own
   * scoring row before it assembles anyway.
   *
   * The event is the `user` question on a turn-opening step and the model's own message, tool call or tool result on
   * every step after it (`packages/core/src/observer.ts`, `isInputEvent`), which is what the bounded wait actually
   * waits for — not "the newest user segment", which exists only once per turn.
   *
   * Default 10 000, and `0` disables the wait. The bound is the same one `NUMBER_RULES` carries in core (0..60 000)
   * and an out-of-range value is dropped rather than clamped, on the file's usual rule: a value the researcher never
   * chose must not silently decide whether a step waits at all.
   */
  anchorWaitMs?: number;
  /**
   * `AssemblyPolicy.tracePlacement`: **the paper's variable and the only layout axis** — `'trace-as-state'`
   * (`M([T, x, q])`, the method, and the default) or `'trace-append'` (`M([x, T, q])`, its control).
   *
   * This is the one layout setting the panel exists for: the two arms differ by nothing but the order of `T` and the
   * long context, so a round that wants the control has to be able to write it down. No cell preset sets it, so a
   * value here is a deliberate deviation from the cell and is reported as one at activation, exactly like the other
   * tuning knobs.
   */
  tracePlacement?: TracePlacement;
  /**
   * Spellings that were read and **cannot be honoured**. A save carrying one is refused whole (`applyTuning`) and
   * the sentence inside is printed; nothing is coerced into a different layout.
   *
   * The case this exists for is the question's old slot: `q=first`, `xFirst=on`, `xf=1` and a fourth positional
   * token of `first` all ask for `[T, q, x]`, and no setting produces it any more. `questionPlacement` itself is
   * deleted from the policy (2026-10-05) — the paper places the question last in every condition, so where it sits
   * stopped being a setting — and the spellings that asked for the *last* position are read and noted instead
   * (`notes` below), because they ask for exactly what every layout now does.
   */
  refused?: TuningRefusal[];
  /**
   * Spellings that were read, honoured by doing nothing, and are worth one sentence: the legacy spellings of the
   * question's *last* position (`q=last`, `xFirst=off`, a fourth field of `off`). They are reported so that an old
   * saved command line is not silently reinterpreted — the failure this file's whole fail-safe rule exists for —
   * and they cost the save nothing, because "question last" is what every layout does now.
   */
  notes?: string[];
  /**
   * The interpreter the local backend runs from, e.g. `path/to/laya_py/env/python.exe`.
   *
   * It lives here, beside the knobs, for one reason: this is the only host-side key/value surface this plugin has
   * verified, and the requirement is that the panel can *write* it — a required field with no write path is a field
   * that cannot be filled, and an unfillable required field makes every Laya run impossible. The same fail-safe
   * rule applies: a value that is not a path-looking string is dropped rather than stored, so a typo leaves the
   * default standing instead of writing something that fails only at launch.
   */
  layaPythonPath?: string;
  /** where downloaded checkpoints live; empty or absent means S1CAP's own cache directory */
  layaWeightsCacheDir?: string;
  /** the environment variable the user's Laya reads to find that cache */
  layaWeightsEnvVar?: string;
  /**
   * Which System-1 backend the session runs against: `jev` (cloud) or `laya-serve` (the local runtime).
   *
   * This is the settings panel's radio, and it belongs on this surface for the reason every other field here
   * does: the panel's only write path is the tuning command line, and a radio with no write path is a control
   * that looks switched while the session keeps the backend it was built with. The host already enforces one
   * backend at a time (`singleBackendIssues`), so this changes *which* one, never how many.
   *
   * Validated against the policy's own provider list (`S1_PROVIDERS`, typed by `S1ProviderName`) rather than a
   * second copy of it, and an unknown name is dropped like every other unusable value on this file — a provider
   * nobody chose must not decide which model answers.
   */
  provider?: S1ProviderName;
}

/**
 * Which of the two deleted outcomes one token in the question's old slot asks for.
 *
 * The setting this slot wrote — where the question `q` sits — **no longer exists** (deleted 2026-10-05). The paper
 * separates the question from the long context and places it "at the end of every input" (arXiv:2609.02702 §4.1),
 * with `[T, x, q]` (Trace as State) and `[x, T, q]` (Trace Append) as its two arms and order the only difference;
 * `q` is therefore the last block of every layout this build produces, by construction, and one of the two values
 * the slot could take asks for a layout the build cannot make.
 *
 * So this reader answers *what the token asks for* rather than a value to store:
 *
 *   - `'last'` — the question at the end (`last`, `qlast`, and the boolean-off spellings `off`/`0`/`no`): what every
 *     layout does now. Accepted as a no-op and noted, so an older saved command line keeps working unchanged.
 *   - `'first'` — the question in front of the long context (`first`, `qfirst`, `on`/`1`/`yes`): `[T, q, x]`, which
 *     is neither of the paper's arms and which no setting produces. Refused with the sentence `questionFirstRefusal`
 *     writes, never coerced. Dropping it would silently run a different layout from the one that was asked for, and
 *     that is the one thing an ablation must not do.
 *   - `undefined` — a token this slot never had (a typo, an empty field): dropped, exactly as it always was, because
 *     a mis-spelled token must never move a block.
 *
 * The *decision* about which spellings ask for the deleted layout is made here rather than read from core's
 * `LEGACY_LAYOUT_KEYS`, and the reason is not duplication for convenience: the wire's vocabulary was never the
 * profile key's. The command line also accepted `qfirst`/`qlast`, `off`/`no` and a bare fourth field, and
 * `@s1cap/core` resolves to a *build artifact* (`packages/core/lib/`) — so a decision read from that table would
 * make what this parser refuses depend on whether the working tree had been rebuilt, which is the failure the
 * `lib/`-freshness check exists to catch. Core's table stays the profile-side source for the same question, and the
 * two agree on what each value meant: `first`/`qfirst`/`on`/`1`/`yes` was the question first, and
 * `last`/`qlast`/`off`/`0`/`no` was the question last.
 */
const QUESTION_FIRST_SPELLINGS: ReadonlySet<string> = new Set(['first', 'qfirst', '1', 'on', 'true', 'yes']);
const QUESTION_LAST_SPELLINGS: ReadonlySet<string> = new Set(['last', 'qlast', '0', 'off', 'false', 'no']);

export function questionSlotOutcome(token: string | undefined): 'first' | 'last' | undefined {
  if (token === undefined) return undefined;
  const t = token.trim().toLowerCase();
  if (QUESTION_FIRST_SPELLINGS.has(t)) return 'first';
  if (QUESTION_LAST_SPELLINGS.has(t)) return 'last';
  return undefined;
}

/**
 * The sentence a wire spelling gets when it asks for the question in front of the long context.
 *
 * It names the spelling and the value (`where`, e.g. `` `q=first` `` or `` `xFirst: true` ``), the layout that value
 * asked for, and the paper sentence that retired it — the same facts core's profile-side refusal carries, in the
 * words of the surface it was written on. Exported because the stored tuning file is a third surface with the same
 * two outcomes (`index.ts`, `readTuningFile`), and two copies of a sentence like this drift.
 */
export function questionFirstRefusal(where: string, value: string): TuningRefusal {
  return {
    key: where,
    value,
    message:
      `${where} asks for the question in front of the long context — \`[T, q, x]\` — and no setting here produces ` +
      `it: the question is the last block of every layout by construction, because the paper separates it from the ` +
      `long context and places it "at the end of every input" (arXiv:2609.02702 §4.1), its two arms being ` +
      `\`[T, x, q]\` (trace-as-state) and \`[x, T, q]\` (trace-append). The axis those spellings wrote is deleted, ` +
      `so nothing was applied rather than substituting a different layout. The only layout axis is \`trace\` ` +
      `(\`trace-as-state\` | \`trace-append\`); drop the question setting.`,
  };
}

/** The sentence a wire spelling gets when it asks for the question at the end, which is what every layout does. */
export function questionLastNote(where: string, value: string): string {
  return (
    `${where} is retired and was ignored on purpose: it asked for the question last, which is where the question ` +
    `sits in every layout now — the paper places it "at the end of every input" (arXiv:2609.02702 §4.1), so the ` +
    `setting it wrote no longer exists. Nothing changed, and \`trace\` is the only layout axis.`
  );
}

/**
 * Parse the tuning string the panel writes.
 *
 * **Fail-safe, and deliberately not clamping:** a field outside its stated range (`d` an integer in 1..16,
 * `0 <= r <= 1`, `w` an integer >= 4) is *dropped* so the policy default stands. Clamping would silently run a cell
 * at a value the researcher never chose, which is the one thing an ablation must never do.
 *
 * This reads the legacy `"<d> <r> <w> <question slot>"` credential string, which is why it takes no `wait`: that
 * field was added after the panel moved to the HTTP route and the keyed command line, and appending a fifth
 * positional here would silently reinterpret a question token that an old write already put in slot four.
 * `parseTuningArgs` is the surface that owns it. Slot four itself is now read only to be refused or noted — the
 * setting it wrote is deleted — and the position is never reassigned, for that same reason: a string written when
 * slot four was the question must not have its fourth field read as something else.
 */
export function parseTuning(value: string | undefined): Tuning {
  const out: Tuning = {};
  if (typeof value !== 'string') return out;
  const parts = value.trim().split(/\s+/);
  const depth = Number(parts[0]);
  if (Number.isInteger(depth) && depth >= 1 && depth <= 16) out.depth = depth;
  const relevanceThreshold = Number(parts[1]);
  if (Number.isFinite(relevanceThreshold) && relevanceThreshold >= 0 && relevanceThreshold <= 1) out.relevanceThreshold = relevanceThreshold;
  const window = Number(parts[2]);
  if (Number.isInteger(window) && window >= 4) out.window = window;
  const slot = questionSlotOutcome(parts[3]);
  if (slot === 'first') {
    out.refused = [questionFirstRefusal(`the fourth field of the credential string (${JSON.stringify(parts[3])})`, String(parts[3]))];
  } else if (slot === 'last') {
    out.notes = [questionLastNote(`the fourth field of the credential string (${JSON.stringify(parts[3])})`, String(parts[3]))];
  }
  return out;
}
/**
 * A path-looking string, or nothing.
 *
 * Deliberately loose: this does not check that the file exists, because the panel writes a path on a machine
 * where the file may not be there yet (a venv being created, a network drive being mounted) and refusing it would
 * make the field unusable for the case it exists for. It rejects only what cannot be a path at all — empty,
 * whitespace, or a bare token with no separator — so a mistyped field falls back to the default instead of
 * becoming a launch-time failure with a message nobody reads.
 */
export function parsePath(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = unquote(value).trim();
  if (trimmed === '') return undefined;
  if (!/[\\/]/.test(trimmed)) return undefined;
  return trimmed;
}

/** A plausible environment-variable name: letters, digits and underscores, starting with a letter or underscore. */
export function parseEnvName(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = unquote(value).trim();
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed) ? trimmed : undefined;
}

/**
 * The provider names the panel may send, in the two spellings a human types.
 *
 * `laya` is the short name the radio shows next to "Laya (local)"; the policy calls the same backend
 * `laya-serve` (`PROVIDERS` in `@s1cap/s1-client`, `S1ProviderName` in core). The alias is resolved *before* the
 * membership test, so the accepted set stays exactly the policy's list and not a second one maintained here.
 */
const PROVIDER_ALIASES: Readonly<Record<string, string>> = { laya: 'laya-serve' };

/**
 * One provider name, canonicalised, or nothing.
 *
 * Fail-safe like the rest of this file: an unknown provider is dropped rather than clamped to the nearest known
 * one, because a value the researcher never chose must not decide which backend answers. The set is the policy's
 * own `S1_PROVIDERS`, so a provider added there is settable from the panel the same day.
 */
export function parseProvider(value: string | undefined): S1ProviderName | undefined {
  if (typeof value !== 'string') return undefined;
  const name = unquote(value).trim().toLowerCase();
  if (name === '') return undefined;
  const canonical = PROVIDER_ALIASES[name] ?? name;
  return (S1_PROVIDERS as readonly string[]).includes(canonical) ? (canonical as S1ProviderName) : undefined;
}

/**
 * Split the tuning string into tokens, honouring double quotes anywhere inside a token.
 *
 * Quoting is not a nicety here — it is load-bearing on this machine. The interpreter this plugin is most likely to
 * be pointed at is the one DSH ships, and that path is `D:\Program Files\DeepSeek Harness\resources\...`. A plain
 * space-separated split cuts it into three tokens, so the panel would store nothing at all and the required field
 * would stay empty with no error anywhere. Found by a test written for an unrelated reason.
 *
 * The pattern matters: a token is a run of non-space characters *in which a quoted section counts as one unit*.
 * A plain `\S+` alternative loses, because the scan starts at the key and the opening quote is swallowed along
 * with the first word — the first version of this cut `laya="D:/Program Files/…"` down to `D:/Program`.
 */
function tokenize(input: string): string[] {
  return input.match(/(?:[^\s"]|"[^"]*")+/g) ?? [];
}

/** Drop one layer of surrounding double quotes, which the tokenizer keeps so quoted sections stay together. */
function unquote(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

/**
 * Parse a tuning command line. Accepts `3 0.7`, `d=3 r=0.7`, `depth=3 relevanceThreshold=0.7`, or either field alone; the same
 * rules apply (`d` an integer in 1..16, `0 <= r <= 1`, `w` an integer >= 4) and anything else is dropped rather than
 * clamped. `wait=` carries the bounded anchor wait (an integer 0..60000, where 0 turns it off) and has no positional
 * slot, for the reason given on `parseTuning`.
 *
 * `tracePlacement=` is the paper's variable and **the only layout axis** — `trace-as-state` (the method) or
 * `trace-append` (its control). It has no positional slot: the first four tokens are the legacy `d r w <question>`
 * order an older write already used, and a word landing in one of those would be silently dropped anyway.
 *
 * The question's own spellings are still *read* and no longer *set*: `q=`, `questionPlacement=`, `xFirst=`, `xf=`
 * and the fourth positional token all named where `q` sits, the field behind them is deleted (the paper places the
 * question last in every condition), and the two outcomes are deliberately different. A token asking for the
 * question **last** (`q=last`, `xFirst=off`, `off`) is accepted as a no-op and reported (`Tuning.notes`), so a
 * researcher's saved command line keeps working and is not silently reinterpreted. A token asking for the question
 * **first** (`q=first`, `xFirst=on`) is **refused** (`Tuning.refused`, with the paper sentence that retired it):
 * it asks for `[T, q, x]`, which no setting produces, and dropping it would run a different layout than the one
 * that was written down.
 *
 * `provider=` selects the System-1 backend (`jev`, `laya-serve` or `none`; `laya` is accepted as the short spelling
 * the radio shows). It has no positional slot either, for the same reason.
 */
export function parseTuningArgs(input: string | undefined): Tuning {
  if (typeof input !== 'string') return {};
  const out: Tuning = {};
  const refused: TuningRefusal[] = [];
  const notes: string[] = [];
  const assign = (key: string, raw: string): void => {
    const value = Number(raw);
    if (key === 'chunkTokens' || key === 'c') {
      if (raw.trim() !== '' && Number.isInteger(value) && value >= 64 && value <= 8192) out.chunkTokens = value;
      return;
    }
    if (key === 'overlapTokens' || key === 'omega' || key === 'ω') {
      if (raw.trim() !== '' && Number.isInteger(value) && value >= 0 && value <= 4096) out.overlapTokens = value;
      return;
    }
    if (key === 'shortContextTokens' || key === 's') {
      if (raw.trim() !== '' && Number.isInteger(value) && value >= 0 && value <= 1048576) out.shortContextTokens = value;
      return;
    }
    if (key === 'depth' || key === 'd') {
      if (Number.isInteger(value) && value >= 1 && value <= 16) out.depth = value;
      return;
    }
    if (key === 'window' || key === 'w') {
      if (Number.isInteger(value) && value >= 4) out.window = value;
      return;
    }
    // The bounded anchor wait. `Number('')` is 0, which is a *legal* value here - it turns the wait off - so an
    // empty token like `wait=` would silently disable the wait it was meant to set. It has to be rejected before the
    // coercion, and that is the only reason this branch is shaped differently from the two above.
    if (key === 'anchorWaitMs' || key === 'wait') {
      if (raw.trim() === '') return;
      const ms = Number(raw);
      if (Number.isInteger(ms) && ms >= 0 && ms <= 60_000) out.anchorWaitMs = ms;
      return;
    }
    if (key === 'relevanceThreshold' || key === 'r') {
      if (Number.isFinite(value) && value >= 0 && value <= 1) out.relevanceThreshold = value;
      return;
    }
    // The paper's two arms, under the paper's names. Only those two strings move the trace: a near miss
    // (`trace-state`, `append`) leaves the arm where it was, because guessing here would reorder the prompt.
    if (key === 'tracePlacement' || key === 'trace') {
      const t = raw.trim().toLowerCase();
      if (t === 'trace-as-state') out.tracePlacement = 'trace-as-state';
      else if (t === 'trace-append') out.tracePlacement = 'trace-append';
      return;
    }
    // The question's old slot: every spelling of it is read, and what it asks for decides between a refusal
    // (`first`) and a note (`last`). Nothing is ever written for it, because there is no field behind it any more.
    if (key === 'questionPlacement' || key === 'q' || key === 'xFirst' || key === 'xf') {
      const where = `${key}=${raw}`;
      const slot = questionSlotOutcome(raw);
      if (slot === 'first') refused.push(questionFirstRefusal(where, raw));
      else if (slot === 'last') notes.push(questionLastNote(where, raw));
      return;
    }
    // The Laya fields are strings, so they are read before the numeric coercion above could swallow them.
    if (key === 'layaPythonPath' || key === 'laya' || key === 'py') {
      const path = parsePath(raw);
      if (path !== undefined) out.layaPythonPath = path;
      return;
    }
    if (key === 'layaWeightsCacheDir' || key === 'weights') {
      const path = parsePath(raw);
      if (path !== undefined) out.layaWeightsCacheDir = path;
      return;
    }
    if (key === 'layaWeightsEnvVar' || key === 'weightsEnv') {
      const name = parseEnvName(raw);
      if (name !== undefined) out.layaWeightsEnvVar = name;
      return;
    }
    // The backend the radio selects. Not numeric, so it is read here and not by the coercion above; an unknown
    // name is dropped rather than clamped, on this file's usual rule.
    if (key === 'provider') {
      const provider = parseProvider(raw);
      if (provider !== undefined) out.provider = provider;
    }
  };
  const positional: string[] = [];
  for (const token of tokenize(input)) {
    if (token === '') continue;
    // The value runs to the end of the token, not to the next space: `tokenize` has already made a quoted path
    // one token, and a `(\S+)` here would silently store `D:/Program` out of `D:/Program Files/...`.
    const match =
      /^(chunkTokens|c|overlapTokens|omega|ω|shortContextTokens|s|depth|d|relevanceThreshold|r|window|w|anchorWaitMs|wait|tracePlacement|trace|questionPlacement|q|xFirst|xf|layaPythonPath|laya|py|layaWeightsCacheDir|weights|layaWeightsEnvVar|weightsEnv|provider)\s*=\s*(.+)$/.exec(
        token,
      );
    if (match && match[1] !== undefined && match[2] !== undefined) assign(match[1], match[2]);
    else positional.push(token);
  }
  if (positional[0] !== undefined) assign('depth', positional[0]);
  if (positional[1] !== undefined) assign('relevanceThreshold', positional[1]);
  if (positional[2] !== undefined) assign('window', positional[2]);
  // Slot four is where the question's old setting has always been read from, under every spelling it had, and the
  // credential string and the panel both wrote it there. The *setting* is deleted but the slot is not reassigned -
  // a string written when slot four was the question must not have its fourth field read as something else - so what
  // arrives here is refused (`first`) or noted (`last`) and never stored.
  if (positional[3] !== undefined) {
    const where = `the fourth field (${JSON.stringify(positional[3])})`;
    const slot = questionSlotOutcome(positional[3]);
    if (slot === 'first') refused.push(questionFirstRefusal(where, positional[3]));
    else if (slot === 'last') notes.push(questionLastNote(where, positional[3]));
  }
  if (refused.length > 0) out.refused = refused;
  if (notes.length > 0) out.notes = notes;
  return out;
}
