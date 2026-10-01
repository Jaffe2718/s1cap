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
                            
                 
                
                  
 

                                 
                
                                    
                 
                                                                                             
             
                                                                  
                      
                                                                           
                   
                                                        
                   
 

/**
 * How a call may be re-attempted after the backend *refused* it.
 *
 * Explicit, and off unless the caller asks, because a hidden retry is a hidden policy: the caller is the one that
 * decides a judgement is worth another second. Only a refusal is retryable — Laya answers `503 server busy` with
 * `Retry-After` rather than queueing (docs/LAYA_RUNTIME.md §6b) — because repeating a refusal costs one wait while
 * repeating a 30 s timeout costs another 30 s.
 */
                                
                                                                     
                      
                                                                        
                              
                                                                          
                           
                                                                         
                     
 

                                  
                  
                  
                 
     
                                                                                                              
                                                                                                           
    
                                                                                                               
                                                                                                             
                                                                                                                
                                                     
     
                       
                                                                                              
                        
                             
                           
 

/**
 * The transport guard: how long one HTTP request may hang before it is treated as dead.
 *
 * Not a knob, and exported only so a test can advance a mocked timer to it instead of waiting. Measured calls
 * against a warm Laya server peak at ~2.4 s for a full batch of twenty questions, so 30 s is an order of
 * magnitude outside the distribution: it fires when a socket is dead, never when a model is merely thinking.
 */
export const S1_TRANSPORT_TIMEOUT_MS = 30_000;

/**
 * Statuses that mean "refused, come back", not "your request is wrong".
 *
 * 503 is the one that matters here — it is Laya's admission control. 429 and the two gateway statuses are the
 * same shape of answer from other deployments, and a 400/413/422 is a request the server will refuse again.
 */
export const S1_RETRYABLE_STATUS                    = [429, 502, 503, 504];

export class S1HttpError extends Error {
           status        ;
  /** the server's `Retry-After` as a delay in ms, when it sent one and it parses as seconds */
  retryAfterMs         ;
  /** attempts made before this was thrown (1 for a single attempt), set by the retry loop */
  attempts         ;
  /** total time spent waiting between those attempts, set by the retry loop */
  waitedMs         ;
  constructor(status        , message        , retryAfterMs         ) {
    super(message);
    this.name = 'S1HttpError';
    this.status = status;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

export class S1TimeoutError extends Error {
  constructor(timeoutMs        ) {
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
  constructor() {
    super('systemone request cancelled by the caller');
    this.name = 'S1CancelledError';
  }
}

/** Known deployments live in `providers.ts` (one active backend at a time); re-exported here. */
export * from './providers.js';
export * from './resolve.js';

export class S1Client {
  #baseUrl        ;
  #apiKey                    ;
  #model                    ;
  #fetch              ;
  #retry                           ;

  constructor(opts                 ) {
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
   * timeout — and neither is a cancellation, which is the caller's decision rather than a backend failure.
   */
  async decide(
    state         ,
    questions                            ,
    opts                           = {},
  )                          {
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
    state         ,
    questions                            ,
    opts                           = {},
  )                                                         {
    const started = Date.now();
    const guard = new AbortController();
    const timer = setTimeout(() => guard.abort(), S1_TRANSPORT_TIMEOUT_MS);
    // Two reasons to abort, kept distinguishable: our own transport guard, and the caller's cancellation. The
    // caller's signal wins the classification, because a cancelled session is not a slow backend.
    const signal =
      opts.signal === undefined ? guard.signal : AbortSignal.any([guard.signal, opts.signal]);
    try {
      const headers                         = { 'content-type': 'application/json' };
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

      const json = (await res.json())                           ;
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
        throw new S1TimeoutError(S1_TRANSPORT_TIMEOUT_MS);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * GET /health — the readiness probe of Laya-style deployments.
   * Verified: `laya-serve` 0.3.21 exposes `/health` and `/v1/systemone` only.
   */
  async health()                   {
    try {
      const res = await this.#fetch(`${this.#baseUrl}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }

  /** GET /v1/models — available on the hosted Jev deployment, not on `laya-serve`. */
  async models()                    {
    const headers                         = {};
    if (this.#apiKey) headers.authorization = `Bearer ${this.#apiKey}`;
    const res = await this.#fetch(`${this.#baseUrl}/v1/models`, { headers });
    if (!res.ok) throw new S1HttpError(res.status, `models ${res.status}`);
    const json = (await res.json())                                           ;
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
function parseRetryAfter(raw               )                     {
  if (raw === null) return undefined;
  const seconds = Number(raw.trim());
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : undefined;
}

/** The server's hint when there is one, the policy's fallback otherwise. */
function retryDelayMs(err             , policy                           )         {
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
function withAttempts   (err   , attempts        , waitedMs        )    {
  if (err instanceof Error) {
    const target = err                                                    ;
    target.attempts = attempts;
    target.waitedMs = waitedMs;
  }
  return err;
}

/** Sleep between attempts, but let the caller's cancellation end the wait instead of outliving it. */
function sleepAbortable(
  ms        ,
  signal                         ,
  attempts        ,
  waitedMs        ,
)                {
  return new Promise((resolve, reject) => {
    const onAbort = ()       => {
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
export function normalize(raw                        )                         {
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

export function noul(instructions        , criteria                                  )               {
  return criteria ? { type: 'noul', instructions, criteria } : { type: 'noul', instructions };
}

export function choice(instructions        , criteria                               )                 {
  return { type: 'choice', instructions, criteria };
}

export function score(instructions        , criteria          )                {
  return { type: 'score', instructions, criteria };
}

/** Jev input-only pricing. */
export function s1CostUsd(inputTokens        , pricePerMInput = 0.042)         {
  return (inputTokens * pricePerMInput) / 1_000_000;
}
