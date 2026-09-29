import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AssociationGraph } from '../src/assoc-graph.ts';
import type { Segment } from '../src/types.ts';

function seg(i: number): Segment {
  return {
    id: 's' + String(i),
    sessionId: 'sess',
    seq: i,
    kind: 'user' as never,
    tokens: 4,
    text: 'alpha beta gamma delta epsilon ' + String(i),
    ts: 1000 + i,
  };
}

test('recall.window = w bounds the scored pairs, and older segments stay in the graph', () => {
  const graph = new AssociationGraph();
  const w = 64;
  const total = 400;
  const segments = Array.from({ length: total }, (_, i) => seg(i));

  for (const segment of segments) {
    graph.addSegments([segment]);
    graph.scoreNew({ windowN: w, threshold: 0 });
  }

  const stats = graph.stats();
  const full = (total * (total - 1)) / 2;
  assert.ok(stats.scoredPairs <= total * w, 'scoredPairs ' + String(stats.scoredPairs) + ' must stay within total*w');
  assert.ok(stats.scoredPairs < full, 'the window must cost less than full pairwise scoring (' + String(full) + ')');
  assert.equal(stats.segments, total);

  // The first segment fell out of the window long ago: it is still a node, still holds its edges, and is still
  // traversable - w only decides whether a pair is scored, never what exists in the graph.
  assert.notEqual(graph.getSegment('s0'), undefined);
  assert.ok(graph.neighbors('s0').length > 0, 'an out-of-window segment keeps its edges');

  // Doubling the window doubles the per-segment cost, and nothing else changes.
  const wider = new AssociationGraph();
  for (const segment of Array.from({ length: total }, (_, i) => seg(i))) {
    wider.addSegments([segment]);
    wider.scoreNew({ windowN: w * 2, threshold: 0 });
  }
  const ratio = wider.stats().scoredPairs / stats.scoredPairs;
  assert.ok(ratio > 1.5 && ratio < 2.5, 'cost tracks w, not the history length (ratio ' + String(ratio) + ')');
});