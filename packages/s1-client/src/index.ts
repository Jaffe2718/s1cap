/**
 * Thin client for the decision-model wire protocol `POST {baseUrl}/v1/systemone`
 * (TypeSafe Jev; wire-compatible with Laya `laya-serve`, EdgeJev, Kev).
 *
 * Verified request/response shape (docs/AGENT_BRIEF.md §1.2):
 *   request  { state, model?, questions: { <id>: { type, instructions, criteria? } } }
 *   response { model, answers: { <id>: {...} }, usage: { input_tokens, output_tokens } }
 *
 * Interop note: `system-one-core` (npm, MIT) implements the same protocol with
 * `HttpSystemOneProvider`; this client is vendored to keep S1CAP dependency-free
 * for offline test runs and to own normalization/telemetry semantics.
 */

export interface NoulQuestion {
  type: 'noul';
  instructions: string;
  criteria?: { true: string; false: string };
}

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  /** option id -> description (null when self-explanatory) */
  criteria: Record<string, string | null>;
}

export interface ScoreQuestion {
  type: 'score';
  instructions: string;
  /** ordered levels, 2..10 (Jev limit) */
  criteria: string[];
}

export type S1Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface NoulAnswer {
  type: 'noul';
  /** P(true) in [0,1]; noul answers carry no confidence field */
  noul: number;
}

export interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface ScoreAnswer {
  type: 'score';
  score: number;
  legend?: string;
  probabilities?: Record<string, number>;
  confidence: number;
}

export type S1Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface S1Usage {
  input_tokens: number;
  output_tokens: number;
}

/**
 * `routing` is what separates a real Laya deployment from anything answering under the same
 * protocol. Measured against `laya-serve` 0.3.21 (typed-decisions checkpoint) on 2026-09-30, a
 * successful answer carries `{model: "english", repo: "convaiinnovations/laya", reason: ...}`:
 * the script/language the router picked and the repository the checkpoint came from. A stub, or
 * any other server speaking the wire format, has no reason to produce it. Recording it is what
 * lets an experiment say which checkpoint produced a given score instead of trusting the
 * `provider` name in its own config - a stub answering on the configured port is otherwise
 * indistinguishable from the model in the telemetry.
 */
export interface S1Routing {
  model?: string;
  repo?: string;
  reason?: string;
}

export interface S1DecideResult {
  model: string;
  answers: Record<string, S1Answer>;
  usage: S1Usage;
  /** the answering attempt's own duration; add `waitedMs` for what the call cost in total */
  ms: number;
  /** present only when the server reported it; see `S1Routing` */
  routing?: S1Routing;
  /** attempts this answer took — 1 when the backend answered first time */
  attempts: number;
  /** total time spent waiting between those attempts */
  waitedMs: number;
}

/**
 * How a call may be re-attempted after the backend *refused* it.
 *
 * Explicit, and off unless the caller asks, because a hidden retry is a hidden policy: the caller is the one that
 * decides a judgement is worth another second. Only a refusal is retryable — Laya answers `503 server busy` with
 * `Retry-After` rather than queueing (docs/LAYA_RUNTIME.md §6b) — because repeating a refusal costs one wait while
 * repeating a transport timeout costs the whole guard again, and that guard is now sized per batch
 * (`s1TransportGuardMs`: 11.25 s at one question, 90 s at the server's 64-question cap).
 */
export interface S1RetryPolicy {
  /** attempts for one call, including the first; 1 means no retry */
  maxAttempts: number;
  /** use the server's `Retry-After` when it sends one (default true) */
  respectRetryAfter?: boolean;
  /** delay used when no usable `Retry-After` arrives (default 1000 ms) */
  fallbackDelayMs?: number;
  /** ceiling on the total wait between attempts (default: no ceiling) */
  maxWaitMs?: number;
}

export interface S1ClientOptions {
  baseUrl: string;
  apiKey?: string;
  model?: string;
  /**
   * Aborts the request when the caller is cancelled - the harness hands a plugin its own `AbortSignal`, and a
   * cancelled session should stop paying for System-1 calls immediately rather than at the end of a batch.
   *
   * This is **not** a deadline. There is deliberately no `timeoutMs` option: a request deadline is a transport
   * property, not something the method has a concept of, and making it a policy field is how a 2500 ms value
   * ended up silently deciding that half a session's pairs would be scored lexically instead of by the backend.
   * The guard below is derived from the batch the call is already carrying (`s1TransportGuardMs`), so nobody
   * tunes it and nobody has to remember to set it: the workload sets it.
   */
  signal?: AbortSignal;
  /** see `S1RetryPolicy`; omitted means one attempt, exactly as before this option existed */
  retry?: S1RetryPolicy;
  /** injectable for tests */
  fetchImpl?: typeof fetch;
}

/**
 * The transport guard's fixed part: everything a call costs before the model has done any work.
 *
 * Covers the round trip, the body read and `json.loads` (measured at 18 ms against the local Laya server, flat at
 * every batch size), the fixed overhead a cold or contended server adds before it starts a forward pass, and the
 * queue wait of the first request in the server's own admission window. It is **also the floor the guard never
 * drops below**, and that is the point of it: the guard's real purpose - a dead socket is detected without
 * waiting for the model to have finished something it never started - is bought here, because 10 s is 21x the
 * measured latency of a one-question call (539 ms on the coolest measured GPU state) and still 8x the *soaked*
 * per-question cost, so nothing legitimate is cut off by it.
 */
export const S1_TRANSPORT_BASE_MS = 10_000;

/**
 * The transport guard's per-question part: what one more question in the batch may cost.
 *
 * The service time is linear in the batch, so a constant cannot be both fast for one question and sufficient for
 * sixty-four - which is exactly how the fixed 30 000 ms guard this replaces was falsified (see the note on
 * `s1TransportGuardMs`). Taken from the one measured point that bounds the throttled case: a 40-question call
 * took **40 800 ms** wall on a thermally soaked GPU at in-flight 1, i.e. 1 020.0 ms per question, rounded up to
 * 1 250 (+23 %) because that measurement carries two known uncertainties - its payload's rows were clamped at
 * `max_len` (its `input_tokens` is exactly 512 x questions), and the GPU clock it ran at is not recorded.
 */
export const S1_TRANSPORT_PER_QUESTION_MS = 1_250;

/**
 * How long the request for a batch of `questionCount` questions may hang before the socket is treated as dead.
 *
 * ## Why this is a function and not the constant it used to be
 *
 * It was `S1_TRANSPORT_TIMEOUT_MS = 30_000`, justified by "measured calls against a warm Laya server peak at
 * ~2.4 s for a full batch of twenty questions ... it fires when a socket is dead, never when a model is merely
 * thinking". **That premise is falsified in both directions, by measurement.**
 *
 *   - It does fire on a backend that is working. At in-flight 16 a 20-question call's wall p95 is 39.0 s and at
 *     24-32 it is 49-50 s, against a *service* time of 2.4 s at every one of those levels - throughput is flat and
 *     latency is linear, so the extra 37 s is the queue in front of the server's single inference lock. Those
 *     calls were being served, one at a time, and the guard called them dead.
 *   - It does not cover the largest batch. The server admits 64 questions (`MAX_QUESTIONS`, `serve.py:67`), and a
 *     64-question call was measured at 9.6 s of service *soaked* and 39-50 s of wall at high in-flight - at or
 *     past the constant, and past it outright by extrapolation on a worse clock.
 *   - The round's own telemetry says the two ends of the range cannot share one number: round `20261004-0233` (C2)
 *     has 634 `s1_call` records, of which **24 ended at `S1TimeoutError: systemone request timed out after
 *     30000ms`** while the 604 that completed took at most 13 988 ms (p50 4 882 ms). A 30 s outcome and a 14 s
 *     ceiling in the same distribution is the guard, not the model, deciding the outcome - and at
 *     `admissionLimit: 8` the wall time of a 20-question call is roughly 8x the 3.06 s service time measured for
 *     that shape, so queue wait alone is enough to reach 30 s without the socket being dead at all.
 *
 * The service time is linear in the batch (`srv ~= 18 + 25.3 q` on a cool GPU) while the guard was constant, so it
 * could not be right at both ends of a range that now reaches 64 questions.
 *
 * ## What it covers, and what it does not
 *
 * | questions | guard | what it has to cover |
 * |---|---|---|
 * | 1 | 11 250 ms | 539 ms measured, cool |
 * | 20 | 35 000 ms | 13 200 ms measured soaked; 39-50 s measured at in-flight 16-32, which is **queue**, not service |
 * | 40 | 60 000 ms | **40 800 ms measured soaked** - the anchor the slope comes from |
 * | 64 | 90 000 ms | ~65 280 ms by extrapolation of that anchor - **not measured; no soaked 64-question run exists** |
 *
 * The margin is deliberately ~1.4-1.5x over the measured anchor, and much larger at the concurrency the sibling
 * measurement recommends, because at in-flight N the wall time is roughly N x the service time: at
 * `s1.admissionLimit` 1 the guard is 11.4x the worst legitimate 20-question call and 9.2x the 64-question one, and
 * at 2 it is 5.7x and 4.6x. That is the coupling worth stating: **this guard bounds a dead socket and the service
 * time; it does not bound a queue.** At `admissionLimit` 8+ a 20-question call's p95 wall time was measured at
 * 39 s, and no guard a dead socket can afford would have covered it - the fix for that end is the limit, not this
 * number.
 *
 * A caller that is merely slow to *start* is not covered either, and cannot be: the response is single-shot, so
 * fetch exposes no progress signal, and "no bytes yet" is the same fact for a dead socket and for a batch that has
 * not begun. That is why the intercept exists and why the guard is not smaller for small batches.
 */
export function s1TransportGuardMs(questionCount: number): number {
  const questions = Number.isFinite(questionCount) ? Math.max(1, Math.trunc(questionCount)) : 1;
  return S1_TRANSPORT_BASE_MS + S1_TRANSPORT_PER_QUESTION_MS * questions;
}

/**
 * How long a *probe* - `health()` or `models()` - may stay silent before its socket is treated as dead.
 *
 * ## Why the probes do not reuse `s1TransportGuardMs`
 *
 * That guard is sized to the inference a *decision* is buying: 10 s of fixed cost plus 1.25 s per question, so
 * 11.25 s at one question and 90 s at the server's 64-question cap. A probe buys no inference at all - it asks
 * whether the backend is there - so the batch guard's floor is 11.25 s of silence for a call whose whole answer is
 * one boolean. Worse, the only caller prints that silence *as a measurement of the backend*: `s1-ping`
 * (`packages/dsh-plugin/src/index.ts:2094-2105`) reports `ms` and says "did not answer /health in Nms", so an 11 s
 * probe reports the guard's own floor as if it were the server's latency. A probe that is slow to say "not there"
 * is the same defect as the hang, only finite.
 *
 * ## Why it is not the launcher's readiness budget either
 *
 * "A backend that is loading a checkpoint for the first time" is a real case, and it belongs to
 * `LayaServer.waitForReady` (`packages/laya-runtime/src/launcher.ts:210-228`), which polls `/health` and
 * `/v1/models` every `pollIntervalMs` (500 ms default) up to `startupTimeoutMs` (120 s default, 600 s from the CLI)
 * and swallows each poll's connection error. A first run cannot even *hang* a probe: with `LAYA_PRELOAD=1` the
 * checkpoints are built **before** uvicorn binds (docs/LAYA_RUNTIME.md §6), so during a download the port is closed
 * and `/health` is refused instantly. The path that must tolerate a slow first start is the polling loop, and it
 * does; the path that must answer quickly is this one, and before this constant existed it could not answer at all.
 *
 * ## The number
 *
 * 5 000 ms. The measured cost of a probe is the fixed part of a call - round trip, body read and `json.loads`, **18
 * ms** against the local server - and the coolest measured call of any kind is 539 ms for a one-question decision.
 * 5 s is 278x the former and 9.3x the latter, so a probe still answers when it is delayed behind work an order of
 * magnitude more expensive than any `/health` handler can be. Thermal throttling multiplies *inference* service time
 * (measured ~24x), not the round trip: 24 x 18 ms is 432 ms, 11x inside this bound. **The assumption this rests on**
 * is that `/health` is not queued behind the inference path - the admission semaphore and the model lock live in the
 * `/v1/systemone` route (docs/LAYA_RUNTIME.md §6b), and `LAYA_MAX_CONCURRENT` admits 16 calls at once - a
 * concurrency one serialized handler could not offer. If that stops holding, the soaked one-question figure
 * (24 x 539 ms, ~13 s) is what falsifies 5 s, and the fix is this number rather than the batch guard.
 *
 * `models()` shares the bound rather than getting its own: it is the same pre-flight question, answered without
 * inference, and nothing in this repository calls it on a startup path - `/v1/models` exists only on the hosted Jev
 * deployment, whose extra cost over a local probe is a TLS handshake and a WAN round trip, both far inside 5 s.
 */
export const S1_PROBE_TIMEOUT_MS = 5_000;

/**
 * Statuses that mean "refused, come back", not "your request is wrong".
 *
 * 503 is the one that matters here — it is Laya's admission control. 429 and the two gateway statuses are the
 * same shape of answer from other deployments, and a 400/413/422 is a request the server will refuse again.
 */
export const S1_RETRYABLE_STATUS: readonly number[] = [429, 502, 503, 504];

export class S1HttpError extends Error {
  readonly status: number;
  /** the server's `Retry-After` as a delay in ms, when it sent one and it parses as seconds */
  retryAfterMs?: number;
  /** attempts made before this was thrown (1 for a single attempt), set by the retry loop */
  attempts?: number;
  /** total time spent waiting between those attempts, set by the retry loop */
  waitedMs?: number;
  constructor(status: number, message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'S1HttpError';
    this.status = status;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

export class S1TimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`systemone request timed out after ${timeoutMs}ms`);
    this.name = 'S1TimeoutError';
  }
}

/**
 * The request was aborted because the caller was cancelled, not because the backend was slow.
 *
 * A separate type on purpose: a cancelled session is not a failing backend, and a record that cannot tell the
 * two apart would report cancellations as reliability problems - and, worse, would count them as reasons to fall
 * back to the lexical scorer.
 */
export class S1CancelledError extends Error {
  attempts?: number;
  waitedMs?: number;
  constructor() {
    super('systemone request cancelled by the caller');
    this.name = 'S1CancelledError';
  }
}

/** Known deployments live in `providers.ts` (one active backend at a time); re-exported here. */
export * from './providers.ts';
export * from './resolve.ts';

export class S1Client {
  #baseUrl: string;
  #apiKey: string | undefined;
  #model: string | undefined;
  #fetch: typeof fetch;
  #retry: S1RetryPolicy | undefined;

  constructor(opts: S1ClientOptions) {
    this.#baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.#apiKey = opts.apiKey;
    this.#model = opts.model;
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#retry = opts.retry;
  }

  /**
   * Evaluate any number of questions against one state in a single call.
   *
   * With a `retry` policy a *refused* call is attempted again, waiting the server's own `Retry-After`; the returned
   * `attempts` and `waitedMs` say what the answer took. A timeout is never retried — repeating it costs another
   * whole guard, which is 90 s at the server's 64-question cap — and neither is a cancellation, which is the
   * caller's decision rather than a backend failure.
   *
   * The transport guard is `s1TransportGuardMs(Object.keys(questions).length)`: the batch size decides how long the
   * socket may stay silent, because the service time is linear in the batch and a constant cannot be right at both
   * one question and sixty-four.
   */
  async decide(
    state: unknown,
    questions: Record<string, S1Question>,
    opts: { signal?: AbortSignal } = {},
  ): Promise<S1DecideResult> {
    const maxAttempts = Math.max(1, Math.trunc(this.#retry?.maxAttempts ?? 1));
    const budgetMs = this.#retry?.maxWaitMs ?? Number.POSITIVE_INFINITY;
    let waitedMs = 0;
    for (let attempt = 1; ; attempt += 1) {
      try {
        const result = await this.#decideOnce(state, questions, opts);
        return { ...result, attempts: attempt, waitedMs };
      } catch (err) {
        const refused = err instanceof S1HttpError && S1_RETRYABLE_STATUS.includes(err.status);
        if (!refused || attempt >= maxAttempts || opts.signal?.aborted === true) {
          throw withAttempts(err, attempt, waitedMs);
        }
        const delayMs = retryDelayMs(err, this.#retry);
        // The budget belongs to the caller: a retry that cannot fit inside it is not worth starting, and throwing
        // the refusal now is more honest than returning a judgement several seconds past the caller's patience.
        if (waitedMs + delayMs > budgetMs) throw withAttempts(err, attempt, waitedMs);
        await sleepAbortable(delayMs, opts.signal, attempt, waitedMs);
        waitedMs += delayMs;
      }
    }
  }

  /** One attempt. The loop above owns everything about repeating it. */
  async #decideOnce(
    state: unknown,
    questions: Record<string, S1Question>,
    opts: { signal?: AbortSignal } = {},
  ): Promise<Omit<S1DecideResult, 'attempts' | 'waitedMs'>> {
    const started = Date.now();
    // The guard is sized by the batch: the service time is linear in it, so a single constant would either cut off
    // a large batch that is working or leave a dead socket on a small one hanging for a minute. See the table on
    // `s1TransportGuardMs` for the two measured anchors and the one extrapolation.
    const guardMs = s1TransportGuardMs(Object.keys(questions).length);
    const guard = new AbortController();
    const timer = setTimeout(() => guard.abort(), guardMs);
    // Two reasons to abort, kept distinguishable: our own transport guard, and the caller's cancellation. The
    // caller's signal wins the classification, because a cancelled session is not a slow backend.
    const signal =
      opts.signal === undefined ? guard.signal : AbortSignal.any([guard.signal, opts.signal]);
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (this.#apiKey) headers.authorization = `Bearer ${this.#apiKey}`;

      const res = await this.#fetch(`${this.#baseUrl}/v1/systemone`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          state,
          ...(this.#model ? { model: this.#model } : {}),
          questions,
        }),
        signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new S1HttpError(
          res.status,
          `systemone ${res.status}: ${body.slice(0, 200)}`,
          parseRetryAfter(res.headers.get('retry-after')),
        );
      }

      const json = (await res.json()) as Partial<S1DecideResult>;
      return {
        model: json.model ?? this.#model ?? 'unknown',
        answers: json.answers ?? {},
        usage: json.usage ?? { input_tokens: 0, output_tokens: 0 },
        ms: Date.now() - started,
        // Forwarded verbatim when the server reports it. Absent is information too: a server
        // that never names its checkpoint is not identifiable as Laya from the telemetry alone.
        ...(json.routing !== undefined ? { routing: json.routing } : {}),
      };
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        if (opts.signal?.aborted === true) throw new S1CancelledError();
        throw new S1TimeoutError(guardMs);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Run a probe under `S1_PROBE_TIMEOUT_MS`.
   *
   * The timer covers the **body read** as well as the response headers, which is why the work is passed in as a
   * callback instead of guarding a `fetch` on its own: `fetch` resolves as soon as the headers arrive, so a socket
   * that answers and then stalls mid-body would hang `res.json()` after any narrower guard had been disarmed.
   * `#decideOnce` has the same shape for the same reason.
   *
   * The classification is the one the rest of the file uses: a deadline is `S1TimeoutError`, and anything else keeps
   * its own type. There is no caller signal to give priority to here - neither probe accepts one - so the
   * cancellation branch of `#decideOnce` has no counterpart.
   */
  async #probe<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const guard = new AbortController();
    const timer = setTimeout(() => guard.abort(), S1_PROBE_TIMEOUT_MS);
    try {
      return await run(guard.signal);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw new S1TimeoutError(S1_PROBE_TIMEOUT_MS);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * GET /health — the readiness probe of Laya-style deployments.
   * Verified: `laya-serve` 0.3.21 exposes `/health` and `/v1/systemone` only.
   *
   * Bounded by `S1_PROBE_TIMEOUT_MS`, and a timeout is reported the way every other failure here is: as `false`.
   * This method has a boolean contract - it answers "is the backend there" - so nothing above it can act on the
   * difference between a refused socket, a black-holed one and a 500, and throwing would turn `/s1-ping`'s
   * "unreachable, and here is how long it took" into a command that fails with a stack. What the guard changes is
   * that "unreachable" is now also true of a socket that accepts a connection and then never answers.
   */
  async health(): Promise<boolean> {
    try {
      const res = await this.#probe((signal) => this.#fetch(`${this.#baseUrl}/health`, { signal }));
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * GET /v1/models — available on the hosted Jev deployment, not on `laya-serve`.
   *
   * Bounded by `S1_PROBE_TIMEOUT_MS`. Unlike `health()` this method throws, so a deadline is reported as
   * `S1TimeoutError` rather than folded into the `S1HttpError` family: the scorer above this client already branches
   * on that class to tell "too slow" from "refused" and from "cancelled" (`packages/dsh-plugin/src/s1-relevance.ts:229`
   * and its `timedOut`/`cancelled` counters at `:585-586`), and an empty list stays distinguishable from a backend
   * that never answered.
   */
  async models(): Promise<string[]> {
    const headers: Record<string, string> = {};
    if (this.#apiKey) headers.authorization = `Bearer ${this.#apiKey}`;
    const json = await this.#probe(async (signal) => {
      const res = await this.#fetch(`${this.#baseUrl}/v1/models`, { headers, signal });
      if (!res.ok) throw new S1HttpError(res.status, `models ${res.status}`);
      return (await res.json()) as { data?: { id?: string }[] } | string[];
    });
    if (Array.isArray(json)) return json;
    return (json.data ?? []).map((m) => m.id ?? '').filter(Boolean);
  }
}

/**
 * The server's own hint, when it gave one that parses as a delay in seconds.
 *
 * `Retry-After` also has an HTTP-date form; Laya does not send it, and parsing a date would be inventing a delay
 * rather than reading one, so an unparseable header is treated as absent.
 */
function parseRetryAfter(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const seconds = Number(raw.trim());
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : undefined;
}

/** The server's hint when there is one, the policy's fallback otherwise. */
function retryDelayMs(err: S1HttpError, policy: S1RetryPolicy | undefined): number {
  const fallback = policy?.fallbackDelayMs ?? 1000;
  if (policy?.respectRetryAfter === false) return fallback;
  return err.retryAfterMs ?? fallback;
}

/**
 * Copy the attempt bookkeeping onto a thrown error.
 *
 * Attached rather than wrapped on purpose: callers already branch on the error's type (`S1HttpError`,
 * `S1TimeoutError`, `S1CancelledError`), and a new wrapper type would make every one of those checks wrong in
 * order to keep the record right.
 */
function withAttempts<T>(err: T, attempts: number, waitedMs: number): T {
  if (err instanceof Error) {
    const target = err as Error & { attempts?: number; waitedMs?: number };
    target.attempts = attempts;
    target.waitedMs = waitedMs;
  }
  return err;
}

/** Sleep between attempts, but let the caller's cancellation end the wait instead of outliving it. */
function sleepAbortable(
  ms: number,
  signal: AbortSignal | undefined,
  attempts: number,
  waitedMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(withAttempts(new S1CancelledError(), attempts, waitedMs));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal === undefined) return;
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Probability normalization — Jev does not guarantee invariants (Σp may exceed 1). */
export function normalize(raw: Record<string, number>): Record<string, number> {
  const entries = Object.entries(raw).filter(([, v]) => Number.isFinite(v) && v > 0);
  const sum = entries.reduce((a, [, v]) => a + v, 0);
  if (entries.length === 0 || sum <= 0) {
    const ids = Object.keys(raw);
    const u = ids.length > 0 ? 1 / ids.length : 0;
    return Object.fromEntries(ids.map((id) => [id, u]));
  }
  return Object.fromEntries(entries.map(([id, v]) => [id, v / sum]));
}

// ---- question helpers (mirrors system-one-core's noul/choice/score) ----

export function noul(instructions: string, criteria?: { true: string; false: string }): NoulQuestion {
  return criteria ? { type: 'noul', instructions, criteria } : { type: 'noul', instructions };
}

export function choice(instructions: string, criteria: Record<string, string | null>): ChoiceQuestion {
  return { type: 'choice', instructions, criteria };
}

export function score(instructions: string, criteria: string[]): ScoreQuestion {
  return { type: 'score', instructions, criteria };
}

/** Jev input-only pricing. */
export function s1CostUsd(inputTokens: number, pricePerMInput = 0.042): number {
  return (inputTokens * pricePerMInput) / 1_000_000;
}
