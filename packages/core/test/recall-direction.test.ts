/**
 * The direction of an RG expansion: an older segment does not recall a newer one.
 *
 * The pair is stored the way `scoreNew` stores it - once, keyed `${older}->${newer}`, because a segment is scored
 * when it arrives against the segments before it. The adjacency is symmetric on purpose (`neighbors()` answers
 * "does this pair have a score", which is true in both directions), and the *walk* is where the direction lives:
 * `recall` expands a node only into neighbours that sit earlier in the session's append order.
 *
 * The defect these tests pin was measured on round `20261004-0233` (cell C2, its own `recallTree` records against
 * the RG snapshot's `order`): 255 of 540 recorded tree edges - 47.2 % - went from a node to a *newer* one, the
 * widest from append position 1 to position 28. `packages/core/test/forward-edge-audit.ts` re-runs the same
 * anchors over the same round and is where the number is checked after a change; these tests are the property it
 * measures, stated on fixtures small enough to read.
 *
 * **What the change costs, stated here rather than discovered later.** This is not an optimisation: it changes
 * which segments a walk selects, so it changes the recorded selection of every round that runs after it. The
 * round it was measured against stays readable and unedited; the next round is what measures the difference.
 *
 * **The fixtures below also carry a second change, made the same day (2026-10-05).** The walk used to cut each
 * node's expansions to its `k` heaviest neighbours (`recall.fanout`), and that option is retired - not in the
 * originating brief, in no wiring record and in no settings panel (`packages/core/src/config.ts`,
 * `LEGACY_POLICY_KEYS`; `packages/core/src/types.ts` carries the measurement). An intermediate version of this
 * header said the direction change *"also admits segments the old walk never reached - a node whose fanout was
 * spent on newer, heavier neighbours had no room left for its older ones, so filtering backward restores
 * candidates the ranking had crowded out."* That was a true statement about the build between the direction fix
 * and the retirement, and it is superseded rather than wrong: with the cap gone there is no fanout to spend and
 * no crowding-out to restore, and the direction filter is now the only thing that decides which neighbours are
 * offered. Where a number in these tests moved with the retirement it is stated beside the assertion that moved.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { AssociationGraph } from '../src/assoc-graph.ts';
import type { AssociationEdge, Segment } from '../src/types.ts';

const SESSION = 'direction';
const NOW = 1000;
/** Large enough that decay is 1 over the fixture, so a test's weights are the weights it wrote. */
const LAMBDA = 1e9;

function seg(id: string, index: number, tokens = 10): Segment {
  return { id, sessionId: SESSION, seq: index, kind: 'assistant', tokens, text: `text of ${id}`, ts: NOW + index };
}

function edge(from: string, to: string, w: number): AssociationEdge {
  return { from, to, w, wTier1: w, source: 's1-noul', verifiedAt: NOW, provenance: 'direction-test' };
}

/** A graph whose append order is exactly `ids`, oldest first. */
function graphOf(ids: readonly string[]): AssociationGraph {
  const g = new AssociationGraph();
  g.addSegments(ids.map((id, index) => seg(id, index)));
  return g;
}

/** id -> position in the graph's append order, read from the graph rather than restated by the fixture. */
function positions(g: AssociationGraph): Map<string, number> {
  const at = new Map<string, number>();
  for (const [index, segment] of g.orderedSegments().entries()) at.set(segment.id, index);
  return at;
}

function opts(depth: number) {
  return { threshold: 0.5, depth, lambdaMs: LAMBDA, now: NOW };
}

test('an older segment does not recall a newer one, and the newer one still recalls it', () => {
  // The defect in its smallest form: one pair, stored older -> newer. Walking from the older end must find
  // nothing, and that is the whole point - it is not a matter of weight or depth, and no threshold makes the
  // newer segment an older one.
  const g = graphOf(['old', 'new']);
  g.upsertEdge(edge('old', 'new', 0.9));

  const fromOlder = g.recall(['old'], opts(2));
  assert.deepEqual(
    fromOlder.map((h) => h.id),
    [],
    'the older segment must not recall the newer one, however heavy their edge is',
  );

  // The legitimate direction is untouched, and this half is why the filter cannot be "drop the edge" or "make
  // the adjacency directed": the very same pair is recalled when the walk starts from the newer end.
  const fromNewer = g.recall(['new'], opts(2));
  assert.deepEqual(fromNewer.map((h) => h.id), ['old'], 'the newer segment recalls the older one');
  assert.equal(fromNewer[0]?.via, 'new');
  assert.equal(fromNewer[0]?.depth, 1);

  // And the pair is still *there* in both directions: `neighbors` is the honest reading of "this pair has a
  // score", and the two tests that use it to prove an out-of-window segment keeps its edges
  // (`pair-cost.test.ts`, `window.test.ts`) are about the adjacency, not about the walk.
  assert.equal(g.neighbors('old').length, 1, 'the older segment still holds its edge');
  assert.equal(g.neighbors('new').length, 1, 'and so does the newer one');
  assert.equal(g.edgeCount, 1, 'with nothing removed from the graph');
});

test('a walk from the middle stops at the newer side, and depth still bounds the older one', () => {
  // The chain a - b - c - d, appended oldest first. Every edge points backwards, so this is what a real
  // neighbourhood looks like: the walk from the newest end is the whole chain.
  const g = graphOf(['a', 'b', 'c', 'd']);
  g.upsertEdge(edge('a', 'b', 0.9));
  g.upsertEdge(edge('b', 'c', 0.9));
  g.upsertEdge(edge('c', 'd', 0.9));

  const fromNewest = g.recall(['d'], opts(3));
  assert.deepEqual(fromNewest.map((h) => h.id), ['c', 'b', 'a'], 'd recalls the older chain, nearest first');
  assert.equal(fromNewest.find((h) => h.id === 'a')?.depth, 3, 'three backward steps');

  // From the middle: `b` is adjacent to `c` and `c` to `d`, and neither comes back - they are newer.
  const fromMiddle = g.recall(['b'], opts(3));
  assert.deepEqual(fromMiddle.map((h) => h.id), ['a'], 'a seed in the middle recalls only its older side');

  // `depth` is unchanged in every other respect: it still cuts the walk, on the older side only.
  const shallow = g.recall(['d'], opts(2));
  assert.deepEqual(shallow.map((h) => h.id), ['c', 'b'], 'depth 2 stops before a');
});

test('every pair an edge: a depth-2 walk from the newest takes no forward step', () => {
  // Everything is connected to everything, so nothing about reachability can hide a forward step: any node the
  // walk places must be older than the node it was expanded from, and the only way to place a *newer* one is to
  // step forward. The weights are chosen to make that tempting - `0.6 + 0.4 j/(n-1)` rises with the **newer**
  // endpoint of a pair, so a node's newer neighbours are its heaviest ones and a symmetric walk follows them.
  const n = 12;
  const ids = Array.from({ length: n }, (_, i) => `s${String(i).padStart(2, '0')}`);
  const g = graphOf(ids);
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      g.upsertEdge(edge(ids[i] as string, ids[j] as string, 0.6 + (0.4 * j) / (n - 1)));
    }
  }
  const at = positions(g);
  const pos = (id: string): number => {
    const p = at.get(id);
    assert.notEqual(p, undefined, `the graph must place ${id}`);
    return p as number;
  };
  const newest = ids[n - 1] as string;

  const hits = g.recall([newest], opts(2));
  assert.ok(hits.length > 0, 'sanity: the walk found something');
  for (const hit of hits) {
    assert.ok(
      pos(hit.id) < pos(hit.via),
      `${hit.id} (idx ${pos(hit.id)}) was reached from ${hit.via} (idx ${pos(hit.via)}), which is not older`,
    );
    assert.ok(pos(hit.id) < pos(newest), 'and every hit is older than the seed');
  }
  // The same statement as a count, and the count **grew when the per-node cap was retired** (2026-10-05): with the
  // cap at k = 3 the walk placed three nodes, and it now places **every** older segment - all eleven - because
  // every pair is an edge and every one of them is older than the seed. Nothing is placed at depth 2 in either
  // case, and that is the shape rather than an accident: the seed is the newest segment, so every neighbour it
  // expands into is older than it, and those neighbours have no older segment left to expand into. Widening
  // forward is what is gone; it is not that the walk got shallower, it is that its expansions are a subset of its
  // neighbourhood.
  assert.equal(hits.length, n - 1, `all ${n - 1} older segments are expanded into: nothing is cut`);
  assert.ok(
    hits.every((h) => h.depth === 1 && h.via === newest),
    `every hit is a depth-1 expansion of the seed: ${JSON.stringify(hits)}`,
  );

  // The scale consequence at its sharpest: from the **oldest** segment, where every neighbour is newer, the walk
  // places nothing. The old rule placed five nodes here - three of them by steps forward in time, and the other
  // two only reachable because a forward step happened first - and an uncapped forward walk would place all
  // eleven. The direction rule is what refuses all of them, at any branching factor.
  assert.deepEqual(g.recall([ids[0] as string], opts(2)), [], 'the oldest segment recalls nothing newer');
});

test('a cycle in the pair graph cannot loop, and a seed never comes back as a hit', () => {
  // The pair graph holds a cycle (a-b, b-c, c-a). The direction rule makes it untraversable *as* a cycle - a walk
  // can only step backwards, so it can never return to a segment it has already left - and that is a second
  // guarantee rather than a replacement for `visited`, which still handles the diamond.
  const g = graphOf(['a', 'b', 'c']);
  g.upsertEdge(edge('a', 'b', 0.9));
  g.upsertEdge(edge('b', 'c', 0.9));
  g.upsertEdge(edge('c', 'a', 0.9));

  const hits = g.recall(['c'], opts(3));
  assert.deepEqual(hits.map((h) => h.id), ['b', 'a'], 'c reaches both older segments, once each');
  assert.ok(hits.every((h) => h.depth === 1 && h.via === 'c'), 'and the edge a-b is not walked back up');
  assert.ok(!hits.some((h) => h.id === 'c'), 'the seed is not a hit');

  // The one way a seed can still be an expansion target: a seed *set* spans two positions, and the older seed is
  // an ordinary older neighbour of the newer one. It must not come back as an "earlier turn" - the question being
  // asked is not history.
  const both = g.recall(['a', 'c'], opts(3));
  assert.deepEqual(both.map((h) => h.id), ['b'], 'the older seed stays a seed even though c can expand into it');
});

test('a neighbour the order does not place is not an expansion, and not a bridge', () => {
  // `ghost` is known to the adjacency only: an edge endpoint the graph never admitted as a segment, which is what
  // a hand-written or damaged snapshot can hold. Its position is unknown, and unknown is not older.
  const g = graphOf(['a', 'b']);
  g.upsertEdge(edge('a', 'ghost', 0.9));
  g.upsertEdge(edge('ghost', 'b', 0.9));

  // From `b`, `ghost` is unplaceable, so no step is taken through it - and `a`, which is reachable only through
  // the ghost, is not reached either. A quiet failure here would be a bridge: the walk would arrive at an older
  // segment by way of a node whose age it could not establish, which is the defect wearing a disguise.
  assert.deepEqual(g.recall(['b'], opts(3)), [], 'no step through an unplaced neighbour');
  assert.equal(g.neighbors('b').length, 1, 'the edge itself is untouched - the filter is on the walk');

  // A placed older neighbour beside the unplaced one is still reached: excluding the unplaceable must not
  // exclude the rest of the neighbourhood.
  g.upsertEdge(edge('a', 'b', 0.8));
  const placed = g.recall(['b'], opts(3));
  assert.deepEqual(placed.map((h) => h.id), ['a'], 'the placed older neighbour is still reached');
  assert.ok(!placed.some((h) => h.id === 'ghost'), 'and the unplaced one is not offered as a hit');

  // The same rule from the anchor's side: a seed the graph does not place expands nowhere.
  assert.deepEqual(g.recall(['ghost'], opts(3)), []);
});

test('a restored graph walks the same direction, and an order that omits a segment leaves it unplaced', () => {
  const g = graphOf(['a', 'b', 'c']);
  g.upsertEdge(edge('a', 'b', 0.9));
  g.upsertEdge(edge('b', 'c', 0.9));

  // The snapshot carries the order, so a restart resumes the same direction rather than rebuilding one from
  // `seq` (which a chunked or re-ordered log need not agree with).
  const restored = AssociationGraph.fromSnapshot(g.snapshot());
  assert.deepEqual(restored.recall(['c'], opts(2)).map((h) => h.id), ['b', 'a'], 'backwards, as before the restart');

  // A snapshot whose `order` does not name a segment does not get one invented for it: the segment is in the
  // graph and in `scores`, and the walk still refuses to place it. Guessing an age - from `seq`, from arrival
  // order here - would be exactly the "unknown means older" the rule forbids.
  const partial = AssociationGraph.fromSnapshot({ ...g.snapshot(), order: ['a', 'b'] });
  assert.notEqual(partial.getSegment('c'), undefined, 'sanity: the segment itself survives the restore');
  assert.deepEqual(partial.recall(['c'], opts(2)), [], 'an anchor with no position expands nowhere');
  assert.deepEqual(partial.recall(['b'], opts(2)).map((h) => h.id), ['a'], 'the placed half is unaffected');
});
