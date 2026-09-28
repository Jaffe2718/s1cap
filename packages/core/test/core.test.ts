import test from 'node:test';
import assert from 'node:assert/strict';

import type { AssociationEdge, Segment, SegmentKind } from '../src/types.ts';
import { defaultPolicy, cellPolicy } from '../src/types.ts';
import { estimateTokens, segmentEvent } from '../src/segmenter.ts';
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
  assert.equal(estimateTokens('你好世界'), 4);
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

  const hits = g.recall(['x'], { tau: 0.55, depth: 2, fanout: 8, lambdaMs: 1e9, now: 1000 });
  const ids = hits.map((h) => h.id);
  assert.deepEqual(ids, ['a', 'b'], 'a then b by weight; c filtered by τ');
  assert.equal(hits[1]?.via, 'a');
  assert.equal(hits[1]?.depth, 2);

  const shallow = g.recall(['x'], { tau: 0.55, depth: 1, fanout: 8, lambdaMs: 1e9, now: 1000 });
  assert.deepEqual(shallow.map((h) => h.id), ['a'], 'depth 1 stops before b');
});

test('recall: fanout keeps only the strongest k neighbours', () => {
  const g = new AssociationGraph();
  g.addSegments([seg('x', 0, 10, 'user'), seg('a', 1, 10), seg('b', 2, 10), seg('c', 3, 10)]);
  g.upsertEdge(edge('x', 'a', 0.95));
  g.upsertEdge(edge('x', 'b', 0.85));
  g.upsertEdge(edge('x', 'c', 0.75));
  const hits = g.recall(['x'], { tau: 0.5, depth: 1, fanout: 2, lambdaMs: 1e9, now: 1000 });
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
  policy.recall.tau = 0.5;
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

test('assemble: TAS off drops the state proxy and orders recall chronologically', () => {
  const fx = buildAssemblerFixture();
  const policy = cellPolicy('C3'); // selection on, TAS off
  policy.recall.tau = 0.5;
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
  policy.recall.tau = 0.5;
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
