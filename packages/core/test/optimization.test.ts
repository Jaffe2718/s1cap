import test from 'node:test';
import assert from 'node:assert/strict';
import { AssociationGraph, lexicalScore } from '../src/assoc-graph.ts';
import { assemble } from '../src/assembler.ts';
import { defaultPolicy } from '../src/types.ts';
import type { Segment } from '../src/types.ts';
import { observeStep } from '../src/observer.ts';

const segment = (id: string, seq: number, text = id): Segment =>
  ({ id, seq, text, sessionId: 's', kind: 'user', ts: 0, tokens: 10 });
const opts = { window: 4, depth: 1, threshold: 0.55, now: 0, lambdaMs: 0 };

test('lexical scoring distinguishes words and supports Unicode; cached text can change', () => {
  const a = segment('a', 0, 'Database timeout 数据库');
  const b = segment('b', 1, 'database retry 数据库');
  assert.equal(lexicalScore(a, b), 2 / 3);
  assert.equal(lexicalScore(a, segment('c', 2, 'weather forecast')), 0);
  b.text = 'unrelated weather';
  assert.equal(lexicalScore(a, b), 0);
});

test('lowering recall threshold reads paid scores, including after a restart', async () => {
  const graph = new AssociationGraph();
  graph.addSegments([segment('a', 0), segment('b', 1)]);
  await graph.scoreNew({ windowN: 4, threshold: 0.8, scoreBatch: () => [0.6] });
  assert.equal(graph.recall(['b'], { ...opts, threshold: 0.8 }).length, 0);
  for (const g of [graph, AssociationGraph.fromSnapshot(graph.snapshot())]) {
    const result = await g.recallDemand(['b'], opts, async () => { throw new Error('must not rescore'); });
    assert.deepEqual(result.hits.map((h) => h.id), ['a']);
    assert.equal(result.pairs, 0);
  }
});

test('demand after widening a settled window buys only missing pairs, also after restore', async () => {
  const graph = new AssociationGraph();
  graph.addSegments(Array.from({ length: 6 }, (_, i) => segment(`s${i}`, i)));
  await graph.scoreNew({ windowN: 2, threshold: 0.55, scoreBatch: (_s, c) => c.map(() => 0.9) });
  for (const g of [graph, AssociationGraph.fromSnapshot(graph.snapshot())]) {
    const asked: string[] = [];
    await g.recallDemand(['s5'], opts, async (rows) => rows.map((r) => r.candidates.map((c) => {
      asked.push(c.id); return 0.9;
    })));
    assert.deepEqual(asked, ['s1', 's2']);
    assert.equal(g.recall(['s5'], opts).length, 4);
    assert.equal((await g.recallDemand(['s5'], opts)).pairs, 0);
  }
});

test('partial restored rows do not repay existing pairs or leave claims stranded', async () => {
  const graph = new AssociationGraph();
  graph.addSegments([segment('a', 0), segment('b', 1), segment('c', 2)]);
  const snap = graph.snapshot();
  snap.scores = [{ from: 'b', to: 'c', w: 0.7, source: 's1-noul', at: 0 }];
  const restored = AssociationGraph.fromSnapshot(snap);
  const bad = await restored.recallDemand(['c'], opts, async () => [[NaN]]);
  assert.equal(bad.judged, 0);
  assert.equal(bad.missedPairs, 1);
  const good = await restored.recallDemand(['c'], opts, async (rows) => {
    assert.deepEqual(rows[0]?.candidates.map((s) => s.id), ['a']);
    return [[0.8]];
  });
  assert.equal(good.judged, 1);
  assert.equal(restored.scoreCount, 2);
});

test('unknown fail-open candidates respect pinned, tail and anchor-sibling exclusions', () => {
  const graph = new AssociationGraph();
  const old = segment('old', 0);
  const pinned = { ...segment('pin', 1), kind: 'systemPinned' as const };
  const tail = segment('tail', 2);
  const sibling = { ...segment('q#0', 3), chunkOf: 'q' };
  const anchor = { ...segment('q#1', 4), chunkOf: 'q' };
  graph.addSegments([old, pinned, tail, sibling, anchor]);
  const result = assemble({ graph, policy: defaultPolicy(), pinned: [pinned], tail: [tail], current: anchor,
    excludeIds: [sibling.id], history: [old], contextWindow: 10000, reserveOutputTokens: 100,
    fixedOverheadTokens: 0, now: 0, lambdaMs: 0 });
  assert.deepEqual(result.layout.recalled.map((s) => s.id), ['old']);
  assert.equal(result.unknownAdmitted, 1);
});

test('a recovered backend replaces lexical guesses without repaying its own judgements', async () => {
  const graph = new AssociationGraph();
  graph.addSegments([segment('a', 0, 'shared words'), segment('b', 1, 'shared words')]);
  await graph.scoreNew({ windowN: 4, threshold: 0.55 });
  const result = await graph.recallDemand(['b'], opts, async () => [[0.1]]);
  assert.equal(result.judged, 1);
  assert.deepEqual(result.hits, [], 'a stale lexical edge must not override a backend rejection');
  assert.equal((await graph.recallDemand(['b'], opts, async () => [[0.9]])).pairs, 0);
});

test('a task starts without trace, then freezes its first nonempty trace instead of freezing absence', async () => {
  const graph = new AssociationGraph();
  const policy = defaultPolicy();
  policy.recall.tier1 = 'off';
  const proxyCache = { id: '', text: '' };
  const base = { graph, policy, proxyCache, sessionId: 's', step: 1, seq: 0, now: 0,
    contextWindow: 10000, reserveOutputTokens: 100, fixedOverheadTokens: 0, lambdaMs: 0 };
  const first = await observeStep({ ...base, messages: [
    { id: 'q', role: 'user', content: [{ type: 'text', text: 'fix database timeout' }] },
  ] });
  assert.equal(first.kind, 'assembled');
  assert.equal(proxyCache.text, '');
  const second = await observeStep({ ...base, step: 2, seq: 1, messages: [
    { id: 'trace', role: 'assistant', content: [{ type: 'reasoning', text: 'Check the connection pool.' }] },
  ] });
  assert.equal(second.kind, 'assembled');
  assert.ok(proxyCache.text.includes('Check the connection pool.'));
  const frozen = proxyCache.text;
  await observeStep({ ...base, step: 3, seq: 2, messages: [
    { id: 'next', role: 'assistant', content: [{ type: 'reasoning', text: 'A later detail.' }] },
  ] });
  assert.equal(proxyCache.text, frozen);
});

test('fully covered sibling text is redundant, while a distinct sibling remains', () => {
  const graph = new AssociationGraph();
  const chunks = [
    { ...segment('doc#0', 0, 'database port 5432 and schema inventory'), chunkOf: 'doc' },
    { ...segment('doc#1', 1, 'database port 5432'), chunkOf: 'doc' },
    { ...segment('doc#2', 2, 'migration requires transaction rollback'), chunkOf: 'doc' },
  ];
  const current = segment('q', 3);
  graph.addSegments([...chunks, current]);
  for (const [i, chunk] of chunks.entries()) graph.upsertEdge({ from: chunk.id, to: current.id,
    w: 0.9 - i / 10, wTier1: 0.9 - i / 10, source: 's1-noul', verifiedAt: 0, provenance: 'test' });
  const result = assemble({ graph, policy: defaultPolicy(), pinned: [], tail: [], current,
    history: chunks, contextWindow: 10000, reserveOutputTokens: 100, fixedOverheadTokens: 0, now: 0, lambdaMs: 0 });
  assert.deepEqual(result.layout.recalled.map((s) => s.id), ['doc#0', 'doc#2']);
  assert.equal(result.recall.droppedSiblings, 1);
});
