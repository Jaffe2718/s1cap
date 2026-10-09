/**
 * THE ANCHOR'S OWN ROW, OFFERED FIRST
 *
 * `AssociationGraph.scoreNew` walks the session's append order from its oldest unsettled entry, and the recall
 * walk needs the opposite end of it: the step's **anchor** — the newest input event (`observer.ts`,
 * `isInputEvent`) — scored against its predecessors. The two orders are opposite, and the lane is 4.6x too slow to
 * work both, which round `20261004-1239` (cell C2) measured from its own artifacts:
 *
 *   session wall (assembly #1 -> #26) : 369.2 s
 *   segments N = 228, cursor = 106/228, `scores` = a complete triangle over segments 0..105 = 5,565 pairs
 *   pairs OFFERED = Sum min(i, 1024) = 25,878      floor = 5,565 / 25,878 = 21.5 %
 *   the session generates pairs at 70.1/s; the lane settles them at 15.1/s
 *   candidates = 0 on 19 of 26 assemblies; `unknownAdmitted` = `selected` (40 = 40 ... 126 = 126) from #9 on
 *
 * So the newest segments had **no edges at all** — nothing above index 105 was ever offered — a walk rooted on one
 * returned nothing, and the fail-open rule in `assemble()` filled the block instead: 21,755 recalled tokens on
 * assembly #26, 91 % of that prompt. `recall.anchorWaitMs` (10 s) was already waiting for that row and gave up at
 * all 18 of those steps (`outcome: "gave-up"`, `polls` ~160); it waited for work nothing had asked for.
 *
 * `scoreNew({ anchorId })` is the graph half of the fix: the entry the caller names is offered **first**, before
 * the cursor's next entry, and it is claimed exactly like every other entry — `#taken`, marked before the first
 * `await` — so two sweeps can never be handed the same row. Scoring it does **not** move the cursor: `#scored` is
 * the contiguous settled prefix and only `#settle` advances it, so the anchor's row lands in `#settled` beside the
 * prefix, the cursor catches up over it when it fills, and the pair is never paid for twice.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { AssociationGraph, S1_DEFERRED } from '../src/assoc-graph.ts';
import type { Segment } from '../src/types.ts';

function segment(id: string, seq: number): Segment {
  return { id, sessionId: 's', kind: 'user', text: `text of ${id}`, tokens: 4, ts: seq, seq };
}

/** A graph of `n` segments, added in order, with its cursor at 0. */
function graphOf(n: number): AssociationGraph {
  const graph = new AssociationGraph();
  graph.addSegments(Array.from({ length: n }, (_unused, i) => segment(`s${String(i)}`, i)));
  return graph;
}

/** Every window a sweep offered, as `${current}:${candidates}` — one string per entry, so a re-offer is visible. */
function recordingScorer(asked: string[], weight = 0.9) {
  return async (current: Segment, candidates: readonly Segment[]): Promise<readonly number[]> => {
    asked.push(`${current.id}:${String(candidates.length)}`);
    return candidates.map(() => weight);
  };
}

test('a sweep told which entry is the anchor offers that row first', async () => {
  const graph = graphOf(12);
  const asked: string[] = [];

  await graph.scoreNew({ windowN: 1024, threshold: 0.55, scoreBatch: recordingScorer(asked), anchorId: 's9' });

  // The whole point: the anchor's own row is the first window the backend is asked about. Before the option
  // existed this was `s1:1` - the cursor's oldest unsettled entry - and the anchor's row came last, after all
  // 5,565 pairs in front of it on the round this reproduces at a twelfth of the scale.
  assert.equal(asked[0], 's9:9', `the anchor's own row is the first window offered: ${JSON.stringify(asked)}`);
  // And the oldest-first work is not lost: the same sweep carries on at the cursor behind the anchor. That is the
  // whole trade - the same throughput, spent in a better order.
  assert.deepEqual(asked.slice(1), ['s1:1', 's2:2', 's3:3', 's4:4', 's5:5', 's6:6', 's7:7', 's8:8', 's10:10', 's11:11'], 'and the cursor follows immediately, in its own order');
  assert.equal(new Set(asked).size, asked.length, 'every window is offered once, the anchor included');
  assert.equal(graph.scoreCount, 66, 'T(T-1)/2 = 66 pairs of twelve segments, each with one row');
  assert.equal(graph.stats().scoredPairs, 66, 'and the offer count is the pair count, not a multiple of it');
  assert.equal(graph.stats().judgedPairs, 66, 'every offer was answered, so the coverage ratio is 1.00 and not a lie');
  // The cursor ends where a plain sweep leaves it, because the anchor's out-of-order settlement is not a position:
  // `#settled` held 9 until the prefix reached it, and the prefix then swallowed it.
  assert.equal(graph.snapshot().scored, 12, 'the cursor caught up over the anchor and settled the whole order');
});

test('the anchor row is settled out of order, and that is not the cursor advancing', async () => {
  const graph = graphOf(12);
  const asked: string[] = [];

  // A budget that pays for the anchor's nine pairs and then refuses the next window. The refused entry goes back
  // unsettled (`#release`), which is what keeps the cursor where it was - and what makes `deferredPairs` count it.
  const first = await graph.scoreNew({
    windowN: 1024,
    threshold: 0.55,
    scoreBatch: recordingScorer(asked),
    anchorId: 's9',
    maxPairsPerSweep: 9,
  });

  assert.deepEqual(asked, ['s9:9'], 'the anchor row, whole, and nothing else: the budget stopped the sweep after it');
  assert.equal(first.scoredPairs, 9);
  assert.equal(first.deferredPairs, 57, 'the windows it did not offer are deferred: 1+2+...+8 + 10 + 11, and not the anchor');
  assert.equal(graph.scoreCount, 9, 'the graph holds the anchor\'s nine pairs and no others');
  // The invariant the priority must not break. Entry 9 is settled; entries 1..8 are not, so the settled *prefix* is
  // just entry 0 (which had no window at all), and the cursor reads 1 rather than 10.
  assert.equal(graph.snapshot().scored, 1, 'a row settled out of order does not move `#scored`');

  // A second sweep, told the same anchor and given no budget, does the rest - and does not buy the anchor twice.
  const second = await graph.scoreNew({ windowN: 1024, threshold: 0.55, scoreBatch: recordingScorer(asked), anchorId: 's9' });
  assert.deepEqual(asked, ['s9:9', 's1:1', 's2:2', 's3:3', 's4:4', 's5:5', 's6:6', 's7:7', 's8:8', 's10:10', 's11:11'], 'the settled anchor is skipped, not re-offered, and the cursor walks over it');
  assert.equal(second.scoredPairs, 57, 'the rest of the order: 66 - 9');
  assert.equal(graph.stats().scoredPairs, 66, 'and every pair of the session was offered exactly once');
  assert.equal(graph.stats().judgedPairs, 66, 'the deferral is what the budget held back, not a lost pair: all 66 were answered');
  assert.equal(graph.snapshot().scored, 12, 'the prefix then catches up over the anchor, as `#settle` says it does');
});

test('an anchor named twice is still one claim: two sweeps in flight cannot be handed the same row', async () => {
  // The exclusive claim, extended to the priority path. A priority that could be handed to two sweeps at once
  // would reintroduce the defect `#taken` exists for - the same pair paid for twice - from the other side.
  const graph = graphOf(12);
  const asked: string[] = [];
  const scorer = async (current: Segment, candidates: readonly Segment[]): Promise<readonly number[]> => {
    asked.push(`${current.id}:${String(candidates.length)}`);
    // Suspends *after* recording, so both sweeps are genuinely in flight with their entries held.
    await new Promise((resolve) => setImmediate(resolve));
    return candidates.map(() => 0.9);
  };

  await Promise.all([
    graph.scoreNew({ windowN: 1024, threshold: 0.55, scoreBatch: scorer, anchorId: 's9' }),
    graph.scoreNew({ windowN: 1024, threshold: 0.55, scoreBatch: scorer, anchorId: 's9' }),
  ]);

  assert.equal(asked.filter((window) => window === 's9:9').length, 1, `the anchor row is offered once: ${JSON.stringify(asked)}`);
  assert.equal(new Set(asked).size, asked.length, 'and no window at all is offered twice');
  assert.equal(graph.stats().scoredPairs, 66, 'both sweeps together offered every pair once');
});

test('a refused anchor row goes back unsettled: the entry the step named is never stranded', async () => {
  const graph = graphOf(6);
  const asked: string[] = [];
  let refuse = true;
  const scorer = async (current: Segment, candidates: readonly Segment[]): Promise<readonly number[] | typeof S1_DEFERRED> => {
    if (refuse) return S1_DEFERRED;
    asked.push(`${current.id}:${String(candidates.length)}`);
    return candidates.map(() => 0.9);
  };

  const refused = await graph.scoreNew({ windowN: 8, threshold: 0.55, scoreBatch: scorer, anchorId: 's4' });
  assert.equal(refused.scoredPairs, 0, 'a refusal spends nothing, the anchor row included');
  assert.equal(graph.scoreCount, 0, 'and no row is written for it, lexically or otherwise');

  refuse = false;
  await graph.scoreNew({ windowN: 8, threshold: 0.55, scoreBatch: scorer, anchorId: 's4' });
  assert.equal(asked[0], 's4:4', 'the held-back row is offered again, first, by the next sweep');
  assert.equal(graph.scoreCount, 15, 'and every pair of six segments is scored exactly once');
});

test('an id the graph does not hold prioritises nothing rather than guessing at a position', async () => {
  // A name that matches nothing must cost nothing: the walk is a cursor sweep, exactly as it was before the
  // option existed. `#at` is the one place a segment's position lives, and an id it does not carry has none.
  const graph = graphOf(6);
  const asked: string[] = [];

  await graph.scoreNew({ windowN: 8, threshold: 0.55, scoreBatch: recordingScorer(asked), anchorId: 'not-a-segment' });

  assert.deepEqual(asked, ['s1:1', 's2:2', 's3:3', 's4:4', 's5:5'], 'the cursor order, unchanged');
  assert.equal(graph.stats().scoredPairs, 15);
});
