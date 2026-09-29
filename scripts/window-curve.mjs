/**
 * The recall-window cost curve: what `recall.window = w` actually saves.
 *
 * Full-history scoring costs Theta(T^2/2) pair comparisons over a session of T segments; the window costs
 * Theta(T*w - w(w-1)/2), and - the number that matters - its per-segment cost is bounded by w no matter how long
 * the session grows. This script runs the real AssociationGraph from packages/core over a synthetic session so the
 * table and the figure are reproducible rather than asserted, and writes docs/figures/window-cost.svg.
 *
 * Usage: node scripts/window-curve.mjs [T]
 */
import { writeFileSync } from 'node:fs';

import { AssociationGraph } from '../packages/core/lib/assoc-graph.js';

const T = Number(process.argv[2] ?? 4096);
const WINDOWS = [64, 256, 1024, 4096];

function segment(i) {
  return {
    id: 's' + String(i),
    sessionId: 'curve',
    seq: i,
    kind: 'user',
    tokens: 8,
    text: 'alpha beta gamma delta epsilon zeta ' + String(i % 97),
    ts: 1000 + i,
  };
}

const segments = Array.from({ length: T }, (_, i) => segment(i));
const rows = [];
let full = 0;

for (const w of WINDOWS) {
  const graph = new AssociationGraph();
  const cumulative = [];
  let perStepMax = 0;
  for (let i = 0; i < T; i += 1) {
    graph.addSegments([segments[i]]);
    const step = graph.scoreNew({ windowN: w, threshold: 0 });
    perStepMax = Math.max(perStepMax, step.scoredPairs);
    cumulative.push(graph.stats().scoredPairs);
  }
  const scored = graph.stats().scoredPairs;
  if (full === 0) full = (T * (T - 1)) / 2;
  rows.push({ w, scored, perStepMax, saved: full - scored, ratio: scored / full, cumulative });
}

const markdown = [
  '| w | pairs scored | max pairs in one step | pairs saved vs full history | share of full |',
  '| --- | --- | --- | --- | --- |',
  ...rows.map(
    (r) =>
      '| ' +
      String(r.w) +
      ' | ' +
      r.scored.toLocaleString('en-US') +
      ' | ' +
      String(r.perStepMax) +
      ' | ' +
      r.saved.toLocaleString('en-US') +
      ' | ' +
      (r.ratio * 100).toFixed(1) +
      '% |',
  ),
].join('\n');

console.log('segments T = ' + String(T) + ', full-history scoring = ' + full.toLocaleString('en-US') + ' pairs');
console.log(markdown);
console.log(
  'per-segment cost is bounded by w: the max pairs scored in a single step equals w for every w whose window fills ('
    + rows.map((r) => String(r.w) + '->' + String(r.perStepMax)).join(', ')
    + ')',
);

// --- the figure: cumulative pairs against session length, one line per w, plus the full-history baseline ---
const W = 720;
const H = 420;
const PAD = 56;
const maxY = full;
const x = (i) => PAD + (i / (T - 1)) * (W - PAD * 1.5);
const y = (v) => H - PAD - (v / maxY) * (H - PAD * 1.6);
const colors = ['#2f6fd0', '#2f9e6b', '#d08a2f', '#b0483f'];
const series = rows
  .map((r, k) => {
    const points = r.cumulative
      .filter((_, i) => i % Math.max(1, Math.floor(T / 160)) === 0)
      .map((v, i) => x(i * Math.max(1, Math.floor(T / 160))) + ',' + y(v))
      .join(' ');
    return (
      '<polyline fill="none" stroke="' + colors[k] + '" stroke-width="2" points="' + points + '"/>' +
      '<text x="' + String(W - PAD * 1.35) + '" y="' + String(y(r.cumulative[r.cumulative.length - 1]) + 4) +
      '" font-size="12" fill="' + colors[k] + '">w=' + String(r.w) + '</text>'
    );
  })
  .join('');
const baseline =
  '<polyline fill="none" stroke="#888" stroke-dasharray="6 4" stroke-width="2" points="' +
  Array.from({ length: 161 }, (_, i) => {
    const t = (i / 160) * (T - 1);
    return x(t) + ',' + y((t * (t - 1)) / 2);
  }).join(' ') +
  '"/><text x="' + String(W - PAD * 1.9) + '" y="' + String(PAD * 0.5) + '" font-size="12" fill="#666">full history</text>';

const svg = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" role="img">',
  '<rect width="' + W + '" height="' + H + '" fill="#ffffff"/>',
  '<text x="' + PAD + '" y="26" font-size="15" font-family="sans-serif" fill="#111">S1 pair comparisons against session length</text>',
  '<line x1="' + PAD + '" y1="' + (H - PAD) + '" x2="' + (W - 20) + '" y2="' + (H - PAD) + '" stroke="#333"/>',
  '<line x1="' + PAD + '" y1="' + PAD + '" x2="' + PAD + '" y2="' + (H - PAD) + '" stroke="#333"/>',
  '<text x="' + PAD + '" y="' + (H - PAD + 22) + '" font-size="12" fill="#333">0</text>',
  '<text x="' + (W - 90) + '" y="' + (H - PAD + 22) + '" font-size="12" fill="#333">T=' + String(T) + ' segments</text>',
  '<text x="8" y="' + (PAD + 6) + '" font-size="12" fill="#333">' + full.toLocaleString('en-US') + '</text>',
  baseline,
  series,
  '</svg>',
].join('\n');
writeFileSync('docs/figures/window-cost.svg', svg + '\n', 'utf8');
console.log('figure written: docs/figures/window-cost.svg');