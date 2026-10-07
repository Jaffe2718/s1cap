#!/usr/bin/env node
// Three-cell, offline context-availability replay. No model or S1 service is contacted.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { AssociationGraph, lexicalScore } from '../packages/core/src/assoc-graph.ts';
import { cellPolicyFromPreset } from '../packages/core/src/cell-preset.ts';
import { observeStep } from '../packages/core/src/observer.ts';
import { estimateTokens } from '../packages/core/src/segmenter.ts';
import { contextVisibility, deliverContext } from '../packages/dsh-plugin/src/context-delivery.ts';

const outputIndex = process.argv.indexOf('--output');
const output = resolve(outputIndex < 0 ? 'profile_output/cell-comparison.json' : process.argv[outputIndex + 1]);
const commitIndex = process.argv.indexOf('--commit');
const commit = commitIndex < 0 ? 'unknown' : process.argv[commitIndex + 1];
const cells = ['C0', 'C1', 'C2'];
const policies = Object.fromEntries(cells.map((cell) => [cell, cellPolicyFromPreset(
  cell, JSON.parse(readFileSync(new URL(`../bench/cells/${cell}.json`, import.meta.url), 'utf8')),
)]));
const cases = [
  { topic: 'atlas', key: 'checksum', fact: '47' },
  { topic: 'cedar', key: 'port', fact: '6432' },
  { topic: 'lumen', key: 'schema', fact: 'v9' },
  { topic: 'rivet', key: 'rollback', fact: 'phase3' },
];
const options = { now: 1_790_000_000_000, contextWindow: 128_000,
  reserveOutputTokens: 8_000, fixedOverheadTokens: 1_200, lambdaMs: 0 };
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const message = (id, role, text) => ({ id, role, content: [{ type: 'text', text }],
  source: { kind: role === 'assistant' ? 'model' : role === 'tool' ? 'tool' : 'user' } });
const content = (item) => item.content.map((part) => part.text ?? '').join('');

function transcript(spec) {
  const source = [
    message('task', 'user', `Investigate ${spec.topic} ${spec.key} and retain the exact value.`),
    message('trace', 'assistant', `I will inspect ${spec.topic} ${spec.key}, then verify the value.`),
    message('fact', 'tool', `${spec.topic} ${spec.key} ${spec.fact}`),
  ];
  for (let i = 0; i < 11; i += 1) {
    source.push(message(`noise-${i}`, 'tool', `Unrelated service_${i} uses revision_${i} for module_${i}.`));
  }
  return source;
}

async function runCase(cell, spec, compacted) {
  const policy = policies[cell];
  const graph = new AssociationGraph();
  const sessionId = `cell-eval-${spec.topic}`;
  const source = transcript(spec);
  let seq = 0;
  const started = performance.now();
  for (const item of source) {
    await observeStep({ ...options, sessionId, step: seq + 2, seq, messages: [item], policy,
      graph, assemble: false });
    seq += 1;
  }
  const query = message('query', 'tool', `Continue the task: verify the exact ${spec.topic} ${spec.key} value.`);
  const visible = compacted ? source.slice(-2) : [...source];
  visible.push(query);
  let questions = 0;
  let scoringSkippedByVisibility = false;
  const built = await observeStep({ ...options, sessionId, step: seq + 2, seq, messages: [query], policy,
    graph, scoreOnStepPath: false, beforeAssemble: cell === 'C2' ? async (anchorId) => {
      const visibility = contextVisibility(visible);
      if (graph.orderedSegments().every((seg) => seg.kind === 'systemPinned' || visibility.containsSegment(seg))) {
        scoringSkippedByVisibility = true;
        return;
      }
      await graph.recallDemand([anchorId], { window: policy.recall.window,
        threshold: policy.recall.threshold, depth: policy.recall.depth, lambdaMs: 0, now: options.now },
      async (rows) => rows.map((row) => row.candidates.map((candidate) => {
        questions += 1;
        return lexicalScore(row.current, candidate);
      })));
    } : undefined });
  assert.equal(built.kind, 'assembled');
  const delivered = deliverContext({ enabled: policy.deliver, trigger: 'every-step', step: seq + 2,
    messages: [query], claimed: [query], visibleMessages: visible,
    order: built.layout.order, stateProxy: built.layout.stateProxy,
    recalled: built.layout.recalled, anchor: built.layout.anchor });
  const inserted = delivered.delivered ? delivered.messages.filter((item) => item.source?.form === 's1cap') : [];
  const surface = [...visible, ...inserted];
  const factPresent = surface.some((item) => content(item).includes(`${spec.topic} ${spec.key} ${spec.fact}`));
  const tracePresent = surface.some((item) => content(item).includes('<trace_start>'));
  const injectedTokensEstimate = inserted.reduce((sum, item) => sum + estimateTokens(content(item)), 0);
  const elapsedMs = performance.now() - started;
  assert.equal(policy.tas.on, cell !== 'C0');
  assert.equal(policy.recall.tier1, cell === 'C2' ? 's1' : 'off');
  assert.equal(policy.deliver, cell !== 'C0');
  return { cell, topic: spec.topic, compacted, factPresent, serializedTracePresent: tracePresent,
    selected: built.selectedIds.length, scoringSkippedByVisibility,
    injectedTokensEstimate, questions, elapsedMs, delivered: inserted.length,
    traceBlock: delivered.blocks?.includes('stateProxy') ?? false,
    recallBlock: delivered.blocks?.includes('recalled') ?? false };
}

const rows = [];
const timings = {};
for (const compacted of [false, true]) {
  for (const spec of cases) {
    for (const cell of cells) {
      await runCase(cell, spec, compacted);
      const samples = [];
      for (let i = 0; i < 5; i += 1) samples.push(await runCase(cell, spec, compacted));
      const first = samples[0];
      for (const sample of samples) {
        assert.deepEqual({ ...sample, elapsedMs: 0 }, { ...first, elapsedMs: 0 });
      }
      rows.push({ ...first, elapsedMs: median(samples.map((sample) => sample.elapsedMs)) });
      timings[`${compacted ? 'compacted' : 'full'}/${spec.topic}/${cell}`] = samples.map((sample) => sample.elapsedMs);
    }
  }
}
const summary = Object.fromEntries([false, true].flatMap((compacted) => cells.map((cell) => {
  const subset = rows.filter((row) => row.cell === cell && row.compacted === compacted);
  return [`${compacted ? 'compacted' : 'full'}/${cell}`, {
    factsAvailable: subset.filter((row) => row.factPresent).length,
    cases: subset.length,
    serializedTracePresent: subset.filter((row) => row.serializedTracePresent).length,
    injectedTokensEstimate: subset.reduce((sum, row) => sum + row.injectedTokensEstimate, 0),
    questions: subset.reduce((sum, row) => sum + row.questions, 0),
    visibilitySkips: subset.filter((row) => row.scoringSkippedByVisibility).length,
    medianLocalMs: median(subset.map((row) => row.elapsedMs)),
  }];
})));
for (const cell of cells) assert.equal(summary[`full/${cell}`].factsAvailable, cases.length);
for (const cell of ['C0', 'C1']) assert.equal(summary[`compacted/${cell}`].factsAvailable, 0);
assert.equal(summary['compacted/C2'].factsAvailable, cases.length);
assert.equal(summary['full/C2'].visibilitySkips, cases.length);
assert.equal(summary['compacted/C2'].visibilitySkips, 0);

const report = { schema: 1, date: '2026-10-07', commit, node: process.version,
  scope: 'Offline replay of the current three cell presets; C2 uses the local lexical fallback, not the Jev backend. No model answers, official task rewards, provider tokens, or agent latency measured.',
  fixtures: cases, repetitions: 5, policies: Object.fromEntries(cells.map((cell) => [cell, {
    tas: policies[cell].tas.on, recall: policies[cell].recall.tier1,
    deliver: policies[cell].deliver, window: policies[cell].recall.window,
    threshold: policies[cell].recall.threshold,
  }])), summary, rows, timingSamplesMs: timings };
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
