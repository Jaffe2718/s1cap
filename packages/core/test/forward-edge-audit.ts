/**
 * FORWARD-EDGE AUDIT — the direction of every expansion an RG walk actually took, against a round's own record.
 *
 * The defect this tool measures: the association graph stores each scored pair **once**, oriented older -> newer
 * (`scoreNew` writes `${other.id}->${current.id}` for the new segment `current`), but the walk expanded
 * `neighbors(id)` in **both** directions, so an older segment recalled a newer one. The user's rule is the
 * opposite: an older segment must not recall a newer one; only a new segment recalls older ones. The record of a
 * walk is `recallTree`, and the graph's own notion of "older" is the position of a segment in the snapshot's
 * `order` array - so the two together say, for every expansion a round took, whether it went forward in time.
 *
 * Two numbers come out of it, and they answer different questions:
 *
 *   RECORDED — the trees the round wrote, read against its own `order`. This is what a past run did, and it is
 *              the number the fix is aimed at. It cannot change; the round is on disk unedited.
 *   RE-RUN   — the same anchors, walked again by the `src/` build in this working tree, one step at a time. The
 *              graph is monotone (edges and scores are only ever added), so the sub-snapshot holding only the
 *              first `position(anchor) + 1` segments is the graph as it stood when that assembly ran; `now` is
 *              the assembly's own `ts`. Re-running the old build here reproduces the recorded walks, which is
 *              what makes the re-run's number a measurement of the walk rather than of the reconstruction.
 *
 * What to drive to zero is the RE-RUN forward count. `0` means no expansion of any walk went forward in time.
 * A recorded count above zero is the defect as it happened and stays on the record.
 *
 * Usage, from `s1cap/`:
 *   node --experimental-strip-types packages/core/test/forward-edge-audit.ts
 *   node --experimental-strip-types packages/core/test/forward-edge-audit.ts <round-dir> [cell]
 *
 * Default round: `../.s1cap-ablation/round-20261004-0233`, cell `C2` (the round's full configuration). The audit
 * only reads; it writes nothing, and it never edits a round.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AssociationGraph } from '../src/assoc-graph.ts';
import type { RgSnapshot } from '../src/assoc-graph.ts';
import type { RecallHit } from '../src/assoc-graph.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const roundArg = process.argv[2];
const ROUND = roundArg ?? join(HERE, '..', '..', '..', '..', '.s1cap-ablation', 'round-20261004-0233');
const CELL = process.argv[3] ?? 'C2';

/** The recall parameters the round ran with: `defaultPolicy().recall` + the plugin's decay constant. */
const THRESHOLD = 0.55;
const DEPTH = 2;
const LAMBDA_MS = 36 * 60 * 60 * 1000;

interface TreeEdge {
  parent: string;
  child: string;
}

/** Every parent -> child edge of a `recallTree`, root included (`parent === undefined` at the root). */
function treeEdges(node: unknown, parent?: string): TreeEdge[] {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return [];
  const out: TreeEdge[] = [];
  for (const [id, child] of Object.entries(node as Record<string, unknown>)) {
    if (parent !== undefined) out.push({ parent, child: id });
    out.push(...treeEdges(child, id));
  }
  return out;
}

/** Every id a `recallTree` holds, the root included. */
function treeIds(node: unknown): string[] {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return [];
  const out: string[] = [];
  for (const [id, child] of Object.entries(node as Record<string, unknown>)) {
    out.push(id, ...treeIds(child));
  }
  return out;
}

/**
 * The tree a walk produced, in the shape `recallTreeOf` writes it (`packages/core/src/assembler.ts`): the anchor
 * at the root, every hit under the node its `via` names, leaves `{}`. Mirrored rather than imported - the
 * assembler does not export it, and an audit that reached into the module under test would stop being an audit.
 */
function treeOf(anchorId: string, hits: readonly RecallHit[]): Record<string, unknown> {
  const tree: Record<string, unknown> = {};
  if (hits.length === 0) return tree;
  const root: Record<string, unknown> = {};
  tree[anchorId] = root;
  const placed = new Map<string, Record<string, unknown>>([[anchorId, root]]);
  for (const hit of [...hits].sort((a, b) => a.depth - b.depth)) {
    if (placed.has(hit.id)) continue;
    const parent = placed.get(hit.via) ?? root;
    const node: Record<string, unknown> = {};
    parent[hit.id] = node;
    placed.set(hit.id, node);
  }
  return tree;
}

interface Tally {
  edges: number;
  forward: number;
  unresolved: number;
  /** the widest forward step seen: parent position -> child position */
  worst: { parent: number; child: number } | undefined;
  /** of the edges above, the ones whose child sits *after* the walk's anchor in the append order */
  beyondAnchor: number;
  /** and the forward ones among those: a child that did not exist yet when the walk ran cannot be the defect */
  beyondAnchorForward: number;
}

function newTally(): Tally {
  return { edges: 0, forward: 0, unresolved: 0, worst: undefined, beyondAnchor: 0, beyondAnchorForward: 0 };
}

function classify(
  tally: Tally,
  edges: readonly TreeEdge[],
  pos: ReadonlyMap<string, number>,
  anchorAt?: number,
): void {
  for (const edge of edges) {
    tally.edges += 1;
    const parent = pos.get(edge.parent);
    const child = pos.get(edge.child);
    if (parent === undefined || child === undefined) {
      tally.unresolved += 1;
      continue;
    }
    const beyond = anchorAt !== undefined && child > anchorAt;
    if (beyond) tally.beyondAnchor += 1;
    if (child > parent) {
      tally.forward += 1;
      if (beyond) tally.beyondAnchorForward += 1;
      if (tally.worst === undefined || child - parent > tally.worst.child - tally.worst.parent) {
        tally.worst = { parent, child };
      }
    }
  }
}

function pct(part: number, whole: number): string {
  return whole === 0 ? 'n/a' : `${((100 * part) / whole).toFixed(1)}%`;
}

function report(label: string, tally: Tally, nodes: number, walks: number): void {
  const worst =
    tally.worst === undefined
      ? 'none'
      : `parent idx ${tally.worst.parent} -> child idx ${tally.worst.child} (delta ${tally.worst.child - tally.worst.parent})`;
  console.log(`  ${label}`);
  console.log(`    tree nodes placed                  : ${nodes}`);
  console.log(`    tree edges examined                : ${tally.edges}`);
  console.log(`    FORWARD edges (child newer)        : ${tally.forward}  (${pct(tally.forward, tally.edges)})`);
  console.log(`    unresolved ids                     : ${tally.unresolved}`);
  console.log(`    largest forward jump               : ${worst}`);
  console.log(`    edges into a child after the anchor: ${tally.beyondAnchor}  (forward: ${tally.beyondAnchorForward})`);
  console.log(`    walks                              : ${walks}`);
}

// --------------------------------------------------------------------------------------- the round's artifacts
const controlPath = join(ROUND, 'evidence', CELL, 'control.jsonl');
const rgDir = join(ROUND, 'home', CELL, '.s1cap', 'rg');

let controlText: string;
let rgFiles: string[];
try {
  controlText = readFileSync(controlPath, 'utf8');
  rgFiles = readdirSync(rgDir).filter((name) => name.startsWith('rg-') && name.endsWith('.json'));
} catch (error) {
  console.log(`forward-edge-audit: SKIPPED - cannot read the round at ${ROUND}`);
  console.log(`  ${error instanceof Error ? error.message : String(error)}`);
  console.log('  pass a round directory: node --experimental-strip-types packages/core/test/forward-edge-audit.ts <round-dir> [cell]');
  process.exit(0);
}
if (rgFiles.length === 0) {
  console.log(`forward-edge-audit: SKIPPED - no rg-*.json under ${rgDir}`);
  process.exit(0);
}

const snapshot = JSON.parse(readFileSync(join(rgDir, rgFiles[0] as string), 'utf8')) as RgSnapshot;
const order = snapshot.order ?? [];
const pos = new Map<string, number>();
for (const [index, id] of order.entries()) if (!pos.has(id)) pos.set(id, index);

interface AssemblyRecord {
  ts: number;
  seq: number;
  candidates?: number;
  recallTree?: Record<string, unknown>;
}

const records: AssemblyRecord[] = [];
for (const line of controlText.split(/\r?\n/)) {
  if (line.trim() === '') continue;
  const record = JSON.parse(line) as AssemblyRecord & { type?: string };
  if (record.type === 'assembly') records.push(record);
}

const withTree = records.filter((r) => r.recallTree !== undefined);
const walked = withTree.filter((r) => Object.keys(r.recallTree ?? {}).length > 0);

console.log('forward-edge-audit - RG traversal direction, against a recorded round');
console.log(`  round                              : ${ROUND}`);
console.log(`  cell                               : ${CELL}`);
console.log(`  rg snapshot                        : ${rgFiles[0] as string}`);
console.log(`  order length                       : ${order.length}`);
console.log(`  edges / scored pairs in snapshot   : ${(snapshot.edges ?? []).length} / ${(snapshot.scores ?? []).length}`);
console.log(`  assemblies recorded                : ${records.length}`);
console.log(`  ... with a recallTree field        : ${withTree.length}`);
console.log(`  ... with a non-empty tree          : ${walked.length}`);
console.log(
  `  recall parameters                  : r=${THRESHOLD} d=${DEPTH} lambda=${LAMBDA_MS}ms ` +
    '(no per-node cap: recall.fanout is retired - LEGACY_POLICY_KEYS, packages/core/src/config.ts)',
);
console.log('');

// ------------------------------------------------------------------ 1. the recorded walks, as the round wrote them
const recorded = newTally();
let recordedNodes = 0;
for (const record of walked) {
  const anchor = Object.keys(record.recallTree ?? {})[0];
  const anchorAt = anchor === undefined ? undefined : pos.get(anchor);
  classify(recorded, treeEdges(record.recallTree), pos, anchorAt);
  recordedNodes += treeIds(record.recallTree).length;
}
report('RECORDED (the round as it ran - unedited)', recorded, recordedNodes, walked.length);
console.log(
  '    ... "after the anchor" is the part a reconstruction cannot hold: those segments did not exist yet when\n' +
    '    the walk ran, and only a forward step could reach them.',
);
console.log('');

// ------------------------------------- 2. the same anchors, walked again by the src/ build in this working tree
//
// `scores` is dropped and no scorer is configured: the walk reads edges only, and an audit must not re-price the
// round. Everything else is the graph as it stood at that assembly - see the header.
const rerun = newTally();
let rerunNodes = 0;
let rerunLost = 0;
let rerunSeenRecorded = 0;
let rerunWalks = 0;
let unplaceable = 0;
/** `candidates` on the assembly record is `hits.length` in the assembler - the reconstruction's own check. */
let rerunCandidates = 0;
let recordedCandidates = 0;
for (const record of walked) {
  const anchor = Object.keys(record.recallTree ?? {})[0];
  if (anchor === undefined) continue;
  const at = pos.get(anchor);
  if (at === undefined) {
    unplaceable += 1;
    continue;
  }
  const prefix = order.slice(0, at + 1);
  const inPrefix = new Set(prefix);
  const graph = AssociationGraph.fromSnapshot({
    schema: snapshot.schema,
    sessionId: snapshot.sessionId,
    order: prefix,
    segments: (snapshot.segments ?? []).filter((s) => inPrefix.has(s.id)),
    edges: (snapshot.edges ?? []).filter((e) => inPrefix.has(e.from) && inPrefix.has(e.to)),
    scored: 0,
    scoredPairs: 0,
    judgedPairs: 0,
  });
  const hits = graph.recall([anchor], {
    threshold: THRESHOLD,
    depth: DEPTH,
    lambdaMs: LAMBDA_MS,
    now: record.ts,
  });
  const tree = treeOf(anchor, hits);
  classify(rerun, treeEdges(tree), pos, at);
  rerunWalks += 1;
  rerunNodes += hits.length;
  rerunCandidates += hits.length;
  recordedCandidates += record.candidates ?? 0;
  const recordedIds = new Set(treeIds(record.recallTree));
  for (const hit of hits) if (recordedIds.has(hit.id)) rerunSeenRecorded += 1;
  const rerunIds = new Set(hits.map((h) => h.id));
  for (const id of recordedIds) if (id !== anchor && !rerunIds.has(id)) rerunLost += 1;
}
report('RE-RUN (the same anchors, walked by this working tree)', rerun, rerunNodes, rerunWalks);
console.log(`    recorded nodes no longer reached   : ${rerunLost}`);
console.log(`    re-run hits the record also reached: ${rerunSeenRecorded} of ${rerunNodes}`);
console.log(`    candidates: record vs re-run       : ${recordedCandidates} vs ${rerunCandidates}`);
if (unplaceable > 0) console.log(`    anchors with no position in order  : ${unplaceable}`);
console.log('');
if (rerun.forward === 0) {
  console.log(
    'VERDICT: PASS - the re-run took 0 forward edges; no expansion of any walk went forward in time',
  );
} else {
  console.log(`VERDICT: FAIL - the re-run took ${rerun.forward} forward edge(s) of ${rerun.edges}`);
  // A failing verdict is a failing command, so the next round can gate on it rather than on reading the output.
  process.exitCode = 1;
}
