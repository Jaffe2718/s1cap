/**
 * The bounded anchor wait (`recall.anchorWaitMs`): a step waits for the newest `user` segment's own scoring row,
 * and only for that row.
 *
 * Why this needs its own file. Scoring runs asynchronously in the upkeep queue, off the step's critical path, and a
 * measured System-1 relevance call takes a median of 15.3 s against the local backend. A step can therefore reach
 * assembly before the segment it recalls from has any scored edges, and BFS recall then returns nothing at all.
 * The wait is the cheaper first remedy; the fail-open rule in `assemble()` (`unjudgedWithin` / `unknownAdmitted`) is
 * the backstop and is tested where it lives.
 *
 * The sleep is *injected* because the observer keeps no clock of its own (step-observer.ts): a caller that does not
 * supply one reaches the wait with an immediate resolve, so no test here ever sleeps for real. Supplying one is what
 * makes "did it wait" observable rather than a matter of timing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { AssociationGraph, defaultPolicy } from '@s1cap/core';
import { createStepObserver } from '../src/step-observer.ts';
import type { StepObserver } from '../src/step-observer.ts';

const SESSION = 'S';
const T0 = 1_790_000_000_000;

/**
 * The single user turn the "no wait" fixture uses.
 *
 * It is the whole payload on purpose: with nothing in front of it, the user turn is the graph's first segment and
 * `unjudgedWithin` - which only looks backwards - has nothing to report. The same payload with a system prompt in
 * front of it *does* wait, because that prompt is an unjudged predecessor, which is what the other tests rely on.
 */
const LONE_TURN = [
  { id: 'u1', role: 'user', content: [{ type: 'text', text: 'Fix the failing test in auth.ts' }] },
];

interface Harness {
  observer: StepObserver;
  /** every `sleep(ms)` the observer asked for, in order */
  slept: number[];
  /** every probe line the observer wrote */
  probes: Record<string, unknown>[];
  warns: string[];
}

/** A promise whose settlement the test decides, so a scoring call can be held in flight on purpose. */
function deferred(): { promise: Promise<readonly number[]>; resolve: (value: readonly number[]) => void } {
  let resolve: (value: readonly number[]) => void = () => undefined;
  const promise = new Promise<readonly number[]>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/**
 * An observer with an injected sleep, and a graph the test can score the way a System-1 call would.
 *
 * `advanceMs` and `answer` are the two halves of what a sleep stands in for. The wait's own `queue.drain()` is
 * synchronous; a System-1 scoring call is not, and that is the whole reason the loop needs a sleep between polls. So
 * a sleep here moves the injected clock, and - unless the test says otherwise - performs the scoring pass the drain
 * could not await. `advanceMs` decides which side of the deadline the wait ends on, and the two interesting outcomes
 * need opposite clocks: "the row completed" and "the budget is gone".
 *
 * The graph is reached through `rgStore`, which is the only seam the observer offers for a graph the test can hold:
 * it is asked for the session's snapshot when the step begins and told about it whenever the step changes it. Taking
 * a *copy*, as this does, is enough to answer the wait's question - `scoreNew` and `unjudgedWithin` read an order, a
 * set of scores and a cursor, and the snapshot carries all three.
 */
function harness(opts: {
  advanceMs?: number;
  anchorWaitMs?: number;
  answer?: boolean;
  seed?: AssociationGraph;
  /** a batch scorer that never answers, so a scoring call stays in flight for the whole wait */
  stall?: boolean;
} = {}): Harness {
  const slept: number[] = [];
  const probes: Record<string, unknown>[] = [];
  const warns: string[] = [];
  let persisted: unknown = opts.seed?.snapshot();
  const stalled = deferred();
  const ticks = { value: T0 };
  const policy = defaultPolicy();
  if (opts.anchorWaitMs !== undefined) policy.recall.anchorWaitMs = opts.anchorWaitMs;
  const observer = createStepObserver({
    policy,
    // The observer's fallback session: this fixture's payloads carry no `agent.session.id`, so without it the graph
    // would be created under the literal `'unassigned'` and the store below would never be asked for anything.
    sessionId: SESSION,
    emit: () => undefined,
    now: () => ticks.value,
    contextWindow: 128_000,
    reserveOutputTokens: 8_000,
    fixedOverheadTokens: 1_200,
    lambdaMs: 36 * 60 * 60 * 1000,
    // A System-1 call that has not answered. It is what makes the wait's "is anything in flight" question answer yes -
    // the queue counts an event as applied the moment its async handler is entered, so it cannot tell a call that will
    // take fifteen seconds from one that has already returned.
    ...(opts.stall === true ? { scoreBatch: () => stalled.promise } : {}),
    onWarn: (message) => warns.push(message),
    onProbe: (line) => probes.push(line),
    // A no-op scheduler: the queue is only drained by the wait itself, so the test controls when upkeep runs.
    schedule: () => undefined,
    rgStore: {
      // The seeded graph, when the fixture has one. The step's own segments are added to the graph the observer built
      // from this snapshot, and `persist` below captures that graph before the first poll - so the sleep is scoring the
      // same order the wait is reading.
      load: () => persisted as never,
      persist: (_sessionId: string, snapshot: never) => {
        persisted = snapshot;
        return true;
      },
      sessions: () => [SESSION],
    },
    sleep: async (ms: number) => {
      slept.push(ms);
      ticks.value += opts.advanceMs ?? 1;
      if (opts.answer !== false && persisted !== undefined) {
        // The scoring the drain could not await, with the local lexical scorer standing in for the backend. This is
        // the same `scoreNew` upkeep calls, and it is what writes the anchor's row.
        const graph = AssociationGraph.fromSnapshot(persisted as never);
        await graph.scoreNew({ windowN: policy.recall.window, threshold: policy.recall.threshold });
        persisted = graph.snapshot();
      }
    },
  });
  return { observer, slept, probes, warns };
}

test('a step whose anchor row is already complete does not wait at all', async () => {
  // The common case, and the reason the wait is an exception path rather than a per-step cost: the anchor is the
  // graph's first segment and `unjudgedWithin` only ever looks backwards, so there is nothing unknown to poll for.
  const h = harness({ anchorWaitMs: 10_000 });
  const observation = await h.observer.observe({ sessionId: SESSION, messages: LONE_TURN, step: 1 });

  const stats = h.observer.stats();
  assert.equal(stats.observed, 1, 'the step was observed');
  assert.equal(stats.errors, 0, `no contained failure: ${stats.lastError}`);
  assert.ok(observation !== undefined, 'the step assembled');
  assert.deepEqual(h.slept, [], 'an already-scored anchor row must not cost a single sleep');
  assert.equal(
    h.probes.filter((p) => p.kind === 'anchor-wait').length,
    0,
    'and nothing is reported, because nothing was unknown',
  );
});

test('wait=0 disables the wait entirely', async () => {
  // A researcher turning the wait off must get the step's own timing back: the check returns before it reads the
  // graph at all, so nothing is drained, polled or reported.
  const h = harness({ anchorWaitMs: 0 });
  const observation = await h.observer.observe({ sessionId: SESSION, messages: LONE_TURN, step: 1 });
  assert.ok(observation !== undefined, 'the step assembled');
  assert.deepEqual(h.slept, []);
  assert.deepEqual(h.warns, []);
  assert.deepEqual(h.observer.stats().upkeep.applied, 0, 'and the queue was not drained by the step path');
});

/**
 * The fixture the two remaining tests share, and the constraints that shaped it - none of which were obvious, and all
 * of which cost a rejected attempt:
 *
 *   - `unjudgedWithin` only looks *backwards* from the anchor, so a user turn at index 0 of the graph has nothing to
 *     wait for however long the wait is set to. The anchor needs a predecessor.
 *   - `scoreNew` walks the graph in order and scores each segment against the segments *before* it, so a segment that
 *     is already in the graph and has not been processed keeps a row that a later pass may or may not fill. Seeding
 *     the graph through `rgStore` is what puts such a segment there.
 *   - the anchor is `window[anchor]`, where `anchor` indexes the payload's segments and `window` is the graph's order.
 *     The two only coincide when the graph's order *ends* with the payload's segments, so the payload here is a suffix
 *     of the seeded graph. A payload that carries a brand-new message instead makes the anchor come out as the seeded
 *     graph's first segment, and the wait then reports nothing.
 *
 * The result is close to the live shape: the conversation is already in the graph, the step carries the task, and the
 * anchor's row is what may or may not be scored by the time assembly asks for it.
 */
function seededGraph(): AssociationGraph {
  const graph = new AssociationGraph();
  graph.addSegments([
    { id: 'sys', sessionId: SESSION, kind: 'systemPinned', seq: 0, ts: T0, tokens: 12, text: 'You are a coding agent working in a repository.' },
    { id: 'u1', sessionId: SESSION, kind: 'user', seq: 1, ts: T0, tokens: 6, text: 'Fix the failing test in auth.ts' },
    { id: 'r1', sessionId: SESSION, kind: 'assistant', seq: 2, ts: T0, tokens: 5, text: 'the comparison is off by one' },
  ]);
  return graph;
}

/**
 * The seeded conversation's own tail, so the anchor index lands on a segment that has a predecessor.
 *
 * The shape of this payload is dictated by an index-space detail in `observeStep` that is worth stating, because a
 * fixture that ignores it passes while proving nothing: the anchor is `window[anchor]`, where `anchor` is the position
 * of the payload's last user turn *within the payload* and `window` is the graph's ordered segments. Those two spaces
 * only agree when the graph's order starts where the payload's does - which is not the case for a session that resumed
 * from a snapshot. So the payload here starts with a non-user segment, which puts its user turn at index 1 and makes
 * `window[1]` the seeded user turn. A payload of `[u1]` alone would put the anchor on `window[0]`, the seeded system
 * prompt, and the wait would then correctly report that a segment with no predecessors has nothing to wait for.
 */
const SEEDED_TAIL = [
  { id: 'r1', role: 'assistant', content: [{ type: 'reasoning', text: 'the comparison is off by one' }] },
  { id: 'u1', role: 'user', content: [{ type: 'text', text: 'Fix the failing test in auth.ts' }] },
];

/**
 * One lifecycle event, which the queue applies without producing a segment.
 *
 * It exists so the wait's `queue.drain()` has something to do, because that drain is where upkeep calls `scoreNew` -
 * so a queued event is the only way a unit test can make the wait own the queue at all.
 */
function queueOneUpkeepEvent(h: Harness): void {
  h.observer.noteSessionEvent({ type: 'step/start', seq: 1, data: { turn: 1, step: 1 } });
}

test('a wait that reaches its deadline proceeds, and reports the remainder exactly once', async () => {
  // The case the wait exists for and cannot fix: the scoring call is still in flight when the budget is gone. Two
  // things have to be true for the wait to run at all, and both are deliberate here - a scoring call that has not
  // answered (the `stall` scorer), and the queue event that starts it. Without the first, the wait correctly refuses to
  // wait at all, because an idle queue with nothing in flight can only be answered by time passing.
  //
  // It must not throw, the step must still be observed, and the fail-open rule in `assemble()` is what admits the
  // pairs - so the number in the diagnostic is what explains the record's `unknownAdmitted` rather than leaving it to
  // be inferred from a graph dump.
  const h = harness({ anchorWaitMs: 1_000, advanceMs: 2_000, seed: seededGraph(), stall: true });
  queueOneUpkeepEvent(h);
  const observation = await h.observer.observe({ sessionId: SESSION, messages: SEEDED_TAIL, step: 1 });

  assert.deepEqual(h.slept, [50], 'it polled once before giving up');
  const stats = h.observer.stats();
  assert.equal(stats.errors, 0, `giving up is not a failure: ${stats.lastError}`);
  assert.equal(stats.observed, 1, 'and the step was still observed');
  assert.ok(observation !== undefined, 'the step assembled from the graph as it stood');
  assert.equal(stats.upkeep.pending, 0, 'the drain inside the wait consumed the queue event');

  // One line for the whole wait. `warns` also carries the observer's "resumed its graph" notice, which is why the
  // count is taken over the wait's own lines rather than over everything the run said.
  const giveUps = h.warns.filter((w) => w.includes('anchor wait gave up'));
  assert.equal(giveUps.length, 1, `exactly one diagnostic, not one per poll: ${JSON.stringify(h.warns)}`);
  assert.match(
    giveUps[0] ?? '',
    /anchor wait gave up after 1000ms \(2 drain\(s\)\): 1 pair\(s\) inside the window still unjudged/,
  );
  const lines = h.probes.filter((p) => p.kind === 'anchor-wait');
  assert.equal(lines.length, 1, 'one probe line for the whole wait');
  assert.deepEqual(lines[0], { schema: 0, kind: 'anchor-wait', ms: 1_000, polls: 2, unknown: 1 });
});

test('an idle queue with nothing in flight is not waited on at all', async () => {
  // The guard that keeps the wait off the critical path when it cannot help. The anchor's row is unjudged and the graph
  // is exactly the one that made the test above wait; what is different is that no scoring call is running and nothing
  // is queued, so no amount of waiting could complete the row. The diagnostic is still written - the fail-open rule is
  // about to admit the pairs, and the record has to say so - but the step pays one check and no sleep.
  const h = harness({ anchorWaitMs: 10_000, seed: seededGraph() });
  const observation = await h.observer.observe({ sessionId: SESSION, messages: SEEDED_TAIL, step: 1 });

  assert.deepEqual(h.slept, [], 'nothing to wait for: no sleep at all');
  const stats = h.observer.stats();
  assert.equal(stats.errors, 0, `standing down is not a failure: ${stats.lastError}`);
  assert.equal(stats.observed, 1, 'the step was observed');
  assert.ok(observation !== undefined, 'and it assembled');
  assert.equal(stats.upkeep.applied, 0, 'no queue work was applied, because there was none');
  assert.equal(h.warns.filter((w) => w.includes('anchor wait gave up')).length, 1, 'the remainder is still reported');
});

/**
 * "Complete" means the backend judged the row, not that a number is there.
 *
 * The two tests below differ in one field and nothing else: both seed the same pair with the same weight, and only
 * `source` changes. That is the whole rule - a failed System-1 call still writes a lexical score, so asking whether a
 * number exists made the wait stand down through exactly the round it was written for (191 of 281 `s1_call` records
 * failed, `unknownAdmitted` never fired, 11 of 49 assemblies fell back to recency). Testing one direction only would
 * pass on a rule that waits forever or on one that never waits.
 */
test('a row the lexical fallback wrote is not a complete row: the wait still reports the remainder', async () => {
  const seed = seededGraph();
  // The shape of a failed System-1 call: the batch scorer returns `undefined`, and `scoreNew` scores the window with
  // the local fallback, recording `source: 'lexical'`.
  await seed.scoreNew({ windowN: 1024, threshold: 0.55, scoreBatch: () => undefined });
  const h = harness({ anchorWaitMs: 10_000, seed });
  const observation = await h.observer.observe({ sessionId: SESSION, messages: SEEDED_TAIL, step: 1 });

  assert.ok(observation !== undefined, 'the step assembled');
  assert.deepEqual(h.slept, [], 'nothing is running that could judge the row, so no sleep is spent');
  const giveUps = h.warns.filter((w) => w.includes('anchor wait gave up'));
  assert.equal(giveUps.length, 1, `a fallback row leaves the pair unjudged: ${JSON.stringify(h.warns)}`);
  assert.match(giveUps[0] ?? '', /1 pair\(s\) inside the window still unjudged/);
  assert.deepEqual(
    h.probes.filter((p) => p.kind === 'anchor-wait'),
    [{ schema: 0, kind: 'anchor-wait', ms: 10_000, polls: 0, unknown: 1 }],
    'and the count the fail-open rule will admit is reported',
  );
});

test('a row the backend judged is a complete row: the wait does not run at all', async () => {
  const seed = seededGraph();
  // Same weight, same pair, different provenance: the backend answered this window.
  await seed.scoreNew({
    windowN: 1024,
    threshold: 0.55,
    scoreBatch: async (_current, candidates) => candidates.map(() => 0.9),
  });
  const h = harness({ anchorWaitMs: 10_000, seed });
  const observation = await h.observer.observe({ sessionId: SESSION, messages: SEEDED_TAIL, step: 1 });

  assert.ok(observation !== undefined, 'the step assembled');
  assert.deepEqual(h.slept, [], 'a judged row costs no sleep');
  assert.equal(h.warns.filter((w) => w.includes('anchor wait gave up')).length, 0, 'and nothing is reported');
  assert.equal(h.probes.filter((p) => p.kind === 'anchor-wait').length, 0, 'not even a probe line');
});
