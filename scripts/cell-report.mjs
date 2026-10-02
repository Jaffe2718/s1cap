#!/usr/bin/env node
/**
 * Cell report for a finished S1CAP run.
 *
 * Prints, per cell, the round owner's metrics - time, cost, completion - broken down by turn and by
 * step, and emits self-contained SVG comparison charts (one per metric group). Zero dependencies,
 * no network: only `node:` builtins.
 *
 * Usage:
 *   node scripts/cell-report.mjs --run <dir> --cells <names> [--label old=new,...] [--out <dir>] [--format md|csv|svg|all]
 *   node scripts/cell-report.mjs --self-test
 *
 * ---------------------------------------------------------------------------------------------
 * WHERE THE NUMBERS COME FROM
 *
 * Three sources per cell. All three are read; none is guessed, and a missing one is a hard error
 * rather than a row of zeros - a cell that produced no evidence is not a cell that scored zero.
 *
 *   1. <run>/evidence/<cell>/control.jsonl   - the plugin's control plane, one JSON object per line:
 *        type=assembly          one per step; emitted before the step's request is assembled
 *        type=context_delivery  one per step; `delivered`/`reason` say what the plugin injected
 *        type=s1_call           one per System-1 request, carrying questions/inputTokens/outputTokens/
 *                               ms/ok, plus `error` when the backend refused the call
 *      Records carry `ts` (epoch ms) but no turn/step, so they are attributed by timestamp - see
 *      `attributeByTime` below, which is deliberately explicit about what cannot be attributed.
 *
 *   2. <run>/home/<cell>/sessions/** /session.v4.jsonl.zstd - the harness's own session store.
 *      It is an append-only file with one zstd frame per write, so it needs the multi-frame reader
 *      carried below. It supplies turns/steps, per-step token usage and tool-call durations.
 *
 *   3. <run>/home/<cell>/.s1cap/rg/*.json - the association-graph snapshot: scoredPairs/judgedPairs
 *      and the edge list. Derives System-1 *coverage* = judgedPairs / scoredPairs, which is reported
 *      beside every System-1 column: coverage is what tells a reader whether System-1 actually
 *      governed the cell or whether its calls were refused.
 *
 * TWO COUNTING TRAPS, both handled explicitly below:
 *   (a) `user/message` includes records the harness injects at session start (`Current runtime
 *       context...`, the `<system-reminder>` skill catalog) and, in the TAS/recall cells, records the
 *       plugin itself injects (source.kind = 'system-prompt'). Only source.kind === 'user' is a human
 *       message; a naive count overstates what a human sent. The report prints the breakdown.
 *   (b) The association graph keeps being maintained by a background task after the last turn ends
 *       (System-1 calls continue for minutes), so every figure here is a snapshot of the artifacts
 *       *as read at run time*. The snapshot instant is printed, and System-1 calls that land after the
 *       last `turn/end` are reported as their own row, never folded into a turn.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';

// ---------------------------------------------------------------------------------------------
// 1. Multi-frame zstd reader (carried from `.s1cap-ablation/session-store.mjs`, same reasoning)
//
// The store is appended to, one zstd frame per write, and Node's `zstdDecompressSync` stops at the
// end of the *first* frame - which is why a naive read of a 100 KB store returns the 289-byte
// session header and nothing else. So walk the concatenated frames explicitly: parse each frame
// header/block chain to find the frame's compressed size, decode that slice on its own, concatenate
// the text. `--self-test` asserts this difference rather than trusting the comment.
// ---------------------------------------------------------------------------------------------

const ZSTD_MAGIC = 0xfd2fb528;
const SKIPPABLE_MIN = 0x184d2a50;
const SKIPPABLE_MAX = 0x184d2a5f;

/** Byte length of the compressed frame starting at `off`. */
function frameSize(buf, off) {
  if (buf.readUInt32LE(off) !== ZSTD_MAGIC) throw new Error(`no zstd magic at ${off}`);
  let p = off + 4;
  const fhd = buf[p];
  p += 1;
  const fcsFlag = fhd >> 6;
  const singleSegment = (fhd >> 5) & 1;
  const hasChecksum = (fhd >> 2) & 1;
  const dictFlag = fhd & 3;
  if (!singleSegment) p += 1; // window descriptor
  p += [0, 1, 2, 4][dictFlag]; // dictionary id
  p += fcsFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][fcsFlag]; // frame content size
  for (;;) {
    const header = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
    p += 3;
    const last = header & 1;
    const blockType = (header >> 1) & 3;
    const blockSize = header >> 3;
    if (blockType === 1) p += 1; // RLE: one byte payload
    else p += blockSize; // raw or compressed
    if (last) break;
  }
  if (hasChecksum) p += 4;
  return p - off;
}

/** Decompress every frame in the file and return the concatenated UTF-8 text. */
function readSessionStore(path) {
  const buf = readFileSync(path);
  let off = 0;
  const parts = [];
  while (off + 4 <= buf.length) {
    const magic = buf.readUInt32LE(off);
    if (magic >= SKIPPABLE_MIN && magic <= SKIPPABLE_MAX) {
      const size = buf.readUInt32LE(off + 4);
      off += 8 + size;
      continue;
    }
    if (magic !== ZSTD_MAGIC) {
      // a trailing partial frame (the process was killed mid-append) is the only expected case
      break;
    }
    const size = frameSize(buf, off);
    parts.push(zstdDecompressSync(buf.subarray(off, off + size)).toString('utf8'));
    off += size;
  }
  return { text: parts.join(''), frames: parts.length, bytes: buf.length, consumed: off };
}

/** Parse the concatenated text as JSONL, skipping unparseable lines. */
function sessionEvents(path) {
  const { text, frames, bytes, consumed } = readSessionStore(path);
  const events = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      /* an unparseable line is reported through the frame/byte counts, not thrown */
    }
  }
  return { events, frames, bytes, consumed };
}

// ---------------------------------------------------------------------------------------------
// 2. Small filesystem / formatting helpers
// ---------------------------------------------------------------------------------------------

function fail(message) {
  const err = new Error(message);
  err.isReportError = true;
  throw err;
}

function walkFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) out.push(p);
    }
  }
  return out;
}

function readJsonl(path) {
  const records = [];
  let bad = 0;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      bad += 1;
    }
  }
  return { records, bad };
}

/** Thousands-grouped integer, implementation-independent (no ICU locale surprises). */
function fmtInt(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '-';
  const neg = n < 0;
  const s = String(Math.round(Math.abs(n)));
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ',';
    out += s[i];
  }
  return (neg ? '-' : '') + out;
}

function fmtPct(x, digits = 1) {
  if (x === null || x === undefined || Number.isNaN(x)) return '-';
  return `${(x * 100).toFixed(digits)}%`;
}

function fmtSec(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '-';
  return `${(ms / 1000).toFixed(1)}s`;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------------------------
// 2b. The round's software identity
//
// The project never recorded which DSH release produced a round, and the machine has since moved
// past the one release the plugin declares as supported. A number quoted without its release is a
// number nobody can place, so the release and the model are read from `<run>/manifest.json`'s `_dsh`
// block and carried on the report header and on every chart.
//
// Read, never inferred. A round that predates the record is not a blank and not a guess: it prints
// the same sentence the harness prints, so the wrapper's line, the report and the charts agree.
// ---------------------------------------------------------------------------------------------

const UNKNOWN_RELEASE =
  'UNKNOWN RELEASE - this round predates the release record; quote that fact with any number from it.';

/**
 * Read `<run>/manifest.json` `_dsh`.
 *
 * Returns `{ present: false, reason }` for every way the record can be absent - no manifest at all
 * (a round provisioned before the manifest existed), an unparseable manifest, a manifest with no
 * `_dsh`, or a `_dsh` with no version. The harness's own `readRoundRecord` treats the last of those
 * as "no record" and the first as an error; here they are all the same stated fact, because a report
 * must still be able to describe a historical round rather than refuse to run on one.
 */
function readDshRecord(runDir) {
  const path = join(runDir, 'manifest.json');
  if (!existsSync(path)) return { present: false, reason: 'no manifest.json', path };
  let doc;
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return { present: false, reason: `manifest.json is not valid JSON (${err.message})`, path };
  }
  const d = doc ? doc._dsh : null;
  if (!d || typeof d !== 'object') return { present: false, reason: 'manifest.json records no _dsh block', path };
  if (typeof d.version !== 'string' || d.version === '') {
    return { present: false, reason: 'manifest.json records no _dsh.version', path };
  }
  return {
    present: true,
    path,
    version: d.version,
    executable: typeof d.executable === 'string' && d.executable !== '' ? d.executable : null,
    command: typeof d.command === 'string' ? d.command : null,
    probedAt: typeof d.probedAt === 'string' && d.probedAt !== '' ? d.probedAt : null,
    provider: d.model && typeof d.model.provider === 'string' ? d.model.provider : null,
    model: d.model && typeof d.model.model === 'string' ? d.model.model : null,
    plugin: d.plugin && typeof d.plugin === 'object' ? d.plugin : null,
  };
}

/**
 * The identity as the harness words it, in its own order:
 *   `dsh <v> (<exe>, provisioned <at>) [| model <p>/<m>] [| NOT declared supported by <plugin> (declares …)]`
 * The report splits this at the ` | ` separators into the release row and the model row; concatenating
 * those rows back with ` | ` reproduces this sentence exactly, which the self-test asserts.
 */
function dshReleaseParts(dsh) {
  if (!dsh.present) return null;
  const parts = [`dsh ${dsh.version} (${dsh.executable ?? 'executable not recorded'}, provisioned ${dsh.probedAt ?? 'time not recorded'})`];
  const declared = dsh.plugin && dsh.plugin.declaredDshReleases;
  if (declared && typeof declared === 'object' && !Object.hasOwn(declared, dsh.version)) {
    parts.push(`NOT declared supported by ${dsh.plugin.name ?? 'the plugin'} (declares ${Object.keys(declared).join(', ')})`);
  }
  return parts;
}

/** The model row, only when the record carries one. Never guessed. */
function dshModelLine(dsh) {
  if (!dsh.present) return null;
  if (dsh.provider === null && dsh.model === null) return null;
  return `${dsh.provider ?? 'provider not recorded'}/${dsh.model ?? 'model not recorded'}`;
}

/** The one-line form, byte-for-byte the harness's, used where only one line fits. */
function dshHarnessLine(dsh) {
  if (!dsh.present) return UNKNOWN_RELEASE;
  const release = dshReleaseParts(dsh);
  const model = dshModelLine(dsh);
  const head = release[0] + (model ? ` | model ${model}` : '');
  return release.length > 1 ? `${head} | ${release.slice(1).join(' | ')}` : head;
}

/**
 * The same identity cut at its ` | ` clause boundaries, for a caption that wraps.
 *
 * Handed to the wrapper as one string, the sentence broke *inside* a clause and continued on a line
 * beginning with a bare `| `. Each clause is short enough to fit a caption line on its own, so the
 * identity is passed as groups and the wrapper breaks only where the harness itself breaks.
 */
function dshCaptionGroups(dsh) {
  if (!dsh.present) return [UNKNOWN_RELEASE];
  const release = dshReleaseParts(dsh);
  const model = dshModelLine(dsh);
  return [
    release[0],
    [`model ${model ?? 'not recorded'}`, ...release.slice(1)].join(' | '),
  ];
}

// ---------------------------------------------------------------------------------------------
// 3. The metric specification - the single source of truth for every renderer
//
// One entry per quantity the owner specified. `scopes` says at which levels the quantity is
// meaningful (a cell-level `turns` count has no per-step meaning; `steps` has no per-step meaning
// either, because a step *is* the unit). `unit` drives both the printed unit and which SVG panel a
// metric lands in - two metrics with different units are never drawn on one axis.
// ---------------------------------------------------------------------------------------------

const METRICS = [
  // --- time -------------------------------------------------------------------------------
  { key: 'turns', group: 'time', unit: 'count', scopes: ['cell'], label: 'turns' },
  { key: 'steps', group: 'time', unit: 'count', scopes: ['cell', 'turn'], label: 'steps' },
  { key: 'llmCalls', group: 'time', unit: 'count', scopes: ['cell', 'turn', 'step'], label: 'LLM calls' },
  { key: 's1Calls', group: 'time', unit: 'count', scopes: ['cell', 'turn', 'step'], label: 'System-1 calls' },
  { key: 'toolCalls', group: 'time', unit: 'count', scopes: ['cell', 'turn', 'step'], label: 'other tool calls' },
  { key: 'llmMs', group: 'time', unit: 'ms', scopes: ['cell', 'turn', 'step'], label: 'LLM time' },
  { key: 's1Ms', group: 'time', unit: 'ms', scopes: ['cell', 'turn', 'step'], label: 'System-1 time' },
  { key: 'toolMs', group: 'time', unit: 'ms', scopes: ['cell', 'turn', 'step'], label: 'other tool time' },
  // `stepFrameMs` and `turnFrameMs` are not extra metrics: they are the frames the three duration
  // metrics above are measured inside, printed so the reader can see the residual instead of
  // assuming LLM + System-1 + tool accounts for the whole step.
  { key: 'stepFrameMs', group: 'time', unit: 'ms', scopes: ['cell', 'turn'], label: 'step frame (step/start→step/end)' },
  { key: 'turnFrameMs', group: 'time', unit: 'ms', scopes: ['cell'], label: 'turn frame (turn/start→turn/end)' },
  { key: 'idleMs', group: 'time', unit: 'ms', scopes: ['cell', 'turn'], label: 'between-step idle (turn frame − step frame)' },
  // --- cost -------------------------------------------------------------------------------
  // Cache-hit rate is deliberately NOT here. It is a mechanism diagnostic (see renderDiagnostics):
  // a high hit rate is not a low cost, and putting it in a cost table invites reading it as one.
  { key: 'hitTokens', group: 'cost', unit: 'token', scopes: ['cell', 'turn', 'step'], label: 'cached-hit input tokens' },
  { key: 'missTokens', group: 'cost', unit: 'token', scopes: ['cell', 'turn', 'step'], label: 'uncached input tokens' },
  { key: 'outTokens', group: 'cost', unit: 'token', scopes: ['cell', 'turn', 'step'], label: 'output tokens' },
  // F19: two rows, not one sum. `FORMULAS.md` prices the lane on **input only** (`C_S1 = p_s1 Σ n_in^S1`, "Jev
  // output is free"), so a single `Σ input + output` column mixes the quantity the cost model prices with one it
  // prices at zero. In the recorded round `outputTokens` is 0 on every record, which is exactly why the mixture
  // was invisible; in a healthy round it would not be. The input row is the priced quantity.
  { key: 's1InputTokens', group: 'cost', unit: 'token', scopes: ['cell', 'turn', 'step'], label: 'System-1 lane input tokens (the priced quantity)' },
  { key: 's1OutputTokens', group: 'cost', unit: 'token', scopes: ['cell', 'turn', 'step'], label: 'System-1 lane output tokens (free under the cost model)' },
  // --- completion -------------------------------------------------------------------------
  // One column, constant in this project's runs: the stimulus is a single short task and every cell
  // finishes it. It is reported as a cell-level count of completed turns (and the wall-clock cost of
  // the completion), never per-turn - a per-turn completion table would be 3 rows of the same value.
  { key: 'turnsCompleted', group: 'completion', unit: 'count', scopes: ['cell'], label: 'turns completed' },
  { key: 'completionMs', group: 'completion', unit: 'ms', scopes: ['cell'], label: 'time to completion' },
];

const UNIT_LABEL = {
  count: 'count',
  ms: 'milliseconds',
  token: 'tokens',
  ratio: 'percent',
};

/**
 * Per-unit axis handling. `toAxis` converts a raw metric value into the unit the axis is drawn in,
 * `fmt` renders a *raw* value (the number printed on a bar) and `fmtAxis` renders an *axis* value
 * (a tick label). They are separate on purpose: `percent` multiplies by 100 on the way to the axis,
 * so a tick formatter that also multiplied would print 2500% for a coverage of 0.25 - which is what
 * the first version of this chart did.
 */
const SVG_PANEL_UNIT = {
  count: { axis: 'count', toAxis: (v) => v, fmt: fmtInt, fmtAxis: fmtInt },
  ms: {
    axis: 'seconds',
    toAxis: (v) => v / 1000,
    fmt: fmtSec,
    fmtAxis: (v) => (Math.abs(v) >= 100 || Number.isInteger(v) ? `${fmtInt(v)}s` : `${v.toFixed(1)}s`),
  },
  token: { axis: 'tokens', toAxis: (v) => v, fmt: fmtInt, fmtAxis: fmtInt },
  ratio: {
    axis: 'percent',
    toAxis: (v) => v * 100,
    fmt: (v) => fmtPct(v),
    fmtAxis: (v) => (Number.isInteger(v) ? `${v}%` : `${v.toFixed(1)}%`),
  },
};

const CELL_COLOURS = [
  '#2f6fb2', '#c2703a', '#4f9d6b', '#8c5fb0', '#b8453f',
  '#5b6b7c', '#a8923a', '#3f8f9e', '#7a6bb5', '#96562f',
];

// ---------------------------------------------------------------------------------------------
// 4. Loading one cell
// ---------------------------------------------------------------------------------------------

/**
 * Pick the cell's real session store out of `sessions/**`.
 *
 * A run directory also contains empty 300-byte stub stores (a session that was opened and never
 * used); every one of them parses fine and reports zero turns, so silently taking "the" store would
 * report a cell as empty. The primary store is the one with the most `turn/start` events, and any
 * other non-empty store is reported as a warning rather than merged - merging two sessions would
 * double-count nothing today but would quietly invent a combined cell tomorrow.
 */
function findPrimarySession(cellDir, cell) {
  const sessionsRoot = join(cellDir, 'sessions');
  if (!existsSync(sessionsRoot)) {
    fail(`cell ${cell}: no sessions directory at ${sessionsRoot} - the cell's evidence is absent`);
  }
  const stores = walkFiles(sessionsRoot).filter((p) => basename(p) === 'session.v4.jsonl.zstd');
  if (stores.length === 0) {
    fail(`cell ${cell}: no session.v4.jsonl.zstd under ${sessionsRoot} - the cell's evidence is absent`);
  }
  const loaded = stores.map((path) => {
    const { events, frames, bytes, consumed } = sessionEvents(path);
    return { path, events, frames, bytes, consumed, turns: events.filter((e) => e.type === 'turn/start').length };
  });
  loaded.sort((a, b) => b.turns - a.turns || b.bytes - a.bytes);
  const primary = loaded[0];
  if (primary.turns === 0) {
    fail(`cell ${cell}: ${primary.path} contains no turn/start event - the cell never ran`);
  }
  const ignored = loaded.slice(1).filter((s) => s.turns > 0);
  return { primary, ignored, storeCount: loaded.length };
}

/**
 * Pick the association-graph snapshot.
 *
 * The rg directory holds one snapshot per session id. The one belonging to the primary session is
 * authoritative; if it is absent the newest file is used and a warning is emitted, because a
 * snapshot from another session would give a coverage number for a different graph.
 */
function findRgSnapshot(cellDir, cell, sessionId) {
  const rgDir = join(cellDir, '.s1cap', 'rg');
  if (!existsSync(rgDir)) {
    fail(`cell ${cell}: no association-graph snapshot directory at ${rgDir} - coverage cannot be derived`);
  }
  const files = walkFiles(rgDir).filter((p) => p.toLowerCase().endsWith('.json'));
  if (files.length === 0) {
    fail(`cell ${cell}: ${rgDir} holds no *.json association-graph snapshot`);
  }
  const loaded = files.map((path) => {
    let doc;
    try {
      doc = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      fail(`cell ${cell}: association-graph snapshot ${path} is not valid JSON (${err.message})`);
    }
    return { path, doc };
  });
  const exact = loaded.filter((s) => s.doc.sessionId === sessionId);
  if (exact.length === 1) return { snapshot: exact[0], warned: null };
  if (exact.length > 1) {
    exact.sort((a, b) => (b.doc.judgedPairs || 0) - (a.doc.judgedPairs || 0));
    return { snapshot: exact[0], warned: `cell ${cell}: ${exact.length} rg snapshots for ${sessionId}; used the largest` };
  }
  fail(
    `cell ${cell}: no association-graph snapshot for session ${sessionId} in ${rgDir} ` +
      `(found: ${loaded.map((s) => `${basename(s.path)}=${s.doc.sessionId || '?'}`).join(', ')})`,
  );
}

function loadCell(runDir, cell, labelMap) {
  const cellDir = join(runDir, 'home', cell);
  const controlPath = join(runDir, 'evidence', cell, 'control.jsonl');
  if (!existsSync(controlPath)) {
    fail(`cell ${cell}: no control plane at ${controlPath} - the cell's evidence is absent`);
  }
  if (!existsSync(cellDir)) {
    fail(`cell ${cell}: no home directory at ${cellDir} - the cell's evidence is absent`);
  }

  const warnings = [];
  const { records: control, bad: badControlLines } = readJsonl(controlPath);
  if (control.length === 0) fail(`cell ${cell}: ${controlPath} is empty`);
  if (badControlLines > 0) warnings.push(`cell ${cell}: ${badControlLines} unparseable control.jsonl line(s) skipped`);

  const { primary, ignored, storeCount } = findPrimarySession(cellDir, cell);
  if (ignored.length > 0) {
    warnings.push(
      `cell ${cell}: ${ignored.length} further non-empty session store(s) ignored ` +
        `(${ignored.map((s) => basename(dirname(s.path))).join(', ')})`,
    );
  }
  if (primary.consumed !== primary.bytes) {
    warnings.push(
      `cell ${cell}: session store has ${primary.bytes - primary.consumed} trailing byte(s) after the last ` +
        'complete zstd frame (killed mid-append?); they are excluded',
    );
  }
  const sessionId = (primary.events.find((e) => e.type === 'session') || {}).id || basename(dirname(primary.path));

  const { snapshot, warned } = findRgSnapshot(cellDir, cell, sessionId);
  if (warned) warnings.push(warned);

  const lane = findLaneEvidence(cellDir, cell, control);

  return {
    name: cell,
    label: labelMap.get(cell) || cell,
    display: labelMap.has(cell) ? `${labelMap.get(cell)} (${cell})` : cell,
    controlPath,
    sessionPath: primary.path,
    sessionId,
    sessionFrames: primary.frames,
    sessionBytes: primary.bytes,
    storeCount,
    rgPath: snapshot.path,
    lane,
    // The mtimes are the honest answer to "when was this snapshot taken": the report reads finished
    // artifacts, and a file's own mtime is the only timestamp the artifacts carry about themselves.
    mtimes: {
      control: mtimeOf(controlPath),
      session: mtimeOf(primary.path),
      rg: mtimeOf(snapshot.path),
    },
    control,
    events: primary.events,
    rg: snapshot.doc,
    warnings,
  };
}

function mtimeOf(path) {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return null;
  }
}

/**
 * Was a System-1 lane configured for this cell at all?
 *
 * This is the difference between two readings that otherwise look identical in a table: a cell with
 * the lane switched off (`s1.provider: "none"`, the "Off" radio) has zero System-1 calls, zero
 * System-1 tokens and zero System-1 time *by construction*; a cell with a lane whose backend refused
 * every request has a real call count, a real failure split, and a coverage number. Printing `0` for
 * both, or a `0` coverage for both, would make "not configured" indistinguishable from "configured
 * and broken" - which is the single reading this report exists to prevent.
 *
 * There is a **third** reading, and until the audit it printed as the first (F3): a cell whose
 * configuration conflicted - `laya.enabled: true` beside `provider: "none"`, or a local provider with
 * neither `baseUrl` nor `pythonPath` - is demoted to `provider: "none"` by `buildBackend`
 * (`packages/dsh-plugin/src/index.ts`), so its wiring record says `s1: "none"` exactly as a control
 * arm's does. The distinguishing evidence is the *configured* provider beside the resolved one, which
 * the plugin now writes onto the same record (along with the conflict text). A `none` whose
 * `configuredProvider` names something else is a **demotion**, it is reported as one, and it must
 * never be read as "this cell had no lane by construction".
 *
 * The evidence, in order of authority (never inferred from the call count alone):
 *   1. `<home>/<cell>/.s1cap/tape.jsonl` `kind:"wiring"` - written once at activation, and its `s1`
 *      field is literally `'none'` when the resolved backend is the Off choice, or
 *      `{provider, mode, baseUrl}` when one is wired (dsh-plugin/src/index.ts). Its
 *      `configuredProvider`/`conflicts` pair is what separates a choice from a demotion; a record
 *      written before the audit has neither and is reported as "unknown", not as "no conflict".
 *   2. the same tape's `kind:"tuning-file"` `effective.provider`.
 *   3. `provider` on the cell's own `s1_call` records (the configured name, recorded even on refusals).
 *   4. nothing at all: with no provider evidence anywhere and no call records, the lane was absent -
 *      but that is an inference, and the report says so rather than presenting it as a configuration.
 */
function findLaneEvidence(cellDir, cell, control) {
  const tapePath = join(cellDir, '.s1cap', 'tape.jsonl');
  const record = {
    state: 'unknown', provider: null, mode: null, baseUrl: null, source: 'no provider evidence in the run directory',
    tapePath: null, configuredProvider: null, conflicts: [],
  };
  if (existsSync(tapePath)) {
    record.tapePath = tapePath;
    let lines = [];
    try {
      lines = readFileSync(tapePath, 'utf8').split('\n');
    } catch {
      lines = [];
    }
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      let o;
      try {
        o = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (o.kind === 'wiring' && o.s1 !== undefined) {
        // `configuredProvider`/`conflicts` are read on both shapes. A wiring record written before the audit has
        // neither, which stays "unknown" rather than becoming "no conflict": those are different statements.
        if (o.configuredProvider !== undefined) record.configuredProvider = String(o.configuredProvider);
        if (Array.isArray(o.conflicts)) record.conflicts = o.conflicts.map((c) => String(c));
        if (o.s1 === 'none') {
          record.state = 'none';
          record.provider = 'none';
          record.source = 'tape.jsonl wiring record: s1 = "none"';
        } else if (o.s1 && typeof o.s1 === 'object') {
          record.state = String(o.s1.provider) === 'none' || String(o.s1.mode) === 'none' ? 'none' : 'present';
          record.provider = o.s1.provider ?? null;
          record.mode = o.s1.mode ?? null;
          record.baseUrl = o.s1.baseUrl ?? null;
          record.source = `tape.jsonl wiring record: s1 = ${JSON.stringify(o.s1)}`;
        }
        // Was the `none` a choice or a demotion? A conflict makes `buildBackend` resolve
        // `{...config.s1, provider: 'none'}`, so the resolved provider is `none` while the configured one is not.
        // The two readings that follow are not interchangeable and the report must not merge them (F3).
        if (
          record.state === 'none' &&
          record.configuredProvider !== null &&
          record.configuredProvider !== 'none'
        ) {
          record.state = 'demoted';
          record.source =
            `tape.jsonl wiring record: configured s1.provider = ${JSON.stringify(record.configuredProvider)}, ` +
            `resolved s1 = "none"` +
            (record.conflicts.length > 0 ? `; ${record.conflicts.length} conflict(s)` : '; no conflict text recorded');
        }
        return record;
      }
      if (o.kind === 'tuning-file' && o.effective && o.effective.provider !== undefined && record.state === 'unknown') {
        record.provider = o.effective.provider;
        record.state = String(o.effective.provider) === 'none' ? 'none' : 'present';
        record.source = `tape.jsonl tuning-file record: effective.provider = ${JSON.stringify(o.effective.provider)}`;
      }
    }
    if (record.state !== 'unknown') return record;
  }
  const calls = control.filter((o) => o.type === 's1_call');
  if (calls.length > 0) {
    const provider = calls.find((c) => c.provider !== undefined)?.provider ?? null;
    record.state = String(provider) === 'none' ? 'none' : 'present';
    record.provider = provider;
    record.source = `control.jsonl s1_call.provider = ${JSON.stringify(provider)}`;
    return record;
  }
  if (!existsSync(tapePath)) {
    record.source = 'no tape.jsonl and no s1_call records: the lane was absent, inferred from the silence';
  } else {
    record.source = 'no wiring/tuning record and no s1_call records: the lane was absent, inferred from the silence';
  }
  return record;
}

// ---------------------------------------------------------------------------------------------
// 5. Aggregation
//
// Every quantity is accumulated into three scope objects with the same shape: the cell, each turn,
// each step. Renderers read those objects only, so a metric cannot be computed one way in the table
// and another way in the chart.
// ---------------------------------------------------------------------------------------------

function emptyScope() {
  return {
    turns: 0, steps: 0, llmCalls: 0, s1Calls: 0, toolCalls: 0,
    llmMs: 0, s1Ms: 0, toolMs: 0, stepFrameMs: 0, turnFrameMs: 0, idleMs: 0,
    hitTokens: 0, missTokens: 0, outTokens: 0, s1InputTokens: 0, s1OutputTokens: 0,
    s1Ok: 0, s1Refused: 0, s1Questions: 0,
    injections: 0, contextSteps: 0, assemblySteps: 0,
    turnsCompleted: 0, completionMs: 0,
    humanMessages: 0, injectedMessages: 0,
  };
}

const SUM_KEYS = [
  'turns', 'steps', 'llmCalls', 's1Calls', 'toolCalls',
  'llmMs', 's1Ms', 'toolMs', 'stepFrameMs', 'turnFrameMs', 'idleMs',
  'hitTokens', 'missTokens', 'outTokens', 's1InputTokens', 's1OutputTokens',
  's1Ok', 's1Refused', 's1Questions',
  'injections', 'contextSteps', 'assemblySteps',
  'turnsCompleted', 'completionMs', 'humanMessages', 'injectedMessages',
];

/**
 * Attribute a timestamped control-plane record to a turn or a step.
 *
 * `s1_call`, `assembly` and `context_delivery` records carry `ts` but no turn/step, so the only
 * available rule is containment in a step window, then containment in a turn window. That rule is
 * lossy by construction - association-graph upkeep runs on its own ~10 s tick, so a large share of
 * System-1 calls land *between* steps - and the loss is not uniform across cells. Reporting only the
 * attributed part would make two cells look comparable when they are not, so the caller must keep
 * the buckets separate and add them up:
 *
 *   'step'  ts inside [step/start, step/end]        -> attributed to that step (and its turn)
 *   'turn'  ts inside [turn/start, turn/end] only   -> 'between steps' bucket of that turn
 *   'idle'  ts between two turns                    -> belongs to no turn
 *   'tail'  ts after the last turn/end              -> asynchronous upkeep, no turn to belong to
 *   'pre'   ts before the first turn/start          -> reported, never silently dropped
 *
 * Returns { level, turn, step }.
 */
function attributeByTime(ts, steps, turns, lastTurnEnd) {
  for (const s of steps) {
    const end = s.t1 === null ? Infinity : s.t1;
    if (ts >= s.t0 && ts <= end) return { level: 'step', turn: s.turn, step: s.step };
  }
  for (const t of turns) {
    const end = t.t1 === null ? Infinity : t.t1;
    if (ts >= t.t0 && ts <= end) return { level: 'turn', turn: t.turn, step: null };
  }
  if (ts > lastTurnEnd) return { level: 'tail', turn: null, step: null };
  if (turns.length > 0 && ts < turns[0].t0) return { level: 'pre', turn: null, step: null };
  return { level: 'idle', turn: null, step: null };
}

function aggregate(cell) {
  const warnings = [];
  const events = cell.events;
  // The three attribution buckets that belong to no turn. They are per-cell locals: keeping them in
  // module state would let one cell's tail leak into the next cell's table.
  const tailScope = emptyScope();
  const preScope = emptyScope();
  const idleScope = emptyScope();

  const turns = [];
  const steps = [];
  let curTurn = null;
  let curStep = null;
  const toolIndex = new Map(); // callId -> { t0, stepKey }

  const stepKey = (turn, step) => `${turn}:${step}`;
  const stepMap = new Map();
  const turnMap = new Map();

  const ensureTurn = (turn, t0) => {
    if (!turnMap.has(turn)) {
      turnMap.set(turn, { ...emptyScope(), turn, t0, t1: null, stepKeys: [], gap: emptyScope(), tail: emptyScope(), pre: emptyScope() });
    }
    return turnMap.get(turn);
  };
  const ensureStep = (turn, step, t0) => {
    const k = stepKey(turn, step);
    if (!stepMap.has(k)) stepMap.set(k, { ...emptyScope(), turn, step, t0, t1: null, msgTime: null });
    return stepMap.get(k);
  };

  for (const e of events) {
    switch (e.type) {
      case 'turn/start': {
        curTurn = { turn: e.data.turn, t0: e.time, t1: null };
        turns.push(curTurn);
        const t = ensureTurn(e.data.turn, e.time);
        t.turns = 1;
        t.t0 = e.time;
        break;
      }
      case 'turn/end': {
        if (curTurn && curTurn.turn === e.data.turn) curTurn.t1 = e.time;
        const t = turnMap.get(e.data.turn);
        if (t) {
          t.t1 = e.time;
          t.turnFrameMs = e.time - t.t0;
          t.turnsCompleted = e.data.reason && e.data.reason.kind === 'completed' ? 1 : 0;
          t.completionState = (e.data.reason && e.data.reason.kind) || 'unknown';
        }
        break;
      }
      case 'step/start': {
        curStep = { turn: e.data.turn, step: e.data.step, t0: e.time, t1: null };
        steps.push(curStep);
        const s = ensureStep(e.data.turn, e.data.step, e.time);
        s.steps = 1;
        s.t0 = e.time;
        const t = ensureTurn(e.data.turn, e.time);
        t.stepKeys.push(stepKey(e.data.turn, e.data.step));
        break;
      }
      case 'step/end': {
        if (curStep && curStep.turn === e.data.turn && curStep.step === e.data.step) curStep.t1 = e.time;
        const s = stepMap.get(stepKey(e.data.turn, e.data.step));
        if (s) {
          s.t1 = e.time;
          s.stepFrameMs = e.time - s.t0;
        }
        break;
      }
      case 'assistant/message': {
        // One `assistant/message` per step: it is the provider round trip for that step. `data.turn`
        // and `data.step` are carried on the record itself, so token attribution needs no timestamp
        // guessing. `data.usage.inputTokens` is the *uncached* input count and
        // `data.usage.cacheReadTokens` the cached-hit count - using `totalTokens` for either would
        // double-count the other, which is why neither appears in the report.
        const s = ensureStep(e.data.turn, e.data.step, e.time);
        ensureTurn(e.data.turn, e.time);
        const u = e.data.usage || {};
        s.llmCalls += 1;
        s.msgTime = e.time;
        s.llmMs += e.time - s.t0;
        s.hitTokens += u.cacheReadTokens || 0;
        s.missTokens += u.inputTokens || 0;
        s.outTokens += u.outputTokens || 0;
        break;
      }
      case 'tool/call': {
        toolIndex.set(e.data.callId, { t0: e.time, turn: e.data.turn, step: e.data.step });
        break;
      }
      case 'tool/result': {
        const id = e.data.toolCallId || (e.data.message && e.data.message.toolCallId);
        const call = toolIndex.get(id);
        if (!call) {
          warnings.push(`tool/result without a matching tool/call (${id || 'no id'}); its duration is not counted`);
          break;
        }
        const s = ensureStep(e.data.turn, e.data.step, e.time);
        s.toolCalls += 1;
        s.toolMs += e.time - call.t0;
        break;
      }
      case 'user/message': {
        // Trap (a): only source.kind === 'user' is a human message.
        const t = ensureTurn(curTurn ? curTurn.turn : 1, e.time);
        if (e.data.source && e.data.source.kind === 'user') t.humanMessages += 1;
        else t.injectedMessages += 1;
        break;
      }
      default:
        break;
    }
  }

  const lastTurnEnd = turns.length > 0 && turns[turns.length - 1].t1 !== null
    ? turns[turns.length - 1].t1
    : (events.length > 0 ? events[events.length - 1].time : 0);

  // --- control plane ---------------------------------------------------------------------------
  const s1Records = cell.control.filter((o) => o.type === 's1_call');
  if (s1Records.length === 0) {
    warnings.push(`cell ${cell.name}: control.jsonl holds no s1_call record - the cell received no System-1 governance`);
  }
  const s1Errors = new Map();
  const bucketFor = (where) => {
    const b = where.level === 'step' ? stepMap.get(stepKey(where.turn, where.step))
      : where.level === 'turn' ? turnMap.get(where.turn).gap
        : where.level === 'tail' ? tailScope
          : where.level === 'idle' ? idleScope
            : preScope;
    if (!b) fail(`cell ${cell.name}: internal error - control-plane record at ${where.level} has no bucket`);
    return b;
  };
  for (const r of s1Records) {
    const bucket = bucketFor(attributeByTime(r.ts, steps, turns, lastTurnEnd));
    bucket.s1Calls += 1;
    bucket.s1Ms += r.ms || 0;
    bucket.s1InputTokens += r.inputTokens || 0;
    bucket.s1OutputTokens += r.outputTokens || 0;
    bucket.s1Questions += r.questions || 0;
    if (r.ok) bucket.s1Ok += 1;
    else {
      bucket.s1Refused += 1;
      const key = String(r.error || 'refused (no error field)').slice(0, 120);
      s1Errors.set(key, (s1Errors.get(key) || 0) + 1);
    }
  }
  // turn totals for System-1 must include the 'between steps' bucket: those calls belong to the
  // turn even though they belong to no step, and hiding them would understate the turn.
  for (const t of turnMap.values()) {
    for (const k of ['s1Calls', 's1Ms', 's1InputTokens', 's1OutputTokens', 's1Ok', 's1Refused', 's1Questions']) {
      t[k] += t.gap[k] || 0;
    }
  }

  const assembly = cell.control.filter((o) => o.type === 'assembly');
  const delivery = cell.control.filter((o) => o.type === 'context_delivery');
  for (const r of assembly) {
    bucketFor(attributeByTime(r.ts, steps, turns, lastTurnEnd)).assemblySteps += 1;
  }
  for (const r of delivery) {
    const bucket = bucketFor(attributeByTime(r.ts, steps, turns, lastTurnEnd));
    bucket.contextSteps += 1;
    bucket.injections += r.delivered ? 1 : 0;
  }

  // --- the step -> turn rollup, run after the control-plane attribution so a turn total includes
  // --- both the calls that landed inside its steps and the ones that landed between them --------
  for (const s of stepMap.values()) {
    const t = ensureTurn(s.turn, s.t0);
    for (const k of SUM_KEYS) t[k] += s[k] || 0;
  }
  for (const t of turnMap.values()) {
    t.idleMs = Math.max(0, (t.turnFrameMs || 0) - (t.stepFrameMs || 0));
  }

  // --- roll the step/turn maps into the cell scope ---------------------------------------------
  const totals = { ...emptyScope() };
  const turnList = [...turnMap.values()].sort((a, b) => a.turn - b.turn);
  for (const t of turnList) {
    for (const k of SUM_KEYS) totals[k] += t[k] || 0;
  }
  totals.turns = turns.length;
  totals.steps = steps.length;
  totals.turnFrameMs = turnList.reduce((a, t) => a + (t.turnFrameMs || 0), 0);
  totals.stepFrameMs = [...stepMap.values()].reduce((a, s) => a + (s.stepFrameMs || 0), 0);
  totals.idleMs = Math.max(0, totals.turnFrameMs - totals.stepFrameMs);
  totals.completionMs = totals.turnFrameMs;
  // the System-1 cell total is the control plane's own count, not the sum of the buckets: if the two
  // ever disagree the attribution is wrong, and the report says so rather than hiding it.
  totals.s1Calls = s1Records.length;
  totals.s1Ms = s1Records.reduce((a, r) => a + (r.ms || 0), 0);
  // F19: the lane's two token halves, counted apart. `FORMULAS.md` prices `Σ n_in` only ("Jev output is free"), so
  // the input sum is the billable figure and the output sum is shown beside it rather than added to it.
  totals.s1InputTokens = s1Records.reduce((a, r) => a + (r.inputTokens || 0), 0);
  totals.s1OutputTokens = s1Records.reduce((a, r) => a + (r.outputTokens || 0), 0);
  totals.s1Ok = s1Records.filter((r) => r.ok).length;
  totals.s1Refused = totals.s1Calls - totals.s1Ok;
  totals.s1Questions = s1Records.reduce((a, r) => a + (r.questions || 0), 0);
  // The assembly/delivery totals come straight from the control plane for the same reason: the
  // buckets exist to place records on a turn or a step, not to define the cell total.
  totals.assemblySteps = assembly.length;
  totals.contextSteps = delivery.length;
  totals.injections = delivery.filter((r) => r.delivered).length;

  const attributed = { s1Calls: 0, s1Ms: 0, s1InputTokens: 0, s1OutputTokens: 0 };
  for (const s of stepMap.values()) {
    attributed.s1Calls += s.s1Calls; attributed.s1Ms += s.s1Ms;
    attributed.s1InputTokens += s.s1InputTokens; attributed.s1OutputTokens += s.s1OutputTokens;
  }
  for (const t of turnList) {
    attributed.s1Calls += t.gap.s1Calls; attributed.s1Ms += t.gap.s1Ms;
    attributed.s1InputTokens += t.gap.s1InputTokens; attributed.s1OutputTokens += t.gap.s1OutputTokens;
  }
  const reconciled = attributed.s1Calls + tailScope.s1Calls + idleScope.s1Calls + preScope.s1Calls;
  if (reconciled !== totals.s1Calls) {
    warnings.push(
      `cell ${cell.name}: System-1 attribution loses ${totals.s1Calls - reconciled} call(s) ` +
        `(control plane ${totals.s1Calls}, buckets ${reconciled})`,
    );
  }

  const rgScored = Number(cell.rg.scoredPairs || 0);
  const rgJudged = Number(cell.rg.judgedPairs || 0);
  /**
   * Pairs the run declined to offer because the System-1 backend was saturated.
   *
   * Reported beside `judgedPairs / scoredPairs`, never inside it, and the distinction is what keeps the coverage
   * ratio honest. `scoredPairs` counts the pairs a scorer was shown; a pair the admission gate held back was shown
   * to nobody, so folding it into the denominator would print coverage over work that never happened, and leaving
   * it out without saying so would hide the work the run chose not to do. The snapshot carries it; a graph written
   * before the field existed has none, which reads as 0 and is rendered as "not recorded" rather than as a zero.
   */
  const rgDeferred = Number(cell.rg.deferredPairs || 0);
  const rgDeferredRecorded = cell.rg.deferredPairs !== undefined;
  const edgeSources = {};
  for (const e of cell.rg.edges || []) edgeSources[e.source] = (edgeSources[e.source] || 0) + 1;
  const rgAsOf = (cell.rg.scores || []).reduce((a, s) => Math.max(a, s.at || 0), 0)
    || (cell.rg.edges || []).reduce((a, e) => Math.max(a, e.verifiedAt || 0), 0);

  const completedTurns = turnList.filter((t) => t.turnsCompleted === 1).length;
  // A cell with no lane has no System-1 calls by construction. Coverage is then *undefined*, not 0:
  // judgedPairs is 0 because the backend never judged anything, but the local lexical scorer still
  // built edges, so 0/N would read as "the backend judged none of what it was shown" - a claim about
  // a backend that was never asked. `laneAbsent` is what every System-1 column is rendered through.
  //
  // `laneDemoted` is the same undefined coverage reached a different way, and it must not print as
  // `laneAbsent`: a demoted cell *did* have a lane configured, and the reason it made no calls is a
  // configuration error the operator can act on, not a design decision (F3). The two share every
  // rendering rule for the numbers - there are none to show either way - and differ in every word
  // that says why.
  const laneAbsent = cell.lane.state === 'none' || (cell.lane.state === 'unknown' && s1Records.length === 0);
  const laneDemoted = cell.lane.state === 'demoted';
  // The pairs the window would have offered, had the gate not held any back. This is the denominator the
  // validity floor is defined over (F5, `docs/FORMULAS.md`): `judged/scored` alone *rises* when the run
  // declines work, because a deferred pair is given back by the graph and never reaches `scoredPairs`.
  const offeredPairs = rgScored + rgDeferred;
  // `null` when there is nothing to qualify, and separately `null` when the snapshot predates the field:
  // "no pair was deferred" and "this snapshot cannot say" are different statements about the same 0.
  const deferredShare = rgDeferredRecorded ? (offeredPairs > 0 ? rgDeferred / offeredPairs : null) : null;
  // F9: what `FORMULAS.md:431` requires beside a `w`-lowering run. Three-valued for the same reason the
  // deferral row is: a build that did not write the field and a run in which the event did not happen
  // are different readings, and only the record can tell them apart.
  const fallbackSteps = assembly.filter((r) => r.fallback !== undefined);
  const fallbackRecorded = assembly.some((r) => 'fallback' in r);
  const unknownAdmittedTotal = assembly.some((r) => 'unknownAdmitted' in r)
    ? assembly.reduce((a, r) => a + (Number(r.unknownAdmitted) || 0), 0)
    : null;
  const recallTreeSteps = assembly.filter((r) => r.recallTree !== undefined);
  // The tree is `{ [anchorId]: { [hitId]: {...} } }` (`assembler.ts`, `recallTreeOf`): ids and nothing else, one
  // node per hit the walk placed. The node count is therefore "how much of a walk there was" and `{}` is a real
  // reading - recall found nothing - rather than a missing value. A record with no `recallTree` key at all is the
  // missing case, and the three-valued renderer says which of the two a cell has.
  const countRecallNodes = (node) => {
    if (node === null || typeof node !== 'object') return 0;
    let n = 0;
    for (const value of Object.values(node)) {
      n += 1 + countRecallNodes(value);
    }
    return n;
  };
  const recallTreeNodes = recallTreeSteps.reduce((a, r) => a + countRecallNodes(r.recallTree), 0);
  const diagnostics = {
    laneState: cell.lane.state,
    laneAbsent,
    laneDemoted,
    laneProvider: cell.lane.provider,
    laneMode: cell.lane.mode,
    laneBaseUrl: cell.lane.baseUrl,
    laneSource: cell.lane.source,
    laneConfiguredProvider: cell.lane.configuredProvider ?? null,
    laneConflicts: cell.lane.conflicts ?? [],
    laneLabel: laneAbsent
      ? (cell.lane.state === 'none' ? `absent (${cell.lane.source})` : 'absent (no provider evidence)')
      : laneDemoted
        ? `**DEMOTED** to none by a configuration conflict: configured ${cell.lane.configuredProvider}`
        : `present: ${cell.lane.provider ?? 'unknown'}${cell.lane.mode ? ` (${cell.lane.mode})` : ''}${cell.lane.baseUrl ? ` at ${cell.lane.baseUrl}` : ''}`,
    s1Calls: totals.s1Calls,
    s1Ok: totals.s1Ok,
    s1Refused: totals.s1Refused,
    s1SuccessRate: totals.s1Calls > 0 ? totals.s1Ok / totals.s1Calls : (laneAbsent || laneDemoted ? null : 0),
    s1ErrorTop: [...s1Errors.entries()].sort((a, b) => b[1] - a[1])[0] || null,
    scoredPairs: rgScored,
    judgedPairs: rgJudged,
    deferredPairs: rgDeferred,
    // A cell whose graph predates the field has no deferral *reading*; printing 0 for it would claim the run was
    // never held back, which is a different statement from "this snapshot cannot say".
    deferredRecorded: rgDeferredRecorded,
    offeredPairs,
    deferredShare,
    coverage: laneAbsent || laneDemoted ? null : (rgScored > 0 ? rgJudged / rgScored : null),
    // The ratio the validity floor is defined over: judged out of everything the arrival order offered, deferrals
    // included. Printed beside `coverage`, never instead of it, so a run that stopped asking is visible as such.
    coverageOffered: laneAbsent || laneDemoted
      ? null
      : (offeredPairs > 0 && rgDeferredRecorded ? rgJudged / offeredPairs : null),
    fallbackSteps: fallbackSteps.length,
    fallbackRecorded,
    fallbackKinds: [...new Set(fallbackSteps.map((r) => (typeof r.fallback === 'string' ? r.fallback : JSON.stringify(r.fallback))))],
    unknownAdmittedTotal,
    recallTreeRecorded: assembly.some((r) => 'recallTree' in r),
    recallTreeSteps: recallTreeSteps.length,
    recallTreeNodes,
    edgeSourceS1: edgeSources['s1-noul'] || 0,
    edgeSourceLexical: edgeSources.lexical || 0,
    rgEdges: (cell.rg.edges || []).length,
    rgSegments: (cell.rg.order || []).length,
    rgAsOf,
    injections: totals.injections,
    contextSteps: totals.contextSteps,
    assemblySteps: totals.assemblySteps,
    cacheHitRate: totals.hitTokens + totals.missTokens > 0
      ? totals.hitTokens / (totals.hitTokens + totals.missTokens)
      : null,
    humanMessages: totals.humanMessages,
    injectedMessages: totals.injectedMessages,
    turnsCompleted: completedTurns,
    turnCount: turns.length,
    turnCompletionConstant: completedTurns === turns.length && turns.length > 0,
  };

  totals.turnsCompleted = completedTurns;
  // Recompute the cell-level originals that the step/turn rollup cannot know about.
  const firstTurnStart = turns.length > 0 ? turns[0].t0 : 0;
  const lastEventTime = events.length > 0 ? events[events.length - 1].time : 0;
  const maxS1Ts = s1Records.reduce((a, r) => Math.max(a, r.ts || 0), 0);

  return {
    cell,
    totals,
    turnList,
    steps: [...stepMap.values()].sort((a, b) => a.turn - b.turn || a.step - b.step),
    tail: tailScope,
    pre: preScope,
    idle: idleScope,
    lastTurnEnd,
    diagnostics,
    lastEventTime,
    maxS1Ts,
    warnings,
  };
}

// ---------------------------------------------------------------------------------------------
// 6. Markdown rendering
// ---------------------------------------------------------------------------------------------

function mdTable(headers, rows) {
  const lines = [];
  lines.push(`| ${headers.join(' | ')} |`);
  lines.push(`| ${headers.map(() => '---').join(' | ')} |`);
  for (const r of rows) lines.push(`| ${r.join(' | ')} |`);
  return lines.join('\n');
}

function valueFor(metric, scope) {
  if (scope === null || scope === undefined) return null;
  const v = scope[metric.key];
  return v === undefined ? null : v;
}

// `s1InputTokens`/`s1OutputTokens` and `s1Ms` are System-1 columns exactly as `s1Calls` is, so they get the same
// treatment: coverage printed beside them, the calls that no step owns printed as their own rows rather than
// dropped, and an explicit lane marker so a configured-but-refused zero can never be read as a not-configured zero.
// Only `s1Calls` is annotated inline with the coverage percentage, because a percentage repeated inside a
// millisecond or token cell makes the number unreadable.
const S1_METRICS = new Set(['s1Calls', 's1Ms', 's1InputTokens', 's1OutputTokens']);
const isS1Metric = (m) => S1_METRICS.has(m.key);

/**
 * Render one System-1 value with the lane marker the owner asked for.
 *
 * Every System-1 zero is labelled with *why* it is zero:
 *   `0 (no S1 lane)`   - the cell has no lane; the zero is by construction
 *   `0 (lane present; 0 ok of N)` - the lane exists and refused or timed out; never a bare `0`
 * Non-zero values need no marker, and non-System-1 metrics are rendered plainly.
 *
 * A demoted lane is the third case and is *not* folded into the first: it has no calls, so the number is 0, but
 * it was configured and then refused, which is a defect in the run and not a property of the arm. The mark says
 * which (F3).
 */
function renderS1Value(metric, cell, value, { cellLevel }) {
  const base = renderValue(metric, value);
  if (!isS1Metric(metric)) return base;
  const d = cell.a.diagnostics;
  if (d.laneDemoted) return `${base} (lane demoted to "none" by a conflict)`;
  if (d.laneAbsent) return `${base} (no S1 lane)`;
  if (base === '0') {
    return cellLevel
      ? `0 (lane present; ${fmtInt(d.s1Ok)} ok of ${fmtInt(d.s1Calls)})`
      : '0 (lane present)';
  }
  return base;
}

/**
 * The deferral that qualifies a coverage figure, as a share of the window the run was offered.
 *
 * `null` in two different situations that must not print alike: a snapshot with no `deferredPairs` field at all
 * ("not recorded"), and a graph with no pairs to defer ("0 of 0"). The first is a missing reading; the second is a
 * measured zero share. F5 - the coverage ratio can be *raised* by declining work, because `assoc-graph.ts` gives a
 * deferred pair back to the cursor and it never reaches `scoredPairs`, so the share has to appear beside every
 * coverage figure rather than only in the diagnostics table.
 */
function deferredShareText(d) {
  if (!d.deferredRecorded) return 'deferral share: not recorded by this snapshot';
  if (d.deferredShare === null) return `deferral share: 0 of 0 pairs (nothing was offered to the gate)`;
  return (
    `deferral share: ${fmtPct(d.deferredShare)} (${fmtInt(d.deferredPairs)} deferred of ` +
    `${fmtInt(d.offeredPairs)} offered = scored + deferred)`
  );
}

/**
 * Coverage beside a System-1 column: a fraction when the lane exists, `undefined` when it does not.
 *
 * Two denominators, both printed, because they answer different questions. `judged/scored` is the share of what
 * the backend was *shown* that it answered; the floor `FORMULAS.md` sets for a cell to count as S1-governed is
 * now defined over `judged/(scored+deferred)` - the window the arrival order offered - because the first ratio
 * rises when the gate holds work back, and a floor a run can satisfy by declining work is not a floor.
 */
function coverageFor(cell) {
  const d = cell.a.diagnostics;
  if (d.laneDemoted) {
    const why = d.laneConflicts.length > 0 ? d.laneConflicts[0] : 'no conflict text recorded on the wiring record';
    return (
      `undefined — **lane demoted** (configured ${d.laneConfiguredProvider}, resolved none by a conflict: ${why}); ` +
      `judged ${fmtInt(d.judgedPairs)}/${fmtInt(d.scoredPairs)} by the lexical fallback, which still built ` +
      `${fmtInt(d.edgeSourceLexical)} edge(s); ${deferredShareText(d)}`
    );
  }
  if (d.laneAbsent) {
    return (
      `undefined — no S1 lane (judged ${fmtInt(d.judgedPairs)}/${fmtInt(d.scoredPairs)}; the lexical fallback ` +
      `still built ${fmtInt(d.edgeSourceLexical)} edge(s)); ${deferredShareText(d)}`
    );
  }
  const offered = d.coverageOffered === null
    ? 'offered-denominator coverage: n/a (deferrals not recorded by this snapshot)'
    : `judged/(scored+deferred) = ${fmtPct(d.coverageOffered)}`;
  return (
    `${fmtPct(d.coverage)} (${fmtInt(d.judgedPairs)}/${fmtInt(d.scoredPairs)} judged/scored; ${offered}); ` +
    deferredShareText(d)
  );
}

function coverageLine(cells) {
  return `coverage beside each System-1 column: ${cells.map((c) => `${c.display} ${coverageFor(c)}`).join(' · ')}`;
}

/** Render one System-1 bucket cell, annotating the call count with the cell's coverage. */
function annotateS1(metric, cell, bucket) {
  const v = renderS1Value(metric, cell, valueFor(metric, bucket), { cellLevel: false });
  const d = cell.a.diagnostics;
  return metric.key === 's1Calls'
    ? `${v} (cov ${d.laneAbsent || d.laneDemoted ? 'n/a' : fmtPct(d.coverage)})`
    : v;
}

/** All System-1 bucket sums for a metric, in the order the tables print them. */
function s1BucketSum(cell, metric) {
  let total = 0;
  for (const s of cell.a.steps) total += valueFor(metric, s) || 0;
  for (const t of cell.a.turnList) total += valueFor(metric, t.gap) || 0;
  for (const b of [cell.a.idle, cell.a.tail, cell.a.pre]) total += valueFor(metric, b) || 0;
  return total;
}

/** One header line naming, per cell, whether it had a System-1 lane at all. */
function laneHeaderLine(cells) {
  const present = cells.filter((c) => !c.a.diagnostics.laneAbsent && !c.a.diagnostics.laneDemoted);
  const absent = cells.filter((c) => c.a.diagnostics.laneAbsent);
  const demoted = cells.filter((c) => c.a.diagnostics.laneDemoted);
  const parts = [];
  if (present.length > 0) {
    parts.push(`had a System-1 lane: ${present.map((c) => `${c.display} — ${c.a.diagnostics.laneLabel}`).join(' · ')}`);
  }
  // Named before the absent cells, and in the loudest of the three tones: this is the one of the three readings
  // that is a defect in the round rather than a decision about the arm, and it used to print as a decision (F3).
  if (demoted.length > 0) {
    parts.push(
      `had a System-1 lane **configured and demoted to none by a configuration conflict**: ` +
        `${demoted.map((c) => `${c.display} — ${c.a.diagnostics.laneLabel}`).join(' · ')}` +
        ' (their calls, tokens and time are zero because no backend was ever resolved; this is NOT a no-lane ' +
        'control, and their coverage is undefined for a different reason than a control arm\'s)',
    );
  }
  if (absent.length > 0) {
    parts.push(
      `had **no** System-1 lane: ${absent.map((c) => `${c.display} — ${c.a.diagnostics.laneLabel}`).join(' · ')}` +
        ' (their System-1 calls, tokens and time are zero by construction, and their coverage is undefined, not 0)',
    );
  }
  return parts.join('; ');
}

function renderValue(metric, v) {
  if (v === null || v === undefined) return '-';
  if (metric.unit === 'ms') return fmtInt(v);
  if (metric.unit === 'ratio') return fmtPct(v);
  return fmtInt(v);
}

function renderMarkdown(analysis) {
  const { cells, runDir, snapshotAt, warnings, dsh } = analysis;
  const out = [];
  const cellNames = cells.map((c) => c.name);
  const headers = cells.map((c) => c.display);

  out.push('# S1CAP cell report');
  out.push('');
  out.push(`- run: \`${runDir}\``);
  out.push(`- cells: ${cells.map((c) => `\`${c.name}\`${c.label !== c.name ? ` = ${c.label}` : ''}`).join(' · ')}`);
  out.push(`- snapshot taken: ${snapshotAt} (all counts are of the artifacts as read at this instant)`);
  // Provenance, beside the snapshot: a number cannot be placed without knowing which release produced
  // it. Both rows are read from the manifest's `_dsh` block; when it is absent the release row states
  // that fact in the harness's own words rather than going blank or guessing.
  if (dsh.present) {
    const parts = dshReleaseParts(dsh);
    const model = dshModelLine(dsh);
    out.push(`- DSH release: ${[parts[0], ...parts.slice(1)].join(' | ')}`);
    out.push(`- model: ${model ?? 'not recorded in this round\'s _dsh block'}`);
  } else {
    out.push(`- DSH release: ${UNKNOWN_RELEASE}`);
    out.push(`- model: not recorded (${dsh.reason})`);
  }
  out.push(`- System-1 lane: ${laneHeaderLine(cells)}`);
  out.push('');
  out.push('Every figure below is derived from the three sources named in `scripts/cell-report.mjs`: the');
  out.push('plugin control plane (`control.jsonl`), the harness session store (`session.v4.jsonl.zstd`),');
  out.push('and the association-graph snapshot (`.s1cap/rg/*.json`). Missing evidence is an error, not a zero.');
  out.push('');

  // ---- provenance ---------------------------------------------------------------------------
  out.push('## Provenance and snapshot');
  out.push('');
  out.push(mdTable(['', ...headers], [
    ['control plane', ...cells.map((c) => `${c.control.length} records`)],
    ['session store', ...cells.map((c) => `${c.sessionFrames} zstd frames / ${fmtInt(c.sessionBytes)} B`)],
    ['session id', ...cells.map((c) => `\`${c.sessionId}\``)],
    ['association graph', ...cells.map((c) => basename(c.rgPath))],
    ['graph as-of (max scores[].at)', ...cells.map((c) => (c.a.diagnostics.rgAsOf ? new Date(c.a.diagnostics.rgAsOf).toISOString() : '-'))],
    ['artifact mtimes (control / session / graph)', ...cells.map((c) => [c.mtimes.control, c.mtimes.session, c.mtimes.rg].map((t) => (t ? t.slice(11, 23) : '-')).join(' / '))],
    ['last session event', ...cells.map((c) => (c.a.lastEventTime ? new Date(c.a.lastEventTime).toISOString() : '-'))],
    ['last System-1 call (control plane)', ...cells.map((c) => (c.a.maxS1Ts ? new Date(c.a.maxS1Ts).toISOString() : '-'))],
    ['System-1 calls after the last turn/end', ...cells.map((c) => fmtInt(c.a.tail.s1Calls))],
  ]));
  out.push('');
  out.push('The association graph is maintained asynchronously and keeps working after the last turn ends,');
  out.push('so System-1 calls continue to arrive past `turn/end`. Those calls are shown in their own row');
  out.push('("after last turn") in every System-1 table and are never folded into a turn.');
  out.push('');

  // ---- time ---------------------------------------------------------------------------------
  out.push('## Time');
  out.push('');
  const timeMetrics = METRICS.filter((m) => m.group === 'time');
  out.push('### Cell totals');
  out.push('');
  out.push(mdTable(['metric', 'unit', ...headers],
    timeMetrics.map((m) => [m.label, UNIT_LABEL[m.unit], ...cells.map((c) => renderS1Value(m, c, valueFor(m, c.a.totals), { cellLevel: true }))])));
  out.push('');
  if (cells.some((c) => c.a.diagnostics.laneAbsent || c.a.diagnostics.laneDemoted)) {
    out.push('A System-1 `0 (no S1 lane)` means the cell had no lane configured, so the zero is by construction;');
    out.push('`0 (lane present; …)` means a lane existed and its calls were refused or timed out; and');
    out.push('`0 (lane demoted to "none" by a conflict)` means a lane **was** configured and a configuration');
    out.push('conflict dropped the session to `provider: "none"` before it made a call. The three are never');
    out.push('printed the same way - the third is a defect in the round, not a property of the arm.');
    out.push('');
  }
  out.push('`turn frame` is `turn/end − turn/start`; `step frame` is `step/end − step/start`; `between-step idle`');
  out.push('is the difference. `LLM time` is `assistant/message − step/start` and `other tool time` is');
  out.push('`tool/result − tool/call` matched by call id, so together with the residual they add up to the');
  out.push('step frame - the report prints all three so the addition can be checked, not assumed.');
  out.push('');
  out.push('`System-1 time` is the plugin\'s own reported `ms` per call, and it is **not** additive with');
  out.push('`LLM time`: association judging runs concurrently with the request, so in a heavy step the sum of');
  out.push('System-1 `ms` can exceed the step\'s wall-clock width.');
  out.push('');

  // ---- cost ---------------------------------------------------------------------------------
  out.push('## Cost');
  out.push('');
  const costMetrics = METRICS.filter((m) => m.group === 'cost');
  out.push('### Cell totals');
  out.push('');
  out.push(mdTable(['metric', 'unit', ...headers],
    costMetrics.map((m) => [m.label, UNIT_LABEL[m.unit], ...cells.map((c) => renderS1Value(m, c, valueFor(m, c.a.totals), { cellLevel: true }))])));
  out.push('');
  out.push('`cached-hit input tokens` is `usage.cacheReadTokens`, `uncached input tokens` is `usage.inputTokens`');
  out.push('(the uncached remainder - `totalTokens` is their sum and is not used for either), and `output');
  out.push('tokens` is `usage.outputTokens`, all summed over the session store\'s `assistant/message` records.');
  out.push('');
  out.push('**Cache hit rate is deliberately absent from this table.** It is a mechanism diagnostic, not a cost');
  out.push('metric: it says how the input was billed, not how much of it there was. It appears once, in');
  out.push('"Mechanism diagnostics" below.');
  out.push('');

  // ---- completion ---------------------------------------------------------------------------
  out.push('## Completion');
  out.push('');
  const completionMetrics = METRICS.filter((m) => m.group === 'completion');
  out.push(mdTable(['', ...headers], [
    ...completionMetrics.map((m) => [m.label, ...cells.map((c) => renderValue(m, valueFor(m, c.a.totals)))]),
    ['turn/end reason', ...cells.map((c) => c.a.turnList.map((t) => `${t.turn}:${t.completionState || 'no turn/end'}`).join(' '))],
  ]));
  out.push('');
  const allComplete = cells.every((c) => c.a.diagnostics.turnCompletionConstant);
  if (allComplete) {
    out.push('Every turn in every cell ended with `turn/end reason.kind = "completed"`, so completion is a');
    out.push('single constant column; it is not broken down per turn, because a per-turn completion table');
    out.push('would repeat the same value once per row and would carry no information about the cells.');
  } else {
    out.push('Completion is **not** constant across these cells; the per-turn reason row above says which turn');
    out.push('did not end with `reason.kind = "completed"`.');
  }
  out.push('');

  // ---- mechanism diagnostics ----------------------------------------------------------------
  out.push('## Mechanism diagnostics (not cost metrics)');
  out.push('');
  out.push('System-1 coverage is `judgedPairs / scoredPairs` from the association-graph snapshot: the share of');
  out.push('scored association pairs the backend actually judged. A cell whose System-1 calls were refused has');
  out.push('a low coverage and did **not** receive its configured System-1 governance, whatever its call count');
  out.push('says - which is why coverage is repeated beside every System-1 column below.');
  out.push('');
  out.push('`scoredPairs` is what the backend was *offered* and `judgedPairs` what it answered. Since 2026-10-02 a');
  out.push('third number sits beside them, because the upkeep now stops asking a backend that is refusing:');
  out.push('`deferredPairs` is the work the admission gate held back, which was offered to nobody. `judged/scored`');
  out.push('deliberately leaves it out - a pair that was never shown is not a pair the backend failed to judge - but');
  out.push('that ratio **rises when the run declines work**, because the graph gives a deferred pair back to its');
  out.push('cursor and it never reaches `scoredPairs`. The validity floor is therefore stated over the window the');
  out.push('arrival order offered, `judged / (scored + deferred)`, and both denominators are printed together so a');
  out.push('cell that looks S1-governed because it stopped asking cannot hide behind the ratio that flatters it.');
  out.push('Both are `undefined` for a cell that had no lane at all, and that is not the same reading as a low one.');
  out.push('');
  out.push('Three readings that look alike are kept apart here, and until the audit two of them did not. A cell');
  out.push('whose lane is switched off has zero System-1 calls, tokens and time *by construction*; a cell with a');
  out.push('lane whose backend refused every request has a real call count, a real failure split and a measured');
  out.push('coverage; and a cell whose lane was **configured and then demoted to `none` by a configuration');
  out.push('conflict** has the same zeroes as the first while being a defect rather than a decision. The lane state');
  out.push('is read, never inferred from the call count: it comes from the `kind:"wiring"` record the plugin writes');
  out.push('once at activation onto the cell\'s own tape (`home/<cell>/.s1cap/tape.jsonl`), whose `s1` field is');
  out.push('literally `"none"` for the Off choice and `{provider, mode, baseUrl}` otherwise. The record now also');
  out.push('carries `configuredProvider` and `conflicts`, which is what tells a demotion from a choice - a `none`');
  out.push('whose configured provider names something else was demoted. The tape\'s `tuning-file` record and the');
  out.push('`provider` on the `s1_call` records are the fallbacks. Only when none of those exist is the absence');
  out.push('inferred from the silence, and the report says so.');
  out.push('');
  out.push(mdTable(['diagnostic', ...headers], [
    ['System-1 lane', ...cells.map((c) => c.a.diagnostics.laneLabel)],
    ['System-1 lane configured provider', ...cells.map((c) => (
      c.a.diagnostics.laneConfiguredProvider === null
        ? '— (not recorded by this snapshot)'
        : String(c.a.diagnostics.laneConfiguredProvider)))],
    ['configuration conflicts behind the demotion', ...cells.map((c) => (
      c.a.diagnostics.laneDemoted
        ? (c.a.diagnostics.laneConflicts.length > 0
          ? c.a.diagnostics.laneConflicts.map((x) => `"${x}"`).join('; ')
          : '— (demoted, but no conflict text on the wiring record)')
        : (c.a.diagnostics.laneConflicts.length > 0 ? `none affecting the lane (${c.a.diagnostics.laneConflicts.length} recorded)` : '— (none)')))],
    ['System-1 calls ok / refused / total', ...cells.map((c) => (c.a.diagnostics.laneAbsent || c.a.diagnostics.laneDemoted
      ? (c.a.diagnostics.laneDemoted ? '— (lane demoted; no backend was resolved)' : '— (no S1 lane)')
      : `${fmtInt(c.a.diagnostics.s1Ok)} / ${fmtInt(c.a.diagnostics.s1Refused)} / ${fmtInt(c.a.diagnostics.s1Calls)}`))],
    ['System-1 call success rate', ...cells.map((c) => (c.a.diagnostics.laneAbsent
      ? '— (no S1 lane)'
      : c.a.diagnostics.laneDemoted ? '— (lane demoted; no backend was resolved)' : fmtPct(c.a.diagnostics.s1SuccessRate)))],
    ['System-1 calls refused', ...cells.map((c) => (c.a.diagnostics.laneAbsent
      ? '— (no S1 lane)'
      : c.a.diagnostics.laneDemoted ? '— (lane demoted; no backend was resolved)' : fmtInt(c.a.diagnostics.s1Refused)))],
    ['top refusal reason', ...cells.map((c) => (c.a.diagnostics.s1ErrorTop
      ? `${c.a.diagnostics.s1ErrorTop[0]} ×${c.a.diagnostics.s1ErrorTop[1]}`
      : (c.a.diagnostics.laneDemoted
        ? '— (lane demoted; the backend was never asked)'
        : c.a.diagnostics.laneAbsent ? '— (no S1 lane)' : '— (none refused)')))],
    ['association pairs judged / scored', ...cells.map((c) => ((c.a.diagnostics.laneAbsent || c.a.diagnostics.laneDemoted)
      ? `${fmtInt(c.a.diagnostics.judgedPairs)} / ${fmtInt(c.a.diagnostics.scoredPairs)} (backend never judged)`
      : `${fmtInt(c.a.diagnostics.judgedPairs)} / ${fmtInt(c.a.diagnostics.scoredPairs)}`))],
    // The third number, and the reason `judged / scored` stays readable when the backend is refusing: a pair the
    // admission gate held back was never offered to anyone, so it is counted here rather than in the denominator.
    ['association pairs deferred (not offered)', ...cells.map((c) => (c.a.diagnostics.deferredRecorded
      ? fmtInt(c.a.diagnostics.deferredPairs)
      : '— (not recorded by this snapshot)'))],
    ['association pairs offered (scored + deferred)', ...cells.map((c) => (c.a.diagnostics.deferredRecorded
      ? fmtInt(c.a.diagnostics.offeredPairs)
      : '— (not recorded by this snapshot)'))],
    ['deferred share of offered', ...cells.map((c) => (c.a.diagnostics.deferredShare === null
      ? '— (not recorded by this snapshot)'
      : fmtPct(c.a.diagnostics.deferredShare)))],
    ['**System-1 coverage**', ...cells.map((c) => (c.a.diagnostics.laneDemoted
      ? '**undefined** (**lane demoted by a conflict**)'
      : c.a.diagnostics.laneAbsent ? '**undefined** (no S1 lane)' : `**${fmtPct(c.a.diagnostics.coverage)}**`))],
    ['System-1 coverage over offered (floor denominator)', ...cells.map((c) => (c.a.diagnostics.coverageOffered === null
      ? (c.a.diagnostics.laneDemoted ? '— (lane demoted by a conflict)' : c.a.diagnostics.laneAbsent ? '— (no S1 lane)' : '— (deferrals not recorded by this snapshot)')
      : fmtPct(c.a.diagnostics.coverageOffered)))],
    ['recall block source', ...cells.map((c) => (c.a.diagnostics.fallbackRecorded
      ? `${fmtInt(c.a.diagnostics.assemblySteps - c.a.diagnostics.fallbackSteps)} backend / ${fmtInt(c.a.diagnostics.fallbackSteps)} recency-fallback` +
        (c.a.diagnostics.fallbackKinds.length > 0 ? ` (${c.a.diagnostics.fallbackKinds.join(', ')})` : '')
      : '— (not recorded by this snapshot)'))],
    ['unjudged pairs admitted (`unknownAdmitted`)', ...cells.map((c) => (c.a.diagnostics.unknownAdmittedTotal === null
      ? '— (not recorded by this snapshot)'
      : fmtInt(c.a.diagnostics.unknownAdmittedTotal)))],
    ['recall structure recorded (steps / nodes placed)', ...cells.map((c) => (c.a.diagnostics.recallTreeRecorded
      ? `${fmtInt(c.a.diagnostics.recallTreeSteps)} / ${fmtInt(c.a.diagnostics.recallTreeNodes)}`
      : '— (not recorded by this snapshot)'))],
    ['association edges from s1-noul / lexical', ...cells.map((c) => `${fmtInt(c.a.diagnostics.edgeSourceS1)} / ${fmtInt(c.a.diagnostics.edgeSourceLexical)}`)],
    ['context injections delivered', ...cells.map((c) => `${fmtInt(c.a.diagnostics.injections)} of ${fmtInt(c.a.diagnostics.contextSteps)} steps`)],
    ['cache hit rate (hit ÷ (hit+miss))', ...cells.map((c) => fmtPct(c.a.diagnostics.cacheHitRate))],
    ['human messages / harness- or plugin-injected', ...cells.map((c) => `${fmtInt(c.a.diagnostics.humanMessages)} / ${fmtInt(c.a.diagnostics.injectedMessages)}`)],
  ]));
  out.push('');
  out.push('Coverage is `judgedPairs / scoredPairs` for a cell that had a lane, and `judgedPairs / (scoredPairs +');
  out.push('deferredPairs)` for the floor `FORMULAS.md` sets at 0.5 - the first says how much of what the backend');
  out.push('was shown it answered, the second how much of the window the run would have offered it answered. For a');
  out.push('cell with no lane *or with a lane demoted by a conflict*, coverage is **undefined**, not 0: `judgedPairs`');
  out.push('is 0 because the backend was never asked, and printing 0/N would describe a backend that judged none of');
  out.push('what it was shown, which is a different claim about a backend that does not exist in that cell. The');
  out.push('lexical fallback still scores and still builds edges, which is why the edge row is split by source.');
  out.push('');
  out.push('The recall rows are `FORMULAS.md`\'s requirement that a run which lowers `w` carries `fallback` and');
  out.push('`unknownAdmitted` beside it, plus the `recallTree` root count. "Recency-fallback" is the event that');
  out.push('silently replaces the System-1 selection with the last-N window, so without it `selected`/`candidates`');
  out.push('cannot be read as evidence about the *selector* - "recall selected nothing" and "recall was overridden"');
  out.push('are different facts about the same count. `— (not recorded by this snapshot)` means the build did not');
  out.push('write the field at all, which a round must not read as "the event did not happen".');
  out.push('');
  out.push('The message row is the counting trap in the session store: `user/message` records include the two');
  out.push('the harness injects at session start (`Current runtime context…`, the `<system-reminder>` skill');
  out.push('catalog) plus, in the deliveries that fired, a plugin-injected `source.kind = "system-prompt"`');
  out.push('message. Only `source.kind === "user"` is counted as a human message.');
  out.push('');

  // ---- per turn -----------------------------------------------------------------------------
  out.push('## Per turn');
  out.push('');
  out.push('Rows are turn indices, so cells can be compared at the same turn index. A cell that did not run a');
  out.push('turn shows `-`.');
  out.push('');
  for (const m of METRICS.filter((x) => x.scopes.includes('turn'))) {
    const turnIndices = [...new Set(cells.flatMap((c) => c.a.turnList.map((t) => t.turn)))].sort((a, b) => a - b);
    const rows = turnIndices.map((idx) => [
      String(idx),
      ...cells.map((c) => {
        const t = c.a.turnList.find((x) => x.turn === idx);
        if (!t) return '-';
        if (m.key === 's1Calls') return `${renderS1Value(m, c, valueFor(m, t), { cellLevel: false })} (cov ${c.a.diagnostics.laneAbsent || c.a.diagnostics.laneDemoted ? 'n/a' : fmtPct(c.a.diagnostics.coverage)})`;
        return isS1Metric(m) ? renderS1Value(m, c, valueFor(m, t), { cellLevel: false }) : renderValue(m, valueFor(m, t));
      }),
    ]);
    // A System-1 turn row holds only what landed inside that turn. Everything else is printed as its
    // own row so the column still adds up to the cell total: a turn table whose rows silently sum to
    // less than its Σ row is the exact failure this report exists to avoid.
    if (isS1Metric(m)) {
      rows.push(['between turns (no turn owns them)', ...cells.map((c) => annotateS1(m, c, c.a.idle))]);
      rows.push(['after last turn (async upkeep)', ...cells.map((c) => annotateS1(m, c, c.a.tail))]);
    }
    const rowSum = (c) => (isS1Metric(m) ? s1BucketSum(c, m) : valueFor(m, c.a.totals));
    const totalsRow = ['Σ cell total', ...cells.map((c) => (isS1Metric(m)
      ? renderS1Value(m, c, rowSum(c), { cellLevel: true })
      : renderValue(m, rowSum(c))))];
    out.push(`### ${m.label} per turn (${UNIT_LABEL[m.unit]})`);
    out.push('');
    if (isS1Metric(m)) out.push(coverageLine(cells));
    if (isS1Metric(m)) out.push('');
    out.push(mdTable(['turn', ...headers], [...rows, totalsRow]));
    out.push('');
  }

  // ---- per step -----------------------------------------------------------------------------
  out.push('## Per step');
  out.push('');
  out.push('**Step indices are per cell, and the cells run different numbers of steps.** A per-step figure is');
  out.push('divided by nothing here: `turn.step` names one step of that one cell. The step counts are:');
  out.push('');
  out.push(`- ${cells.map((c) => `**${c.display}**: ${fmtInt(c.a.totals.steps)} steps`).join(' · ')}`);
  out.push('');
  out.push('Where a mean per step is quoted it is divided by that cell\'s own step count (printed in the row');
  out.push('label), never by another cell\'s.');
  out.push('');
  const stepRows = [...new Set(cells.flatMap((c) => c.a.steps.map((s) => `${s.turn}.${s.step}`)))].sort((a, b) => {
    const [at, as] = a.split('.').map(Number);
    const [bt, bs] = b.split('.').map(Number);
    return at - bt || as - bs;
  });

  for (const m of METRICS.filter((x) => x.scopes.includes('step'))) {
    const rows = stepRows.map((key) => {
      const [turn, step] = key.split('.').map(Number);
      return [key, ...cells.map((c) => {
        const s = c.a.steps.find((x) => x.turn === turn && x.step === step);
        if (!s) return '-';
        return annotateS1(m, c, s);
      })];    });
    // These rows are emitted unconditionally for System-1 metrics, even when they are all zero: the
    // guarantee that the rows above Σ add up to Σ must not depend on the data happening to need it.
    if (isS1Metric(m)) {
      const turnIndices = [...new Set(cells.flatMap((c) => c.a.turnList.map((t) => t.turn)))].sort((a, b) => a - b);
      for (const idx of turnIndices) {
        rows.push([`${idx}.· between steps`, ...cells.map((c) => {
          const t = c.a.turnList.find((x) => x.turn === idx);
          if (!t) return '-';
          return annotateS1(m, c, t.gap);
        })]);
      }
      rows.push(['between turns (after step/end, before the next turn/start)', ...cells.map((c) => annotateS1(m, c, c.a.idle))]);
      rows.push(['after last turn (async upkeep)', ...cells.map((c) => annotateS1(m, c, c.a.tail))]);
    }
    // The mean is taken over exactly the rows printed above it, so it can never be divided by a
    // number the reader cannot see. For every metric except the System-1 ones those rows already sum
    // to the cell total; for the System-1 ones the Σ row below shows what the cells did outside any
    // step, and it equals the control plane's own count.
    const rowValue = (c) => (isS1Metric(m) ? s1BucketSum(c, m) : valueFor(m, c.a.totals));
    const divisorRow = ['mean per step (÷ that cell\'s own step count)', ...cells.map((c) => {
      const n = c.a.totals.steps;
      const v = rowValue(c);
      if (v === null || !n) return '-';
      if (isS1Metric(m) && (c.a.diagnostics.laneAbsent || c.a.diagnostics.laneDemoted)) {
        return `${c.a.diagnostics.laneDemoted ? '0 (lane demoted by a conflict' : '0 (no S1 lane'}; ÷${n})`;
      }
      const mean = v / n;
      return m.unit === 'ms' ? `${(mean / 1000).toFixed(2)}s (÷${n})` : `${mean.toFixed(1)} (÷${n})`;
    })];
    const totalRow = ['Σ cell total', ...cells.map((c) => (isS1Metric(m)
      ? renderS1Value(m, c, valueFor(m, c.a.totals), { cellLevel: true })
      : renderValue(m, valueFor(m, c.a.totals))))];
    out.push(`### ${m.label} per step (${UNIT_LABEL[m.unit]})`);
    out.push('');
    if (isS1Metric(m)) {
      out.push(coverageLine(cells));
      out.push('');
      out.push('System-1 records are attributed by timestamp, because the control plane carries no turn/step. What');
      out.push('falls between two steps of a turn is shown as `turn.· between steps`; what falls between two turns');
      out.push('or arrives after the last `turn/end` is shown as its own row. Every row above the Σ adds up to the');
      out.push('cell total - the association-graph upkeep tick is not aligned to steps, so dropping the remainder');
      out.push('would silently understate the busiest cells.');
      out.push('');
    }
    out.push(mdTable(['turn.step', ...headers], [...rows, divisorRow, totalRow]));
    out.push('');
  }

  // ---- provenance footnotes -----------------------------------------------------------------
  out.push('## Reconciliation and warnings');
  out.push('');
  out.push(mdTable(['', ...headers], [
    ['steps (session store `step/start`)', ...cells.map((c) => fmtInt(c.a.totals.steps))],
    ['assembly records (control plane)', ...cells.map((c) => fmtInt(c.a.diagnostics.assemblySteps))],
    ['context_delivery records', ...cells.map((c) => fmtInt(c.a.diagnostics.contextSteps))],
    ['System-1 calls (sum of buckets)', ...cells.map((c) => fmtInt(s1BucketSum(c, METRICS.find((m) => m.key === 's1Calls'))))],
    ['System-1 calls (control plane)', ...cells.map((c) => fmtInt(c.a.totals.s1Calls))],
    ['LLM calls = steps?', ...cells.map((c) => (c.a.totals.llmCalls === c.a.totals.steps ? 'yes' : `no (${c.a.totals.llmCalls} vs ${c.a.totals.steps})`))],
  ]));
  out.push('');
  if (warnings.length === 0) {
    out.push('No warnings.');
  } else {
    out.push(`${warnings.length} warning(s):`);
    out.push('');
    for (const w of warnings) out.push(`- ${w}`);
  }
  out.push('');

  out.push('## What this report does not derive');
  out.push('');
  out.push('- **Per-turn or per-step coverage.** The association-graph snapshot stores `scoredPairs`/`judgedPairs`');
  out.push('  as running totals with no turn breakdown, so coverage is a single cell-level ratio. The snapshot\'s');
  out.push('  own as-of time (max `scores[].at`) is printed above.');
  out.push('- **Any quantity for a cell whose evidence is absent.** A missing run directory, `control.jsonl`,');
  out.push('  session store or rg snapshot is a hard error; the script never prints zeros for absent evidence.');
  out.push('- **A cached-hit/miss split for the System-1 lane.** `s1_call` records carry one `inputTokens` field');
  out.push('  with no cache breakdown, so the lane\'s tokens are reported as a single number.');
  out.push('- **The lane state when the plugin tape is missing.** `home/<cell>/.s1cap/tape.jsonl` is written only');
  out.push('  when observation is on. Without it the lane state falls back to the tape\'s `tuning-file` record,');
  out.push('  then to `provider` on the cell\'s `s1_call` records, and only then to the silence - which the report');
  out.push('  labels as inferred rather than configured.');
  out.push('- **Wall-clock exclusivity between System-1 time and LLM time.** Association judging runs concurrently');
  out.push('  with the request; the two sums overlap and must not be added together.');
  out.push('');

  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------
// 7. CSV rendering - one long-format sheet, so every figure in the tables is machine-readable
// ---------------------------------------------------------------------------------------------

function renderCsv(analysis) {
  const rows = [['cell', 'label', 'group', 'metric', 'unit', 'scope', 'turn', 'step', 'bucket', 'value']];
  for (const c of analysis.cells) {
    for (const m of METRICS) {
      const push = (scope, turn, step, bucket, value) => {
        if (value === null || value === undefined) return;
        rows.push([c.name, c.label, m.group, m.label, m.unit, scope, turn === null ? '' : turn, step === null ? '' : step, bucket, value]);
      };
      if (m.scopes.includes('cell')) push('cell', '', '', '', valueFor(m, c.a.totals));
      if (m.scopes.includes('turn')) {
        for (const t of c.a.turnList) push('turn', t.turn, '', '', valueFor(m, t));
      }
      if (m.scopes.includes('step')) {
        for (const s of c.a.steps) push('step', s.turn, s.step, '', valueFor(m, s));
        if (isS1Metric(m)) {
          for (const t of c.a.turnList) push('turn', t.turn, '', 'between-steps', valueFor(m, t.gap));
          push('idle', '', '', 'between-turns', valueFor(m, c.a.idle));
          push('tail', '', '', 'after-last-turn', valueFor(m, c.a.tail));
          push('pre', '', '', 'before-first-turn', valueFor(m, c.a.pre));
        }
      }
    }
    // diagnostics are emitted with their own metric names so a cost table can never absorb them
    const d = c.a.diagnostics;
    const noLane = d.laneAbsent || d.laneDemoted;
    const diag = [
      ['mechanism', 'System-1 lane', 'flag', d.laneLabel],
      ['mechanism', 'System-1 lane absent (zero by construction)', 'flag', d.laneAbsent ? 1 : 0],
      // A third flag rather than a reuse of the one above: `laneAbsent = 1` used to be the only way to say "there
      // were no calls", and it read the same for a control arm and for a cell whose backend was demoted by a
      // conflict - the conflation F3 is about. Every downstream consumer that reads only the CSV needs both.
      ['mechanism', 'System-1 lane demoted by a configuration conflict', 'flag', d.laneDemoted ? 1 : 0],
      ['mechanism', 'System-1 lane configured provider', 'flag', d.laneConfiguredProvider ?? ''],
      ['mechanism', 'System-1 lane provider', 'flag', d.laneProvider ?? ''],
      ['mechanism', 'System-1 lane conflicts', 'count', d.laneConflicts.length],
      ['mechanism', 'System-1 lane conflict detail', 'flag', d.laneConflicts.join(' | ')],
      ['mechanism', 'System-1 calls ok', 'count', noLane ? 0 : d.s1Ok],
      ['mechanism', 'System-1 calls refused', 'count', noLane ? 0 : d.s1Refused],
      ['mechanism', 'System-1 call success rate', 'ratio', d.s1SuccessRate],
      ['mechanism', 'association pairs scored', 'count', d.scoredPairs],
      ['mechanism', 'association pairs judged', 'count', d.judgedPairs],
      // F5: the fields a reader of *this file* needs to qualify the ratio below, and which the audit found entirely
      // absent from it. `deferredPairs` is omitted, not zeroed, when the snapshot predates the field - a 0 would
      // claim the run was never held back.
      ['mechanism', 'association pairs deferred', 'count', d.deferredRecorded ? d.deferredPairs : null],
      ['mechanism', 'association pairs offered (scored + deferred)', 'count', d.deferredRecorded ? d.offeredPairs : null],
      ['mechanism', 'deferred share of offered', 'ratio', d.deferredShare],
      ['mechanism', 'deferred pairs recorded by this snapshot', 'flag', d.deferredRecorded ? 1 : 0],
      // omitted rather than written as 0 when the lane is absent: a 0 here would be read as a measurement
      ['mechanism', 'System-1 coverage (judged/scored)', 'ratio', noLane ? null : d.coverage],
      // The floor's denominator (`FORMULAS.md`): a deferred pair is given back by the graph and never reaches
      // `scoredPairs`, so `judged/scored` can be raised by declining work. This ratio cannot.
      ['mechanism', 'System-1 coverage (judged/(scored+deferred))', 'ratio', d.coverageOffered],
      ['mechanism', 'System-1 coverage state', 'flag', d.laneDemoted
        ? 'undefined (lane demoted by a conflict)'
        : d.laneAbsent ? 'undefined (no S1 lane)' : 'defined'],
      // F9: `FORMULAS.md:431` requires these beside any run that lowered `w`. Omitted when the build did not write
      // them, so "the record cannot say" never arrives as "the event did not happen".
      ['mechanism', 'recall block source', 'flag', d.fallbackRecorded
        ? (d.fallbackSteps === 0 ? 'backend (no recency fallback)' : `recency-fallback on ${d.fallbackSteps} step(s)`)
        : null],
      ['mechanism', 'recall recency-fallback steps', 'count', d.fallbackRecorded ? d.fallbackSteps : null],
      ['mechanism', 'unjudged pairs admitted (unknownAdmitted)', 'count', d.unknownAdmittedTotal],
      ['mechanism', 'recall structure steps recorded', 'count', d.recallTreeRecorded ? d.recallTreeSteps : null],
      ['mechanism', 'recall structure nodes placed', 'count', d.recallTreeRecorded ? d.recallTreeNodes : null],
      ['mechanism', 'association edges from s1-noul', 'count', d.edgeSourceS1],
      ['mechanism', 'association edges from lexical', 'count', d.edgeSourceLexical],
      ['mechanism', 'context injections delivered', 'count', d.injections],
      ['mechanism', 'cache hit rate (NOT a cost metric)', 'ratio', d.cacheHitRate],
      ['mechanism', 'human messages', 'count', d.humanMessages],
      ['mechanism', 'injected messages', 'count', d.injectedMessages],
      ['provenance', 'rg snapshot as-of (epoch ms)', 'ms', d.rgAsOf],
      ['provenance', 'last session event (epoch ms)', 'ms', c.a.lastEventTime],
      ['provenance', 'last System-1 call (epoch ms)', 'ms', c.a.maxS1Ts],
    ];
    for (const [group, metric, unit, value] of diag) {
      if (value === null || value === undefined) continue;
      rows.push([c.name, c.label, group, metric, unit, 'diagnostic', '', '', '', value]);
    }
  }
  return rows.map((r) => r.map((v) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\n') + '\n';
}

// ---------------------------------------------------------------------------------------------
// 8. SVG rendering
//
// Self-contained: an opaque background, a `<style>` block with a generic font stack (no webfont,
// no CDN, no script), and geometry computed here. Metrics are grouped on one axis only when they
// share a unit - a chart that puts "steps" and "seconds" on one scale is not a comparison.
// ---------------------------------------------------------------------------------------------

const SVG_FONT = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

function niceStep(range, ticks) {
  if (range <= 0) return 1;
  const raw = range / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  for (const mult of [1, 2, 2.5, 5, 10]) {
    if (raw <= mag * mult) return mag * mult;
  }
  return mag * 10;
}

/**
 * One panel: grouped bars, one group per metric, one bar per cell, the value printed on each bar and
 * the unit in the axis label. Returns { svg, height }.
 */
function barPanel({ title, note, unit, metrics, cells, valueOf, labelFor, y, width }) {
  // `pad.top` carries the panel title, the note, and the headroom the rotated value labels need above
  // the tallest bar: a label anchored at the top of a full-height bar must still clear the note. It
  // grows with the note rather than the note being clipped to fit it - a caption that is cut off is
  // the failure this whole geometry pass exists to stop, and the band is the thing that can move.
  const noteLines = note ? wrapCaption(note, 132) : [];
  const padTop = 108 + (noteLines.length - 1) * 15;
  const pad = { left: 118, right: 30, top: padTop, bottom: 96 };
  const plotW = width - pad.left - pad.right;
  const plotH = 250;
  // Every coordinate below is PANEL-LOCAL: the panel's group carries `translate(0,y)` and is the one
  // and only place `y` is applied. Adding `y` here as well put each panel's body a full band too low -
  // invisible for panel 1, where y is 0, and wrong for every panel after it.
  const top = pad.top;
  const bottom = top + plotH;
  const unitSpec = SVG_PANEL_UNIT[unit];
  const out = [];

  let max = 0;
  for (const m of metrics) {
    for (const c of cells) {
      const v = valueOf(m.key, c.name);
      if (v !== null && v !== undefined && Number.isFinite(v)) max = Math.max(max, unitSpec.toAxis(v));
    }
  }
  const step = niceStep(max * 1.16 || 1, 5);
  const axisMax = Math.max(step, Math.ceil((max * 1.16) / step) * step);
  const ticks = [];
  // `+= step` accumulates float error over five or six additions (0.1 * 3 !== 0.30000000000000004
  // is exactly the kind of label that ends up on an axis), so the tick value is computed from the
  // index instead.
  const tickCount = Math.floor(axisMax / step + 1e-9);
  for (let i = 0; i <= tickCount; i += 1) ticks.push(i * step);

  const yOf = (v) => bottom - (v / axisMax) * plotH;
  const nGroups = metrics.length;
  const nBars = cells.length;
  const groupW = plotW / nGroups;
  const gap = nBars > 4 ? 4 : 6;
  const innerPad = Math.min(18, groupW * 0.10);
  // With one or two metrics in a panel the bars would otherwise sit as thin slivers in a wide plot,
  // which reads as "these numbers are small" rather than "there are few of them".
  const maxBarW = nGroups <= 2 ? 104 : nGroups <= 4 ? 76 : 66;
  const barW = Math.min(maxBarW, (groupW - 2 * innerPad - (nBars - 1) * gap) / nBars);

  // The band is declared on the group so the geometry can be read back out of the finished file and
  // checked without re-running the renderer: `--audit` and `--self-test` both parse these attributes.
  out.push(`<g class="panel" data-panel="${escapeXml(title)}" data-metrics="${metrics.length}" data-cells="${cells.length}" data-band-height="${pad.top + plotH + pad.bottom}" transform="translate(0,${y})">`);
  out.push(`  <text x="${pad.left}" y="30" class="panel-title">${escapeXml(title)}</text>`);
  noteLines.forEach((ln, i) => {
    out.push(`  <text x="${pad.left}" y="${56 + i * 15}" class="panel-note">${escapeXml(ln)}</text>`);
  });

  // legend, on the panel-title line: a long note under the title would otherwise run beneath it
  let lx = width - pad.right;
  for (let i = cells.length - 1; i >= 0; i -= 1) {
    const c = cells[i];
    const label = c.display;
    const w = 14 + 6 + label.length * 6.4;
    lx -= w + 14;
    out.push(`  <rect x="${lx}" y="18" width="13" height="13" rx="2" fill="${c.colour}"/>`);
    out.push(`  <text x="${lx + 19}" y="29" class="legend">${escapeXml(label)}</text>`);
  }

  // grid + tick labels + axis label
  for (const t of ticks) {
    const yy = yOf(t);
    out.push(`  <line x1="${pad.left}" y1="${yy.toFixed(1)}" x2="${pad.left + plotW}" y2="${yy.toFixed(1)}" class="grid"/>`);
    out.push(`  <text x="${pad.left - 10}" y="${(yy + 4).toFixed(1)}" class="tick" text-anchor="end">${escapeXml(unitSpec.fmtAxis(t))}</text>`);
  }
  out.push(`  <text x="${pad.left - 96}" y="${top + plotH / 2}" class="axis-label" text-anchor="middle" transform="rotate(-90 ${pad.left - 96} ${top + plotH / 2})">${escapeXml(unitSpec.axis)}</text>`);
  out.push(`  <line x1="${pad.left}" y1="${bottom}" x2="${pad.left + plotW}" y2="${bottom}" class="axis"/>`);

  metrics.forEach((m, gi) => {
    const gx = pad.left + gi * groupW;
    if (gi > 0) {
      out.push(`  <line x1="${(gx).toFixed(1)}" y1="${top}" x2="${(gx).toFixed(1)}" y2="${bottom}" class="grid-faint"/>`);
    }
    const barsW = nBars * barW + (nBars - 1) * gap;
    const startX = gx + (groupW - barsW) / 2;
    cells.forEach((c, ci) => {
      const raw = valueOf(m.key, c.name);
      const v = raw === null || raw === undefined || !Number.isFinite(raw) ? 0 : unitSpec.toAxis(raw);
      const h = axisMax > 0 ? Math.max(v > 0 ? 1.5 : 0, (v / axisMax) * plotH) : 0;
      const x = startX + ci * (barW + gap);
      const yTop = bottom - h;
      out.push(`  <rect x="${x.toFixed(1)}" y="${yTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="${c.colour}"/>`);
      const label = labelFor
        ? labelFor(m.key, c.name, raw, unitSpec.fmt(raw))
        : (raw === null || raw === undefined || !Number.isFinite(raw) ? 'n/a' : unitSpec.fmt(raw));
      const ly = Math.max(top + 2, yTop - 6);
      out.push(`  <text x="${(x + barW / 2 + 3.5).toFixed(1)}" y="${ly.toFixed(1)}" class="value" text-anchor="start" transform="rotate(-90 ${(x + barW / 2 + 3.5).toFixed(1)} ${ly.toFixed(1)})">${escapeXml(label)}</text>`);
    });
    // metric label under the group, wrapped to at most two lines
    const words = m.label.split(' ');
    const lines = [];
    let line = '';
    for (const w of words) {
      if ((line + ' ' + w).trim().length > 16 && line !== '') { lines.push(line); line = w; } else line = (line + ' ' + w).trim();
    }
    if (line) lines.push(line);
    lines.slice(0, 2).forEach((ln, li) => {
      out.push(`  <text x="${(gx + groupW / 2).toFixed(1)}" y="${(bottom + 20 + li * 14).toFixed(1)}" class="group-label" text-anchor="middle">${escapeXml(ln)}</text>`);
    });
  });

  out.push('</g>');
  return { svg: out.join('\n'), height: pad.top + plotH + pad.bottom };
}

function svgDocument({ title, subtitleGroups, panels, width }) {
  // The document is a header block, then the panels stacked with no gap and no overlap, then a footer
  // margin. `HEAD` depends on how many lines the caption wrapped to, and is emitted as the wrapper's
  // own offset so the audit can read it back rather than assume it.
  //
  // The caption arrives as groups rather than one string, and each group is wrapped on its own. That
  // is what keeps the release record readable: wrapped together with the rest, the harness's sentence
  // was split across a line break mid-sentence, so it neither read as one statement nor could be
  // matched against the wrapper's output as one.
  const FOOT = 40;
  const subLines = subtitleGroups.flatMap((g) => wrapCaption(g, 138));
  const HEAD = 52 + (subLines.length - 1) * 15;
  let y = 0;
  let body = '';
  for (const p of panels) {
    const r = barPanel({ ...p, y, width });
    body += r.svg + '\n';
    y += r.height;
  }
  const height = HEAD + y + FOOT;
  const style = `<style>
    text { font-family: ${SVG_FONT}; }
    .doc-title { fill: #171a1f; font-size: 19px; font-weight: 600; }
    .doc-sub { fill: #5c6675; font-size: 12px; }
    .panel-title { fill: #171a1f; font-size: 15px; font-weight: 600; }
    .panel-note { fill: #5c6675; font-size: 11px; }
    .legend { fill: #3b4553; font-size: 11.5px; }
    .tick { fill: #5c6675; font-size: 10.5px; }
    .axis-label { fill: #5c6675; font-size: 11px; letter-spacing: .06em; }
    .group-label { fill: #171a1f; font-size: 11.5px; }
    .value { fill: #171a1f; font-size: 10.5px; }
    .grid { stroke: #e3e8ef; stroke-width: 1; }
    .grid-faint { stroke: #f0f3f7; stroke-width: 1; }
    .axis { stroke: #9aa5b4; stroke-width: 1.2; }
  </style>`;
  const banner = '<!-- generated by scripts/cell-report.mjs (S1CAP cell report); self-contained, no script, no external font -->';
  return `${banner}
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>
  ${style}
  <text x="30" y="34" class="doc-title">${escapeXml(title)}</text>
${subLines.map((ln, i) => `  <text x="30" y="${54 + i * 15}" class="doc-sub">${escapeXml(ln)}</text>`).join('\n')}
  <g class="panels" transform="translate(0,${HEAD})">
${body}  </g>
</svg>
`;
}

// ---------------------------------------------------------------------------------------------
// 8b. Reading the geometry back out of a finished SVG
//
// The arithmetic was right and the drawing was wrong, which is the one failure a numeric self-test
// cannot see. So the geometry is asserted the same way the numbers are: by parsing the file that was
// actually written and checking that every bar and every value label an SVG contains lies inside the
// band of the panel that owns it - the panel whose heading names the series it draws.
//
// This reads attributes the renderer emits (`class="panel"`, `data-metrics`, `data-cells`,
// `data-band-height`), but it does NOT trust the declared band height: the height of every band
// except the last is derived from the next band's offset, the last is derived from the document
// height, and the declared value is only accepted if it agrees. A renderer that lies about its own
// geometry fails this check too.
// ---------------------------------------------------------------------------------------------

const SVG_HEAD = 52;
const SVG_FOOT = 40;
// A rotated value label is anchored at its baseline and runs upward. At the 10.5px the `.value`
// class sets, no glyph in these labels is wider than 6.1px (the widest are digits and commas), so
// `6.1 * length` is a conservative upper bound on how far above its anchor a label can reach.
const VALUE_LABEL_ADVANCE = 6.1;
// Horizontal budget per character, as a fraction of font size, for the horizontal containment check.
// Deliberately generous: the sans stack's average lowercase advance is ~0.50em and its digits ~0.55em,
// so 0.58em over-estimates a mixed caption by ~15% and a caption that passes has certainly fitted.
const TEXT_ADVANCE_EM = 0.58;

/** Font sizes declared by the document's own style block, so the estimate uses the real sizes. */
function styleFontSizes(text) {
  const style = /<style>([\s\S]*?)<\/style>/.exec(text);
  const sizes = new Map();
  if (!style) return sizes;
  for (const m of style[1].matchAll(/\.([a-z-]+)\s*\{([^}]*)\}/g)) {
    const fs = /font-size:\s*([\d.]+)px/.exec(m[2]);
    if (fs) sizes.set(m[1], Number(fs[1]));
  }
  return sizes;
}

/**
 * What kind of SVG is this?
 *
 * The audit owns the metric charts this tool writes, and only those. Two other generators write into
 * the same directory, and both legitimately have no panels to band-check:
 *
 *   - `cell-figure.mjs` writes a composition of a `foreignObject` header plus the three charts nested
 *     inside it. Counting it as a failure made the documented order (`report` -> `figure` -> `audit`)
 *     report a false alarm, so a composition is recognised and skipped with a note instead.
 *   - `s1-activity.mjs` writes a recall-activity matrix: rows are segments and columns are invocations,
 *     so its geometry is a grid of cells with its own self-test, not bands of bars on one axis. It
 *     declares itself with `data-chart="s1-activity"` on the root element and is skipped with a note.
 *     The marker is decisive and nothing else is: an SVG that merely resembles the matrix, or that
 *     carries no marker, is still 'unknown' and still fails — a chart the audit cannot place is
 *     exactly what it must not wave through.
 */
function classifySvg(text) {
  if (/<svg[^>]*\sdata-chart="s1-activity"/.test(text)) return 'activity';
  // A composition is tested for next, and decisively: it embeds whole chart documents, so it contains
  // their `class="panels"` wrappers too. Only a `foreignObject` plus nested `<svg>` children rules it
  // out as a chart, and no metric chart this tool writes has either.
  const nestedSvg = (text.match(/<svg[\s>]/g) || []).length;
  if (/<foreignObject[\s>]/.test(text) && nestedSvg >= 2) return 'composition';
  const hasPanelWrapper = /<g class="panels" transform="translate\(0,-?[\d.]+\)">/.test(text);
  const legacyGroups = [...text.matchAll(/<g(?: class="panel")? transform="translate\(0,(-?[\d.]+)\)">/g)].length;
  if (hasPanelWrapper || legacyGroups >= 2) return 'chart';
  return 'unknown';
}

function auditSvg(text) {
  const violations = [];
  const docHeight = Number(/<svg[^>]*\sheight="([\d.]+)"/.exec(text)?.[1]);
  const docWidth = Number(/<svg[^>]*\swidth="([\d.]+)"/.exec(text)?.[1]);
  const kind = classifySvg(text);
  if (kind === 'activity') {
    return {
      docHeight,
      docWidth,
      origin: null,
      bands: [],
      violations: [],
      ok: true,
      skipped: true,
      kind,
      texts: 0,
      legacy: false,
      reason: 'a recall-activity matrix (data-chart="s1-activity"): rows are segments and columns are recall '
        + 'invocations, a grid audited by `node scripts/s1-activity.mjs --self-test`, not bands of bars on one axis',
    };
  }
  if (kind === 'composition') {
    return {
      docHeight,
      docWidth,
      origin: null,
      bands: [],
      violations: [],
      ok: true,
      skipped: true,
      kind,
      texts: 0,
      legacy: false,
      reason: 'a composed figure: a foreignObject header with the metric charts nested inside it, so it has no '
        + 'top-level panels of its own - its panels are the charts it embeds, audited as the files beside it',
    };
  }
  if (!Number.isFinite(docHeight)) violations.push('document has no readable height attribute');

  // Panels carry `class="panel"` and the wrapper `class="panels"`. A chart written before those
  // attributes existed is still audited, because the defect this check exists for was shipped in one:
  // there the wrapper is the first `translate(0,y)` group and the panels are the rest, with neither
  // the declared height nor the expected bar count available - so those two checks are skipped and
  // the geometric ones, which are the ones that matter, are not.
  const groups = [...text.matchAll(/<g(?: class="(panel|panels)")? data-panel="[^"]*"| <g(?: class="(panel|panels)")?[^>]*transform="translate\(0,(-?[\d.]+)\)">/g)];
  const marks = [];
  let origin = null;
  let legacy = false;

  const modern = [...text.matchAll(/<g class="panels" transform="translate\(0,(-?[\d.]+)\)">/g)];
  if (modern.length === 1) {
    // `modern[0][1]` is the first match's first capture group; `modern[1]` would be the second match.
    origin = Number(modern[0][1]);
    for (const m of text.matchAll(/<g class="panel" data-panel="([^"]*)" data-metrics="(\d+)" data-cells="(\d+)" data-band-height="(\d+)" transform="translate\(0,(-?[\d.]+)\)">/g)) {
      marks.push({
        at: m.index,
        end: m.index + m[0].length,
        title: m[1],
        metrics: Number(m[2]),
        cells: Number(m[3]),
        declaredHeight: Number(m[4]),
        y: Number(m[5]),
      });
    }
    if (marks.length === 0) violations.push('document contains no panel group');
  } else {
    legacy = true;
    const plain = [...text.matchAll(/<g(?: class="panel")? transform="translate\(0,(-?[\d.]+)\)">/g)]
      .map((m) => ({ at: m.index, end: m.index + m[0].length, y: Number(m[1]), title: null, metrics: null, cells: null, declaredHeight: null }));
    if (plain.length < 2) {
      violations.push(modern.length > 1
        ? `document embeds ${modern.length} panel wrappers and has no foreignObject - it is neither a single chart nor a recognisable composition`
        : 'document has no readable panel structure');
      return { docHeight, docWidth, origin: null, bands: [], violations, ok: false, legacy };
    }
    origin = plain[0].y;
    for (let i = 1; i < plain.length; i += 1) {
      const body = text.slice(plain[i].end, i + 1 < plain.length ? plain[i + 1].at : text.length);
      const t = /class="panel-title">([^<]*)</.exec(body);
      marks.push({ ...plain[i], title: t ? t[1] : `panel ${i}` });
    }
  }

  const bands = marks.map((m, i) => {
    const bodyEnd = i + 1 < marks.length ? marks[i + 1].at : text.length;
    const body = text.slice(m.end, bodyEnd);
    // Bands are contiguous by construction: the next band starts where this one's height says it does.
    const derivedHeight = i + 1 < marks.length
      ? marks[i + 1].y - m.y
      : docHeight - origin - SVG_FOOT - m.y;
    const absTop = origin + m.y;
    const absBottom = absTop + derivedHeight;

    // Bars are the un-rounded rects; the only rounded rects a panel draws are legend swatches.
    const rects = [...body.matchAll(/<rect [^>]*\/>/g)].map((r) => {
      const t = r[0];
      return {
        x: Number(/x="(-?[\d.]+)"/.exec(t)[1]),
        y: Number(/y="(-?[\d.]+)"/.exec(t)[1]),
        w: Number(/width="([\d.]+)"/.exec(t)[1]),
        h: Number(/height="([\d.]+)"/.exec(t)[1]),
        legend: /\brx="/.test(t),
      };
    });
    const values = [...body.matchAll(/<text x="(-?[\d.]+)" y="(-?[\d.]+)" class="value"[^>]*>([^<]*)<\/text>/g)]
      .map((v) => ({ x: Number(v[1]), y: Number(v[2]), label: v[3] }));
    const lines = [...body.matchAll(/<line x1="(-?[\d.]+)" y1="(-?[\d.]+)" x2="(-?[\d.]+)" y2="(-?[\d.]+)"/g)]
      .map((l) => ({ y1: Number(l[2]), y2: Number(l[4]) }));

    if (!legacy && m.declaredHeight !== derivedHeight) {
      violations.push(`"${m.title}": declared band height ${m.declaredHeight} but the bands advance by ${derivedHeight}`);
    }
    if (m.y < 0) violations.push(`"${m.title}": band offset ${m.y} is negative`);
    if (i > 0 && marks[i - 1].y >= m.y) {
      violations.push(`"${m.title}": band offset ${m.y} does not advance past the previous band`);
    }
    // Every metric in this panel draws one bar per cell, plus one legend swatch per cell. A legacy
    // chart declares neither, so the weaker invariant is used there: every bar carries its number.
    const bars = rects.filter((r) => !r.legend);
    if (!legacy) {
      const expectedBars = m.metrics * m.cells;
      if (bars.length !== expectedBars) {
        violations.push(`"${m.title}": ${bars.length} bar(s) drawn for ${m.metrics} metric(s) x ${m.cells} cell(s) = ${expectedBars}`);
      }
      if (values.length !== expectedBars) {
        violations.push(`"${m.title}": ${values.length} value label(s) for ${expectedBars} bar(s)`);
      }
    } else if (bars.length !== values.length) {
      violations.push(`"${m.title}": ${bars.length} bar(s) but ${values.length} value label(s)`);
    }
    for (const r of bars) {
      const yTop = absTop + r.y;
      if (yTop < absTop - 1e-6 || yTop + r.h > absBottom + 1e-6) {
        violations.push(`"${m.title}": bar y=${yTop.toFixed(1)}..${(yTop + r.h).toFixed(1)} outside band ${absTop}..${absBottom}`);
      }
    }
    for (const v of values) {
      const yAnchor = absTop + v.y;
      const yReach = yAnchor - v.label.length * VALUE_LABEL_ADVANCE;
      if (yAnchor > absBottom + 1e-6 || yReach < absTop - 1e-6) {
        violations.push(`"${m.title}": label "${v.label}" occupies y=${yReach.toFixed(1)}..${yAnchor.toFixed(1)} outside band ${absTop}..${absBottom}`);
      }
    }
    for (const l of lines) {
      for (const ly of [l.y1, l.y2]) {
        const abs = absTop + ly;
        if (abs < absTop - 1e-6 || abs > absBottom + 1e-6) {
          violations.push(`"${m.title}": grid/axis line y=${abs.toFixed(1)} outside band ${absTop}..${absBottom}`);
        }
      }
    }
    return {
      title: m.title,
      offset: m.y,
      height: derivedHeight,
      declaredHeight: m.declaredHeight,
      absTop,
      absBottom,
      metrics: m.metrics,
      cells: m.cells,
      bars: bars.length,
      labels: values.length,
      lines: lines.length,
      barSpan: bars.length > 0 ? [absTop + Math.min(...bars.map((r) => r.y)), absTop + Math.max(...bars.map((r) => r.y + r.h))] : null,
      labelSpan: values.length > 0 ? [absTop + Math.min(...values.map((v) => v.y)), absTop + Math.max(...values.map((v) => v.y))] : null,
    };
  });

  const sum = bands.reduce((a, b) => a + b.height, 0);
  if (Number.isFinite(docHeight) && docHeight !== origin + sum + SVG_FOOT) {
    violations.push(`document height ${docHeight} is not origin ${origin} + bands ${sum} + footer ${SVG_FOOT}`);
  }
  if (bands.length > 0 && bands[0].offset !== 0) {
    violations.push(`first band starts at ${bands[0].offset}, not 0`);
  }

  // Horizontal containment. The same class of defect as a double-translated panel is a caption wider
  // than the page: nothing throws, the browser clips it, and the sentence just stops mid-word. Every
  // non-rotated text is measured against the document width with a deliberately generous advance.
  const fontSizes = styleFontSizes(text);
  const horiz = [];
  for (const m of text.matchAll(/<text x="(-?[\d.]+)" y="(-?[\d.]+)" class="([a-z-]+)"([^>]*)>([^<]*)<\/text>/g)) {
    const cls = m[3];
    if (cls === 'value' || cls === 'axis-label') continue; // rotated: covered by the vertical check
    const size = fontSizes.get(cls);
    if (size === undefined) continue;
    const x = Number(m[1]);
    const content = m[5];
    const w = content.length * size * TEXT_ADVANCE_EM;
    const anchor = /text-anchor="end"/.test(m[4]) ? 'end' : /text-anchor="middle"/.test(m[4]) ? 'middle' : 'start';
    const left = anchor === 'start' ? x : anchor === 'end' ? x - w : x - w / 2;
    const right = left + w;
    horiz.push({ cls, content, left, right });
    if (left < -1 || right > docWidth + 1) {
      violations.push(`text "${content.slice(0, 40)}${content.length > 40 ? '…' : ''}" (class ${cls}) spans x=${left.toFixed(0)}..${right.toFixed(0)}, outside the document width 0..${docWidth}`);
    }
  }

  return { docHeight, docWidth, origin, bands, violations, ok: violations.length === 0, legacy, kind, skipped: false, texts: horiz.length };
}

/** Human-readable audit, used by `--audit` and quoted in the self-test output. */
function formatAudit(name, audit) {
  if (audit.skipped) {
    return `${name}: SKIPPED  ${audit.reason}`;
  }
  const lines = [`${name}: ${audit.ok ? 'OK' : `FAIL (${audit.violations.length})`}  doc ${audit.docWidth}x${audit.docHeight}, origin ${audit.origin}, ${audit.bands.length} panel(s)${audit.legacy ? ' [pre-band-attribute chart: heights derived from the offsets]' : ''}`];
  for (const b of audit.bands) {
    lines.push(
      `  band [${b.absTop}..${b.absBottom}) h=${b.height}${b.declaredHeight === null ? '' : ` (declared ${b.declaredHeight})`} "${b.title}"` +
        ` bars=${b.bars}${b.metrics === null ? '' : `/${b.metrics * b.cells}`} labels=${b.labels}` +
        ` barSpan=${b.barSpan ? `${b.barSpan[0].toFixed(1)}..${b.barSpan[1].toFixed(1)}` : '-'}` +
        ` labelSpan=${b.labelSpan ? `${b.labelSpan[0].toFixed(1)}..${b.labelSpan[1].toFixed(1)}` : '-'}`,
    );
  }
  for (const v of audit.violations) lines.push(`  ! ${v}`);
  return lines.join('\n');
}

function renderSvgs(analysis) {
  const { cells, runDir, snapshotAt, dsh } = analysis;
  const width = 1120;
  const svgCells = cells.map((c, i) => ({
    name: c.name,
    display: c.label !== c.name ? `${c.label} (${c.name})` : c.name,
    colour: CELL_COLOURS[i % CELL_COLOURS.length],
    laneAbsent: c.a.diagnostics.laneAbsent,
    laneDemoted: c.a.diagnostics.laneDemoted,
  }));
  // A chart gets screenshotted and forwarded on its own, so the release and the model travel with it
  // as their own caption group, second - after the run directory and before anything else - where no
  // wrap can push them off the end and where the harness's sentence stays on one line.
  const sub = () => `run ${runDir}`;
  const prov = () => dshCaptionGroups(dsh);
  /**
   * A System-1 bar of zero is labelled with why it is zero, exactly as in the tables: a bar that says
   * `0 (no lane)` and a bar that says `0 (lane, 0 ok)` are different findings and must not be drawn
   * the same way.
   */
  const s1Label = (key, name, raw, text) => {
    const cell = cells.find((x) => x.name === name);
    if (!cell) return text;
    if (cell.a.diagnostics.laneDemoted) return `${text} (lane demoted)`;
    if (cell.a.diagnostics.laneAbsent) return `${text} (no lane)`;
    if (text === '0') return '0 (lane, 0 ok)';
    return text;
  };

  const timeMetrics = METRICS.filter((m) => m.group === 'time' && m.scopes.includes('cell'));
  const countMetrics = timeMetrics.filter((m) => m.unit === 'count' && m.key !== 'turnFrameMs' && m.key !== 'stepFrameMs' && m.key !== 'idleMs');
  // The durations are split by what they measure, not by how big they are. `LLM time`, `other tool
  // time` and the step frame are wall-clock segments of the same step and can be read against each
  // other; `System-1 time` is a sum of latencies of calls that run *concurrently* with the request,
  // so it can exceed the step's own width and putting it on the same axis would invite adding it in.
  const wallClockMetrics = timeMetrics.filter((m) => ['llmMs', 'toolMs', 'stepFrameMs', 'idleMs'].includes(m.key));
  const s1DurationMetrics = timeMetrics.filter((m) => m.key === 's1Ms');
  const costMetrics = METRICS.filter((m) => m.group === 'cost' && m.scopes.includes('cell'));

  const laneSummary = cells
    .map((c) => {
      const d = c.a.diagnostics;
      const name = c.label !== c.name ? c.label : c.name;
      if (d.laneDemoted) return `${name}: S1 lane DEMOTED to none by a conflict (configured ${d.laneConfiguredProvider})`;
      if (d.laneAbsent) return `${name}: no S1 lane`;
      return `${name}: S1 ${d.laneProvider ?? 'present'}`;
    })
    .join(' · ');

  const valueOfFrom = (totalsOf) => (key, name) => {
    const c = cells.find((x) => x.name === name);
    if (!c) return null;
    const scope = totalsOf(c);
    if (!scope) return null;
    const v = scope[key];
    return v === undefined ? null : v;
  };

  const timeSvg = svgDocument({
    title: 'S1CAP cell report - time',
    subtitleGroups: [
      sub(),
      ...prov(),
      `group: time · one group per metric, one bar per cell · snapshot ${snapshotAt}`,
      laneSummary,
    ],
    width,
    panels: [
      {
        title: 'Time - counts',
        note: 'System-1 calls counted from the control plane (refusals included); the rest from the session store.',
        unit: 'count',
        metrics: countMetrics.map((m) => ({ key: m.key, label: m.label })),
        cells: svgCells,
        valueOf: valueOfFrom((c) => c.a.totals),
        labelFor: s1Label,
      },
      {
        title: 'Time - wall clock (the step, decomposed)',
        note: 'LLM time = assistant/message − step/start; tool time = tool/result − tool/call; step frame = step/end − step/start; idle = the turn\'s gaps between steps. These four are segments of the same clock and can be read against each other.',
        unit: 'ms',
        metrics: wallClockMetrics.map((m) => ({ key: m.key, label: m.label })),
        cells: svgCells,
        valueOf: valueOfFrom((c) => c.a.totals),
        labelFor: s1Label,
      },
      {
        title: 'Time - System-1 lane (concurrent, not additive)',
        note: 'The plugin\'s own reported ms per call, summed. Association judging runs concurrently with the request, so this is NOT a segment of the step frame and must not be added to the panel above. A cell with no lane reports 0.',
        unit: 'ms',
        metrics: s1DurationMetrics.map((m) => ({ key: m.key, label: m.label })),
        cells: svgCells,
        valueOf: valueOfFrom((c) => c.a.totals),
        labelFor: s1Label,
      },
    ],
  });

  const costSvg = svgDocument({
    title: 'S1CAP cell report - cost',
    subtitleGroups: [
      sub(),
      ...prov(),
      `group: cost · one group per metric, one bar per cell · snapshot ${snapshotAt}`,
      `cache hit rate is a mechanism diagnostic and is deliberately NOT in this chart`,
      laneSummary,
    ],
    width,
    panels: [
      {
        title: 'Cost - tokens',
        note: 'hit = usage.cacheReadTokens, miss = usage.inputTokens (uncached remainder), output = usage.outputTokens, System-1 lane = Σ s1_call input+output.',
        unit: 'token',
        metrics: costMetrics.map((m) => ({ key: m.key, label: m.label })),
        cells: svgCells,
        valueOf: valueOfFrom((c) => c.a.totals),
        labelFor: s1Label,
      },
    ],
  });

  const governanceSvg = svgDocument({
    title: 'S1CAP cell report - System-1 governance (mechanism, not cost)',
    subtitleGroups: [
      sub(),
      ...prov(),
      `group: mechanism · one group per metric, one bar per cell · snapshot ${snapshotAt}`,
      `coverage = judgedPairs / scoredPairs; the floor is defined over judgedPairs / (scoredPairs + deferredPairs)`,
      laneSummary,
    ],
    width,
    panels: [
      {
        title: 'System-1 governance',
        note: 'coverage is the share of scored association pairs the backend actually judged; "over offered" adds the deferred pairs the gate held back, which is the denominator FORMULAS.md sets the 0.5 floor over. A cell with no lane has no coverage at all - not a coverage of zero - so its bar is absent, and a cell whose lane was demoted by a conflict is absent for a different reason.',
        unit: 'ratio',
        metrics: [
          { key: 'coverage', label: 'System-1 coverage (judged/scored)' },
          // F5: the floor's denominator drawn beside the ratio it qualifies. `judged/scored` *rises* when the gate
          // holds work back, so a chart showing only it can make a cell that stopped asking look healthier than one
          // that kept asking and was refused. This series cannot be raised by declining work.
          { key: 'coverageOffered', label: 'coverage over offered (judged/(scored+deferred))' },
          { key: 'deferredShare', label: 'deferred share of the offered window' },
          { key: 's1SuccessRate', label: 'System-1 call success rate' },
          { key: 'cacheHitRate', label: 'cache hit rate (diagnostic only)' },
        ],
        cells: svgCells,
        valueOf: (key, name) => {
          const c = cells.find((x) => x.name === name);
          return c ? c.a.diagnostics[key] : null;
        },
        labelFor: (key, name, raw, text) => {
          const cell = cells.find((x) => x.name === name);
          if (raw === null || raw === undefined) {
            if (!cell) return 'n/a';
            if (cell.a.diagnostics.laneDemoted && (key === 'coverage' || key === 's1SuccessRate')) {
              return 'n/a (lane demoted)';
            }
            if (cell.a.diagnostics.laneAbsent && (key === 'coverage' || key === 's1SuccessRate')) {
              return 'n/a (no lane)';
            }
            // A coverage over the offered window that is absent because the snapshot predates `deferredPairs` and
            // one that is absent because there were no pairs at all are different readings. Both draw as `n/a`; the
            // markdown and the CSV carry which one it is.
            return 'n/a';
          }
          return text;
        },
      },
    ],
  });

  return { 'time.svg': timeSvg, 'cost.svg': costSvg, 's1-governance.svg': governanceSvg };
}

// ---------------------------------------------------------------------------------------------
// 9. Argument parsing
// ---------------------------------------------------------------------------------------------

const USAGE = `Usage:
  node scripts/cell-report.mjs --run <dir> --cells <names> [--label old=new,...] [--out <dir>] [--format md|csv|svg|all]
  node scripts/cell-report.mjs --self-test

  --run <dir>       finished run directory: expects <dir>/evidence/<cell>/control.jsonl,
                    <dir>/home/<cell>/sessions/**/session.v4.jsonl.zstd and <dir>/home/<cell>/.s1cap/rg/*.json
  --cells <names>   comma-separated cell names, e.g. C1,C2,C3,C4
  --label <map>     display labels, old=new,... e.g. --label C1=baseline,C2=TAS,C3=recall-only,C4=full
  --out <dir>       output directory for generated files (default ./s1cap-report)
  --format <list>   md | csv | svg | all (default all)
  --audit <files>   read finished SVG(s) back and check each panel's geometry, then exit
  --quiet           do not print the markdown report to stdout
  --self-test       build a synthetic run under the OS temp directory and assert the arithmetic
`;

/**
 * Wrap a caption into lines of at most `maxChars` characters, breaking on spaces.
 *
 * Captions used to be emitted as one line and simply ran off the right edge of the document, where a
 * viewer clips them silently. This returns as many lines as the text needs and never drops any: an
 * earlier version stopped at a fixed line cap, which would now quietly delete the release record off
 * the end of a long subtitle. The audit measures every line and rejects anything that still overflows.
 */
function wrapCaption(text, maxChars) {
  const words = String(text).split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    if (line !== '' && (line + ' ' + w).length > maxChars) {
      lines.push(line);
      line = w;
    } else {
      line = line === '' ? w : `${line} ${w}`;
    }
  }
  if (line !== '') lines.push(line);
  return lines.length > 0 ? lines : [''];
}

function parseArgs(argv) {
  const opts = { cells: [], label: new Map(), format: null, out: null, run: null, quiet: false, selfTest: false, audit: [], help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) fail(`missing value for ${a}`);
      return argv[i];
    };
    switch (a) {
      case '--run': opts.run = next(); break;
      case '--cells': opts.cells.push(...next().split(',').map((s) => s.trim()).filter(Boolean)); break;
      case '--label': {
        for (const part of next().split(',').map((s) => s.trim()).filter(Boolean)) {
          const eq = part.indexOf('=');
          if (eq <= 0) fail(`--label expects old=new pairs, got "${part}"`);
          opts.label.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
        }
        break;
      }
      case '--out': opts.out = next(); break;
      case '--format': {
        const vals = next().split(',').map((s) => s.trim()).filter(Boolean);
        for (const v of vals) {
          if (!['md', 'csv', 'svg', 'all'].includes(v)) fail(`--format expects md|csv|svg|all, got "${v}"`);
        }
        opts.format = opts.format || new Set();
        for (const v of vals) {
          if (v === 'all') for (const x of ['md', 'csv', 'svg']) opts.format.add(x);
          else opts.format.add(v);
        }
        break;
      }
      case '--quiet': opts.quiet = true; break;
      case '--audit': {
        // one or more paths, comma-separated or repeated; a directory audits every *.svg inside it
        for (const p of next().split(',').map((s) => s.trim()).filter(Boolean)) opts.audit.push(p);
        break;
      }
      case '--self-test': opts.selfTest = true; break;
      case '-h': case '--help': opts.help = true; break;
      default: fail(`unknown argument "${a}"\n\n${USAGE}`);
    }
  }
  if (!opts.format) opts.format = new Set(['md', 'csv', 'svg']);
  return opts;
}

// ---------------------------------------------------------------------------------------------
// 10. Top-level analysis driver
// ---------------------------------------------------------------------------------------------

function analyseRun(runDir, cellNames, labelMap, snapshotAt) {
  if (!existsSync(runDir)) fail(`run directory not found: ${runDir}`);
  if (cellNames.length === 0) fail('no cells requested: pass --cells <names>');
  const cells = cellNames.map((name) => {
    const cell = loadCell(runDir, name, labelMap);
    return { ...cell, a: aggregate(cell) };
  });
  const warnings = cells.flatMap((c) => c.warnings.concat(c.a.warnings));
  // The round's software identity is a property of the round, not of a cell: it is read once here and
  // carried on the report header and on every chart subtitle.
  const dsh = readDshRecord(runDir);
  if (!dsh.present) warnings.push(`round release record unavailable (${dsh.reason}): ${UNKNOWN_RELEASE}`);
  return { runDir, snapshotAt, cells, warnings, dsh };
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`cell-report: ${err.message}`);
    process.exit(2);
  }
  if (opts.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (opts.selfTest) {
    runSelfTest();
    return;
  }
  if (opts.audit.length > 0) {
    runAudit(opts.audit);
    return;
  }
  if (!opts.run) {
    console.error(`cell-report: --run is required\n\n${USAGE}`);
    process.exit(2);
  }
  const runDir = resolve(opts.run);
  const snapshotAt = new Date().toISOString();
  let analysis;
  try {
    analysis = analyseRun(runDir, opts.cells, opts.label, snapshotAt);
  } catch (err) {
    if (err.isReportError) {
      console.error(`cell-report: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const md = renderMarkdown(analysis);
  if (!opts.quiet) process.stdout.write(md + '\n');

  const outDir = resolve(opts.out || join(process.cwd(), 's1cap-report'));
  const written = [];
  mkdirSync(outDir, { recursive: true });
  if (opts.format.has('md')) {
    writeFileSync(join(outDir, 'cell-report.md'), md + '\n', 'utf8');
    written.push(join(outDir, 'cell-report.md'));
  }
  if (opts.format.has('csv')) {
    writeFileSync(join(outDir, 'cell-report.csv'), renderCsv(analysis), 'utf8');
    written.push(join(outDir, 'cell-report.csv'));
  }
  if (opts.format.has('svg')) {
    for (const [name, content] of Object.entries(renderSvgs(analysis))) {
      writeFileSync(join(outDir, name), content, 'utf8');
      written.push(join(outDir, name));
    }
  }
  process.stderr.write(`cell-report: wrote ${written.length} file(s) under ${outDir}\n`);
  for (const w of written) process.stderr.write(`  ${w}\n`);
  for (const w of analysis.warnings) process.stderr.write(`warning: ${w}\n`);
}

// ---------------------------------------------------------------------------------------------
// 10b. --audit: read finished SVGs back and check their geometry
// ---------------------------------------------------------------------------------------------

function runAudit(paths) {
  const files = [];
  for (const p of paths) {
    const abs = resolve(p);
    if (!existsSync(abs)) {
      console.error(`cell-report --audit: no such file or directory: ${abs}`);
      process.exit(1);
    }
    if (statSync(abs).isDirectory()) {
      for (const f of walkFiles(abs).filter((x) => x.toLowerCase().endsWith('.svg'))) files.push(f);
    } else {
      files.push(abs);
    }
  }
  if (files.length === 0) {
    console.error('cell-report --audit: nothing to audit');
    process.exit(1);
  }
  let bad = 0;
  let skipped = 0;
  let charts = 0;
  for (const f of files.sort()) {
    const audit = auditSvg(readFileSync(f, 'utf8'));
    if (audit.skipped) skipped += 1;
    else {
      charts += 1;
      if (!audit.ok) bad += 1;
    }
    process.stdout.write(`${formatAudit(f, audit)}\n`);
  }
  const skipNote = `${skipped} skipped (not a metric chart - see the note above)`;
  process.stdout.write(charts === 0
    ? `cell-report --audit: nothing to audit, ${skipNote}\n`
    : `cell-report --audit: ${charts - bad}/${charts} chart(s) OK${skipped > 0 ? `, ${skipNote}` : ''}\n`);
  process.exit(bad === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------------------------
// 11. --self-test
//// Builds a real run directory under the OS temp directory - real multi-frame zstd session stores,
// real control.jsonl, real rg snapshot - and runs the same load/aggregate path the report uses.
// This checks the arithmetic without the caller's scratch data, and it is the only test this script
// needs, because nothing outside this file is exercised.
// ---------------------------------------------------------------------------------------------

function assertEqual(actual, expected, what) {
  if (actual !== expected) {
    throw new Error(`self-test FAILED: ${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertTrue(cond, what) {
  if (!cond) throw new Error(`self-test FAILED: ${what}`);
}

function zstdFrames(text, chunkLines) {
  const lines = text.split('\n');
  const frames = [];
  for (let i = 0; i < lines.length; i += chunkLines) {
    const chunk = lines.slice(i, i + chunkLines).join('\n');
    if (chunk.trim() === '') continue;
    frames.push(zstdCompressSync(Buffer.from(chunk + '\n', 'utf8')));
  }
  return Buffer.concat(frames);
}

function buildSyntheticRun(root) {
  // --- cell A: 2 turns, 3 steps, known token/ms arithmetic ------------------------------------
  const A = [];
  const ev = (type, time, data, extra) => A.push({ type, time, seq: A.length, data, ...(extra || {}) });
  const sessionA = { type: 'session', version: 4, id: 'session-aaaa', createdAt: 900 };
  A.push(sessionA);
  ev('turn/start', 1000, { turn: 1 });
  ev('user/message', 1001, { content: [{ type: 'text', text: 'human one' }], source: { kind: 'user' } });
  ev('user/message', 1002, { content: [{ type: 'text', text: 'Current runtime context...' }], source: { kind: 'runtime-context' } });
  ev('user/message', 1003, { content: [{ type: 'text', text: '<system-reminder>...' }], source: { kind: 'skill-catalog' } });
  ev('step/start', 1010, { turn: 1, step: 1 });
  ev('assistant/message', 1110, { turn: 1, step: 1, message: { role: 'assistant', content: [] }, usage: { inputTokens: 10, cacheReadTokens: 100, outputTokens: 5, totalTokens: 115 } });
  ev('tool/call', 1115, { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{}' });
  ev('tool/result', 1135, { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1', content: [], id: 'm1' } });
  ev('step/end', 1140, { turn: 1, step: 1 });
  ev('step/start', 1150, { turn: 1, step: 2 });
  ev('assistant/message', 1350, { turn: 1, step: 2, message: { role: 'assistant', content: [] }, usage: { inputTokens: 20, cacheReadTokens: 200, outputTokens: 6, totalTokens: 226 } });
  ev('step/end', 1355, { turn: 1, step: 2 });
  ev('turn/end', 1400, { turn: 1, reason: { kind: 'completed' } });
  ev('turn/start', 1500, { turn: 2 });
  ev('user/message', 1501, { content: [{ type: 'text', text: 'human two' }], source: { kind: 'user' } });
  ev('step/start', 1510, { turn: 2, step: 1 });
  ev('assistant/message', 1810, { turn: 2, step: 1, message: { role: 'assistant', content: [] }, usage: { inputTokens: 30, cacheReadTokens: 300, outputTokens: 7, totalTokens: 337 } });
  ev('tool/call', 1815, { turn: 2, step: 1, callId: 'c2', name: 'write', arguments: '{}' });
  ev('tool/result', 1845, { turn: 2, step: 1, message: { role: 'tool', toolCallId: 'c2', content: [], id: 'm2' } });
  ev('step/end', 1850, { turn: 2, step: 1 });
  ev('turn/end', 1900, { turn: 2, reason: { kind: 'completed' } });

  const controlA = [
    { type: 'assembly', schema: 1, ts: 1005, sessionId: 'session-aaaa', seq: 0, candidates: 2, selected: 1 },
    { type: 'context_delivery', schema: 1, ts: 1006, sessionId: 'session-aaaa', cell: 'A', delivered: true, reason: 'inserted', blocks: ['recalled'] },
    { type: 'assembly', schema: 1, ts: 1145, sessionId: 'session-aaaa', seq: 1, candidates: 1, selected: 1 },
    { type: 'context_delivery', schema: 1, ts: 1146, sessionId: 'session-aaaa', cell: 'A', delivered: false, reason: 'nothing to insert', blocks: [] },
    { type: 'assembly', schema: 1, ts: 1505, sessionId: 'session-aaaa', seq: 2, candidates: 3, selected: 2 },
    { type: 'context_delivery', schema: 1, ts: 1506, sessionId: 'session-aaaa', cell: 'A', delivered: true, reason: 'inserted', blocks: ['recalled'] },
    { type: 's1_call', schema: 1, ts: 1050, sessionId: 'session-aaaa', provider: 'laya-serve', role: 'assoc', kind: 'noul', questions: 1, inputTokens: 7, outputTokens: 0, ms: 10, ok: true },
    { type: 's1_call', schema: 1, ts: 1060, sessionId: 'session-aaaa', provider: 'laya-serve', role: 'assoc', kind: 'noul', questions: 2, inputTokens: 8, outputTokens: 1, ms: 20, ok: true },
    { type: 's1_call', schema: 1, ts: 1200, sessionId: 'session-aaaa', provider: 'laya-serve', role: 'assoc', kind: 'noul', questions: 1, inputTokens: 9, outputTokens: 0, ms: 5, ok: true },
    // lands between turn 1's end and turn 2's start: no turn owns it, so it must appear as its own row
    { type: 's1_call', schema: 1, ts: 1450, sessionId: 'session-aaaa', provider: 'laya-serve', role: 'assoc', kind: 'noul', questions: 1, inputTokens: 3, outputTokens: 0, ms: 15, ok: true },
    // arrives after the last turn/end: asynchronous association-graph upkeep
    { type: 's1_call', schema: 1, ts: 2000, sessionId: 'session-aaaa', provider: 'laya-serve', role: 'assoc', kind: 'noul', questions: 1, inputTokens: 0, outputTokens: 0, ms: 40, ok: false, error: 'S1HttpError: systemone 503: server busy' },
  ];
  const rgA = {
    schema: 2, sessionId: 'session-aaaa', scoredPairs: 10, judgedPairs: 5,
    order: ['a', 'b'], segments: [],
    edges: [{ from: 'a', to: 'b', w: 0.5, source: 's1-noul', verifiedAt: 1200 }, { from: 'b', to: 'a', w: 0.4, source: 'lexical', verifiedAt: 1201 }],
    scores: [{ from: 'a', to: 'b', w: 0.5, source: 's1-noul', at: 1900 }],
  };

  // --- cell B: 1 turn, 1 step - proves the per-step tables leave holes rather than shifting rows --
  const B = [];
  const evB = (type, time, data, extra) => B.push({ type, time, seq: B.length, data, ...(extra || {}) });
  B.push({ type: 'session', version: 4, id: 'session-bbbb', createdAt: 900 });
  evB('turn/start', 1000, { turn: 1 });
  evB('user/message', 1001, { content: [{ type: 'text', text: 'human' }], source: { kind: 'user' } });
  evB('step/start', 1010, { turn: 1, step: 1 });
  evB('assistant/message', 1030, { turn: 1, step: 1, message: { role: 'assistant', content: [] }, usage: { inputTokens: 1, cacheReadTokens: 5, outputTokens: 2, totalTokens: 8 } });
  evB('step/end', 1035, { turn: 1, step: 1 });
  evB('turn/end', 1040, { turn: 1, reason: { kind: 'completed' } });
  const controlB = [
    { type: 'assembly', schema: 1, ts: 1005, sessionId: 'session-bbbb', seq: 0, candidates: 0, selected: 0 },
    { type: 'context_delivery', schema: 1, ts: 1006, sessionId: 'session-bbbb', cell: 'B', delivered: false, reason: 'the decision carried no messages', blocks: [] },
    { type: 's1_call', schema: 1, ts: 1015, sessionId: 'session-bbbb', provider: 'laya-serve', role: 'assoc', kind: 'noul', questions: 1, inputTokens: 0, outputTokens: 0, ms: 0, ok: false, error: 'S1HttpError: systemone 503: server busy' },
    { type: 's1_call', schema: 1, ts: 1016, sessionId: 'session-bbbb', provider: 'laya-serve', role: 'assoc', kind: 'noul', questions: 1, inputTokens: 11, outputTokens: 0, ms: 4, ok: true },
  ];
  const rgB = { schema: 2, sessionId: 'session-bbbb', scoredPairs: 4, judgedPairs: 1, order: ['a'], segments: [], edges: [], scores: [] };

  // --- cell E: no System-1 lane at all (`s1.provider: "none"`), stated by the wiring record -------
  const E = [];
  const evE = (type, time, data) => E.push({ type, time, seq: E.length, data });
  E.push({ type: 'session', version: 4, id: 'session-eeee', createdAt: 900 });
  evE('turn/start', 1000, { turn: 1 });
  evE('user/message', 1001, { content: [{ type: 'text', text: 'human' }], source: { kind: 'user' } });
  evE('step/start', 1010, { turn: 1, step: 1 });
  evE('assistant/message', 1030, { turn: 1, step: 1, message: { role: 'assistant', content: [] }, usage: { inputTokens: 2, cacheReadTokens: 10, outputTokens: 1, totalTokens: 13 } });
  evE('step/end', 1035, { turn: 1, step: 1 });
  evE('turn/end', 1040, { turn: 1, reason: { kind: 'completed' } });
  const controlE = [
    { type: 'assembly', schema: 1, ts: 1005, sessionId: 'session-eeee', seq: 0, candidates: 0, selected: 0 },
    { type: 'context_delivery', schema: 1, ts: 1006, sessionId: 'session-eeee', cell: 'E', delivered: false, reason: 'the decision carried no messages', blocks: [] },
  ];
  const rgE = {
    schema: 2, sessionId: 'session-eeee', scoredPairs: 8, judgedPairs: 0, order: ['a', 'b', 'c'], segments: [],
    edges: [
      { from: 'a', to: 'b', w: 0.3, source: 'lexical', verifiedAt: 1030 },
      { from: 'b', to: 'c', w: 0.2, source: 'lexical', verifiedAt: 1031 },
      { from: 'a', to: 'c', w: 0.1, source: 'lexical', verifiedAt: 1032 },
    ],
    scores: [{ from: 'a', to: 'b', w: 0.3, source: 'lexical', at: 1032 }],
  };
  const tapeE = [{ schema: 0, kind: 'wiring', s1: 'none', relevance: false, xFirst: false }];

  // --- cell F: a lane that exists and refused every call -----------------------------------------
  const F = [];
  const evF = (type, time, data) => F.push({ type, time, seq: F.length, data });
  F.push({ type: 'session', version: 4, id: 'session-ffff', createdAt: 900 });
  evF('turn/start', 1000, { turn: 1 });
  evF('user/message', 1001, { content: [{ type: 'text', text: 'human' }], source: { kind: 'user' } });
  evF('step/start', 1010, { turn: 1, step: 1 });
  evF('assistant/message', 1030, { turn: 1, step: 1, message: { role: 'assistant', content: [] }, usage: { inputTokens: 2, cacheReadTokens: 10, outputTokens: 1, totalTokens: 13 } });
  evF('step/end', 1035, { turn: 1, step: 1 });
  evF('turn/end', 1040, { turn: 1, reason: { kind: 'completed' } });
  const controlF = [
    { type: 'assembly', schema: 1, ts: 1005, sessionId: 'session-ffff', seq: 0, candidates: 1, selected: 1 },
    { type: 'context_delivery', schema: 1, ts: 1006, sessionId: 'session-ffff', cell: 'F', delivered: false, reason: 'the decision carried no messages', blocks: [] },
    { type: 's1_call', schema: 1, ts: 1012, sessionId: 'session-ffff', provider: 'laya-serve', role: 'assoc', kind: 'noul', questions: 5, inputTokens: 0, outputTokens: 0, ms: 0, ok: false, error: 'S1HttpError: systemone 503: server busy' },
    { type: 's1_call', schema: 1, ts: 1013, sessionId: 'session-ffff', provider: 'laya-serve', role: 'assoc', kind: 'noul', questions: 5, inputTokens: 0, outputTokens: 0, ms: 0, ok: false, error: 'S1HttpError: systemone 503: server busy' },
    { type: 's1_call', schema: 1, ts: 1014, sessionId: 'session-ffff', provider: 'laya-serve', role: 'assoc', kind: 'noul', questions: 5, inputTokens: 0, outputTokens: 0, ms: 0, ok: false, error: 'S1HttpError: systemone 503: server busy' },
  ];
  const rgF = {
    schema: 2, sessionId: 'session-ffff', scoredPairs: 8, judgedPairs: 0, order: ['a', 'b'], segments: [],
    edges: [
      { from: 'a', to: 'b', w: 0.3, source: 'lexical', verifiedAt: 1030 },
      { from: 'b', to: 'a', w: 0.2, source: 'lexical', verifiedAt: 1031 },
    ],
    scores: [{ from: 'a', to: 'b', w: 0.3, source: 'lexical', at: 1031 }],
  };
  const tapeF = [{ schema: 0, kind: 'wiring', s1: { provider: 'laya-serve', mode: 'local', baseUrl: 'http://127.0.0.1:8008' }, relevance: true }];

  // --- cell G: a lane whose coverage is *raised* by the work it declined -----------------------------
  //
  // The hazard F5 is about, made arithmetic. The gate holds 10 pairs back; `assoc-graph.ts` gives them to the
  // cursor again, so they never reach `scoredPairs`, which stays 10 while `judgedPairs` is 6. `judged/scored` is
  // therefore 0.60 - above the 0.5 validity floor - while the run only ever answered 6 of the 20 pairs the arrival
  // order offered. The second denominator is 6/20 = 0.30, below the floor. Without `deferredPairs` in the
  // machine-readable export, this cell reads as S1-governed.
  const G = [];
  const evG = (type, time, data) => G.push({ type, time, seq: G.length, data });
  G.push({ type: 'session', version: 4, id: 'session-gggg', createdAt: 900 });
  evG('turn/start', 1000, { turn: 1 });
  evG('user/message', 1001, { content: [{ type: 'text', text: 'human' }], source: { kind: 'user' } });
  evG('step/start', 1010, { turn: 1, step: 1 });
  evG('assistant/message', 1030, { turn: 1, step: 1, message: { role: 'assistant', content: [] }, usage: { inputTokens: 2, cacheReadTokens: 10, outputTokens: 1, totalTokens: 13 } });
  evG('step/end', 1035, { turn: 1, step: 1 });
  evG('turn/end', 1040, { turn: 1, reason: { kind: 'completed' } });
  const controlG = [
    // The second assembly record carries the recency fallback and the unjudged-admitted count: the two fields
    // `FORMULAS.md:431` requires beside a run that lowered `w`, and which no report printed before F9.
    { type: 'assembly', schema: 1, ts: 1005, sessionId: 'session-gggg', seq: 0, candidates: 3, selected: 2, recallTree: { s0: { s1: {}, s2: {} } } },
    { type: 'assembly', schema: 1, ts: 1018, sessionId: 'session-gggg', seq: 1, candidates: 1, selected: 1, fallback: 'recency-window', unknownAdmitted: 4, recallTree: {} },
    { type: 'context_delivery', schema: 1, ts: 1006, sessionId: 'session-gggg', cell: 'G', delivered: false, reason: 'the decision carried no messages', blocks: [] },
    { type: 's1_call', schema: 1, ts: 1012, sessionId: 'session-gggg', provider: 'laya-serve', role: 'assoc', kind: 'noul', questions: 5, inputTokens: 100, outputTokens: 0, ms: 10, ok: true },
    { type: 's1_call', schema: 1, ts: 1014, sessionId: 'session-gggg', provider: 'laya-serve', role: 'assoc', kind: 'noul', questions: 5, inputTokens: 0, outputTokens: 0, ms: 0, ok: false, error: 'S1HttpError: systemone 503: server busy' },
  ];
  const rgG = {
    schema: 2, sessionId: 'session-gggg', scoredPairs: 10, judgedPairs: 6, deferredPairs: 10, order: ['a', 'b'], segments: [],
    edges: [{ from: 'a', to: 'b', w: 0.3, source: 's1-noul', verifiedAt: 1030 }],
    scores: [{ from: 'a', to: 'b', w: 0.3, source: 's1-noul', at: 1030 }],
  };
  const tapeG = [{ schema: 0, kind: 'wiring', s1: { provider: 'laya-serve', mode: 'local', baseUrl: 'http://127.0.0.1:8008' }, relevance: true, configuredProvider: 'laya-serve', conflicts: [] }];

  // --- cell H: a lane CONFIGURED and then demoted by a configuration conflict -------------------------
  //
  // The reading F3 is about. `s1: "none"` on the wiring record - byte-for-byte what cell E writes - but the
  // `configuredProvider` beside it says `laya-serve`, and `conflicts` says why. The old report merged this with
  // cell E: "undefined - no S1 lane", i.e. a C2 whose backend was demoted printed as a deliberate control arm, in
  // the direction that flatters the round.
  const H = [];
  const evH = (type, time, data) => H.push({ type, time, seq: H.length, data });
  H.push({ type: 'session', version: 4, id: 'session-hhhh', createdAt: 900 });
  evH('turn/start', 1000, { turn: 1 });
  evH('user/message', 1001, { content: [{ type: 'text', text: 'human' }], source: { kind: 'user' } });
  evH('step/start', 1010, { turn: 1, step: 1 });
  evH('assistant/message', 1030, { turn: 1, step: 1, message: { role: 'assistant', content: [] }, usage: { inputTokens: 2, cacheReadTokens: 10, outputTokens: 1, totalTokens: 13 } });
  evH('step/end', 1035, { turn: 1, step: 1 });
  evH('turn/end', 1040, { turn: 1, reason: { kind: 'completed' } });
  const controlH = [
    { type: 'assembly', schema: 1, ts: 1005, sessionId: 'session-hhhh', seq: 0, candidates: 2, selected: 1 },
    { type: 'context_delivery', schema: 1, ts: 1006, sessionId: 'session-hhhh', cell: 'H', delivered: false, reason: 'the decision carried no messages', blocks: [] },
  ];
  const rgH = {
    schema: 2, sessionId: 'session-hhhh', scoredPairs: 6, judgedPairs: 0, deferredPairs: 0, order: ['a', 'b'], segments: [],
    edges: [{ from: 'a', to: 'b', w: 0.3, source: 'lexical', verifiedAt: 1030 }],
    scores: [{ from: 'a', to: 'b', w: 0.3, source: 'lexical', at: 1030 }],
  };
  const tapeH = [{
    schema: 0,
    kind: 'wiring',
    s1: 'none',
    configuredProvider: 'laya-serve',
    conflicts: ['only one S1 backend may be active: laya.enabled=true conflicts with s1.provider="jev" (set provider to "laya-serve", or disable Laya)'],
    relevance: false,
  }];
  // --- cell I: a present lane whose graph predates `deferredPairs` -------------------------------------
  //
  // The one case where the second denominator cannot be computed at all. It must say "not recorded", never 0, and
  // the deferral row must keep saying it too - the audit confirmed that property and it must survive this change.
  const I = [];
  const evI = (type, time, data) => I.push({ type, time, seq: I.length, data });
  I.push({ type: 'session', version: 4, id: 'session-iiii', createdAt: 900 });
  evI('turn/start', 1000, { turn: 1 });
  evI('user/message', 1001, { content: [{ type: 'text', text: 'human' }], source: { kind: 'user' } });
  evI('step/start', 1010, { turn: 1, step: 1 });
  evI('assistant/message', 1030, { turn: 1, step: 1, message: { role: 'assistant', content: [] }, usage: { inputTokens: 2, cacheReadTokens: 10, outputTokens: 1, totalTokens: 13 } });
  evI('step/end', 1035, { turn: 1, step: 1 });
  evI('turn/end', 1040, { turn: 1, reason: { kind: 'completed' } });
  const controlI = [
    // No `fallback`, no `unknownAdmitted`, no `recallTree`: a pre-fix build. All three rows must say so rather than
    // printing "the event did not happen".
    { type: 'assembly', schema: 1, ts: 1005, sessionId: 'session-iiii', seq: 0, candidates: 1, selected: 1 },
    { type: 'context_delivery', schema: 1, ts: 1006, sessionId: 'session-iiii', cell: 'I', delivered: false, reason: 'the decision carried no messages', blocks: [] },
  ];
  const rgI = {
    schema: 1, sessionId: 'session-iiii', scoredPairs: 4, judgedPairs: 2, order: ['a'], segments: [], edges: [], scores: [],
  };
  const tapeI = [{ schema: 0, kind: 'wiring', s1: { provider: 'laya-serve', mode: 'local', baseUrl: 'http://127.0.0.1:8008' }, relevance: true }];

  const mkCell = (name, events, control, rg, tape) => {
    const home = join(root, 'home', name);
    const storeDir = join(home, 'sessions', '--workspace--', `session-${name.toLowerCase()}`);
    mkdirSync(storeDir, { recursive: true });
    mkdirSync(join(home, '.s1cap', 'rg'), { recursive: true });
    if (tape) writeFileSync(join(home, '.s1cap', 'tape.jsonl'), tape.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const text = events.map((e) => JSON.stringify(e)).join('\n');
    // three frames, so the multi-frame walk is genuinely exercised
    const buf = zstdFrames(text, Math.max(1, Math.ceil(events.length / 3)));
    writeFileSync(join(storeDir, 'session.v4.jsonl.zstd'), buf);
    // the stub store every real run also contains
    const stubDir = join(home, 'sessions', '--workspace--', `session-${name.toLowerCase()}-stub`);
    mkdirSync(stubDir, { recursive: true });
    writeFileSync(join(stubDir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'session', id: 'stub' })}\n`)));
    const evDir = join(root, 'evidence', name);
    mkdirSync(evDir, { recursive: true });
    writeFileSync(join(evDir, 'control.jsonl'), control.map((r) => JSON.stringify(r)).join('\n') + '\n');
    writeFileSync(join(home, '.s1cap', 'rg', `rg-session-${name.toLowerCase()}-deadbeef.json`), JSON.stringify(rg));
    return { text, buf };
  };

  const builtA = mkCell('A', A, controlA, rgA);
  mkCell('B', B, controlB, rgB);
  mkCell('E', E, controlE, rgE, tapeE);
  mkCell('F', F, controlF, rgF, tapeF);
  mkCell('G', G, controlG, rgG, tapeG);
  mkCell('H', H, controlH, rgH, tapeH);
  mkCell('I', I, controlI, rgI, tapeI);
  // The round's software identity, exactly as the harness writes it, including the plugin that does
  // *not* declare this release as supported - the case that motivated recording it at all.
  writeFileSync(join(root, 'manifest.json'), `${JSON.stringify({
    _run: root,
    _dsh: {
      version: '0.2.0-rc.2',
      executable: 'C:\\Users\\lfkex\\AppData\\Roaming\\npm\\dsh.cmd',
      command: 'dsh --version',
      probedAt: '2026-10-01T09:35:32.648Z',
      profileSource: 'profile.default',
      plugin: { name: 'dsh-s1cap', version: '0.1.0', declaredDshReleases: { '0.1.7-rc.2': 'supported' }, peerDependencies: null },
      model: { provider: 'deepseek-account', model: 'deepseek-flash' },
    },
  }, null, 1)}\n`);
  return { builtA, eventsA: A };
}

/**
 * A second, minimal run directory whose manifest carries no `_dsh` block - the shape every round on
 * disk has today, because the record was introduced after them. One cell is enough: the release row is
 * a property of the round and must reach the header and the charts whether or not any cell has a lane.
 */
function buildRunWithoutDshRecord(root, manifestBody) {
  const events = [
    { type: 'session', version: 4, id: 'session-nnnn', createdAt: 900 },
    { type: 'turn/start', time: 1000, seq: 1, data: { turn: 1 } },
    { type: 'user/message', time: 1001, seq: 2, data: { content: [{ type: 'text', text: 'human' }], source: { kind: 'user' } } },
    { type: 'step/start', time: 1010, seq: 3, data: { turn: 1, step: 1 } },
    { type: 'assistant/message', time: 1030, seq: 4, data: { turn: 1, step: 1, message: { role: 'assistant', content: [] }, usage: { inputTokens: 2, cacheReadTokens: 10, outputTokens: 1 } } },
    { type: 'step/end', time: 1035, seq: 5, data: { turn: 1, step: 1 } },
    { type: 'turn/end', time: 1040, seq: 6, data: { turn: 1, reason: { kind: 'completed' } } },
  ];
  const home = join(root, 'home', 'N');
  const storeDir = join(home, 'sessions', '--workspace--', 'session-n');
  mkdirSync(storeDir, { recursive: true });
  mkdirSync(join(home, '.s1cap', 'rg'), { recursive: true });
  writeFileSync(join(storeDir, 'session.v4.jsonl.zstd'), zstdFrames(events.map((e) => JSON.stringify(e)).join('\n'), 3));
  const evDir = join(root, 'evidence', 'N');
  mkdirSync(evDir, { recursive: true });
  writeFileSync(join(evDir, 'control.jsonl'), `${JSON.stringify({ type: 'assembly', schema: 1, ts: 1005, sessionId: 'session-nnnn', seq: 0 })}\n`);
  writeFileSync(join(home, '.s1cap', 'rg', 'rg-session-nnnn-deadbeef.json'), JSON.stringify({
    schema: 2, sessionId: 'session-nnnn', scoredPairs: 2, judgedPairs: 1, order: ['a'], segments: [], edges: [], scores: [],
  }));
  if (manifestBody !== null) writeFileSync(join(root, 'manifest.json'), manifestBody);
}

function runSelfTest() {
  const root = mkdtempSync(join(tmpdir(), 's1cap-cell-report-selftest-'));
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
  const throws = (fn, needle, what) => check(() => {
    let threw = null;
    try { fn(); } catch (e) { threw = e; }
    assertTrue(threw !== null, `${what}: expected a throw, got none`);
    assertTrue(String(threw.message).includes(needle), `${what}: message "${threw.message}" does not mention "${needle}"`);
  }, what);

  try {
    process.stdout.write(`cell-report --self-test: synthetic run at ${root}\n`);
    const { builtA, eventsA } = buildSyntheticRun(root);

    // The decoder's reason for existing: a naive single-frame decode returns only frame 1.
    check(() => {
      const naive = zstdDecompressSync(builtA.buf).toString('utf8');
      const full = readSessionStore(join(root, 'home', 'A', 'sessions', '--workspace--', 'session-a', 'session.v4.jsonl.zstd'));
      assertTrue(full.frames >= 3, `expected >= 3 frames, got ${full.frames}`);
      assertTrue(naive.length < full.text.length, 'naive zstdDecompressSync should return less than the full walk');
      assertTrue(full.text.includes('turn/end'), 'the multi-frame walk should reach the last frame');
    }, 'multi-frame zstd walk reaches every frame (naive decode does not)');

    const analysis = analyseRun(root, ['A', 'B', 'E', 'F', 'G', 'H', 'I'], new Map([['A', 'alpha'], ['E', 'never'], ['F', 'refused'], ['G', 'shrinkable'], ['H', 'demoted'], ['I', 'predeferral']]), '2026-01-01T00:00:00.000Z');
    const A = analysis.cells.find((c) => c.name === 'A');
    const B = analysis.cells.find((c) => c.name === 'B');
    const E = analysis.cells.find((c) => c.name === 'E');
    const F = analysis.cells.find((c) => c.name === 'F');
    const G = analysis.cells.find((c) => c.name === 'G');
    const H = analysis.cells.find((c) => c.name === 'H');
    const I = analysis.cells.find((c) => c.name === 'I');

    check(() => {
      assertEqual(A.a.totals.turns, 2, 'A turns');
      assertEqual(A.a.totals.steps, 3, 'A steps');
      assertEqual(A.a.totals.llmCalls, 3, 'A LLM calls');
      assertEqual(A.a.totals.s1Calls, 5, 'A System-1 calls');
      assertEqual(A.a.totals.toolCalls, 2, 'A other tool calls');
    }, 'cell A counts (turns 2, steps 3, LLM 3, S1 5, tools 2)');

    check(() => {
      assertEqual(A.a.totals.llmMs, 100 + 200 + 300, 'A LLM time');
      assertEqual(A.a.totals.toolMs, 20 + 30, 'A tool time');
      assertEqual(A.a.totals.s1Ms, 10 + 20 + 5 + 15 + 40, 'A System-1 time');
      assertEqual(A.a.totals.stepFrameMs, 130 + 205 + 340, 'A step frame');
      assertEqual(A.a.totals.turnFrameMs, 400 + 400, 'A turn frame');
      assertEqual(A.a.totals.idleMs, 800 - 675, 'A between-step idle');
    }, 'cell A durations (LLM 600, tool 50, S1 90, step frame 675, turn frame 800, idle 125)');

    check(() => {
      assertEqual(A.a.totals.hitTokens, 600, 'A hit tokens');
      assertEqual(A.a.totals.missTokens, 60, 'A uncached input tokens');
      assertEqual(A.a.totals.outTokens, 18, 'A output tokens');
      // F19: the lane's two halves, counted apart. A's five calls carry input 7+8+9+3+0 = 27 and output 0+1+0+0+0 =
      // 1. The old single column printed 28 - the *sum* of the quantity `FORMULAS.md` prices and one it prices at
      // zero. The priced figure is the input row.
      assertEqual(A.a.totals.s1InputTokens, 7 + 8 + 9 + 3 + 0, 'A System-1 lane input tokens');
      assertEqual(A.a.totals.s1OutputTokens, 0 + 1 + 0 + 0 + 0, 'A System-1 lane output tokens');
      assertEqual(
        A.a.totals.s1InputTokens + A.a.totals.s1OutputTokens,
        28,
        'the two rows still add up to what the single column used to print',
      );
      assertTrue(A.a.totals.s1Tokens === undefined, 'and the mixed column is gone rather than left beside them');
    }, 'cell A tokens (hit 600, miss 60, out 18, S1 lane 27 in + 1 out - split, not summed)');

    check(() => {
      const s11 = A.a.steps.find((s) => s.turn === 1 && s.step === 1);
      const s12 = A.a.steps.find((s) => s.turn === 1 && s.step === 2);
      const s21 = A.a.steps.find((s) => s.turn === 2 && s.step === 1);
      assertEqual(s11.s1Calls, 2, 'step 1.1 S1 calls');
      assertEqual(s11.s1Ms, 30, 'step 1.1 S1 time');
      assertEqual(s11.hitTokens, 100, 'step 1.1 hit tokens');
      assertEqual(s11.llmMs, 100, 'step 1.1 LLM time');
      assertEqual(s11.toolMs, 20, 'step 1.1 tool time');
      assertEqual(s12.s1Calls, 1, 'step 1.2 S1 calls');
      assertEqual(s21.s1Calls, 0, 'step 2.1 S1 calls');
      assertEqual(s21.hitTokens, 300, 'step 2.1 hit tokens');
    }, 'cell A per-step split (1.1: 2 S1 / 30ms / 100 hit; 1.2: 1 S1; 2.1: 0 S1)');

    check(() => {
      const t1 = A.a.turnList.find((t) => t.turn === 1);
      const t2 = A.a.turnList.find((t) => t.turn === 2);
      assertEqual(t1.steps, 2, 'turn 1 steps');
      assertEqual(t2.steps, 1, 'turn 2 steps');
      assertEqual(t1.hitTokens, 300, 'turn 1 hit tokens');
      assertEqual(t2.hitTokens, 300, 'turn 2 hit tokens');
      assertEqual(t1.s1Calls, 3, 'turn 1 S1 calls');
      assertEqual(t1.gap.s1Calls, 0, 'turn 1 between-step S1 calls');
    }, 'cell A per-turn split (2 + 1 steps; 300 + 300 hit tokens; 3 S1 in turn 1)');

    check(() => {
      assertEqual(A.a.tail.s1Calls, 1, 'A tail S1 calls');
      assertEqual(A.a.tail.s1Ms, 40, 'A tail S1 time');
      assertEqual(A.a.idle.s1Calls, 1, 'A between-turns S1 calls');
      assertEqual(A.a.idle.s1Ms, 15, 'A between-turns S1 time');
      // the buckets must reconcile to the control plane's own count - the whole point of keeping the
      // unattributed rows visible instead of folding them into a step
      const bucketSum = A.a.steps.reduce((n, s) => n + s.s1Calls, 0)
        + A.a.turnList.reduce((n, t) => n + t.gap.s1Calls, 0)
        + A.a.idle.s1Calls + A.a.tail.s1Calls + A.a.pre.s1Calls;
      assertEqual(bucketSum, A.a.totals.s1Calls, 'A S1 bucket sum');
      assertEqual(A.a.totals.s1Ms, 90, 'A S1 total ms');
    }, 'cell A System-1 attribution reconciles (3 in steps + 1 between turns + 1 after last turn = 5)');

    check(() => {
      assertEqual(A.a.diagnostics.coverage, 0.5, 'A coverage');
      assertEqual(A.a.diagnostics.scoredPairs, 10, 'A scoredPairs');
      assertEqual(A.a.diagnostics.judgedPairs, 5, 'A judgedPairs');
      assertEqual(A.a.diagnostics.s1Ok, 4, 'A S1 ok');
      assertEqual(A.a.diagnostics.s1Refused, 1, 'A S1 refused');
      assertEqual(A.a.diagnostics.s1SuccessRate, 0.8, 'A S1 success rate');
      assertEqual(B.a.diagnostics.coverage, 0.25, 'B coverage');
    }, 'coverage and System-1 outcomes (A 5/10, B 1/4; A 4 ok / 1 refused)');

    check(() => {
      // The harness injects TWO records at session start (the runtime-context snapshot and the skill
      // catalog `<system-reminder>`), so the raw user/message count is 4 against 2 human messages.
      assertEqual(A.a.diagnostics.humanMessages, 2, 'A human messages');
      assertEqual(A.a.diagnostics.injectedMessages, 2, 'A injected messages');
      assertEqual(A.a.diagnostics.injections, 2, 'A delivered injections');
      assertEqual(A.a.diagnostics.turnsCompleted, 2, 'A completed turns');
      const rate = A.a.diagnostics.cacheHitRate;
      assertTrue(Math.abs(rate - 600 / 660) < 1e-12, `A cache hit rate should be 600/660, got ${rate}`);
    }, 'message counting trap and diagnostics (2 human vs 4 raw; 2 injections; hit rate 600/660)');

    check(() => {
      assertEqual(B.a.totals.turns, 1, 'B turns');
      assertEqual(B.a.totals.steps, 1, 'B steps');
      assertEqual(B.a.totals.s1Calls, 2, 'B S1 calls');
      assertEqual(B.a.totals.s1Ms, 4, 'B S1 time');
      assertEqual(B.a.totals.s1InputTokens, 11, 'B S1 lane input tokens');
      assertEqual(B.a.totals.s1OutputTokens, 0, 'B S1 lane output tokens');
      assertTrue(B.a.steps.every((s) => s.turn === 1 && s.step === 1), 'B has no step 1.2');
    }, 'cell B is smaller than A and keeps its own step count');

    check(() => {
      assertEqual(A.label, 'alpha', 'A label from --label');
      assertEqual(A.display, 'alpha (A)', 'A display name');
      assertEqual(B.label, 'B', 'B keeps its own name without a mapping');
    }, '--label maps a run cell name to a display label');

    const md = renderMarkdown(analysis);
    check(() => {
      assertTrue(md.includes('alpha (A)'), 'markdown uses the display label');
      assertTrue(md.includes('Cache hit rate is deliberately absent'), 'cost table disclaims the cache hit rate');
      assertTrue(md.includes('after last turn (async upkeep)'), 'markdown shows the unattributed System-1 tail');
      assertTrue(md.includes('| - |') || md.includes('| - |'), 'missing steps render as a dash, not as zero');
      const s1Section = md.split('### System-1 calls per step')[1] || '';
      assertTrue(s1Section.includes('coverage beside each System-1 column'), 'coverage is repeated beside System-1 columns');
      for (const label of [
        'System-1 time per step',
        'System-1 lane input tokens (the priced quantity) per step',
        'System-1 lane output tokens (free under the cost model) per step',
      ]) {
        const sec = md.split(`### ${label}`)[1] || '';
        assertTrue(sec.includes('coverage beside each System-1 column'), `coverage is repeated in "${label}"`);
        assertTrue(sec.includes('between turns (after step/end'), `"${label}" carries the unattributed rows`);
      }
    }, 'markdown rendering (labels, cost disclaimer, tail row, dash for missing steps, coverage note)');

    check(() => {
      // The lane-absent cell E: the wiring record says s1 = "none", there are no s1_call records, and
      // its zeros are by construction - they must be labelled as such, and its coverage must be
      // undefined rather than a 0/N that would describe a backend that was never asked.
      assertEqual(E.a.diagnostics.laneState, 'none', 'E lane state');
      assertEqual(E.a.diagnostics.laneAbsent, true, 'E lane absent');
      assertEqual(E.label, 'never', 'E display label');
      assertEqual(E.a.totals.s1Calls, 0, 'E System-1 calls');
      assertEqual(E.a.totals.s1Ms, 0, 'E System-1 time');
      assertEqual(E.a.totals.s1InputTokens, 0, 'E System-1 lane input tokens');
      assertEqual(E.a.totals.s1OutputTokens, 0, 'E System-1 lane output tokens');
      assertEqual(E.a.diagnostics.judgedPairs, 0, 'E judgedPairs');
      assertEqual(E.a.diagnostics.scoredPairs, 8, 'E scoredPairs');
      assertEqual(E.a.diagnostics.coverage, null, 'E coverage is undefined, not 0');
      assertEqual(E.a.diagnostics.edgeSourceLexical, 3, 'E lexical edges still built');
      assertEqual(E.a.diagnostics.edgeSourceS1, 0, 'E has no s1-noul edges');

      // The lane-present cell F: a real lane with three refused calls. It must show the counts, the
      // failure split and a coverage of 0 - which for this cell is a measurement, not an absence.
      assertEqual(F.a.diagnostics.laneState, 'present', 'F lane state');
      assertEqual(F.a.diagnostics.laneAbsent, false, 'F lane present');
      assertEqual(F.label, 'refused', 'F display label');
      assertEqual(F.a.totals.s1Calls, 3, 'F System-1 calls');
      assertEqual(F.a.diagnostics.s1Refused, 3, 'F refused calls');
      assertEqual(F.a.diagnostics.s1SuccessRate, 0, 'F success rate is 0');
      assertEqual(F.a.diagnostics.coverage, 0, 'F coverage is a measured 0');
      assertEqual(F.a.diagnostics.laneProvider, 'laya-serve', 'F lane provider');

      const md2 = renderMarkdown(analysis);
      assertTrue(md2.includes('0 (no S1 lane)'), 'lane-absent zeros carry the "no S1 lane" marker');
      assertTrue(md2.includes('0 (lane present; 0 ok of 3)'), 'lane-present zeros carry the failure split');
      assertTrue(md2.includes('undefined — no S1 lane'), 'coverage is printed as undefined for a lane-absent cell');
      assertTrue(md2.includes('never (E) undefined'), 'the coverage line marks E as undefined');
      assertTrue(md2.includes('refused (F) 0.0%'), 'the coverage line prints F\'s measured 0%');
      const headerLine = md2.split('\n').find((l) => l.startsWith('- System-1 lane:')) || '';
      assertTrue(headerLine.includes('had a System-1 lane'), 'the header line names the cells that had a lane');
      assertTrue(headerLine.includes('had **no** System-1 lane'), 'the header line names the cells that did not');
      assertTrue(headerLine.includes('refused (F)'), 'F is listed as having a lane');
      assertTrue(headerLine.includes('never (E)'), 'E is listed as having none');
      // the ambiguous reading must not appear anywhere: a bare System-1 0 in a lane-absent column
      assertTrue(!/\| 0 \| 0 \|/.test(md2.split('### System-1 calls per step')[1].split('### other tool calls')[0]),
        'a lane-absent per-step System-1 cell is never a bare 0');
    }, 'lane-absence markers: no lane prints 0 (no S1 lane) with undefined coverage; a refused lane prints counts and a measured 0');

    const csv = renderCsv(analysis);
    check(() => {
      const lines = csv.trim().split('\n');
      assertEqual(lines[0], 'cell,label,group,metric,unit,scope,turn,step,bucket,value', 'csv header');
      assertTrue(lines.includes('A,alpha,time,System-1 calls,count,cell,,,,5'), 'csv cell row for System-1 calls');
      assertTrue(lines.includes('A,alpha,time,System-1 calls,count,step,1,1,,2'), 'csv per-step row for System-1 calls');
      assertTrue(lines.includes('A,alpha,time,System-1 calls,count,idle,,,between-turns,1'), 'csv between-turns row for System-1 calls');
      assertTrue(lines.includes('A,alpha,time,System-1 calls,count,tail,,,after-last-turn,1'), 'csv tail row for System-1 calls');
      assertTrue(lines.some((l) => l.includes('mechanism') && l.includes('cache hit rate (NOT a cost metric)')), 'csv marks the cache hit rate as not-a-cost-metric');
      assertTrue(!lines.some((l) => l.includes(',cost,cache hit rate')), 'no cache hit rate row in the cost group');
      assertTrue(lines.some((l) => l.startsWith('E,never,mechanism,System-1 lane absent (zero by construction),flag,diagnostic,,,,1')), 'csv flags E as lane-absent');
      assertTrue(lines.some((l) => l.startsWith('F,refused,mechanism,System-1 lane absent (zero by construction),flag,diagnostic,,,,0')), 'csv flags F as lane-present');
      assertTrue(lines.some((l) => l.startsWith('E,never,mechanism,System-1 coverage state,flag,diagnostic,,,,undefined (no S1 lane)')), 'csv marks E coverage undefined');
      assertTrue(!lines.some((l) => l.startsWith('E,never,mechanism,System-1 coverage (judged/scored)')), 'csv omits a numeric coverage for E rather than writing 0');
      assertTrue(lines.some((l) => l.startsWith('F,refused,mechanism,System-1 coverage (judged/scored),ratio,diagnostic,,,,0')), 'csv writes F\'s measured coverage 0');
    }, 'csv is long-format, keeps the cache hit rate out of the cost group, and distinguishes the two System-1 zeros');

    check(() => {
      // F5. The cell whose coverage is raised by the work it declined: 6 judged of 10 scored is 0.60, above the 0.5
      // floor, while only 6 of the 20 pairs the arrival order offered were ever answered. The second denominator is
      // the one the floor is defined over, and both must be readable from the report *and* from the CSV.
      assertEqual(G.a.diagnostics.scoredPairs, 10, 'G scored pairs');
      assertEqual(G.a.diagnostics.deferredPairs, 10, 'G deferred pairs');
      assertEqual(G.a.diagnostics.offeredPairs, 20, 'G offered = scored + deferred');
      assertEqual(G.a.diagnostics.coverage, 0.6, 'G judged/scored, raised by declining work');
      assertEqual(G.a.diagnostics.coverageOffered, 0.3, 'G judged/(scored+deferred), the floor denominator');
      assertTrue(G.a.diagnostics.coverage > 0.5 && G.a.diagnostics.coverageOffered < 0.5,
        'the fixture must actually straddle the 0.5 floor, or it proves nothing');
      assertEqual(G.a.diagnostics.deferredShare, 0.5, 'G deferred share = 10/20');

      const mdG = renderMarkdown(analysis);
      assertTrue(mdG.includes('judged/(scored+deferred) = 30.0%'), 'the offered denominator is printed beside coverage');
      assertTrue(mdG.includes('deferral share: 50.0% (10 deferred of 20 offered = scored + deferred)'),
        'the deferral share and its denominator are printed beside every coverage figure');

      // F9. The recency fallback is the event that silently replaces the System-1 selection with the last-N window.
      assertEqual(G.a.diagnostics.fallbackSteps, 1, 'G records one step on the recency fallback');
      assertEqual(G.a.diagnostics.fallbackRecorded, true, 'G recorded the field');
      assertEqual(G.a.diagnostics.unknownAdmittedTotal, 4, 'G admits four unjudged pairs');
      assertEqual(G.a.diagnostics.recallTreeSteps, 2, 'G recorded a recall tree on both assemblies');
      assertEqual(G.a.diagnostics.recallTreeNodes, 3, 'two nodes under s0, one under s1, and an empty tree');
      assertTrue(mdG.includes('1 backend / 1 recency-fallback'), 'the recall block source row names the fallback');
      assertTrue(mdG.includes('unjudged pairs admitted (`unknownAdmitted`)'), 'the unknownAdmitted row exists');
      assertTrue(mdG.includes('recall structure recorded (steps / nodes placed)'), 'the recall tree row exists');

      // F3. The demoted lane, which used to print exactly as the no-lane control.
      assertEqual(H.a.diagnostics.laneState, 'demoted', 'H lane state is demoted, not none');
      assertEqual(H.a.diagnostics.laneDemoted, true, 'H is flagged demoted');
      assertEqual(H.a.diagnostics.laneAbsent, false, 'H is NOT the no-lane reading');
      assertEqual(H.a.diagnostics.laneConfiguredProvider, 'laya-serve', 'H names what the recipe asked for');
      assertEqual(H.a.diagnostics.laneConflicts.length, 1, 'H carries the reason');
      assertEqual(H.a.diagnostics.coverage, null, 'H coverage is undefined - no backend was resolved');
      assertEqual(E.a.diagnostics.laneDemoted, false, 'E stays a configuration, not a demotion');
      const mdH = renderMarkdown(analysis);
      assertTrue(mdH.includes('**lane demoted**'), 'the demoted cell says "demoted", not "no S1 lane"');
      assertTrue(mdH.includes('lane demoted to "none" by a conflict'), 'and every System-1 zero says so');
      assertTrue(mdH.includes('configured and demoted to none by a configuration conflict'),
        'the header line names the demoted cells separately from the no-lane ones');
      assertTrue(mdH.includes('demoted (H)'), 'the demoted cell appears in the coverage line');

      // F5/I: a snapshot that predates `deferredPairs` must say "not recorded", never 0 - the property the audit
      // verified and this change must not lose.
      assertEqual(I.a.diagnostics.deferredRecorded, false, 'I predates the deferral field');
      assertEqual(I.a.diagnostics.coverageOffered, null, 'I has no offered denominator');
      assertEqual(I.a.diagnostics.coverage, 0.5, 'but I still has judged/scored');
      assertEqual(I.a.diagnostics.recallTreeRecorded, false, 'I recorded no recall tree');
      assertEqual(I.a.diagnostics.unknownAdmittedTotal, null, 'I recorded no unknownAdmitted');
      const mdI = renderMarkdown(analysis);
      assertTrue(mdI.includes('deferral share: not recorded by this snapshot'), 'I says the deferral is unrecorded');
      assertTrue(mdI.includes('offered-denominator coverage: n/a (deferrals not recorded by this snapshot)'),
        'and so is the offered denominator');
      const iRows = renderCsv(analysis).split('\n').filter((l) => l.startsWith('I,'));
      assertTrue(iRows.some((l) => l.includes('deferred pairs recorded by this snapshot,flag,diagnostic,,,,0')),
        'the CSV flags the missing deferral field');
      assertTrue(!iRows.some((l) => l.includes('association pairs deferred,')), 'and omits the count rather than zeroing it');
      assertTrue(!iRows.some((l) => l.includes('System-1 coverage (judged/(scored+deferred))')), 'and omits the ratio');
      assertTrue(mdI.includes('undefined — no S1 lane'), 'E keeps the no-lane wording');
    }, 'F3/F5/F9: a demoted lane prints as demoted, coverage carries its deferral denominator, and the recall rows are reported or marked unrecorded');

    check(() => {
      // The CSV is the machine-readable half: every field the markdown states must be readable from it, because a
      // downstream consumer never sees the prose (F5's second half).
      const lines = csv.trim().split('\n');
      assertTrue(lines.some((l) => l.startsWith('G,shrinkable,mechanism,association pairs deferred,count,diagnostic,,,,10')),
        'csv carries deferredPairs');
      assertTrue(lines.some((l) => l.startsWith('G,shrinkable,mechanism,association pairs offered (scored + deferred),count,diagnostic,,,,20')),
        'csv carries the offered denominator');
      assertTrue(lines.some((l) => l.startsWith('G,shrinkable,mechanism,deferred share of offered,ratio,diagnostic,,,,0.5')),
        'csv carries the deferral share');
      assertTrue(lines.some((l) => l.startsWith('G,shrinkable,mechanism,System-1 coverage (judged/(scored+deferred)),ratio,diagnostic,,,,0.3')),
        'csv carries the floor denominator');
      assertTrue(lines.some((l) => l.startsWith('H,demoted,mechanism,System-1 lane demoted by a configuration conflict,flag,diagnostic,,,,1')),
        'csv flags the demoted lane');
      assertTrue(lines.some((l) => l.startsWith('E,never,mechanism,System-1 lane demoted by a configuration conflict,flag,diagnostic,,,,0')),
        'and does not flag the no-lane control');
      assertTrue(lines.some((l) => l.startsWith('H,demoted,mechanism,System-1 lane configured provider,flag,diagnostic,,,,laya-serve')),
        'csv carries the configured provider');
      // The conflict text itself, quoted by the CSV writer because it contains a comma - which is the point of the
      // quoting, so the assertion looks for the fragment rather than the whole line.
      assertTrue(lines.some((l) => l.includes('System-1 lane conflict detail') && l.includes('only one S1 backend may be active')),
        'csv carries the conflict text');
      assertTrue(lines.some((l) => l.startsWith('G,shrinkable,mechanism,recall block source,flag,diagnostic,,,,recency-fallback on 1 step(s)')),
        'csv carries the recall block source');
      assertTrue(lines.some((l) => l.startsWith('G,shrinkable,mechanism,unjudged pairs admitted (unknownAdmitted),count,diagnostic,,,,4')),
        'csv carries unknownAdmitted');
      assertTrue(lines.some((l) => l.startsWith('G,shrinkable,mechanism,recall structure nodes placed,count,diagnostic,,,,3')),
        'csv carries the recall tree node count');
      assertTrue(!lines.some((l) => l.startsWith('E,never,mechanism,System-1 coverage (judged/(scored+deferred))')),
        'the offered denominator is omitted, not zeroed, for a cell with no lane');
    }, 'F3/F5/F9 in the CSV: the deferredPairs family, the demotion flags and the recall rows are all machine-readable');

    const svgs = renderSvgs(analysis);

    check(() => {
      assertTrue(Object.keys(svgs).includes('time.svg'), 'time.svg exists');
      assertTrue(Object.keys(svgs).includes('cost.svg'), 'cost.svg exists');
      for (const [name, s] of Object.entries(svgs)) {
        assertTrue(s.startsWith('<!--'), `${name} starts with a banner comment`);
        assertTrue(s.includes('xmlns="http://www.w3.org/2000/svg"'), `${name} is a standalone svg`);
        assertTrue(!/<script/i.test(s), `${name} has no script`);
        assertTrue(!/https?:\/\//.test(s.replace('http://www.w3.org/2000/svg', '')), `${name} references no external URL`);
        assertTrue(s.includes('>3,000<') || s.includes('>1,200<') || /class="value"/.test(s), `${name} prints numbers on the bars`);
        assertTrue((s.match(/<rect/g) || []).length > 3, `${name} draws bars`);
      }
      assertTrue(svgs['time.svg'].includes('>count<') || svgs['time.svg'].includes('count</text>'), 'time.svg labels the count axis');
      assertTrue(svgs['cost.svg'].includes('tokens'), 'cost.svg labels the token axis');
    }, 'svg output is self-contained, script-free and prints values on bars');

    check(() => {
      // the same distinction the tables make has to survive into the charts
      assertTrue(svgs['cost.svg'].includes('0 (no lane)'), 'cost.svg marks the lane-absent zero');
      assertTrue(svgs['cost.svg'].includes('no S1 lane'), 'cost.svg names the cell without a lane in its subtitle');
      assertTrue(svgs['time.svg'].includes('0 (lane, 0 ok)'), 'time.svg marks the lane-present zero as a refused lane');
      assertTrue(svgs['s1-governance.svg'].includes('n/a (no lane)'), 'the governance chart has no coverage bar for a lane-absent cell');
      assertTrue(svgs['s1-governance.svg'].includes('never (E)'), 'the governance chart names the lane-absent cell');
    }, 'svg charts distinguish a lane-absent zero from a refused-lane zero');

    // GEOMETRY. The arithmetic was right the first time and the drawing was not: every panel after
    // the first was translated twice, so its body landed in the next panel's band and the last
    // panel's body fell off the canvas entirely. Nothing above can see that, so the finished files
    // are read back and every bar and every value label is required to lie inside the band of the
    // panel that owns it.
    check(() => {
      const audits = Object.entries(svgs).map(([name, text]) => [name, auditSvg(text)]);
      for (const [name, audit] of audits) {
        assertTrue(audit.violations.length === 0, `${name} geometry: ${audit.violations.slice(0, 4).join(' | ')}`);
        assertTrue(audit.ok, `${name} audit not ok`);
        assertTrue(audit.bands.length >= 1, `${name} has no panels`);
        // every panel must actually carry its own series, not just its heading
        for (const b of audit.bands) {
          assertEqual(b.bars, b.metrics * b.cells, `${name} "${b.title}" bars drawn`);
          assertEqual(b.labels, b.metrics * b.cells, `${name} "${b.title}" value labels drawn`);
          assertTrue(b.barSpan !== null && b.barSpan[0] >= b.absTop && b.barSpan[1] <= b.absBottom,
            `${name} "${b.title}" bar span ${JSON.stringify(b.barSpan)} outside ${b.absTop}..${b.absBottom}`);
        }
        // bands are contiguous and fill the document exactly
        const sum = audit.bands.reduce((a, b) => a + b.height, 0);
        assertEqual(audit.bands[0].offset, 0, `${name} first band offset`);
        assertEqual(audit.origin + sum + 40, audit.docHeight, `${name} doc height identity`);
        for (let i = 1; i < audit.bands.length; i += 1) {
          assertEqual(audit.bands[i].absTop, audit.bands[i - 1].absBottom, `${name} band ${i + 1} starts where band ${i} ends`);
        }
      }
      // time.svg is the multi-panel file and is where the defect lived: pin its panel count and order
      const time = audits.find(([n]) => n === 'time.svg')[1];
      assertEqual(time.bands.length, 3, 'time.svg panel count');
      assertEqual(time.bands.map((b) => b.title).join(' / '),
        'Time - counts / Time - wall clock (the step, decomposed) / Time - System-1 lane (concurrent, not additive)',
        'time.svg panel order');
      assertTrue(time.bands[1].metrics === 4 && time.bands[1].cells === analysis.cells.length,
        `wall-clock panel draws 4 metrics x ${analysis.cells.length} cells`);
      assertTrue(time.bands[2].metrics === 1, 'the System-1 panel draws one metric');

      // and the audit must actually fail on the defect it exists for: stack one panel on another's
      // offset, exactly as the double translation did, and the same reader rejects it. The offsets are
      // read from the chart rather than hard-coded, so the fixture survives any change in band height.
      const offsets = time.bands.map((b) => b.offset);
      const lastOffset = offsets[offsets.length - 1];
      const prevOffset = offsets[offsets.length - 2];
      assertTrue(lastOffset !== prevOffset, 'the geometry fixture needs at least two distinct band offsets');
      const broken = svgs['time.svg'].replace(`transform="translate(0,${lastOffset})"`, `transform="translate(0,${prevOffset})"`);
      assertTrue(broken !== svgs['time.svg'], 'the geometry regression fixture did not apply');
      const brokenAudit = auditSvg(broken);
      assertTrue(!brokenAudit.ok, 'the audit must reject a panel whose body is drawn one band too low');
      assertTrue(brokenAudit.violations.some((v) => /outside band|bands advance|doc height/.test(v)),
        `the audit must name the geometric violation, got: ${brokenAudit.violations.join(' | ')}`);

      // the horizontal check gets its own fixture: a caption too wide for the page must be rejected
      const wide = auditSvg(svgs['cost.svg'].replace(/<text x="118" y="56" class="panel-note">[^<]*<\/text>/,
        `<text x="118" y="56" class="panel-note">${'W'.repeat(300)}</text>`));
      assertTrue(!wide.ok, 'the audit must reject a caption wider than the document');
    }, 'svg geometry: bars and value labels lie inside the owning panel band, bands are contiguous, height is exact');

    check(() => {
      // The audit owns the metric charts and nothing else. `cell-figure.mjs` writes a composition into
      // the same directory, and counting it as a failure made `report -> figure -> audit` - the
      // documented order - report a false alarm. It is skipped with a reason; an SVG that is neither a
      // chart nor a recognisable composition is still a failure, so the skip cannot swallow a broken
      // chart.
      const composition = `<svg xmlns="http://www.w3.org/2000/svg" width="1168" height="3761" viewBox="0 0 1168 3761">
  <rect x="0" y="0" width="1168" height="3761" fill="#ffffff"/>
  <foreignObject x="0" y="0" width="1168" height="900"><div xmlns="http://www.w3.org/1999/xhtml">header</div></foreignObject>
  <svg x="24" y="900" width="1120" height="546" viewBox="0 0 1120 546"><g class="panels" transform="translate(0,52)"></g></svg>
  <svg x="24" y="1476" width="1120" height="546" viewBox="0 0 1120 546"><g class="panels" transform="translate(0,52)"></g></svg>
  <svg x="24" y="2052" width="1120" height="546" viewBox="0 0 1120 546"><g class="panels" transform="translate(0,52)"></g></svg>
</svg>`;
      assertEqual(classifySvg(composition), 'composition', 'a composed figure is recognised');
      const a = auditSvg(composition);
      assertTrue(a.skipped && a.ok, 'a composition is skipped, not failed');
      assertTrue(a.reason.includes('composed figure'), 'the skip carries a readable reason');
      assertTrue(formatAudit('summary.svg', a).startsWith('summary.svg: SKIPPED'), 'the audit prints the skip');

      // `s1-activity.mjs` writes a matrix into the same directory under the documented order
      // (`cell-report` -> `s1-activity` -> `cell-report --audit`). It declares itself on the root
      // element; the skip is printed with a reason, and it is the marker alone that earns the skip.
      const activity = `<svg xmlns="http://www.w3.org/2000/svg" width="1240" height="1736" viewBox="0 0 1240 1736" data-chart="s1-activity">
  <rect class="cell" data-row="0" data-col="1" data-state="candidate" x="300" y="900" width="120" height="24" fill="#2f6fd0"/>
  <rect class="ring" data-row="0" data-col="1" data-overlay="selected" x="301" y="901" width="118" height="21" fill="none" stroke="#b0483f"/>
</svg>`;
      assertEqual(classifySvg(activity), 'activity', 'the activity matrix is recognised by its own marker');
      const act = auditSvg(activity);
      assertTrue(act.skipped && act.ok, 'the activity matrix is skipped, not failed');
      assertTrue(act.reason.includes('recall-activity matrix'), 'the activity skip carries a readable reason');
      assertTrue(act.reason.includes('s1-activity.mjs --self-test'), 'and names where its geometry is checked');
      assertTrue(formatAudit('s1-activity.svg', act).startsWith('s1-activity.svg: SKIPPED'), 'the audit prints that skip');
      // The marker has to be decisive. The same body without it is an unplaceable chart, not a matrix:
      // a resemblance must never buy a skip, or the audit would wave through whatever looks familiar.
      const unmarked = activity.replace(' data-chart="s1-activity"', '');
      assertEqual(classifySvg(unmarked), 'unknown', 'a matrix without its marker is not recognised as one');
      const unmarkedAudit = auditSvg(unmarked);
      assertTrue(!unmarkedAudit.ok && !unmarkedAudit.skipped, 'and it still fails the audit');

      // a chart is still a chart, and a document that is neither is still a failure
      assertEqual(classifySvg(svgs['time.svg']), 'chart', 'the real charts classify as charts');
      const junk = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect x="0" y="0" width="100" height="100"/></svg>';
      assertEqual(classifySvg(junk), 'unknown', 'an unrecognisable svg is not a composition');
      const j = auditSvg(junk);
      assertTrue(!j.ok && !j.skipped, 'an unrecognisable svg still fails the audit');
      assertTrue(j.violations.includes('document has no readable panel structure'), 'and says why');
    }, 'the audit skips a composed figure and the activity matrix with a note, and still fails an svg it cannot place');

    check(() => {
      // The release and the model are read from the manifest's `_dsh` block and must reach the header...
      assertEqual(analysis.dsh.present, true, 'the fixture manifest records _dsh');
      assertEqual(analysis.dsh.version, '0.2.0-rc.2', 'recorded release');
      const mdDsh = renderMarkdown(analysis);
      const releaseRow = mdDsh.split('\n').find((l) => l.startsWith('- DSH release:')) || '';
      const modelRow = mdDsh.split('\n').find((l) => l.startsWith('- model:')) || '';
      assertTrue(releaseRow.includes('dsh 0.2.0-rc.2'), 'header carries the release');
      assertTrue(releaseRow.includes('C:\\Users\\lfkex\\AppData\\Roaming\\npm\\dsh.cmd'), 'header carries the executable');
      assertTrue(releaseRow.includes('provisioned 2026-10-01T09:35:32.648Z'), 'header carries the probe time');
      assertTrue(releaseRow.includes('NOT declared supported by dsh-s1cap (declares 0.1.7-rc.2)'),
        'header says the plugin does not declare this release supported');
      assertEqual(modelRow, '- model: deepseek-account/deepseek-flash', 'header model row');
      // ...and the two rows must reassemble into the harness's own single line, so the wrapper's
      // output, the report and the charts cannot drift apart
      const harness = dshHarnessLine(analysis.dsh);
      assertEqual(harness, 'dsh 0.2.0-rc.2 (C:\\Users\\lfkex\\AppData\\Roaming\\npm\\dsh.cmd, provisioned 2026-10-01T09:35:32.648Z)'
        + ' | model deepseek-account/deepseek-flash'
        + ' | NOT declared supported by dsh-s1cap (declares 0.1.7-rc.2)', 'harness wording');
      assertTrue(harness === `${releaseRow.replace('- DSH release: ', '').split(' | ')[0]} | model ${modelRow.replace('- model: ', '')} | ${releaseRow.split(' | ').slice(1).join(' | ')}`,
        'the release and model rows reassemble into the harness sentence');
      for (const [name, text] of Object.entries(renderSvgs(analysis))) {
        assertTrue(text.includes('dsh 0.2.0-rc.2'), `${name} subtitle carries the release`);
        assertTrue(text.includes('deepseek-account/deepseek-flash'), `${name} subtitle carries the model`);
        const captionLines = [...text.matchAll(/class="doc-sub">([^<]*)</g)].map((m) => m[1]);
        // the release clause itself must not be split, and the clauses must reassemble into the
        // harness's sentence - a split inside a clause would leave a line starting with a bare `|`
        assertTrue(captionLines.some((l) => l.trim() === dshReleaseParts(analysis.dsh)[0]),
          `${name} carries the release clause unbroken`);
        assertTrue(!captionLines.some((l) => l.trim().startsWith('|')), `${name} has a caption line starting with "|"`);
        // Read back with the harness's own separator, the caption lines contain its sentence verbatim:
        // the identity survived the wrap without a word changed or lost.
        assertTrue(captionLines.join(' | ').includes(harness), `${name} captions reassemble into the harness sentence`);
      }
    }, 'a round WITH a release record puts it on the header and on every chart');

    check(() => {
      // ...and a round WITHOUT one states that fact in the harness's own words, in both places.
      const bare = join(root, 'bare');
      mkdirSync(bare, { recursive: true });
      buildRunWithoutDshRecord(bare, null);
      const a1 = analyseRun(bare, ['N'], new Map(), '2026-01-01T00:00:00.000Z');
      assertEqual(a1.dsh.present, false, 'no manifest means no record');
      const md1 = renderMarkdown(a1);
      assertTrue(md1.includes(`- DSH release: ${UNKNOWN_RELEASE}`), 'header states the missing record verbatim');
      assertTrue(md1.includes('- model: not recorded'), 'the model row states the absence rather than going blank');
      assertTrue(!md1.includes('- DSH release: \n'), 'the release row is never empty');
      const svg1 = renderSvgs(a1);
      for (const [name, text] of Object.entries(svg1)) {
        assertTrue(text.includes(UNKNOWN_RELEASE), `${name} subtitle states the missing record verbatim`);
        assertTrue(auditSvg(text).ok, `${name} geometry still holds with the UNKNOWN caption`);
      }

      // a manifest that exists but carries no _dsh is the same stated fact, not a crash
      const partial = join(root, 'partial');
      mkdirSync(partial, { recursive: true });
      buildRunWithoutDshRecord(partial, `${JSON.stringify({ _run: partial, _harness: 'x' })}\n`);
      const a2 = analyseRun(partial, ['N'], new Map(), '2026-01-01T00:00:00.000Z');
      assertEqual(a2.dsh.present, false, 'a manifest with no _dsh is not a record');
      assertEqual(a2.dsh.reason, 'manifest.json records no _dsh block', 'and the reason is recorded');
      assertTrue(renderMarkdown(a2).includes(UNKNOWN_RELEASE), 'the header still states it verbatim');

      // a _dsh with no version is the same: the harness reads `_dsh?.version` and so do we
      const versionless = join(root, 'versionless');
      mkdirSync(versionless, { recursive: true });
      buildRunWithoutDshRecord(versionless, `${JSON.stringify({ _dsh: { executable: 'x' } })}\n`);
      assertEqual(analyseRun(versionless, ['N'], new Map(), 'x').dsh.present, false, '_dsh without a version is not a record');

      // unparseable manifest: a stated fact, never a throw - a report must still describe the round
      const corrupt = join(root, 'corrupt');
      mkdirSync(corrupt, { recursive: true });
      buildRunWithoutDshRecord(corrupt, '{ not json');
      const a4 = analyseRun(corrupt, ['N'], new Map(), 'x');
      assertEqual(a4.dsh.present, false, 'a corrupt manifest is not a record');
      assertTrue(a4.dsh.reason.startsWith('manifest.json is not valid JSON'), 'and the reason names it');
    }, 'a round WITHOUT a release record states the fact in the harness wording, never a blank and never a guess');

    throws(() => analyseRun(join(root, 'nope'), ['A'], new Map(), 'x'), 'run directory not found', 'missing run directory fails loudly');
    throws(() => analyseRun(root, ['ZZ'], new Map(), 'x'), 'no control plane', 'missing cell evidence fails loudly');

    // a cell whose control plane exists but whose session store was never written
    mkdirSync(join(root, 'evidence', 'C'), { recursive: true });
    mkdirSync(join(root, 'home', 'C'), { recursive: true });
    writeFileSync(join(root, 'evidence', 'C', 'control.jsonl'), '{"type":"assembly"}\n');
    throws(() => analyseRun(root, ['C'], new Map(), 'x'), 'no sessions directory', 'cell without a session store fails loudly');

    // a cell with a session store but no association-graph snapshot: coverage is underivable, which
    // is an error, because a missing snapshot must not be reported as zero coverage
    mkdirSync(join(root, 'evidence', 'D'), { recursive: true });
    const dStore = join(root, 'home', 'D', 'sessions', '--workspace--', 'session-d');
    mkdirSync(dStore, { recursive: true });
    writeFileSync(join(dStore, 'session.v4.jsonl.zstd'), zstdFrames(
      JSON.stringify({ type: 'session', version: 4, id: 'session-dddd' }) + '\n'
      + JSON.stringify({ type: 'turn/start', time: 1, data: { turn: 1 } }) + '\n',
      2,
    ));
    writeFileSync(join(root, 'evidence', 'D', 'control.jsonl'), '{"type":"assembly","ts":1}\n');
    throws(() => analyseRun(root, ['D'], new Map(), 'x'), 'no association-graph snapshot directory', 'cell without an rg snapshot fails loudly');

    process.stdout.write(`cell-report --self-test: ${failures === 0 ? 'PASS' : `FAIL (${failures})`}\n`);
  } catch (err) {
    failures += 1;
    process.stdout.write(`cell-report --self-test: FAIL\n  ${err.stack}\n`);
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  process.exit(failures === 0 ? 0 : 1);
}

main();
