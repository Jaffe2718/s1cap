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
