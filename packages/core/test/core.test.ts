import test from 'node:test';
import assert from 'node:assert/strict';

import type { AssociationEdge, Segment, SegmentKind } from '../src/types.ts';
import { defaultPolicy, cellPolicy } from '../src/types.ts';
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
  policy.recall.relevanceThreshold = 0.1;
  policy.recall.budgetRatio = 0.9;
  policy.recall.tier1 = 'embed';

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
  graph.upsertEdge({ from: 'x', to: 'long1#0', w: 0.9, wTier1: 0.9, source: 's1', verifiedAt: 0, provenance: 'test' });
  graph.upsertEdge({ from: 'x', to: 'long1#1', w: 0.8, wTier1: 0.8, source: 's1', verifiedAt: 0, provenance: 'test' });
  graph.upsertEdge({ from: 'x', to: 'other', w: 0.7, wTier1: 0.7, source: 's1', verifiedAt: 0, provenance: 'test' });

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
    // Without history the min-fill fallback (mu = 0.25 of a 1620-token budget) fires on this small fixture and
    // empties the block, which would test the fallback rather than the de-duplication.
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

test('recall: bounded BFS honours τ, depth and fanout', () => {
  const g = new AssociationGraph();
  g.addSegments([seg('x', 0, 10, 'user'), seg('a', 1, 10), seg('b', 2, 10), seg('c', 3, 10)]);
  g.upsertEdge(edge('x', 'a', 0.9));
  g.upsertEdge(edge('a', 'b', 0.8));
  g.upsertEdge(edge('c', 'x', 0.3)); // below τ

  const hits = g.recall(['x'], { relevanceThreshold: 0.55, depth: 2, fanout: 8, lambdaMs: 1e9, now: 1000 });
  const ids = hits.map((h) => h.id);
  assert.deepEqual(ids, ['a', 'b'], 'a then b by weight; c filtered by τ');
  assert.equal(hits[1]?.via, 'a');
  assert.equal(hits[1]?.depth, 2);

  const shallow = g.recall(['x'], { relevanceThreshold: 0.55, depth: 1, fanout: 8, lambdaMs: 1e9, now: 1000 });
  assert.deepEqual(shallow.map((h) => h.id), ['a'], 'depth 1 stops before b');
});

test('recall: fanout keeps only the strongest k neighbours', () => {
  const g = new AssociationGraph();
  g.addSegments([seg('x', 0, 10, 'user'), seg('a', 1, 10), seg('b', 2, 10), seg('c', 3, 10)]);
  g.upsertEdge(edge('x', 'a', 0.95));
  g.upsertEdge(edge('x', 'b', 0.85));
  g.upsertEdge(edge('x', 'c', 0.75));
  const hits = g.recall(['x'], { relevanceThreshold: 0.5, depth: 1, fanout: 2, lambdaMs: 1e9, now: 1000 });
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
  g.addSegments([...pinned, current, ...tail, ...history]);
  g.upsertEdge(edge('x', 'a', 0.9));
  g.upsertEdge(edge('x', 'b', 0.8));
  g.upsertEdge(edge('x', 'c', 0.6));
  return { graph: g, pinned, tail, current, history };
}

test('assemble (C4/TAS on): recalled block ordered by weight, x last, budget accounted', () => {
  const fx = buildAssemblerFixture();
  const policy = defaultPolicy();
  policy.recall.relevanceThreshold = 0.5;
  policy.recall.budgetRatio = 0.5;
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
  assert.deepEqual(res.layout.recalled.map((s) => s.id), ['a', 'b'], 'weight order, c did not fit');
  assert.equal(res.fallback, undefined);
  assert.equal(res.budget.total, 800);
  assert.equal(res.budget.byBlock.pinned, 100);
  assert.equal(res.budget.byBlock.tail, 50);
  assert.equal(res.budget.byBlock.anchor, 20);
  assert.equal(res.budget.byBlock.recalled, 250);
  assert.equal(res.cacheStability.prefixTokensStable, 100);
  assert.equal(res.recall.candidates, 3);
  assert.equal(res.recall.selected, 2);
});

test('xFirst places the task before history; the default places it last', () => {
  const build = (xFirst: boolean) => {
    const fx = buildAssemblerFixture();
    const policy = defaultPolicy();
    policy.recall.relevanceThreshold = 0.5;
    policy.recall.budgetRatio = 0.5;
    policy.xFirst = xFirst;
    return assemble({
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
  };

  // The order is the deliverable, so it is asserted as a sequence rather than inferred from field order.
  assert.deepEqual(build(false).layout.order, ['pinned', 'stateProxy', 'recalled', 'tail', 'anchor']);
  assert.deepEqual(build(true).layout.order, ['pinned', 'stateProxy', 'anchor', 'recalled', 'tail']);

  // Both orders carry the same blocks and the same budget: only the position of x moves, so a difference in
  // cost between the two would mean the branch had changed something it should not have.
  const last = build(false);
  const first = build(true);
  assert.equal(first.budget.used, last.budget.used, 'the layout is free');
  assert.deepEqual(
    { ...first.budget.byBlock },
    { ...last.budget.byBlock },
    'the same blocks are accounted either way',
  );
  assert.deepEqual(first.layout.recalled.map((s) => s.id), last.layout.recalled.map((s) => s.id));
});

test('the task joins the stable head only when it is placed first, and prefixTokensStable never moves', () => {
  const build = (xFirst: boolean) => {
    const fx = buildAssemblerFixture();
    const policy = defaultPolicy();
    policy.recall.relevanceThreshold = 0.5;
    policy.recall.budgetRatio = 0.5;
    policy.xFirst = xFirst;
    return assemble({
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
  };

  const last = build(false);
  const first = build(true);
  // The N1 acceptance criterion is recorded in STATUS.md as `prefixTokensStable === blocks.pinned`, so it must
  // keep meaning exactly that no matter where x goes.
  assert.equal(last.cacheStability.prefixTokensStable, last.budget.byBlock.pinned);
  assert.equal(first.cacheStability.prefixTokensStable, first.budget.byBlock.pinned);
  assert.equal(first.cacheStability.layoutStableTokens > last.cacheStability.layoutStableTokens, true,
    'x first makes the stable head longer by exactly the task');
  assert.equal(
    first.cacheStability.layoutStableTokens - last.cacheStability.layoutStableTokens,
    first.budget.byBlock.anchor,
    'and the difference is the anchor, not an approximation of it',
  );
});

test('assemble: TAS off drops the state proxy and orders recall chronologically', () => {
  const fx = buildAssemblerFixture();
  const policy = cellPolicy('C3'); // selection on, TAS off
  policy.recall.relevanceThreshold = 0.5;
  policy.recall.budgetRatio = 0.5;
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
  assert.deepEqual(res.layout.recalled.map((s) => s.id), ['a', 'b'], 'chronological order by seq');
});

test('assemble: tier1 off (C1/C2) leaves the recalled block empty by design', () => {
  const fx = buildAssemblerFixture();
  const policy = cellPolicy('C1');
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
  assert.equal(policy.planGate.on, false);
  assert.equal(policy.recall.tier1, 'off');
});

test('assemble: thin recall degrades to the recency window', () => {
  const g = new AssociationGraph();
  const pinned = [seg('pin', -1, 50, 'systemPinned')];
  const current = seg('x', 10, 20, 'user');
  const tiny = seg('tiny', 2, 5);
  const older = seg('old', 1, 120);
  g.addSegments([...pinned, current, tiny, older]);
  g.upsertEdge(edge('x', 'tiny', 0.9)); // 5 tokens << μ·budget

  const policy = defaultPolicy();
  policy.recall.relevanceThreshold = 0.5;
  policy.recall.budgetRatio = 0.5;
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
    cell: 'C4',
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
    flags: { tas: true, sel: true, planGate: true, degraded: false },
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
