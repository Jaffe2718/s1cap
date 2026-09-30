/**
 * The upkeep path, end to end, from session events to segments, edges and the plan gate.
 *
 * These tests exist because every live session so far has shown the same shape: upkeep reports events enqueued
 * and applied, and `upkeepSegments: 0` - so the counters prove the queue ran and prove nothing about whether it
 * did anything. Driving a realistic event sequence through the observer in a test is the only way to tell a
 * stream that carries no content from a wiring that drops it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultPolicy } from '@s1cap/core';

import { createStepObserver } from '../src/step-observer.ts';
import type { StepObserver } from '../src/step-observer.ts';

interface Harness {
  observer: StepObserver;
  ticks: (() => void)[];
  seenByGate: string[];
  scored: unknown[];
  records: unknown[];
  session: { id: string; kind: string; seq: number }[];
}

function harness(opts: { withGate?: boolean; withScorer?: boolean; withSession?: boolean } = {}): Harness {
  const ticks: (() => void)[] = [];
  const seenByGate: string[] = [];
  const scored: unknown[] = [];
  const records: unknown[] = [];
  const session: { id: string; kind: string; seq: number }[] = [];
  const observer = createStepObserver({
    policy: defaultPolicy(),
    emit: (event) => records.push(event),
    now: () => 1_790_000_000_000,
    contextWindow: 128_000,
    reserveOutputTokens: 8_000,
    fixedOverheadTokens: 1_200,
    lambdaMs: 36 * 60 * 60 * 1000,
    maxLagTurns: 2,
    schedule: (tick) => ticks.push(tick),
    ...(opts.withSession === true
      ? {
          onSessionEvent: (event) => {
            session.push({ id: event.id, kind: event.kind, seq: event.seq });
          },
        }
      : {}),
    ...(opts.withGate === true
      ? {
          planGate: {
            consider: async (text: string) => {
              seenByGate.push(text);
              return undefined;
            },
          },
        }
      : {}),
    ...(opts.withScorer === true
      ? {
          scoreBatch: async (current: unknown, candidates: readonly unknown[]) => {
            scored.push({ current, candidates });
            return candidates.map(() => 0.99);
          },
        }
      : {}),
  });
  return { observer, ticks, seenByGate, scored, records, session };
}

/** Wait for the queue's async handler to settle; the flush itself is synchronous. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * The session-event shapes the host actually emits.
 *
 * Measured, not inferred: a `session-event-probe` line from a live session recorded the envelope as
 * `{type, seq, time, data}` and the payload keys inside `data` per type. The fixtures here used to put `message`
 * at the top level, which no event has, so they exercised a shape that does not occur and passed while every
 * live content event produced nothing.
 */
function sessionEvents() {
  const at = (seq: number) => ({ seq, time: 1_790_000_000_000 + seq });
  return [
    { type: 'turn/start', ...at(1), data: { turn: 1 } },
    { type: 'step/start', ...at(2), data: { turn: 1, step: 1 } },
    {
      type: 'user/message',
      ...at(3),
      data: { id: 'u1', role: 'user', content: [{ type: 'text', text: 'inspect this repository and report' }] },
    },
    {
      type: 'assistant/message',
      ...at(4),
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'a1',
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'I will lay out the steps first.' },
            { type: 'text', text: '1. inventory the layout\n2. read the build config\n3. map the modules' },
          ],
        },
        usage: {},
        stream: false,
      },
    },
    { type: 'tool/call', ...at(5), data: { turn: 1, step: 2, callId: 'c1', name: 'ls', arguments: { path: '.' } } },
    {
      type: 'tool/result',
      ...at(6),
      data: { turn: 1, step: 2, message: { id: 'r1', role: 'tool', content: [{ type: 'text', text: 'src  test  package.json' }] } },
    },
    { type: 'step/end', ...at(7), data: { turn: 1, step: 2 } },
    { type: 'turn/end', ...at(8), data: { turn: 1 } },
  ];
}

test('the session-event stream reaches the graph: content events become segments, lifecycle ones do not', async () => {
  const h = harness();
  for (const event of sessionEvents()) h.observer.noteSessionEvent(event);
  h.ticks.forEach((tick) => tick());
  await settle();

  const stats = h.observer.stats();
  assert.ok(stats.upkeepEvents > 0, 'events were applied, not just enqueued');
  assert.ok(
    stats.upkeepSegments > 0,
    `the content events must become segments (upkeepEvents=${stats.upkeepEvents} upkeepEmpty=${stats.upkeepEmpty})`,
  );
  assert.ok(stats.graphSegments > 0, 'and the graph holds them');
  // Four content events: the user message, the assistant message, the tool call and the tool result.
  assert.equal(stats.upkeepSegments, 4, `expected four segments, got ${stats.upkeepSegments}`);
  // Lifecycle events produce nothing and are counted as such, so the ratio stays visible.
  assert.ok(stats.upkeepEmpty >= 4, `lifecycle events are counted as empty, got ${stats.upkeepEmpty}`);
});

test('a turn boundary drains the queue, so the last message of a turn is not left behind', async () => {
  const h = harness();
  // Only the tail of a turn: the assistant message and the boundary that follows it. This is the shape a short
  // session has, and the shape where the model's own message used to stay queued while the session ended.
  h.observer.noteSessionEvent({
    type: 'assistant/message',
    seq: 1,
    data: { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '1. alpha\n2. beta' }] } },
  });
  assert.equal(h.observer.stats().upkeep.pending, 1, 'queued, not yet applied');
  h.observer.noteSessionEvent({ type: 'turn/end', turn: 1 });
  await settle();
  assert.equal(h.observer.stats().upkeep.pending, 0, 'the boundary drained it');
  assert.ok(h.observer.stats().upkeepSegments > 0, 'and it became a segment');
});

test('the plan gate is offered the model\'s output once the turn drains', async () => {
  const h = harness({ withGate: true });
  for (const event of sessionEvents()) h.observer.noteSessionEvent(event);
  h.ticks.forEach((tick) => tick());
  await settle();

  assert.ok(h.seenByGate.length > 0, 'the gate was offered the model\'s output');
  assert.ok(
    h.seenByGate.some((t) => t.includes('inventory the layout')),
    'including the plan, which arrives merged with the reasoning part',
  );
  assert.ok(!h.seenByGate.some((t) => t.includes('inspect this repository')), 'never the user\'s own message');
});

test('a batch scorer is called for the window once there is a previous segment to score against', async () => {
  const h = harness({ withScorer: true });
  for (const event of sessionEvents()) h.observer.noteSessionEvent(event);
  h.ticks.forEach((tick) => tick());
  await settle();

  assert.ok(h.scored.length > 0, 'the batch scorer ran: this is the live System-1 path');
  const stats = h.observer.stats();
  assert.ok(stats.upkeepScoredPairs > 0, 'and the pairs are counted');
  assert.ok(stats.graphEdges > 0, 'a weight above the threshold produced an edge');
});

test('the session-content stream is fed the RawEvents that entered the graph, and only those', async () => {
  const h = harness({ withSession: true });
  for (const event of sessionEvents()) h.observer.noteSessionEvent(event);
  h.ticks.forEach((tick) => tick());
  await settle();

  // The whole point of the session stream is that it is a record of what was actually said, written from the same
  // adapted events the graph consumed. A declared-but-unwritten sink was the old gap; if this array is empty the
  // wiring regressed. Four content events, no lifecycle events.
  assert.equal(h.session.length, 4, `expected four session lines, got ${h.session.length}`);
  const ids = h.session.map((e) => e.id).sort();
  assert.deepEqual(ids, ['a1', 'c1', 'r1', 'u1'], 'the user msg, assistant msg, tool call and tool result');
  // seq comes from the envelope, so the file is replayable in the host's own order, not the plugin's arrival order.
  assert.deepEqual(h.session.map((e) => e.seq), [3, 4, 5, 6], 'host log sequence, in order');
  assert.ok(!h.session.some((e) => e.kind === 'systemPinned'), 'lifecycle/system notices are not conversation');
});

/**
 * S1CAP's own delivered blocks stop at ingestion, and the session file still records them.
 *
 * The delivered block is appended to the session log by the harness, so it comes back on this stream as an
 * ordinary user message on the next event. Letting it become a segment would put S1CAP's own text into the
 * graph, and from there into the recall candidates, the verbatim tail, and `fullTokens` — the denominator of
 * `wouldSaveTokens`, which would make the headline saving self-referential. The session file is a different
 * thing: it is a faithful record of what the session said, so the block belongs there even while it is not
 * something S1CAP measures. Those two statements are the whole test, and the tension between them is why it
 * exists.
 */
test('a delivered context block never becomes a segment, but the session file still records it', async () => {
  const h = harness({ withSession: true });
  const events = sessionEvents();
  // Exactly what the harness logs when a delivered block is appended: our marker id, a user message.
  const delivered = {
    type: 'user/message',
    data: {
      id: 's1cap-895b6ae1',
      role: 'user',
      content: [{ type: 'text', text: '# context assembled for this step\n## state proxy T\n…' }],
    },
  };
  for (const event of [...events, delivered]) h.observer.noteSessionEvent(event);
  h.ticks.forEach((tick) => tick());
  await settle();

  // Not measured: no segment, so no tokens in the baseline and nothing for relevance to select.
  const stats = h.observer.stats();
  assert.equal(stats.upkeepSegments, 4, 'four content segments, the delivered block excluded');
  assert.equal(stats.upkeepSelfDropped, 1, 'and the drop is reported, not silent');
  assert.equal(stats.graphSegments, 4, 'the graph holds the session, not our own addition to it');
  // Still recorded: the session file describes the session, not S1CAP's view of it.
  assert.ok(
    h.session.some((e) => e.id === 's1cap-895b6ae1'),
    `the delivered block is in the session file: ${JSON.stringify(h.session.map((e) => e.id))}`,
  );
  assert.equal(h.session.length, 5, 'four content events plus the delivered block');
});
