#!/usr/bin/env node
// Deterministic offline evaluations. No model calls, provider token counts, or task solve-rate claims.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { AssociationGraph } from '../packages/core/src/assoc-graph.ts';
import { estimateTokens } from '../packages/core/src/segmenter.ts';
import { deliverContext } from '../packages/dsh-plugin/src/context-delivery.ts';

const argv = process.argv.slice(2);
const value = (key, fallback) => argv.includes(key) ? argv[argv.indexOf(key) + 1] : fallback;
const baseline = value('--baseline');
if (!baseline) {
  throw Error('Usage: node scripts/eval-optimization.mjs --baseline <worktree> [--history <turns.json>] [--output <file>]');
}
const output = resolve(value('--output', 'profile_output/simple-evals.json'));
const historyFile = value('--history');
const historyLabel = value('--history-label', historyFile ? resolve(historyFile).split('/').slice(-2).join('/') : undefined);
const baselineCommit = value('--baseline-commit', 'unknown');
const optimizedCommit = value('--optimized-commit', 'unknown');
const oldDelivery = await import(pathToFileURL(resolve(baseline, 'packages/dsh-plugin/lib/context-delivery.js')));
const repetitions = 5;
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const messageText = (message) => message.content?.map?.((part) => part.text ?? '').join('') ?? '';
const segment = (id, seq, text, sessionId = 'simple-eval') => ({
  id, sessionId, kind: 'toolResult', seq, ts: seq, tokens: estimateTokens(text), text,
});

function deliveryOnce(deliver, steps, compactionEvery) {
  let visible = [];
  let injectedTokens = 0;
  let cumulativeVisibleTokens = 0;
  let injectedMessages = 0;
  let compactions = 0;
  let coverageChecks = 0;
  const pool = Array.from({ length: steps }, (_, i) => segment(
    `fact-${i}`, i, `Fact ${i}: service_${i % 11} uses schema_${i} with rollback_key_${i}. `.repeat(6),
  ));
  const stateProxy = '<trace_start>' + 'Preserve schema constraints and verify rollback behavior. '.repeat(12) + '<trace_end>';
  const started = performance.now();
  for (let i = 0; i < steps; i += 1) {
    if (compactionEvery !== null && i > 0 && i % compactionEvery === 0) {
      visible = visible.slice(-2);
      compactions += 1;
    }
    const recalled = pool.slice(Math.max(0, i - 7), i + 1);
    const result = deliver({
      enabled: true, trigger: 'every-step', step: i + 2, messages: [], visibleMessages: visible,
      stateProxy, recalled, anchor: segment(`anchor-${i}`, 10_000 + i, `anchor ${i}`),
      order: ['pinned', 'stateProxy', 'tail', 'recalled', 'anchor'],
    });
    if (result.delivered) {
      for (const message of result.messages) {
        const text = messageText(message);
        injectedTokens += estimateTokens(text);
        injectedMessages += 1;
        visible.push(message);
      }
    }
    const surface = visible.map(messageText);
    assert.ok(surface.some((text) => text.includes(stateProxy)), `trace missing at step ${i}`);
    for (const fact of recalled) {
      assert.ok(surface.some((text) => text.includes(fact.text)), `${fact.id} missing at step ${i}`);
      coverageChecks += 1;
    }
    cumulativeVisibleTokens += surface.reduce((sum, text) => sum + estimateTokens(text), 0);
  }
  return {
    steps, compactionEvery, compactions, injectedMessages, injectedTokensEstimate: injectedTokens,
    cumulativeVisibleTokensEstimate: cumulativeVisibleTokens, coverageChecks,
    elapsedMs: performance.now() - started,
  };
}

function deliveryCase(steps, compactionEvery) {
  // Warm both code paths before collecting timing samples.
  deliveryOnce(oldDelivery.deliverContext, Math.min(steps, 32), compactionEvery);
  deliveryOnce(deliverContext, Math.min(steps, 32), compactionEvery);
  const controls = [], optimized = [];
  for (let i = 0; i < repetitions; i += 1) {
    controls.push(deliveryOnce(oldDelivery.deliverContext, steps, compactionEvery));
    optimized.push(deliveryOnce(deliverContext, steps, compactionEvery));
  }
  const control = controls[0], after = optimized[0];
  assert.equal(control.coverageChecks, after.coverageChecks);
  return {
    steps,
    compactionEvery,
    baseline: { ...control, elapsedMs: median(controls.map((x) => x.elapsedMs)) },
    optimized: { ...after, elapsedMs: median(optimized.map((x) => x.elapsedMs)) },
    injectedTokenReduction: 1 - after.injectedTokensEstimate / control.injectedTokensEstimate,
    cumulativeVisibleTokenReduction: 1 - after.cumulativeVisibleTokensEstimate / control.cumulativeVisibleTokensEstimate,
    timingSamplesMs: {
      baseline: controls.map((x) => x.elapsedMs), optimized: optimized.map((x) => x.elapsedMs),
    },
  };
}

const topicOf = (id) => Number(id.slice(1)) % 8;
function oracleScore(current, other) {
  const a = topicOf(current.id), b = topicOf(other.id);
  if (a === b) return Math.floor(Number(other.id.slice(1)) / 8) % 2 === 0 ? 0.82 : 0.62;
  if ((a + 1) % 8 === b || (b + 1) % 8 === a) return 0.42;
  return 0.08;
}

async function accuracyOnce(window, threshold) {
  const graph = new AssociationGraph();
  const items = Array.from({ length: 96 }, (_, i) => segment(
    `s${i}`, i, `topic_${i % 8} entity_${i % 8} observation_${i}`,
  ));
  graph.addSegments(items);
  const anchor = items.at(-1);
  const truth = new Set(items.slice(0, -1).filter((item) => topicOf(item.id) === topicOf(anchor.id)).map((item) => item.id));
  let questions = 0;
  const started = performance.now();
  const result = await graph.recallDemand([anchor.id], {
    window, threshold, depth: 1, lambdaMs: 0, now: 0,
  }, async (rows) => rows.map((row) => row.candidates.map((candidate) => {
    questions += 1;
    return oracleScore(row.current, candidate);
  })));
  const predicted = new Set(result.hits.map((hit) => hit.id));
  let tp = 0;
  for (const id of predicted) if (truth.has(id)) tp += 1;
  const fp = predicted.size - tp;
  const fn = truth.size - tp;
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp / (tp + fn);
  return {
    window, threshold, truth: truth.size, selected: predicted.size, tp, fp, fn, precision, recall,
    f1: precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall),
    rows: result.rows, questions, elapsedMs: performance.now() - started,
  };
}

async function accuracyCase(window, threshold) {
  await accuracyOnce(window, threshold);
  const samples = [];
  for (let i = 0; i < repetitions; i += 1) samples.push(await accuracyOnce(window, threshold));
  const first = samples[0];
  for (const sample of samples) {
    assert.deepEqual(
      { tp: sample.tp, fp: sample.fp, fn: sample.fn, questions: sample.questions },
      { tp: first.tp, fp: first.fp, fn: first.fn, questions: first.questions },
    );
  }
  return { ...first, elapsedMs: median(samples.map((x) => x.elapsedMs)), timingSamplesMs: samples.map((x) => x.elapsedMs) };
}

function historicalReplay(deliver, turns, compactBeforeFinal) {
  let visible = [];
  let injectedTokens = 0;
  let injectedMessages = 0;
  let restoredFacts = 0;
  for (let i = 0; i < turns.length; i += 1) {
    if (compactBeforeFinal && i === turns.length - 1) visible = visible.slice(-1);
    const current = { id: `history-message-${i}`, role: 'user', content: [{ type: 'text', text: turns[i].text }] };
    visible.push(current);
    const recalled = turns.slice(0, i).map((turn, j) => segment(`history-message-${j}`, j, turn.text, 'historical-text'));
    const result = deliver({
      enabled: true, trigger: 'every-step', step: i + 2, messages: [current], visibleMessages: visible,
      stateProxy: '', recalled, anchor: segment(`history-anchor-${i}`, 100 + i, turns[i].text, 'historical-text'),
      order: ['pinned', 'recalled', 'tail', 'anchor'],
    });
    if (result.delivered) for (const message of result.messages.filter((item) => item.source?.form === 's1cap')) {
      const text = messageText(message);
      injectedTokens += estimateTokens(text);
      injectedMessages += 1;
      restoredFacts += recalled.filter((fact) => text.includes(fact.text)).length;
      visible.push(message);
    }
    const surface = visible.map(messageText);
    for (const fact of recalled) assert.ok(surface.some((text) => text.includes(fact.text)), `historical ${fact.id} missing`);
  }
  return { turns: turns.length, compactBeforeFinal, injectedMessages, injectedTokensEstimate: injectedTokens, restoredFacts };
}

const scaling = [32, 64, 128, 256].map((steps) => deliveryCase(steps, null));
const compaction = [16, 32].map((every) => deliveryCase(128, every));
const accuracy = [];
for (const window of [4, 8, 16, 32]) {
  for (const threshold of [0.35, 0.55, 0.7]) accuracy.push(await accuracyCase(window, threshold));
}

let historicalTextReplay = null;
if (historyFile) {
  const turns = JSON.parse(readFileSync(resolve(historyFile), 'utf8')).turns;
  assert.ok(Array.isArray(turns) && turns.length >= 2, 'history must contain at least two turns');
  historicalTextReplay = {
    source: historyLabel,
    turnHashes: turns.map((turn) => turn.sha256),
    noCompaction: {
      baseline: historicalReplay(oldDelivery.deliverContext, turns, false),
      optimized: historicalReplay(deliverContext, turns, false),
    },
    compactBeforeFinal: {
      baseline: historicalReplay(oldDelivery.deliverContext, turns, true),
      optimized: historicalReplay(deliverContext, turns, true),
    },
  };
}

const report = {
  schema: 1,
  createdAt: new Date().toISOString(),
  node: process.version,
  baselineCommit,
  optimizedCommit,
  repetitions,
  scope: 'Deterministic offline engineering evaluation; heuristic token estimates and synthetic relevance labels. No provider billing, model quality, live throughput, or task solve rate measured.',
  scaling,
  compaction,
  recallAccuracy: {
    corpusSegments: 96,
    topics: 8,
    relevantDefinition: 'Earlier segments with the same topic as the final anchor.',
    scorer: 'Deterministic graded oracle: same-topic 0.62/0.82, adjacent-topic 0.42, otherwise 0.08.',
    cases: accuracy,
  },
  historicalTextReplay,
};
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
