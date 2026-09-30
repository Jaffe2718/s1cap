/**
 * What the association graph does with the probabilities the backend returns.
 *
 * The graph used to keep only the pairs that cleared `recall.threshold`: the weight was computed, paid for, and
 * discarded if it fell below r. That made the threshold an ingest filter instead of the traversal test the brief
 * describes, and it destroyed the only graded signal the graph had - which is why the connectivity matrix drawn
 * from it could only ever be a yes/no picture, and why a run recorded at one r could not be re-read at another
 * without asking the backend for every pair a second time. These tests pin the three consequences.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { AssociationGraph } from '../src/assoc-graph.ts';
import type { RgSnapshot } from '../src/assoc-graph.ts';
import type { Segment } from '../src/types.ts';

function segment(id: string, seq: number): Segment {
  return { id, sessionId: 's', seq, kind: 'user', tokens: 1, text: `text ${id}`, ts: seq };
}

test('the graph keeps the probabilities, not only the verdict of the threshold', async () => {
  const graph = new AssociationGraph();
  graph.addSegments([segment('a', 0), segment('b', 1), segment('c', 2)]);
  const bySegment: Record<string, number[]> = { b: [0.9], c: [0.9, 0.2] };
  let calls = 0;

  await graph.scoreNew({
    windowN: 1024,
    threshold: 0.55,
    scoreBatch: async (current: Segment, candidates: readonly Segment[]) => {
      calls += 1;
      return bySegment[current.id] ?? candidates.map(() => 0);
    },
  });

  assert.equal(calls, 2, 'one scoring pass per new segment that has a window to be scored against');
  assert.equal(graph.edgeCount, 2, 'the threshold still decides the graph: 0.9 and 0.9 are edges, 0.2 is not');
  assert.equal(graph.scoreCount, 3, 'but all three probabilities are kept');
  assert.deepEqual(
    graph.scores().map((pair) => pair.w).sort((a, b) => a - b),
    [0.2, 0.9, 0.9],
    'including the one below the threshold, which used to be thrown away after being paid for',
  );
  assert.ok(
    graph.scores().every((pair) => pair.source === 's1-noul'),
    'and each pair says who produced it, so a fallback score can never be read as a backend score',
  );
});

test('a different r is a different reading of the same run, not a second set of System-1 calls', async () => {
  const graph = new AssociationGraph();
  graph.addSegments([segment('a', 0), segment('b', 1)]);
  let calls = 0;
  await graph.scoreNew({
    windowN: 8,
    threshold: 0.55,
    scoreBatch: async () => {
      calls += 1;
      return [0.3];
    },
  });

  assert.equal(calls, 1, 'the backend was asked once');
  assert.equal(graph.edgeCount, 0, 'at r = 0.55 the pair is not an edge');
  assert.equal(graph.edgesAt(0.2).length, 1, 'at r = 0.2 the same recorded pair is one - with no further call');
  assert.equal(graph.edgesAt(0.4).length, 0, 'and at r = 0.4 it is not');
  assert.equal(calls, 1, 'sweeping r costs nothing, which is the point of keeping the probability');
});

test('a window the backend did not answer is still offered, and stops counting as judged', async () => {
  // The distinction that a live session could not make: `scoredPairs` counts what the window offered, and it was
  // read as coverage. The session reported 18528 offered pairs while 1796 had been judged and 1863 questions had
  // timed out, and nothing in the record disagreed.
  const graph = new AssociationGraph();
  graph.addSegments([segment('a', 0), segment('b', 1), segment('c', 2)]);
  let call = 0;
  await graph.scoreNew({
    windowN: 8,
    threshold: 0.55,
    scoreBatch: async (_current: Segment, candidates: readonly Segment[]) => {
      call += 1;
      return call === 1 ? candidates.map(() => 0.9) : undefined; // the second window gets no answer
    },
  });

  const stats = graph.stats();
  assert.equal(stats.scoredPairs, 3, 'both windows were offered');
  assert.equal(stats.judgedPairs, 1, 'only the window the backend answered was judged');
  assert.equal(
    graph.scores().filter((pair) => pair.source === 'lexical').length,
    2,
    'and the unanswered two are recorded as fallback, so the gap cannot be mistaken for a backend result',
  );
});

test('unjudgedWithin asks for the backend judgement, not for a number in the scores map', async () => {
  // The distinction the fail-open rule rests on. A failed System-1 call still leaves a score behind - the local
  // lexical fallback's - so "has an entry in `#scores`" made a pair the backend never judged look exactly like one
  // it had, and the rule stayed silent through the round it exists for: 281 `s1_call` records, 191 failed (97 fetch
  // failures, 57 timeouts, 37 `503`s), `unknownAdmitted` zero times, 11 of 49 assemblies on the recency fallback.
  const graph = new AssociationGraph();
  graph.addSegments([segment('a', 0), segment('b', 1), segment('c', 2)]);
  let call = 0;
  await graph.scoreNew({
    windowN: 8,
    threshold: 0.55,
    scoreBatch: async (_current: Segment, candidates: readonly Segment[]) => {
      call += 1;
      // The backend answers b's window and fails c's, which is the shape a timed-out call leaves.
      return call === 1 ? candidates.map(() => 0.9) : undefined;
    },
  });

  assert.equal(
    graph.scores().filter((pair) => pair.source === 'lexical').length,
    2,
    'sanity: the unanswered window was scored by the fallback and kept',
  );
  // Judged by the backend: not unknown, so not admitted.
  assert.deepEqual(graph.unjudgedWithin('b', 8).map((s) => s.id), []);
  // Scored by the fallback only: both pairs are still unknown, nearest first.
  assert.deepEqual(graph.unjudgedWithin('c', 8).map((s) => s.id), ['b', 'a']);
  // And the scoping is unchanged: a pair beyond `w` was never asked, so it is not admitted either.
  assert.deepEqual(graph.unjudgedWithin('c', 1).map((s) => s.id), ['b']);
});

test('a snapshot carries the probabilities across a restart, and an older file still loads', async () => {
  const graph = new AssociationGraph();
  graph.addSegments([segment('a', 0), segment('b', 1)]);
  await graph.scoreNew({ windowN: 8, threshold: 0.55, scoreBatch: async () => [0.4] });

  const restored = AssociationGraph.fromSnapshot(graph.snapshot());
  assert.equal(restored.scoreCount, 1, 'the sub-threshold probability survived the round trip');
  assert.equal(restored.edgesAt(0.3).length, 1, 'and is usable after the restart');

  const older = { ...graph.snapshot(), schema: 1 } as RgSnapshot & { scores?: unknown };
  delete older.scores;
  const read = AssociationGraph.fromSnapshot(older);
  assert.equal(read.segmentCount, 2, 'a schema-1 file is still read rather than discarded for being one version old');
  assert.equal(read.scoreCount, 0, 'it simply carries no probabilities, having been written before they were kept');
});
