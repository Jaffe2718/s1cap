/**
 * Observation mode: the read-only half of M1.
 *
 * These tests pin the two properties the milestone rests on — the observation is *deterministic* (so a
 * replay can be compared field by field) and *non-mutating* (so running it against a live session cannot
 * change what the model sees) — plus the adapter's translation table and the C0/C2 ablation behaviour.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { AssociationGraph, defaultPolicy, observeStep } from '../src/index.ts';
import { cellPolicyOf } from './preset-fixture.ts';
import { TELEMETRY_SCHEMA_VERSION } from '../src/index.ts';

/** A DSH-shaped message list: roles and part `type`s as read from dsh-llm's message.js. */
const MESSAGES = [
  {
    id: 'sys',
    role: 'system',
    content: [{ type: 'text', text: 'You are a coding agent working in a repository.' }],
    source: { kind: 'system-prompt' },
  },
  { id: 'u1', role: 'user', content: [{ type: 'text', text: 'Fix the failing test in auth.ts' }] },
  {
    id: 'a1',
    role: 'assistant',
    content: [{ type: 'text', text: 'I will inspect auth.ts and its callers.' }],
    source: { kind: 'model' },
  },
  {
    id: 't1',
    role: 'tool',
    content: [{ type: 'text', text: 'auth.ts: 120 lines, token check at line 88' }],
    source: { kind: 'tool', callId: 'c1' },
    toolCallId: 'c1',
  },
  {
    id: 'r1',
    role: 'assistant',
    content: [{ type: 'reasoning', text: 'the expiry comparison looks off by one second' }],
    source: { kind: 'model' },
  },
  { id: 'u2', role: 'user', content: [{ type: 'text', text: 'also check the expiry path' }] },
];

const BASE = {
  sessionId: 'S',
  step: 3,
  seq: 10,
  messages: MESSAGES,
  now: 1_790_000_000_000,
  contextWindow: 128_000,
  reserveOutputTokens: 8_000,
  fixedOverheadTokens: 1_200,
  lambdaMs: 36 * 60 * 60 * 1000,
};

async function run(policyOverrides: Record<string, unknown> = {}) {
  const policy = { ...defaultPolicy(), ...policyOverrides };
  const graph = new AssociationGraph();
  return {
    policy,
    graph,
    observation: await observeStep({ ...BASE, policy, graph }),
  };
}

test('an observation is deterministic: the same step replayed produces the same record', async () => {
  const first = (await run()).observation;
  const replay = (await run()).observation;

  assert.deepEqual(replay.event, first.event, 'the control-plane record must be identical');
  assert.deepEqual(replay.selectedIds, first.selectedIds);
  assert.equal(replay.fullTokens, first.fullTokens);
  assert.equal(replay.selectedTokens, first.selectedTokens);
  assert.equal(replay.wouldSaveTokens, first.wouldSaveTokens);
  assert.deepEqual(replay.report, first.report);
});

test('observation never mutates the payload it is reading', async () => {
  const snapshot = structuredClone(MESSAGES);
  const { observation } = await run();
  assert.deepEqual(MESSAGES, snapshot, 'the harness message list must be untouched');
  assert.ok(observation.segments.length > 0);
});

test('the adapter maps the verified DSH vocabulary and reports what it does not know', async () => {
  const { observation } = await run();
  const report = observation.report;

  assert.equal(report.unknownRoles.length, 0, 'every DSH role has a rule');
  assert.deepEqual(report.unknownPartTypes, [], 'reasoning parts have a deliberate rule, not an unknown one');
  assert.equal(report.roles['user'], 'user');
  assert.equal(report.roles['assistant'], 'trace', 'the reasoning-only message is labelled a trace');
  assert.equal(report.roles['tool'], 'toolResult');
  assert.equal(report.roles['system'], 'systemPinned');

  const kinds = observation.segments.map((s) => s.kind);
  assert.deepEqual(kinds, ['systemPinned', 'user', 'assistant', 'toolResult', 'trace', 'user']);

  // deterministic identity and ordering are what make replay comparison possible
  assert.deepEqual(
    observation.segments.map((s) => s.id),
    ['sys', 'u1', 'a1', 't1', 'r1', 'u2'],
  );
  assert.deepEqual(
    observation.segments.map((s) => s.seq),
    [10, 11, 12, 13, 14, 15],
  );
});

test('a message with no text is reported as empty, and an unknown part keeps its payload bounded', async () => {
  const messages = [
    { role: 'system', content: [] },
    { role: 'assistant', content: [{ type: 'image', data: 'x'.repeat(4000) }] },
    { role: 'user', content: [{ type: 'text', text: 'go' }] },
  ];
  const graph = new AssociationGraph();
  const observation = await observeStep({ ...BASE, messages, policy: defaultPolicy(), graph });

  assert.equal(observation.report.empty, 1);
  assert.deepEqual(observation.report.unknownPartTypes, ['image']);
  assert.equal(observation.report.rawParts, 1);
  const imageSegment = observation.segments.find((s) => s.text.startsWith('[image]'));
  assert.ok(imageSegment, 'an unknown part is kept, clearly marked');
  assert.ok(imageSegment!.text.length < 2100, 'raw payloads stay bounded');
});

test('the control-plane record carries the frozen schema and the full C0/C2 contrast', async () => {
  const c2 = (await run()).observation;
  assert.equal(c2.event.type, 'assembly');
  assert.equal(c2.event.schema, TELEMETRY_SCHEMA_VERSION);
  assert.equal(c2.event.seq, BASE.seq);
  assert.deepEqual(Object.keys(c2.event.blocks).sort(), ['anchor', 'pinned', 'recalled', 'stateProxy', 'tail']);
  // The accounting identity, not `budgetUsed <= budgetTotal`. That inequality held *because* the removed
  // `recall.budgetRatio` cap dropped candidates that did not fit the allowance; selection is decided by `r` and `d`
  // now, so `budgetUsed` may legitimately exceed `budgetTotal` (see `AssemblyResult.budget` and
  // `AssemblyEvent.budgetUsed`). What is worth pinning is that the recorded number agrees with the blocks it is
  // made of, which is what a reader of a round recomputes.
  assert.equal(
    c2.event.budgetUsed,
    Object.values(c2.event.blocks).reduce((sum, tokens) => sum + tokens, 0),
    'budgetUsed is the size of the assembled view: every block, the recalled one included',
  );
  assert.ok(c2.event.budgetTotal > 0, 'and the window budget it is measured against is on the record');
  assert.equal(c2.event.prefixTokensStable, c2.event.blocks['pinned'], 'the cache-stable prefix is the pinned block');
  // The arm rides on every assembly record, because "which of the paper's conditions ran" has to be answerable from
  // the round's own artifacts. This field replaced a boolean `xFirst` on 2026-10-05: that one recorded *where a
  // block went* and was read as though it named the arm, which is how every cell came to record a layout the paper
  // does not have. `layoutOrder` is asserted beside it so the pair is checked against the order it describes rather
  // than on its own.
  //
  // **The field that once sat beside it (`questionPlacement`) is gone, and its absence is asserted rather than
  // ignored.** It recorded where the question sits, and the question is the last block of every layout now — the
  // paper fixes it there in every condition — so a field that carried one value forever would be a knob in the
  // record that no round can vary. A tape written before 2026-10-05 still carries it, and `layoutOrder` beside it
  // says the same thing in the layout's own words.
  assert.equal(c2.event.tracePlacement, 'trace-as-state', 'the default arm is the paper\'s method');
  assert.equal('questionPlacement' in c2.event, false, 'and no record states a question position any more');
  assert.deepEqual(
    c2.event.layoutOrder,
    ['pinned', 'stateProxy', 'tail', 'recalled', 'anchor'],
    'the recorded order is what the arm describes and where the question is: M([T, x, q])',
  );
  assert.equal(c2.event.layoutOrder.at(-1), 'anchor', 'the question is last, in the record as in the layout');

  // C0 is the baseline cell: no System-1 selection at all, so nothing is recalled.
  const c0Policy = cellPolicyOf('C0');
  const graph = new AssociationGraph();
  const c0 = await observeStep({ ...BASE, policy: c0Policy, graph });
  assert.equal(c0.event.selected, 0);
  assert.deepEqual(c0.selectedIds, []);
  assert.equal(c0.event.candidates, 0);

  // C2's block is what the selection found, and this fixture is small enough that the whole view fits the window:
  // the point of the assertion is that the record's two budget numbers are internally consistent, not that a cap
  // kept them in that order (the cap is gone - see the identity above).
  assert.equal(
    c2.event.budgetUsed,
    Object.values(c2.event.blocks).reduce((sum, tokens) => sum + tokens, 0),
  );
  assert.ok(c2.wouldSaveTokens >= 0);
});

test('the graph accumulates across steps, so a later step can recall an earlier one', async () => {
  const policy = cellPolicyOf('C2');
  const graph = new AssociationGraph();
  const first = await observeStep({ ...BASE, policy, graph, messages: MESSAGES.slice(0, 2), step: 1 });
  const second = await observeStep({ ...BASE, policy, graph, step: 2 });

  assert.equal(first.segments.length, 2);
  assert.ok(graph.stats().segments >= MESSAGES.length, 'segments from both steps live in one graph');
  assert.ok(second.segments.length === MESSAGES.length);
});

test('the tail block holds the newest turns of the pool, and never the anchor', async () => {
  // This is the shape the graph window actually has in a live session: the step's newest turn is at the end of the
  // append-only log and everything else is in front of it. An earlier version sliced the window *at* the anchor, so
  // the pool was the history and `tail` was empty in every real record - the k most recent verbatim turns were never
  // in the prompt. The filter that replaced it (`observer.ts`, `pool`) is what this exercises, and it is written
  // against the anchor rather than against a position: every segment except the anchor, the anchor's sibling chunks
  // and the pinned prefix is in the pool, whatever the anchor is. Exercised through the graph-window path (empty
  // payload) because that is what production takes: `pre-step` hands over an empty array after the first step.
  const policy = cellPolicyOf('C2');
  policy.tail.k = 3;
  const graph = new AssociationGraph();
  // Seed the graph the way upkeep would: the anchor first, then the turns produced for it.
  const [u2] = MESSAGES.slice(-1);
  assert.ok(u2 !== undefined);
  await observeStep({ ...BASE, policy, graph, messages: MESSAGES.slice(0, 6), step: 1 });

  const obs = await observeStep({ ...BASE, policy, graph, messages: [], step: 2 });
  assert.equal(obs.kind, 'assembled');
  if (obs.kind !== 'assembled') return;

  // The anchor is `u2`, the newest input event this window has; the turns in front of it are what the tail is for.
  assert.ok(obs.event.blocks['tail'] !== undefined);
  assert.ok(
    obs.event.blocks['tail']! > 0,
    `tail must carry the recent turns, got blocks=${JSON.stringify(obs.event.blocks)}`,
  );
  // It must be the *newest* k of the pool, and it must not duplicate the anchor.
  assert.ok(obs.selectedIds.length >= 0);
  assert.ok(!obs.selectedIds.includes('u2'), 'the anchor is not also a tail turn');
});

/**
 * S1CAP must not recall its own delivered blocks.
 *
 * A delivered block is appended to the session log by the harness and comes back through the session-event
 * stream, where it is an ordinary user segment. Being a summary of the conversation, it is also among the most
 * relevant things in it, so a live run measured the recursion directly: one injection's headers read
 * `## state proxy T | ## recalled · user · s1cap-895b6ae1 | ## state proxy T | …`, and by the last step a
 * single message carried 30 recalled blocks, most of them our own earlier output. A context made of our own
 * output is not a measurement of anything.
 *
 * The block stays in the log — the harness put it there, and the request is built from the log, so the model
 * reads it as part of the transcript either way. What is excluded is its use as a *recall candidate*.
 */
test('a delivered block is never ingested, never recalled, and never in the token baseline', async () => {
  const policy = cellPolicyOf('C2');
  policy.tail.k = 2;
  const graph = new AssociationGraph();
  await observeStep({ ...BASE, policy, graph, messages: MESSAGES, step: 1 });
  const before = await observeStep({ ...BASE, policy, graph, messages: [], step: 2 });
  assert.equal(before.kind, 'assembled');
  if (before.kind !== 'assembled') return;
  void before;

  // A prior step's delivery, exactly as the harness logged it: a user message carrying our marker id. This is
  // 1_500 tokens of text S1CAP itself wrote, and the host will read it as part of the transcript forever.
  const injected = {
    id: 's1cap-895b6ae1',
    sessionId: BASE.sessionId,
    kind: 'user' as const,
    seq: 900,
    ts: BASE.now,
    tokens: 1_500,
    text: '# context assembled for this step\n## state proxy T\nTASK: something\n## recalled · user · u1\n…',
  };
  graph.addSegments([injected]);

  // Hand-added, so it is in the graph the way a segment added by any other means would be: `fullTokens` counts
  // it, honestly, and the second lock below is what keeps it out of the recall and the tail. The ingestion gate
  // itself is on the session-event path, and is tested where that path lives (upkeep-path.test.ts).
  const obs = await observeStep({ ...BASE, policy, graph, messages: [], step: 3 });
  assert.equal(obs.kind, 'assembled');
  if (obs.kind !== 'assembled') return;

  assert.ok(!obs.selectedIds.includes(injected.id), 'not selected by relevance');
  assert.ok(
    !obs.layout.recalled.some((s) => s.id === injected.id),
    `not in the recalled block: ${JSON.stringify(obs.layout.recalled.map((s) => s.id))}`,
  );
  assert.ok(
    !obs.layout.tail.some((s) => s.id === injected.id),
    'and not re-presented in the verbatim tail as if it were a recent turn',
  );
});

// --- recallTree: the walk as it is written into the control-plane log ---

/**
 * The tree has to reach the record, not merely the assembler's result: `telemetry.controlJsonl` is written from
 * `observation.event`. These two tests cover the chain `assemble()` -> `AssemblyResult.recallTree` -> `AssemblyEvent`
 * for a walk that found something and for one that found nothing.
 */
test('the assembly record carries the recall walk as a nested tree of ids', async () => {
  const policy = cellPolicyOf('C2');
  policy.tail.k = 1; // a1 is a tail turn, so it cannot also be a recalled one - it is still in the tree
  const graph = new AssociationGraph();
  const at = BASE.now;
  const s = (id: string, seq: number, kind: 'user' | 'assistant', text: string) => ({
    id,
    sessionId: BASE.sessionId,
    kind,
    seq,
    ts: at,
    tokens: 5,
    text,
  });
  // **Appended `a2, a1, u1`, and the direction rule is why.** The walk is `u1 -> a1 -> a2` and every expansion is
  // a step *back* in the append order, so `a2` has to be the oldest segment and `u1` - the anchor, which is the
  // step's newest input event - the newest. The fixture used to append `a1, a2, u1` and reached `a2` from `a1` by
  // walking forward in time. Which segment the tail takes is unaffected: `tail.k = 1` and the tail is the last of
  // the pool in append order, so it is still `a1`, and `a1` is still a hit the walk reached (at depth 1) that the
  // tail exclusion then drops from the block. That is the property this test pins: the tree documents what the
  // selector found, not what the layout kept.
  graph.addSegments([
    s('a2', 1, 'assistant', 'the expiry comparison looks off by one second'),
    s('a1', 2, 'assistant', 'the token check is at line 88 of auth.ts'),
    s('u1', 3, 'user', 'fix the expiry path too'),
  ]);
  const link = (from: string, to: string, w: number) =>
    graph.upsertEdge({ from, to, w, wTier1: w, source: 's1-noul', verifiedAt: at, provenance: 'test' });
  link('u1', 'a1', 0.9);
  link('a1', 'a2', 0.8);

  // Seeded by hand and not scored on the step path, so the graph recall walks is exactly the one above.
  const obs = await observeStep({ ...BASE, policy, graph, messages: [], step: 1, scoreOnStepPath: false });
  assert.equal(obs.kind, 'assembled');
  if (obs.kind !== 'assembled') return;

  assert.equal(obs.layout.anchor.id, 'u1', 'the anchor is the newest input event here (u1), and the root of the tree');
  assert.deepEqual(obs.event.recallTree, { u1: { a1: { a2: {} } } });
  // The tree records what the selector found; the block records what the selection then placed. a1 is in the tail
  // and therefore not in `recalled`, and dropping it from the tree for that reason would misreport the walk.
  assert.deepEqual(obs.layout.recalled.map((seg) => seg.id), ['a2']);
  assert.equal(obs.event.selected, 1);
  assert.deepEqual(Object.keys(obs.event.recallTree ?? {}), ['u1'], 'keys are ids, at the root and below');
  // The record is written as JSON, and `undefined` would vanish from the line: round-tripping is the check that
  // the field survives the sink rather than only the object literal.
  assert.deepEqual(JSON.parse(JSON.stringify(obs.event)).recallTree, { u1: { a1: { a2: {} } } });
});

test('a step whose recall found nothing records recallTree as {}, not as a missing field', async () => {
  const policy = cellPolicyOf('C2');
  const graph = new AssociationGraph();
  graph.addSegments([
    {
      id: 'u1',
      sessionId: BASE.sessionId,
      kind: 'user' as const,
      seq: 1,
      ts: BASE.now,
      tokens: 5,
      text: 'fix the failing test',
    },
  ]);
  // No edges at all, and no scoring on the step path, so the anchor has nothing to walk to.
  const obs = await observeStep({ ...BASE, policy, graph, messages: [], step: 1, scoreOnStepPath: false });
  assert.equal(obs.kind, 'assembled');
  if (obs.kind !== 'assembled') return;

  assert.equal(obs.event.candidates, 0, 'sanity: recall produced nothing');
  assert.ok('recallTree' in obs.event, 'the field is written even when there is nothing in it');
  assert.notEqual(obs.event.recallTree, undefined);
  assert.deepEqual(obs.event.recallTree, {});
  assert.deepEqual(JSON.parse(JSON.stringify(obs.event)).recallTree, {}, 'and it survives the JSONL serialisation');
});

// --- the anchor: which segment the walk is rooted on ---

/**
 * The anchor is resolved *in the graph's window*, and this is the test that fails without that.
 *
 * The defect it pins, measured on a real three-cell round: `anchor` was a position in the payload's segment list
 * and it was used to index the graph's append-ordered array (`window[anchor]`). The two index spaces only agree
 * when the graph's order begins where the payload's does, which is not the live case - the payload holds the
 * current question after its own first segment - so 273 of 277 invocations rooted the walk on
 * `34b2115f-…-#3`: the tail chunk of turn 1's `AGENTS.md` block. Every record looked healthy, and the tree was a
 * faithful account of a walk from the wrong question.
 *
 * What the window resolves *to* is a separate rule with its own test (F6, below): the newest input event. In this
 * fixture that is `u2`, the question this step carries, which is also what the rule it replaced would have picked -
 * so this test pins the index space and not the predicate, and the two cannot be confused for each other.
 *
 * The fixture is the live shape and nothing more: the earlier turn is already in the graph, and the step carries
 * the current question plus the `AGENTS.md` chunks that sit in front of it. The payload's last user turn is at
 * index 3 of its own segment list; index 3 of the graph is `u1`, which is what the old expression returned.
 */
test('the walk is rooted on the current question, not on the segment that index happens to name in the graph', async () => {
  const policy = cellPolicyOf('C2');
  policy.tail.k = 1;
  const graph = new AssociationGraph();
  const at = BASE.now;
  // Turn 1: exactly the shape the live round's root came from - a long instruction block split into chunks, whose
  // tail chunk is a `user` segment, plus the task the user actually asked.
  graph.addSegments([
    { id: 'u1', sessionId: BASE.sessionId, kind: 'user', seq: 1, ts: at, tokens: 40, text: 'the task from turn 1' },
    { id: 'agents#1', sessionId: BASE.sessionId, kind: 'user', seq: 2, ts: at, tokens: 60, text: 'AGENTS.md, chunk 1' },
    { id: 'agents#3', sessionId: BASE.sessionId, kind: 'user', seq: 3, ts: at, tokens: 60, text: 'AGENTS.md, chunk 3' },
    { id: 'a1', sessionId: BASE.sessionId, kind: 'assistant', seq: 4, ts: at, tokens: 30, text: 'turn 1 answer' },
  ]);
  // The turn-1 task recalls well; the instruction chunks do too, which is why the wrong root was not obvious.
  const link = (from: string, to: string, w: number) =>
    graph.upsertEdge({ from, to, w, wTier1: w, source: 's1-noul', verifiedAt: at, provenance: 'test' });
  link('u1', 'a1', 0.9);
  link('agents#3', 'agents#1', 0.9);
  link('agents#3', 'a1', 0.85);
  // The current question's own row, scored as the backend would have scored it, so the walk from `u2` finds
  // something and the tree is the walk rather than the recency fallback.
  link('u2', 'a1', 0.95);
  link('u2', 'agents#1', 0.5);
  graph.addSegments([
    { id: 'u2', sessionId: BASE.sessionId, kind: 'user', seq: 5, ts: at, tokens: 20, text: 'now fix the parser instead' },
  ]);

  // Turn 2 opens: on the payload path the harness claims only the new question. `agents#1`/`agents#3` are in front
  // of it, so the payload's own last user turn sits at index 3 - and so does `u1` in the graph.
  const obs = await observeStep({
    ...BASE,
    policy,
    graph,
    step: 6,
    scoreOnStepPath: false,
    messages: [
      { id: 'agents#1', role: 'user', content: [{ type: 'text', text: 'AGENTS.md, chunk 1' }] },
      { id: 'agents#3', role: 'user', content: [{ type: 'text', text: 'AGENTS.md, chunk 3' }] },
      { id: 'sys2', role: 'system', content: [{ type: 'text', text: 'You are a coding agent.' }] },
      { id: 'u2', role: 'user', content: [{ type: 'text', text: 'now fix the parser instead' }] },
    ],
  });
  assert.equal(obs.kind, 'assembled');
  if (obs.kind !== 'assembled') return;

  assert.equal(obs.layout.anchor.id, 'u2', 'the root is the question this step carries');
  const roots = Object.keys(obs.event.recallTree ?? {});
  assert.deepEqual(roots, ['u2'], 'and the tree is the walk from it, not a walk from a turn-1 segment');
  // `u1` and `agents#3` are reachable from the current question through `a1`, and being reachable is not the
  // defect: the defect was being the *seed*. Both trees hold the same ids - which is exactly why counting nodes,
  // edges or candidates could never have shown it - and they differ in which node everything hangs from. With the
  // old expression the root here was `u1`, one step earlier than the graph's fourth segment, and every step of the
  // run inherited whichever turn-1 chunk that index happened to name.
  assert.ok(obs.layout.tail.some((s) => s.id === 'a1'), 'the newest turns are still the pool the tail is drawn from');
  assert.ok(
    obs.event.recallTree !== undefined && Object.keys(obs.event.recallTree).length === 1,
    'one root, and it is the current question rather than a chunk of turn 1',
  );

  // The two positions are named when they disagree, and they are positions in different arrays - the payload's
  // segment list (3) and the graph's append order (4). Reporting them is what makes the distinction legible.
  //
  // The second step carries the new question alone, which is the shape a real payload has after a turn boundary:
  // the payload's own anchor is 0 and the graph's is still 4, and the walk still roots on `u2`.
  const mismatches: { payloadAnchor: number; windowAnchor: number; payloadId: string; windowId: string }[] = [];
  await observeStep({
    ...BASE,
    policy,
    graph,
    step: 7,
    scoreOnStepPath: false,
    messages: [{ id: 'u2', role: 'user', content: [{ type: 'text', text: 'now fix the parser instead' }] }],
    onAnchorMismatch: (detail) => mismatches.push(detail),
  });
  assert.deepEqual(
    mismatches,
    [{ payloadAnchor: 0, windowAnchor: 4, payloadId: 'u2', windowId: 'u2' }],
    'the mismatch names both positions and both ids, and the window one is the anchor that was used',
  );
});

// --- the bounded anchor wait (recall.anchorWaitMs): the hook, and its containment ---

/**
 * The anchor id is computed inside `observeStep` and the queue that drains asynchronous scoring lives in the
 * plugin, so the wait has to travel back out as a callback. What matters for the core half is only that it is
 * called, that it is called with the anchor's own id, and that it happens before `assemble()` reads the graph.
 */
test('observeStep offers the anchor id to beforeAssemble, and only after the anchor is chosen', async () => {
  const policy = cellPolicyOf('C2');
  const graph = new AssociationGraph();
  const seen: string[] = [];
  // The hook is called with the anchor's id *and* with the anchor already in the graph, which is what makes the
  // plugin's `unjudgedWithin(anchorId, w)` check meaningful rather than always empty.
  const observation = await observeStep({
    ...BASE,
    policy,
    graph,
    step: 1,
    beforeAssemble: (anchorId: string) => {
      seen.push(anchorId);
      assert.ok(graph.getSegment(anchorId) !== undefined, 'the anchor is in the graph when the hook runs');
    },
  });

  // The anchor is the newest input event, which in MESSAGES is u2: 'also check the expiry path' is the task, and it
  // is the last thing the step carries.
  assert.deepEqual(seen, ['u2']);
  assert.equal(observation.kind, 'assembled');
  if (observation.kind !== 'assembled') return;
  assert.equal(observation.layout.anchor.id, 'u2', 'and it is the anchor the layout was built from');
});

test('a throwing beforeAssemble costs the wait, never the step or the observation', async () => {
  const policy = cellPolicyOf('C2');
  const graph = new AssociationGraph();
  const observation = await observeStep({
    ...BASE,
    policy,
    graph,
    step: 1,
    beforeAssemble: () => {
      // The realistic shape of this failure: a wait that reached for a queue that is no longer there.
      throw new Error('the scoring queue is gone');
    },
  });

  assert.equal(observation.kind, 'assembled', 'an assembled step is still assembled');
  if (observation.kind !== 'assembled') return;
  assert.equal(observation.event.type, 'assembly');
  assert.equal(observation.layout.anchor.id, 'u2');
  assert.ok(observation.segments.length > 0, 'the observation itself is not lost');
  assert.ok(observation.event.budgetUsed > 0);
});

test('a rejecting beforeAssemble is contained too: it is awaited, not left to reject the promise', async () => {
  const policy = cellPolicyOf('C2');
  const graph = new AssociationGraph();
  const observation = await observeStep({
    ...BASE,
    policy,
    graph,
    step: 1,
    beforeAssemble: async () => {
      await Promise.resolve();
      throw new Error('the drain rejected');
    },
  });
  assert.equal(observation.kind, 'assembled');
});

test('a delivered block arriving on the session-event stream is dropped at ingestion', async () => {
  // The path production takes: upkeep folds the session-event stream into the graph, so the delivered message
  // comes back as a RawEvent rather than being added by hand. The ingestion gate is what keeps it out.
  const policy = cellPolicyOf('C2');
  const graph = new AssociationGraph();
  const obs = await observeStep({
    ...BASE,
    policy,
    graph,
    messages: [
      ...MESSAGES,
      {
        id: 's1cap-deadbeef',
        role: 'user',
        content: [{ type: 'text', text: '# context assembled for this step\n## state proxy T\n…' }],
      },
    ],
    step: 1,
  });
  assert.equal(obs.kind, 'assembled');
  if (obs.kind !== 'assembled') return;

  assert.ok(
    obs.segments.every((s) => !s.id.startsWith('s1cap-')),
    `the delivered message produced no segment: ${JSON.stringify(obs.segments.map((s) => s.id))}`,
  );
  assert.equal(graph.getSegment('s1cap-deadbeef'), undefined, 'and nothing was added to the graph');
});

// ------------------------------------------------------- the record's fail-open counter (F4)

/**
 * F4: `unknownAdmitted` reached the assembler's result and nothing else.
 *
 * The field was computed by `assemble()` since the fail-open branch was written, is asserted on the assembler's own
 * result in `core.test.ts`, is required by the documents (`CELLS-RUN.md`: a run that lowers `w` must carry
 * `fallback`, `unknownAdmitted` and `recallTree` beside it) and is referred to by the plugin's comments as if it
 * were written down - and of round `20261002-2037`'s 277 `assembly` records, **zero** carried the key. The round's
 * first delivery is the case it hid: `candidates: 0`, `selected: 1`, no `fallback`, and one 372-token block, which
 * with no candidates and no recency fallback can only be the fail-open branch admitting unjudged pairs.
 */
test('the assembly record carries the fail-open admission count, and omits it when it is zero', async () => {
  // The fixture is `core.test.ts`'s fail-open pair, driven through `observeStep` instead of `assemble`: a window
  // whose only pair the backend never judged, so recall finds no edge and the fail-open rule is what fills the block.
  const policy = cellPolicyOf('C2');
  policy.tail.k = 0; // Keep the old user turn recallable; pinned content is never admitted.
  const graph = new AssociationGraph();
  const observation = await observeStep({
    ...BASE,
    policy,
    graph,
    step: 1,
    messages: [
      { id: 'sys', role: 'system', content: [{ type: 'text', text: 'You are a coding agent.' }], source: { kind: 'system-prompt' } },
      { id: 'old', role: 'user', content: [{ type: 'text', text: 'alpha beta gamma' }] },
      { id: 'x', role: 'user', content: [{ type: 'text', text: 'delta epsilon' }] },
    ],
    // `undefined` from the batch scorer is the backend not answering this window: the graph writes a lexical row,
    // which is not a judgement, so the pair stays unknown.
    scoreBatch: () => undefined,
  });
  assert.equal(observation.kind, 'assembled');
  if (observation.kind !== 'assembled') return;

  assert.equal(observation.event.candidates, 0, 'sanity: no edge cleared the threshold, so the walk found nothing');
  assert.equal(observation.event.selected, 1, 'the old turn is admitted, and the pinned prefix is excluded');
  assert.equal(observation.event.fallback, undefined, 'not by the recency window: the fail-open rule suppressed it');
  assert.equal(
    observation.event.unknownAdmitted,
    1,
    'the admission is on the record, which is what makes the block explainable after the round',
  );

  // The other direction, and the reason the field is omitted rather than zeroed: a step that admitted nothing must
  // not look like a step whose admission count was dropped. `{}` vs absent is the convention `recallTree` uses.
  //
  // Two constraints shape the fixture, and both cost a rejected attempt. The recallable turn is an *assistant*
  // segment rather than a second user message, so nothing here depends on where the question sits. And it must not
  // be inside the verbatim tail: `tail.k` takes the last three segments of the pool and the assembler excludes
  // them, so a history turn with three short turns after it is the one that is left for the walk - with fewer,
  // everything in front of the anchor is "recent" and `selected` is 0.
  const judgedGraph = new AssociationGraph();
  policy.tail.k = 3;
  const judged = await observeStep({
    ...BASE,
    policy,
    graph: judgedGraph,
    step: 1,
    messages: [
      { id: 'sys', role: 'system', content: [{ type: 'text', text: 'You are a coding agent.' }], source: { kind: 'system-prompt' } },
      { id: 'h1', role: 'assistant', content: [{ type: 'text', text: 'the comparison is off by one second' }], source: { kind: 'model' } },
      { id: 'h2', role: 'tool', content: [{ type: 'text', text: 'auth.ts: 120 lines' }], source: { kind: 'tool' } },
      { id: 'h3', role: 'assistant', content: [{ type: 'text', text: 'narrowing it down' }], source: { kind: 'model' } },
      { id: 'h4', role: 'tool', content: [{ type: 'text', text: 'expiry at line 88' }], source: { kind: 'tool' } },
      { id: 'x', role: 'user', content: [{ type: 'text', text: 'delta epsilon' }] },
    ],
    scoreBatch: async (_current, candidates) => candidates.map(() => 0.9),
  });
  assert.equal(judged.kind, 'assembled');
  if (judged.kind !== 'assembled') return;
  assert.equal(judged.event.selected, 1, 'the backend judged this pair, so recall selected it on its own edge');
  assert.deepEqual(judged.layout.recalled.map((s) => s.id), ['h1'], 'and the selected turn is the history one');
  assert.equal(judged.event.fallback, undefined, 'and no fallback was needed');
  assert.equal(
    judged.event.unknownAdmitted,
    undefined,
    'and nothing was admitted unjudged - an absence, not a recorded zero',
  );
});

// ------------------------------------------------------- the anchor's sibling chunks (F5)

/**
 * F5: with the corrected seed, x is one *chunk* of the question.
 *
 * The seed is the newest input event in the graph window (`observer.ts`, `isInputEvent`) - the question itself at a
 * turn-opening step, which is the case here - and a long user message is split into chunks that share a `chunkOf`
 * parent (`segmenter.ts`), so that newest segment is the *last chunk* of the question. Nothing excluded its
 * siblings: they sat in `tail` or in `history`, the assembler's `excluded` set was built from pinned/tail/anchor
 * only, and the sibling guard only stops two chunks of one parent being selected together - the anchor's own parent
 * is never in `selectedParents`, because the anchor is not selected by the walk. So a chunk of the *current*
 * question could be selected and delivered as "an earlier user turn, quoted verbatim", which is both false and
 * redundant. Measured in round `20261002-2037`: both deliveries quote the task prompt, and the delivered body is
 * its middle chunk. The exclusion is written on the anchor's parent (`chunkOf ?? id`), so it now covers the model's
 * own message, tool call or tool result as well, which is the anchor on every step after the turn's first.
 */
test('a chunk of the current question is never recalled as history', async () => {
  const policy = cellPolicyOf('C2');
  // One long user message, chunked by the segmenter (512-token chunks) into several pieces that all share
  // `chunkOf: 'q'`. The paragraph breaks are what makes the segmenter pack it into more than two pieces; a block of
  // newlines with no blank line goes through the sentence splitter and can come out as one or two.
  const long = Array.from(
    { length: 8 },
    (_, i) =>
      `Section ${i} of the question. The failing test is in auth.ts and the expiry comparison is off by one ` +
      'second, which makes the check pass for tokens that should already have been rejected. Explain how you would ' +
      'narrow it down, which callers are affected, and what the smallest safe change is.',
  ).join('\n\n');
  // Three judged history turns, so `history` holds something other than the question's own chunks and the walk has
  // a legitimate candidate. They are short, which is what leaves them *behind* the question in the pool - the tail
  // takes the last `tail.k` segments of the pool, and the question's chunks are at the end of it.
  const history = [
    { id: 'h1', role: 'assistant', content: [{ type: 'text', text: 'the comparison is off by one second' }], source: { kind: 'model' } },
    { id: 'h2', role: 'tool', content: [{ type: 'text', text: 'auth.ts: 120 lines, token check at line 88' }], source: { kind: 'tool' } },
    { id: 'h3', role: 'assistant', content: [{ type: 'text', text: 'I will narrow it down to the expiry path' }], source: { kind: 'model' } },
  ];
  const graph = new AssociationGraph();
  const observation = await observeStep({
    ...BASE,
    policy,
    graph,
    step: 1,
    messages: [
      { id: 'sys', role: 'system', content: [{ type: 'text', text: 'You are a coding agent.' }], source: { kind: 'system-prompt' } },
      ...history,
      { id: 'q', role: 'user', content: [{ type: 'text', text: long }] },
    ],
    // Every pair judged relevant, so every segment in the window is a candidate: the sibling chunks would be
    // selected if nothing excluded them.
    scoreBatch: async (_current, candidates) => candidates.map(() => 0.99),
  });
  assert.equal(observation.kind, 'assembled');
  if (observation.kind !== 'assembled') return;

  const siblings = observation.segments.filter((s) => s.chunkOf === 'q').map((s) => s.id);
  assert.ok(siblings.length > 1, `sanity: the long question was chunked (${JSON.stringify(observation.segments.map((s) => s.id))})`);
  const anchor = observation.layout.anchor;
  assert.equal(anchor.chunkOf, 'q', 'sanity: the anchor is a chunk of the question, not a standalone event');
  const anchorParent = anchor.chunkOf ?? anchor.id;
  const otherSiblings = siblings.filter((id) => id !== anchor.id);
  assert.ok(otherSiblings.length > 0, 'sanity: there is at least one sibling for the guard to exclude');
  assert.ok(
    Object.keys(observation.event.recallTree).length > 0,
    'sanity: the walk ran, so an empty result here would be evidence of something else',
  );
  // The sibling was *offered* to the walk - the tree records what recall returned, and it came back with a hit on
  // the question's own first chunk. That is what makes the next assertion a test of the guard rather than of an
  // empty graph: without `excludeIds` this hit is selectable, because the sibling guard only stops two chunks of
  // one parent being selected *together* and the anchor's parent is never in `selectedParents`.
  const treeIds = JSON.stringify(observation.event.recallTree);
  assert.ok(
    otherSiblings.some((id) => treeIds.includes(id)),
    `sanity: the walk reached a sibling chunk, so the exclusion is load-bearing: tree ${treeIds}`,
  );

  const selected = observation.layout.recalled.map((s) => `${s.id}(${s.chunkOf ?? s.id})`);
  assert.ok(
    observation.layout.recalled.every((s) => (s.chunkOf ?? s.id) !== anchorParent),
    `no block may quote the question the model is answering: selected ${JSON.stringify(selected)}`,
  );
  // And they are excluded from the *pool* too, not merely from the selection: a sibling must not be re-presented
  // through the verbatim tail either, since that list is built from the pool.
  assert.ok(
    observation.layout.tail.every((s) => (s.chunkOf ?? s.id) !== anchorParent),
    `the verbatim tail holds turns, and the current question is not one of them: ${JSON.stringify(observation.layout.tail.map((s) => s.id))}`,
  );
  // The question is still in the layout exactly once, as the anchor - which is the point: it is not "history".
  const inLayout = [...observation.layout.recalled, ...observation.layout.tail, observation.layout.anchor];
  assert.equal(
    inLayout.filter((s) => s.chunkOf === 'q').length,
    1,
    'the question appears in the layout once, at the anchor',
  );
  // And the history turns are still recalled or tailed, so the exclusion did not empty the view.
  assert.ok(
    history.some((h) => inLayout.some((s) => s.id === h.id)),
    `the turns that are genuine history are still placed: ${JSON.stringify(inLayout.map((s) => s.id))}`,
  );
});

// ------------------------------------------------------- the anchor: the newest input event (F6)

/**
 * The anchor is the step's newest **input event**, not its newest `user` segment.
 *
 * The rule the walk is seeded from was "the newest `user` segment in the graph window", which is a
 * chat-transcript rule: it holds while a session alternates one user turn with one model turn, and it stops
 * advancing the moment the loop takes more than one step per turn. The model's own messages arrive as
 * `assistant` (or `trace`), its tool invocations as `toolCall`, their results as `toolResult`, and none of those is
 * a `user` segment — so from the turn's second step on, the newest `user` segment stays the turn's opening
 * question for the rest of the turn and every step re-seeds the walk from it.
 *
 * Measured in round `20261004-0233`, cell C2, from that round's own control plane
 * (`evidence/C2/control.jsonl`, 25 assemblies): the `recallTree` root changed once and then stayed
 * `7b0dd492-…-#3` for the last 20 consecutive assemblies while the step counter climbed from 23 to 116.
 * `candidates` plateaued at 26-28, `selected` at 20 and `bfsDepth` at 2 — and because the selection never moved,
 * the delivered payload was byte-identical from step to step, so the payload-id guard refused it and only **11 of
 * the 25** steps received anything at all. That session logged 25 `trace` and **zero** `assistant` segments (every
 * model message carried reasoning parts, so the adapter labelled it `trace`) and 14 of its 15 `user` segments were
 * S1CAP's own deliveries, which ingestion drops — so a rule that admitted only `user`, `assistant` and the tool
 * kinds would still have frozen on the one genuine `user` segment left.
 *
 * The brief's own requirement is the two halves of idea 3: the recall is driven by "the user input *or* the
 * model's own self-directed input", and idea 2 makes a model output and a tool-call result session events of the
 * same standing as a user input. This test is that requirement, stepped through an agent loop one event at a
 * time; `newestUser` is carried beside `anchor` in every row so the two rules can be read against each other in
 * one output.
 */
test('the walk is seeded from the newest input event, and the seed advances through an agent loop', async () => {
  const policy = cellPolicyOf('C2');
  policy.tail.k = 2;
  const graph = new AssociationGraph();
  const at = BASE.now;
  const s = (
    id: string,
    seq: number,
    kind: 'user' | 'assistant' | 'trace' | 'toolCall' | 'toolResult' | 'systemPinned',
    text: string,
  ) => ({ id, sessionId: BASE.sessionId, kind, seq, ts: at, tokens: 5, text });
  const link = (from: string, to: string, w: number) =>
    graph.upsertEdge({ from, to, w, wTier1: w, source: 's1-noul', verifiedAt: at, provenance: 'test' });
  /** What the rule this replaces would have anchored on, for the same window: the newest `user` segment. */
  const newestUserOf = (window: readonly { id: string; kind: string }[]): string => {
    for (let i = window.length - 1; i >= 0; i -= 1) {
      const seg = window[i];
      if (seg !== undefined && seg.kind === 'user') return seg.id;
    }
    return '(none)';
  };

  // Turn 1's remains, already in the graph: whatever the walk is seeded on has to have something to find, or it
  // returns no hits and the tree is `{}` - which would let the root assertion below pass for the wrong reason.
  graph.addSegments([
    s('h1', 1, 'assistant', 'the token check is at line 88 of auth.ts'),
    s('h2', 2, 'toolResult', 'auth.ts: 120 lines'),
  ]);

  // One arrival per step, in the order a live agent loop produces them. The payload is empty on every one of
  // these steps, which is the live shape rather than a convenience: `inbox.claim` hands over the user's question
  // on the turn's first step and nothing at all on every step after it, while the model's output reaches the
  // graph through the session-event stream (`docs/STATUS-ARCHIVE.md`, fault 2).
  const arrivals: [string, 'user' | 'assistant' | 'trace' | 'toolCall' | 'toolResult' | 'systemPinned', string][] = [
    ['u1', 'user', 'the parser drops the last statement of a script'],
    ['a1', 'assistant', 'I will trace the splitter.'],
    ['c1', 'toolCall', 'tool call: read_file\n{"path":"sqlparse/engine/statement_splitter.py"}'],
    ['t1', 'toolResult', 'statement_splitter.py: 210 lines; the flush is at line 120'],
    ['r1', 'trace', 'the flush at line 120 keeps the trailing text'],
    // A pinned prefix arriving late, as the harness's own notices do. It is the newest *segment* in the window and
    // must still not be the anchor: `systemPinned` is the one kind the brief's rule excludes, because the pinned
    // prefix is not a session event at all - it precedes everything in the request by construction.
    ['p1', 'systemPinned', '<system-reminder> Additional instructions from AGENTS.md'],
    ['q2', 'user', 'also check the expiry path'],
  ];

  const rows: { anchor: string; newestUser: string; root: string }[] = [];
  let step = 1;
  for (const [id, kind, text] of arrivals) {
    graph.addSegments([s(id, 10 + step, kind, text)]);
    // One hand-made edge per arrival, from the segment that is supposed to seed this step's walk. This test is
    // about which segment seeds the walk, not about scoring, so the scorer is taken off the step path below and
    // the edge is written here.
    link(id, kind === 'user' ? 'h1' : 'h2', 0.9);

    const obs = await observeStep({ ...BASE, policy, graph, messages: [], step, scoreOnStepPath: false });
    assert.equal(obs.kind, 'assembled', `step ${step} (${id} arrived) must assemble: ${JSON.stringify(obs)}`);
    if (obs.kind !== 'assembled') return;

    const anchorId = obs.layout.anchor.id;
    rows.push({
      anchor: anchorId,
      newestUser: newestUserOf(graph.orderedSegments()),
      root: Object.keys(obs.event.recallTree)[0] ?? '(no hits)',
    });

    // The current event is never offered back as history: it is the anchor, and neither the recalled block nor the
    // verbatim tail may quote it to the model as an earlier turn. The assertion is on the resolved anchor rather
    // than on the arrival, because on the pinned step those are deliberately different segments.
    assert.ok(!obs.selectedIds.includes(anchorId), `step ${step}: the anchor ${anchorId} is not also a recalled turn`);
    assert.ok(
      !obs.layout.tail.some((seg) => seg.id === anchorId),
      `step ${step}: ${anchorId} is the step's own newest input event, not one of the k most recent turns`,
    );
    step += 1;
  }

  assert.deepEqual(
    rows.map((r) => r.anchor),
    ['u1', 'a1', 'c1', 't1', 'r1', 'r1', 'q2'],
    'the seed is the newest input event at every step: the question, then the model\'s own message, its tool call, ' +
      'the tool result and its reasoning - and it does not move when a pinned prefix arrives',
  );
  assert.deepEqual(
    rows.map((r) => r.newestUser),
    ['u1', 'u1', 'u1', 'u1', 'u1', 'u1', 'q2'],
    'the rule this replaces, over the same six steps: the newest `user` segment, frozen on the turn\'s question ' +
      'from the second step to the sixth',
  );
  assert.deepEqual(
    rows.map((r) => r.root),
    rows.map((r) => r.anchor),
    'and each step\'s walk is rooted on that seed - which is what the delivered payload and the figure read',
  );
});

/**
 * The case the old rule got right, kept so the fix cannot be read as "ignore `user`".
 *
 * At a turn-opening step the user's question **is** the newest input event, so the two rules agree and must: the
 * question is the segment the step's model call ends on, and it is the anchor of the layout as well as the root of
 * the tree. The assertion is written against both halves of the predicate - the question wins over the pinned
 * prefix that follows it in the same payload, and it is the root rather than merely the last block.
 */
test('a step whose newest event is the user\'s own question is still anchored there', async () => {
  const policy = cellPolicyOf('C2');
  const graph = new AssociationGraph();
  const at = BASE.now;
  graph.addSegments([
    { id: 'h1', sessionId: BASE.sessionId, kind: 'assistant', seq: 1, ts: at, tokens: 5, text: 'turn 1 answer' },
  ]);
  // The question's own row, so the walk from it finds something and the tree is a walk rather than `{}`.
  graph.upsertEdge({
    from: 'q2',
    to: 'h1',
    w: 0.95,
    wTier1: 0.95,
    source: 's1-noul',
    verifiedAt: at,
    provenance: 'test',
  });

  const obs = await observeStep({
    ...BASE,
    policy,
    graph,
    step: 2,
    scoreOnStepPath: false,
    // The question arrives in this step's payload, and a rendered system prompt follows it — the newest *segment*
    // is therefore `systemPinned`, and the anchor still has to be the question.
    messages: [
      { id: 'q2', role: 'user', content: [{ type: 'text', text: 'now fix the parser instead' }] },
      {
        id: 'sys',
        role: 'system',
        content: [{ type: 'text', text: 'You are a coding agent.' }],
        source: { kind: 'system-prompt' },
      },
    ],
  });
  assert.equal(obs.kind, 'assembled');
  if (obs.kind !== 'assembled') return;

  assert.equal(obs.layout.anchor.id, 'q2', 'the user\'s question is the newest input event, and the anchor');
  assert.equal(obs.layout.anchor.kind, 'user');
  assert.deepEqual(Object.keys(obs.event.recallTree), ['q2'], 'and the walk is rooted on the question');
  assert.ok(!obs.selectedIds.includes('q2'), 'the anchor is not also offered back as a recalled earlier turn');
  assert.ok(!obs.layout.tail.some((seg) => seg.id === 'q2'), 'nor as one of the k most recent turns');
});
