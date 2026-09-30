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
  ms: number;
  /** present only when the server reported it; see `S1Routing` */
  routing?: S1Routing;
}

export interface S1ClientOptions {
  baseUrl: string;
  apiKey?: string;
  model?: string;
  /** per-request timeout; on expiry a S1TimeoutError is thrown */
  timeoutMs?: number;
  /** injectable for tests */
  fetchImpl?: typeof fetch;
}

export class S1HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'S1HttpError';
    this.status = status;
  }
}

export class S1TimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`systemone request timed out after ${timeoutMs}ms`);
    this.name = 'S1TimeoutError';
  }
}

/** Known deployments live in `providers.ts` (one active backend at a time); re-exported here. */
export * from './providers.ts';
export * from './resolve.ts';

export class S1Client {
  #baseUrl: string;
  #apiKey: string | undefined;
  #model: string | undefined;
  #timeoutMs: number;
  #fetch: typeof fetch;

  constructor(opts: S1ClientOptions) {
    this.#baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.#apiKey = opts.apiKey;
    this.#model = opts.model;
    this.#timeoutMs = opts.timeoutMs ?? 2500;
    this.#fetch = opts.fetchImpl ?? fetch;
  }

  /** Evaluate any number of questions against one state in a single call. */
  async decide(state: unknown, questions: Record<string, S1Question>): Promise<S1DecideResult> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
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
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new S1HttpError(res.status, `systemone ${res.status}: ${body.slice(0, 200)}`);
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
      if (err instanceof Error && err.name === 'AbortError') throw new S1TimeoutError(this.#timeoutMs);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * GET /health — the readiness probe of Laya-style deployments.
   * Verified: `laya-serve` 0.3.21 exposes `/health` and `/v1/systemone` only.
   */
  async health(): Promise<boolean> {
    try {
      const res = await this.#fetch(`${this.#baseUrl}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }

  /** GET /v1/models — available on the hosted Jev deployment, not on `laya-serve`. */
  async models(): Promise<string[]> {
    const headers: Record<string, string> = {};
    if (this.#apiKey) headers.authorization = `Bearer ${this.#apiKey}`;
    const res = await this.#fetch(`${this.#baseUrl}/v1/models`, { headers });
    if (!res.ok) throw new S1HttpError(res.status, `models ${res.status}`);
    const json = (await res.json()) as { data?: { id?: string }[] } | string[];
    if (Array.isArray(json)) return json;
    return (json.data ?? []).map((m) => m.id ?? '').filter(Boolean);
  }
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
