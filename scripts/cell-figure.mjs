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
 * Usage: node scripts/cell-figure.mjs --self-test
 *   builds synthetic inputs under the OS temp directory and asserts the composition, including the release
 *   record in both directions (recorded, and absent as every historical round is)
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// ---------------------------------------------------------------------------------------------
// The round's software identity
//
// A figure is the artifact people forward, so it cannot be read without knowing what produced it. The
// release is read from `<run>/manifest.json`'s `_dsh` block - read, never inferred - and a round that
// predates the record prints the harness's own sentence rather than a blank. The wording and the
// clause order are `cell-report.mjs`'s, so the figure, the report and the harness's `report.mjs`
// wrapper all say the same thing.
// ---------------------------------------------------------------------------------------------

const UNKNOWN_RELEASE =
  'UNKNOWN RELEASE - this round predates the release record; quote that fact with any number from it.';

/** See `cell-report.mjs`'s `readDshRecord`: every way the record can be absent is one stated fact. */
function readDshRecord(runDir) {
  const path = join(runDir, 'manifest.json');
  if (!existsSync(path)) return { present: false, reason: 'no manifest.json' };
  let doc;
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return { present: false, reason: `manifest.json is not valid JSON (${err.message})` };
  }
  const d = doc ? doc._dsh : null;
  if (!d || typeof d !== 'object' || typeof d.version !== 'string' || d.version === '') {
    return { present: false, reason: 'manifest.json records no _dsh.version' };
  }
  return {
    present: true,
    version: d.version,
    executable: typeof d.executable === 'string' && d.executable !== '' ? d.executable : null,
    probedAt: typeof d.probedAt === 'string' && d.probedAt !== '' ? d.probedAt : null,
    provider: d.model && typeof d.model.provider === 'string' ? d.model.provider : null,
    model: d.model && typeof d.model.model === 'string' ? d.model.model : null,
    plugin: d.plugin && typeof d.plugin === 'object' ? d.plugin : null,
  };
}

/**
 * The identity as the harness words it:
 *   `dsh <v> (<exe>, provisioned <at>) [| model <p>/<m>] [| NOT declared supported by <plugin> (declares …)]`
 * `cell-report.mjs` carries the same sentence on its chart captions. The figure's identity line already
 * names the model in its own words, so here the clause is the release and the support warning only.
 */
function dshReleaseClause(dsh) {
  if (!dsh.present) return UNKNOWN_RELEASE;
  const parts = [`dsh ${dsh.version} (${dsh.executable ?? 'executable not recorded'}, provisioned ${dsh.probedAt ?? 'time not recorded'})`];
  const declared = dsh.plugin && dsh.plugin.declaredDshReleases;
  if (declared && typeof declared === 'object' && !Object.hasOwn(declared, dsh.version)) {
    parts.push(`NOT declared supported by ${dsh.plugin.name ?? 'the plugin'} (declares ${Object.keys(declared).join(', ')})`);
  }
  return parts.join(' | ');
}

// ---------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------

function parseArgv(argv) {
  const out = { cells: [], label: null, run: null, out: null, headerHeight: 900, selfTest: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--run') out.run = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--cells') out.cells = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--label') out.label = argv[++i];
    else if (a === '--header-height') out.headerHeight = Number(argv[++i]);
    else if (a === '--self-test') out.selfTest = true;
    else throw new Error(`unknown argument "${a}"`);
  }
  if (!out.selfTest && !out.run) {
    throw new Error('usage: node scripts/cell-figure.mjs --run <run-dir> [--out <dir>] [--cells C0,C1,C2]');
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The composition
// ---------------------------------------------------------------------------------------------

/**
 * Read the cell's own `kind:"wiring"` tape record. This is the report's own source for "did this arm have a
 * System-1 lane", so the figure cannot claim a configuration the cell did not run: the recipe is not consulted.
 */
function wiringOf(run, cell) {
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

/**
 * The layout a wiring record states, read under both spellings because a round directory records what it ran and is
 * never rewritten.
 *
 * **`tracePlacement` is the only axis, and a current record states no question position at all — its absence is the
 * correction, not a gap.** The paper (arXiv:2609.02702 §4.1) places the question last in every condition, so the
 * field that used to move it was deleted rather than renamed on 2026-10-05, and the arm follows from
 * `tracePlacement` alone.
 *
 * A record written before that date states neither name: it wrote one boolean, `xFirst`, and no trace axis. That
 * boolean was the *question's* position, and it is carried here for what it was rather than translated onto an arm.
 * `xFirst: false` put the question last, which is what every layout does now, so it is harmless; `xFirst: true` asked
 * for the question **in front of the long context** (`[T, q, x]`), a layout this build cannot produce and
 * `LEGACY_LAYOUT_KEYS` in `packages/core/src/config.ts` refuses today. Those records also carry no
 * `stateProxyPosition` and no `tracePlacement`, so their trace axis is genuinely unrecorded - the figure says so
 * rather than inferring it from `layout.order`, which would be a guess about which of the two arrangements produced
 * that order.
 */
function layoutAxes(w) {
  const tracePlacement =
    w.tracePlacement === 'trace-as-state' || w.tracePlacement === 'trace-append' ? w.tracePlacement : null;
  const legacyXFirst = typeof w.xFirst === 'boolean' ? w.xFirst : null;
  return { tracePlacement, legacyXFirst };
}

/** What the record did not state. A layout the figure cannot read is said, never defaulted to the policy's values. */
const NOT_RECORDED = '(not recorded)';

/**
 * A pre-rename record's `xFirst: true`, named as what it was: the question in front of the long context, which is
 * `[T, q, x]` - not one of the paper's two orders, and a layout this build cannot produce. It is reported as no arm
 * rather than mapped onto one, because there is no arm it corresponds to.
 */
const XFIRST_TRUE_NOT_AN_ARM =
  'not a paper arm (pre-rename `xFirst: true`: the question was in front of the long context)';

/**
 * The paper's arm, named from `tracePlacement` alone: Trace as State is `M([T, x, q])` and Trace Append is
 * `M([x, T, q])`, with the question last in both. That fixed point is why no question field is read here - a current
 * record has none, and a pre-rename one states a position this build no longer has a layout for.
 *
 * A record with no trace axis identifies no arm. A pre-rename round wrote the boolean `xFirst` instead, so its trace
 * axis was never recorded and the cell says that; and `xFirst: true` asked for the question in front of the long
 * context, so it is named as no paper arm rather than as one of the paper's.
 */
function paperArm({ tracePlacement, legacyXFirst }) {
  if (tracePlacement === null && legacyXFirst === null) return NOT_RECORDED;
  if (tracePlacement === null) return legacyXFirst ? XFIRST_TRUE_NOT_AN_ARM : 'not identifiable (no trace axis recorded)';
  return tracePlacement === 'trace-as-state' ? 'Trace as State [T, x, q]' : 'Trace Append [x, T, q]';
}

/**
 * The report's total rows are `| metric | unit | v0 | v1 | v2 |`, or `| metric | v0 | v1 | v2 |` for a few.
 *
 * The Provenance section is skipped outright. Its table has the same shape as a total row and its keys collide with
 * real ones - `System-1 calls after the last turn/end` starts with `System-1 calls` - so reading it fed the figure
 * the asynchronous tail (0 | 0 | 4 on round 20261001-1414) where the cell total was 0 | 0 | 25, eight times too few
 * for the only cell with a lane. Provenance is metadata about when the artifacts were read; it is never a metric,
 * and no ordering assumption is safe here because it is printed first.
 */
function rowsOf(markdown, cellCount) {
  const rows = new Map();
  let section = '';
  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.match(/^#{2,3}\s+(.+?)\s*$/);
    if (heading) {
      section = heading[1];
      continue;
    }
    if (section.startsWith('Provenance')) continue;
    if (!line.startsWith('|') || line.includes('---')) continue;
    const parts = line.split('|').slice(1, -1).map((s) => s.trim());
    if (parts.length !== cellCount + 1 && parts.length !== cellCount + 2) continue;
    const key = parts[0].replaceAll('*', '').replace(/\s+/g, ' ').trim();
    const unit = parts.length === cellCount + 2 ? parts[1] : '';
    const values = parts.slice(parts.length - cellCount);
    if (!rows.has(key)) rows.set(key, { unit, values });
  }
  return rows;
}

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
  // Two rows since 2026-10-05, and both belong in the figure. `docs/FORMULAS.md` §5.1 defines the floor as
  // **distinct pairs settled over the offered window** and demotes `judgedPairs/scoredPairs` to a secondary
  // reading; the report prints them as two rows whose labels share the prefix "System-1 coverage", so naming
  // either one by that prefix alone is ambiguous - `pickRow` throws rather than picking, which is how this was
  // caught. Name each exactly.
  ['System-1 coverage over offered', 'DIAGNOSTICS'],
  ['System-1 coverage, judged/scored', 'DIAGNOSTICS'],
  ['System-1 calls ok / refused / total', 'DIAGNOSTICS'],
  ['context injections delivered', 'DIAGNOSTICS'],
];

/**
 * Pick the row that carries a wanted metric.
 *
 * Exact key first, as the caller does: four of the seventeen wanted names are also the prefix of a
 * *different* row in the same report (`turns completed`, `steps (session store step/start)`,
 * `LLM calls = steps?`, `System-1 calls after the last turn/end`), and any of them could be printed
 * under the wanted label.
 *
 * The prefix fallback is still needed, because the report spells two rows with a suffix the wanted
 * name omits (`step frame (step/start→step/end)`). It refuses to guess: more than one prefix match
 * with no exact match throws, so the next collision of this shape is a loud failure rather than a
 * wrong number under a right-looking label.
 */
/**
 * Rows this figure asks for under a name the report no longer uses.
 *
 * `cell-report.mjs` owns its metric labels (`docs/DOC-CONTRACT.md` §2: a document — or a reader — must not restate
 * a value the code owns), so this figure follows the report rather than pinning a label of its own. But a round's
 * `cell-report.md` is a **frozen artifact**: a report generated before the report renamed a row must still render.
 * Hence both spellings, newest first, resolved by the same exact-then-prefix rule `pickRow` already uses.
 *
 * The one entry here is a live mismatch that made the figure unusable on **every** round, old or freshly
 * generated: the report writes "System-1 lane input tokens (the priced quantity)" (its cost table, beside the
 * output-token row) while this figure asked for "System-1 lane's own tokens". Neither label may be abbreviated to
 * "System-1 lane" to bridge them — the report carries a second row starting with those words, and `pickRow` throws
 * on an ambiguous prefix rather than guessing, which is the right behaviour to keep.
 */
const RENAMED_ROWS = new Map([
  ["System-1 lane's own tokens", ['System-1 lane input tokens (the priced quantity)']],
]);

function pickRow(rows, want) {
  if (rows.has(want)) return [want, rows.get(want)];
  const candidates = [want, ...(RENAMED_ROWS.get(want) ?? [])];
  for (const candidate of candidates) {
    if (rows.has(candidate)) return [candidate, rows.get(candidate)];
    const matches = [...rows.entries()].filter(([key]) => key.startsWith(candidate));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new Error(
        `"${candidate}" matches ${matches.length} rows (${matches.map(([k]) => `"${k}"`).join(', ')}) and none of `
          + 'them exactly - name the row exactly in WANTED instead of letting the figure pick one of them',
      );
    }
  }
  return null;
}

const CHART_W = 1120;
const MARGIN = 24;
const PAGE_W = CHART_W + MARGIN * 2;

/** Charts are nested as whole `<svg>` elements at their own size, so their internal coordinates are untouched. */
function chartBlock(outDir, name) {
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

/**
 * Build both deliverables and write them. Returns the parts, so `--self-test` can assert on what was
 * written without re-reading it and without a second code path that could drift from this one.
 */
function composeFigure({ run, cells, outDir, labelOf, headerHeight }) {
  if (!existsSync(outDir)) throw new Error(`no output directory: ${outDir}`);
  for (const name of ['time', 'cost', 's1-governance']) {
    if (!existsSync(join(outDir, `${name}.svg`))) {
      throw new Error(`missing chart ${name}.svg in ${outDir} - run cell-report.mjs first`);
    }
  }
  if (!existsSync(join(outDir, 'cell-report.md'))) {
    throw new Error(`missing cell-report.md in ${outDir} - run cell-report.mjs first`);
  }

  // -------------------------------------------------------------------------------------------
  // What each cell is, as it actually ran
  // -------------------------------------------------------------------------------------------

  const yes = (b) => (b ? 'on' : 'off');
  const definitions = cells.map((cell) => {
    const w = wiringOf(run, cell);
    const lane =
      w.s1 === 'none' || w.s1 == null
        ? 'none (provider: none)'
        : `${w.s1.provider}${w.s1.baseUrl ? ` at ${w.s1.baseUrl}` : ''}`;
    const role =
      cell === 'C0'
        ? 'baseline: chronological history, nothing ordered, nothing delivered'
        : cell === 'C1'
          ? "the paper's arm: the state proxy T is delivered on its own, with recall selection off and the System-1 lane absent"
          : cell === 'C2'
            ? 'full configuration: the state proxy T ahead of the System-1 recall selection'
            : `(${labelOf.get(cell) ?? 'no role recorded'})`;
    const axes = layoutAxes(w);
    return {
      cell,
      role,
      tas: yes(w.tas?.on),
      selection: yes(w.relevance),
      placement: paperArm(axes),
      lane,
    };
  });

  // -------------------------------------------------------------------------------------------
  // The numbers, read out of the report rather than recomputed
  // -------------------------------------------------------------------------------------------

  const report = readFileSync(join(outDir, 'cell-report.md'), 'utf8');
  const rows = rowsOf(report, cells.length);

  const metrics = [];
  for (const [want, group] of WANTED) {
    const hit = pickRow(rows, want);
    if (!hit) throw new Error(`the report has no "${want}" row - the figure would silently omit a metric`);
    metrics.push({ group, name: hit[0], unit: hit[1].unit, values: hit[1].values });
  }

  // -------------------------------------------------------------------------------------------
  // The composition
  // -------------------------------------------------------------------------------------------

  const charts = ['time', 'cost', 's1-governance'].map((name) => chartBlock(outDir, name));
  if (new Set(charts.map((c) => c.style)).size !== 1) {
    throw new Error('the charts do not share one <style> block; nesting them would let one restyle another');
  }

  const snapshot = (report.match(/snapshot taken: ([^\s(]+)/) ?? [])[1] ?? 'unknown';
  const model = 'deepseek-account/deepseek-flash (DeepSeek V4.1 Flash), reasoningEffort pinned';
  const dsh = readDshRecord(run);
  const release = dshReleaseClause(dsh);

  const esc = (s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const table = (head, bodyRows, cls) => `
  <table class="${cls}">
    <thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${bodyRows.map((r) => `<tr>${r.map((c, i) => `<${i === 0 ? 'th' : 'td'}>${esc(String(c))}</${i === 0 ? 'th' : 'td'}>`).join('')}</tr>`).join('')}</tbody>
  </table>`;

  const defTable = table(
    // No `plan gate` column: the policy has no such field any more, and a column printed from a key no run writes
    // would be a blank in one cell and a true-looking "yes" in another. See packages/core/src/types.ts.
    // One `placement` column, and not the two layout columns of 2026-10-05: `tracePlacement` is the only layout axis
    // (the question's position was deleted, not renamed), so the column names the paper's arm from that one value,
    // and a pre-rename round - which recorded the boolean `xFirst` and no trace axis - is named for what it was
    // rather than given an arm it never ran.
    ['cell', 'what it is', 'TAS', 'S1 selection', 'placement', 'System-1 lane'],
    definitions.map((d) => [d.cell, d.role, d.tas, d.selection, d.placement, d.lane]),
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

  // The identity line carries the release beside the model, because the figure is the artifact that
  // gets forwarded on its own and a number cannot be placed without knowing what produced it. An
  // unrecorded release prints the harness's own sentence: never a blank, never a guess.
  const header = `
  <h1>S1CAP ablation &mdash; three cells, ${cells.join(' / ')}</h1>
  <p class="sub">Round <code>${esc(run.split(/[\\/]/).pop())}</code> &middot; <strong>${esc(release)}</strong> &middot; model <strong>${esc(model)}</strong> &middot; one cell at a time, three human messages each, no intervention &middot; snapshot ${esc(snapshot)}</p>
  <div class="note"><strong>Read this before the numbers.</strong> One round, <strong>n&nbsp;=&nbsp;1 per cell</strong>, so these are a direction, not an estimate. The two arms that show <code>0 (no S1 lane)</code> have <em>no System-1 backend at all</em> (<code>s1.provider: none</code> + <code>laya.enabled: false</code>), so their System-1 calls, tokens and time are zero by construction and their coverage is <em>undefined</em>, not 0&nbsp;%. The third arm's lane is live. The two token accounts are separate: the lane's own tokens are the backend's, the cached-hit / uncached / output tokens are the model's.</div>
  ${defTable}
  <p class="sub">Configuration read from each cell's own <code>wiring</code> record, not from its recipe. The <code>placement</code> column names the paper's arm from <code>tracePlacement</code> alone &mdash; Trace as State is <code>[T, x, q]</code>, Trace Append is <code>[x, T, q]</code>, and the question is last in both, which is why no record states a question position. A round run before 2026-10-05 records no trace axis at all: it wrote the boolean <code>xFirst</code> (the question's position) instead, so its arm is not identifiable, and <code>xFirst: true</code> &mdash; the question in front of the long context, a layout this build cannot produce &mdash; is named as no paper arm rather than mapped onto one.</p>
  ${numTable}
  <p class="sub">Numbers read from <code>cell-report.md</code>; charts from <code>cell-report.mjs</code>. <code>step frame</code> = step/start&rarr;step/end, <code>turn frame</code> = turn/start&rarr;turn/end. System-1 time is <strong>concurrent</strong> with the request and must never be added to LLM time.</p>`;

  // The header is HTML, and in the HTML deliverable it simply flows - no fixed box, so it cannot clip. The SVG
  // deliverable has to place it, and SVG has no notion of "as tall as its content", so there the height is an
  // estimate: `--header-height`, printed by this tool and wrong only in the direction of leaving a gap if it is too
  // large. That is the reason the PNG is taken from the HTML, not from the SVG.
  const HEADER_H = headerHeight;
  const chartBlockHeights = charts.map((c) => c.height + 30);
  const chartsHeight = chartBlockHeights.reduce((a, b) => a + b, 0);

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

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>S1CAP ${esc(cells.join(' '))} summary</title></head>
<body style="margin:0;background:#fff">
<div class="page" style="width:${PAGE_W}px;padding:18px 24px 0;box-sizing:border-box">
  <style>${pageStyle}</style>
  ${header}
</div>
${chartsOnlySvg(0)}
</body></html>\n`;

  writeFileSync(join(outDir, 'summary.svg'), svg, 'utf8');
  writeFileSync(join(outDir, 'summary.html'), html, 'utf8');

  return { svg, html, header, release, model, snapshot, metrics, charts, pageWidth: PAGE_W, headerHeight: HEADER_H };
}

// ---------------------------------------------------------------------------------------------
// --self-test
//
// The figure is a composition, so its failure mode is not a wrong number but a missing fact: a figure
// that omits a cell's configuration, a metric row, or - now - the release it was produced by. The
// fixture is the smallest set of inputs `composeFigure` reads, built twice: once with a `_dsh` record
// and once the way every round on disk looks today, without one.
// ---------------------------------------------------------------------------------------------

function assertEqual(actual, expected, what) {
  if (actual !== expected) {
    throw new Error(`self-test FAILED: ${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertTrue(cond, what) {
  if (!cond) throw new Error(`self-test FAILED: ${what}`);
}

const FIXTURE_CELLS = ['C0', 'C1', 'C2'];

/** The three charts, each a whole SVG with the same style block, as `cell-report.mjs` writes them. */
function writeFixtureCharts(outDir) {
  mkdirSync(outDir, { recursive: true });
  const style = '<style>\n    .doc-title { fill: #171a1f; font-size: 19px; }\n  </style>';
  for (const name of ['time', 'cost', 's1-governance']) {
    writeFileSync(join(outDir, `${name}.svg`), `<!-- fixture -->
<svg xmlns="http://www.w3.org/2000/svg" width="1120" height="546" viewBox="0 0 1120 546">
  <rect x="0" y="0" width="1120" height="546" fill="#ffffff"/>
  ${style}
  <text x="30" y="34" class="doc-title">${name}</text>
</svg>
`, 'utf8');
  }
}

/**
 * A report laid out the way `cell-report.mjs` lays one out - Provenance first, then the two
 * `### Cell totals` tables, then Completion, the mechanism diagnostics and the reconciliation - and
 * carrying the *real* neighbouring rows that share a wanted name's prefix.
 *
 * Every value is distinct per metric and per cell, so a wrong pick is a value mismatch and cannot hide
 * behind a coincidentally equal number: on the real round the `turns` / `turns completed`,
 * `steps` / `steps (session store step/start)` and `LLM calls` / `LLM calls = steps?` pairs happen to
 * carry identical values, so only their labels tell them apart. The decoy rows carry 999.
 */
const DECOY = '999 | 999 | 999';

function fixtureReport() {
  // The value a correct pick must yield, per wanted name. Everything else in the fixture is a decoy.
  const cellTotals = {
    turns: '11 | 12 | 13',
    steps: '21 | 22 | 23',
    'LLM calls': '31 | 32 | 33',
    'System-1 calls': '41 | 42 | 43',
    'other tool calls': '51 | 52 | 53',
    'LLM time': '61 | 62 | 63',
    'System-1 time': '71 | 72 | 73',
    'other tool time': '81 | 82 | 83',
    'step frame (step/start→step/end)': '91 | 92 | 93',
    'turn frame (turn/start→turn/end)': '101 | 102 | 103',
    'cached-hit input tokens': '111 | 112 | 113',
    'uncached input tokens': '121 | 122 | 123',
    'output tokens': '131 | 132 | 133',
    "System-1 lane's own tokens": '141 | 142 | 143',
  };
  // These live only in the mechanism table; there is no cell-total row for them. The coverage row split in two
  // on 2026-10-05 (the floor and the secondary reading), so the fixture carries both - a fixture that still had
  // the single old label is what made the failure above visible in the first place.
  const mechanism = {
    'System-1 coverage over offered (the floor)': '151 | 152 | 153',
    'System-1 coverage, judged/scored (the secondary reading)': '154 | 155 | 156',
    'System-1 calls ok / refused / total': '161 | 162 | 163',
    'context injections delivered': '171 | 172 | 173',
  };

  const timeRows = ['turns', 'steps', 'LLM calls', 'System-1 calls', 'other tool calls', 'LLM time', 'System-1 time', 'other tool time'];
  const frameRows = ['step frame (step/start→step/end)', 'turn frame (turn/start→turn/end)'];
  const costRows = ['cached-hit input tokens', 'uncached input tokens', 'output tokens', "System-1 lane's own tokens"];
  const total = (k) => `| ${k} | count | ${cellTotals[k]} |`;

  const lines = [
    '# S1CAP cell report',
    '',
    '- run: `fixture`',
    '- snapshot taken: 2026-01-01T00:00:00.000Z (all counts are of the artifacts as read at this instant)',
    '- DSH release: fixture',
    '',
    '## Provenance and snapshot',
    '',
    '|  | C0 | C1 | C2 |',
    '| --- | --- | --- | --- |',
    `| System-1 calls after the last turn/end | ${DECOY} |`,
    '',
    '## Time',
    '',
    '### Cell totals',
    '',
    '| metric | unit | C0 | C1 | C2 |',
    '| --- | --- | --- | --- | --- |',
    ...timeRows.map(total),
    ...frameRows.map(total),
    '',
    '## Cost',
    '',
    '### Cell totals',
    '',
    '| metric | unit | C0 | C1 | C2 |',
    '| --- | --- | --- | --- | --- |',
    ...costRows.map(total),
    '',
    '## Completion',
    '',
    '|  | C0 | C1 | C2 |',
    '| --- | --- | --- | --- |',
    `| turns completed | ${DECOY} |`,
    `| turn/end reason | ${DECOY} |`,
    '',
    '## Mechanism diagnostics (not cost metrics)',
    '',
    '| diagnostic | C0 | C1 | C2 |',
    '| --- | --- | --- | --- |',
    `| System-1 calls ok / refused / total | ${mechanism['System-1 calls ok / refused / total']} |`,
    `| **System-1 coverage over offered (the floor)** | ${mechanism['System-1 coverage over offered (the floor)']} |`,
    `| System-1 coverage, judged/scored (the secondary reading) | ${mechanism['System-1 coverage, judged/scored (the secondary reading)']} |`,
    `| context injections delivered | ${mechanism['context injections delivered']} |`,
    '',
    '## Reconciliation and warnings',
    '',
    '|  | C0 | C1 | C2 |',
    '| --- | --- | --- | --- |',
    `| steps (session store \`step/start\`) | ${DECOY} |`,
    `| System-1 calls (sum of buckets) | ${DECOY} |`,
    `| LLM calls = steps? | ${DECOY} |`,
    '',
  ];
  return { markdown: lines.join('\n'), expected: { ...cellTotals, ...mechanism }, decoy: DECOY };
}

function writeFixtureReport(outDir) {
  writeFileSync(join(outDir, 'cell-report.md'), fixtureReport().markdown, 'utf8');
}

/**
 * One tape per cell, and the three shapes the layout reader has to survive, so the fixture proves the reader rather
 * than the fixture's own convenience:
 *
 *   C0  an old round's record: `xFirst: false` and no trace axis at all (`round-20261004-0233` is written this way)
 *   C1  an old round's record with the question in front: `xFirst: true`, a layout this build cannot produce
 *   C2  a current record: `tracePlacement` by name and **no question field at all**, which is the shape every round
 *       writes now, and the shape the arm has to be read from
 */
function writeFixtureRun(root, { dsh, cells }) {
  const layouts = {
    C0: { xFirst: false },
    C1: { xFirst: true },
    C2: { tracePlacement: 'trace-append' },
  };
  for (const cell of cells) {
    const dir = join(root, 'home', cell, '.s1cap');
    mkdirSync(dir, { recursive: true });
    const wiring = cell === 'C2'
      ? { schema: 0, kind: 'wiring', s1: { provider: 'laya-serve', mode: 'local', baseUrl: 'http://127.0.0.1:8008' }, relevance: true, ...layouts[cell], tas: { on: true } }
      : { schema: 0, kind: 'wiring', s1: 'none', relevance: false, ...layouts[cell], tas: { on: false } };
    writeFileSync(join(dir, 'tape.jsonl'), `${JSON.stringify(wiring)}\n`, 'utf8');
  }
  if (dsh !== null) writeFileSync(join(root, 'manifest.json'), `${JSON.stringify({ _run: root, _dsh: dsh }, null, 1)}\n`, 'utf8');
}

const RELEASE_FIXTURE = {
  version: '0.2.0-rc.2',
  executable: 'C:\\Users\\lfkex\\AppData\\Roaming\\npm\\dsh.cmd',
  command: 'dsh --version',
  probedAt: '2026-10-01T09:35:32.648Z',
  profileSource: 'profile.default',
  plugin: { name: 'dsh-s1cap', version: '0.1.0', declaredDshReleases: { '0.1.7-rc.2': 'supported' }, peerDependencies: null },
  model: { provider: 'deepseek-account', model: 'deepseek-flash' },
};

function runSelfTest() {
  const root = mkdtempSync(join(tmpdir(), 's1cap-cell-figure-selftest-'));
  let failures = 0;
  const check = (fn, what) => {
    try {
      fn();
      process.stdout.write(`  ok   ${what}\n`);
    } catch (err) {
      failures += 1;
      process.stdout.write(`  FAIL ${what}\n       ${err.message}\n`);
    }
  };

  try {
    process.stdout.write(`cell-figure --self-test: synthetic inputs at ${root}\n`);

    const withRun = join(root, 'with-release');
    writeFixtureRun(withRun, { dsh: RELEASE_FIXTURE, cells: FIXTURE_CELLS });
    writeFixtureCharts(join(withRun, 'report'));
    writeFixtureReport(join(withRun, 'report'));

    const withoutRun = join(root, 'without-release');
    writeFixtureRun(withoutRun, { dsh: null, cells: FIXTURE_CELLS });
    writeFixtureCharts(join(withoutRun, 'report'));
    writeFixtureReport(join(withoutRun, 'report'));

    const labelOf = new Map();

    // --- a round WITH a release record --------------------------------------------------------
    let withFig = null;
    check(() => {
      withFig = composeFigure({ run: withRun, cells: FIXTURE_CELLS, outDir: join(withRun, 'report'), labelOf, headerHeight: 900 });
      assertEqual(withFig.release,
        'dsh 0.2.0-rc.2 (C:\\Users\\lfkex\\AppData\\Roaming\\npm\\dsh.cmd, provisioned 2026-10-01T09:35:32.648Z)'
        + ' | NOT declared supported by dsh-s1cap (declares 0.1.7-rc.2)', 'release clause');
      for (const [name, text] of [['summary.svg', withFig.svg], ['summary.html', withFig.html]]) {
        assertTrue(text.includes('dsh 0.2.0-rc.2'), `${name} names the release`);
        assertTrue(text.includes('NOT declared supported by dsh-s1cap (declares 0.1.7-rc.2)'), `${name} carries the support warning`);
        assertTrue(!text.includes(UNKNOWN_RELEASE), `${name} must not claim the record is missing`);
      }
      assertTrue(withFig.svg.startsWith('<!-- generated by scripts/cell-figure.mjs'), 'the svg carries its banner');
    }, 'a round WITH a release record names it in the figure, and does not claim it is missing');

    check(() => {
      for (const name of ['summary.svg', 'summary.html']) {
        const text = readFileSync(join(withRun, 'report', name), 'utf8');
        assertTrue(text.includes('dsh 0.2.0-rc.2'), `${name} on disk names the release`);
      }
    }, 'both deliverables are written to disk and carry the release');

    // --- a round WITHOUT one ------------------------------------------------------------------
    let withoutFig = null;
    check(() => {
      withoutFig = composeFigure({ run: withoutRun, cells: FIXTURE_CELLS, outDir: join(withoutRun, 'report'), labelOf, headerHeight: 900 });
      assertEqual(withoutFig.release, UNKNOWN_RELEASE, 'the missing record states the harness sentence');
      for (const [name, text] of [['summary.svg', withFig && withoutFig.svg], ['summary.html', withoutFig.html]]) {
        assertTrue(text.includes(UNKNOWN_RELEASE), `${name} states the missing record verbatim`);
      }
      assertTrue(!withoutFig.svg.includes('dsh 0.2.0-rc.2'), 'no release is invented');
      assertTrue(!/= ""/.test(withoutFig.header), 'the release is never an empty string');
    }, 'a round WITHOUT a release record states the fact in the harness wording, never a blank and never a guess');

    check(() => {
      for (const name of ['summary.svg', 'summary.html']) {
        const text = readFileSync(join(withoutRun, 'report', name), 'utf8');
        assertTrue(text.includes(UNKNOWN_RELEASE), `${name} on disk states the missing record`);
      }
    }, 'the missing-record wording reaches both files on disk');

    // --- everything else the figure promised, unchanged ----------------------------------------
    // --- the layout: both spellings, and the paper's arms and only those ------------------------
    check(() => {
      // The old round's spelling (`round-20261004-0233` and everything before 2026-10-05) is read for what it was -
      // the question's position - in a record that states no trace axis at all.
      assertEqual(layoutAxes({ xFirst: false }).legacyXFirst, false, 'legacy xFirst false is read as the question last');
      assertEqual(layoutAxes({ xFirst: true }).legacyXFirst, true, 'legacy xFirst true is read as the question in front');
      assertEqual(layoutAxes({ xFirst: true }).tracePlacement, null, 'a legacy record states no trace axis');
      assertEqual(layoutAxes({}).tracePlacement, null, 'a record with no layout key is not defaulted');
      assertEqual(layoutAxes({}).legacyXFirst, null, 'and states no question position either');
      // A current record: the axis by name and no question field to read, which is the shape every round writes now.
      assertEqual(layoutAxes({ tracePlacement: 'trace-as-state' }).tracePlacement, 'trace-as-state', 'the arm is read by name');
      assertEqual(layoutAxes({ tracePlacement: 'trace-append' }).legacyXFirst, null, 'a current record states no question position');
      assertEqual(layoutAxes({ tracePlacement: 'sideways' }).tracePlacement, null, 'a value the policy does not have resolves to nothing');
      // The arm follows from the trace axis alone, and the deleted question field is not read even if a hand-written
      // tape still carries it.
      assertEqual(paperArm(layoutAxes({ tracePlacement: 'trace-as-state' })), 'Trace as State [T, x, q]', 'Trace as State');
      assertEqual(paperArm(layoutAxes({ tracePlacement: 'trace-append' })), 'Trace Append [x, T, q]', 'Trace Append');
      assertEqual(paperArm(layoutAxes({ tracePlacement: 'trace-as-state', questionPlacement: 'first' })), 'Trace as State [T, x, q]', 'the deleted question field is not read');
      assertEqual(paperArm(layoutAxes({ tracePlacement: 'trace-append', xFirst: true })), 'Trace Append [x, T, q]', 'the recorded axis wins over the retired boolean');
      // A record with no trace axis identifies no arm: a pre-rename round never wrote one, and `xFirst: true` asked
      // for a layout this build cannot produce, so it is no paper arm rather than one of the paper's.
      assertEqual(paperArm(layoutAxes({ xFirst: false })), 'not identifiable (no trace axis recorded)', 'a legacy question-last record names no arm');
      assertEqual(paperArm(layoutAxes({ xFirst: true })), XFIRST_TRUE_NOT_AN_ARM, 'xFirst true is no paper arm');
      assertEqual(paperArm(layoutAxes({})), NOT_RECORDED, 'a record with no layout key says so');
    }, 'the layout is read under both spellings, and the arm follows from the trace axis alone');

    check(() => {
      // The same three cases as rendered, so the table cannot print an arm it did not read: C0 is the old record with
      // no trace axis, C1 the old record's question-in-front layout, C2 the current record of the Trace Append arm.
      const svg = withFig.svg;
      assertTrue(svg.includes('<th>placement</th>'), 'the one placement column carries the arm');
      assertTrue(!svg.includes('question placement') && !svg.includes('<th>paper arm</th>'), 'the separate question and arm columns are gone');
      assertTrue(!svg.includes('x-first'), 'the single x-first column is gone');
      assertTrue(svg.includes('not identifiable (no trace axis recorded)'), 'C0 (legacy, xFirst false) shows no arm rather than a default one');
      assertTrue(svg.includes('not a paper arm (pre-rename'), 'C1 (legacy, xFirst true) is named as no paper arm');
      assertTrue(svg.includes('Trace Append [x, T, q]'), 'C2 (current, no question field) is named as the Trace Append arm');
      assertTrue(svg.includes('xFirst'), 'the reading note says how a pre-rename round spells the layout');
    }, 'the figure names the arm from the trace axis, and never a default or an invented arm for a record that states none');

    check(() => {
      assertTrue(withFig.svg.includes('C0') && withFig.svg.includes('C1') && withFig.svg.includes('C2'), 'all three cells');
      assertTrue(withFig.svg.includes('none (provider: none)'), 'the lane-absent cells say so');
      assertTrue(withFig.svg.includes('laya-serve at http://127.0.0.1:8008'), 'the live lane names its backend');
      assertEqual(withFig.metrics.length, WANTED.length, 'every wanted metric is carried');
      assertTrue(withFig.svg.includes('TIME') && withFig.svg.includes('COST') && withFig.svg.includes('DIAGNOSTICS'), 'metric groups');
      assertTrue(withFig.svg.includes('snapshot 2026-01-01T00:00:00.000Z'), 'the snapshot is carried');
      assertTrue(withFig.svg.includes('step/start&rarr;step/end'), 'the reading note is carried');
      assertEqual(withFig.charts.length, 3, 'three charts are embedded');
    }, 'the composition still carries every cell, metric, group and chart it carried before');

    // --- the general one: every wanted metric must resolve to the report's own cell total ---------
    check(() => {
      const { markdown, expected } = fixtureReport();
      const rows = rowsOf(markdown, FIXTURE_CELLS.length);

      // The fixture must actually contain the collision it guards against, or it proves nothing. The
      // picker as it was before the fix is reproduced here - a pure prefix scan over every table, no
      // exact key first, no section filtering - and under it `System-1 calls` must land on the decoy.
      // That is the defect this fixture exists for, and `pickRow` must not repeat it.
      const legacyRowsOf = (md) => {
        const out = new Map();
        for (const line of md.split(/\r?\n/)) {
          if (!line.startsWith('|') || line.includes('---')) continue;
          const parts = line.split('|').slice(1, -1).map((s) => s.trim());
          if (parts.length !== FIXTURE_CELLS.length + 1 && parts.length !== FIXTURE_CELLS.length + 2) continue;
          const key = parts[0].replaceAll('*', '').replace(/\s+/g, ' ').trim();
          if (!out.has(key)) out.set(key, { unit: '', values: parts.slice(-FIXTURE_CELLS.length) });
        }
        return out;
      };
      const legacyRows = legacyRowsOf(markdown);
      const legacyPrefixScan = (want) => [...legacyRows.entries()].find(([key]) => key.startsWith(want));
      assertEqual(legacyPrefixScan('System-1 calls')[0], 'System-1 calls after the last turn/end',
        'the fixture decoy must be the System-1 tail row that caused the defect');
      assertEqual(legacyPrefixScan('System-1 calls')[1].values.join(' | '), DECOY,
        'the fixture must reproduce the collision: the old prefix scan must land on the decoy');
      // and the exact-first picker must beat the same decoy, which is the whole fix
      assertEqual(pickRow(rows, 'System-1 calls')[1].values.join(' | '), expected['System-1 calls'],
        'the fixed picker must land on the total, not the decoy');

      // ...and the picker under test must not, for any wanted metric, by label or by value.
      // 18 since 2026-10-05: the coverage row split into the floor and the secondary reading, and the figure
      // carries both because a reader who sees only one of them cannot tell which question it answers.
      assertEqual(WANTED.length, 18, 'the wanted list still has 18 metrics');
      for (const [want] of WANTED) {
        const hit = pickRow(rows, want);
        assertTrue(hit !== null, `"${want}" must resolve`);
        const label = hit[0];
        const values = hit[1].values.join(' | ');
        assertTrue(Object.hasOwn(expected, label), `"${want}" resolved to "${label}", which is not the row carrying its total`);
        assertEqual(values, expected[label], `"${want}" (picked as "${label}") values`);
        assertTrue(values !== DECOY, `"${want}" resolved to a decoy row`);
        assertTrue(!/completed|session store|sum of buckets|turn\/end reason/.test(label), `"${want}" resolved to the neighbour "${label}"`);
      }

      // every wanted metric reached the figure, in order, with the total's values
      const fig = composeFigure({ run: withRun, cells: FIXTURE_CELLS, outDir: join(withRun, 'report'), labelOf, headerHeight: 900 });
      assertEqual(fig.metrics.length, WANTED.length, 'the figure carries every wanted metric');
      for (const [i, [want]] of WANTED.entries()) {
        const label = pickRow(rows, want)[0];
        assertEqual(fig.metrics[i].name, label, `figure metric ${i} ("${want}") label`);
        assertEqual(fig.metrics[i].values.join(' | '), expected[label], `figure metric ${i} ("${want}") values`);
      }
    }, 'every wanted metric resolves to the report row that carries its cell total, by label and by value');

    check(() => {
      // the fallback must refuse to guess: two prefix matches and no exact match is a loud failure
      const rows = rowsOf(`${fixtureReport().markdown}\n| step frame (step/start something else) | count | 999 | 999 | 999 |\n`, FIXTURE_CELLS.length);
      let threw = null;
      try {
        pickRow(rows, 'step frame (step/start');
      } catch (e) {
        threw = e;
      }
      assertTrue(threw !== null, 'an ambiguous prefix match must throw rather than pick one');
      assertTrue(/matches 2 rows/.test(threw.message), `the error must name the ambiguity, got: ${threw && threw.message}`);
      // and the exact match still wins even when a prefix neighbour is present
      assertEqual(pickRow(rows, 'turns')[1].values.join(' | '), fixtureReport().expected.turns, 'exact match beats a prefix neighbour');
    }, 'an ambiguous prefix fallback fails loudly instead of printing one of the candidates');

    check(() => {
      // the figure's own guard: a report missing a wanted row is an error, not an omission
      const broken = join(root, 'broken');
      mkdirSync(broken, { recursive: true });
      writeFixtureCharts(broken);
      writeFixtureRun(join(root, 'broken-run'), { dsh: RELEASE_FIXTURE, cells: FIXTURE_CELLS });
      writeFileSync(join(broken, 'cell-report.md'), '# S1CAP cell report\n\n- snapshot taken: x\n\n| metric | unit | C0 | C1 | C2 |\n| --- | --- | --- | --- | --- |\n| turns | count | 1 | 1 | 1 |\n', 'utf8');
      let threw = null;
      try {
        composeFigure({ run: join(root, 'broken-run'), cells: FIXTURE_CELLS, outDir: broken, labelOf, headerHeight: 900 });
      } catch (e) {
        threw = e;
      }
      assertTrue(threw !== null, 'a report missing a metric row must throw');
      assertTrue(/has no "steps" row/.test(threw.message), `the error names the missing row, got: ${threw && threw.message}`);
    }, 'a report missing a wanted metric row is still an error, not a silent omission');

    process.stdout.write(`cell-figure --self-test: ${failures === 0 ? 'PASS' : `FAIL (${failures})`}\n`);
  } catch (err) {
    failures += 1;
    process.stdout.write(`cell-figure --self-test: FAIL\n  ${err.stack}\n`);
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  process.exit(failures === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

let opts;
try {
  opts = parseArgv(process.argv.slice(2));
} catch (err) {
  console.error(`cell-figure: ${err.message}`);
  process.exit(2);
}
if (opts.selfTest) runSelfTest();

const run = resolve(opts.run);
const cells = opts.cells.length > 0 ? opts.cells : ['C0', 'C1', 'C2'];
const outDir = opts.out ? resolve(opts.out) : join(run, 'report');
const labelOf = new Map(
  (opts.label ?? '')
    .split(',')
    .map((pair) => pair.split('=').map((s) => s.trim()))
    .filter((pair) => pair.length === 2),
);

const figure = composeFigure({ run, cells, outDir, labelOf, headerHeight: opts.headerHeight });
console.log(`cell-figure: wrote ${join(outDir, 'summary.svg')} and summary.html`);
console.log(`  ${cells.length} cell(s), ${figure.metrics.length} metric(s), ${figure.charts.length} chart(s)`);
console.log(`  ${figure.release}`);
console.log(`  summary.html width ${figure.pageWidth}px, height is content-driven (render it to measure)`);
console.log(`  summary.svg assumes a ${figure.headerHeight}px header box; if the header clips there, raise --header-height`);
