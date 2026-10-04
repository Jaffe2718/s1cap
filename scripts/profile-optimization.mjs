#!/usr/bin/env node
// Offline engineering benchmark. No model calls, billing estimates, or solve-rate claims.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { AssociationGraph, lexicalScore } from '../packages/core/src/assoc-graph.ts';
import { estimateTokens } from '../packages/core/src/segmenter.ts';
import { deliverContext } from '../packages/dsh-plugin/src/context-delivery.ts';
import { scoreDemandRows } from '../packages/dsh-plugin/src/demand-scheduler.ts';
import { createStepObserver } from '../packages/dsh-plugin/src/step-observer.ts';
import { defaultPolicy } from '../packages/core/src/types.ts';

const argv = process.argv.slice(2);
const value = (key, fallback) => argv.includes(key) ? argv[argv.indexOf(key) + 1] : fallback;
const baseline = value('--baseline');
if (!baseline) throw Error('Usage: node scripts/profile-optimization.mjs --baseline <baseline-worktree> [--output profile_output/optimization.json]');
const output = resolve(value('--output', 'profile_output/optimization.json'));
const oldGraph = await import(pathToFileURL(resolve(baseline, 'packages/core/lib/assoc-graph.js')));
const oldDelivery = await import(pathToFileURL(resolve(baseline, 'packages/dsh-plugin/lib/context-delivery.js')));
const segment = (i, text = `database event ${i}`) =>
  ({ id: `s${i}`, sessionId: 'profile', kind: 'toolResult', seq: i, ts: 0, tokens: estimateTokens(text), text });
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const messageText = (message) => message.content.map((p) => p.text ?? '').join('');

function deliveryRun(deliver) {
  let visible = [];
  let injectedTokens = 0;
  let injectedChars = 0;
  let messages = 0;
  let promptTokens = 0;
  let coverageChecks = 0;
  const pool = Array.from({ length: 48 }, (_, i) => segment(i, `Fact ${i}: ` + `schema_${i} timeout_${i} rollback_${i}. `.repeat(12)));
  const stateProxy = '<trace_start>' + 'Inspect the schema and verify the migration. '.repeat(24) + '<trace_end>';
  const started = performance.now();
  for (let i = 0; i < pool.length; i++) {
    // A controlled surface replacement halfway through the sequence: facts lost
    // here must become eligible again, even if they were delivered before.
    if (i === 24) visible = visible.slice(-3);
    const recalled = pool.slice(Math.max(0, i - 7), i + 1);
    const result = deliver({ enabled: true, trigger: 'every-step', step: i + 2,
      messages: [], visibleMessages: visible, stateProxy, recalled,
      anchor: segment(1000 + i), order: ['pinned', 'stateProxy', 'tail', 'recalled', 'anchor'] });
    if (result.delivered) for (const message of result.messages) {
      const text = messageText(message);
      injectedTokens += estimateTokens(text);
      injectedChars += text.length;
      messages++;
      visible.push(message);
    }
    const texts = visible.map(messageText);
    assert.ok(texts.some((text) => text.includes(stateProxy)));
    for (const required of recalled) {
      assert.ok(texts.some((text) => text.includes(required.text)), `lost ${required.id} at step ${i}`);
      coverageChecks++;
    }
    promptTokens += texts.reduce((n, text) => n + estimateTokens(text), 0);
  }
  return { steps: pool.length, injectedMessages: messages, injectedChars, injectedTokensEstimate: injectedTokens,
    cumulativePromptTokensEstimate: promptTokens, coverageChecks, elapsedMs: performance.now() - started };
}

async function partialRow(Graph) {
  const graph = new Graph();
  const segments = Array.from({ length: 7 }, (_, i) => segment(i));
  graph.addSegments(segments);
  const snapshot = graph.snapshot();
  snapshot.scores = [4, 5].map((i) => ({ from: `s${i}`, to: 's6', w: 0.9, source: 's1-noul', at: 0 }));
  snapshot.edges = snapshot.scores.map((s) => ({ from: s.from, to: s.to, w: s.w, wTier1: s.w,
    source: s.source, verifiedAt: 0, provenance: 'profile' }));
  const restored = Graph.fromSnapshot(snapshot);
  let questions = 0;
  const result = await restored.recallDemand(['s6'], { window: 4, depth: 1, threshold: 0.55, lambdaMs: 0, now: 0 },
    async (rows) => rows.map((row) => row.candidates.map(() => { questions++; return 0.9; })));
  assert.equal(result.hits.length, 4);
  return { questions, hits: result.hits.map((h) => h.id).sort() };
}

// Corrected, uncached reference: timing against the old broken regex would
// reward a scorer for skipping useful work. The actual old scores are below.
function uncachedScore(a, b) {
  const tokens = (text) => new Set(text.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter((s) => s.length > 1));
  const left = tokens(a.text), right = tokens(b.text);
  let shared = 0;
  for (const token of left) if (right.has(token)) shared++;
  return left.size && right.size ? shared / Math.min(left.size, right.size) : 0;
}
const lexicalPool = Array.from({ length: 192 }, (_, i) => segment(i,
  Array.from({ length: 160 }, (_, j) => `field_${(i * 3 + j) % 256}`).join(' ')));
const pairs = lexicalPool.flatMap((s, i) => lexicalPool.slice(Math.max(0, i - 16), i).map((other) => [s, other]));
function lexicalRun(score) {
  let checksum = 0;
  const started = performance.now();
  for (const [a, b] of pairs) checksum += score(a, b);
  return { elapsedMs: performance.now() - started, checksum };
}
const reference = [], cached = [];
lexicalRun(lexicalScore); // steady-state window scoring, after token-set warmup
for (let i = 0; i < 5; i++) {
  const before = lexicalRun(uncachedScore), after = lexicalRun(lexicalScore);
  assert.equal(before.checksum, after.checksum);
  reference.push(before.elapsedMs); cached.push(after.elapsedMs);
}

const rows = Array.from({ length: 32 }, (_, i) => ({ id: `r${i}`, index: i + 1, depth: 1,
  current: segment(i), candidates: [segment(100)] }));
const fakeScore = async (current) => {
  await new Promise((resolve) => setTimeout(resolve, 4));
  return [current.seq / 32];
};
async function scheduleRun(concurrency) {
  const started = performance.now();
  // This is the exact old scheduling rule: await each row serially.
  const answers = concurrency === 1
    ? await (async () => { const out = []; for (const row of rows) out.push(await fakeScore(row.current)); return out; })()
    : await scoreDemandRows(rows, fakeScore, { concurrency, canStart: () => true });
  assert.deepEqual(answers, rows.map((r) => [r.current.seq / 32]));
  return performance.now() - started;
}
const serial = [], parallel = [];
for (let i = 0; i < 5; i++) { serial.push(await scheduleRun(1)); parallel.push(await scheduleRun(2)); }
const delivery = { baseline: deliveryRun(oldDelivery.deliverContext), optimized: deliveryRun(deliverContext) };
const paidPairs = { baseline: await partialRow(oldGraph.AssociationGraph), optimized: await partialRow(AssociationGraph) };
assert.deepEqual(paidPairs.baseline.hits, paidPairs.optimized.hits);
async function visibilityRun(useSurface) {
  const policy = defaultPolicy();
  policy.recall.anchorWaitMs = 0;
  policy.recall.depth = 1;
  let calls = 0, questions = 0;
  const observer = createStepObserver({ policy, sessionId: 'visible-profile', emit: () => {}, now: () => 0,
    contextWindow: 10000, reserveOutputTokens: 100, fixedOverheadTokens: 0, lambdaMs: 0,
    scoreBatch: async (_current, candidates) => { calls++; questions += candidates.length; return candidates.map(() => 0.9); },
  });
  const visible = [];
  for (let i = 0; i < 12; i++) {
    const message = { id: `m${i}`, role: i % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: `Inspect migration step ${i}.` }] };
    visible.push(message);
    await observer.observe({ messages: [message], step: i + 2 }, useSurface ? { visibleMessages: visible } : undefined);
    await new Promise((resolve) => setImmediate(resolve));
  }
  return { steps: visible.length, calls, questions, skipped: observer.stats().recallVisibleSkips };
}
const visibilityGate = { controlWithoutSurface: await visibilityRun(false), optimizedWithSurface: await visibilityRun(true) };
assert.equal(visibilityGate.optimizedWithSurface.calls, 0);
const relevant = segment(0, 'Database timeout 数据库'), candidate = segment(1, 'database retry 数据库');
const report = {
  schema: 1, createdAt: new Date().toISOString(), node: process.version,
  baselineCommit: execFileSync('git', ['-C', resolve(baseline), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  scope: 'Synthetic offline engineering benchmark; no task solve rates, provider token counts, cache billing, or live backend throughput measured.',
  delivery,
  injectionReduction: 1 - delivery.optimized.injectedTokensEstimate / delivery.baseline.injectedTokensEstimate,
  partialRow: paidPairs,
  visibilityGate,
  lexical: { pairs: pairs.length, reference: 'Unicode-correct uncached scorer',
    referenceMedianMs: median(reference), optimizedMedianMs: median(cached), speedup: median(reference) / median(cached),
    samples: { reference, cached }, checksumMatched: true,
    regression: { expected: 2 / 3, baseline: oldGraph.lexicalScore(relevant, candidate), optimized: lexicalScore(relevant, candidate) } },
  scheduling: { rows: rows.length, concurrency: 2, simulatedRowLatencyMs: 4,
    serialMedianMs: median(serial), parallelMedianMs: median(parallel), speedup: median(serial) / median(parallel),
    samples: { serial, parallel }, answersMatched: true },
};
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
