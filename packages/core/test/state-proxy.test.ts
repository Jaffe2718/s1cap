/**
 * STATE PROXY T — π(r_1,…,r_ntr): the model's own reasoning for this task, serialized.
 *
 * These pin the serializer, not a description of it. What is asserted is the artefact the paper defines: the
 * model's own text, verbatim and in source order, inside a fixed frame, bounded by `tas.tMaxChars`, with
 * nothing in it that the model did not say and nothing missing that it did.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildStateProxy } from '../src/state-proxy.ts';
import type { Segment, SegmentKind } from '../src/types.ts';

/** The fixed frame. Pinned as literals, not imported, so that changing a constant breaks a test. */
const INTRO = 'Reasoning trace for this task so far, in the order it was produced:';
const START = '<trace_start>';
const END = '<trace_end>';
const CUT = '[trace truncated]';

function seg(id: string, seq: number, kind: SegmentKind, text: string): Segment {
  return { id, sessionId: 'S', seq, kind, tokens: 1, text, ts: 1000 + seq };
}

/**
 * A live task: the user's request, then the model's own reasoning, then the environment, then its answer.
 *
 * The `trace` segment is deliberately multi-line with irregular indentation, because the failure this replaces
 * normalised whitespace: a proxy that flattens `/\s+/` to a single space cannot pass a verbatim check.
 */
function session(): Segment[] {
  return [
    seg('u1', 0, 'user', 'Fix the flaky test in auth.spec.ts and run the suite.'),
    seg('r1', 1, 'trace', 'Check whether the timeout is fixed or dynamic:\n  await wait(fn, 100);\nA fixed 100ms is the whole flake.'),
    seg('tc1', 2, 'toolCall', 'tool call: read\n{"path":"auth.spec.ts"}'),
    seg('tr1', 3, 'toolResult', 'auth.spec.ts: 84 lines. The test waits on a fixed 100ms timeout.'),
    seg('a1', 4, 'assistant', 'The wait is too short. I will replace it with a poll on the condition.'),
  ];
}

/** What the loop appends after the answer: the next step of the same task. */
const NEXT_STEP = seg('a2', 5, 'assistant', 'Now I will run the suite.');

function build(over: {
  segments?: Segment[];
  anchorId?: string;
  maxChars?: number;
  updatePolicy?: 'perTask' | 'perTurn';
} = {}): string {
  return buildStateProxy({
    segments: over.segments ?? session(),
    anchorId: over.anchorId ?? 'u1',
    maxChars: over.maxChars ?? 50_000,
    updatePolicy: over.updatePolicy ?? 'perTask',
    now: 0,
  });
}

test('T is the model’s own text, verbatim and in source order', () => {
  const text = build();
  // A distinctive multi-line substring, byte for byte: newlines and the leading double-space survive. Any
  // whitespace-flattening or first-line-clipping proxy fails here, which is the point.
  assert.ok(
    text.includes('Check whether the timeout is fixed or dynamic:\n  await wait(fn, 100);\nA fixed 100ms is the whole flake.'),
    `the trace must survive unmodified, got: ${JSON.stringify(text)}`,
  );
  // The visible answer a_j is inside π's input too, and it is not reduced to a "next:" line: the whole of it.
  assert.ok(
    text.includes('The wait is too short. I will replace it with a poll on the condition.'),
    `the answer must survive whole, got: ${text}`,
  );
  // Source order: reasoning before answer, and the run's whole text in one piece rather than interleaved.
  const atReasoning = text.indexOf('Check whether the timeout');
  const atAnswer = text.indexOf('The wait is too short');
  assert.ok(atReasoning >= 0 && atAnswer > atReasoning, `segments must appear in source order, got: ${text}`);
});

test('T is wrapped in a fixed frame — one intro line and the two paper delimiters, once each', () => {
  const text = build();
  assert.ok(text.startsWith(`${INTRO}\n${START}\n`), `unexpected frame head: ${text.slice(0, 120)}`);
  assert.ok(text.endsWith(`\n${END}`), `unexpected frame foot: ${text.slice(-40)}`);
  assert.equal(text.split(START).length - 1, 1, 'exactly one <trace_start>');
  assert.equal(text.split(END).length - 1, 1, 'exactly one <trace_end>');

  // π is held fixed across the window as well as across the placement conditions: a different session has to
  // come out under the same frame, or T would be a function of the task and not of a serializer.
  const other = build({
    segments: [seg('u9', 0, 'user', 'something else entirely'), seg('a9', 1, 'assistant', 'one line')],
    anchorId: 'u9',
  });
  assert.ok(other.startsWith(`${INTRO}\n${START}\n`));
  assert.ok(other.endsWith(`\n${END}`));
});

test('user text and tool traffic are the long context x, not the state', () => {
  const text = build();
  assert.ok(!text.includes('Fix the flaky test'), 'the task x is already in the prompt as the anchor');
  assert.ok(!text.includes('auth.spec.ts: 84 lines'), 'a tool result is evidence, not reasoning');
  assert.ok(!text.includes('tool call: read'), 'and neither is the call that fetched it');
});

test('nothing in T is templated: no task:/done:/ran:/called:/next: sections', () => {
  // The retired hand-written summary is exactly this, and it is what the paper does not describe.
  const text = build();
  assert.doesNotMatch(text, /^\s*(task|done|ran|called|next):/m, `T must not be a summary: ${text}`);
  assert.doesNotMatch(text, /^\s*-\s/m, 'and it must not be a bullet list either');
});

test('perTask freezes the serialisation: a later step cannot move the block', () => {
  const segments = session();
  // A tight ceiling so the cut is exercised — this is where the two policies are allowed to differ at all.
  const before = build({ segments, maxChars: 200, updatePolicy: 'perTask' });
  const after = build({ segments: [...segments, NEXT_STEP], maxChars: 200, updatePolicy: 'perTask' });
  assert.equal(after, before, 'perTask is a function of the trace prefix, so appending to the log cannot change it');
  assert.ok(!before.includes('run the suite'), 'and the frozen block does not grow into the next step');
});

test('perTask keeps the first characters of the trace, which is the paper’s direction', () => {
  const text = build({ maxChars: 200, updatePolicy: 'perTask' });
  assert.ok(text.includes('Check whether the timeout is fixed or dynamic:'), `kept the wrong end: ${text}`);
});

test('perTurn re-serialises each turn: the block follows the trace forward', () => {
  const segments = session();
  const before = build({ segments, maxChars: 200, updatePolicy: 'perTurn' });
  const after = build({ segments: [...segments, NEXT_STEP], maxChars: 200, updatePolicy: 'perTurn' });
  assert.notEqual(after, before, 'perTurn is re-serialised, so a longer trace gives a different block');
  assert.ok(after.includes('Now I will run the suite.'), 'and it keeps the newest reasoning rather than the oldest');
});

test('under the ceiling the two policies are the same text', () => {
  // The switch only has an observable effect once a task's trace outgrows tMaxChars. Recording that here keeps
  // the two tests above honest: neither is asserting a difference that only the ceiling creates.
  assert.equal(build({ updatePolicy: 'perTurn' }), build({ updatePolicy: 'perTask' }));
});

test('the ceiling holds, the cut is marked, and the closing delimiter survives it', () => {
  const text = build({ maxChars: 200 });
  assert.ok(text.length <= 200, `T exceeded its ceiling: ${text.length}`);
  assert.ok(text.includes(CUT), `a truncation this module performs must be labelled, got: ${text}`);
  assert.ok(text.endsWith(`\n${END}`), 'T stays a well-formed <trace_start>…<trace_end> block even when cut');

  // A single enormous run must not be able to push T past the budget it was given: T sits in front of
  // everything that varies, so an unbounded T would drag the whole prefix with it.
  const huge = build({
    segments: [seg('u1', 0, 'user', 'x'.repeat(50_000)), seg('r1', 1, 'trace', 'y'.repeat(200_000))],
    maxChars: 200,
  });
  assert.ok(huge.length <= 200, `T exceeded its ceiling on a huge trace: ${huge.length}`);
  assert.ok(huge.endsWith(`\n${END}`));
});

test('an empty ceiling, a missing anchor, and a task with no trace all yield the empty string', () => {
  // The assembler accounts an empty T as 0 tokens and a non-empty one as at least 1, so returning a placeholder
  // here would quietly inflate every budget number the paper reports.
  assert.equal(build({ maxChars: 0 }), '', 'a zero ceiling');
  assert.equal(build({ anchorId: 'not-in-the-window' }), '', 'no anchor to name the task by');
  assert.equal(build({ segments: [seg('u1', 0, 'user', 'just a question, no answer yet')] }), '', 'no trace text');
  assert.equal(
    build({
      segments: [
        seg('u1', 0, 'user', 'a question'),
        seg('tc1', 1, 'toolCall', 'tool call: read'),
        seg('tr1', 2, 'toolResult', 'some bytes'),
      ],
    }),
    '',
    'tool traffic alone is the long context, not a trace',
  );
  assert.equal(build({ maxChars: 50 }), '', 'a ceiling too small for the frame yields nothing, not a malformed block');
});

test('T is a pure function of its inputs and does not disturb them', () => {
  const segments = session();
  const before = JSON.stringify(segments);
  assert.equal(build({ segments }), build({ segments }), 'the same window must produce byte-identical text');
  assert.equal(JSON.stringify(segments), before, 'and the caller’s window must come back untouched');
});

test('hostile inputs return an empty string rather than throwing on the step’s critical path', () => {
  for (const maxChars of [Number.NaN, Number.NEGATIVE_INFINITY, -1, -999_999]) {
    assert.equal(build({ maxChars }), '', `maxChars=${String(maxChars)} must not throw`);
  }
});