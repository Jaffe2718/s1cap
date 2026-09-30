/**
 * S1 RELEVANCE — the batch scorer and, more importantly, what it does when the backend is not there.
 *
 * The fallback is the part worth testing: a relevance backend that is down must cost accuracy, never the round.
 * Every test here drives the scorer directly with a fake `decide`, so no network and no clock are involved.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createS1Relevance, S1_RETRY_ATTEMPTS, S1_RETRY_BASE_DELAY_MS, S1_RETRY_BUDGET_MS, S1_RETRY_MAX_DELAY_MS } from '../src/s1-relevance.ts';
import { S1CancelledError, S1HttpError, S1TimeoutError } from '@s1cap/s1-client';
import type { Segment } from '@s1cap/core';

function segment(id: string, text: string): Segment {
  return { id, sessionId: 's', seq: 0, kind: 'assistant', tokens: 1, text, ts: 0 };
}

const current = segment('s1', 'the current task is to plot a distribution');
const candidates = [segment('h1', 'read the csv schema'), segment('h2', 'unrelated weather note')];

/**
 * Answers whatever it is asked, with a weight derived from the candidate's own text, so a test can tell *which*
 * candidate a weight belongs to instead of trusting the position of a question id inside a retried request.
 */
function answerByCandidate(questions: Record<string, { instructions: string }>): Record<string, { type: string; noul: number }> {
  const answers: Record<string, { type: string; noul: number }> = {};
  for (const [id, question] of Object.entries(questions)) {
    answers[id] = { type: 'noul', noul: question.instructions.includes('read the csv schema') ? 0.9 : 0.1 };
  }
  return answers;
}

test('one call scores the whole window, and the weights come back aligned with the candidates', async () => {
  const calls: { state: unknown; questions: Record<string, unknown> }[] = [];
  const relevance = createS1Relevance({
    decide: async (state, questions) => {
      calls.push({ state, questions });
      return {
        answers: {
          h0: { type: 'noul', noul: 0.9 },
          h1: { type: 'noul', noul: 0.1 },
        },
      };
    },
  });

  const weights = await relevance(current, candidates);
  assert.equal(calls.length, 1, 'the window must cost exactly one System-1 call');
  assert.deepEqual(Object.keys(calls[0]?.questions ?? {}), ['h0', 'h1'], 'one question per candidate');
  assert.deepEqual(weights, [0.9, 0.1], 'weights stay aligned with candidate order');
  // The figure's box says `noul relevance`; this pins the question type, because a silent drift back to some
  // other answer shape would leave a paper claim about a box that no longer asks what the paper says.
  for (const id of ['h0', 'h1']) {
    const q = calls[0]?.questions[id] as { type?: string; instructions?: string; criteria?: { true: string; false: string } };
    assert.equal(q?.type, 'noul', `${id}: relevance asks a noul question`);
    assert.equal(typeof q?.criteria?.true, 'string', `${id}: the true criterion is stated`);
    assert.equal(typeof q?.criteria?.false, 'string', `${id}: the false criterion is stated`);
  }
});

test('a raw true/false distribution is read by its true-side mass', async () => {
  const relevance = createS1Relevance({
    decide: async () => ({
      // A backend that answers with an un-normalized distribution over the criteria: the true mass is P(useful).
      answers: { h0: { type: 'noul', probabilities: { true: 6, false: 2 } } },
    }),
  });
  const weights = await relevance(current, [candidates[0] as Segment]);
  assert.equal(weights?.length, 1);
  assert.equal(weights?.[0], 0.75, 'the true-side mass, normalized');
});

test('a failed call yields undefined rather than a row of zeros', async () => {
  // The distinction matters: zeros would be read as "nothing is relevant", which would silently discard the
  // whole window. `undefined` is the signal to fall back to the local scorer instead.
  const warnings: string[] = [];
  const relevance = createS1Relevance({
    decide: async () => {
      throw new Error('backend down');
    },
    onWarn: (message) => warnings.push(message),
  });

  const weights = await relevance(current, candidates);
  assert.equal(weights, undefined, 'no weights, so the caller falls back');
  assert.equal(relevance.stats().failures, 1, 'the failure is counted');
  // An error nobody classified - not a status, not the transport guard - is not evidence that asking again would
  // help, so it is asked once. `TypeError: fetch failed` (97 of them in the measured round) lands here too.
  assert.equal(relevance.stats().retries, 0, 'an unclassified error is not treated as retryable');
  assert.equal(relevance.stats().gaveUpAfterRetries, 0, 'and it did not give up after retrying, because it never retried');
  assert.ok(warnings.some((w) => w.includes('falling back')), 'and reported in words');
});

test('an unreadable answer also yields undefined, so a partial batch is never mistaken for a full one', async () => {
  const relevance = createS1Relevance({
    decide: async () => ({
      answers: { h0: { type: 'noul', noul: 0.9 } }, // h1 missing
    }),
  });
  const weights = await relevance(current, candidates);
  assert.equal(weights, undefined, 'one unreadable answer invalidates the batch rather than scoring it 0');
});

test('the window is covered in batches, so the cap costs round trips and not coverage', async () => {
  // This replaces a test that asserted the opposite, and the opposite was the defect. The scorer used to ask
  // about `candidates[0 .. perCall-1]` and stop, warning that "the rest is unscored" - so with the graph building
  // its candidate list oldest-first, every segment past the first twenty was measured against the session's
  // opening twenty segments and never against its recent neighbours. A live session showed it exactly: 100% of
  // its System-1 edges had an older endpoint in 0..19, and the later BFS anchors had no edges at all, so recall
  // fell back to the recency window. The cap bounds one request, not the window.
  const seen: string[][] = [];
  const relevance = createS1Relevance({
    questionsPerCall: 2,
    decide: async (_state, questions) => {
      seen.push(Object.keys(questions));
      const answers: Record<string, { type: string; noul: number }> = {};
      for (const key of Object.keys(questions)) answers[key] = { type: 'noul', noul: 0.5 };
      return { answers };
    },
  });

  const many = [segment('a', 'x'), segment('b', 'y'), segment('c', 'z')];
  const weights = await relevance(current, many);
  assert.deepEqual(
    seen,
    [['h0', 'h1'], ['h0']],
    'three candidates at a cap of two is two requests, not one request that quietly drops the third',
  );
  assert.deepEqual(weights, [0.5, 0.5, 0.5], 'and every candidate gets a weight, including the ones past the first request');
});

test('the rendered window is bounded, and how much of it was sent is reported', async () => {
  // The cost knob, pinned. With 1200-character segments a fourteen-question batch measured a median of 15.3 s
  // against a warm local backend - and that number only became visible once the 2.5 s deadline was removed, which
  // is why the bound is now small and why the characters sent are a statistic rather than a guess.
  const huge = 'x'.repeat(5000);
  let sent = '';
  const relevance = createS1Relevance({
    decide: async (_state, questions) => {
      sent = JSON.stringify(questions);
      const answers: Record<string, { type: string; noul: number }> = {};
      for (const key of Object.keys(questions)) answers[key] = { type: 'noul', noul: 0.5 };
      return { answers };
    },
  });

  await relevance(current, [segment('big', huge)]);
  assert.ok(sent.length < 4000, `the request stayed small (was ${String(sent.length)} characters)`);
  assert.ok(!sent.includes('x'.repeat(400)), 'and the candidate was truncated rather than sent whole');
  const stats = relevance.stats();
  assert.ok(stats.promptChars > 0, 'the characters rendered into the request are counted');
  assert.ok(stats.promptChars < 2000, `and the count matches the small request (was ${String(stats.promptChars)})`);
  assert.equal(stats.answeredQuestions, 1, 'answered questions are counted separately from questions sent');
  assert.equal(stats.timedOut, 0);
  assert.equal(stats.cancelled, 0);
});

test('a timeout and a cancellation are counted as themselves, not as one kind of failure', async () => {
  const timeouts = createS1Relevance({
    // Injected so the retries below cost no wall-clock time: a timeout is retryable, so this fake is asked three
    // times and would otherwise sleep through the backoff.
    sleep: async () => {},
    decide: async () => {
      throw new S1TimeoutError(30_000);
    },
  });
  await timeouts(current, [segment('a', 'x')]);
  // Three, not one: a timeout is retryable now, so a backend that always dies at the transport guard is asked
  // `S1_RETRY_ATTEMPTS` times. The classification this test is about is unchanged - every attempt is a timeout,
  // and none of them is a cancellation - which is exactly why the two are counted apart.
  assert.equal(timeouts.stats().timedOut, S1_RETRY_ATTEMPTS, 'a dead socket is a timeout, on every attempt');
  assert.equal(timeouts.stats().retries, S1_RETRY_ATTEMPTS - 1, 'and the retries it cost are visible');
  assert.equal(timeouts.stats().cancelled, 0);

  const cancelled = createS1Relevance({
    sleep: async () => {},
    decide: async () => {
      throw new S1CancelledError();
    },
  });
  await cancelled(current, [segment('a', 'x')]);
  assert.equal(cancelled.stats().cancelled, 1, 'a cancelled session is a cancellation');
  assert.equal(cancelled.stats().timedOut, 0);
  assert.equal(cancelled.stats().retries, 0, 'and it is never asked again');
});

test('a 503 is retried with a smaller batch, so a busy server costs a smaller request and not the window', async () => {
  // 37 of the measured 191 failures were exactly this: `systemone 503: {"detail":"server busy"}`. The server was
  // not broken, it was asking for less at a time, and the old policy answered by handing the whole window to the
  // lexical scorer. The retry asks about half the candidates, floor one question.
  const sizes: number[] = [];
  const delays: number[] = [];
  const relevance = createS1Relevance({
    sleep: async (ms) => {
      delays.push(ms);
    },
    decide: async (_state, questions) => {
      sizes.push(Object.keys(questions).length);
      if (sizes.length === 1) throw new S1HttpError(503, 'systemone 503: {"detail":"server busy"}');
      return { answers: answerByCandidate(questions) };
    },
  });

  const weights = await relevance(current, candidates);
  assert.deepEqual(weights, [0.9, 0.1], 'the window is still judged by the backend, and still in candidate order');
  assert.deepEqual(sizes, [2, 1, 1], 'the failed two-question request came back as a one-question request');
  const stats = relevance.stats();
  assert.equal(stats.retries, 1, 'the retry is counted');
  assert.equal(stats.reducedBatches, 1, 'and so is the request that was smaller than the window would have asked');
  assert.equal(stats.calls, 2, 'two requests were answered');
  assert.equal(stats.failures, 1, 'the failed attempt is still a failure');
  assert.equal(stats.gaveUpAfterRetries, 0, 'nothing was given up on');
  assert.equal(stats.answeredQuestions, 2, 'both candidates came back with a usable weight');
  assert.deepEqual(delays, [S1_RETRY_BASE_DELAY_MS], 'the retry waited one base backoff, not zero');
});

test('a transport timeout is retryable, and the retry is smaller because the request was the problem', async () => {
  // The other 57 failures died at the 30 000 ms guard. There is no evidence in a dead socket that the *question*
  // was wrong, so this one is retried - against the injected clock, so the 30 s is asserted rather than waited.
  const sizes: number[] = [];
  const delays: number[] = [];
  const warnings: string[] = [];
  const clock = { t: 0 };
  const relevance = createS1Relevance({
    now: () => clock.t,
    sleep: async (ms) => {
      delays.push(ms);
      clock.t += ms;
    },
    onWarn: (message) => warnings.push(message),
    decide: async (_state, questions) => {
      sizes.push(Object.keys(questions).length);
      if (sizes.length === 1) {
        clock.t += 30_000;
        throw new S1TimeoutError(30_000);
      }
      return { answers: answerByCandidate(questions) };
    },
  });

  const weights = await relevance(current, candidates);
  assert.deepEqual(weights, [0.9, 0.1], 'the timeout cost a retry, not the window');
  assert.deepEqual(sizes, [2, 1, 1], 'and the retry asked about fewer candidates');
  const stats = relevance.stats();
  assert.equal(stats.timedOut, 1, 'the timeout is still classified as a timeout');
  assert.equal(stats.retries, 1, 'and it is classified as retryable, which is what the retry count says');
  assert.equal(stats.cancelled, 0, 'a slow backend is not a cancelled session, and the two took different paths');
  assert.deepEqual(delays, [S1_RETRY_BASE_DELAY_MS]);
  assert.ok(
    warnings.some((w) => w.includes('retryable; retrying in')),
    'the line a human reads says the failure was retryable and what the retry will ask',
  );
  assert.ok(clock.t <= S1_RETRY_BUDGET_MS, `a retried 30 s timeout still fits the window budget (clock ${String(clock.t)}ms)`);
});

test('a cancelled session is never retried, and no retry counter moves', async () => {
  // A cancellation is the caller's decision, not the backend's state. Retrying it would keep paying for a session
  // the harness has already ended, and counting it as a retry would report a cancellation as load-shedding.
  let calls = 0;
  const delays: number[] = [];
  const relevance = createS1Relevance({
    sleep: async (ms) => {
      delays.push(ms);
    },
    decide: async () => {
      calls += 1;
      throw new S1CancelledError();
    },
  });

  const weights = await relevance(current, candidates);
  assert.equal(weights, undefined, 'a cancelled window has no weights, exactly as before');
  assert.equal(calls, 1, 'the backend was asked once and not again');
  assert.deepEqual(delays, [], 'and nothing was waited for, because nothing was scheduled');
  const stats = relevance.stats();
  assert.equal(stats.cancelled, 1);
  assert.equal(stats.retries, 0, 'a cancellation is not a retry');
  assert.equal(stats.reducedBatches, 0);
  assert.equal(stats.gaveUpAfterRetries, 0, 'and it is not a give-up after retrying either');
});

test('retries exhausted: the whole window goes to the fallback, and the give-up is counted as itself', async () => {
  const sizes: number[] = [];
  const relevance = createS1Relevance({
    sleep: async () => {},
    decide: async (_state, questions) => {
      sizes.push(Object.keys(questions).length);
      throw new S1HttpError(503, 'systemone 503: {"detail":"server busy"}');
    },
  });

  const weights = await relevance(current, candidates);
  assert.equal(weights, undefined, 'no partially filled window: either the backend judged it or the fallback does');
  assert.deepEqual(sizes, [2, 1, 1], `${String(S1_RETRY_ATTEMPTS)} attempts, each no larger than the one before`);
  const stats = relevance.stats();
  assert.equal(stats.failures, S1_RETRY_ATTEMPTS, 'every attempt is a failure of its own, and none is hidden by the retry');
  assert.equal(stats.retries, S1_RETRY_ATTEMPTS - 1, 'the retries that were spent are counted');
  assert.equal(stats.reducedBatches, 2, 'both retries asked about fewer candidates than the window would have');
  assert.equal(stats.gaveUpAfterRetries, 1, 'and the window that gave up after retrying is one number, not a silence');
  assert.equal(stats.answeredQuestions, 0, 'nothing was answered, so nothing is claimed as answered');
  assert.equal(stats.calls, 0, 'and no call is claimed to have succeeded');
});

test('the backoff doubles and is clamped, and the schedule is asserted instead of slept through', async () => {
  const delays: number[] = [];
  const relevance = createS1Relevance({
    sleep: async (ms) => {
      delays.push(ms);
    },
    decide: async () => {
      throw new S1TimeoutError(30_000);
    },
  });

  const wall = Date.now();
  await relevance(current, candidates);
  assert.deepEqual(
    delays,
    [S1_RETRY_BASE_DELAY_MS, S1_RETRY_MAX_DELAY_MS],
    'base, then the clamped double rather than twice the base',
  );
  // The clamp is only worth having if it binds, so this asserts that it does: the second wait asked the
  // exponential for `2 x base` and got the ceiling instead. Without the clamp the schedule is 1 s, 2 s, 4 s, ...
  // and raising the attempt bound by one would buy minutes of waiting per window instead of seconds.
  assert.ok(S1_RETRY_BASE_DELAY_MS * 2 > S1_RETRY_MAX_DELAY_MS, 'the clamp is below the uncapped second wait');
  assert.ok(delays.every((d) => d <= S1_RETRY_MAX_DELAY_MS), 'no wait exceeds the ceiling');
  assert.ok(delays.every((d) => d > 0), 'and no retry is a busy re-send into the load the 503 complained about');
  assert.ok(Date.now() - wall < 1_000, 'the injected wait is why the suite does not pay the backoff it asserts');
});

test('a window stops retrying once its retry budget is spent, so the upkeep queue is not held behind it', async () => {
  // Two attempts of 40 s each on the injected clock, plus the real backoff wait between them: the first fits
  // inside the 60 s budget, the second does not, and the third is refused. This is the bound that keeps one slow
  // segment from stalling the whole queue behind it.
  const attempts: number[] = [];
  const clock = { t: 0 };
  const relevance = createS1Relevance({
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms;
    },
    decide: async () => {
      attempts.push(clock.t);
      clock.t += 40_000;
      throw new S1HttpError(503, 'systemone 503: {"detail":"server busy"}');
    },
  });

  const weights = await relevance(current, candidates);
  assert.equal(weights, undefined);
  assert.equal(attempts.length, 2, 'the second attempt spent the budget, so there is no third');
  const stats = relevance.stats();
  assert.equal(stats.retries, 1, 'one retry was affordable');
  assert.equal(stats.gaveUpAfterRetries, 1, 'and the window that ran out of budget is counted like the one that ran out of attempts');
});

test('4xx is the request\'s problem and is not retried, while 429 is the server\'s and is', async () => {
  let malformed = 0;
  const bad = createS1Relevance({
    sleep: async () => {},
    decide: async () => {
      malformed += 1;
      throw new S1HttpError(400, 'systemone 400: bad request');
    },
  });
  await bad(current, candidates);
  assert.equal(malformed, 1, 'a request the server called malformed is not sent three times');
  assert.equal(bad.stats().retries, 0);
  assert.equal(bad.stats().gaveUpAfterRetries, 0, 'this window failed once; it did not give up after retrying');

  // 429 is the same statement as a 503 - not now, less at a time - so it sits on the retryable side of the line.
  let throttled = 0;
  const busy = createS1Relevance({
    sleep: async () => {},
    decide: async () => {
      throttled += 1;
      throw new S1HttpError(429, 'systemone 429: too many requests');
    },
  });
  await busy(current, candidates);
  assert.equal(throttled, S1_RETRY_ATTEMPTS, 'a throttle is retried up to the attempt bound');
  assert.equal(busy.stats().retries, S1_RETRY_ATTEMPTS - 1);
  assert.equal(busy.stats().gaveUpAfterRetries, 1);
});

test('an empty window costs nothing', async () => {
  let called = 0;
  const relevance = createS1Relevance({
    decide: async () => {
      called += 1;
      return { answers: {} };
    },
  });
  const weights = await relevance(current, []);
  assert.deepEqual(weights, []);
  assert.equal(called, 0, 'no candidates means no call at all');
});

test('the reported cost is the measured cost: usage and latency reach stats()', async () => {
  // The `s1_call` cost record reads these stats. If the client returns real token counts and a real duration,
  // stats() must carry them, or the per-call line would report zero spend for calls that cost something.
  // A call's cost is decided by the backend's usage and the client's timer, not by anything estimated here.
  const relevance = createS1Relevance({
    decide: async () => ({
      answers: { h0: { type: 'noul', noul: 0.8 }, h1: { type: 'noul', noul: 0.2 } },
      usage: { input_tokens: 1400, output_tokens: 2 },
      ms: 37,
    }),
  });
  await relevance(current, candidates);
  const stats = relevance.stats();
  assert.equal(stats.calls, 1, 'one call');
  assert.equal(stats.questions, 2, 'two questions');
  assert.equal(stats.inputTokens, 1400, 'backend-reported input tokens, not a guess');
  assert.equal(stats.outputTokens, 2, 'output tokens likewise');
});

test('the scorer is the returned value itself, not a method hanging off it', async () => {
  // This pins the shape that the plugin's wiring got wrong. `createS1Relevance` returns the batch function and
  // attaches `stats` to it, but index.ts called `relevance.scoreBatch(state, candidates)` - a property that does
  // not exist. The call threw `not a function` for every segment, the upkeep path caught it by design, and the
  // session reported a populated graph with zero edges, `scoredPairs: 0` and zero System-1 calls while every
  // other counter looked healthy. Nine real segments produced thirty-six uncounted pairs that way.
  //
  // No type checker runs in this repository (the build is `stripTypeScriptTypes` and `typescript` is not a
  // dependency), so a member that does not exist on the declared type ships silently. A test is the only place
  // left that can hold this contract.
  const relevance = createS1Relevance({ decide: async () => ({ answers: {} }) });
  assert.equal(typeof relevance, 'function', 'the returned scorer is callable');
  assert.equal(
    (relevance as unknown as { scoreBatch?: unknown }).scoreBatch,
    undefined,
    'there is no `.scoreBatch` member to call by mistake',
  );
  assert.deepEqual(await relevance(current, []), [], 'and it is callable directly, with an empty window costing nothing');
  assert.equal(typeof relevance.stats, 'function', 'stats hangs off the same function object');
});
