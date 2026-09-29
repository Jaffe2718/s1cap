/**
 * STATE PROXY T — the block that stands in for the raw trace.
 *
 * Three claims are worth pinning, because all three are the reason T is allowed to sit in the byte-stable head:
 * it is bounded by `tas.tMaxChars`, every line of it is derived from something that was actually said or
 * returned, and it does not change while the task does not.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildStateProxy } from '../src/state-proxy.ts';
import type { Segment, SegmentKind } from '../src/types.ts';

function seg(id: string, seq: number, kind: SegmentKind, text: string): Segment {
  return { id, sessionId: 'S', seq, kind, tokens: 1, text, ts: 1000 + seq };
}

/** The shape of a live session: the user's task, then everything the model did about it. */
function session() {
  return [
    seg('u1', 0, 'user', 'Fix the flaky test in auth.spec.ts and run the suite.'),
    seg('a1', 1, 'assistant', 'I will read the test and find the flakiness.'),
    seg('tc1', 2, 'toolCall', 'tool call: read\n{"path":"auth.spec.ts"}'),
    seg('tr1', 3, 'toolResult', 'auth.spec.ts: 84 lines. The test waits on a fixed 100ms timeout.'),
    seg('a2', 4, 'assistant', 'The wait is too short. I will replace it with a poll on the condition.'),
  ];
}

test('T states the task, what was done, and what the model said it would do next', () => {
  const segments = session();
  const text = buildStateProxy({ segments, anchorId: 'u1', maxChars: 8000, updatePolicy: 'perTask', now: 0 });

  assert.match(text, /^task: Fix the flaky test/);
  assert.match(text, /done:/, 'the section that stands in for the trace');
  assert.match(text, /ran: auth\.spec\.ts: 84 lines/, 'a tool result is rendered as something that ran');
  assert.match(text, /called: tool call: read/, 'and a tool call as something that was called');
  // "Next" must be the model's own most recent statement, quoted rather than paraphrased: a proxy that invented
  // an intent would be putting words in the model's mouth at the front of its own prompt.
  const tail = text.slice(text.indexOf('next:'));
  assert.ok(
    tail.includes('replace it with a poll'),
    `next must quote the model's last statement, got: ${tail}`,
  );
  assert.ok(!text.includes('I will read the test'), 'an earlier intent is superseded by the later one');
});

test('T is bounded by tMaxChars, and the bound holds even for a pathological anchor', () => {
  const short = buildStateProxy({
    segments: session(),
    anchorId: 'u1',
    maxChars: 400,
    updatePolicy: 'perTask',
    now: 0,
  });
  assert.ok(short.length <= 400, `T exceeded its ceiling: ${short.length}`);

  // A single enormous task line must not be able to push T past the budget it was given: T sits in front of
  // everything that varies, so an unbounded T would drag the whole prefix with it.
  const huge = buildStateProxy({
    segments: [seg('u1', 0, 'user', 'x'.repeat(50_000))],
    anchorId: 'u1',
    maxChars: 200,
    updatePolicy: 'perTask',
    now: 0,
  });
  assert.ok(huge.length <= 200, `T exceeded its ceiling on a huge anchor: ${huge.length}`);
});

test('an empty ceiling yields nothing rather than a one-token block', () => {
  // The assembler accounts an empty T as 0 tokens and a non-empty one as at least 1, so returning a placeholder
  // here would quietly inflate every budget number the paper reports.
  const text = buildStateProxy({
    segments: session(),
    anchorId: 'u1',
    maxChars: 0,
    updatePolicy: 'perTask',
    now: 0,
  });
  assert.equal(text, '');
});

test('a missing anchor yields nothing, because T describes a task it cannot name', () => {
  const text = buildStateProxy({
    segments: session(),
    anchorId: 'not-in-the-window',
    maxChars: 8000,
    updatePolicy: 'perTask',
    now: 0,
  });
  assert.equal(text, '');
});

test('T is a pure function of its inputs, which is what lets the caller memoize it per task', () => {
  const segments = session();
  const build = () => buildStateProxy({ segments, anchorId: 'u1', maxChars: 8000, updatePolicy: 'perTask', now: 0 });
  assert.equal(build(), build(), 'the same window must produce byte-identical text');
  // A later step in the same task changes what has been done, so T may change with the window - which is why the
  // memo is keyed by the anchor and `perTask` is what makes that key sufficient.
  const grown = [...segments, seg('a3', 5, 'assistant', 'Now I will run the suite.')];
  const next = buildStateProxy({ segments: grown, anchorId: 'u1', maxChars: 8000, updatePolicy: 'perTask', now: 0 });
  assert.notEqual(next, build());
  assert.ok(next.includes('run the suite'), 'and it follows the newest intent');
});
