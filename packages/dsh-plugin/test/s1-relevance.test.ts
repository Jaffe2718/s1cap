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
          h0: { type: 'score', score: 0.9 },
          h1: { type: 'score', score: 0.1 },
        },
      };
    },
  });

  const weights = await relevance(current, candidates);
  assert.equal(calls.length, 1, 'the window must cost exactly one System-1 call');
  assert.deepEqual(Object.keys(calls[0]?.questions ?? {}), ['h0', 'h1'], 'one question per candidate');
  assert.deepEqual(weights, [0.9, 0.1], 'weights stay aligned with candidate order');
});

test('a probability distribution is normalized into one number in [0,1]', async () => {
  const relevance = createS1Relevance({
    decide: async () => ({
      // Jev does not guarantee a sum of one, so the scorer normalizes before reading the top level.
      answers: { h0: { type: 'score', probabilities: { a: 6, b: 2, c: 2 } } },
    }),
  });
  const weights = await relevance(current, [candidates[0] as Segment]);
  assert.equal(weights?.length, 1);
  assert.equal(weights?.[0], 0.6, 'the top level mass, normalized');
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
      answers: { h0: { type: 'score', score: 0.9 } }, // h1 missing
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
      return { answers: { h0: { type: 'score', score: 0.5 }, h1: { type: 'score', score: 0.5 } } };
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
