/**
 * Compose one shareable figure for a finished round: what each cell is, and what each cell measured.
 *
 * Why this exists. A round produces three tables and three charts, and a reader who receives them separately has to
 * hold the cell definitions in their head while reading the numbers - which is exactly how "C1" gets read as the
 * wrong arm. This writes a single self-contained file that carries both: the configuration each cell actually ran
 * (read from that cell's own wiring record, not from its recipe) and the metrics from the report, with the charts
 * inline.
 *
 * Everything is read back from artifacts the round already produced. This file derives no metric: the numbers come
 * from `cell-report.md`, the charts from `cell-report.mjs`'s own SVGs, and the configuration from the plugin's
 * `kind:"wiring"` tape record. A missing input is an error, never a blank in the figure.
 *
 * Usage: node scripts/cell-figure.mjs --run <run-dir> [--out <dir>] [--cells C0,C1,C2] [--label "C0=baseline,..."]
 *   writes <out>/summary.svg and <out>/summary.html (default out: <run>/report)
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// ---------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------

function parseArgv(argv) {
  const out = { cells: [], label: null, run: null, out: null, headerHeight: 900 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--run') out.run = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--cells') out.cells = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--label') out.label = argv[++i];
    else if (a === '--header-height') out.headerHeight = Number(argv[++i]);
    else throw new Error(`unknown argument "${a}"`);
  }
  if (!out.run) throw new Error('usage: node scripts/cell-figure.mjs --run <run-dir> [--out <dir>] [--cells C0,C1,C2]');
  return out;
}

const opts = parseArgv(process.argv.slice(2));
const run = resolve(opts.run);
const cells = opts.cells.length > 0 ? opts.cells : ['C0', 'C1', 'C2'];
const outDir = opts.out ? resolve(opts.out) : join(run, 'report');
const labelOf = new Map(
  (opts.label ?? '')
    .split(',')
    .map((pair) => pair.split('=').map((s) => s.trim()))
    .filter((pair) => pair.length === 2),
);

if (!existsSync(outDir)) throw new Error(`no output directory: ${outDir}`);
for (const name of ['time', 'cost', 's1-governance']) {
  if (!existsSync(join(outDir, `${name}.svg`))) {
    throw new Error(`missing chart ${name}.svg in ${outDir} - run cell-report.mjs first`);
  }
}
if (!existsSync(join(outDir, 'cell-report.md'))) {
  throw new Error(`missing cell-report.md in ${outDir} - run cell-report.mjs first`);
}

// ---------------------------------------------------------------------------------------------
// What each cell is, as it actually ran
// ---------------------------------------------------------------------------------------------

/**
 * Read the cell's own `kind:"wiring"` tape record. This is the report's own source for "did this arm have a
 * System-1 lane", so the figure cannot claim a configuration the cell did not run: the recipe is not consulted.
 */
function wiringOf(cell) {
  const tape = join(run, 'home', cell, '.s1cap', 'tape.jsonl');
  if (!existsSync(tape)) throw new Error(`${cell}: no tape at ${tape}`);
  for (const line of readFileSync(tape, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // a torn tail line is expected while an instance is running
    }
    if (rec.kind === 'wiring') return rec;
  }
  throw new Error(`${cell}: the tape holds no wiring record, so what the cell ran is unknown`);
}

const yes = (b) => (b ? 'on' : 'off');
const definitions = cells.map((cell) => {
  const w = wiringOf(cell);
  const lane =
    w.s1 === 'none' || w.s1 == null
      ? 'none (provider: none)'
      : `${w.s1.provider}${w.s1.baseUrl ? ` at ${w.s1.baseUrl}` : ''}`;
  const role =
    cell === 'C0'
      ? 'baseline: chronological history, nothing ordered, nothing delivered'
      : cell === 'C1'
        ? 'TAS alone: state proxy first, current task before recall, nothing judged'
        : cell === 'C2'
          ? 'full configuration: TAS ordering plus System-1 governance'
          : `(${labelOf.get(cell) ?? 'no role recorded'})`;
  return {
    cell,
    role,
    tas: yes(w.tas?.on),
    selection: yes(w.relevance),
    planGate: yes(w.planGate),
    xFirst: yes(w.xFirst),
    lane,
  };
});

// ---------------------------------------------------------------------------------------------
// The numbers, read out of the report rather than recomputed
// ---------------------------------------------------------------------------------------------

/** The report's total rows are `| metric | unit | v0 | v1 | v2 |`, or `| metric | v0 | v1 | v2 |` for a few. */
function rowsOf(markdown) {
  const rows = new Map();
  for (const line of markdown.split(/\r?\n/)) {
    if (!line.startsWith('|') || line.includes('---')) continue;
    const parts = line.split('|').slice(1, -1).map((s) => s.trim());
    if (parts.length !== cells.length + 1 && parts.length !== cells.length + 2) continue;
    const key = parts[0].replaceAll('*', '').replace(/\s+/g, ' ').trim();
    const unit = parts.length === cells.length + 2 ? parts[1] : '';
    const values = parts.slice(parts.length - cells.length);
    if (!rows.has(key)) rows.set(key, { unit, values }); // the cell-total tables come first
  }
  return rows;
}

const report = readFileSync(join(outDir, 'cell-report.md'), 'utf8');
const rows = rowsOf(report);

const WANTED = [
  ['turns', 'TIME'],
  ['steps', 'TIME'],
  ['LLM calls', 'TIME'],
  ['System-1 calls', 'TIME'],
  ['other tool calls', 'TIME'],
  ['LLM time', 'TIME'],
  ['System-1 time', 'TIME'],
  ['other tool time', 'TIME'],
  ['step frame (step/start', 'TIME'],
  ['turn frame (turn/start', 'TIME'],
  ['cached-hit input tokens', 'COST'],
  ['uncached input tokens', 'COST'],
  ['output tokens', 'COST'],
  ["System-1 lane's own tokens", 'COST'],
  ['System-1 coverage', 'DIAGNOSTICS'],
  ['System-1 calls ok / refused / total', 'DIAGNOSTICS'],
  ['context injections delivered', 'DIAGNOSTICS'],
];

const metrics = [];
for (const [want, group] of WANTED) {
  const hit = [...rows.entries()].find(([key]) => key.startsWith(want));
  if (!hit) throw new Error(`the report has no "${want}" row - the figure would silently omit a metric`);
  metrics.push({ group, name: hit[0], unit: hit[1].unit, values: hit[1].values });
}

// ---------------------------------------------------------------------------------------------
// The composition
// ---------------------------------------------------------------------------------------------

const CHART_W = 1120;
const MARGIN = 24;
const PAGE_W = CHART_W + MARGIN * 2;

/** Charts are nested as whole `<svg>` elements at their own size, so their internal coordinates are untouched. */
function chart(name) {
  const svg = readFileSync(join(outDir, `${name}.svg`), 'utf8');
  const open = svg.match(/<svg[^>]*width="(\d+)"[^>]*height="(\d+)"[^>]*>/);
  if (!open) throw new Error(`${name}.svg has no width/height`);
  const style = svg.match(/<style>[\s\S]*?<\/style>/);
  if (!style) throw new Error(`${name}.svg has no <style> block`);
  return {
    width: Number(open[1]),
    height: Number(open[2]),
    style: style[0],
    inner: svg.slice(open.index + open[0].length, svg.lastIndexOf('</svg>')),
  };
}

const charts = ['time', 'cost', 's1-governance'].map((name) => chart(name));
if (new Set(charts.map((c) => c.style)).size !== 1) {
  throw new Error('the charts do not share one <style> block; nesting them would let one restyle another');
}

const snapshot = (report.match(/snapshot taken: ([^\s(]+)/) ?? [])[1] ?? 'unknown';
const model = 'deepseek-account/deepseek-flash (DeepSeek V4.1 Flash), reasoningEffort pinned';

const esc = (s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const table = (head, bodyRows, cls) => `
  <table class="${cls}">
    <thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${bodyRows.map((r) => `<tr>${r.map((c, i) => `<${i === 0 ? 'th' : 'td'}>${esc(String(c))}</${i === 0 ? 'th' : 'td'}>`).join('')}</tr>`).join('')}</tbody>
  </table>`;

const defTable = table(
  ['cell', 'what it is', 'TAS', 'S1 selection', 'plan gate', 'x-first', 'System-1 lane'],
  definitions.map((d) => [d.cell, d.role, d.tas, d.selection, d.planGate, d.xFirst, d.lane]),
  'defs',
);

let lastGroup = null;
const numRows = [];
for (const m of metrics) {
  if (m.group !== lastGroup) {
    numRows.push([`${m.group}`, '', ...cells.map(() => '')]);
    lastGroup = m.group;
  }
  numRows.push([m.name.replace(/\s*\(.*$/, ''), m.unit, ...m.values]);
}
const numTable = table(['metric', 'unit', ...cells.map((c) => labelOf.get(c) ?? c)], numRows, 'nums');

const header = `
  <h1>S1CAP ablation &mdash; three cells, ${cells.join(' / ')}</h1>
  <p class="sub">Round <code>${esc(run.split(/[\\/]/).pop())}</code> &middot; model <strong>${esc(model)}</strong> &middot; one cell at a time, three human messages each, no intervention &middot; snapshot ${esc(snapshot)}</p>
  <div class="note"><strong>Read this before the numbers.</strong> One round, <strong>n&nbsp;=&nbsp;1 per cell</strong>, so these are a direction, not an estimate. The two arms that show <code>0 (no S1 lane)</code> have <em>no System-1 backend at all</em> (<code>s1.provider: none</code> + <code>laya.enabled: false</code>), so their System-1 calls, tokens and time are zero by construction and their coverage is <em>undefined</em>, not 0&nbsp;%. The third arm's lane is live. The two token accounts are separate: the lane's own tokens are the backend's, the cached-hit / uncached / output tokens are the model's.</div>
  ${defTable}
  <p class="sub">Configuration read from each cell's own <code>wiring</code> record, not from its recipe.</p>
  ${numTable}
  <p class="sub">Numbers read from <code>cell-report.md</code>; charts from <code>cell-report.mjs</code>. <code>step frame</code> = step/start&rarr;step/end, <code>turn frame</code> = turn/start&rarr;turn/end. System-1 time is <strong>concurrent</strong> with the request and must never be added to LLM time.</p>`;

// The header is HTML, and in the HTML deliverable it simply flows - no fixed box, so it cannot clip. The SVG
// deliverable has to place it, and SVG has no notion of "as tall as its content", so there the height is an
// estimate: `--header-height`, printed by this tool and wrong only in the direction of leaving a gap if it is too
// large. That is the reason the PNG is taken from the HTML, not from the SVG.
const HEADER_H = opts.headerHeight;
const chartBlockHeights = charts.map((c) => c.height + 30);
const chartsHeight = chartBlockHeights.reduce((a, b) => a + b, 0);

const pageStyle = `
    .page { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; color:#1a1a1a; font-size:13px; line-height:1.45; }
    .page h1 { font-size:20px; margin:0 0 6px; }
    .page .sub { color:#555; margin:4px 0 10px; font-size:12px; }
    .page .note { background:#fff8e6; border:1px solid #e8d9a8; border-radius:6px; padding:8px 10px; margin:8px 0 12px; }
    .page table { border-collapse:collapse; margin:6px 0 4px; font-size:12px; width:100%; }
    .page th, .page td { border:1px solid #dcdcdc; padding:3px 6px; text-align:left; vertical-align:top; }
    .page thead th { background:#f4f4f4; }
    .page tbody th { background:#fafafa; font-weight:600; white-space:nowrap; }
    .page td:nth-child(n+3), .page th:nth-child(n+3) { text-align:right; font-variant-numeric:tabular-nums; }
    .page .defs td:nth-child(2), .page .defs th:nth-child(2) { text-align:left; }
    .page .nums td:nth-child(2), .page .nums th:nth-child(2), .page .nums td:nth-child(1) { text-align:left; }
    .page code { background:#f2f2f2; padding:0 3px; border-radius:3px; }`;

const chartsOnlySvg = (top) => `<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE_W}" height="${chartsHeight + top}" viewBox="0 0 ${PAGE_W} ${chartsHeight + top}">
  <rect x="0" y="0" width="${PAGE_W}" height="${chartsHeight + top}" fill="#ffffff"/>
  ${charts[0].style}
${charts
  .map((c, i) => {
    const y = top + chartBlockHeights.slice(0, i).reduce((a, b) => a + b, 0);
    return `  <svg x="${MARGIN}" y="${y}" width="${c.width}" height="${c.height}" viewBox="0 0 ${c.width} ${c.height}">${c.inner}</svg>`;
  })
  .join('\n')}
</svg>`;

let y = HEADER_H;
const nested = [];
for (const [i, c] of charts.entries()) {
  nested.push(
    `<svg x="${MARGIN}" y="${y}" width="${c.width}" height="${c.height}" viewBox="0 0 ${c.width} ${c.height}">${c.inner}</svg>`,
  );
  y += chartBlockHeights[i];
}

const svg = `<!-- generated by scripts/cell-figure.mjs (S1CAP); self-contained, no script, no external font -->
<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE_W}" height="${HEADER_H + chartsHeight}" viewBox="0 0 ${PAGE_W} ${HEADER_H + chartsHeight}">
  <rect x="0" y="0" width="${PAGE_W}" height="${HEADER_H + chartsHeight}" fill="#ffffff"/>
  ${charts[0].style}
  <foreignObject x="0" y="0" width="${PAGE_W}" height="${HEADER_H}">
    <div xmlns="http://www.w3.org/1999/xhtml" class="page" style="padding:18px 24px 0">
      <style>${pageStyle}</style>
      ${header}
    </div>
  </foreignObject>
  ${nested.join('\n  ')}
</svg>
`;

writeFileSync(join(outDir, 'summary.svg'), svg, 'utf8');
writeFileSync(
  join(outDir, 'summary.html'),
  `<!doctype html><html><head><meta charset="utf-8"><title>S1CAP ${esc(cells.join(' '))} summary</title></head>
<body style="margin:0;background:#fff">
<div class="page" style="width:${PAGE_W}px;padding:18px 24px 0;box-sizing:border-box">
  <style>${pageStyle}</style>
  ${header}
</div>
${chartsOnlySvg(0)}
</body></html>\n`,
  'utf8',
);
console.log(`cell-figure: wrote ${join(outDir, 'summary.svg')} and summary.html`);
console.log(`  ${cells.length} cell(s), ${metrics.length} metric(s), ${charts.length} chart(s)`);
console.log(`  summary.html width ${PAGE_W}px, height is content-driven (render it to measure)`);
console.log(`  summary.svg assumes a ${HEADER_H}px header box; if the header clips there, raise --header-height`);
