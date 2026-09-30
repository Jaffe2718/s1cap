/**
 * S1 RELEVANCE — the batch scorer and, more importantly, what it does when the backend is not there.
 *
 * The fallback is the part worth testing: a relevance backend that is down must cost accuracy, never the round.
 * Every test here drives the scorer directly with a fake `decide`, so no network and no clock are involved.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createS1Relevance } from '../src/s1-relevance.ts';
import { S1CancelledError, S1TimeoutError } from '@s1cap/s1-client';
import type { Segment } from '@s1cap/core';

function segment(id: string, text: string): Segment {
  return { id, sessionId: 's', seq: 0, kind: 'assistant', tokens: 1, text, ts: 0 };
}

const current = segment('s1', 'the current task is to plot a distribution');
const candidates = [segment('h1', 'read the csv schema'), segment('h2', 'unrelated weather note')];

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
    decide: async () => {
      throw new S1TimeoutError(30_000);
    },
  });
  await timeouts(current, [segment('a', 'x')]);
  assert.equal(timeouts.stats().timedOut, 1, 'a dead socket is a timeout');
  assert.equal(timeouts.stats().cancelled, 0);

  const cancelled = createS1Relevance({
    decide: async () => {
      throw new S1CancelledError();
    },
  });
  await cancelled(current, [segment('a', 'x')]);
  assert.equal(cancelled.stats().cancelled, 1, 'a cancelled session is a cancellation');
  assert.equal(cancelled.stats().timedOut, 0);
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
