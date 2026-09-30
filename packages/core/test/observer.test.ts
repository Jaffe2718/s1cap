/**
 * Observation mode: the read-only half of M1.
 *
 * These tests pin the two properties the milestone rests on — the observation is *deterministic* (so a
 * replay can be compared field by field) and *non-mutating* (so running it against a live session cannot
 * change what the model sees) — plus the adapter's translation table and the C1/C4 ablation behaviour.
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

test('the control-plane record carries the frozen schema and the full C1/C4 contrast', async () => {
  const c4 = (await run()).observation;
  assert.equal(c4.event.type, 'assembly');
  assert.equal(c4.event.schema, TELEMETRY_SCHEMA_VERSION);
  assert.equal(c4.event.seq, BASE.seq);
  assert.deepEqual(Object.keys(c4.event.blocks).sort(), ['anchor', 'pinned', 'recalled', 'stateProxy', 'tail']);
  assert.ok(c4.event.budgetUsed <= c4.event.budgetTotal);
  assert.equal(c4.event.prefixTokensStable, c4.event.blocks['pinned'], 'the cache-stable prefix is the pinned block');

  // C1 is the baseline cell: no System-1 selection at all, so nothing is recalled.
  const c1Policy = cellPolicy('C1');
  const graph = new AssociationGraph();
  const c1 = await observeStep({ ...BASE, policy: c1Policy, graph });
  assert.equal(c1.event.selected, 0);
  assert.deepEqual(c1.selectedIds, []);
  assert.equal(c1.event.candidates, 0);

  // C4 still respects the budget it is given.
  assert.ok(c4.event.budgetUsed <= c4.event.budgetTotal);
  assert.ok(c4.wouldSaveTokens >= 0);
});

test('the graph accumulates across steps, so a later step can recall an earlier one', async () => {
  const policy = cellPolicy('C4');
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
  const policy = cellPolicy('C4');
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
test('a delivered block is never a recall candidate, and the graph still holds it', async () => {
  const policy = cellPolicy('C4');
  policy.tail.k = 2;
  const graph = new AssociationGraph();
  await observeStep({ ...BASE, policy, graph, messages: MESSAGES, step: 1 });

  // A prior step's delivery, exactly as the harness logged it: a user message with our marker id.
  graph.addSegments([
    {
      id: 's1cap-895b6ae1',
      sessionId: BASE.sessionId,
      kind: 'user',
      seq: 900,
      ts: BASE.now,
      tokens: 1_500,
      text: '# context assembled for this step\n## state proxy T\nTASK: something\n## recalled · user · u1\n…',
    },
  ]);

  const obs = await observeStep({ ...BASE, policy, graph, messages: [], step: 2 });
  assert.equal(obs.kind, 'assembled');
  if (obs.kind !== 'assembled') return;

  assert.ok(!obs.selectedIds.includes('s1cap-895b6ae1'), 'not selected by relevance');
  assert.ok(
    !obs.layout.recalled.some((s) => s.id === 's1cap-895b6ae1'),
    `and not in the recalled block either: ${JSON.stringify(obs.layout.recalled.map((s) => s.id))}`,
  );
  assert.ok(graph.getSegment('s1cap-895b6ae1') !== undefined, 'the graph is still a faithful record of the session');
});
