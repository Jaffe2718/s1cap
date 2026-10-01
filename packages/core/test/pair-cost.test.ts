/**
 * What the association window costs, and what it does not: the pairs the backend is asked about.
 *
 * The suspicion this file answers is that a new segment makes the graph re-score the whole window, so a long
 * session re-pays for pairs already judged. It does not, and the check is a counter rather than a reading of the
 * code: `scoredPairs` counts pairs offered, `scores` is keyed by pair, so any pair offered twice would leave the
 * first number larger than the second. Round `20261001-1300` measured 6 670 / 4 278 / 3 321 / 22 791 offered
 * pairs for 116 / 93 / 82 / 214 segments - exactly T(T-1)/2 in every cell, because `recall.window = 1024` bound
 * nothing - and each of the four graphs held exactly that many *distinct* pairs. What is quadratic in a session
 * is the number of new pairs, not a repetition of old ones, and the lever is `w` or `s1.questionsPerCall`.
 *
 * These tests pin the two mechanisms that make that true: the one-way `scored` cursor, and the snapshot that
 * carries it across a restart. A future change that starts re-offering a pair fails here, with the pair named,
 * instead of quietly multiplying the System-1 bill in a run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { AssociationGraph } from '../src/assoc-graph.ts';
import type { Segment } from '../src/types.ts';

function segment(id: string, seq: number): Segment {
  return { id, sessionId: 's', seq, kind: 'user', tokens: 1, text: `text ${id}`, ts: seq };
}

/** `${from}->${to}` for every pair handed to the batch scorer, in the order the graph offered them. */
function pairRecorder(asked: string[]): (current: Segment, candidates: readonly Segment[]) => readonly number[] {
  return (current, candidates) => {
    for (const candidate of candidates) asked.push(`${candidate.id}->${current.id}`);
    // Above `recall.threshold`, so the edge set is the pair set and the two can be compared directly.
    return candidates.map(() => 0.9);
  };
}

test('a new segment is offered exactly the pairs that involve it, and no pair is offered twice', async () => {
  const w = 6;
  const total = 12;
  const graph = new AssociationGraph();
  const asked: string[] = [];
  const scorer = pairRecorder(asked);
  const expected: string[] = [];

  // One segment at a time, which is what upkeep does: it folds each session event into the graph and scores
  // whatever arrived since the last call.
  for (let i = 0; i < total; i += 1) {
    const id = `s${String(i).padStart(2, '0')}`;
    graph.addSegments([segment(id, i)]);
    await graph.scoreNew({ windowN: w, threshold: 0.55, scoreBatch: scorer });
    // The pairs this arrival should cost: its window, oldest first. Nothing else, and nothing already asked.
    for (let j = Math.max(0, i - w); j < i; j += 1) expected.push(`s${String(j).padStart(2, '0')}->${id}`);
  }

  assert.deepEqual(asked, expected, 'the offer is the new segment against its window, in arrival order');
  assert.equal(new Set(asked).size, asked.length, 'and not one of those pairs was offered a second time');

  // The number the suspicion predicts, computed rather than asserted in prose: if every arrival re-scored the
  // windows already scored, pair (h_i, s_j) would be asked again at each later arrival k with k <= j + w.
  let rejudged = 0;
  for (let i = 0; i < total; i += 1) {
    for (let j = i + 1; j <= Math.min(total - 1, i + w); j += 1) {
      const again = Math.min(total - 1, j + w) - j;
      rejudged += 1 + Math.max(0, again);
    }
  }
  assert.ok(
    asked.length < rejudged,
    `offered ${String(asked.length)} pairs, where re-scoring the window at every arrival would offer ${String(rejudged)}`,
  );

  // And the graph's own counters agree with the pairs the scorer was handed - the two numbers a run is read from.
  const stats = graph.stats();
  assert.equal(stats.scoredPairs, asked.length, 'scoredPairs counts the pairs offered, and the offer is the new ones');
  assert.equal(stats.judgedPairs, asked.length, 'the backend answered every window it was offered');
  assert.equal(graph.scoreCount, asked.length, 'scores is keyed by pair, so this is the distinct-pair count');
});

test('the edge set is the pair set: every pair offered above the threshold is kept, and none is lost', async () => {
  const w = 6;
  const total = 12;
  const graph = new AssociationGraph();
  const asked: string[] = [];
  const scorer = pairRecorder(asked);

  for (let i = 0; i < total; i += 1) {
    graph.addSegments([segment(`s${i}`, i)]);
    await graph.scoreNew({ windowN: w, threshold: 0.55, scoreBatch: scorer });
  }

  // The record this pins is the graph's content, so it is asserted as a set rather than as a count: a change
  // that dropped an edge and added another would keep the count and lose the measurement.
  const edges = graph.scores().map((pair) => `${pair.from}->${pair.to}`);
  assert.deepEqual([...edges].sort(), [...asked].sort(), 'the recorded pairs are exactly the offered pairs');
  assert.equal(graph.edgeCount, asked.length, 'all of them clear r = 0.55, so the edge set is the pair set');
  assert.ok(
    graph.scores().every((pair) => pair.source === 's1-noul'),
    'and every pair says the backend judged it, so the fallback cannot be read as System-1 coverage',
  );

  // Segments that long ago fell out of the window keep their edges: w decides whether a pair is scored, never
  // what exists in the graph. This is the property a "stop re-scoring" change must not trade away.
  assert.ok(graph.neighbors('s0').length > 0, 'the first segment still holds its edges after leaving the window');
});

test('a resumed graph is asked only about pairs it has never judged', async () => {
  // The persistence path, which is where a re-pay would be least visible: `scoreNew` continues from the cursor
  // in the snapshot, so a restart costs the pairs of the segments that arrived while the process was down and
  // nothing else. Ten pairs are bought before the snapshot; the two segments after it must cost nine, not
  // nineteen - the re-judging hypothesis would pay for the window a second time.
  const first = new AssociationGraph();
  const before: string[] = [];
  const scorer = pairRecorder(before);
  for (let i = 0; i < 5; i += 1) {
    first.addSegments([segment(`a${i}`, i)]);
    await first.scoreNew({ windowN: 8, threshold: 0.55, scoreBatch: scorer });
  }
  assert.equal(before.length, 10, 'sanity: five segments at w = 8 are ten pairs, T(T-1)/2');
  assert.equal(first.stats().judgedPairs, 10);

  const resumed = AssociationGraph.fromSnapshot(first.snapshot());
  assert.equal(resumed.scoreCount, 10, 'the probabilities survive the round trip');
  assert.equal(resumed.stats().judgedPairs, 10, 'and so do the counters the coverage rate is read from');

  const after: string[] = [];
  const resumedScorer = pairRecorder(after);
  resumed.addSegments([segment('b0', 5)]);
  await resumed.scoreNew({ windowN: 8, threshold: 0.55, scoreBatch: resumedScorer });
  resumed.addSegments([segment('b1', 6)]);
  await resumed.scoreNew({ windowN: 8, threshold: 0.55, scoreBatch: resumedScorer });

  assert.deepEqual(
    after,
    ['a0->b0', 'a1->b0', 'a2->b0', 'a3->b0', 'a4->b0', 'a0->b1', 'a1->b1', 'a2->b1', 'a3->b1', 'a4->b1', 'b0->b1'],
    'the resumed session asked about the new segments and about nothing it had already bought',
  );
  const stats = resumed.stats();
  assert.equal(stats.scoredPairs, 21, 'ten pairs before the restart, eleven after it');
  assert.equal(stats.judgedPairs, 21, 'and the earlier judgements still count as judgements');
  assert.equal(resumed.edgeCount, 21, 'every pair survived the restart as an edge, none was rebuilt');
});
