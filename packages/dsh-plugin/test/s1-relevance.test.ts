/**
 * S1 RELEVANCE — the batch scorer and, more importantly, what it does when the backend is not there.
 *
 * The fallback is the part worth testing: a relevance backend that is down must cost accuracy, never the round.
 * Every test here drives the scorer directly with a fake `decide`, so no network and no clock are involved.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createS1Relevance } from '../src/s1-relevance.ts';
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

test('the question cap is a stated limit, not a silent truncation', async () => {
  const warnings: string[] = [];
  const seen: string[][] = [];
  const relevance = createS1Relevance({
    questionsPerCall: 2,
    decide: async (_state, questions) => {
      seen.push(Object.keys(questions));
      return { answers: { h0: { type: 'noul', noul: 0.5 }, h1: { type: 'noul', noul: 0.5 } } };
    },
    onWarn: (message) => warnings.push(message),
  });

  const many = [segment('a', 'x'), segment('b', 'y'), segment('c', 'z')];
  const weights = await relevance(current, many);
  assert.deepEqual(seen, [['h0', 'h1']], 'only the cap is asked about in this call');
  assert.equal(weights?.length, 3, 'the result is still one weight per candidate');
  assert.equal(weights?.[2], 0, 'the unscored tail is zero, and that is why it is reported');
  assert.ok(warnings.some((w) => w.includes('questionsPerCall')), 'the truncation is stated');
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
