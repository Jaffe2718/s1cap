/**
 * THE ANCHOR'S ROW IS CAUSED, NOT WAITED FOR
 *
 * `packages/core/test/anchor-priority.test.ts` states the graph half: a sweep told which entry is the anchor offers
 * that row first, and settling it does not move the cursor. This file states the plugin half, through the observer
 * that production runs: **the bounded anchor wait must be able to make the row happen, not only to hope for it.**
 *
 * Round `20261004-1239` (cell C2) is why. Its tape carries 26 `anchor-wait` lines: step 1 stood down, steps 2-8
 * `completed`, and steps **9-26 `gave-up`** after ~160 polls (10 s) with `unknown` climbing 54, 65, 74 … 224 - the
 * anchor's own window, unjudged. The wait was running; the row was not being scored, because upkeep walks the
 * append order from its oldest unsettled entry and the cursor had stalled at 106 of 228. Every one of those steps
 * then took the fail-open path: `candidates` 0, `unknownAdmitted` = `selected` (40 = 40 … 126 = 126), and on the
 * last assembly 21,755 recalled tokens - 91 % of the prompt.
 *
 * The fixture is that shape in miniature. The backend answers the anchor's own row and **defers every other
 * window** (`S1_DEFERRED`), so the cursor cannot advance past it and the anchor is unreachable by the cursor's
 * order however long the step waits. Before this change the step could only fail open; after it, the wait names the
 * anchor to a sweep (`scoreNew({ anchorId })`), that row is offered first, and the walk has edges to expand into.
 *
 * The clock is injected (`sleep`), as everywhere in this suite: a test that slept through a real `anchorWaitMs`
 * would be paying ten seconds per assertion, and the deadline is read from the sleeps the wait asked for.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { AssociationGraph, S1_DEFERRED, defaultPolicy } from '@s1cap/core';
import type { RgSnapshot, Segment } from '@s1cap/core';

import { createStepObserver } from '../src/step-observer.ts';
import type { StepObserver } from '../src/step-observer.ts';

const SESSION = 'S';
const T0 = 1_790_000_000_000;
/** How many segments the conversation already holds. The anchor's own row is this many pairs. */
const SEED = 12;
/** The step's newest input event, which is the anchor: a `user` segment the payload carries by id. */
const ANCHOR = 'q1';

/** The conversation the step re-carries none of, so the anchor is the step's own message and sits last. */
function seededGraph(): AssociationGraph {
  const graph = new AssociationGraph();
  const segments: Segment[] = Array.from({ length: SEED }, (_unused, i) => ({
    id: `s${String(i)}`,
    sessionId: SESSION,
    kind: i === 0 ? 'user' : 'trace',
    seq: i,
    ts: T0,
    tokens: 5,
    text: `history segment ${String(i)}`,
  }));
  graph.addSegments(segments);
  return graph;
}

interface Harness {
  observer: StepObserver;
  /** every window the backend was asked about, as `${current}:${candidates}` - one string per offer */
  asked: string[];
  /** the sleeps the wait asked for: how the deadline is read without a real clock */
  slept: number[];
  probes: Record<string, unknown>[];
  warns: string[];
  /** Final walk telemetry is asynchronous even after the anchor unblocks assembly. */
  walkCompleted: Promise<void>;
  /** the graph as the step left it, from the observer's own persistence calls */
  persisted(): RgSnapshot;
  /** let the row the fixture is holding open resolve - see `holdFirstRow` */
  releaseRow(): void;
}

function harness(opts: { anchorWaitMs?: number; advanceMs?: number; holdFirstRow?: boolean } = {}): Harness {
  const asked: string[] = [];
  const slept: number[] = [];
  const probes: Record<string, unknown>[] = [];
  const warns: string[] = [];
  let completeWalk: () => void = () => undefined;
  const walkCompleted = new Promise<void>((resolve) => { completeWalk = resolve; });
  const ticks = { value: T0 };
  let persisted: RgSnapshot = seededGraph().snapshot();
  // The row the fixture may hold open, so a test can pin what the step did *while* a scoring call was in flight.
  let releaseRow: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    releaseRow = resolve;
  });
  const policy = defaultPolicy();
  policy.recall.depth = 1; // This fixture isolates anchor priority, not deeper background expansion.
  if (opts.anchorWaitMs !== undefined) policy.recall.anchorWaitMs = opts.anchorWaitMs;
  const observer = createStepObserver({
    policy,
    sessionId: SESSION,
    emit: () => undefined,
    now: () => ticks.value,
    contextWindow: 128_000,
    reserveOutputTokens: 8_000,
    fixedOverheadTokens: 1_200,
    lambdaMs: 36 * 60 * 60 * 1000,
    // The round's shape, in one rule: the anchor's own row is answered, and every row behind it is deferred. The
    // cursor therefore stops where it stands and the anchor is a row the cursor's order will never reach.
    scoreBatch: async (current: Segment, candidates: readonly Segment[]) => {
      asked.push(`${current.id}:${String(candidates.length)}`);
      if (current.id === ANCHOR) {
        if (opts.holdFirstRow === true) await held;
        return candidates.map(() => 0.9);
      }
      return S1_DEFERRED;
    },
    onWarn: (message) => warns.push(message),
    onProbe: (line) => {
      probes.push(line);
      if (line.kind === 'recall-demand') completeWalk();
    },
    // No timer: the only thing that drains the queue is the wait itself, which is what the test is measuring.
    schedule: () => undefined,
    rgStore: {
      load: () => persisted,
      persist: (_sessionId: string, snapshot: RgSnapshot) => {
        persisted = snapshot;
        return true;
      },
      sessions: () => [SESSION],
    },
    sleep: async (ms: number) => {
      slept.push(ms);
      // A real timer drains ready promises before advancing time. Model that
      // boundary so worker-pool bookkeeping is not charged fake seconds.
      await new Promise<void>((resolve) => setImmediate(resolve));
      ticks.value += opts.advanceMs ?? 6_000;
    },
  });
  return { observer, asked, slept, probes, warns, walkCompleted, persisted: () => persisted, releaseRow: () => releaseRow() };
}

/** One macrotask plus its microtasks: enough for the walk's unawaited promise chain to finish. */
async function settleAsync(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** One session event that arrives while the step is waiting, carrying content - so the drain runs a real sweep. */
function queuedContentEvent(): unknown {
  return {
    type: 'user/message',
    seq: 900,
    time: T0,
    data: { id: 'x900', role: 'user', content: [{ type: 'text', text: 'a segment that arrives during the wait' }] },
  };
}

/** The step's payload: one message, which is the anchor, and no `agent.session.id` (the observer's own id is used). */
const STEP_PAYLOAD = {
  step: 4,
  messages: [{ id: ANCHOR, role: 'user', content: [{ type: 'text', text: 'now make the parser reject trailing commas' }] }],
};

test('the walk buys the anchor row the cursor cannot reach, so the step is not empty', async () => {
  const h = harness();
  h.observer.noteSessionEvent(queuedContentEvent());
  const observation = await h.observer.observe(STEP_PAYLOAD);

  assert.ok(observation !== undefined, 'the step assembled');
  assert.equal(h.observer.stats().errors, 0, `no contained failure: ${h.observer.stats().lastError}`);

  // The offer order is the whole point of on-demand scoring: the anchor's own row is the *first* row the backend
  // is asked about, and it is asked because the step's walk needs it rather than because the segment arrived.
  assert.equal(h.asked[0], `${ANCHOR}:${String(SEED)}`, `the anchor row is offered first: ${JSON.stringify(h.asked)}`);
  // The sweep's oldest-first cursor work is deliberately *not* here any more: with the eager path removed, the
  // only rows bought are the ones a walk demands (`packages/dsh-plugin/src/step-observer.ts`'s queue handler).
  assert.equal(h.asked.includes('s1:1'), false, `nothing walks the cursor: ${JSON.stringify(h.asked)}`);

  // The row is judged before `assemble()` reads the graph, so the walk has edges to expand into and the fail-open
  // rule has nothing to admit. This is the failure the round measured: `candidates: 0` and `unknownAdmitted` equal
  // to `selected` on 19 of its 26 assemblies.
  assert.equal(observation.event.candidates, SEED, 'every predecessor of the anchor is a candidate');
  assert.ok(observation.event.selected > 0, 'and the block is filled from the walk');
  assert.equal(
    'unknownAdmitted' in observation.event,
    false,
    `nothing was admitted unjudged: ${JSON.stringify(observation.event)}`,
  );

  // The record says which kind of wait it was. `gaveUp: false` with `unknown: 0` is a wait that won; `started`
  // says the wait owns the walk that bought the row.
  const line = h.probes.find((probe) => probe.kind === 'anchor-wait');
  assert.ok(line !== undefined, 'the wait reports its outcome');
  assert.equal(line['outcome'], 'completed');
  assert.equal(line['unknown'], 0);
  assert.equal(line['started'], true, 'the wait started the walk that scored the row');
  assert.equal(h.warns.filter((warn) => warn.includes('anchor wait gave up')).length, 0, 'and it never gave up');

  assert.equal(h.persisted().scores?.length, SEED, 'anchor scores are persisted when the step returns');

  // The walk's own line, which is where a round reads what the demand cost (`rows`, `pairs`) and what it got
  // (`judged`, `missed`) - the numbers that make the saving visible instead of inferred from a smaller total.
  // Per-row publication unblocks the step before the whole walk settles. Only
  // the final telemetry assertion waits for that completion, not the step above.
  await h.walkCompleted;
  const demand = h.probes.find((probe) => probe.kind === 'recall-demand');
  assert.ok(demand !== undefined, 'the walk reports what it asked for');
  assert.equal(demand['rows'] >= 1, true, `at least the anchor's row: ${JSON.stringify(demand)}`);
  assert.equal(demand['judged'] >= SEED, true, `the anchor's ${String(SEED)} pairs were judged`);

  // **The cursor invariant, and it changed meaning with the design.** It used to read 1 here because the eager
  // sweep settled entry 0 (a segment with no window) on its way to the anchor. Nothing walks the cursor now, so
  // `#scored` - the contiguous settled *prefix* - is 0 while the walk's rows settle above it out of order; that is
  // the invariant holding, not a regression. What says work was paid for is `scores`.
  assert.equal(h.persisted().scored, 0, 'no eager sweep advanced the cursor, and the demand walk never moves it');
  assert.equal(h.persisted().scores?.length, SEED, `the graph holds the anchor's ${String(SEED)} pairs: ${String(h.persisted().scores?.length)}`);
  assert.ok((h.persisted().demandPairs ?? 0) >= SEED, 'and the snapshot says how those pairs were bought');
});

test('with no backend to judge the row, nothing is waited for - and the graph is still scored locally', async () => {
  // The stand-down, restated. Without a batch scorer every row the walk writes is lexical and `unjudgedWithin`
  // does not count those as judged (a failed System-1 call writes one too), so waiting could only be answered by
  // time passing: no sleep is spent, and the line says `not-started`.
  //
  // **What changed is what the graph holds afterwards.** Under eager scoring the queue's `scoreNew` fallback filled
  // the graph as segments arrived; with that path removed, the *walk* is what scores without a backend, locally and
  // synchronously - which is why this fixture's recall is now filled from the graph instead of fail-opening. A
  // session with no System-1 lane keeps working, and the recall it gets is the lexical one it always had.
  const asked: string[] = [];
  const probes: Record<string, unknown>[] = [];
  const ticks = { value: T0 };
  let persisted: RgSnapshot | undefined;
  const observer = createStepObserver({
    policy: defaultPolicy(),
    sessionId: SESSION,
    emit: () => undefined,
    now: () => ticks.value,
    contextWindow: 128_000,
    reserveOutputTokens: 8_000,
    fixedOverheadTokens: 1_200,
    lambdaMs: 36 * 60 * 60 * 1000,
    onProbe: (line) => probes.push(line),
    schedule: () => undefined,
    rgStore: {
      load: () => seededGraph().snapshot(),
      persist: (_sessionId: string, snapshot: RgSnapshot) => {
        persisted = snapshot;
        return true;
      },
      sessions: () => [SESSION],
    },
    sleep: async (ms: number) => {
      ticks.value += ms;
      asked.push(`slept:${String(ms)}`);
    },
  });
  const observation = await observer.observe(STEP_PAYLOAD);

  assert.ok(observation !== undefined, 'the step assembled from the lexical graph');
  assert.deepEqual(asked, [], 'nothing was waited for, because nothing could judge the row');
  const line = probes.find((probe) => probe.kind === 'anchor-wait');
  assert.equal(line?.['outcome'], 'not-started');
  assert.equal(line?.['started'], false);
  assert.match(String(line?.['unknown'] ?? ''), /^\d+$/, 'and it reports the pairs the backend never judged');
  // The local walk still scored the row - which is what keeps a session with no System-1 lane populated, and what
  // the queue's own fallback used to do as segments arrived. It is a *lexical* row: written, and not a judgement,
  // which is why the fail-open rule below is unchanged.
  const demand = probes.find((probe) => probe.kind === 'recall-demand');
  assert.equal(demand?.['pairs'], SEED, `the walk scored the anchor's whole window locally: ${JSON.stringify(demand)}`);
  assert.equal(demand?.['judged'], 0, 'and the backend judged none of it');
  assert.equal(persisted?.scores?.length, SEED, 'the lexical row is in the graph the step persisted');
  // And the step's own reading is exactly what it was: the fixture's anchor shares no tokens with its history, so
  // nothing clears `tau`, the walk finds no candidates, and the fail-open rule admits the window as the backstop.
  assert.equal(observation.event.candidates, 0, 'no lexical weight cleared the threshold');
  assert.equal(observation.event.unknownAdmitted, SEED - defaultPolicy().tail.k, 'fail-open excludes the verbatim tail');
});

test('wait=0 disables the wait entirely: no sleep, no line - and the walk still buys the row', async () => {
  // `anchorWaitMs = 0` keeps its meaning: the step does not wait. It does not disable the *recall*, which is the
  // whole of on-demand scoring - scoring starts when the BFS recall is called - so the walk is started and its
  // first row is in flight while the step assembles. The fixture holds that row open on purpose, so which of the
  // two happened is pinned rather than left to the order of two microtask chains.
  const h = harness({ anchorWaitMs: 0, holdFirstRow: true });
  h.observer.noteSessionEvent(queuedContentEvent());
  const observation = await h.observer.observe(STEP_PAYLOAD);

  assert.ok(observation !== undefined, 'the step assembled');
  assert.deepEqual(h.slept, [], 'the researcher who turns the wait off gets the step timing back');
  assert.equal(h.probes.filter((probe) => probe.kind === 'anchor-wait').length, 0, 'and nothing is reported');
  assert.equal(observation.event.candidates, 0, 'the step assembles from the graph as it stands');
  assert.equal(observation.event.unknownAdmitted, SEED - defaultPolicy().tail.k, 'fail-open does not duplicate the tail');
  // The row was asked for anyway, and the step did not wait for it: that is the difference between "do not wait"
  // and "do not score", and it is the reason `0` is not a way to switch the lane off.
  assert.equal(h.asked[0], `${ANCHOR}:${String(SEED)}`, `the row is in flight: ${JSON.stringify(h.asked)}`);

  // Release it, and the walk finishes in the background: the row is settled and persisted even though the step
  // that asked for it had already assembled.
  h.releaseRow();
  await settleAsync();
  assert.equal(h.persisted().scores?.length, SEED, 'the row landed after the step, and the graph kept it');
});
