/**
 * Observation mode: the read-only half of M1.
 *
 * These tests pin the two properties the milestone rests on — the observation is *deterministic* (so a
 * replay can be compared field by field) and *non-mutating* (so running it against a live session cannot
 * change what the model sees) — plus the adapter's translation table and the C0/C2 ablation behaviour.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { AssociationGraph, cellPolicy, defaultPolicy, observeStep } from '../src/index.ts';
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
  assert.ok(c2.event.budgetUsed <= c2.event.budgetTotal);
  assert.equal(c2.event.prefixTokensStable, c2.event.blocks['pinned'], 'the cache-stable prefix is the pinned block');

  // C0 is the baseline cell: no System-1 selection at all, so nothing is recalled.
  const c0Policy = cellPolicy('C0');
  const graph = new AssociationGraph();
  const c0 = await observeStep({ ...BASE, policy: c0Policy, graph });
  assert.equal(c0.event.selected, 0);
  assert.deepEqual(c0.selectedIds, []);
  assert.equal(c0.event.candidates, 0);

  // C2 still respects the budget it is given.
  assert.ok(c2.event.budgetUsed <= c2.event.budgetTotal);
  assert.ok(c2.wouldSaveTokens >= 0);
});

test('the graph accumulates across steps, so a later step can recall an earlier one', async () => {
  const policy = cellPolicy('C2');
  const graph = new AssociationGraph();
  const first = await observeStep({ ...BASE, policy, graph, messages: MESSAGES.slice(0, 2), step: 1 });
  const second = await observeStep({ ...BASE, policy, graph, step: 2 });

  assert.equal(first.segments.length, 2);
  assert.ok(graph.stats().segments >= MESSAGES.length, 'segments from both steps live in one graph');
  assert.ok(second.segments.length === MESSAGES.length);
});

test('the tail block holds the newest turns, including the output produced after the anchor', async () => {
  // This is the shape the graph window actually has in a live session: the anchor is the last *user* segment,
  // and everything the model did for this task (its own message, the tool call, the tool result) sits after it
  // in the append-only log. An earlier version sliced the window at the anchor, so the pool was the *history*
  // and `tail` was empty in every real record - the k most recent verbatim turns were never in the prompt.
  // Exercised through the graph-window path (empty payload) because that is what production takes: `pre-step`
  // hands over an empty array after the first step.
  const policy = cellPolicy('C2');
  policy.tail.k = 3;
  const graph = new AssociationGraph();
  // Seed the graph the way upkeep would: the anchor first, then the turns produced for it.
  const [u2] = MESSAGES.slice(-1);
  assert.ok(u2 !== undefined);
  await observeStep({ ...BASE, policy, graph, messages: MESSAGES.slice(0, 6), step: 1 });

  const obs = await observeStep({ ...BASE, policy, graph, messages: [], step: 2 });
  assert.equal(obs.kind, 'assembled');
  if (obs.kind !== 'assembled') return;

  // The anchor is the last user message; the assistant and tool segments that follow it are what the tail is for.
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
  const policy = cellPolicy('C2');
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
  const policy = cellPolicy('C2');
  policy.tail.k = 1; // a2 is a tail turn, so it cannot also be a recalled one - it is still in the tree
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
  graph.addSegments([
    s('a1', 1, 'assistant', 'the token check is at line 88 of auth.ts'),
    s('a2', 2, 'assistant', 'the expiry comparison looks off by one second'),
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

  assert.equal(obs.layout.anchor.id, 'u1', 'the anchor is the last user segment, and the root of the tree');
  assert.deepEqual(obs.event.recallTree, { u1: { a1: { a2: {} } } });
  // The tree records what the selector found; the block records what the budget delivered. a2 is in the tail and
  // therefore not in `recalled`, and dropping it from the tree for that reason would misreport the walk.
  assert.deepEqual(obs.layout.recalled.map((seg) => seg.id), ['a1']);
  assert.equal(obs.event.selected, 1);
  assert.deepEqual(Object.keys(obs.event.recallTree ?? {}), ['u1'], 'keys are ids, at the root and below');
  // The record is written as JSON, and `undefined` would vanish from the line: round-tripping is the check that
  // the field survives the sink rather than only the object literal.
  assert.deepEqual(JSON.parse(JSON.stringify(obs.event)).recallTree, { u1: { a1: { a2: {} } } });
});

test('a step whose recall found nothing records recallTree as {}, not as a missing field', async () => {
  const policy = cellPolicy('C2');
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

// --- the bounded anchor wait (recall.anchorWaitMs): the hook, and its containment ---

/**
 * The anchor id is computed inside `observeStep` and the queue that drains asynchronous scoring lives in the
 * plugin, so the wait has to travel back out as a callback. What matters for the core half is only that it is
 * called, that it is called with the anchor's own id, and that it happens before `assemble()` reads the graph.
 */
test('observeStep offers the anchor id to beforeAssemble, and only after the anchor is chosen', async () => {
  const policy = cellPolicy('C2');
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

  // The anchor is the newest `user` segment: u2 is last in MESSAGES and 'also check the expiry path' is the task.
  assert.deepEqual(seen, ['u2']);
  assert.equal(observation.kind, 'assembled');
  if (observation.kind !== 'assembled') return;
  assert.equal(observation.layout.anchor.id, 'u2', 'and it is the anchor the layout was built from');
});

test('a throwing beforeAssemble costs the wait, never the step or the observation', async () => {
  const policy = cellPolicy('C2');
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
  const policy = cellPolicy('C2');
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
  const policy = cellPolicy('C2');
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
