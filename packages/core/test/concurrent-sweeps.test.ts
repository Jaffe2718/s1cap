/**
 * CONCURRENT SWEEPS AND THE CLAIM
 *
 * `AssociationGraph.scoreNew` is called from an upkeep handler that the queue does **not** await
 * (`packages/core/src/upkeep-queue.ts`, `runOne`), and the observer drains every queued event synchronously at
 * `turn/end` and inside the anchor wait, so a burst of N session events starts N concurrent sweeps over one
 * graph. Until 2026-10-05 each sweep read `#scored` once at entry and then walked forward, writing the shared
 * cursor as it took each segment, so two sweeps whose walks overlapped scored the same segment. Round
 * `20261004-0233` (cell C2) measured what that costs, from its own artifacts: `scoredPairs` 10 157 against
 * **2 211 distinct pairs** in `scores` - a complete triangle over the first 67 segments, nothing missing and
 * nothing outside it - for **9 828 questions** sent to the backend. 486 of the 634 calls were re-asks.
 *
 * These tests state the property that made it possible: N sweeps in flight hold N *distinct* entries, an entry
 * is offered once, and no exit path can leave an entry owned by a sweep that has gone away.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { AssociationGraph, S1_DEFERRED } from '../src/assoc-graph.ts';
import type { Segment } from '../src/types.ts';

function segment(id: string, seq: number): Segment {
  return { id, sessionId: 's', kind: 'user', text: `text of ${id}`, tokens: 4, ts: seq, seq };
}

/** A graph of `n` segments, added in order. */
function graphOf(n: number): AssociationGraph {
  const graph = new AssociationGraph();
  graph.addSegments(Array.from({ length: n }, (_unused, i) => segment(`s${String(i)}`, i)));
  return graph;
}

test('sweeps in flight hold distinct entries: no pair is offered twice', async () => {
  const graph = graphOf(12);
  /** Every pair this scorer was asked about, in the order it was asked. */
  const asked: string[] = [];
  // The scorer suspends *after* recording, so every sweep is genuinely in flight with its entry held while the
  // others take theirs - which is the shape the upkeep queue produces.
  const scorer = async (current: Segment, candidates: readonly Segment[]): Promise<readonly number[]> => {
    for (const candidate of candidates) asked.push(`${candidate.id}->${current.id}`);
    await new Promise((resolve) => setImmediate(resolve));
    return candidates.map(() => 0.9);
  };

  // Eight concurrent sweeps, as `admissionLimit: 8` and a drained event burst produce.
  await Promise.all(Array.from({ length: 8 }, () => graph.scoreNew({ windowN: 1024, threshold: 0.55, scoreBatch: scorer })));

  const distinct = new Set(asked);
  assert.equal(distinct.size, asked.length, `every pair offered once, got ${String(asked.length)} offers of ${String(distinct.size)} pairs`);
  // T(T-1)/2 = 66 pairs of twelve segments, and every one of them offered.
  assert.equal(distinct.size, 66);
  assert.equal(graph.scoreCount, 66, 'and the graph keeps exactly one row per pair');
  assert.equal(graph.stats().scoredPairs, 66, 'the cumulative offer count is the pair count, not a multiple of it');
});

test('a deferred entry is offered again by a later sweep, and the count does not double', async () => {
  const graph = graphOf(4);
  const asked: string[] = [];
  let refuse = true;
  const scorer = async (current: Segment, candidates: readonly Segment[]): Promise<readonly number[] | typeof S1_DEFERRED> => {
    if (refuse) return S1_DEFERRED;
    for (const candidate of candidates) asked.push(`${candidate.id}->${current.id}`);
    await new Promise((resolve) => setImmediate(resolve));
    return candidates.map(() => 0.9);
  };

  // Two sweeps at once, both refused: each holds a different entry, and neither may swallow the other's.
  const refused = await Promise.all([
    graph.scoreNew({ windowN: 8, threshold: 0.55, scoreBatch: scorer }),
    graph.scoreNew({ windowN: 8, threshold: 0.55, scoreBatch: scorer }),
  ]);
  assert.equal(refused[0]?.scoredPairs, 0);
  assert.equal(refused[1]?.scoredPairs, 0);
  assert.equal(graph.scoreCount, 0, 'a refusal spends nothing, lexically or otherwise');
  assert.equal(graph.deferredPairs, 6, 'the whole backlog is still counted once, not once per refused sweep');

  refuse = false;
  await graph.scoreNew({ windowN: 8, threshold: 0.55, scoreBatch: scorer });
  assert.deepEqual(asked, ['s0->s1', 's0->s2', 's1->s2', 's0->s3', 's1->s3', 's2->s3'], 'every held-back window, and each pair once');
  assert.equal(graph.stats().scoredPairs, 6, 'the deferred pairs were offered once, not twice and not never');
  assert.equal(graph.deferredPairs, 6, 'and the deferral counter keeps what happened');
});

test('a scorer that throws gives its entry back: no segment is left unreachable', async () => {
  const graph = graphOf(4);
  const asked: string[] = [];
  let fail = true;
  const scorer = async (current: Segment, candidates: readonly Segment[]): Promise<readonly number[]> => {
    // A malformed batch is the throw the graph itself raises; it is the exit path that used to leave the cursor
    // advanced over an unscored segment.
    if (fail) return [];
    for (const candidate of candidates) asked.push(`${candidate.id}->${current.id}`);
    return candidates.map(() => 0.9);
  };

  await assert.rejects(() => graph.scoreNew({ windowN: 8, threshold: 0.55, scoreBatch: scorer }), /weights for/);
  assert.equal(graph.scoreCount, 0);
  fail = false;
  await graph.scoreNew({ windowN: 8, threshold: 0.55, scoreBatch: scorer });
  assert.deepEqual(asked, ['s0->s1', 's0->s2', 's1->s2', 's0->s3', 's1->s3', 's2->s3'], 'the entry the throw held is offered again, whole');
  assert.equal(graph.stats().scoredPairs, 6);
});

test('the per-sweep budget still bounds one call, and holds back the entries it did not offer', async () => {
  const graph = graphOf(6);
  const asked: string[] = [];
  const scorer = async (current: Segment, candidates: readonly Segment[]): Promise<readonly number[]> => {
    for (const candidate of candidates) asked.push(`${candidate.id}->${current.id}`);
    await new Promise((resolve) => setImmediate(resolve));
    return candidates.map(() => 0.9);
  };

  // Four concurrent sweeps sharing a four-pair budget each. Which call stops where is a scheduling artefact, so
  // the assertions are the invariants the budget must not break: no pair offered twice, no call offering more
  // than its budget, and nothing dropped - a later sweep with no budget reaches every remaining pair.
  const results = await Promise.all(
    Array.from({ length: 4 }, () => graph.scoreNew({ windowN: 64, threshold: 0.55, scoreBatch: scorer, maxPairsPerSweep: 4 })),
  );
  for (const result of results) assert.ok(result.scoredPairs <= 4, `one call offered ${String(result.scoredPairs)} pairs on a four-pair budget`);
  assert.equal(new Set(asked).size, asked.length, 'no pair offered twice, even with a budget in play');

  await graph.scoreNew({ windowN: 64, threshold: 0.55, scoreBatch: scorer });
  assert.equal(graph.scoreCount, 15, 'T(T-1)/2 = 15 pairs of six segments, each offered exactly once');
  assert.equal(graph.stats().scoredPairs, 15, 'the budget delayed work; it did not drop any');
});

test('a resume does not re-count the tail it had already counted as deferred', async () => {
  // `deferSegment` leaves `#deferralCounted` one past the last entry it counted, and a walk counts a whole
  // suffix, so what it reached is the end of the order - not the number of segments it counted. Restoring the
  // count put the marker inside the order and made the resumed graph count the same tail a second time.
  const graph = graphOf(6);
  await graph.scoreNew({ windowN: 64, threshold: 0.55, scoreBatch: () => S1_DEFERRED, maxPairsPerSweep: 4 });
  const first = graph.deferredPairs;
  assert.equal(first, 15, 'every window the refusal stopped in front of: 1 + 2 + 3 + 4 + 5 pairs');
  assert.equal(graph.deferredSegments, 5, 'and the entry with no window at all is settled, not deferred');

  const resumed = AssociationGraph.fromSnapshot(graph.snapshot());
  assert.equal(resumed.deferredPairs, first, 'the count survives the snapshot as it stood');
  const again = await resumed.scoreNew({ windowN: 64, threshold: 0.55, scoreBatch: () => S1_DEFERRED, maxPairsPerSweep: 4 });
  assert.equal(again.deferredPairs, 0, 'and a sweep that stops in the same place counts nothing new');
  assert.equal(resumed.deferredPairs, first, 'so the total is the omission, not the omission squared');
});

test('at the measured round\'s scale, eight concurrent sweeps ask each pair exactly once', async () => {
  // The round's shape, reproduced without a backend: 185 segments (round `20261004-0233`'s `order`), windows
  // that are the whole history because `w = 1024` never bound, `maxPairsPerSweep: 2048` as the plugin sets it,
  // and eight sweeps in flight as `admissionLimit: 8` and a drained event burst produce. The upkeep is then
  // driven the way the queue drives it - rounds of concurrent sweeps while anything is left.
  const SEGMENTS = 185;
  const graph = graphOf(SEGMENTS);
  let questions = 0;
  const scorer = async (current: Segment, candidates: readonly Segment[]): Promise<readonly number[]> => {
    questions += candidates.length;
    await new Promise((resolve) => setImmediate(resolve));
    return candidates.map(() => 0.9);
  };

  for (let round = 0; round < 200; round += 1) {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => graph.scoreNew({ windowN: 1024, threshold: 0.55, scoreBatch: scorer, maxPairsPerSweep: 2048 })),
    );
    if (results.every((r) => r.scoredPairs === 0)) break;
  }

  // Sum of min(i, w) over the arrival order = T(T-1)/2 here, because w = 1024 > 185.
  const pairs = (SEGMENTS * (SEGMENTS - 1)) / 2;
  assert.equal(graph.scoreCount, pairs, `every one of the ${String(pairs)} pairs has a row`);
  assert.equal(graph.stats().scoredPairs, pairs, 'and the cumulative offer count is the pair count, not a multiple of it');
  assert.equal(questions, pairs, `the backend was asked ${String(questions)} questions for ${String(pairs)} pairs`);
  assert.equal(graph.stats().judgedPairs, pairs, 'every offer was answered');
});
