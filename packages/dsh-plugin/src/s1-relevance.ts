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
 * calls it made (807 answered, 282 `503 server busy`, 66 at the 30 s transport guard).
 *
 * What follows for the window, and it is the part a reader should take away: `recall.window = w` is the only
 * thing that bounds the marginal cost, and with w = 1024 against a 214-segment session it bounded nothing - the
 * window was the whole history, and the pair count is therefore quadratic in segments. The lever is w or the
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
 * backend that was not reachable), 57 x `S1TimeoutError` at the 30 000 ms transport guard, and 37 x
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
import { S1CancelledError, S1HttpError, S1TimeoutError, S1_RETRYABLE_STATUS, noul, normalize } from '@s1cap/s1-client';
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
 * A constant rather than a policy field, for the reason `S1_TRANSPORT_TIMEOUT_MS` is one: `s1.questionsPerCall`
 * describes the workload and belongs to the config, while how often a dead socket is asked again is a property of
 * the transport, and a knob there is a knob that silently decides how much of a session is scored lexically.
 */
export const S1_RETRY_ATTEMPTS = 3;

/**
 * The first backoff wait; it doubles per attempt and is clamped by `S1_RETRY_MAX_DELAY_MS`.
 *
 * A second, not a millisecond: the failures this retries are a server saying "busy" (37 x 503 in the measured
 * round) or a request that died at the 30 s transport guard, where a wait shorter than a second is not long
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
 * The wall-clock a single window may spend retrying, measured from its first attempt on `opts.now`.
 *
 * The transport guard is 30 s and the measured round had 57 calls that died at exactly 30 000 ms: at that price
 * the second attempt is already a minute, and a third is refused. The bound is on the whole window and not on one
 * wait, because what must not happen is a window holding the upkeep queue for minutes while it retries; a window
 * that answers late is worth less than one that answers. Fast failures (a 503 in tens of milliseconds) never
 * reach this bound - `S1_RETRY_ATTEMPTS` stops them first - so in practice this budget is the timeout path's.
 */
export const S1_RETRY_BUDGET_MS = 60_000;

/** The wait before retry number `attempt` (1-based): the base doubled per attempt, clamped. */
function retryDelayMs(attempt: number): number {
  return Math.min(S1_RETRY_MAX_DELAY_MS, S1_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
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
 */
function isRetryable(err: unknown): boolean {
  if (err instanceof S1TimeoutError) return true;
  if (err instanceof S1HttpError) return err.status === 429 || err.status >= 500;
  return false;
}

export interface S1RelevanceOptions {
  decide(state: unknown, questions: Record<string, ReturnType<typeof noul>>): Promise<{
    answers: Record<string, { type?: string; noul?: unknown; probabilities?: Record<string, number>; confidence?: number }>;
    usage?: { input_tokens: number; output_tokens: number };
    ms?: number;
  }>;
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
     * What each chunk resolved to, collected rather than acted on inside the attempt loop.
     *
     * The release of the admission slot, the "the whole window falls back" decision and the lexical hand-off can
     * all only be taken once the loop is over: the first because a slot has to be back in the gate before the
     * retry backoff, the others because they are properties of the *window* and not of one batch. Collecting the
     * chunks also lets the weights be read in candidate order at the end, which is what keeps a partial batch from
     * being misread as a full one.
     */
    const batches: { batch: number[]; answers: Awaited<ReturnType<S1RelevanceOptions['decide']>>['answers'] }[] = [];
    while (cursor < candidates.length) {
      // What this chunk would ask for with no back-pressure. It is the yardstick that keeps `reducedBatches`
      // meaning "smaller because the backend pushed back" rather than "smaller because the window ran out", which
      // is why the naturally short last chunk of a window is not counted.
      const natural = Math.min(perCall, candidates.length - cursor);
      let size = Math.min(requestSize, candidates.length - cursor);
      let batch: number[] = [];
      let answers: Awaited<ReturnType<S1RelevanceOptions['decide']>>['answers'] | undefined;
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
        // What the attempt did, in the two facts the gate needs: was a request sent, and was it refused. The
        // release itself is in the `finally` below, so no exit path can skip it.
        let sent = false;
        let refused = false;
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
            answers = result.answers;
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
            // counter: the backend was working on the request for 30 s, so pausing would add a pause to a server
            // that is merely slow. A cancellation is the caller's decision. Only the first is a refusal. A
            // transport failure is neither, so it counts as the request having been sent and come back.
            refused = err instanceof S1HttpError && S1_RETRYABLE_STATUS.includes(err.status);

            const retryable = isRetryable(err);
            const elapsed = clock() - started;
            if (!retryable || attempt >= S1_RETRY_ATTEMPTS || elapsed >= S1_RETRY_BUDGET_MS) {
              const why = !retryable
                ? 'not retryable'
                : elapsed >= S1_RETRY_BUDGET_MS
                  ? `the window's ${S1_RETRY_BUDGET_MS}ms retry budget is spent`
                  : `all ${S1_RETRY_ATTEMPTS} attempts used`;
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
            // carry. The reduction sticks for the rest of the window (see `requestSize` above).
            size = Math.max(1, Math.floor(batch.length / 2));
            requestSize = size;
            retryDelay = retryDelayMs(attempt);
            opts.onWarn?.(
              `[s1cap] relevance call failed at candidate ${cursor}/${candidates.length} (retryable; retrying in ${retryDelay}ms with ${size} question${size === 1 ? '' : 's'}): ${String(err)}`,
            );
          }
        } finally {
          // The single release point for the slot taken above, on every exit that reaches the request: answered,
          // refused, abandoned, thrown. `recordSuccess` on this path is not a claim that the backend answered -
          // `recordLeak` covers the one case where no request left the cell - it is the counter that says a
          // request in flight came back. A release that lived in the catch blocks could be skipped by a throw
          // between the acquire and the try, and nothing would have said so (F16.3).
          if (admitted) {
            if (sent) {
              if (refused) opts.backpressure?.recordRefusal();
              else opts.backpressure?.recordSuccess();
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

      batches.push({ batch, answers });

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
      for (let slot = 0; slot < chunk.batch.length; slot += 1) {
        const weight = readWeight(chunk.answers?.[`h${slot}`] as Partial<NoulAnswer> | undefined);
        if (weight === undefined) {
          stats.failures += 1;
          opts.onWarn?.(`[s1cap] relevance: no usable weight for candidate h${chunk.batch[slot]}; the whole batch falls back`);
          return undefined;
        }
        out[chunk.batch[slot] as number] = weight;
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
