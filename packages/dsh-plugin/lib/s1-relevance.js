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
import { S1CancelledError, S1HttpError, S1TimeoutError, noul, normalize } from '@s1cap/s1-client';
                                                   
                                           

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
function retryDelayMs(attempt        )         {
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
function isRetryable(err         )          {
  if (err instanceof S1TimeoutError) return true;
  if (err instanceof S1HttpError) return err.status === 429 || err.status >= 500;
  return false;
}

                                     
                                                                                       
                                                                                                                            
                                                            
                
     
                                                               
                            
                                 
                           
                 
     
                                                                                                                 
                                                                                                           
                                                                          
     
                                    
 

                                   
                
                                                                                                                   
                    
                      
                       
                 
     
                                                                                                                 
                                                                                                                   
                                    
     
                      
                                                                                                    
                            
                                                                                           
                   
                                                                                      
                    
                                                                                    
                   
     
                                                                                                               
                                                                                                                
                                                                        
     
                  
                                                                                                                    
                         
     
                                                                                                               
                                                                                                              
                                                
     
                             
 

                              
     
                                                                                                            
                                                                             
     
                                                                                             
                            
 

/** A segment rendered for the backend: bounded, and labelled so the model can judge the pair it is shown. */
function render(segment         )         {
  const text = segment.text.length > MAX_SEGMENT_CHARS
    ? `${segment.text.slice(0, MAX_SEGMENT_CHARS)}...`
    : segment.text;
  return `[${segment.kind}] ${text}`;
}

function readWeight(answer                                                                        )                     {
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
      const value = normalized[key]                      ;
      if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.min(1, value));
    }
  }
  return undefined;
}

export function createS1Relevance(opts                    )              {
  const stats                   = {
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
  };
  const perCall = Math.max(1, Math.trunc(opts.questionsPerCall ?? 16));
  const clock = opts.now ?? Date.now;
  const wait =
    opts.sleep ?? ((ms        ) => new Promise      ((resolve) => { setTimeout(resolve, ms); }));
  /** one line, not one per segment: "no backend" is a mode, and a mode repeated per segment is noise */
  let reportedNoClient = false;

  const scoreBatch = async (current         , candidates                    )                                         => {
    if (candidates.length === 0) return [];
    const started = clock();
    const out = new Array        (candidates.length).fill(0);

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
    while (cursor < candidates.length) {
      // What this chunk would ask for with no back-pressure. It is the yardstick that keeps `reducedBatches`
      // meaning "smaller because the backend pushed back" rather than "smaller because the window ran out", which
      // is why the naturally short last chunk of a window is not counted.
      const natural = Math.min(perCall, candidates.length - cursor);
      let size = Math.min(requestSize, candidates.length - cursor);
      let batch           = [];
      let answers                                                              ;

      // The attempt loop: `attempt` is 1-based and the first pass is the original request, so a window that never
      // fails makes exactly the calls it made before this loop existed.
      for (let attempt = 1; ; attempt += 1) {
        batch = [];
        for (let i = cursor; i < candidates.length && batch.length < size; i += 1) batch.push(i);
        if (batch.length < natural) stats.reducedBatches += 1;

        // Question ids are local to the request (`h0..hN`), because each batch is its own request; the prose keeps
        // the candidate's position in the window, so the model can still tell which part of the history it is
        // being asked about.
        // Rendered once per batch rather than once per question: it was called inside the loop, so a fourteen
        // question batch sliced the same 1200-character string fourteen times. More to the point, its length is the
        // number that explains a 15-second call, so it is counted and reported instead of being left to be guessed
        // at from a latency nobody can attribute.
        const stateText = render(current);
        const questions                                          = {};
        batch.forEach((candidateIndex, slot) => {
          const candidateText = render(candidates[candidateIndex]           );
          stats.promptChars += stateText.length + candidateText.length;
          questions[`h${slot}`] = noul(
            `Does retrieving this candidate help answer or continue the current segment?\n\n` +
              `Current segment:\n${stateText}\n\n` +
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
          const result = await opts.decide(
            // The state is the current segment: one System-1 call judges how useful the listed candidates are for
            // it, which is the direction the design asks for (h_i's reference value for s_j, not string overlap).
            { kind: current.kind, text: render(current) },
            questions,
          );
          // `undefined` is the caller saying there is no backend to ask - observation mode, or a provider that
          // resolved to `none`. That is a state and not a failure, so it is reported once instead of per segment;
          // and it is handled here rather than by a TypeError on `result.answers`, which is what it used to be.
          // It is also not retried: there is no endpoint to ask again.
          if (result === undefined) {
            if (!reportedNoClient) {
              reportedNoClient = true;
              opts.onWarn?.('[s1cap] relevance: no System-1 client is answering; windows are scored lexically');
            }
            return undefined;
          }
          answers = result.answers;
          stats.calls += 1;
          stats.inputTokens += result.usage?.input_tokens ?? 0;
          stats.outputTokens += result.usage?.output_tokens ?? 0;
          stats.answeredQuestions += batch.length;
          break;
        } catch (err) {
          stats.failures += 1;
          // Classified, because the three are different facts about a run: a dead socket, a cancelled session, and
          // a backend that answered something unusable. They used to arrive here as one TypeError.
          if (err instanceof S1TimeoutError) stats.timedOut += 1;
          else if (err instanceof S1CancelledError) stats.cancelled += 1;

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
          const delay = retryDelayMs(attempt);
          opts.onWarn?.(
            `[s1cap] relevance call failed at candidate ${cursor}/${candidates.length} (retryable; retrying in ${delay}ms with ${size} question${size === 1 ? '' : 's'}): ${String(err)}`,
          );
          await wait(delay);
        }
      }

      // All or nothing for the segment. A batch that answered while its neighbour timed out would leave some
      // pairs judged by the backend and others by the lexical scorer, and the graph would then hold two kinds of
      // number in one window without a per-pair record saying which - the exact confusion `ScoredPair.source`
      // exists to prevent. A segment whose backend did not answer is scored lexically, in full, and says so. The
      // retry above does not soften this: it either gets the whole window judged by the backend or hands the whole
      // window to the fallback, because half a window of backend weights is a window whose `source` record lies.
      for (let slot = 0; slot < batch.length; slot += 1) {
        const weight = readWeight(answers[`h${slot}`]                                   );
        if (weight === undefined) {
          stats.failures += 1;
          opts.onWarn?.(`[s1cap] relevance: no usable weight for candidate h${batch[slot]}; the whole batch falls back`);
          return undefined;
        }
        out[batch[slot]          ] = weight;
      }
      cursor += batch.length;
    }

    stats.lastMs = Math.max(0, clock() - started);
    // Aligned by candidate index, so a partial batch is impossible to misread as a full one.
    return out;
  };

  const relevance = scoreBatch               ;
  (relevance                       ).stats = () => ({ ...stats });
  return relevance;
}
