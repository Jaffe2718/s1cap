/**
 * ON-DEMAND (LAZY) SCORING — the walk asks for the rows it needs, and nothing else is scored.
 *
 * The design in one sentence: a pair is scored because a walk demanded the row it belongs to, not because the
 * segment that owns it arrived. `AssociationGraph.recallDemand` is the same walk `recall` runs, with one thing
 * added per level — before a level is expanded it asks the caller's scorer for the rows of the nodes it stands on
 * and cannot answer from what the graph holds.
 *
 * What these tests pin, and why each one is here rather than in a comment:
 *
 *   1. **The answer is the same when nothing is missing.** On a graph that is already settled, `recallDemand`
 *      must return exactly what `recall` returns and must not call the scorer at all. This is worth more than any
 *      timing number: it is what says the lazy walk is the *same* walk, and it is structural — both call
 *      `#walkLevel`.
 *   2. **The demand is the walk's, not a sweep's.** The first row asked for is the anchor's own; the rows that
 *      follow are the nodes the walk actually expanded, newest first; a node whose row leaves it with no
 *      neighbour above `tau` is never expanded and its neighbours' rows are never asked for.
 *   3. **The saving, both halves.** Rows and pairs: `sum min(index, w)` over the demanded rows against the eager
 *      `sum_{i=1}^{N-1} min(i, w)` over every row. Order: eager spends the lane oldest-first while the walk needs
 *      the newest, and the arithmetic is asserted rather than described.
 *   4. **Nothing is stranded.** A scorer that throws, a scorer that answers nothing, and two concurrent walks
 *      over one anchor: no entry may be left in `#taken`, and no row may be scored twice.
 *   5. **`d` is billed.** Under on-demand scoring the rows a walk costs are the rows it reaches, so a deeper walk
 *      buys more rows. That is the sentence `packages/core/src/types.ts` carries about `recall.depth`, and this is
 *      where it is measured.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { AssociationGraph } from '../src/assoc-graph.ts';
import type { DemandRow, RecallOptions } from '../src/assoc-graph.ts';
import type { Segment } from '../src/types.ts';

function segment(id: string, seq: number): Segment {
  // The text is the id: the graph's local lexical scorer is the fallback everywhere a backend is absent, and a
  // fixture whose texts are identical would make every pair equally relevant, which is the one graph shape that
  // cannot tell an expanding walk from a dead end.
  return { id, sessionId: 's', kind: 'user', text: `segment ${id}`, ts: seq, seq };
}

/** A graph of `n` segments in append order, and nothing scored. */
function graphOf(n: number): AssociationGraph {
  const graph = new AssociationGraph();
  graph.addSegments(Array.from({ length: n }, (_unused, i) => segment(`s${String(i)}`, i)));
  return graph;
}

const OPTS: RecallOptions & { window: number } = {
  threshold: 0.55,
  depth: 2,
  lambdaMs: 0,
  now: 0,
  window: 16,
};

/**
 * A deterministic stand-in for the System-1 backend: every pair is judged, and a pair is relevant when the
 * *older* segment's index is a multiple of 3. Index-driven rather than text-driven so the graph's shape is
 * stated by the fixture and not by the lexical fallback.
 */
function indexScorer(asked: DemandRow[]): (rows: readonly DemandRow[]) => Promise<readonly (readonly number[])[]> {
  return async (rows) => {
    for (const row of rows) asked.push(row);
    return rows.map((row) => row.candidates.map((other) => (Number(other.id.slice(1)) % 3 === 0 ? 0.9 : 0.1)));
  };
}

/** `sum_{i=1}^{N-1} min(i, w)`: what eager scoring offers for an N-segment session at window `w`. */
function eagerPairs(n: number, w: number): number {
  let total = 0;
  for (let i = 1; i < n; i += 1) total += Math.min(i, w);
  return total;
}

/** `sum min(index, w)` over exactly the rows a demand named. */
function demandedPairs(rows: readonly DemandRow[], w: number): number {
  let total = 0;
  for (const row of rows) total += Math.min(row.index, w);
  return total;
}

test('a settled graph answers identically, and the demand asks for nothing', async () => {
  // The equality the whole design rests on: on a graph where every row is already scored, the lazy walk is the
  // eager walk and the scorer is never called. A backend that throws proves the second half honestly - a walk
  // that demanded a row here would fail loudly rather than quietly re-score it.
  const eager = graphOf(24);
  await eager.scoreNew({ windowN: OPTS.window, threshold: OPTS.threshold, scoreBatch: async (current, candidates) =>
    candidates.map((other) => (Number(other.id.slice(1)) % 3 === 0 ? 0.9 : 0.1)) });

  const lazy = graphOf(24);
  await lazy.scoreNew({ windowN: OPTS.window, threshold: OPTS.threshold, scoreBatch: async (current, candidates) =>
    candidates.map((other) => (Number(other.id.slice(1)) % 3 === 0 ? 0.9 : 0.1)) });

  const expected = eager.recall(['s23'], OPTS);
  const asked: DemandRow[] = [];
  const demand = await lazy.recallDemand(['s23'], OPTS, async (rows) => {
    for (const row of rows) asked.push(row);
    throw new Error('a row was demanded on a graph that is already settled');
  });

  assert.deepEqual(
    demand.hits.map((hit) => ({ id: hit.id, depth: hit.depth, via: hit.via })),
    expected.map((hit) => ({ id: hit.id, depth: hit.depth, via: hit.via })),
    'the lazy walk returns exactly the eager walk\'s hits, in the same tree',
  );
  assert.deepEqual(demand.hits, expected, 'weights and order too, not just the ids');
  assert.deepEqual(asked, [], 'and not one row was asked for: there was nothing missing');
  assert.equal(demand.rows, 0);
  // The walk stopped because it reached its depth bound with nothing left to ask - not because a budget ran out and
  // not because it ran out of graph. `depth` is the honest reason here and is one of the two that mean "done".
  assert.equal(demand.stop, 'depth');
  // The eager graph's own totals, so the two fixtures are provably the same shape.
  assert.equal(lazy.stats().scoredPairs, eager.stats().scoredPairs);
});

test('a partially scored graph: the demand is the walk\'s own expansion, newest first, level by level', async () => {
  // No eager scoring at all: the graph holds 32 segments and zero pairs. The walk is rooted on the last one, so
  // the first row it needs is the anchor's own - and every row after it is a node the walk actually expanded.
  const graph = graphOf(32);
  const asked: DemandRow[] = [];
  const demand = await graph.recallDemand(['s31'], OPTS, indexScorer(asked));

  assert.equal(asked[0]?.id, 's31', `the anchor's row is asked for first: ${asked.map((r) => r.id).join(',')}`);
  assert.deepEqual(
    asked.map((row) => row.depth),
    [...asked.map((row) => row.depth)].sort((a, b) => a - b),
    'demands are issued level by level, never into a level below the one being expanded',
  );
  // Newest first *within* a level, which is the order half of the benefit: eager scoring walks the append order
  // from its oldest entry, and the walk needs this end of it.
  const levelOne = asked.filter((row) => row.depth === 1).map((row) => row.index);
  assert.deepEqual(levelOne, [...levelOne].sort((a, b) => b - a), 'and newest first inside a level');

  // The volume: only the rows the walk asked for were scored. The eager path would have offered every row.
  const eager = eagerPairs(32, OPTS.window);
  const lazy = demandedPairs(asked, OPTS.window);
  assert.equal(demand.pairs, lazy, 'the pairs paid for are exactly the demanded rows\' windows');
  assert.equal(graph.stats().scoredPairs, lazy, 'and the graph\'s own offer count agrees');
  assert.equal(graph.scoreCount, lazy, 'and so does the number of graded pairs it holds');
  assert.ok(lazy < eager, `lazy ${lazy} must be below eager ${eager} for this fixture`);
  // 8 rows of a 32-segment session at w = 16: 16 + 15 + 14 + ... is what an eager pass pays (all 31 rows).
  assert.equal(eager, 16 + 15 + 14 + 13 + 12 + 11 + 10 + 9 + 8 + 7 + 6 + 5 + 4 + 3 + 2 + 1 + 16 * 15);
  assert.ok(
    asked.length < 31,
    `the walk asked for ${asked.length} of the 31 rows eager scoring would offer: ${asked.map((r) => r.index).join(',')}`,
  );
});

test('a node with no neighbour above tau is not expanded, so its neighbours are never paid for', async () => {
  // The branch that the saving is made of. Every candidate weight is below `tau`, so the anchor's row is scored
  // once, ranks to nothing, and the walk stops: exactly one row, and never a row behind it.
  const graph = graphOf(40);
  const asked: DemandRow[] = [];
  const demand = await graph.recallDemand(['s39'], OPTS, async (rows) => {
    for (const row of rows) asked.push(row);
    return rows.map((row) => row.candidates.map(() => 0.1));
  });

  assert.equal(asked.length, 1, `one row, the anchor's: ${asked.map((r) => r.id).join(',')}`);
  assert.equal(asked[0]?.id, 's39');
  assert.equal(demand.hits.length, 0, 'and the walk found nothing, because nothing cleared tau');
  assert.equal(demand.pairs, 16, 'the pair count is one window, not one window per segment');
  assert.equal(eagerPairs(40, OPTS.window), 16 * 24 + 120, 'the eager pass on the same session pays this much');
});

test('d is billed under on-demand scoring: a deeper walk reaches more nodes and demands their rows', async () => {
  // The sentence `packages/core/src/types.ts` carries - "d is free under eager scoring and billed under on-demand
  // scoring" - measured rather than asserted. Eager scoring's pair count contains no `d` at all; the lazy walk's
  // does, because a node reached is a row scored.
  const cost = async (depth: number): Promise<number> => {
    const graph = graphOf(32);
    const asked: DemandRow[] = [];
    await graph.recallDemand(['s31'], { ...OPTS, depth }, indexScorer(asked));
    return demandedPairs(asked, OPTS.window);
  };
  const atOne = await cost(1);
  const atTwo = await cost(2);
  const atFour = await cost(4);

  assert.ok(atOne < atTwo, `depth 1 pays ${atOne}, depth 2 pays ${atTwo}`);
  assert.ok(atTwo <= atFour, `depth 2 pays ${atTwo}, depth 4 pays ${atFour}`);
  // And eager scoring pays the same at every depth, which is the property that stops being true here.
  const eager = graphOf(32);
  for (const depth of [1, 2, 4]) {
    await eager.scoreNew({ windowN: OPTS.window, threshold: OPTS.threshold, scoreBatch: async (current, candidates) =>
      candidates.map(() => 0.9) });
    assert.equal(eager.stats().scoredPairs, eagerPairs(32, OPTS.window), `eager cost is depth-independent (${depth})`);
  }
});

test('a stricter threshold spreads the walk less, and the demand shrinks with it', async () => {
  // The saving depends on how far the walk spreads, so it is reported at a second threshold rather than only at
  // the default. The same graph, the same anchor, two thresholds; a walk that stops earlier asks for less.
  const run = async (threshold: number): Promise<{ rows: number; pairs: number }> => {
    const graph = graphOf(48);
    const asked: DemandRow[] = [];
    const demand = await graph.recallDemand(['s47'], { ...OPTS, threshold, depth: 4 }, indexScorer(asked));
    return { rows: demand.rows, pairs: demand.pairs };
  };
  const loose = await run(0.05);
  const strict = await run(0.9);

  assert.equal(loose.pairs, demandedPairs([{ index: 47, depth: 0 } as DemandRow], OPTS.window) + (loose.pairs - 16));
  assert.ok(strict.rows <= loose.rows, `tau 0.9 asks for ${strict.rows} rows, tau 0.05 for ${loose.rows}`);
  assert.ok(strict.pairs <= loose.pairs, `and pays ${strict.pairs} pairs against ${loose.pairs}`);
  assert.equal(strict.rows, 1, 'at 0.9 only the anchor clears nothing: one row, then the dead end');
});

test('a scorer that throws leaves no entry behind: the next sweep can still claim the row', async () => {
  // The claim is exclusive and it is held across an `await`, so the release path is the one that has to be
  // right. A throw from the scorer is the hardest case: the walk catches it as "no answer for this level", and
  // every claimed entry must go back unsettled or the segment is unreachable for the rest of the session.
  const graph = graphOf(8);
  const demand = await graph.recallDemand(['s7'], OPTS, async () => {
    throw new Error('backend exploded');
  });
  assert.equal(demand.pairs, 7, 'the row was claimed and offered, so its pairs are counted');
  assert.equal(demand.missedPairs, 7, 'and none of them was answered');
  assert.equal(graph.scoreCount, 0, 'nothing was written for a row nobody answered');
  assert.equal(graph.stats().scoredPairs, 0, 'and nothing is claimed to have been scored');

  // The same row, by the eager path, over the same graph: if the claim had been stranded this would skip s7.
  const asked: string[] = [];
  await graph.scoreNew({
    windowN: OPTS.window,
    threshold: OPTS.threshold,
    scoreBatch: async (current, candidates) => {
      asked.push(current.id);
      return candidates.map(() => 0.9);
    },
  });
  assert.ok(asked.includes('s7'), `the released row is offered again: ${asked.join(',')}`);
});

test('a row another walk owns is skipped, not waited for, and never scored twice', async () => {
  // Two concurrent walks over one anchor. The claim is taken before the first `await`, so the second walk sees
  // the row as owned and leaves it alone; whichever walk scores it, it is scored once.
  const graph = graphOf(10);
  let calls = 0;
  const rowsAsked: string[] = [];
  const scorer = async (rows: readonly DemandRow[]): Promise<readonly (readonly number[])[]> => {
    calls += 1;
    for (const row of rows) rowsAsked.push(row.id);
    await new Promise((resolve) => setImmediate(resolve));
    return rows.map((row) => row.candidates.map(() => 0.9));
  };

  const [first, second] = await Promise.all([
    graph.recallDemand(['s9'], { ...OPTS, depth: 4 }, scorer),
    graph.recallDemand(['s9'], { ...OPTS, depth: 4 }, scorer),
  ]);

  assert.equal(rowsAsked.filter((id) => id === 's9').length, 1, `the anchor's row is offered once: ${rowsAsked.join(',')}`);
  assert.equal(new Set(rowsAsked).size, rowsAsked.length, `no row is offered twice: ${rowsAsked.join(',')}`);
  assert.equal(calls, rowsAsked.length === 0 ? 0 : calls, 'one scorer call per level at most');
  assert.equal(graph.scoreCount, graph.stats().scoredPairs, 'the graded pairs and the offer count agree');
  assert.ok(first.skipped + second.skipped > 0, 'the second walk reports the rows it could not have');
  assert.equal(graph.recall(['s9'], { ...OPTS, depth: 4 }).length > 0, true, 'and the walk that won left a walkable graph');
});

test('the budget stops the demand between levels, and the walk finishes on what it holds', async () => {
  // `recall.anchorWaitMs` is the caller's deadline, and it is spent between levels so an in-flight call is never
  // abandoned: the level already claimed is answered and kept, and no further level is asked for.
  const graph = graphOf(24);
  const asked: DemandRow[] = [];
  let levels = 0;
  const demand = await graph.recallDemand(
    ['s23'],
    { ...OPTS, depth: 4 },
    indexScorer(asked),
    () => {
      levels += 1;
      return levels <= 1;
    },
  );

  assert.equal(demand.stop, 'budget', 'the walk says why it stopped asking');
  assert.ok(demand.rows > 0, 'the level it was allowed to ask for was asked for');
  assert.deepEqual([...new Set(asked.map((row) => row.depth))], [0], 'and only that level');
  assert.ok(graph.stats().scoredPairs > 0, 'the pairs it paid for are in the graph');
});
