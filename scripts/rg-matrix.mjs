/**
 * RG MATRIX — the association graph as a **numeric** matrix: every cell that has a recorded relevance prints it as a
 * percentage, and every cell that has none is left blank.
 *
 * Why a number and not a shade. The first version of this figure encoded each pair as a colour, which answered "is
 * there an edge" and refused to answer "what did the lane actually say" — and the value is the thing the threshold is
 * compared against, so a reader had to go back to the snapshot to see it. Here the cell carries the recorded weight
 * (`round(w * 100)`), and the only colours left are the four *states* a cell can be in:
 *
 *   - **blank**            the pair was never offered: the two segments are in the wrong order for a backward walk,
 *                          further apart than `recall.window`, or the later one did not exist yet.
 *   - **pale, no number**  offered, and **no score was recorded** — the lane was asked and never answered. This is
 *                          "the backend did not keep up", and it is deliberately *not* drawn as a number: a missing
 *                          value and a value of zero are different facts, and this project has paid for confusing
 *                          them before.
 *   - **number, grey**     scored and **below `r`**: the threshold rejects it, so the walk may not follow it.
 *   - **number, navy**     scored at or above `r`: an **edge of the graph**, bold.
 *
 * `scores` is the authority for "a value exists", not `edges`: an edge is a score that passed the threshold, so
 * reading edges alone cannot tell "rejected" from "never asked". On `round-20261004-1618`: 1 848 pairs offered by the
 * window, **766 settled (41.5 %)**, 1 082 offered and never answered, 681 rejected below `r = 0.6`, 85 edges.
 *
 * Usage: node scripts/rg-matrix.mjs --run <dir> --cell C2 [--tail N] [--cell-px 20] [--out <file.svg>]
 *   --tail N     draw only the last N segments (append order), which is how a reader gets numbers big enough to read
 *                on a 124-segment session. The header always states the full run's counts.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

function parseArgs(argv) {
  const out = { run: null, cell: null, out: null, tail: null, cellPx: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--run') out.run = argv[++i];
    else if (arg === '--cell') out.cell = argv[++i];
    else if (arg === '--out') out.out = argv[++i];
    else if (arg === '--tail') out.tail = Number(argv[++i]);
    else if (arg === '--cell-px') out.cellPx = Number(argv[++i]);
  }
  if (out.run === null || out.cell === null) {
    console.error('usage: node scripts/rg-matrix.mjs --run <dir> --cell C2 [--tail N] [--cell-px 20] [--out <file.svg>]');
    process.exit(2);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const runDir = args.run;
const cell = args.cell;
const fail = (message) => {
  console.error(`rg-matrix: ${message}`);
  process.exit(1);
};

/** The largest RG snapshot in the cell's home. A session can leave more than one; the last is the largest. */
function loadGraph() {
  const dir = join(runDir, 'home', cell, '.s1cap', 'rg');
  if (!existsSync(dir)) fail(`no RG snapshot directory at ${dir} — the cell never persisted a graph`);
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  if (files.length === 0) fail(`no RG snapshot in ${dir}`);
  const biggest = files.map((f) => ({ f, size: readFileSync(join(dir, f)).length })).sort((a, b) => b.size - a.size)[0];
  const path = join(dir, biggest.f);
  return { path, graph: JSON.parse(readFileSync(path, 'utf8')), snapshots: files.length };
}

/** `recall.r` / `recall.w` / `recall.d` from the tape's wiring record — the values the run used. */
function loadKnobs() {
  const tape = join(runDir, 'home', cell, '.s1cap', 'tape.jsonl');
  if (!existsSync(tape)) fail(`no tape at ${tape}`);
  const wiring = readFileSync(tape, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((rec) => rec && rec.kind === 'wiring');
  if (wiring.length === 0) fail('the tape holds no kind:"wiring" record, so r and w cannot be read');
  const recall = wiring[wiring.length - 1].recall;
  if (recall === null || typeof recall !== 'object') fail('the wiring record carries no recall block');
  return { r: recall.r, w: recall.w, d: recall.d };
}

const { path: graphPath, graph, snapshots } = loadGraph();
const knobs = loadKnobs();
const order = graph.order ?? [];
if (order.length === 0) fail('the snapshot carries no `order` array');
const segments = new Map((graph.segments ?? []).map((s) => [s.id, s]));
const r = knobs.r;
const w = knobs.w;
const N = order.length;

// Which pairs the window offers: segment i against the `w` before it (`FORMULAS.md`: `sum_i min(i, w)`).
const offered = new Set();
for (let i = 0; i < N; i += 1) {
  for (let j = Math.max(0, i - w); j < i; j += 1) offered.add(`${order[j]}|${order[i]}`);
}

const settled = new Map();
for (const s of graph.scores ?? []) settled.set(`${s.from}|${s.to}`, s.w);

// Counted over the whole run, never over the drawn window: the header must not change when `--tail` does.
let offeredCount = 0;
let unsettledCount = 0;
let rejectedCount = 0;
let edgeCount = 0;
for (const key of offered) {
  offeredCount += 1;
  const value = settled.get(key);
  if (value === undefined) unsettledCount += 1;
  else if (value >= r) edgeCount += 1;
  else rejectedCount += 1;
}
const settledShare = offeredCount === 0 ? 0 : (100 * (rejectedCount + edgeCount)) / offeredCount;

/**
 * **What a missing score means, which is not one thing.** Until 2026-10-05 scoring was eager: every offered pair was
 * asked for, so a pair with no score was a pair the lane had not answered yet, and "settled / offered" was the
 * coverage floor. Scoring is now on demand — the walk asks for the rows it needs — so a pair with no score is
 * normally a pair **nobody asked about**, which is the design rather than a failure.
 *
 * The snapshot settles which reading applies, and the figure must not guess: `demandMissedPairs` counts the pairs
 * that were demanded and never answered. On `round-20261004-1618` it is **0** against `demandPairs: 766` — so all
 * 1 082 unscored cells in this round were never demanded, and "the backend did not keep up" would have been a false
 * sentence about a lane that answered every single question it was asked. The first version of this figure printed
 * exactly that sentence in its legend.
 */
const demanded = typeof graph.demandPairs === 'number' ? graph.demandPairs : null;
const missed = typeof graph.demandMissedPairs === 'number' ? graph.demandMissedPairs : null;
const unscoredMeaning =
  missed === 0
    ? `no score recorded — and this round's \`demandMissedPairs\` is 0, so every one of these was **never demanded** ` +
      `(the walk did not ask), not left unanswered. Scoring is on demand: unsettled/offered measures what the walk ` +
      `asked for, not what the lane managed`
    : missed === null
      ? 'no score recorded; the snapshot carries no `demandMissedPairs`, so "never asked" and "asked and unanswered" cannot be told apart here'
      : `no score recorded — ${missed} pair(s) were demanded and never answered in this round, and the rest of these were never demanded`;

// ---------------------------------------------------------------------------------------------------------------
// The drawn window
// ---------------------------------------------------------------------------------------------------------------

const from = args.tail !== null && Number.isFinite(args.tail) ? Math.max(0, N - args.tail) : 0;
const ids = order.slice(from);
/** Append-order index of a segment id. Defined here, before the loop that asks: a `const` read from a function
 *  called earlier would be in its temporal dead zone, which is a crash rather than a wrong picture, but it is the
 *  kind of mistake that only shows on the first run. */
const indexOfOrder = new Map(order.map((id, i) => [id, i]));
const indexOfId = (id) => indexOfOrder.get(id) ?? -1;

// The drawn window's own coverage, beside the run's. With `--tail` the two differ — on this round the tail is better
// covered than the run average — and a reader looking at a legible window must not carry the run's 41.5 % over to it.
let winOffered = 0;
let winSettled = 0;
for (let row = 0; row < ids.length; row += 1) {
  for (let col = 0; col < row; col += 1) {
    const key = `${ids[col]}|${ids[row]}`;
    if (!offered.has(key)) continue;
    winOffered += 1;
    if (settled.has(key)) winSettled += 1;
  }
}
const windowShare = winOffered === 0 ? 0 : (100 * winSettled) / winOffered;
const windowNote = `In this window alone: ${winSettled.toLocaleString()} of ${winOffered.toLocaleString()} offered pairs settled (${windowShare.toFixed(
  1,
)} %), which is not the run's ${settledShare.toFixed(1)} % unless every segment is drawn.`;
const CELL = args.cellPx !== null && Number.isFinite(args.cellPx) ? args.cellPx : Math.max(20, Math.min(26, Math.floor(760 / ids.length)));
const FONT = Math.max(7, Math.round(CELL * 0.46));
const LEFT = 168;
const TOP = 236;
const size = ids.length * CELL;
const width = LEFT + size + 40;
const height = TOP + size + 96;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const parts = [];
parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Segoe UI, system-ui, sans-serif">`);
parts.push(`<rect width="${width}" height="${height}" fill="#ffffff"/>`);
parts.push(`<text x="16" y="26" font-size="18" font-weight="600">S1CAP RG matrix — cell ${esc(cell)}, ${esc(relative(process.cwd(), runDir).split(sep).join('/') || runDir)}</text>`);
parts.push(
  `<text x="16" y="46" font-size="12" fill="#333">each cell: the recorded relevance in percent (<tspan font-weight="600">round(w × 100)</tspan>), blank when no score exists · r=${r} · w=${w} · d=${knobs.d} · ${N} segments</text>`,
);
parts.push(
  `<text x="16" y="64" font-size="12" fill="#333">whole run: ${offeredCount.toLocaleString()} pairs offered by the window · <tspan font-weight="700">${settledShare.toFixed(1)} % settled</tspan> (${(rejectedCount + edgeCount).toLocaleString()}) · ${unsettledCount.toLocaleString()} with no score · ${rejectedCount.toLocaleString()} below r · ${edgeCount.toLocaleString()} edges (snapshot records ${(graph.edges ?? []).length})</text>`,
);
parts.push(
  `<text x="16" y="82" font-size="12" fill="#333">demanded ${String(demanded)} · <tspan font-weight="700">demanded and missed ${String(missed)}</tspan> · judged/scored ${String(graph.judgedPairs)}/${String(graph.scoredPairs)} · deferred ${String(graph.deferredPairs)} — ${missed === 0 ? 'the lane answered every pair it was asked for, so "not settled" here means "not asked"' : 'see the legend for what a missing score means in this round'}</text>`,
);
parts.push(
  `<text x="16" y="98" font-size="12" fill="#333">snapshot ${esc(graphPath.split(sep).slice(-1)[0])} — ${snapshots} file(s) in the directory, the largest read</text>`,
);

const legend = [
  ['#ffffff', '', 'none', 'white, no border', 'never offered: wrong order for a backward walk, or further apart than w'],
  ['#ffffff', '#b0b0b0', 'dashed', 'dashed border, no number', unscoredMeaning],
  ['#ffffff', '#c9c9c9', 'thin', 'thin grey border', `scored below r=${r}: the walk may not follow it`],
  ['#ffffff', '#12306e', 'thick', 'thick navy border', `scored at or above r: an edge (snapshot: ${(graph.edges ?? []).length})`],
];
legend.forEach(([, stroke, , label, note], k) => {
  const y = 116 + k * 17;
  parts.push(
    `<rect x="18" y="${y - 9}" width="15" height="13" fill="#ffffff" stroke="${stroke === '' ? '#ffffff' : stroke}" stroke-width="${
      stroke === '#12306e' ? 2 : stroke === '' ? 0 : 1
    }"${stroke === '#b0b0b0' ? ' stroke-dasharray="2 2"' : ''}/>`,
  );
  parts.push(
    `<text x="40" y="${y + 1}" font-size="11.5"><tspan font-weight="600">${esc(label)}</tspan><tspan fill="#555"> — ${esc(
      // `**` is how a source comment marks emphasis; SVG has no markdown, so it must not reach the picture.
      (note.length > 150 ? `${note.slice(0, 147)}…` : note).replace(/\*\*/g, ''),
    )}</tspan></text>`,
  );
});
parts.push(
  `<text x="16" y="196" font-size="11.5" fill="#555">${from > 0 ? `drawn: the last ${ids.length} segments (#${from}–#${N - 1} in append order).` : 'drawn: every segment. Use --tail N when the numbers are too small to read.'} ${windowNote}</text>`,
);
parts.push(
  `<text x="16" y="214" font-size="11.5" fill="#555">row = the later segment of the pair (the one asking), column = the earlier one. The walk travels backwards, so every pair drawn has row &gt; column and the values lie **below** the diagonal — the first version of this caption said "above", which the picture itself contradicted.</text>`.replace(
    /\*\*/g,
    '',
  ),
);

const originX = LEFT;
const originY = TOP;
parts.push(`<rect x="${originX}" y="${originY}" width="${size}" height="${size}" fill="#fff"/>`);

for (let row = 0; row < ids.length; row += 1) {
  for (let col = 0; col < ids.length; col += 1) {
    const later = ids[row];
    const earlier = ids[col];
    const x = originX + col * CELL;
    const y = originY + row * CELL;
    // The state is the **border**, the number is the content, and the fill stays white so the digits are the
    // darkest thing in the cell. A reader scanning the figure sees two independent facts without decoding a ramp:
    // which pairs the walk may follow (border weight and colour), and what the lane answered (the number, or the
    // absence of one).
    if (row === col) {
      // The diagonal is not a pair: a segment is not associated with itself.
      parts.push(`<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" fill="#d8d8d8"/>`);
      continue;
    }
    if (indexOfId(later) <= indexOfId(earlier)) continue; // the wrong orientation for a backward walk
    const key = `${earlier}|${later}`;
    if (!offered.has(key)) continue; // never offered: the cell keeps the page's own white and no border
    const value = settled.get(key);
    if (value === undefined) {
      // Offered and never answered. A **dashed** border with no number: the dashes are the missing value, so the
      // cell cannot be misread as "scored 0".
      parts.push(
        `<rect x="${x + 1}" y="${y + 1}" width="${CELL - 2}" height="${CELL - 2}" fill="#ffffff" stroke="#b0b0b0" stroke-width="1" stroke-dasharray="2 2"/>`,
      );
      continue;
    }
    const isEdge = value >= r;
    parts.push(
      `<rect x="${x + 0.5}" y="${y + 0.5}" width="${CELL - 1}" height="${CELL - 1}" fill="#ffffff" stroke="${
        isEdge ? '#12306e' : '#c9c9c9'
      }" stroke-width="${isEdge ? 2 : 1}"/>`,
    );
    parts.push(
      `<text x="${x + CELL / 2}" y="${y + CELL / 2 + FONT * 0.35}" font-size="${FONT}" text-anchor="middle" fill="${
        isEdge ? '#12306e' : '#8a8a8a'
      }" font-weight="${isEdge ? '700' : '400'}">${Math.round(value * 100)}</text>`,
    );
  }
}

// Both axes are the same append order, so the rows and the columns carry the same labels.
for (let k = 0; k < ids.length; k += 1) {
  const seg = segments.get(ids[k]) ?? {};
  const label = `${esc(String(seg.kind ?? '?')).slice(0, 12)} ${esc(String(seg.seq ?? ''))}`;
  parts.push(
    `<text x="${originX - 6}" y="${originY + k * CELL + CELL / 2 + FONT * 0.35}" font-size="${Math.max(8, FONT * 0.8)}" fill="#444" text-anchor="end">${label}</text>`,
  );
  parts.push(
    `<text x="${originX + k * CELL + CELL / 2}" y="${originY + size + 13}" font-size="${Math.max(8, FONT * 0.8)}" fill="#444" text-anchor="middle" transform="rotate(-60 ${originX + k * CELL + CELL / 2} ${originY + size + 13})">${esc(String(seg.seq ?? ''))}</text>`,
  );
  parts.push(`<line x1="${originX + k * CELL}" y1="${originY}" x2="${originX + k * CELL}" y2="${originY + size}" stroke="#f2f2f2" stroke-width="0.5"/>`);
  parts.push(`<line x1="${originX}" y1="${originY + k * CELL}" x2="${originX + size}" y2="${originY + k * CELL}" stroke="#f2f2f2" stroke-width="0.5"/>`);
}
parts.push(`<rect x="${originX}" y="${originY}" width="${size}" height="${size}" fill="none" stroke="#bbb"/>`);
parts.push('</svg>');

const out = args.out ?? join(runDir, 'report', args.tail === null ? 'rg-matrix.svg' : `rg-matrix-tail${ids.length}.svg`);
// The report directory is not guaranteed to exist: a round that has never been reported has no `report/`, and
// `writeFileSync` answers ENOENT with a stack trace that says `node:fs:2430` and nothing about the cause — which is
// how the first run of this tool on two of the three rounds failed.
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, parts.join('\n'), 'utf8');

console.log(
  `rg-matrix: ${cell} @ ${relative(process.cwd(), runDir).split(sep).join('/')} — ${N} segments, drawn ${ids.length}, ` +
    `${offeredCount.toLocaleString()} offered, settled ${settledShare.toFixed(1)} %, unsettled ${unsettledCount.toLocaleString()}, ` +
    `rejected ${rejectedCount.toLocaleString()}, edges ${edgeCount.toLocaleString()}`,
);
console.log(`wrote ${out}`);
