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
  { key: 's1Tokens', group: 'cost', unit: 'token', scopes: ['cell', 'turn', 'step'], label: "System-1 lane's own tokens" },
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
 * The evidence, in order of authority (never inferred from the call count alone):
 *   1. `<home>/<cell>/.s1cap/tape.jsonl` `kind:"wiring"` - written once at activation, and its `s1`
 *      field is literally `'none'` when the resolved backend is the Off choice, or
 *      `{provider, mode, baseUrl}` when one is wired (dsh-plugin/src/index.ts).
 *   2. the same tape's `kind:"tuning-file"` `effective.provider`.
 *   3. `provider` on the cell's own `s1_call` records (the configured name, recorded even on refusals).
 *   4. nothing at all: with no provider evidence anywhere and no call records, the lane was absent -
 *      but that is an inference, and the report says so rather than presenting it as a configuration.
 */
function findLaneEvidence(cellDir, cell, control) {
  const tapePath = join(cellDir, '.s1cap', 'tape.jsonl');
  const record = { state: 'unknown', provider: null, mode: null, baseUrl: null, source: 'no provider evidence in the run directory', tapePath: null };
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
    hitTokens: 0, missTokens: 0, outTokens: 0, s1Tokens: 0,
    s1Ok: 0, s1Refused: 0, s1Questions: 0,
    injections: 0, contextSteps: 0, assemblySteps: 0,
    turnsCompleted: 0, completionMs: 0,
    humanMessages: 0, injectedMessages: 0,
  };
}

const SUM_KEYS = [
  'turns', 'steps', 'llmCalls', 's1Calls', 'toolCalls',
  'llmMs', 's1Ms', 'toolMs', 'stepFrameMs', 'turnFrameMs', 'idleMs',
  'hitTokens', 'missTokens', 'outTokens', 's1Tokens',
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
    bucket.s1Tokens += (r.inputTokens || 0) + (r.outputTokens || 0);
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
    for (const k of ['s1Calls', 's1Ms', 's1Tokens', 's1Ok', 's1Refused', 's1Questions']) {
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
  totals.s1Tokens = s1Records.reduce((a, r) => a + (r.inputTokens || 0) + (r.outputTokens || 0), 0);
  totals.s1Ok = s1Records.filter((r) => r.ok).length;
  totals.s1Refused = totals.s1Calls - totals.s1Ok;
  totals.s1Questions = s1Records.reduce((a, r) => a + (r.questions || 0), 0);
  // The assembly/delivery totals come straight from the control plane for the same reason: the
  // buckets exist to place records on a turn or a step, not to define the cell total.
  totals.assemblySteps = assembly.length;
  totals.contextSteps = delivery.length;
  totals.injections = delivery.filter((r) => r.delivered).length;

  const attributed = { s1Calls: 0, s1Ms: 0, s1Tokens: 0 };
  for (const s of stepMap.values()) {
    attributed.s1Calls += s.s1Calls; attributed.s1Ms += s.s1Ms; attributed.s1Tokens += s.s1Tokens;
  }
  for (const t of turnList) {
    attributed.s1Calls += t.gap.s1Calls; attributed.s1Ms += t.gap.s1Ms; attributed.s1Tokens += t.gap.s1Tokens;
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
  const edgeSources = {};
  for (const e of cell.rg.edges || []) edgeSources[e.source] = (edgeSources[e.source] || 0) + 1;
  const rgAsOf = (cell.rg.scores || []).reduce((a, s) => Math.max(a, s.at || 0), 0)
    || (cell.rg.edges || []).reduce((a, e) => Math.max(a, e.verifiedAt || 0), 0);

  const completedTurns = turnList.filter((t) => t.turnsCompleted === 1).length;
  // A cell with no lane has no System-1 calls by construction. Coverage is then *undefined*, not 0:
  // judgedPairs is 0 because the backend never judged anything, but the local lexical scorer still
  // built edges, so 0/N would read as "the backend judged none of what it was shown" - a claim about
  // a backend that was never asked. `laneAbsent` is what every System-1 column is rendered through.
  const laneAbsent = cell.lane.state === 'none' || (cell.lane.state === 'unknown' && s1Records.length === 0);
  const diagnostics = {
    laneState: cell.lane.state,
    laneAbsent,
    laneProvider: cell.lane.provider,
    laneMode: cell.lane.mode,
    laneBaseUrl: cell.lane.baseUrl,
    laneSource: cell.lane.source,
    laneLabel: laneAbsent
      ? (cell.lane.state === 'none' ? `absent (${cell.lane.source})` : 'absent (no provider evidence)')
      : `present: ${cell.lane.provider ?? 'unknown'}${cell.lane.mode ? ` (${cell.lane.mode})` : ''}${cell.lane.baseUrl ? ` at ${cell.lane.baseUrl}` : ''}`,
    s1Calls: totals.s1Calls,
    s1Ok: totals.s1Ok,
    s1Refused: totals.s1Refused,
    s1SuccessRate: totals.s1Calls > 0 ? totals.s1Ok / totals.s1Calls : (laneAbsent ? null : 0),
    s1ErrorTop: [...s1Errors.entries()].sort((a, b) => b[1] - a[1])[0] || null,
    scoredPairs: rgScored,
    judgedPairs: rgJudged,
    coverage: laneAbsent ? null : (rgScored > 0 ? rgJudged / rgScored : null),
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

// `s1Ms` and `s1Tokens` are System-1 columns exactly as `s1Calls` is, so they get the same
// treatment: coverage printed beside them, the calls that no step owns printed as their own rows
// rather than dropped, and an explicit lane marker so a configured-but-refused zero can never be
// read as a not-configured zero. Only `s1Calls` is annotated inline with the coverage percentage,
// because a percentage repeated inside a millisecond or token cell makes the number unreadable.
const S1_METRICS = new Set(['s1Calls', 's1Ms', 's1Tokens']);
const isS1Metric = (m) => S1_METRICS.has(m.key);

/**
 * Render one System-1 value with the lane marker the owner asked for.
 *
 * Every System-1 zero is labelled with *why* it is zero:
 *   `0 (no S1 lane)`   - the cell has no lane; the zero is by construction
 *   `0 (lane present; 0 ok of N)` - the lane exists and refused or timed out; never a bare `0`
 * Non-zero values need no marker, and non-System-1 metrics are rendered plainly.
 */
function renderS1Value(metric, cell, value, { cellLevel }) {
  const base = renderValue(metric, value);
  if (!isS1Metric(metric)) return base;
  const d = cell.a.diagnostics;
  if (d.laneAbsent) return `${base} (no S1 lane)`;
  if (base === '0') {
    return cellLevel
      ? `0 (lane present; ${fmtInt(d.s1Ok)} ok of ${fmtInt(d.s1Calls)})`
      : '0 (lane present)';
  }
  return base;
}

/** Coverage beside a System-1 column: a fraction when the lane exists, `undefined` when it does not. */
function coverageFor(cell) {
  const d = cell.a.diagnostics;
  if (d.laneAbsent) {
    return `undefined — no S1 lane (judged ${fmtInt(d.judgedPairs)}/${fmtInt(d.scoredPairs)}; the lexical fallback still built ${fmtInt(d.edgeSourceLexical)} edge(s))`;
  }
  return `${fmtPct(d.coverage)} (${fmtInt(d.judgedPairs)}/${fmtInt(d.scoredPairs)} judged/scored)`;
}

function coverageLine(cells) {
  return `coverage beside each System-1 column: ${cells.map((c) => `${c.display} ${coverageFor(c)}`).join(' · ')}`;
}

/** Render one System-1 bucket cell, annotating the call count with the cell's coverage. */
function annotateS1(metric, cell, bucket) {
  const v = renderS1Value(metric, cell, valueFor(metric, bucket), { cellLevel: false });
  return metric.key === 's1Calls' ? `${v} (cov ${cell.a.diagnostics.laneAbsent ? 'n/a' : fmtPct(cell.a.diagnostics.coverage)})` : v;
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
  const present = cells.filter((c) => !c.a.diagnostics.laneAbsent);
  const absent = cells.filter((c) => c.a.diagnostics.laneAbsent);
  const parts = [];
  if (present.length > 0) {
    parts.push(`had a System-1 lane: ${present.map((c) => `${c.display} — ${c.a.diagnostics.laneLabel}`).join(' · ')}`);
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
  const { cells, runDir, snapshotAt, warnings } = analysis;
  const out = [];
  const cellNames = cells.map((c) => c.name);
  const headers = cells.map((c) => c.display);

  out.push('# S1CAP cell report');
  out.push('');
  out.push(`- run: \`${runDir}\``);
  out.push(`- cells: ${cells.map((c) => `\`${c.name}\`${c.label !== c.name ? ` = ${c.label}` : ''}`).join(' · ')}`);
  out.push(`- snapshot taken: ${snapshotAt} (all counts are of the artifacts as read at this instant)`);
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
  if (cells.some((c) => c.a.diagnostics.laneAbsent)) {
    out.push('A System-1 `0 (no S1 lane)` means the cell had no lane configured, so the zero is by construction;');
    out.push('`0 (lane present; …)` means a lane existed and its calls were refused or timed out. The two are');
    out.push('never printed the same way.');
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
  out.push('Two readings that look alike are kept apart here. A cell with the lane switched off has zero');
  out.push('System-1 calls, tokens and time *by construction*; a cell with a lane whose backend refused every');
  out.push('request has a real call count, a real failure split and a measured coverage. The lane state is read,');
  out.push('never inferred from the call count: it comes from the `kind:"wiring"` record the plugin writes once');
  out.push('at activation onto the cell\'s own tape (`home/<cell>/.s1cap/tape.jsonl`), whose `s1` field is');
  out.push('literally `"none"` for the Off choice and `{provider, mode, baseUrl}` otherwise; the tape\'s');
  out.push('`tuning-file` record and the `provider` on the `s1_call` records are the fallbacks. Only when none');
  out.push('of those exist is the absence inferred from the silence, and the report says so.');
  out.push('');
  out.push(mdTable(['diagnostic', ...headers], [
    ['System-1 lane', ...cells.map((c) => c.a.diagnostics.laneLabel)],
    ['System-1 calls ok / refused / total', ...cells.map((c) => (c.a.diagnostics.laneAbsent
      ? '— (no S1 lane)'
      : `${fmtInt(c.a.diagnostics.s1Ok)} / ${fmtInt(c.a.diagnostics.s1Refused)} / ${fmtInt(c.a.diagnostics.s1Calls)}`))],
    ['System-1 call success rate', ...cells.map((c) => (c.a.diagnostics.laneAbsent ? '— (no S1 lane)' : fmtPct(c.a.diagnostics.s1SuccessRate)))],
    ['System-1 calls refused', ...cells.map((c) => (c.a.diagnostics.laneAbsent ? '— (no S1 lane)' : fmtInt(c.a.diagnostics.s1Refused)))],
    ['top refusal reason', ...cells.map((c) => (c.a.diagnostics.s1ErrorTop ? `${c.a.diagnostics.s1ErrorTop[0]} ×${c.a.diagnostics.s1ErrorTop[1]}` : (c.a.diagnostics.laneAbsent ? '— (no S1 lane)' : '— (none refused)')) )],
    ['association pairs judged / scored', ...cells.map((c) => (c.a.diagnostics.laneAbsent
      ? `${fmtInt(c.a.diagnostics.judgedPairs)} / ${fmtInt(c.a.diagnostics.scoredPairs)} (backend never judged)`
      : `${fmtInt(c.a.diagnostics.judgedPairs)} / ${fmtInt(c.a.diagnostics.scoredPairs)}`))],
    ['**System-1 coverage**', ...cells.map((c) => (c.a.diagnostics.laneAbsent ? '**undefined** (no S1 lane)' : `**${fmtPct(c.a.diagnostics.coverage)}**`))],
    ['association edges from s1-noul / lexical', ...cells.map((c) => `${fmtInt(c.a.diagnostics.edgeSourceS1)} / ${fmtInt(c.a.diagnostics.edgeSourceLexical)}`)],
    ['context injections delivered', ...cells.map((c) => `${fmtInt(c.a.diagnostics.injections)} of ${fmtInt(c.a.diagnostics.contextSteps)} steps`)],
    ['cache hit rate (hit ÷ (hit+miss))', ...cells.map((c) => fmtPct(c.a.diagnostics.cacheHitRate))],
    ['human messages / harness- or plugin-injected', ...cells.map((c) => `${fmtInt(c.a.diagnostics.humanMessages)} / ${fmtInt(c.a.diagnostics.injectedMessages)}`)],
  ]));
  out.push('');
  out.push('Coverage is `judgedPairs / scoredPairs` for a cell that had a lane. For a cell with no lane it is');
  out.push('**undefined**, not 0: `judgedPairs` is 0 because the backend was never asked, and printing 0/N');
  out.push('would describe a backend that judged none of what it was shown, which is a different claim about a');
  out.push('backend that does not exist in that cell. The lexical fallback still scores and still builds edges,');
  out.push('which is why the edge row is split by source.');
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
        if (m.key === 's1Calls') return `${renderS1Value(m, c, valueFor(m, t), { cellLevel: false })} (cov ${c.a.diagnostics.laneAbsent ? 'n/a' : fmtPct(c.a.diagnostics.coverage)})`;
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
      if (isS1Metric(m) && c.a.diagnostics.laneAbsent) return `0 (no S1 lane; ÷${n})`;
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
    const diag = [
      ['mechanism', 'System-1 lane', 'flag', d.laneLabel],
      ['mechanism', 'System-1 lane absent (zero by construction)', 'flag', d.laneAbsent ? 1 : 0],
      ['mechanism', 'System-1 lane provider', 'flag', d.laneProvider ?? ''],
      ['mechanism', 'System-1 calls ok', 'count', d.laneAbsent ? 0 : d.s1Ok],
      ['mechanism', 'System-1 calls refused', 'count', d.laneAbsent ? 0 : d.s1Refused],
      ['mechanism', 'System-1 call success rate', 'ratio', d.s1SuccessRate],
      ['mechanism', 'association pairs scored', 'count', d.scoredPairs],
      ['mechanism', 'association pairs judged', 'count', d.judgedPairs],
      // omitted rather than written as 0 when the lane is absent: a 0 here would be read as a measurement
      ['mechanism', 'System-1 coverage (judged/scored)', 'ratio', d.laneAbsent ? null : d.coverage],
      ['mechanism', 'System-1 coverage state', 'flag', d.laneAbsent ? 'undefined (no S1 lane)' : 'defined'],
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
  // pad.top carries the panel title, the note, and the headroom the rotated value labels need above
  // the tallest bar: a label anchored at the top of a full-height bar must still clear the note.
  const pad = { left: 118, right: 30, top: 108, bottom: 96 };
  const plotW = width - pad.left - pad.right;
  const plotH = 250;
  const top = y + pad.top;
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

  out.push(`<g transform="translate(0,${y})">`);
  out.push(`  <text x="${pad.left}" y="30" class="panel-title">${escapeXml(title)}</text>`);
  if (note) out.push(`  <text x="${pad.left}" y="56" class="panel-note">${escapeXml(note)}</text>`);

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

function svgDocument({ title, subtitle, panels, width }) {
  let y = 0;
  let body = '';
  for (const p of panels) {
    const r = barPanel({ ...p, y, width });
    body += r.svg + '\n';
    y += r.height;
  }
  const height = y + 52 + 40;
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
  <text x="30" y="54" class="doc-sub">${escapeXml(subtitle)}</text>
  <g transform="translate(0,52)">
${body}  </g>
</svg>
`;
}

function renderSvgs(analysis) {
  const { cells, runDir, snapshotAt } = analysis;
  const width = 1120;
  const svgCells = cells.map((c, i) => ({
    name: c.name,
    display: c.label !== c.name ? `${c.label} (${c.name})` : c.name,
    colour: CELL_COLOURS[i % CELL_COLOURS.length],
    laneAbsent: c.a.diagnostics.laneAbsent,
  }));
  const sub = (group) =>
    `run ${runDir} · group: ${group} · one group per metric, one bar per cell · snapshot ${snapshotAt}`;
  /**
   * A System-1 bar of zero is labelled with why it is zero, exactly as in the tables: a bar that says
   * `0 (no lane)` and a bar that says `0 (lane, 0 ok)` are different findings and must not be drawn
   * the same way.
   */
  const s1Label = (key, name, raw, text) => {
    const cell = cells.find((x) => x.name === name);
    if (!cell) return text;
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
    .map((c) => `${c.label !== c.name ? c.label : c.name}: ${c.a.diagnostics.laneAbsent ? 'no S1 lane' : `S1 ${c.a.diagnostics.laneProvider ?? 'present'}`}`)
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
    subtitle: `${sub('time')} · ${laneSummary}`,
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
    subtitle: `${sub('cost')} · ${laneSummary} · cache hit rate is a mechanism diagnostic and is deliberately NOT in this chart`,
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
    subtitle: `${sub('mechanism')} · coverage = judgedPairs / scoredPairs from the association-graph snapshot · ${laneSummary}`,
    width,
    panels: [
      {
        title: 'System-1 governance',
        note: 'coverage is the share of scored association pairs the backend actually judged. A cell with no lane has no coverage at all - not a coverage of zero - so its bar is absent.',
        unit: 'ratio',
        metrics: [
          { key: 'coverage', label: 'System-1 coverage (judged/scored)' },
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
            return cell && cell.a.diagnostics.laneAbsent && (key === 'coverage' || key === 's1SuccessRate')
              ? 'n/a (no lane)'
              : 'n/a';
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
  --quiet           do not print the markdown report to stdout
  --self-test       build a synthetic run under the OS temp directory and assert the arithmetic
`;

function parseArgs(argv) {
  const opts = { cells: [], label: new Map(), format: null, out: null, run: null, quiet: false, selfTest: false, help: false };
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
  return { runDir, snapshotAt, cells, warnings };
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
// 11. --self-test
//
// Builds a real run directory under the OS temp directory - real multi-frame zstd session stores,
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
  const tapeE = [{ schema: 0, kind: 'wiring', s1: 'none', relevance: false, planGate: false, xFirst: false }];

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
  return { builtA, eventsA: A };
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

    const analysis = analyseRun(root, ['A', 'B', 'E', 'F'], new Map([['A', 'alpha'], ['E', 'never'], ['F', 'refused']]), '2026-01-01T00:00:00.000Z');
    const A = analysis.cells.find((c) => c.name === 'A');
    const B = analysis.cells.find((c) => c.name === 'B');
    const E = analysis.cells.find((c) => c.name === 'E');
    const F = analysis.cells.find((c) => c.name === 'F');

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
      assertEqual(A.a.totals.s1Tokens, 7 + 9 + 9 + 3, 'A System-1 lane tokens');
    }, 'cell A tokens (hit 600, miss 60, out 18, S1 lane 28)');

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
      assertEqual(B.a.totals.s1Tokens, 11, 'B S1 lane tokens');
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
      for (const label of ['System-1 time per step', 'System-1 lane\'s own tokens per step']) {
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
      assertEqual(E.a.totals.s1Tokens, 0, 'E System-1 lane tokens');
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
