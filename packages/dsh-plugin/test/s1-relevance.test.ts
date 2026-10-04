/**
 * S1 RELEVANCE — the batch scorer and, more importantly, what it does when the backend is not there.
 *
 * The fallback is the part worth testing: a relevance backend that is down must cost accuracy, never the round.
 * Every test here drives the scorer directly with a fake `decide`, so no network and no clock are involved.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createS1Relevance,
  S1_RETRY_ATTEMPTS,
  S1_RETRY_BASE_DELAY_MS,
  S1_RETRY_MAX_DELAY_MS,
  s1RetryBudgetMs,
} from '../src/s1-relevance.ts';
import { S1CancelledError, S1HttpError, S1TimeoutError, s1TransportGuardMs } from '@s1cap/s1-client';
import { AssociationGraph } from '@s1cap/core';
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
    assert.ok(!q?.instructions?.includes(current.text), `${id}: the shared current segment is not repeated per question`);
  }
  assert.deepEqual(
    calls[0]?.state,
    { kind: current.kind, text: `[assistant] ${current.text}` },
    'the shared current segment is sent once as rendered state',
  );
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

test('a missing client yields no weights and is a state, not a failure', async () => {
  // This is the delegate the plugin installs when the backend resolves to `none`: `index.ts` answers `undefined`
  // from `decide` *before* it reaches for the client (`if (client === undefined) return undefined`), so a session
  // switched Off spends nothing and scores every window lexically. It has to be distinguishable from a backend
  // that was asked and did not answer: an Off session must not report failed calls or retries, or a researcher
  // reading the counters would conclude the backend was broken rather than switched off.
  const warnings: string[] = [];
  const relevance = createS1Relevance({ decide: async () => undefined, onWarn: (message) => warnings.push(message) });

  assert.equal(await relevance(current, candidates), undefined, 'no weights, so the caller scores lexically');
  const stats = relevance.stats();
  assert.equal(stats.calls, 0, 'nothing was called, so no call is counted');
  assert.equal(stats.failures, 0, 'and no failure is invented for a backend that was never configured');
  assert.equal(stats.retries, 0, 'there is no endpoint to ask again');
  assert.equal(stats.gaveUpAfterRetries, 0);
  assert.equal(stats.timedOut, 0);
  assert.equal(stats.answeredQuestions, 0);

  // Reported once per session rather than once per segment: "no backend" is a mode, and a mode repeated for every
  // window of a long run is noise that hides the one line that says why nothing was scored.
  await relevance(current, candidates);
  assert.equal(warnings.filter((w) => w.includes('no System-1 client')).length, 1, `got: ${warnings.join(' | ')}`);
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
    // times and would otherwise sleep through the backoff. The error carries the guard the client would really have
    // applied to a one-question request - `s1TransportGuardMs`, not the 30 000 ms fixed guard that no longer exists.
    sleep: async () => {},
    decide: async () => {
      throw new S1TimeoutError(s1TransportGuardMs(1));
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
  // 57 of the measured failures died at the transport guard - a fixed 30 000 ms in that round, and the guard has
  // since become `s1TransportGuardMs(batch)`, so the fake below throws the guard the client would really apply to
  // the request it was handed rather than a number from a guard that no longer exists. There is no evidence in a
  // dead socket that the *question* was wrong, so this one is retried - against the injected clock, so the guard is
  // asserted rather than waited.
  const sizes: number[] = [];
  const delays: number[] = [];
  const warnings: string[] = [];
  const clock = { t: 0 };
  const relevance = createS1Relevance({
    questionsPerCall: 2,
    now: () => clock.t,
    sleep: async (ms) => {
      delays.push(ms);
      clock.t += ms;
    },
    onWarn: (message) => warnings.push(message),
    decide: async (_state, questions) => {
      const asked = Object.keys(questions).length;
      sizes.push(asked);
      if (sizes.length === 1) {
        clock.t += s1TransportGuardMs(asked);
        throw new S1TimeoutError(s1TransportGuardMs(asked));
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
  // The `2` is this window's own cap, so the budget compared against is the one the window was actually given:
  // one guard plus its backoff is well inside it. This used to compare against `S1_RETRY_BUDGET_MS`, a fixed 60 s
  // that described a 30 s guard and has been replaced by the schedule it bounds.
  assert.ok(
    clock.t <= s1RetryBudgetMs(2),
    `a timed-out guard plus its backoff fits the window's own budget (clock ${String(clock.t)}ms)`,
  );
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
      // The guard for the two-question request this window asks, not a fixed 30 000 ms: the error's own number is
      // not asserted here, but a fake that names a guard the client cannot produce is a fake that hides a change.
      throw new S1TimeoutError(s1TransportGuardMs(2));
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
  // Each attempt is made to cost half the window's budget, which is the shape this bound exists for: the first
  // fits, the second overspends it, and a third is refused. Both the budget and the per-attempt cost are derived
  // from `s1RetryBudgetMs` rather than written as numbers, so this test cannot pass against a budget that has since
  // grown past its own arithmetic - it did pass against the fixed 60 s one, which is why the numbers were written
  // out here before.
  const perCall = 16;
  const attemptCostMs = Math.ceil(s1RetryBudgetMs(perCall) / 2);
  const attempts: number[] = [];
  const clock = { t: 0 };
  const relevance = createS1Relevance({
    questionsPerCall: perCall,
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms;
    },
    decide: async () => {
      attempts.push(clock.t);
      clock.t += attemptCostMs;
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

test('the retry budget is the guard schedule it bounds, so a bigger batch cannot silently lose its retry', async () => {
  // The defect this pins. `S1_RETRY_BUDGET_MS` was a fixed 60 000 ms sized for the fixed 30 s guard that
  // `s1-client` no longer has, and one policy then did three different things: at 20 questions a timeout was 35 s
  // and the whole schedule fitted (35 + 1 + 22.5 = 58.5 s), at 40 a single timeout *was* 60 s and the retry was
  // refused, and at 64 it was 90 s and exceeded the budget before the first attempt returned. The sizes where it
  // did nothing are the sizes a saturated server produces, and it did nothing while still reading as a configured
  // bound. `s1RetryBudgetMs` is now the sum of the guards the attempt schedule will actually meet, taken from the
  // client's `s1TransportGuardMs`, so the two cannot drift apart again.
  //
  // The expansion, written out from the client's own function rather than from this module's: guard(q), the first
  // backoff, guard(q/2), the second backoff, guard(q/4).
  assert.equal(
    s1RetryBudgetMs(20),
    s1TransportGuardMs(20) + S1_RETRY_BASE_DELAY_MS + s1TransportGuardMs(10) + S1_RETRY_MAX_DELAY_MS + s1TransportGuardMs(5),
    'the default batch size: 35 000 + 1 000 + 22 500 + 1 500 + 16 250 = 76 250 ms',
  );
  assert.equal(
    s1RetryBudgetMs(40),
    s1TransportGuardMs(40) + S1_RETRY_BASE_DELAY_MS + s1TransportGuardMs(20) + S1_RETRY_MAX_DELAY_MS + s1TransportGuardMs(10),
    'the size the old fixed budget refused outright: 120 000 ms',
  );
  assert.equal(
    s1RetryBudgetMs(64),
    s1TransportGuardMs(64) + S1_RETRY_BASE_DELAY_MS + s1TransportGuardMs(32) + S1_RETRY_MAX_DELAY_MS + s1TransportGuardMs(16),
    "the server's cap, where one guard was already past the old budget: 172 500 ms",
  );

  // The property that makes the budget a bound on the wait and not a second, hidden attempt limit: the first
  // timeout of a window, plus the backoff it schedules, plus the smaller request it entitles the window to, must
  // fit. The first of those two assertions is the one that fails against a fixed budget: at 40 questions the guard
  // alone is 60 000 ms, so `60 000 > 60 000 + 1 000` is false and no retry could have happened.
  for (const perCall of [1, 2, 5, 20, 40, 64]) {
    const budget = s1RetryBudgetMs(perCall);
    const firstGuard = s1TransportGuardMs(perCall);
    assert.ok(
      budget > firstGuard + S1_RETRY_BASE_DELAY_MS,
      `at ${perCall} questions one timeout plus its backoff must fit the budget (${String(firstGuard)} + ${String(S1_RETRY_BASE_DELAY_MS)} < ${String(budget)})`,
    );
    assert.ok(
      budget >= firstGuard + S1_RETRY_BASE_DELAY_MS + s1TransportGuardMs(Math.max(1, Math.floor(perCall / 2))),
      `and so must the halved request the retry will send at ${perCall} questions (budget ${String(budget)})`,
    );
    if (perCall > 1) {
      assert.ok(s1RetryBudgetMs(perCall) > s1RetryBudgetMs(perCall - 1), `the budget grows with the batch (${perCall})`);
    }
  }

  // And behaviourally, where the old fixed budget refused the retry: the real guard for the real batch, followed by
  // a backend that answers - twice, so the whole three-attempt schedule is exercised and the budget is the only
  // thing that could have stopped it.
  for (const perCall of [40, 64]) {
    const sizes: number[] = [];
    const clock = { t: 0 };
    const relevance = createS1Relevance({
      questionsPerCall: perCall,
      now: () => clock.t,
      sleep: async (ms) => {
        clock.t += ms;
      },
      decide: async (_state, questions) => {
        const asked = Object.keys(questions).length;
        sizes.push(asked);
        if (sizes.length < S1_RETRY_ATTEMPTS) {
          clock.t += s1TransportGuardMs(asked);
          throw new S1TimeoutError(s1TransportGuardMs(asked));
        }
        const answers: Record<string, { type: string; noul: number }> = {};
        for (const key of Object.keys(questions)) answers[key] = { type: 'noul', noul: 0.5 };
        return { answers };
      },
    });

    const many = Array.from({ length: perCall }, (_unused, i) => segment(`h${i}`, `candidate ${i}`));
    const weights = await relevance(current, many);
    assert.equal(weights?.length, perCall, `at ${perCall} questions a timeout costs a retry, not the window`);
    assert.ok(weights?.every((w) => w === 0.5), 'and every candidate is judged by the backend');
    assert.deepEqual(
      sizes.slice(0, S1_RETRY_ATTEMPTS),
      [perCall, Math.floor(perCall / 2), Math.floor(perCall / 4)],
      'the schedule the budget was written for: the whole batch, then half, then a quarter',
    );
    const stats = relevance.stats();
    assert.equal(stats.retries, S1_RETRY_ATTEMPTS - 1, 'every retry the attempt bound allows was affordable');
    assert.equal(stats.gaveUpAfterRetries, 0, 'and no window was abandoned by a budget it never reached');
    assert.equal(stats.timedOut, S1_RETRY_ATTEMPTS - 1, 'the injected timeouts are counted as timeouts');
    assert.equal(stats.answeredQuestions, perCall, 'the whole window was answered, in the reduced requests');
  }
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

test('a growing session costs the new pairs and nothing else, so the call count is T(T-1)/2 over the cap', async () => {
  // The measurement this pins, from round `20261001-1300`: C2 offered 22 791 pairs for its 214 segments, exactly
  // T(T-1)/2, and made 1 155 calls at 20 questions per call. The suspicion that motivated the check was that the
  // whole window is re-scored at every arrival, which would make the question count grow faster than T(T-1)/2.
  // It does not: the graph's cursor scores each segment once, so a pair is asked once. The test drives the real
  // scorer through the real graph, one arrival at a time as upkeep does, and reads the pair back out of the
  // rendered question - so a change that re-offered a pair would change the set, not merely a counter.
  const perCall = 4;
  const total = 16;
  const graph = new AssociationGraph();
  const questionsPerBatch: number[] = [];
  const pairs: string[] = [];
  const readPair = (state: unknown, instructions: string): string => {
    const currentMatch = /\[[^\]]*\] (text \d+)/.exec(String((state as { text?: unknown }).text));
    const candidateMatch = /Candidate h\d+:\n\[[^\]]*\] (text \d+)/.exec(instructions);
    return currentMatch === null || candidateMatch === null
      ? 'unreadable question'
      : `${String(candidateMatch[1])}->${String(currentMatch[1])}`;
  };
  const relevance = createS1Relevance({
    questionsPerCall: perCall,
    decide: async (state, questions) => {
      questionsPerBatch.push(Object.keys(questions).length);
      const answers: Record<string, { type: string; noul: number }> = {};
      for (const [id, question] of Object.entries(questions)) {
        answers[id] = { type: 'noul', noul: 0.9 };
        pairs.push(readPair(state, question.instructions));
      }
      return { answers };
    },
  });

  for (let i = 0; i < total; i += 1) {
    graph.addSegments([segment(`s${i}`, `text ${i}`)]);
    // `w` wider than the session, which is the measured shape: C2 ran at w = 1024 against 214 segments.
    await graph.scoreNew({ windowN: 1024, threshold: 0.55, scoreBatch: relevance });
  }

  const expectedPairs = (total * (total - 1)) / 2;
  let expectedCalls = 0;
  for (let j = 0; j < total; j += 1) expectedCalls += Math.ceil(j / perCall);

  const stats = graph.stats();
  assert.equal(stats.scoredPairs, expectedPairs, `T(T-1)/2 = ${String(expectedPairs)} pairs, each involving a new segment`);
  assert.equal(stats.judgedPairs, expectedPairs, 'the backend answered every window it was offered');
  assert.equal(pairs.length, expectedPairs, 'and the requests carried exactly that many questions');
  assert.equal(new Set(pairs).size, pairs.length, 'no pair was asked twice');
  assert.equal(relevance.stats().calls, expectedCalls, `the calls are the pairs over the cap: ${String(expectedCalls)}`);
  assert.deepEqual(
    questionsPerBatch.slice(0, 5),
    [1, 2, 3, 4, 4],
    'the early arrivals fit one call each; the fifth fills a batch of the cap and spills the remainder',
  );
  assert.equal(
    questionsPerBatch.reduce((sum, n) => sum + n, 0),
    expectedPairs,
    'the questions sent are the pair count: batching saves round trips and not questions',
  );
});

