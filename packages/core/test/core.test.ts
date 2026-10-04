import test from 'node:test';
import assert from 'node:assert/strict';

import type { AssemblyPolicy, AssemblyResult, AssociationEdge, Cell, Segment, SegmentKind } from '../src/types.ts';
import { defaultPolicy } from '../src/types.ts';
import { cellPolicyOf } from './preset-fixture.ts';
import { estimateTokens, segmentEvent, splitBlocks } from '../src/segmenter.ts';
import { AssociationGraph, decayedWeight } from '../src/assoc-graph.ts';
import { assemble } from '../src/assembler.ts';
import { AttemptController, normalizeProbs, orderPlans } from '../src/plan-gate.ts';
import { llmCallCost, s1CallCost, summarizeTask, PRICES } from '../src/telemetry.ts';
import type { LlmCallEvent, S1CallEvent, TelemetryEvent } from '../src/telemetry.ts';

const SESSION = 'sess-1';

function seg(id: string, seq: number, tokens: number, kind: SegmentKind = 'assistant'): Segment {
  return { id, sessionId: SESSION, seq, kind, tokens, text: `text of ${id}`, ts: 1000 + seq };
}

function edge(from: string, to: string, w: number, verifiedAt = 1000): AssociationEdge {
  return { from, to, w, wTier1: w, source: 's1-score', verifiedAt, provenance: 'test' };
}

// ---------------------------------------------------------------- segmenter

test('estimateTokens: CJK counts ~1/char, latin ~4 chars/token', () => {
  // CJK branch of the estimator, exercised with Japanese kana (no Han characters)
  assert.equal(estimateTokens('こんにちは'), 5);
  assert.equal(estimateTokens('abcdefgh'), 2);
  assert.ok(estimateTokens('hello world') >= 2);
});

test('segmentEvent: short message stays one segment', () => {
  const out = segmentEvent({
    id: 'e1',
    sessionId: SESSION,
    seq: 1,
    kind: 'user',
    role: 'user',
    text: 'fix the failing test',
    ts: 1,
  });
  assert.equal(out.length, 1);
  assert.equal(out[0]?.id, 'e1');
  assert.equal(out[0]?.kind, 'user');
});

test('segmentEvent: long tool result is chunked with parent id and overlap', () => {
  const lines = Array.from({ length: 300 }, (_, i) => `line ${i}: ${'x'.repeat(60)}`);
  const text = lines.join('\n');
  const out = segmentEvent({ id: 'tr1', sessionId: SESSION, seq: 2, kind: 'toolResult', text, ts: 2 });
  assert.ok(out.length > 1, 'expected multiple chunks');
  for (const [i, s] of out.entries()) {
    assert.equal(s.chunkOf, 'tr1');
    assert.equal(s.id, `tr1#${i}`);
    assert.ok(s.tokens <= 700, `chunk ${i} too large: ${s.tokens}`);
  }
  assert.ok(out.at(-1)?.text.includes('line 299'), 'last line must appear in the tail chunk');
});

test('splitBlocks: a code fence survives as one block, a list survives as one block', () => {
  // The two cases where a line-based split destroys meaning: a diff is not two facts, and a numbered list is
  // not meaningful from its third item.
  const diff = ['--- a/x.ts', '+++ b/x.ts', '@@ -1,3 +1,3 @@', '-old', '+new', ' context'].join('\n');
  const fenced = ['before', '```diff', 'line one', 'line two', '```', 'after'].join('\n');
  const blocks = splitBlocks(fenced).map((b) => b.text);
  assert.ok(blocks.some((b) => b.includes('```diff') && b.includes('line two')), `fence must stay whole: ${JSON.stringify(blocks)}`);
  assert.ok(blocks.at(-1) === 'after', 'text after a fence is its own block');
  assert.ok(diff.includes('-old'), 'sanity: the fixture is a diff');

  const list = ['- alpha is the first', '- beta is the second', '- gamma is the third', '', 'after the list'].join('\n');
  const listBlocks = splitBlocks(list).map((b) => b.text);
  assert.ok(
    listBlocks.some((b) => b.includes('alpha') && b.includes('beta') && b.includes('gamma')),
    `a list must stay whole across its blank lines: ${JSON.stringify(listBlocks)}`,
  );
  assert.ok(listBlocks.at(-1) === 'after the list');
});

test('segmentEvent: a long prose paragraph is split on sentence boundaries, never mid-sentence', () => {
  // The cost of a mid-sentence cut is that the two halves score differently against a query and recall can keep
  // both, so the model pays for the overlap twice.
  const sentence = `The build failed because the test harness timed out while waiting for the child process ${'detail '.repeat(6)}.`;
  const text = Array.from({ length: 40 }, (_, i) => `${sentence} (${i})`).join(' ');
  const out = segmentEvent({ id: 'pr1', sessionId: SESSION, seq: 5, kind: 'assistant', text, ts: 5 });
  assert.ok(out.length > 1, 'expected multiple chunks');
  for (const [i, s] of out.entries()) {
    assert.equal(s.chunkOf, 'pr1');
    assert.equal(s.id, `pr1#${i}`);
    // Every chunk must end at a sentence boundary (possibly with a trailing label), never inside one.
    const trimmed = s.text.trim();
    assert.ok(
      /[.!?。！?"')\]]\s*$/.test(trimmed),
      `chunk ${i} must end on a sentence boundary, got: ...${trimmed.slice(-40)}`,
    );
  }
  assert.ok(out.at(-1)?.text.includes('(39)'), 'the last sentence must be in the tail chunk');
});

test('assemble: two chunks of one passage cannot both be selected', () => {
  // A long event is chunked with an overlap, so its chunks share a `chunkOf` parent. Recall scores them
  // independently; without the parent check both can be selected and the overlap is paid for twice.
  const graph = new AssociationGraph();
  const policy = defaultPolicy();
  policy.recall.threshold = 0.1;
  policy.recall.tier1 = 's1';

  const parent = { ...seg('long1', 0, 100), kind: 'toolResult' as SegmentKind };
  const chunks: Segment[] = [
    { ...parent, id: 'long1#0', chunkOf: 'long1', seq: 0, text: 'first half of the passage' },
    { ...parent, id: 'long1#1', chunkOf: 'long1', seq: 1, text: 'second half of the same passage' },
    { ...seg('other', 2, 100), id: 'other', chunkOf: undefined, seq: 2, text: 'a different event entirely' },
  ];
  const current = seg('x', 9, 20, 'user');
  graph.addSegments([...chunks, current]);
  // recall walks outward from the seed, so the edges run x -> chunk. Direction is not cosmetic: with the edges
  // the other way round recall finds nothing, which is exactly what a mistyped direction looks like.
  graph.upsertEdge({ from: 'x', to: 'long1#0', w: 0.9, wTier1: 0.9, source: 's1-noul', verifiedAt: 0, provenance: 'test' });
  graph.upsertEdge({ from: 'x', to: 'long1#1', w: 0.8, wTier1: 0.8, source: 's1-noul', verifiedAt: 0, provenance: 'test' });
  graph.upsertEdge({ from: 'x', to: 'other', w: 0.7, wTier1: 0.7, source: 's1-noul', verifiedAt: 0, provenance: 'test' });

  const res = assemble({
    graph,
    policy,
    pinned: [seg('p', 10, 10, 'systemPinned')],
    tail: [],
    current,
    contextWindow: 2000,
    reserveOutputTokens: 100,
    fixedOverheadTokens: 100,
    now: 1000,
    lambdaMs: 1e9,
    // The token-share floor is off by default, so a thin selection reaches the layout here and the test is about
    // de-duplication rather than about a fallback that would have emptied the block first.
    history: chunks,
  });

  const selectedIds = res.layout.recalled.map((s) => s.id);
  const fromPassage = selectedIds.filter((id) => id.startsWith('long1#'));
  assert.equal(fromPassage.length, 1, `one passage is one selection, got ${JSON.stringify(selectedIds)}`);
  assert.equal(res.recall.droppedSiblings, 1, 'and the dropped sibling is counted, not hidden');
  // The distinct event is untouched: de-duplication must not look like recall losing candidates.
  assert.ok(selectedIds.includes('other'), 'a different event is still selected');
});

// ------------------------------------------------------------- association

test('decayedWeight: exponential decay, half-life == λ·ln2', () => {
  assert.equal(decayedWeight(1, 0, 1000), 1);
  assert.ok(Math.abs(decayedWeight(1, 1000, 1000) - Math.exp(-1)) < 1e-9);
  const halfLife = 1000 * Math.LN2;
  assert.ok(Math.abs(decayedWeight(1, halfLife, 1000) - 0.5) < 1e-9);
});

test('recall: bounded BFS honours τ and depth', () => {
  // **The append order is load-bearing here, and this test is where the direction rule is visible in an old
  // fixture.** `x` used to be appended *first* and `a`/`b`/`c` after it, so the walk reached them by expanding
  // forward in time - the defect. The assertions are unchanged; what changed is that `x` is the segment the
  // session appended last, which is what a recall anchor always is (`observer.ts` roots the walk on the step's
  // newest input event), so every edge below is walked backwards. `c` is the oldest and is dropped by τ, not by
  // its position: it stays a neighbour of `x` and is still offered to the walk.
  const g = new AssociationGraph();
  g.addSegments([seg('c', 0, 10), seg('b', 1, 10), seg('a', 2, 10), seg('x', 3, 10, 'user')]);
  g.upsertEdge(edge('x', 'a', 0.9));
  g.upsertEdge(edge('a', 'b', 0.8));
  g.upsertEdge(edge('c', 'x', 0.3)); // below τ

  const hits = g.recall(['x'], { threshold: 0.55, depth: 2, lambdaMs: 1e9, now: 1000 });
  const ids = hits.map((h) => h.id);
  assert.deepEqual(ids, ['a', 'b'], 'a then b by weight; c filtered by τ');
  assert.equal(hits[1]?.via, 'a');
  assert.equal(hits[1]?.depth, 2);

  const shallow = g.recall(['x'], { threshold: 0.55, depth: 1, lambdaMs: 1e9, now: 1000 });
  assert.deepEqual(shallow.map((h) => h.id), ['a'], 'depth 1 stops before b');
});

/**
 * A node expands into **every** neighbour that clears τ and is older - there is no per-node cap.
 *
 * This test replaces one that asserted the opposite rule. It read *"recall: fanout keeps only the strongest k
 * neighbours"* and pinned that a walk from `x` with three older neighbours and `k = 2` returned exactly `a` and
 * `b`. **That assertion was wrong rather than stale**: it described a correct reading of a field that should not
 * have existed. `recall.fanout` (`k`) is retired (2026-10-05 - not in the originating brief, in no wiring record,
 * in no settings panel; `packages/core/src/config.ts`, `LEGACY_POLICY_KEYS`) so the behaviour it pinned is gone,
 * and a test asserting the cap would keep documenting a rule the method does not have.
 *
 * What replaces it is the property the walk now has, which is why the fixture is kept and extended rather than
 * deleted: the same three older neighbours, the same weights, plus a fourth (`d`, the weakest of the four) that
 * the old `k = 2` cut would have discarded unseen. The walk must place all four, and it must place `d` - the
 * weakest candidate is exactly what a strongest-k cut removes, so its presence is what distinguishes "no cap"
 * from "a cap so large it did not bite here".
 */
test('recall: every older neighbour over τ is expanded into - there is no per-node cap', () => {
  // Same re-orientation as above: the anchor is appended last, so its neighbours are all older than it. Ranking is
  // still by weight and still descending, which the first assertion pins; what is gone is the cut that turned a
  // ranking into a selection.
  const g = new AssociationGraph();
  g.addSegments([
    seg('e', 0, 10),
    seg('d', 1, 10),
    seg('c', 2, 10),
    seg('b', 3, 10),
    seg('a', 4, 10),
    seg('x', 5, 10, 'user'),
  ]);
  g.upsertEdge(edge('x', 'a', 0.95));
  g.upsertEdge(edge('x', 'b', 0.85));
  g.upsertEdge(edge('x', 'c', 0.75));
  g.upsertEdge(edge('x', 'd', 0.65));
  // The sub-τ edge, and it is here so that "no cap" cannot be misread as "no filtering": the walk still offers the
  // neighbour and still drops it, on relevance rather than on a count.
  g.upsertEdge(edge('x', 'e', 0.2));
  const hits = g.recall(['x'], { threshold: 0.5, depth: 1, lambdaMs: 1e9, now: 1000 });
  assert.deepEqual(hits.map((h) => h.id), ['a', 'b', 'c', 'd'], 'ranked by weight; e filtered by τ, nothing cut');
  // The weakest candidate is the one a strongest-k cut removes first, so it is asserted on its own: this is the
  // assertion the retired `k = 2` case would have failed, and it is why the fixture grew a fourth neighbour.
  assert.ok(
    hits.some((h) => h.id === 'd'),
    `the weakest older neighbour over τ must survive: ${JSON.stringify(hits.map((h) => h.id))}`,
  );
  // Depth is untouched by the removal, and so is the direction: `a` is a depth-1 hit with no older neighbour left
  // to expand into, so a deeper walk adds nothing - the seed already reaches every older segment it holds an edge
  // to, which is the shape an uncapped walk has on a star fixture.
  const deeper = g.recall(['x'], { threshold: 0.5, depth: 3, lambdaMs: 1e9, now: 1000 });
  assert.deepEqual(deeper.map((h) => h.id), ['a', 'b', 'c', 'd'], 'depth 3 finds no more: there is nothing at depth 2');
});

test('recall: a heavier path raises the weight without re-parenting the hit', () => {
  // `via` is the parent that *discovered* the hit, not the best predecessor seen so far. The two differ exactly
  // here: `b -> a` is heavier than the edge that discovered `a`, and letting that rewrite `via` is what made a
  // tree built from the hits merely tree-shaped.
  //
  // **The fixture had to be rebuilt, and the direction rule is why.** It used to be a two-cycle - `x -> a` light,
  // `a -> b`, then `b -> a` heavier - which only the old symmetric walk could traverse: `a -> b` needs `b` after
  // `a` in the append order while `b -> a` needs `a` after `b`, and no order satisfies both. So that fixture
  // asserted the rule through a shape the rule forbids. The rule itself is unchanged, and this is the shape that
  // carries it: a sibling `b`, discovered by the seed as well, reaches *back* to `a`. `a` is therefore discovered
  // second (0.5 against `b`'s 0.7) and still ends up ranked first, because the weight is the heaviest path and the
  // parent is the discovery edge - the two are allowed to disagree, which is the whole assertion.
  const g = new AssociationGraph();
  g.addSegments([seg('a', 0, 10), seg('b', 1, 10), seg('x', 2, 10, 'user')]);
  g.upsertEdge(edge('x', 'a', 0.5));
  g.upsertEdge(edge('x', 'b', 0.7));
  g.upsertEdge(edge('b', 'a', 0.9));

  const hits = g.recall(['x'], { threshold: 0.4, depth: 3, lambdaMs: 1e9, now: 1000 });
  const a = hits.find((h) => h.id === 'a');
  assert.ok(a !== undefined, `a must still be a hit: ${JSON.stringify(hits)}`);
  assert.equal(a.via, 'x', 'the parent that discovered it, not the heaviest predecessor');
  assert.equal(a.depth, 1, 'discovered at depth 1, and the depth is frozen with the parent');
  assert.equal(a.w, 0.9, 'while the weight is still the heaviest path found, which is what ranking reads');
  // Freezing the parent must not disturb the ranking: the heavier path found later puts `a` in front of the
  // sibling that discovered it.
  assert.deepEqual(hits.map((h) => h.id), ['a', 'b']);
});

// -------------------------------------------------------------- assembler

function buildAssemblerFixture(): {
  graph: AssociationGraph;
  pinned: Segment[];
  tail: Segment[];
  current: Segment;
  history: Segment[];
} {
  const g = new AssociationGraph();
  const pinned = [seg('pin', -1, 100, 'systemPinned')];
  const current = seg('x', 10, 20, 'user');
  const tail = [seg('t1', 9, 50, 'assistant')];
  const a = seg('a', 3, 100);
  const b = seg('b', 4, 150);
  const c = seg('c', 5, 300);
  const history = [a, b, c];
  // **Append order, and the reason it is `history` before `x`.** The anchor used to be appended second, with the
  // three history segments after it, so `x -> a` and its siblings were walked *forward* in time - the defect the
  // direction rule removes. A recall anchor is the step's newest segment, so the fixture now appends it last and
  // every edge from it is a backward step. Nothing else about the fixture moved: the same ids, weights, tokens and
  // seq values, and the `tail`/`history` arrays the assembler is handed are built from the same objects.
  g.addSegments([...pinned, ...history, ...tail, current]);
  g.upsertEdge(edge('x', 'a', 0.9));
  g.upsertEdge(edge('x', 'b', 0.8));
  g.upsertEdge(edge('x', 'c', 0.6));
  return { graph: g, pinned, tail, current, history };
}

test('assemble (C2/TAS on): every hit inside r and d is delivered, weight-ordered, x last', () => {
  // **This test used to assert the opposite, and the old expectation was wrong rather than stale.** It pinned
  // `['a', 'b']` with the message "weight order, c did not fit" - `c` clears the threshold and sits one edge from
  // the anchor, and was dropped by `recall.budgetRatio`'s token allowance alone. That is the mechanism the brief
  // does not declare (`packages/core/src/types.ts`, `AssemblyPolicy.recall`), so the assertion encoded the defect:
  // it stated a selection rule ("what fits the allowance") that is not the brief's ("what clears r inside d").
  // With the cap gone all three candidates are selected, and `candidates === selected` is the property that now
  // holds whenever nothing is excluded.
  const fx = buildAssemblerFixture();
  const policy = defaultPolicy();
  policy.recall.threshold = 0.5;
  const res = assemble({
    graph: fx.graph,
    policy,
    pinned: fx.pinned,
    tail: fx.tail,
    current: fx.current,
    stateProxy: 'task: fix the failing test; active target: src/foo.ts',
    contextWindow: 1000,
    reserveOutputTokens: 100,
    fixedOverheadTokens: 100,
    now: 1000,
    lambdaMs: 1e9,
    history: fx.history,
  });

  assert.equal(res.layout.anchor.id, 'x');
  assert.equal(res.layout.pinned.length, 1);
  assert.equal(res.layout.stateProxy !== undefined, true, 'TAS on => state proxy present');
  assert.deepEqual(res.layout.recalled.map((s) => s.id), ['a', 'b', 'c'], 'every hit inside r and d, in weight order');
  assert.equal(res.fallback, undefined);
  assert.equal(res.budget.total, 800);
  assert.equal(res.budget.byBlock.pinned, 100);
  assert.equal(res.budget.byBlock.tail, 50);
  assert.equal(res.budget.byBlock.anchor, 20);
  // 100 + 150 + 300: all three are accounted for, where the cap used to record 250 and silently drop `c`.
  assert.equal(res.budget.byBlock.recalled, 550);
  assert.equal(res.cacheStability.prefixTokensStable, 100);
  assert.equal(res.recall.candidates, 3);
  assert.equal(res.recall.selected, 3);
  assert.equal(
    res.recall.selected,
    res.recall.candidates,
    'nothing was dropped: no exclusion applies and there is no token allowance to fail',
  );
});

test('the question is the last block under every setting the policy has', () => {
  // **This test replaces one that pinned two question-first orders, and the old expectation was wrong rather than
  // stale.** It asserted that `questionPlacement: 'first'` produced `pinned, stateProxy, anchor, recalled, tail` —
  // i.e. it encoded the deleted axis as a capability, and half of what it pinned was a layout the paper does not
  // have. The paper separates the question from the long context and places it "at the end of every input", so what
  // is asserted now is that *no* field moves it: the field is gone from the type, and the orders below are the
  // closure of the settings that remain.
  const orders = [
    orderFor(() => {}),
    orderFor((p) => {
      p.tracePlacement = 'trace-append';
    }),
    orderFor((p) => {
      p.tas.on = false;
    }),
    orderFor((p) => {
      p.tas.on = false;
      p.tracePlacement = 'trace-append';
    }),
    orderFor((p) => {
      p.tas.on = false;
      p.recall.tier1 = 'off';
    }),
  ];
  for (const order of orders) {
    assert.equal(order[order.length - 1], 'anchor', `the question is last in ${order.join(', ')}`);
    assert.equal(order.filter((block) => block === 'anchor').length, 1, 'and it appears exactly once');
    assert.equal(order[0], 'pinned', 'with the pinned prefix first, as in every layout');
  }
  // The field a round would have to write to move it does not exist on the policy object at all.
  assert.equal('questionPlacement' in defaultPolicy(), false, 'no policy field can place the question');
});

/**
 * One assembled layout for a policy the caller adjusts, so each test below states only the axis it is about.
 *
 * The fixture and the window are the ones the surrounding assembler tests use, so a layout assertion here is
 * comparable with the budget assertions beside it.
 */
function layoutFor(mutate: (policy: AssemblyPolicy) => void): AssemblyResult {
  const fx = buildAssemblerFixture();
  const policy = defaultPolicy();
  policy.recall.threshold = 0.5;
  mutate(policy);
  return assemble({
    graph: fx.graph,
    policy,
    pinned: fx.pinned,
    tail: fx.tail,
    current: fx.current,
    stateProxy: 'task: fix the failing test; active target: src/foo.ts',
    contextWindow: 1000,
    reserveOutputTokens: 100,
    fixedOverheadTokens: 100,
    now: 1000,
    lambdaMs: 1e9,
    history: fx.history,
  });
}

/** The recorded order of a layout, which is the evidence a reader of a round checks. */
function orderFor(mutate: (policy: AssemblyPolicy) => void): string[] {
  return layoutFor(mutate).layout.order;
}

test('the two arms are the paper\'s: [T, x, q] is Trace as State, [x, T, q] is Trace Append, and both end in q', () => {
  // "trace as state and trace append use the same long context x and the same textual task state proxy T, with
  // order as the only difference", and the question is last in every one of the paper's conditions. The arm is the
  // only thing `tracePlacement` decides; the question's position is its own default (`'last'`), which is why these
  // two orders come out of one knob rather than two - and why the layouts every cell recorded before 2026-10-05
  // (`pinned, stateProxy, anchor, recalled, tail`) are not reachable from any pair of settings here.
  assert.deepEqual(
    orderFor((p) => {
      p.tracePlacement = 'trace-as-state';
    }),
    ['pinned', 'stateProxy', 'tail', 'recalled', 'anchor'],
    'Trace as State: the trace before the long context, the question last, and the block that moves last inside it',
  );
  assert.deepEqual(
    orderFor((p) => {
      p.tracePlacement = 'trace-append';
    }),
    ['pinned', 'tail', 'recalled', 'stateProxy', 'anchor'],
    'Trace Append: the same trace after the long context, and the question is still last',
  );

  // "Order as the only difference" has to mean it: the two arms carry the same blocks and cost the same, so a
  // measured difference between them cannot be an accounting artifact.
  const tas = layoutFor((p) => {
    p.tracePlacement = 'trace-as-state';
  });
  const appended = layoutFor((p) => {
    p.tracePlacement = 'trace-append';
  });
  assert.deepEqual({ ...appended.budget.byBlock }, { ...tas.budget.byBlock }, 'the same blocks are accounted either way');
  assert.equal(appended.budget.used, tas.budget.used, 'the layout is free');
  assert.deepEqual(appended.layout.recalled.map((s) => s.id), tas.layout.recalled.map((s) => s.id), 'same selection');
  assert.equal(appended.layout.stateProxy, tas.layout.stateProxy, 'and the same proxy text');

  // And the default is the method, not the control: a policy that states nothing lays out `M([T, x, q])`.
  assert.deepEqual(
    orderFor(() => {}),
    ['pinned', 'stateProxy', 'tail', 'recalled', 'anchor'],
    'the default arm is the paper\'s Trace as State',
  );
});

test('with TAS off there is no state proxy to move, and the recorded order says so under both arms', () => {
  // The figure's T is simply absent, so the placement axis has nothing to act on. Recording a `stateProxy` slot for
  // an arm with no T would make the record disagree with the layout it describes.
  //
  // **This used to build four layouts, two of them with the question first**, because the deleted axis could move it
  // and the test's own comment called that "the honest reading". It was not: the question is last in every layout
  // now, so the two arms collapse onto one order with TAS off, and that is the honest reading of an inert axis.
  for (const placement of ['trace-as-state', 'trace-append'] as const) {
    const order = orderFor((p) => {
      p.tas.on = false;
      p.tracePlacement = placement;
    });
    assert.deepEqual(order, ['pinned', 'tail', 'recalled', 'anchor'], `TAS off, ${placement}`);
    assert.equal(order.includes('stateProxy'), false, `no state slot is claimed, ${placement}`);
    // And no proxy is paid for either: with TAS off the empty T costs zero tokens rather than `estimateTokens('')`
    // (assembler.ts), so the budget does not carry a block the layout does not name.
    const off = layoutFor((p) => {
      p.tas.on = false;
      p.tracePlacement = placement;
    });
    assert.equal(off.layout.stateProxy, undefined, `no proxy block is emitted, ${placement}`);
    assert.equal(off.budget.byBlock.stateProxy, 0, `and it is not charged for, ${placement}`);
    assert.equal(off.layout.order.at(-1), 'anchor', `and the question is still last, ${placement}`);
  }
});

test('the arm moves only the trace: with the question removed, the two arms differ by T\'s side alone', () => {
  const withoutQuestion = (order: string[]) => order.filter((block) => block !== 'anchor');
  const side = (order: string[]) => (order.indexOf('stateProxy') < order.indexOf('recalled') ? 'before' : 'after');
  for (const placement of ['trace-as-state', 'trace-append'] as const) {
    const order = orderFor((p) => {
      p.tracePlacement = placement;
    });
    // Stated positionally rather than as a string comparison, because a negative assertion would also pass if the
    // trace were simply missing.
    assert.equal(side(order), placement === 'trace-as-state' ? 'before' : 'after', `the trace is ${placement}`);
    assert.equal(
      order[order.length - 1],
      'anchor',
      `${placement}: the question is last under the default, which is where the paper puts it`,
    );
    // The remainder is the same sequence in both arms - `tail, recalled` - so the arm is a relocation of T and not
    // a reshuffle, and `recalled` is the last block of the long context in both. (The question is in the same place
    // too, which the assertion above already states.)
    assert.deepEqual(
      withoutQuestion(order),
      placement === 'trace-as-state'
        ? ['pinned', 'stateProxy', 'tail', 'recalled']
        : ['pinned', 'tail', 'recalled', 'stateProxy'],
      `${placement}: nothing but T's position differs`,
    );
  }
});

test('the layout surface is one axis: three orders exist in total, and every one of them ends in the question', () => {
  // **This test replaces one that asserted the arm and the question's position composed into four orders.** That was
  // true, and the composition is exactly what was deleted: two of the four orders put the question in the middle of
  // the prompt, and the field that could produce them is gone. What is worth pinning now is the *closure* of the
  // layout space — the two arms with TAS on and the TAS-off baseline — because a fourth order appearing later would
  // mean a second axis had grown back.
  const seen = new Map<string, string[]>();
  for (const placement of ['trace-as-state', 'trace-append'] as const) {
    for (const tas of [true, false]) {
      for (const tier1 of ['s1', 'off'] as const) {
        const order = orderFor((p) => {
          p.tracePlacement = placement;
          p.tas.on = tas;
          p.recall.tier1 = tier1;
        });
        assert.equal(order.filter((b) => b === 'anchor').length, 1, `the question appears exactly once (${placement}/${String(tas)})`);
        assert.equal(order[0], 'pinned', `the pinned prefix is first in every layout (${placement}/${String(tas)})`);
        // **The block that moves is the last block of the long context, in every arm.** A change in the selection
        // breaks the cached prefix from that point on, so `recalled` is placed after `tail` — behind every block of
        // `x` that does not move — and only the question is behind it. Under `'trace-append'` T is behind it as well,
        // which is what that arm *is*: the trace after the long context, by definition. This is the layout half of
        // the cache-stability change (`assembler.ts`, `AssembleInput.recallOrder`); the ordering half is pinned in
        // its own test below, and the `tail`-in-front half is what "last block of the long context" states.
        assert.deepEqual(
          order.filter((b) => b !== 'pinned' && b !== 'anchor' && b !== 'stateProxy'),
          ['tail', 'recalled'],
          `the long context is tail then recalled (${placement}/${String(tas)})`,
        );
        assert.equal(order.at(-1), 'anchor', `and the question is last (${placement}/${String(tas)})`);
        if (tas) {
          assert.equal(order.filter((b) => b === 'stateProxy').length, 1, `the proxy appears exactly once (${placement})`);
        }
        seen.set(order.join('|'), order);
      }
    }
  }
  assert.deepEqual(
    [...seen.keys()].sort(),
    [
      'pinned|stateProxy|tail|recalled|anchor',
      'pinned|tail|recalled|anchor',
      'pinned|tail|recalled|stateProxy|anchor',
    ],
    `three orders exist in total, and no setting produces a fourth: ${JSON.stringify([...seen.values()])}`,
  );

  // Cost is a property of the blocks, not of the order, so the two arms pay the same.
  const costs = new Set(
    (['trace-as-state', 'trace-append'] as const).map((placement) =>
      JSON.stringify({ ...layoutFor((p) => { p.tracePlacement = placement; }).budget.byBlock }),
    ),
  );
  assert.equal(costs.size, 1, `every arm accounts for the same blocks: ${[...costs].join(' vs ')}`);
});

test('every cell records the paper\'s Trace-as-State layout: the arm is the default and the question is last', () => {
  // **This test was rewritten on 2026-10-05, and its old expectation was wrong rather than stale.** It used to pin
  // `['pinned', 'stateProxy', 'anchor', 'recalled', 'tail']` for C1 and C2 and `['pinned', 'anchor', 'recalled',
  // 'tail']` for C0 as "the order every cell records today", on the argument that adding the position axis must not
  // change what an arm *is*. What it was actually pinning is that **no cell reproduced either of the paper's arms**:
  // `q` sat second in C1 and C2 and first in C0, while the paper places it last in all three of its conditions and
  // the two layouts the project named its arms after were unreachable without an override no preset wrote. Keeping
  // that expectation would have kept the defect: the strings were the evidence of the defect, not of the design.
  //
  // What replaces it is the property the correction is actually for - all three cells run the method by default:
  // C0 the baseline `M([x, q])` (`tas.on: false` leaves no trace to place, and `tier1: 'off'` selects nothing),
  // C1 and C2 the paper's `M([T, x, q])`.
  const expected: Record<Cell, string[]> = {
    C0: ['pinned', 'tail', 'recalled', 'anchor'],
    C1: ['pinned', 'stateProxy', 'tail', 'recalled', 'anchor'],
    C2: ['pinned', 'stateProxy', 'tail', 'recalled', 'anchor'],
  };
  for (const cell of ['C0', 'C1', 'C2'] as const) {
    const policy = cellPolicyOf(cell);
    const fx = buildAssemblerFixture();
    const res = assemble({
      graph: fx.graph,
      policy,
      pinned: fx.pinned,
      tail: fx.tail,
      current: fx.current,
      stateProxy: 'task: fix the failing test',
      contextWindow: 1000,
      reserveOutputTokens: 100,
      fixedOverheadTokens: 100,
      now: 1000,
      lambdaMs: 1e9,
      history: fx.history,
    });
    assert.deepEqual(res.layout.order, expected[cell], `${cell}: the paper's Trace-as-State layout`);
    assert.equal(res.layout.order[res.layout.order.length - 1], 'anchor', `${cell}: the question is last`);
    // And the settings behind them: the arm is a knob no cell opts into, exactly like the trigger, and the question
    // is not a field at all — the order above is where its position is recorded.
    assert.equal(policy.tracePlacement, 'trace-as-state', `${cell}: the cell does not choose an arm`);
    assert.equal('questionPlacement' in policy, false, `${cell}: and does not state a question position`);
  }
  // C1 and C2 recording the same order is a fact about the design rather than a copy-paste: both are Trace as State,
  // and what separates them is recall selection, asserted in authority.test.ts.
  assert.deepEqual(expected.C1, expected.C2, 'both trace-carrying cells lay out the same way');
});

test('the cache-stable head follows the proxy out of it: T is only cached while it is in the head', () => {
  // Moving T behind the recalled context is not free, and the record has to say so. A number that still counted T
  // as part of the byte-stable prefix after the layout put it behind the moving blocks would be the worst kind of
  // stale record: correct arithmetic, wrong world.
  //
  // **The question is not part of this calculation any more.** This test used to run four layouts, two of them with
  // the question first, because the head grew by the question when a profile moved it forward. `q` is the last block
  // of every layout now, so it is always behind the cut, and what is left as a variable is T's side alone. **The
  // tail joined the head on 2026-10-05** (`recalled` moved behind it, for the cache reason the assembler's header
  // gives), so the head is pinned + tail + T-when-T-is-in-front, and the cut is `recalled` in both arms wherever the
  // block has anything in it.
  const head = layoutFor((p) => {
    p.tracePlacement = 'trace-as-state';
  });
  const appended = layoutFor((p) => {
    p.tracePlacement = 'trace-append';
  });
  const proxyTokens = head.budget.byBlock.stateProxy ?? 0;
  const tailTokens = head.budget.byBlock.tail ?? 0;

  // Trace as State: the head is the pinned prefix, the tail, and T. This is the default arm, which is why the
  // default head is the pinned prefix plus the tail plus T.
  assert.equal(
    head.cacheStability.layoutStableTokens,
    head.cacheStability.prefixTokensStable + tailTokens + proxyTokens,
    'T and the tail are both in the head',
  );
  // Trace Append: T is no longer behind a stable prefix, so the head is the pinned prefix plus the tail. The
  // difference between the two arms is the whole cost of Trace Append on the cache.
  assert.equal(
    appended.cacheStability.layoutStableTokens,
    appended.cacheStability.prefixTokensStable + tailTokens,
    'T is behind the moving blocks and cannot be cached, and the tail still can',
  );
  assert.equal(
    appended.cacheStability.tokensAfterCut - head.cacheStability.tokensAfterCut,
    proxyTokens,
    'and exactly the proxy re-prefills',
  );
  // The cut is where a re-selection breaks the prefix, and `recalled` is the block that moves - in both arms, and
  // in both it is the last block of the long context. It used to name T for every TAS-on layout and the pinned
  // prefix for the control, which described the layout of neither.
  assert.equal(head.cacheStability.cutAfterBlock, 'recalled', 'the cut is the block that moves');
  assert.equal(appended.cacheStability.cutAfterBlock, 'recalled', 'in both arms');
  // And what sits behind the cut is everything that is not in the head, in both arms - the identity the old
  // per-branch formula already had, now stated once. The question is in that tail in both: `anchor` is the last
  // block of the order, so its tokens are always paid for again after a cut.
  for (const res of [head, appended]) {
    assert.equal(
      res.cacheStability.tokensAfterCut,
      res.budget.used - res.cacheStability.layoutStableTokens,
      'the tail behind the cut is the whole view minus its stable head',
    );
    assert.equal(res.layout.order.at(-1), 'anchor', 'and the question is the last block of the layout');
    assert.equal(
      res.cacheStability.tokensAfterCut >= (res.budget.byBlock.anchor ?? 0),
      true,
      'so the question is behind the cut, never in the stable head',
    );
  }
});

test('prefixTokensStable never moves, and the question never joins the stable head', () => {
  // **Replaces a test whose subject was the deleted axis** ("the question joins the stable head only when it is
  // placed first"). The N1 acceptance criterion is recorded in STATUS.md as `prefixTokensStable === blocks.pinned`,
  // so it has to keep meaning exactly that — and the head can no longer gain the question, because the question is
  // the last block of every layout. What the test still has to prove is that the *arm* moves the head, and that the
  // question's tokens are behind the cut either way.
  const tas = layoutFor((p) => {
    p.tracePlacement = 'trace-as-state';
  });
  const appended = layoutFor((p) => {
    p.tracePlacement = 'trace-append';
  });
  for (const res of [tas, appended]) {
    assert.equal(res.cacheStability.prefixTokensStable, res.budget.byBlock.pinned, 'the prefix keeps its meaning');
    assert.equal(
      res.cacheStability.layoutStableTokens,
      res.budget.byBlock.pinned +
        (res.budget.byBlock.tail ?? 0) +
        (res === tas ? (res.budget.byBlock.stateProxy ?? 0) : 0),
      'the head is pinned and the tail, plus T only while the arm keeps T in front',
    );
    assert.equal(res.layout.order.at(-1), 'anchor', 'and the question is the last block, in the order and in the head');
    assert.equal(
      res.cacheStability.tokensAfterCut >= (res.budget.byBlock.anchor ?? 0),
      true,
      'so the question is always behind the cut',
    );
  }
  // The arm is what moves the head's T, and it is the only thing that does: the difference is the proxy, not the
  // question (which is in the tail of both) and not the recalled block (which is behind the cut in both).
  assert.equal(
    tas.cacheStability.layoutStableTokens - appended.cacheStability.layoutStableTokens,
    tas.budget.byBlock.stateProxy,
    'the head difference is T, exactly',
  );
  assert.equal(tas.cacheStability.cutAfterBlock, 'recalled');
  assert.equal(appended.cacheStability.cutAfterBlock, 'recalled');
});

test('assemble: TAS off drops the state proxy and orders recall chronologically', () => {
  const fx = buildAssemblerFixture();
  // Selection on with TAS off: the dropped fourth arm was the preset that named this pairing, so it is built
  // here from the full configuration by turning the state proxy off.
  const policy = cellPolicyOf('C2');
  policy.tas.on = false;
  policy.recall.threshold = 0.5;
  const res = assemble({
    graph: fx.graph,
    policy,
    pinned: fx.pinned,
    tail: fx.tail,
    current: fx.current,
    stateProxy: 'ignored when TAS is off',
    contextWindow: 1000,
    reserveOutputTokens: 100,
    fixedOverheadTokens: 100,
    now: 1000,
    lambdaMs: 1e9,
    history: fx.history,
  });
  assert.equal(res.layout.stateProxy, undefined);
  // All three clear r inside d, so all three are here - the same selection as the TAS-on test above, re-ordered
  // chronologically. `['a','b']` was this assertion before the cap was removed, and the missing `c` was the cap's
  // doing rather than the ordering rule's.
  assert.deepEqual(res.layout.recalled.map((s) => s.id), ['a', 'b', 'c'], 'chronological order by seq');
});

/**
 * The block's order is a cache property, so it is pinned here as one — **as a pair**: the same three steps assembled
 * both ways, with the ordering (`AssembleInput.recallOrder`) and without it.
 *
 * Without it the block is what the walk returned, which is what every recorded round delivered (`#walkHits` sorts
 * weight-descending), and that is the counter-example: the arrival of a new and heavier segment re-sorts everything
 * behind it, so a segment that has been in the block since the first step moves to the right and the prefix cache
 * loses every token from there on. With it, **content the previous step carried keeps its offset and new content
 * appends** — the requirement in one sentence.
 *
 * The assertion that carries the property is the invalidated-token count, and it is split into its two parts because
 * only one of them is what the ordering can remove: **tokens of the block that change position** (previously-selected
 * tokens that no longer sit at their old offset) is 700 for the walk's order on this fixture against **0** for this
 * one, while the re-prefill each step pays - those plus the genuinely new tail - is 1 850 against 450. The same two
 * figures are computed for the round this change was measured on in `AssembleInput.recallOrder`.
 *
 * The equality check at the foot is the other half: both orders carry the same segments, so the ordering cannot
 * change what the model reads, and a reorder that changed the *selection* could not pass as this change.
 */
test('the recalled block is ordered by first selection: a surviving segment keeps its offset and new ones append', () => {
  const policy = defaultPolicy();
  policy.recall.threshold = 0.25;
  /**
   * `recallOrder` undefined is the build before this change: no map, so the block is whatever the walk returned.
   * That is not a simulation of the old behaviour - it *is* the old behaviour, still reachable and still what a
   * replay or a stateless caller gets.
   */
  const run = (graph: AssociationGraph, recallOrder?: string[]): AssemblyResult =>
    assemble({
      graph,
      policy,
      pinned: [seg('pin', -1, 100, 'systemPinned')],
      tail: [],
      current: seg('x', 10, 20, 'user'),
      stateProxy: 'task: fix the failing test',
      contextWindow: 1000,
      reserveOutputTokens: 100,
      fixedOverheadTokens: 100,
      now: 1000,
      lambdaMs: 1e9,
      ...(recallOrder !== undefined ? { recallOrder } : {}),
    });

  /**
   * The session as it stood after `upto` history segments: `pinned` first, `x` last, and the history between them.
   *
   * Each new edge is **heavier** than the last (`d` is 0.95 against `a`'s 0.5), which is the shape a live walk has —
   * the step's own newest neighbour is the one it is most related to — and it is what makes a weight-ordered block
   * re-sort on every step. `x` is appended last, so every edge is a backward step, as the direction rule requires.
   */
  const graphFor = (upto: number): AssociationGraph => {
    const g = new AssociationGraph();
    const names = ['a', 'b', 'c', 'd'];
    const weights: Record<string, number> = { a: 0.5, b: 0.6, c: 0.7, d: 0.95 };
    const history = names.slice(0, upto).map((id, i) => seg(id, 3 + i, 100 + i * 50));
    g.addSegments([seg('pin', -1, 100, 'systemPinned'), ...history, seg('x', 10, 20, 'user')]);
    for (const s of history) g.upsertEdge(edge('x', s.id, weights[s.id] as number));
    return g;
  };
  const ids = (r: AssemblyResult) => r.layout.recalled.map((s) => s.id);

  // --- the ordering, step by step -----------------------------------------------------------------
  const order: string[] = [];
  const step1 = run(graphFor(2), order);
  assert.deepEqual(ids(step1), ['b', 'a'], 'step 1 places what it selected, in the walk\'s order');
  assert.deepEqual(order, ['b', 'a'], 'and the map is left holding that order');
  // `c` is the newest segment and the heaviest so far, so the walk ranks it first; it is appended instead, because
  // nothing that was already in the block may move.
  const step2 = run(graphFor(3), order);
  assert.deepEqual(ids(step2), ['b', 'a', 'c'], 'step 2 appends the arrival, heaviest or not');
  const step3 = run(graphFor(4), order);
  assert.deepEqual(ids(step3), ['b', 'a', 'c', 'd'], 'step 3 appends again, and nothing survives in a new place');
  assert.deepEqual(order, ['b', 'a', 'c', 'd'], 'the map is a permutation of the current block, and does not grow');

  // --- the same three steps without it, which is the build before the change ----------------------
  const before1 = run(graphFor(2));
  const before2 = run(graphFor(3));
  const before3 = run(graphFor(4));
  assert.deepEqual(ids(before1), ['b', 'a'], 'step 1 is the same either way: an empty map appends in the walk\'s order');
  assert.deepEqual(ids(before2), ['c', 'b', 'a'], 'step 2 re-sorts: the arrival is heaviest, so it goes first');
  assert.deepEqual(ids(before3), ['d', 'c', 'b', 'a'], 'step 3 re-sorts again, and every earlier segment moves right');

  // --- what the difference costs the cache -------------------------------------------------------
  /**
   * What one step's change costs the prefix cache: everything behind the longest byte-identical prefix, which is the
   * previous block's moved tail plus the current block's moving tail. Two different quantities live in that one
   * number and they are worth telling apart, because only the first is what the ordering can remove:
   *
   *   - **tokens of the block that change position**: previously-selected tokens that no longer sit at their old
   *     offset. An appended segment is not one of these - it was not in the previous prompt at all - so a pure append
   *     moves nothing however many tokens it adds.
   *   - **tokens re-prefilled**: the above, plus the newly added tail, which the cache has never seen. Every step
   *     that selects anything new pays this, whatever the order.
   */
  const stepCost = (previous: string[], previousTokens: number[], current: AssemblyResult) => {
    const now = ids(current);
    const nowTokens = current.layout.recalled.map((s) => s.tokens);
    let same = 0;
    while (same < previous.length && same < now.length && previous[same] === now[same]) same += 1;
    const moved = previousTokens.slice(same).reduce((total, t) => total + t, 0);
    const refilled = moved + nowTokens.slice(same).reduce((total, t) => total + t, 0);
    return { moved, refilled };
  };
  const tokensOf = (r: AssemblyResult) => r.layout.recalled.map((s) => s.tokens);

  const movedBefore = stepCost(ids(before1), tokensOf(before1), before2).moved
    + stepCost(ids(before2), tokensOf(before2), before3).moved;
  const refillBefore = stepCost(ids(before1), tokensOf(before1), before2).refilled
    + stepCost(ids(before2), tokensOf(before2), before3).refilled;
  const movedAfter = stepCost(ids(step1), tokensOf(step1), step2).moved
    + stepCost(ids(step2), tokensOf(step2), step3).moved;
  const refillAfter = stepCost(ids(step1), tokensOf(step1), step2).refilled
    + stepCost(ids(step2), tokensOf(step2), step3).refilled;

  // The walk's order moves every earlier segment on both steps: 250 + 450 of block changed position, and each step
  // bills its whole new block on top of the eviction because not even the first segment survives the prefix.
  assert.equal(movedBefore, 700, 'the walk\'s order: 700 tokens of block change position over the two steps');
  assert.equal(refillBefore, 1850, 'and the re-prefill is those plus each step\'s new tail');
  // This order: nothing changes position, and the only tokens re-prefilled are the two genuinely new segments.
  assert.equal(movedAfter, 0, 'this order moves nothing: both steps are pure appends');
  assert.equal(refillAfter, 450, 'and only the two arrivals are re-prefilled - 200 + 250');

  // --- dropping ----------------------------------------------------------------------------------
  // A segment that leaves the block leaves the map, and the segments behind it close the gap - which no ordering can
  // avoid, and which is why the ordering only claims that *additions* are free.
  const dropped = run(graphFor(3), order);
  assert.deepEqual(ids(dropped), ['b', 'a', 'c'], 'a segment the walk no longer returns is dropped');
  assert.deepEqual(order, ['b', 'a', 'c'], 'and the map is pruned with it, so a re-selection starts from the current block');

  // --- the equality check ------------------------------------------------------------------------
  assert.notDeepEqual(ids(step3), ids(before3), 'the two orders really are different, so the equality below is not vacuous');
  const textOf = (r: AssemblyResult) => r.layout.recalled.map((s) => s.text).sort();
  assert.deepEqual([...ids(step3)].sort(), [...ids(before3)].sort(), 'the same segments, in the same set, in both orders');
  assert.deepEqual(textOf(step3), textOf(before3), 'and the same text for each of them');
  assert.equal(step3.recall.selected, before3.recall.selected, 'so the selection count cannot differ either');
  assert.equal(step3.budget.byBlock.recalled, before3.budget.byBlock.recalled, 'nor the tokens it costs');
  assert.equal(step3.recall.candidates, before3.recall.candidates, 'nor what the walk found');
});

test('assemble: tier1 off (C0/C1) leaves the recalled block empty by design', () => {
  const fx = buildAssemblerFixture();
  const policy = cellPolicyOf('C0');
  const res = assemble({
    graph: fx.graph,
    policy,
    pinned: fx.pinned,
    tail: fx.tail,
    current: fx.current,
    contextWindow: 1000,
    reserveOutputTokens: 100,
    fixedOverheadTokens: 100,
    now: 1000,
    lambdaMs: 1e9,
    history: fx.history,
  });
  assert.deepEqual(res.layout.recalled, []);
  assert.equal(res.layout.stateProxy, undefined);
  // C0's two ordering switches, asserted where the assembler is: no TAS, no S1 selection. The plan gate used to be
  // a third line here and is no longer a policy field at all (`packages/core/src/types.ts` says why); its absence
  // is asserted in authority.test.ts, where the cell presets are pinned.
  assert.equal(policy.tas.on, false);
  assert.equal(policy.recall.tier1, 'off');
});

test('assemble: a selector that selected nothing degrades to the recency window', () => {
  // The guard that matters. One 5-token hit in a window with hundreds of tokens free is a *thin* selection, and
  // thin is the expected shape of a working selector; the count floor is what catches a *broken* one, so this test
  // raises it above the selection on purpose. A default that degraded here would throw away confident results in
  // the ordinary case, which is what the old token-share floor did on 9 of 9 steps of a live run.
  const g = new AssociationGraph();
  const pinned = [seg('pin', -1, 50, 'systemPinned')];
  const current = seg('x', 10, 20, 'user');
  const tiny = seg('tiny', 2, 5);
  const older = seg('old', 1, 120);
  // `x` last: it is the anchor, and a recall anchor is the newest segment (the same re-orientation as
  // `buildAssemblerFixture`). `tiny` is appended after `old` so that the walk from `x` to `tiny` is a backward
  // step; the recency fallback below is drawn from `history`, which the caller passes explicitly.
  g.addSegments([...pinned, older, tiny, current]);
  g.upsertEdge(edge('x', 'tiny', 0.9)); // the only thing relevance found

  const policy = defaultPolicy();
  policy.recall.threshold = 0.5;
  policy.recall.minRecalledSegments = 2;
  const res = assemble({
    graph: g,
    policy,
    pinned,
    tail: [],
    current,
    contextWindow: 1000,
    reserveOutputTokens: 100,
    fixedOverheadTokens: 100,
    now: 1000,
    lambdaMs: 1e9,
    history: [older, tiny],
  });
  assert.equal(res.fallback, 'recency-window');
  assert.deepEqual(
    res.layout.recalled.map((s) => s.id),
    ['old', 'tiny'],
    'chronological history fills the block (recall exclusions reset)',
  );
});

test('assemble: a thin but real selection is delivered, not replaced', () => {
  // The default, stated as a test because it is the correction. One relevant segment in a large budget is the
  // method working: a selector that filled the budget would be selecting everything, which is the baseline it
  // claims to beat. `minRecalledShare` stays available for an experiment that wants the old floor, and asking
  // for it must still work.
  const g = new AssociationGraph();
  const pinned = [seg('pin', -1, 50, 'systemPinned')];
  const current = seg('x', 10, 20, 'user');
  const tiny = seg('tiny', 2, 5);
  const older = seg('old', 1, 120);
  // `x` last, as in the fixture above: the anchor is the newest segment, so the one relevant edge is a backward
  // step. Everything the test asserts is about the *floor* (`minRecalledSegments` / `minRecalledShare`), not about
  // which way the walk went.
  g.addSegments([...pinned, older, tiny, current]);
  g.upsertEdge(edge('x', 'tiny', 0.9));

  const policy = defaultPolicy();
  policy.recall.threshold = 0.5;
  const res = assemble({
    graph: g,
    policy,
    pinned,
    tail: [],
    current,
    contextWindow: 1000,
    reserveOutputTokens: 100,
    fixedOverheadTokens: 100,
    now: 1000,
    lambdaMs: 1e9,
    history: [older, tiny],
  });
  assert.equal(res.fallback, undefined, 'no fallback: one segment is a selection, not a failure');
  assert.deepEqual(res.layout.recalled.map((s) => s.id), ['tiny'], 'and it is the relevant one, not the recent ones');
  assert.equal(res.recall.selected, 1, 'the record says what was selected, so the ranking downstream consumed is visible');

  // Opting back in is still possible, and still reported as a fallback rather than as a selection. The floor's
  // share is taken of the room the window has left (`remaining`: 800 - 70 = 730 here, so the threshold is 182.5
  // tokens against a 5-token selection) rather than of the retired `floor(total × ρ)` allowance; at the default
  // μ = 0 the comparison is `5 < 0`, which is false, so the floor is inert and this is the only place it can fire.
  const withFloor = defaultPolicy();
  withFloor.recall.threshold = 0.5;
  withFloor.recall.minRecalledShare = 0.25;
  const floored = assemble({
    graph: g,
    policy: withFloor,
    pinned,
    tail: [],
    current,
    contextWindow: 1000,
    reserveOutputTokens: 100,
    fixedOverheadTokens: 100,
    now: 1000,
    lambdaMs: 1e9,
    history: [older, tiny],
  });
  assert.equal(floored.fallback, 'recency-window', 'the token-share floor still works when it is asked for');
});

test('assemble: fail-open fires on a pair the backend never judged, and only on that', async () => {
  // Two fixtures that differ in provenance alone, and both weights are below the threshold, so neither produces an
  // edge and recall returns nothing - the situation the fail-open rule exists for. What it must not do is stay
  // silent: `scoreNew` writes the local fallback's score when the backend does not answer, so a rule that asked for
  // "a score entry" treated an unanswered window as a judged one and left `unknownAdmitted` at zero through a round
  // in which 191 of 281 `s1_call` records failed and 11 of 49 assemblies fell back to recency.
  const build = async (backendAnswered: boolean) => {
    const g = new AssociationGraph();
    const pinned = [seg('pin', -1, 10, 'systemPinned')];
    const current = { ...seg('x', 10, 20, 'user'), text: 'delta epsilon' };
    const older = { ...seg('old', 1, 10), text: 'alpha beta gamma' };
    g.addSegments([older, current]);
    await g.scoreNew({
      windowN: 8,
      threshold: 0.55,
      // `undefined` is the batch scorer's way of saying the backend did not answer this window.
      scoreBatch: backendAnswered
        ? async (_current, candidates) => candidates.map(() => 0.2)
        : () => undefined,
    });
    const policy = defaultPolicy();
    policy.recall.threshold = 0.55;
    return assemble({
      graph: g,
      policy,
      pinned,
      tail: [],
      current,
      contextWindow: 4000,
      reserveOutputTokens: 100,
      fixedOverheadTokens: 100,
      now: 1000,
      lambdaMs: 1e9,
      history: [older],
    });
  };

  const unjudged = await build(false);
  assert.equal(unjudged.recall.candidates, 0, 'sanity: no edge, so the walk found nothing');
  assert.equal(unjudged.unknownAdmitted, 1, 'the pair the backend never judged is admitted, not read as irrelevant');
  assert.deepEqual(unjudged.layout.recalled.map((s) => s.id), ['old']);
  assert.equal(unjudged.fallback, undefined, 'so the step is not handed to the recency window');

  const judged = await build(true);
  assert.equal(judged.recall.candidates, 0, 'the same situation: a score below the threshold, so no edge');
  assert.equal(judged.unknownAdmitted, undefined, 'but a judged pair is a reading, not an absence of one');
  assert.equal(judged.fallback, 'recency-window', 'so this step does fall back, which is the guard working');
});

// ------------------------------------------------------- recall tree (walk record)

/** Every id a recall tree carries, depth-first. Used to compare the tree's node set with recall's own output. */
function treeIds(tree: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [id, child] of Object.entries(tree)) {
    out.push(id, ...treeIds(child as Record<string, unknown>));
  }
  return out;
}

/** Assert every value in the tree is a child object: an id keyed to ids, never a weight, kind, depth or count. */
function assertIdsOnly(tree: Record<string, unknown>, known: ReadonlySet<string>): void {
  for (const [id, child] of Object.entries(tree)) {
    assert.ok(known.has(id), `a segment id, got ${JSON.stringify(id)}`);
    assert.ok(typeof child === 'object' && child !== null && !Array.isArray(child), `a child object at ${id}`);
    assertIdsOnly(child as Record<string, unknown>, known);
  }
}

test('assemble: recallTree is the nested walk, one root, a grandchild, and leaves', () => {
  // The shape the owner specified: `{ <anchor>: { <child>: { <grandchild>: {} }, <child2>: {} } }`.
  const g = new AssociationGraph();
  const pinned = [seg('pin', -1, 10, 'systemPinned')];
  const current = seg('x', 10, 20, 'user');
  const a = seg('a', 1, 10);
  const b = seg('b', 2, 10);
  const c = seg('c', 3, 10);
  // **Appended backwards, and that is the direction rule.** The chain is `x -> a -> b` plus `x -> c`, and an
  // expansion is only ever to an *older* segment, so the append order has to be `c, b, a, x`: `x` is the anchor
  // and therefore the newest, `a` is older than `x`, and `b` is older than `a`. The old fixture appended
  // `x, a, b, c` and reached `a` and `b` by walking forward in time.
  g.addSegments([...pinned, c, b, a, current]);
  // x -> a -> b (child with a grandchild) and x -> c (a second leaf child).
  g.upsertEdge(edge('x', 'a', 0.9));
  g.upsertEdge(edge('a', 'b', 0.8));
  g.upsertEdge(edge('x', 'c', 0.7));

  const policy = defaultPolicy();
  policy.recall.threshold = 0.5;
  const now = 1000;
  const lambdaMs = 1e9;
  const res = assemble({
    graph: g,
    policy,
    pinned,
    tail: [],
    current,
    contextWindow: 4000,
    reserveOutputTokens: 100,
    fixedOverheadTokens: 100,
    now,
    lambdaMs,
    history: [a, b, c],
  });

  assert.deepEqual(res.recallTree, { x: { a: { b: {} }, c: {} } }, 'the tree recall actually walked');
  assertIdsOnly(res.recallTree, new Set(['x', 'a', 'b', 'c']));
  // The rule the owner was explicit about: the key stores the fragment id and nothing else, so the tree carries
  // exactly one node per hit, plus the anchor that seeded the walk.
  assert.equal(treeIds(res.recallTree).length, res.recall.candidates + 1);
  assert.equal(res.recall.candidates, 3, 'and it agrees with the count of the walk');

  // The node set is exactly what recall returned, plus the anchor - no node added, none dropped. Asserted against
  // recall's own output rather than against the fixture, so a change to the walk moves both sides together.
  const hits = g.recall([current.id], {
    threshold: policy.recall.threshold,
    depth: policy.recall.depth,
    lambdaMs,
    now,
  });
  assert.deepEqual(
    treeIds(res.recallTree).sort(),
    [current.id, ...hits.map((h) => h.id)].sort(),
    'the tree carries every hit recall returned and nothing else',
  );
});

test('assemble: a walk that finds nothing writes recallTree {}, not undefined', () => {
  const g = new AssociationGraph();
  const pinned = [seg('pin', -1, 10, 'systemPinned')];
  const current = seg('x', 10, 20, 'user');
  const older = seg('old', 1, 10);
  g.addSegments([...pinned, current, older]); // no edges: the anchor has nothing to walk to

  const policy = defaultPolicy();
  policy.recall.threshold = 0.5;
  const res = assemble({
    graph: g,
    policy,
    pinned,
    tail: [],
    current,
    contextWindow: 4000,
    reserveOutputTokens: 100,
    fixedOverheadTokens: 100,
    now: 1000,
    lambdaMs: 1e9,
    history: [older],
  });

  assert.equal(res.recall.candidates, 0, 'sanity: the walk found nothing');
  assert.ok('recallTree' in res, 'the field is written even when there is nothing in it');
  assert.notEqual(res.recallTree, undefined, '"recall found nothing" is not "not measured"');
  assert.deepEqual(res.recallTree, {});
  assert.equal(Object.keys(res.recallTree).length, 0, 'an empty object states it, and it is present');
});

test('assemble: a node reachable by two paths appears once, under the parent that reached it first', () => {
  const build = () => {
    const g = new AssociationGraph();
    const pin = seg('pin', -1, 10, 'systemPinned');
    const current = seg('x', 10, 20, 'user');
    const a = seg('a', 1, 10);
    const b = seg('b', 2, 10);
    const c = seg('c', 3, 10);
    const history = [a, b, c];
    // Appended `c, a, b, x`: both paths into `c` (`a -> c` and `b -> c`) have to be *backward* steps for the
    // diamond to be walkable at all, and the anchor `x` is last because a recall anchor is the newest segment.
    g.addSegments([pin, c, a, b, current]);
    return { g, pinned: [pin], current, history };
  };
  const run = (fx: ReturnType<typeof build>, policy: ReturnType<typeof defaultPolicy>) =>
    assemble({
      graph: fx.g,
      policy,
      pinned: fx.pinned,
      tail: [],
      current: fx.current,
      contextWindow: 4000,
      reserveOutputTokens: 100,
      fixedOverheadTokens: 100,
      now: 1000,
      lambdaMs: 1e9,
      history: fx.history,
    });

  // A diamond: x -> a -> c and x -> b -> c. c is reached twice and recorded once.
  const policy = defaultPolicy();
  policy.recall.threshold = 0.5;
  const diamond = build();
  diamond.g.upsertEdge(edge('x', 'a', 0.9));
  diamond.g.upsertEdge(edge('x', 'b', 0.8));
  diamond.g.upsertEdge(edge('a', 'c', 0.7));
  diamond.g.upsertEdge(edge('b', 'c', 0.6));
  const diamondRes = run(diamond, policy);
  assert.deepEqual(diamondRes.recallTree, { x: { a: { c: {} }, b: {} } });
  const diamondIds = treeIds(diamondRes.recallTree);
  assert.equal(diamondIds.length, new Set(diamondIds).size, `each id once: ${JSON.stringify(diamondIds)}`);
  assert.deepEqual([...diamondIds].sort(), ['a', 'b', 'c', 'x']);

  // The heavier path, in the shape the direction rule leaves it: `b -> a` is heavier than the edge that discovered
  // `a`, so `a`'s heaviest predecessor is a sibling discovered in the same pass, after it. `via` is frozen at
  // discovery, so the record stays the walk - `a` and `b` both under `x` - where a rewrite would have re-parented
  // `a` under a node the walk discovered later than it.
  //
  // **This half used to be a two-cycle** (`x -> a` light, `a -> b`, then `b -> a` heavier). That fixture is not
  // walkable by the fixed rule and never was walkable *by the rule it claims to test*: `a -> b` needs `b` after `a`
  // in the append order while `b -> a` needs `a` after `b`, so the only way to reach the heavier edge was a forward
  // step. The property it asserted - parent frozen, weight raised - is unchanged; only the shape that carries it
  // moved, from a cycle to a pair of siblings.
  const heavier = build();
  heavier.g.upsertEdge(edge('x', 'a', 0.5));
  heavier.g.upsertEdge(edge('x', 'b', 0.7));
  heavier.g.upsertEdge(edge('b', 'a', 0.9));
  const heavierPolicy = defaultPolicy();
  heavierPolicy.recall.threshold = 0.4;
  heavierPolicy.recall.depth = 3;
  const heavierRes = run(heavier, heavierPolicy);
  assert.deepEqual(heavierRes.recallTree, { x: { a: {}, b: {} } }, 'the discovery parent, not the heaviest edge');
  assert.deepEqual(
    heavierRes.layout.recalled.map((s) => s.id),
    ['a', 'b'],
    'and the ranking still follows the heaviest path found, which is what the weight is for',
  );
});

// --------------------------------------------------------------- plan gate

test('normalizeProbs: repairs Jev’s non-normalized output', () => {
  const n = normalizeProbs({ refund: 0.7, no_refund: 0.49 }); // documented 1.19 case
  const sum = Object.values(n).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
  assert.ok(Math.abs((n.refund ?? 0) - 0.7 / 1.19) < 1e-9);
  assert.deepEqual(normalizeProbs({}), {});
  assert.deepEqual(normalizeProbs({ a: 0, b: 0 }), { a: 0.5, b: 0.5 });
});

test('orderPlans: probability order, abstention on low confidence', () => {
  const plans = [
    { id: 'p1', summary: 'patch' },
    { id: 'p2', summary: 'revert' },
    { id: 'p3', summary: 'rewrite' },
  ];
  const scored = orderPlans(
    plans,
    [
      { id: 'p1', prob: 0.2, confidence: 0.9 },
      { id: 'p2', prob: 0.5, confidence: 0.8 },
      { id: 'p3', prob: 0.3, confidence: 0.7 },
    ],
    0.5,
  );
  assert.deepEqual(scored.order, ['p2', 'p3', 'p1']);
  assert.equal(scored.abstained, false);

  const weak = orderPlans(plans, [{ id: 'p1', prob: 0.9, confidence: 0.2 }], 0.5);
  assert.equal(weak.abstained, true);
  assert.deepEqual(weak.order, ['p1', 'p2', 'p3'], 'keeps the LLM order');
});

test('AttemptController: cap M=2, stops early on success, lists unexecuted plans', () => {
  const c = new AttemptController(['p1', 'p2', 'p3'], 2);
  assert.equal(c.next(), 'p1');
  c.record('p1', false);
  assert.equal(c.next(), 'p2');
  c.record('p2', true);
  assert.equal(c.next(), undefined);
  assert.equal(c.succeeded, 'p2');
  assert.equal(c.attempts, 2);
  assert.deepEqual(c.unexecuted(), ['p3']);

  const capped = new AttemptController(['a', 'b', 'c'], 2);
  capped.record('a', false);
  capped.record('b', false);
  assert.equal(capped.next(), undefined, 'cap reached without success');
  assert.equal(capped.succeeded, undefined);
});

// --------------------------------------------------------------- telemetry

test('cost model: llm call, s1 call, task aggregate', () => {
  const prices = PRICES['deepseek-flash-peak'];
  const llm: LlmCallEvent = {
    type: 'llm_call',
    schema: 1,
    ts: 1000,
    sessionId: SESSION,
    cell: 'C2',
    model: 'deepseek-flash',
    seq: 1,
    promptTokens: 2_000_000,
    cacheHitTokens: 1_000_000,
    cacheMissTokens: 1_000_000,
    outputTokens: 1_000_000,
    wallMs: 5000,
    approvalWaitMs: 1500,
    netLatencyMs: 3500,
    s1Assist: { calls: 2, tokens: 30_000, ms: 40 },
  };
  assert.ok(Math.abs(llmCallCost(llm, prices) - (0.006 + 0.3 + 1.2)) < 1e-9);
  assert.ok(Math.abs(s1CallCost(1_000_000) - 0.042) < 1e-12);

  const s1: S1CallEvent = {
    type: 's1_call',
    schema: 1,
    ts: 1100,
    provider: 'jev',
    role: 'assoc',
    kind: 'noul',
    questions: 20,
    inputTokens: 1_000_000,
    outputTokens: 0,
    ms: 300,
  };
  const events: TelemetryEvent[] = [llm, s1];
  const sum = summarizeTask(events, prices);
  assert.ok(Math.abs(sum.llmUsd - 1.506) < 1e-9);
  assert.ok(Math.abs(sum.s1Usd - 0.042) < 1e-12);
  assert.equal(sum.cacheHitRate, 0.5);
  assert.equal(sum.llmCalls, 1);
  assert.equal(sum.s1Calls, 1);
});

test('a telemetry type carries no field a run cannot populate, and `planGate` exists nowhere in it', () => {
  // The type system cannot report this: the build is pure type erasure (`scripts/build-packages.mjs`,
  // `stripTypeScriptTypes(source, { mode: 'strip' })`) and `typescript` is not installed, so a required field with
  // no assignment site ships silently - which is what `S1CallEvent.flags`/`LlmCallEvent.flags` were: a required
  // `{ tas, sel, planGate, degraded }` that 0 of the round's 5 992 `s1_call` records carried, naming a component
  // the policy no longer has. This is the runtime half of the check the typechecker would have done.
  const llm: LlmCallEvent = {
    type: 'llm_call', schema: 1, ts: 1000, sessionId: SESSION, cell: 'C2', model: 'deepseek-flash', seq: 1,
    promptTokens: 1, cacheHitTokens: 0, cacheMissTokens: 1, outputTokens: 1,
    wallMs: 1, approvalWaitMs: 0, netLatencyMs: 1,
    s1Assist: { calls: 0, tokens: 0, ms: 0 },
  };
  assert.equal('flags' in llm, false, 'no `flags` bucket: it described interventions nothing recorded');
  assert.equal('planGate' in llm, false, 'and the removed plan gate names no field of a telemetry event');
  const s1: S1CallEvent = {
    type: 's1_call', schema: 1, ts: 1100, provider: 'jev', role: 'assoc', kind: 'noul',
    questions: 1, inputTokens: 1, outputTokens: 0, ms: 1,
  };
  assert.equal('flags' in s1, false, '`s1_call` never had one, and must not gain one by accident');
  assert.equal(Object.keys(llm).some((k) => k.includes('planGate')), false);
  assert.equal(Object.keys(s1).some((k) => k.includes('planGate')), false);
});
