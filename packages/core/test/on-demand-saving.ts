/**
 * ON-DEMAND SAVING — what a demand-driven walk costs against what eager scoring costs, on a round's own frozen
 * graph.
 *
 * Read-only analysis, in the shape `forward-edge-audit.ts` established: it opens a round's artifacts, computes,
 * prints, and writes nothing. Rounds are never edited.
 *
 * The two costs, and the arithmetic each one is:
 *
 *   EAGER   `sum_{i=1}^{N-1} min(i, w)` — every segment's row is bought as the segment arrives, oldest first.
 *           This number contains no `d`.
 *   LAZY    `sum min(index, w)` over the rows a backwards-only walk actually reached, at depth `d` and threshold
 *           `tau`. A node whose row leaves it with no neighbour above `tau` is never expanded, so the rows behind
 *           it are never bought — that is the whole saving, and it is why this number *does* move with `d`.
 *
 * And the order half, which is separate from the volume: eager scoring walks the append order from its oldest
 * entry, while a step's walk is rooted on the newest input event and expands backwards. So the pairs an eager
 * sweep must buy *before* it can serve one step's anchor is a sum over everything in front of that anchor, while
 * the walk's first row is the anchor's own. Both halves are printed; a session whose segments-per-step is low
 * still gets the order half.
 *
 * Usage, from `s1cap/`:
 *   node --experimental-strip-types packages/core/test/on-demand-saving.ts
 *   node --experimental-strip-types packages/core/test/on-demand-saving.ts <round-dir> [cell] [w] [tau] [depth]
 *
 * Defaults: `../.s1cap-ablation/round-20261004-1458`, cell `C2`, `w` inferred from the snapshot when it can be
 * (see `inferWindow`), `tau = 0.55` (the value this build runs), `d = 16`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AssociationGraph, decayedWeight } from '../src/assoc-graph.ts';
import type { RgSnapshot } from '../src/assoc-graph.ts';
import type { Segment } from '../src/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const ROUND = args[0] ?? join(HERE, '..', '..', '..', '..', '.s1cap-ablation', 'round-20261004-1458');
const CELL = args[1] ?? 'C2';
const W_ARG = args[2] === undefined ? undefined : Number(args[2]);
const TAU_ARG = args[3] === undefined ? undefined : Number(args[3]);
const DEPTH_ARG = args[4] === undefined ? undefined : Number(args[4]);

/** The plugin's decay constant (`DECAY_LAMBDA_MS`, `packages/dsh-plugin/src/index.ts`). */
const LAMBDA_MS = 36 * 60 * 60 * 1000;

/** `sum_{i=1}^{N-1} min(i, w)`: what the arrival order offers, and what eager scoring pays. */
function eagerPairs(n: number, w: number): number {
  let total = 0;
  for (let i = 1; i < n; i += 1) total += Math.min(i, w);
  return total;
}

/** The pairs bought before row `index`: `sum_{j=1}^{index-1} min(j, w)`. */
function pairsBefore(index: number, w: number): number {
  let total = 0;
  for (let j = 1; j < index; j += 1) total += Math.min(j, w);
  return total;
}

function findSnapshot(round: string, cell: string): string {
  const rgDir = join(round, 'home', cell, '.s1cap', 'rg');
  const files = readdirSync(rgDir).filter((f) => f.endsWith('.json'));
  if (files.length === 0) throw new Error(`no RG snapshot under ${rgDir}`);
  return join(rgDir, files[0] as string);
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const at = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[at] as number;
}

const snapshotPath = findSnapshot(ROUND, CELL);
const snap = JSON.parse(readFileSync(snapshotPath, 'utf8')) as RgSnapshot;
const graph = AssociationGraph.fromSnapshot(snap);
const order = snap.order;
const index = new Map<string, number>();
for (const [i, id] of order.entries()) if (!index.has(id)) index.set(id, i);
const N = order.length;

/**
 * `w` is not in the snapshot, so it is inferred when the graph is complete: the run's own `scoredPairs` equals
 * `sum min(i, w)` exactly for the `w` it ran. When it does not (a session whose scoring never caught up), the
 * inference fails loudly and the caller passes `w`.
 */
function inferWindow(): { w: number; exact: boolean } {
  if (W_ARG !== undefined && Number.isFinite(W_ARG)) return { w: W_ARG, exact: true };
  for (const candidate of [4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048]) {
    if (eagerPairs(N, candidate) === snap.scoredPairs) return { w: candidate, exact: true };
  }
  return { w: 16, exact: false };
}

const inferred = inferWindow();
const W = inferred.w;
const TAU = TAU_ARG ?? 0.55;
const DEPTH = DEPTH_ARG ?? 16;

interface Row { id: string; index: number; depth: number }

/** The rows one anchor's walk demands, level by level, on the graph as it stands. */
function demandRows(anchorId: string, tau: number, depth: number, now: number): { rows: Row[]; levels: number[]; hits: number } {
  const rows: Row[] = [];
  const levels: number[] = [];
  const seen = new Set<string>([anchorId]);
  const best = new Set<string>();
  let frontier: { id: string; depth: number }[] = [{ id: anchorId, depth: 0 }];
  while (frontier.length > 0) {
    const level = frontier.filter((node) => node.depth < depth && (index.get(node.id) ?? 0) > 0);
    if (level.length === 0) break;
    levels.push(level.length);
    for (const node of level) {
      const at = index.get(node.id);
      if (at !== undefined) rows.push({ id: node.id, index: at, depth: node.depth });
    }
    const next: { id: string; depth: number }[] = [];
    for (const node of frontier) {
      if (node.depth >= depth) continue;
      const from = index.get(node.id);
      const ranked = graph
        .neighbors(node.id)
        .map((e) => {
          const other = e.from === node.id ? e.to : e.from;
          return { other, w: decayedWeight(e.w, now - e.verifiedAt, LAMBDA_MS) };
        })
        .filter((n) => n.w > tau && from !== undefined && (index.get(n.other) ?? -1) < from)
        .sort((a, b) => b.w - a.w);
      for (const n of ranked) {
        if (seen.has(n.other)) continue;
        seen.add(n.other);
        best.add(n.other);
        next.push({ id: n.other, depth: node.depth + 1 });
      }
    }
    frontier = next;
  }
  return { rows, levels, hits: best.size };
}

// --- the round's own anchors, from its control plane (`recallTree` roots) --------------------------------
const controlPath = join(ROUND, 'evidence', CELL, 'control.jsonl');
const control = readFileSync(controlPath, 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line) as Record<string, unknown>);
const assemblies = control.filter((r) => r['type'] === 'assembly');
const anchorIds: string[] = [];
for (const record of assemblies) {
  const tree = record['recallTree'];
  if (typeof tree !== 'object' || tree === null) continue;
  const root = Object.keys(tree as Record<string, unknown>)[0];
  if (root !== undefined && !anchorIds.includes(root)) anchorIds.push(root);
}
const anchorIndices = anchorIds.map((id) => index.get(id) ?? -1).filter((i) => i >= 0).sort((a, b) => a - b);
const callMs = control
  .filter((r) => r['type'] === 's1_call' && typeof r['ms'] === 'number' && r['ok'] === true)
  .map((r) => r['ms'] as number)
  .sort((a, b) => a - b);
const questions = control.filter((r) => r['type'] === 's1_call').map((r) => Number(r['questions'] ?? 0));
const questionsPerCall = questions.length === 0 ? 0 : Math.max(...questions);
const steps = assemblies.length;

console.log('================================================================================');
console.log('ON-DEMAND SAVING — measured on a frozen round (read-only)');
console.log('================================================================================');
console.log(`round            ${ROUND}`);
console.log(`cell             ${CELL}`);
console.log(`snapshot         ${snapshotPath}`);
console.log(`segments N       ${N}`);
console.log(`distinct pairs   ${graph.scoreCount}   (scores map; graded, above and below tau)`);
console.log(`edges            ${graph.edgeCount}`);
console.log(`cursor `+ '`scored`'.padEnd(8) + ` ${snap.scored} / ${N}`);
console.log(`snapshot totals  scoredPairs ${snap.scoredPairs}, judgedPairs ${snap.judgedPairs}, deferredPairs ${snap.deferredPairs}`);
console.log(`window w         ${W}${inferred.exact ? ' (inferred: sum min(i, w) equals the snapshot\'s scoredPairs)' : ' (ASSUMED: the snapshot\'s scoredPairs does not equal sum min(i, w) for any candidate - pass w explicitly)'}`);
console.log(`tau / depth      ${TAU} / ${DEPTH}`);
console.log(`assemblies       ${steps}`);
console.log(`anchors          ${anchorIds.length} distinct, indices [${anchorIndices.join(', ')}]`);
console.log(`segments/step    ${(N / Math.max(1, steps)).toFixed(1)}  (N / assemblies; the governor of the lazy saving)`);
console.log(`call latency     ${callMs.length} answered calls, one row each: min ${callMs[0]}, p50 ${quantile(callMs, 0.5)}, p90 ${quantile(callMs, 0.9)}, max ${callMs[callMs.length - 1]} ms`);
console.log(`questions/call   max ${questionsPerCall}; a full row at w = ${W} is ${W} questions = ${Math.max(1, Math.ceil(W / Math.max(1, questionsPerCall)))} call(s)`);

// --- the two costs -----------------------------------------------------------------------------------------
const eager = eagerPairs(N, W);
console.log('\n--- EAGER (the arrival order) ' + '-'.repeat(48));
console.log(`rows  N-1 = ${N - 1}`);
console.log(`pairs sum_{i=1}^{N-1} min(i, w) = ${eager}   [arithmetic from N and w; contains no d]`);

// The union over every segment as an anchor: the degenerate case, and it is not an unlikely one.
const allRows = new Map<string, Row>();
for (const id of order) {
  const at = index.get(id) ?? -1;
  if (at <= 0) continue;
  const sim = demandRows(id, TAU, DEPTH, Number(snap.segments.find((s) => s.id === id)?.ts ?? 0));
  for (const row of sim.rows) allRows.set(row.id, row);
}
const allPairs = [...allRows.values()].reduce((sum, row) => sum + Math.min(row.index, W), 0);
console.log('\n--- LAZY, upper bound (every segment used as an anchor) ' + '-'.repeat(28));
console.log(`rows  ${allRows.size}   pairs ${allPairs}`);
console.log(`saving rows ${(100 * (1 - allRows.size / (N - 1))).toFixed(1)}%   pairs ${(100 * (1 - allPairs / eager)).toFixed(1)}%`);
console.log('(the union over every anchor demands every row, so this is the eager cost: the degenerate case)');

// The round's own anchors.
const now = Math.max(...snap.segments.map((s: Segment) => s.ts));
const usedRows = new Map<string, Row>();
const perAnchor: { id: string; index: number; rows: number; pairs: number; levels: number; hits: number }[] = [];
for (const id of anchorIds) {
  const at = index.get(id) ?? -1;
  if (at < 0) continue;
  const sim = demandRows(id, TAU, DEPTH, now);
  for (const row of sim.rows) usedRows.set(row.id, row);
  perAnchor.push({
    id,
    index: at,
    rows: sim.rows.length,
    pairs: sim.rows.reduce((sum, row) => sum + Math.min(row.index, W), 0),
    levels: sim.levels.length,
    hits: sim.hits,
  });
}
const usedPairs = [...usedRows.values()].reduce((sum, row) => sum + Math.min(row.index, W), 0);
console.log(`\n--- LAZY, the round's own ${anchorIds.length} anchors ` + '-'.repeat(40));
console.log(`rows  ${usedRows.size}   pairs ${usedPairs}`);
console.log(`saving rows ${(100 * (1 - usedRows.size / (N - 1))).toFixed(1)}%   pairs ${(100 * (1 - usedPairs / eager)).toFixed(1)}%`);
if (snap.scored < N) {
  console.log('');
  console.log(`** UNMEASURABLE ON THIS ROUND, AND THE NUMBER ABOVE IS NOT A SAVING. **`);
  console.log(`Its graph holds ${graph.scoreCount} graded pairs and its cursor is at ${snap.scored} of ${N}: a walk from an`);
  console.log(`anchor above ${snap.scored} has no edges at all (nothing above that index was ever scored), and a walk`);
  console.log(`below it is measured on a graph the round never finished. The sparsity the number above reads is the`);
  console.log(`round's *failure*, not the threshold: the lazy cost on this round cannot be recovered from its`);
  console.log(`artifacts, and a re-run at w = ${W} is what would measure it. What IS exact here is the EAGER cost`);
  console.log(`(${eager} pairs = sum min(i, ${W}) over ${N - 1} rows) and the upper bound, which are arithmetic from N and w.`);
}
console.log('per anchor: index, rows, pairs, levels, reached');
for (const a of perAnchor) {
  console.log(`  ${String(a.index).padStart(4)}  rows ${String(a.rows).padStart(3)}  pairs ${String(a.pairs).padStart(4)}  levels ${String(a.levels).padStart(2)}  reached ${a.hits}`);
}

// --- the order half ----------------------------------------------------------------------------------------
const before = perAnchor.map((a) => pairsBefore(a.index, W));
const firstRow = perAnchor.map((a) => Math.min(a.index, W));
const sortedBefore = [...before].sort((x, y) => x - y);
const sortedFirst = [...firstRow].sort((x, y) => x - y);
console.log('\n--- ORDER (what an eager sweep spends before it reaches the anchor) ' + '-'.repeat(14));
console.log(`pairs before the anchor's row, per step: p50 ${quantile(sortedBefore, 0.5)}, p90 ${quantile(sortedBefore, 0.9)}, max ${sortedBefore[sortedBefore.length - 1] ?? 0}, total ${before.reduce((a, b) => a + b, 0)}`);
console.log(`the walk's first row (the anchor's own): p50 ${quantile(sortedFirst, 0.5)}, p90 ${quantile(sortedFirst, 0.9)}, max ${sortedFirst[sortedFirst.length - 1] ?? 0}`);
console.log('per step: index, eager pairs before the anchor, the walk\'s first row');
for (let i = 0; i < perAnchor.length; i += 1) {
  console.log(`  ${String(perAnchor[i]?.index).padStart(4)}  eager-before ${String(before[i]).padStart(5)}  walk-first ${String(firstRow[i]).padStart(3)}`);
}

// --- what d costs ------------------------------------------------------------------------------------------
console.log('\n--- d IS BILLED (the round\'s anchors, rows and pairs per depth) ' + '-'.repeat(14));
for (const tau of [TAU, 0.6]) {
  console.log(`  at tau = ${tau.toFixed(2)}:`);
  for (const depth of [1, 2, 4, 8, 16]) {
    const rowsAt = new Map<string, Row>();
    for (const id of anchorIds) {
      const at = index.get(id) ?? -1;
      if (at < 0) continue;
      for (const row of demandRows(id, tau, depth, now).rows) rowsAt.set(row.id, row);
    }
    const pairsAt = [...rowsAt.values()].reduce((sum, row) => sum + Math.min(row.index, W), 0);
    console.log(`    d=${String(depth).padStart(2)}  rows ${String(rowsAt.size).padStart(3)}  pairs ${String(pairsAt).padStart(4)}   (eager pays ${eager} at every d)`);
  }
}

// --- what tau costs ----------------------------------------------------------------------------------------
console.log('\n--- tau SWEEP (the round\'s anchors) ' + '-'.repeat(45));
for (const tau of [0.55, 0.6, 0.7, 0.8]) {
  const rowsAt = new Map<string, Row>();
  let spread = 0;
  for (const id of anchorIds) {
    const at = index.get(id) ?? -1;
    if (at < 0) continue;
    const sim = demandRows(id, tau, DEPTH, now);
    spread += sim.hits;
    for (const row of sim.rows) rowsAt.set(row.id, row);
  }
  const pairsAt = [...rowsAt.values()].reduce((sum, row) => sum + Math.min(row.index, W), 0);
  console.log(`  tau=${tau.toFixed(2)}  rows ${String(rowsAt.size).padStart(3)}  pairs ${String(pairsAt).padStart(4)}  saving ${(100 * (1 - pairsAt / eager)).toFixed(1)}%  mean reach ${(spread / Math.max(1, anchorIds.length)).toFixed(1)}`);
}
console.log('(the sweep is exact at any tau >= the graph\'s: the frozen graph holds every pair the walk could');
console.log(' ask about at this window, so a stricter tau prunes traversal and changes no answer)');

// --- the walk's latency ------------------------------------------------------------------------------------
// One call per row (a row is `min(index, w)` questions, at most `questionsPerCall` of them), and a walk's levels
// are sequential. **A row is bought once**: a row an earlier step's walk already scored is not re-asked
// (`#rowMissing`), so the lane's cost across a session is the *union* of the walks' rows, not their sum - which is
// why the number below is the union and the per-step column is what each step adds to it.
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
const seenSoFar = new Set<string>();
const newRowsPerStep: number[] = [];
for (const a of perAnchor) {
  let added = 0;
  for (const row of demandRows(a.id, TAU, DEPTH, now).rows) {
    if (seenSoFar.has(row.id)) continue;
    seenSoFar.add(row.id);
    added += 1;
  }
  newRowsPerStep.push(added);
}
const random = rng(20261005);
const totals: number[] = [];
for (let draw = 0; draw < 2000; draw += 1) {
  let total = 0;
  for (let r = 0; r < usedRows.size; r += 1) total += callMs[Math.floor(random() * callMs.length)] as number;
  totals.push(total);
}
totals.sort((a, b) => a - b);
console.log('\n--- LATENCY (the round\'s own answered-call latencies, sampled with a fixed seed) ' + '-'.repeat(4));
console.log(`a step waits for the anchor's own row = 1 call: p50 ${quantile(callMs, 0.5)} ms, p90 ${quantile(callMs, 0.9)} ms, max ${callMs[callMs.length - 1]} ms`);
console.log(`  (plus the 50 ms poll granularity - and only while it polls at all: the row is the walk's first level)`);
console.log(`the whole session's lane, every walk's rows bought once: ${usedRows.size} calls -> p50 ${quantile(totals, 0.5)} ms, p90 ${quantile(totals, 0.9)} ms`);
console.log(`  the round's own lane spent ${callMs.length} calls / ${callMs.reduce((a, b) => a + b, 0)} ms on the eager ${eager} pairs`);
const sortedNew = [...newRowsPerStep].sort((a, b) => a - b);
console.log(`new rows per step: p50 ${quantile(sortedNew, 0.5)}, p90 ${quantile(sortedNew, 0.9)}, max ${sortedNew[sortedNew.length - 1] ?? 0}`);
console.log(`  (spread over the session: a step whose walk reaches only rows an earlier step already bought costs`);
console.log(`   one local check per row and no call at all)`);
console.log('per step: index, rows the walk demanded, of them newly bought');
for (let i = 0; i < perAnchor.length; i += 1) {
  console.log(`  ${String(perAnchor[i]?.index).padStart(4)}  demanded ${String(perAnchor[i]?.rows).padStart(3)}  new ${String(newRowsPerStep[i]).padStart(3)}`);
}
