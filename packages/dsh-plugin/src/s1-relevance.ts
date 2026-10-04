/**
 * S1 RELEVANCE — one question per *new* pair, batched `s1.questionsPerCall` to a request.
 *
 * This is the figure's "noul relevance" box: for a new segment s_j, decide how much reference value each
 * historical segment h_i carries for it, as a value in [0,1]. The question type is `noul` - a binary
 * "would retrieving this help?" whose P(true) is read straight as the weight - because that is what the
 * route diagram specifies (`relevance scoring (noul)`, `S1 Assoc Backend: noul relevance`). An earlier
 * implementation asked a graded 4-level `score` question and took the top level's probability mass; both
 * give a number in [0,1], but only the noul form is the thing under study, and the paper cannot describe a
 * box whose implementation asks a different question. The direction matters and is not symmetric - the
 * question is about h_i's usefulness *for s_j*, not about how similar the two strings are.
 *
 * The cost is the pair count, not the call count, and that was measured before anything here was changed.
 * A new segment s_j is paired with each of the `w` segments before it, and every one of those questions is
 * new: the graph scores each segment exactly once, in arrival order, so no pair it has already judged is asked
 * again - not within a session, and not after a restart, because the snapshot carries the `scored` cursor and
 * the `scores` map (`assoc-graph.ts`). Round `20261001-1300` confirms the arithmetic to the pair: the four cells
 * of that round offered 6 670, 4 278, 3 321 and 22 791 pairs for 116, 93, 82 and 214 segments, which is T(T-1)/2 in
 * every one of them, and each graph recorded exactly that many *distinct* pairs. One pair fewer than offered
 * would have meant a pair asked twice, because `scores` is keyed by pair; none of the four cells shows it. The
 * call count is that number divided by this cap, so C2's 22 791 pairs at 20 questions per call are the 1 155
 * calls it made (807 answered, 282 `503 server busy`, 66 at the transport guard, which was a fixed 30 s in that
 * round and is now `s1TransportGuardMs(batch)`; the 66 is a count under the old guard).
 *
 * **Corrected 2026-10-05: the identity above is not an invariant, and this paragraph was read as though it were.**
 * Round `20261004-0233` falsifies the generalization. Its C2 graph holds **2 211** `scores` rows - exactly
 * `67*66/2`, a complete triangle over segments 0-66 with no holes and nothing outside it - while `scoredPairs`
 * reads **10 157**, i.e. **4.59x** its distinct-pair content, and its control plane recorded **9 828 questions**
 * for those 2 211 pairs where a clean pass needs 144 calls. 486 of its 634 calls (77.5%) were re-asks of pairs the
 * graph already held. The fingerprint is in the call sequence: `q = 1,2,3,4, 2,3,4, 3,4, 4, 5,6,6, ...`, window
 * sizes repeated *downward*, where a single sweep is strictly ascending.
 *
 * The mechanism was concurrent sweeps, not the cap: `upkeep-queue.ts`'s `runOne` does not await its handler and
 * `step-observer.ts` drains every queued event synchronously, so a burst started N sweeps at once, and each sweep
 * copied the shared cursor **once at entry** and then wrote it forward per take. Overlapping walks scored the same
 * segment and either could move the cursor backward. Multiplicity tracked concurrency: 371 calls of exactly 20
 * questions against only 47 windows of >=20 pairs = 7.9, beside `admissionLimit: 8`. `scoreNew` now claims each
 * entry exclusively before its first `await`, so L in flight means L *distinct* segments and the cursor cannot
 * regress; a scale test at this round's exact shape reads **17 020 questions for 17 020 pairs (1.00x)**.
 *
 * The honest reading of round `20261001-1300`'s clean arithmetic is therefore "that round did not overlap", not
 * "overlap cannot happen" - and a reader who took the second meaning from this paragraph had no reason to look for
 * the duplicate work this round measured.
 *
 * What follows for the window, and it is the part a reader should take away: `recall.window = w` is the only
 * thing that bounds the marginal cost, and with w = 1024 against a 214-segment session it bounded nothing - the
 * window was the whole history, and the pair count is therefore quadratic in segments. **That is what the default
 * was changed for on 2026-10-05** (`recall.window` 1024 -> 16, `recall.depth` 2 -> 16: a window at or above the
 * session's segment count scores every pair; `docs/FORMULAS.md` section "Recall window w" carries the cost table).
 * The lever is w or the
 * cap, never a de-duplication of work that was never repeated. The client takes any number of questions in one
 * request, so the batching saves round trips and not questions; `scoredPairs` in the control plane counts the
 * pairs, and the graph is where that is decided.
 *
 * Failure policy: a System-1 call that errors or returns an answer we cannot read yields **no
 * weights**, and the graph's caller falls back to its lexical scorer. That is deliberate. A relevance backend
 * that is briefly unavailable must cost accuracy, never the round, and never a stack trace into the harness.
 *
 * "No weights" is the right answer only when asking again would not help, and a measured round says it often
 * would have. That round produced 281 `s1_call` records of which 191 failed: 97 x `TypeError: fetch failed` (a
 * backend that was not reachable), 57 x `S1TimeoutError` at the transport guard - a fixed 30 000 ms then, and the
 * guard has since become a function of the batch (`s1TransportGuardMs`), so the 57 is a count taken under a guard
 * that no longer exists and is not comparable with one taken now - and 37 x
 * `S1HttpError: systemone 503: {"detail":"server busy"}` - the server itself asking for less at a time. Every
 * one of those windows was scored lexically instead, and the round ended with **zero** `s1-noul` edges in the
 * whole graph: the fallback did not merely cost accuracy, it cost the entire System-1 signal.
 *
 * So a failure that a retry could plausibly clear (a 5xx, a 429, the transport timeout) is retried with an
 * exponential wait and a smaller batch, because the server said it was busy and the smaller request is the one
 * it can answer. A cancellation is never retried, and neither is a 4xx: those are statements about the request,
 * not about the server's load. Which failures were retried, and which windows were abandoned *after* retrying,
 * is counted in `S1RelevanceStats` rather than left silent - a retry nobody can see is how "the backend was
 * slow" stayed indistinguishable from "the backend was refusing" for a whole round.
 */
import {
  S1CancelledError,
  S1HttpError,
  S1TimeoutError,
  S1_RETRYABLE_STATUS,
  noul,
  normalize,
  s1TransportGuardMs,
} from '@s1cap/s1-client';
import type { NoulAnswer } from '@s1cap/s1-client';
import type { Segment, S1Deferral } from '@s1cap/core';
import { S1_DEFERRED } from '@s1cap/core';

import type { Backpressure } from './s1-backpressure.ts';

/**
 * How much of each segment is shown to the backend.
 *
 * It was 1200, and a measured run says that was the dominant cost: a batch of 14 questions carries the current
 * segment once plus one candidate each, so the request body was tens of thousands of characters and the median
 * call took **15.3 seconds** (mean 14.0 s, p90 25.0 s, max 29.0 s) against a warm 8-thread local backend. Those
 * numbers were invisible until the 2.5 s deadline was removed - before that the distribution was censored at
 * 2408 ms and every slower call was counted as a failure, which is how "S1 is cheap and fast" survived contact
 * with a live session for so long.
 *
 * 256 keeps a segment identifiable (kind, opening, and enough of the body to judge "would retrieving this help")
 * while cutting the prefill by roughly five times. The question is a coarse one - a noul head deciding whether a
 * candidate is worth retrieving - and a 1200-character tail of a tool result rarely changes that answer.
 */
const MAX_SEGMENT_CHARS = 256;

/**
 * How many times one request may be attempted before its window is abandoned: the original plus two retries.
 *
 * Three, because this scorer runs on the upkeep queue's critical path - the segment behind it waits - and because
 * the measured 503s were a server reporting itself busy, where a fourth attempt is a bet the third already lost.
 * A constant rather than a policy field, for the reason the transport guard is not one either - it is derived from
 * the batch the call already carries, never set: `s1.questionsPerCall` describes the workload and belongs to the
 * config, while how often a request is asked again is a property of the transport, and a knob there is a knob that
 * silently decides how much of a session is scored lexically.
 */
export const S1_RETRY_ATTEMPTS = 3;

/**
 * The first backoff wait; it doubles per attempt and is clamped by `S1_RETRY_MAX_DELAY_MS`.
 *
 * A second, not a millisecond: the failures this retries are a server saying "busy" (37 x 503 in the measured
 * round) or a request that died at the transport guard, where a wait shorter than a second is not long
 * enough to be a different question and a wait of many seconds is paid by the segment waiting behind it. How
 * long a busy local backend needs is **not measured** - this is the number to revisit if `retries` keeps firing
 * and `gaveUpAfterRetries` keeps rising. Deliberately deterministic, with no jitter: retries here are sequential
 * inside one window, and a test must be able to assert the schedule rather than sleep on it. Several sessions
 * retrying at once could synchronize on this schedule, which is unmeasured.
 */
export const S1_RETRY_BASE_DELAY_MS = 1_000;

/**
 * The ceiling on one backoff wait.
 *
 * Without it the schedule is 1 s, 2 s, 4 s, 8 s ..., so raising `S1_RETRY_ATTEMPTS` by one would buy minutes of
 * waiting per window instead of seconds. 1.5 s is below `2 x S1_RETRY_BASE_DELAY_MS`, on purpose: the clamp then
 * binds on the second wait of a default three-attempt run, so it is exercised by the tests instead of being a
 * branch nobody has ever taken.
 */
export const S1_RETRY_MAX_DELAY_MS = 1_500;

/**
 * The wall-clock a window may spend before its retries are refused, as the sum of the guards it will actually meet.
 *
 * It was `S1_RETRY_BUDGET_MS = 60_000`, a fixed number sized for the fixed 30 s guard: 30 + 1 s of backoff + 30 =
 * 61 s, so one retry of a timed-out request was the whole budget and a second was already refused. The guard is now
 * `s1TransportGuardMs(batch)` (`s1-client`), and a fixed budget against a batch-sized guard does not merely go
 * stale - it inverts per batch size. At 20 questions the guard is 35 s and one retry still fitted 60 s; at 40
 * questions a single timeout *was* 60 s, so the budget refused the retry outright; at 64 it was 90 s and exceeded
 * the budget before the first attempt had returned. One policy therefore meant "one retry" at this project's
 * default `questionsPerCall` (20, `types.ts`) and "no retry at all" at the sizes a saturated server produces, while
 * still reading as a configured bound.
 *
 * So the budget is the schedule it is meant to bound, added up: attempt 1 asks `q` questions and may hang for
 * `s1TransportGuardMs(q)`, the second asks `reducedBatchSize(q)` after one backoff wait, the third asks
 * `reducedBatchSize(reducedBatchSize(q))` after a second. No number here is chosen - the guards come from
 * `s1-client`, the attempt count and the waits come from this file, and the reduction is the same function the
 * retry uses - so the budget cannot describe a schedule the retry does not run:
 *
 * | questions | guard | + wait | half | + wait | quarter | budget |
 * |---|---|---|---|---|---|---|
 * | 20 (default) | 35 000 | 1 000 | 22 500 | 1 500 | 16 250 | 76 250 ms |
 * | 40 | 60 000 | 1 000 | 35 000 | 1 500 | 22 500 | 120 000 ms |
 * | 64 (server cap) | 90 000 | 1 000 | 50 000 | 1 500 | 30 000 | 172 500 ms |
 *
 * What it costs, at the sizes this project runs at. At 20 questions - the default - the timeout path does not move:
 * the old 60 s budget already admitted this whole schedule (35 + 1 + 22.5 = 58.5 s before the third attempt could
 * start), which is why the defect was invisible at the size the graph usually asks for. At 40 the old budget
 * refused the retry outright, so the worst case moves from a single 60 s timeout to the full 120 s schedule: the
 * window waits twice as long before falling back, and when the halved retry answers it is judged by the backend
 * instead of lexically. At 64 it moves from a single 90 s timeout to 172.5 s, 1.9x. That wait is paid only when the
 * backend is genuinely dead; a window whose backend is *refusing* (a 503 in tens of milliseconds) never reaches
 * this bound, because `S1_RETRY_ATTEMPTS` stops it first. The trade is the one the round above argues for - a
 * window that answers late is worth less than one that answers - and the bound the wait must not cross is the
 * upkeep queue's, which is why the budget is the schedule the attempt bound already allows and not more.
 *
 * The clock is the window's, from its first attempt (`started`), so what it measures includes the chunks of the
 * same window that answered. That is deliberate - the bound exists so one window cannot hold the upkeep queue - but
 * the residual is worth stating: a window whose earlier chunks were themselves slow can still find the budget spent
 * when a late chunk times out. At `perCall` 20 that is 76 s of earlier work, which at the measured ~3 s service
 * time is roughly 25 chunks, so it is the tail of a full 1024-candidate window and not the ordinary case. It is
 * also no longer reachable by a fresh window: the property this function exists to hold, and which the test beside
 * it asserts, is that the first timeout of a window plus the retry it entitles always fits.
 */
export function s1RetryBudgetMs(questionsPerCall: number): number {
  let size = Number.isFinite(questionsPerCall) ? Math.max(1, Math.trunc(questionsPerCall)) : 1;
  let total = 0;
  for (let attempt = 1; attempt <= S1_RETRY_ATTEMPTS; attempt += 1) {
    total += s1TransportGuardMs(size);
    if (attempt < S1_RETRY_ATTEMPTS) total += retryDelayMs(attempt);
    size = reducedBatchSize(size);
  }
  return total;
}

/** The wait before retry number `attempt` (1-based): the base doubled per attempt, clamped. */
function retryDelayMs(attempt: number): number {
  return Math.min(S1_RETRY_MAX_DELAY_MS, S1_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
}

/**
 * The size of the next request after a failed attempt at `asked`: half of what was actually asked, floor one.
 *
 * Named and shared, rather than written twice: `s1RetryBudgetMs` budgets the guards of the requests the retry
 * loop will actually send, and the retry loop sends whatever this function says. If the reduction changes, the
 * budget changes with it, because there is one reduction. The floor of 1 is the smallest request the protocol can
 * carry - a one-question request that failed is asked again at one question, not at zero.
 */
function reducedBatchSize(asked: number): number {
  return Math.max(1, Math.floor(asked / 2));
}

/**
 * Whether asking the same question again could plausibly get a different answer.
 *
 * Retryable: a 5xx (including the measured 503 "server busy"), a 429, and the transport timeout - all three say
 * the server could not serve *this request now*. Not retryable: a cancellation, which is the caller's decision
 * and must never be restarted; the other 4xx, which say the request was wrong and will still be wrong; and
 * anything unclassified. The measured `TypeError: fetch failed` (97 of them) falls in that last group - an
 * unreachable backend may well come back a second later, so this is a judgement and not a proof: retrying it
 * would add latency to every window of a round whose backend is simply not running, and the `failures` counter
 * plus the control-plane `s1_call` records are what would show it. If that evidence arrives, this is the line to
 * change. Errors are matched by class and `status`, never by message.
 *
 * The timeout is on this list, where `s1-client`'s own retry loop deliberately leaves it off: that loop re-sends
 * the request it just sent, "and repeating it costs the whole guard again". A retry here does not repeat it - the
 * request that comes back asks `reducedBatchSize` of the questions, so its guard is smaller with it (35 000 ms
 * becomes 22 500 ms at a default batch). That is a different, smaller question and not a blind repeat, which is
 * why the two policies differ rather than disagree; `s1RetryBudgetMs` above is what keeps the smaller request's
 * guard affordable instead of leaving the retry to be refused by a budget sized for the old fixed one.
 */
function isRetryable(err: unknown): boolean {
  if (err instanceof S1TimeoutError) return true;
  if (err instanceof S1HttpError) return err.status === 429 || err.status >= 500;
  return false;
}

export interface S1RelevanceOptions {
  decide(state: unknown, questions: Record<string, ReturnType<typeof noul>>, context?: { sessionId: string }): Promise<{
    answers: Record<string, { type?: string; noul?: unknown; probabilities?: Record<string, number>; confidence?: number }>;
    usage?: { input_tokens: number; output_tokens: number };
    ms?: number;
  } | undefined>;
  /** per-request question cap (policy: s1.questionsPerCall) */
  questionsPerCall?: number;
  onWarn?(message: string): void;
  /** injected for tests */
  now?(): number;
  /**
   * Injected for tests: the backoff wait between attempts. Production uses a real timer, because the wait exists
   * to let a busy server drain and a scorer that never actually waits would turn its retries into a second
   * request in the same instant - the load the 503 was complaining about.
   */
  sleep?(ms: number): Promise<void>;
  /**
   * The admission gate for the backend, when one is supplied.
   *
   * Without it this scorer asks for every window it is handed, one batch after another, and a saturated backend
   * answers `503` to most of them: round `20261002-2037` sent 5 992 requests at 2.70/s over 2 220 s and 64.4 %
   * were refused, because the upkeep queue does not await its async handler and several `scoreNew` loops were
   * therefore in flight at once. Retrying each refusal - which is what `retryAttempts` does, correctly, waiting
   * the server's own `Retry-After` - does not help against a backend that is refusing *everything*; it is one
   * more request inside the same admission window.
   *
   * With a gate, a request that cannot be admitted is not sent, and the window is handed back as `S1_DEFERRED` so
   * the graph defers it (`assoc-graph.ts`) instead of scoring it lexically: the pair is neither paid for nor lost,
   * and the omission is counted. See `s1-backpressure.ts` for the policy and its measured justification.
   */
  backpressure?: Backpressure;
}

export interface S1RelevanceStats {
  calls: number;
  /** questions rendered into requests, counting every attempt: a question that got no answer was still paid for */
  questions: number;
  inputTokens: number;
  outputTokens: number;
  lastMs: number;
  /**
   * Characters of segment text rendered into requests. The number that explains the latency: with 1200-character
   * segments a fourteen-question batch cost a median 15.3 s against a local backend, and a prefill nobody measured
   * is a prefill nobody can reduce.
   */
  promptChars: number;
  /** questions the backend answered with a usable weight, as opposed to questions that were sent */
  answeredQuestions: number;
  /** calls that ended in the transport guard rather than an answer, counted per attempt */
  timedOut: number;
  /** calls the caller cancelled, which is a cancellation and not a backend failure */
  cancelled: number;
  /** calls that produced no usable weight and were reported, counted per attempt */
  failures: number;
  /**
   * Requests re-sent after a retryable failure. This is the counter that separates "the backend was slow" from
   * "the backend was refusing": the measured round's 191 failures were invisible in aggregate, and a retry that
   * is not counted is a retry that hides the load it is working around.
   */
  retries: number;
  /** requests sent with fewer questions than the un-backed-off size, because the server asked for less at a time */
  reducedBatches: number;
  /**
   * Windows abandoned **after** retrying, because the attempts ran out or the retry budget was spent. Distinct
   * from `failures`: a window that fails once on a 4xx never asked twice, and only this counter tells the two
   * apart when reading `/s1` after a bad round.
   */
  gaveUpAfterRetries: number;
  /**
   * Windows the admission gate did not let through, so they were handed back to the graph as `S1_DEFERRED`.
   *
   * The number that separates "the backend answered badly" from "we stopped asking". Nothing was scored for
   * these windows in either direction - not by the backend and not by the fallback - so they are neither a
   * failure nor a judgement; the graph's `deferredPairs` is the same event counted in pairs.
   */
  blocked: number;
  /** of `blocked`, the ones held back because the cell's own in-flight budget was full */
  blockedByLimit: number;
  /** of `blocked`, the ones held back because the breaker was open after a run of refusals */
  blockedByBreaker: number;
  /** true once the gate has held anything back in this session */
  backpressured: boolean;
}

export interface S1Relevance {
  /**
   * Weights for `candidates`, in order. Returns `undefined` when no backend answered, which is the caller's
   * signal to use its fallback rather than to treat every pair as unrelated; returns `S1_DEFERRED` when the
   * backend is saturated and the window was not offered at all, which is the caller's signal to hold the pairs
   * for a later tick instead of buying them from the fallback.
   */
  (current: Segment, candidates: readonly Segment[]): Promise<readonly number[] | undefined | S1Deferral>;
  stats(): S1RelevanceStats;
}

/** A segment rendered for the backend: bounded, and labelled so the model can judge the pair it is shown. */
function render(segment: Segment): string {
  const text = segment.text.length > MAX_SEGMENT_CHARS
    ? `${segment.text.slice(0, MAX_SEGMENT_CHARS)}...`
    : segment.text;
  return `[${segment.kind}] ${text}`;
}

function readWeight(answer: { noul?: unknown; probabilities?: Record<string, number> } | undefined): number | undefined {
  if (answer === undefined) return undefined;
  // The noul answer *is* the weight: P("retrieving this would help") reduced to one number in [0,1]. A backend
  // that answers with a raw distribution over the criteria gets the same treatment - the true-side mass -
  // because the edge weight the graph consumes is a probability either way.
  if (typeof answer.noul === 'number' && Number.isFinite(answer.noul)) {
    return Math.max(0, Math.min(1, answer.noul));
  }
  if (answer.probabilities !== undefined && typeof answer.probabilities === 'object') {
    const normalized = normalize(answer.probabilities);
    for (const key of ['true', 'yes']) {
      const value = normalized[key] as number | undefined;
      if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.min(1, value));
    }
  }
  return undefined;
}

export function createS1Relevance(opts: S1RelevanceOptions): S1Relevance {
  const stats: S1RelevanceStats = {
    calls: 0,
    questions: 0,
    inputTokens: 0,
    outputTokens: 0,
    lastMs: 0,
    promptChars: 0,
    answeredQuestions: 0,
    timedOut: 0,
    cancelled: 0,
    failures: 0,
    retries: 0,
    reducedBatches: 0,
    gaveUpAfterRetries: 0,
    blocked: 0,
    blockedByLimit: 0,
    blockedByBreaker: 0,
    backpressured: false,
  };
  const perCall = Math.max(1, Math.trunc(opts.questionsPerCall ?? 16));
  const clock = opts.now ?? Date.now;
  const wait =
    opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  /** one line, not one per segment: "no backend" is a mode, and a mode repeated per segment is noise */
  let reportedNoClient = false;

  const scoreBatch = async (
    current: Segment,
    candidates: readonly Segment[],
  ): Promise<readonly number[] | undefined | S1Deferral> => {
    if (candidates.length === 0) return [];
    const started = clock();
    const out = new Array<number>(candidates.length).fill(0);

    // The window is covered in sequential batches, not truncated at the first one.
    //
    // The previous shape asked about `candidates[0 .. perCall-1]` and stopped, warning that "the rest is
    // unscored". Because the graph builds its candidate list oldest-first, that meant every segment past the
    // first twenty was measured against **the session's opening twenty segments** and never against its recent
    // neighbours: a live session showed 100% of its System-1 edges with an older endpoint in 0..19, exactly
    // twenty distinct older endpoints, and BFS anchors with no edges at all - recall then fell back to the
    // recency window, which reads as "the selector found nothing" and was in fact "the selector was never
    // asked". `w` is supposed to bound the System-1 *cost* of one segment (O(w) questions), not silently
    // redefine the window as twenty; splitting the same questions across several requests changes the number
    // of round trips and not the number of questions.
    let cursor = 0;
    // The request size for the rest of this window, and the one number a retry changes. It stays reduced instead
    // of being reset per chunk: a 503 is evidence that this server is busy *now*, so asking the next chunk of the
    // same window for a full `perCall` again would ask it to be busy again. The cost is round trips - a window
    // reduced twice pays up to four requests where it paid one - which is the trade the server asked for, and the
    // smaller requests are the ones with the small prefill, so it is not obviously a latency loss even when every
    // request answers.
    let requestSize = perCall;
    /**
     * The wall-clock this window may spend before its retries are refused, fixed once per window from its cap.
     *
     * From `perCall` and not from the chunk's own size, because no chunk of this window asks for more than the cap,
     * so the cap's schedule is the largest one the window can run and `s1RetryBudgetMs(perCall)` is the conservative
     * reading of it: the budget may not refuse a retry that a smaller first attempt would have afforded. See
     * `s1RetryBudgetMs` for the arithmetic and for what the bound is and is not.
     */
    const retryBudgetMs = s1RetryBudgetMs(perCall);
    /**
     * What each chunk resolved to, collected rather than acted on inside the attempt loop.
     *
     * The release of the admission slot, the "the whole window falls back" decision and the lexical hand-off can
     * all only be taken once the loop is over: the first because a slot has to be back in the gate before the
     * retry backoff, the others because they are properties of the *window* and not of one batch. Collecting the
     * chunks also lets the weights be written in candidate order at the end, which is what keeps a partial batch
     * from being misread as a full one. The weights are *validated* inside the attempt that produced them (see
     * `readWeight` at the answer site) - what is stored here is the reading, not the raw reply.
     */
    const batches: { batch: number[]; weights: (number | undefined)[] }[] = [];
    while (cursor < candidates.length) {
      // What this chunk would ask for with no back-pressure. It is the yardstick that keeps `reducedBatches`
      // meaning "smaller because the backend pushed back" rather than "smaller because the window ran out", which
      // is why the naturally short last chunk of a window is not counted.
      const natural = Math.min(perCall, candidates.length - cursor);
      let size = Math.min(requestSize, candidates.length - cursor);
      let batch: number[] = [];
      let answers: NonNullable<Awaited<ReturnType<S1RelevanceOptions['decide']>>>['answers'] | undefined;
      let deferredChunk = false;

      // The attempt loop: `attempt` is 1-based and the first pass is the original request, so a window that never
      // fails makes exactly the calls it made before this loop existed. Labelled because three different exits
      // inside it mean "this chunk is done" - the answer arrived, the gate refused the attempt, or the attempts ran
      // out - and a `break` that silently meant "next chunk" would be the way a judged window is dropped.
      retryLoop: for (let attempt = 1; ; attempt += 1) {
        batch = [];
        for (let i = cursor; i < candidates.length && batch.length < size; i += 1) batch.push(i);
        if (batch.length < natural) stats.reducedBatches += 1;

        // Admission, before a single question is rendered: the backend takes 16 requests at once and refuses the
        // rest, so a request that cannot be admitted this instant is not worth composing. A refusal here is not a
        // failure and is not retried - the window goes back to the graph as `S1_DEFERRED`, which holds the pairs
        // without scoring them lexically, and the next upkeep tick offers them again.
        //
        // It is checked per attempt rather than per batch, because a retry is a second request and is exactly what
        // the gate exists to ration. The wait between two attempts is `Retry-After`, which the gate does not
        // replace: `retryAttempts` still governs one refusal, and the gate governs a backend that refuses all of
        // them.
        //
        // One slot per *attempt*, not one per chunk. An earlier comment here claimed the slot was "acquired per
        // chunk and reused across its retries"; the variable it named was redeclared inside the attempt loop, so
        // the code has always taken a fresh slot per attempt - and that is the correct reading, because each
        // attempt is a separate request the backend must admit. What the comment hid is that the acquire sat
        // outside the block that released it (F16.3): a throw from `render(current)` or from the question
        // rendering below leaked the slot for the life of the process, with nothing counting leaks. Every exit
        // from here now either sends and is accounted for, or is handed back and counted.
        let admitted = false;
        // What the attempt did, in the three facts the gate needs: was a request sent, was it refused, and did it
        // come back with a reply. `answered` is what closes the breaker, and its limit is worth stating: it means
        // *a reply arrived for this request*, not that the window became a judgement - the weights are read after
        // the loop, and a reply with no usable weight counts here as a transport failure. That is the honest
        // reading of a per-request counter, and the scorer's own `failures` counter is what says which reply was
        // unusable.
        // The release itself is in the `finally` below, so no exit path can skip it.
        let sent = false;
        let refused = false;
        let answered = false;
        let retryDelay: number | undefined;
        try {
          if (opts.backpressure !== undefined) {
            const admission = opts.backpressure.tryAcquire();
            if (!admission.ok) {
              stats.blocked += 1;
              stats.backpressured = true;
              if (admission.reason === 'breaker-open') stats.blockedByBreaker += 1;
              else stats.blockedByLimit += 1;
              // Reported once per state change rather than once per window: the gate is a mode, and a line per
              // deferred window on a saturated backend is a log nobody reads.
              if (stats.blocked === 1 || stats.blocked % 50 === 0) {
                opts.onWarn?.(
                  `[s1cap] relevance: not asking (${admission.reason}); ${stats.blocked} window(s) held back so far. ` +
                    'Their pairs are reported as the graph\'s `deferredPairs` and are not scored lexically.',
                );
              }
              deferredChunk = true;
              break retryLoop;
            }
            admitted = true;
          }

          // Question ids are local to the request (`h0..hN`), because each batch is its own request; the prose keeps
          // the candidate's position in the window, so the model can still tell which part of the history it is
          // being asked about.
          // Rendered once per batch rather than once per question: it was called inside the loop, so a fourteen
          // question batch sliced the same 1200-character string fourteen times. More to the point, its length is the
          // number that explains a 15-second call, so it is counted and reported instead of being left to be guessed
          // at from a latency nobody can attribute.
          const stateText = render(current);
          // `state` is serialized once by the System-1 protocol. Repeating it inside every question made a
          // 20-candidate request carry 21 copies of the same current segment. Long tool traces exposed the cost:
          // one cell spent 28.96M lane tokens while only five context deliveries fired. Keep the state in the
          // request's state field and let each question carry only its candidate.
          stats.promptChars += stateText.length;
          const questions: Record<string, ReturnType<typeof noul>> = {};
          batch.forEach((candidateIndex, slot) => {
            const candidateText = render(candidates[candidateIndex] as Segment);
            stats.promptChars += candidateText.length;
            questions[`h${slot}`] = noul(
              `Does retrieving this candidate help answer or continue the current segment?\n\n` +
                `Candidate h${candidateIndex}:\n${candidateText}`,
              {
                true: 'retrieving the candidate would help with the current segment',
                false: 'the candidate is unrelated or a distraction',
              },
            );
          });
          // Counted here rather than after the answer, so a question that was sent and never answered is still part
          // of the spend: `answeredQuestions` is the subset that came back.
          stats.questions += batch.length;

          try {
            sent = true;
            const result = await opts.decide(
              // The state is the current segment: one System-1 call judges how useful the listed candidates are for
              // it, which is the direction the design asks for (h_i's reference value for s_j, not string overlap).
              { kind: current.kind, text: stateText },
              questions,
              { sessionId: current.sessionId },
            );
            // `undefined` is the caller saying there is no backend to ask - observation mode, or a provider that
            // resolved to `none`. That is a state and not a failure, so it is reported once instead of per segment;
            // and it is handled here rather than by a TypeError on `result.answers`, which is what it used to be.
            // It is also not retried: there is no endpoint to ask again.
            if (result === undefined) {
              // The gate was charged for a request that was never made: `decide` answered "there is no backend",
              // which it can do without touching the network (no client, or a provider resolved to `none`). That
              // is not an answered request, so it hands the slot back through `recordLeak`, which counts it -
              // keeping "the effective cap walked to zero with no stated cause" a number in `/s1` rather than a
              // silent leak.
              sent = false;
              if (!reportedNoClient) {
                reportedNoClient = true;
                opts.onWarn?.('[s1cap] relevance: no System-1 client is answering; windows are scored lexically');
              }
              return undefined;
            }
            // The backend answered this request, which is what closes the breaker: not a timer, and not a guess.
            // `answered` is the flag the gate reads; it means a reply arrived, and the weights are checked after
            // the loop - see the note beside the declaration.
            answers = result.answers;
            // A reply is only an *answer* once it carries a weight the graph can consume, and the check is here -
            // inside the attempt, before `break retryLoop` - because this is the last moment at which the gate can
            // still be told the truth about it. An empty body, a truncated one, a `noul` head that emitted prose:
            // the request left the cell and came back without a judgement, which is a transport failure and not a
            // success. Reading the weights here rather than after the loop also removes the second traversal that
            // used to do it; the early return runs the `finally` below like any other exit, so the slot is released
            // and the gate records `recordTransportFailure` for it (`answered` stays false).
            for (let slot = 0; slot < batch.length; slot += 1) {
              if (readWeight(answers?.[`h${slot}`] as Partial<NoulAnswer> | undefined) === undefined) {
                stats.failures += 1;
                opts.onWarn?.(
                  `[s1cap] relevance: no usable weight for candidate h${batch[slot]}; the whole window falls back`,
                );
                return undefined;
              }
            }
            answered = true;
            stats.calls += 1;
            stats.inputTokens += result.usage?.input_tokens ?? 0;
            stats.outputTokens += result.usage?.output_tokens ?? 0;
            stats.answeredQuestions += batch.length;
            break retryLoop;
          } catch (err) {
            stats.failures += 1;
            // Classified, because the three are different facts about a run: a dead socket, a cancelled session, and
            // a backend that answered something unusable. They used to arrive here as one TypeError.
            if (err instanceof S1TimeoutError) stats.timedOut += 1;
            else if (err instanceof S1CancelledError) stats.cancelled += 1;
            // What the gate is told, and why it is this narrow. A *refusal* - a retryable status, which is Laya's
            // `503 server busy` and the 429/gateway family - is the backend saying "not now", and a run of them is
            // the saturation the breaker exists for. A transport timeout is the opposite signal at the same
            // counter: the backend was working on the request for the whole transport guard, so pausing would add a
            // pause to a server that is merely slow. A cancellation is the caller's decision. Only the first is a
            // refusal. A
            // transport failure is neither, so it counts as the request having been sent and come back.
            refused = err instanceof S1HttpError && S1_RETRYABLE_STATUS.includes(err.status);

            const retryable = isRetryable(err);
            const elapsed = clock() - started;
            if (!retryable || attempt >= S1_RETRY_ATTEMPTS || elapsed >= retryBudgetMs) {
              // The attempt bound is named before the budget, because it is now possible for both to be true at the
              // same moment and only one of them to be the reason. The budget is the guard schedule those attempts
              // are allowed to run, so a window that times out on every one of them reaches `elapsed === budget`
              // exactly when `attempt` reaches `S1_RETRY_ATTEMPTS`; blaming the budget there would name a bound that
              // never fired. The counter is the same either way - `gaveUpAfterRetries` is one number - but the line
              // a human reads should say which bound stopped the window.
              const why = !retryable
                ? 'not retryable'
                : attempt >= S1_RETRY_ATTEMPTS
                  ? `all ${S1_RETRY_ATTEMPTS} attempts used`
                  : `the window's ${retryBudgetMs}ms retry budget is spent`;
              // A window abandoned *because it retried* is a different fact from one abandoned on its first failure:
              // the first says the backend kept refusing, the second says it was never asked twice. Both end in the
              // lexical fallback, and only this counter tells them apart afterwards.
              if (retryable) stats.gaveUpAfterRetries += 1;
              opts.onWarn?.(
                `[s1cap] relevance call failed at candidate ${cursor}/${candidates.length} (${why}; falling back to lexical scoring): ${String(err)}`,
              );
              return undefined;
            }

            stats.retries += 1;
            // Halve what was actually asked, not the window's cap: a two-question request that failed must come back
            // as one question rather than as eight, and the floor of 1 is the smallest request the protocol can
            // carry. The reduction sticks for the rest of the window (see `requestSize` above). It is
            // `reducedBatchSize` and not a halving written here, because `s1RetryBudgetMs` budgets the guards of
            // exactly this sequence and the two must not be able to disagree about what the sequence is.
            size = reducedBatchSize(batch.length);
            requestSize = size;
            retryDelay = retryDelayMs(attempt);
            opts.onWarn?.(
              `[s1cap] relevance call failed at candidate ${cursor}/${candidates.length} (retryable; retrying in ${retryDelay}ms with ${size} question${size === 1 ? '' : 's'}): ${String(err)}`,
            );
          }
        } finally {
          // The single release point for the slot taken above, on every exit that reaches the request: answered,
          // refused, abandoned, thrown. Released here so no exit path can skip it, and *classified* here, because
          // the three exits are three different facts about the backend and the gate used to be told only one of
          // them:
          //
          //   - `refused` (a retryable status - Laya's 503, the 429/5xx family): the backend said "not now". This
          //     is the saturation the breaker exists for, and a run of them opens it.
          //   - `answered` (a reply arrived - `sent`, not `refused`, and `result.answers` was read): the only thing
          //     that closes the breaker. A reply with no usable weight still counts here, because this release runs
          //     at the end of the *attempt* and the weights are checked after the loop; see the note beside the
          //     declaration.
          //   - everything else that left the cell: a transport timeout, `TypeError: fetch failed`, a cancellation,
          //     a reply with no usable weight. **This is the case that used to call `recordSuccess()`.** A dead
          //     backend then incremented `ok` once per call, cleared the refusal streak and closed the breaker, so
          //     the two failure kinds that dominated round `20261002-2037` after the 503s - 67
          //     `TypeError: fetch failed` - read as healthy on `/s1`, and the mechanism that exists to stop a cell
          //     hammering a backend was blind to them. `recordTransportFailure()` releases the slot and counts them
          //     without claiming the backend answered. Note the ordering limit: this release runs at the end of the
          //     *attempt*, so an unreadable reply is counted from here and not from the weight check after the loop.
          //   - nothing sent (`recordLeak`): the one case where no request left the cell at all.
          if (admitted) {
            if (sent) {
              if (refused) opts.backpressure?.recordRefusal();
              else if (answered) opts.backpressure?.recordSuccess();
              else opts.backpressure?.recordTransportFailure();
            } else {
              opts.backpressure?.recordLeak();
            }
          }
        }
        // The wait sits outside the `try`, so the slot a refused attempt was holding is back in the gate before
        // the backoff: a retry that waits while still counted as in flight would let one refused window exhaust a
        // budget meant for windows. No delay means the attempt settled this chunk - the answer arrived, the gate
        // refused, or the attempts ran out - and the chunk is done.
        if (retryDelay === undefined) break retryLoop;
        await wait(retryDelay);
      }

      // A chunk nobody was allowed to send is answered by the gate, and the answer is `S1_DEFERRED` whatever the
      // attempt: the backend is saturated, nothing was asked, and the graph must hold the pairs for a later tick
      // rather than buy them from the lexical scorer - otherwise declining work would raise the coverage ratio,
      // which is the hazard `deferredPairs` exists to make visible. A window whose *retry* was refused comes back
      // the same way, which is the ordering this module has always had: the refusal that prompted the retry is
      // still evidence that the backend is busy now.
      if (deferredChunk) return S1_DEFERRED;

      // The batch's weights, in slot order. Every one of them was checked in the attempt above, so no entry here
      // can be `undefined`; the type keeps the possibility because it is read from the same map the check reads.
      batches.push({
        batch,
        weights: batch.map((_candidateIndex, slot) =>
          readWeight(answers?.[`h${slot}`] as Partial<NoulAnswer> | undefined),
        ),
      });

      // All or nothing for the segment. A batch that answered while its neighbour timed out would leave some
      // pairs judged by the backend and others by the lexical scorer, and the graph would then hold two kinds of
      // number in one window without a per-pair record saying which - the exact confusion `ScoredPair.source`
      // exists to prevent. A segment whose backend did not answer is scored lexically, in full, and says so. The
      // retry above does not soften this: it either gets the whole window judged by the backend or hands the whole
      // window to the fallback, because half a window of backend weights is a window whose `source` record lies.
      //
      // Read back in chunk order so `out` is aligned by candidate index: a chunk that answered after a later one
      // failed still lands where the graph expects it.
      cursor += batch.length;
    }

    for (const chunk of batches) {
      // Every weight in every chunk was validated inside the attempt that produced it, so this traversal writes
      // the values out and cannot fail: `out` is aligned by candidate index, so a partial batch is impossible to
      // misread as a full one.
      for (let slot = 0; slot < chunk.batch.length; slot += 1) {
        out[chunk.batch[slot] as number] = chunk.weights[slot] as number;
      }
    }

    stats.lastMs = Math.max(0, clock() - started);
    // Aligned by candidate index, so a partial batch is impossible to misread as a full one.
    return out;
  };

  const relevance = scoreBatch as S1Relevance;
  (relevance as { stats?: unknown }).stats = () => ({ ...stats });
  return relevance;
}
