#!/usr/bin/env node
/**
 * S1CAP recall activity — one cell, one round: what the recall walk did, invocation by invocation.
 *
 * The matrix has one COLUMN per invocation of the recall/BFS inside the cell (the `assembly` records of
 * the control plane, in time order, each attributed to the turn/step it ran in) and one ROW per segment
 * of the cell's final association graph, numbered from 0 for the oldest, drawn WITH THE OLDEST AT THE
 * BOTTOM. A cell of the matrix is one (segment, invocation) pair.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT IS RECORDED, AND WHAT IS NOT — read this before reading the picture
 *
 * Every state below is read out of a run artifact. Nothing is inferred from a count, and nothing is
 * filled in from a plausible default; an input that is missing is an error, never a blank matrix.
 *
 *   1. `not yet created` — the segment's recorded creation stamp (`segments[].ts`) is later than the
 *      invocation's stamp (`assembly.ts`). One correction is applied, and it is a recorded fact rather
 *      than a tolerance: a step's pre-step payload is written to the graph by the upkeep lane a few
 *      milliseconds AFTER the assembly that consumed it, so the segments a step itself carried can
 *      carry a stamp later than the invocation that already used them. The step's payload is on the
 *      tape (`{sessionId, step, systemPrompt, messages}`), so those ids are read from there and marked
 *      as existing. The correction is counted and printed: it only ever turns a would-be blank cell
 *      into "exists", never the other way round.
 *
 *      One **documented tolerance** sits beside that correction, and it is bounded rather than general:
 *      a segment whose recorded stamp is later than the invocation that *selected* it may still have
 *      existed when it was selected, because the association-graph upkeep writes the row asynchronously
 *      and lags the assembly by a few tens of milliseconds. Round `20261002-2037` is the case that
 *      forced it: `--cell C2` exited 1 on assembly #1, whose selected segment carried `ts` 37 ms after
 *      the assembly and 26 ms after the delivery that carried it, over 277 invocations of otherwise
 *      usable evidence. `ASYNC_LAG_TOLERANCE_MS` is the window, it is applied to every segment in the
 *      same direction, and it is counted and printed (`lagCells`). Beyond it the figure is still
 *      refused: a selection that precedes its segment's existence by more than the window is a
 *      contradiction, not a race, and `--self-test` asserts both sides of that line.
 *
 *   2. `recall candidate` — the segment's id is a node of that invocation's recorded `recallTree`
 *      (excluding the root, which is the anchor the walk started from). `recallTree` is the shape of
 *      the walk that produced the step's recall: every hit `recall` returned, ids only. `candidates`
 *      in the same record is the number of those hits, and this tool asserts that identity rather
 *      than trusting it.
 *
 *   3. `existed, the walk did not return it` — it is in the graph at that invocation (1) and not a
 *      node of the walk (2). This is NOT "judged irrelevant": the walk only follows edges at or above
 *      the relevance threshold r, from the anchor it chose, and a pair that was never scored has no
 *      edge to follow at all. The matrix reports what the walk returned, not a relevance verdict.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT THE FILL OF A RECALLED CELL MEANS: THE BFS LAYER
 *
 * `candidate` and `root` are the only two states drawn in the walk's blue, and the layer is read out of
 * the `recallTree` itself: the anchor the walk started from is layer 0, its children are layer 1, their
 * children layer 2, and so on. The nesting in the record IS the layer — nothing is inferred from a
 * distance, a score, or a timestamp, and a tree whose shape this walk cannot read (a node that is not an
 * object, an id that appears at two different layers) is refused rather than drawn at a guessed depth.
 *
 * Layer 0 is the darkest and each layer above it is one step lighter along a single-hue ramp derived
 * from the existing `#2f6fd0` (same hue 216°, same saturation 63%, lightness 50% at layer 0 decaying to
 * 63% at the run's deepest layer). No second hue family is introduced, and the lightest shade the ramp
 * can reach is still unmistakably darker than `existed` (#d7e0ee) and `absent` (#ffffff) — every
 * recalled cell reads as recalled, and which layer it was is read off the shade.
 *
 * **The ramp is normalised over the whole run, not per column.** Its length is sized by the maximum
 * `bfsDepth` recorded across the run's invocations, so one shade means one layer in every column of the
 * figure and the columns can be compared against each other. That normalisation has a stated cost, which
 * is the price of comparability: a run whose walks are all shallow draws a flat blue, and the deepest
 * shade present is then layer 0. The figure prints the depth it was sized for, and when that depth is
 * larger than the layer a given walk reached it is truncated for that invocation at its OWN `bfsDepth` —
 * a recorded fact, compared against the run-global scale rather than quietly fitted to it.
 *
 * Layer is carried by the FILL and by nothing else. The ring (a delivered selection) and the caret (the
 * walk's own root) encode different recorded facts and are never removed or moved by a layer; where the
 * layer's shade would swallow one, the MARK's ink is chosen for contrast against that shade instead.
 *
 *   THE SELECTED SET. `assembly.selected` is a COUNT (`recall.selected = layout.recalled.length`); the
 *   control plane records no per-segment identity for it, and `recallTree` is explicitly the candidate
 *   walk rather than the ranking (see `recallTreeOf` in packages/core/src/assembler.ts). The identity
 *   is written in exactly one place: the injected message a delivered block becomes holds one
 *   provenance line per selected segment, `## earlier <kind> turn, quoted verbatim · <parent-id>`, and
 *   its id is the `payloadId` the `context_delivery` record carries. So this tool draws the selected
 *   identity where — and only where — that payload is in the evidence, as a ring, and elsewhere it
 *   draws the recorded COUNT (the bar panel and the per-invocation table say `count only`). It never
 *   substitutes one for the other and never re-labels a candidate as selected. The summary line
 *   prints how many selected segments are covered by a recorded identity and how many are not.
 *
 *   Provenance lines are counted against the `recalled` blocks only. Since 2026-10-04 the injected message
 *   can also carry the state proxy `T` as its own block (`stateProxy`), which is the model's own serialized
 *   trace and not a recalled turn: it has no provenance line and no selected segment behind it. So the count
 *   that has to agree with `assembly.selected` is the recall blocks, not every block the record lists. A block
 *   name this tool does not recognise is named in the failure rather than folded in, so a third block type
 *   cannot be absorbed silently — the check stays as strict as it was for the blocks it does know.
 *
 *   THE DELIVERIES THAT CARRIED NOTHING. A `context_delivery` record is written on steps that assemble
 *   nothing as well as on steps that inject (`delivered:false`, no `blocks`, no `payloadId`), because the
 *   delivery report is the only trace such a step leaves — `packages/dsh-plugin/src/index.ts` says so
 *   where it stops reading the session id off the assembly record. Those records report no selection, so
 *   there is nothing for an invocation to own and they own no column: they are counted, and the count is
 *   printed (`N of M delivery record(s) carried nothing`). They are deliberately NOT the state the
 *   attribution refusal exists to catch, which is a record that *did* deliver a selection and nonetheless
 *   cannot be attached to an invocation — that refusal is unchanged, and round `20261003-2104` is why the
 *   two had to be separated: one empty record in C2, 123 139 ms past its nearest assembly, refused a whole
 *   figure over a record that by construction had no selection in it. A run whose empty deliveries are
 *   most of its steps is a fact about the run that the figure's column count already shows; the printed
 *   count is what keeps that fact from being inferred from a silence.
 *
 * The knobs are printed from the tape — never hard-coded — and **from the record that states the values the run
 * actually used**. The `kind:"wiring"` record states them at activation; the settings panel's stored tuning is
 * applied on the first step and writes a `kind:"tuning-file"` record with `effective`. When both are present the
 * effective values are the ones printed, and the line says a retune happened and what the wiring record had said,
 * because a figure annotated with a number the session did not run with is the drift this project keeps removing
 * (`round-20261004-1618`: tuning 0.6, wiring record 0.55). Each column also reports the `windowN` its own assembly
 * record carries.
 *
 * Usage:
 *   node scripts/s1-activity.mjs --run <run-dir> --cell <name> [--out <run-dir>/report/s1-activity.svg] [--explain]
 *   node scripts/s1-activity.mjs --run <run-dir> --cell <name> --out -        (SVG to stdout, summary to stderr)
 *   node scripts/s1-activity.mjs --self-test
 *
 * Output: a self-contained SVG (no script, no external font, no network) and one summary line —
 * invocations x segments, the cells of each state, and how many selections have a recorded id — so a
 * caller can sanity-check the figure without opening it. `--explain` prints, column by column, where
 * every state came from (the creation stamp, the same-step carry, the walk, the delivered payload).
 * Exit 1 with a message naming the missing or inconsistent input when the figure cannot be drawn.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';

// ---------------------------------------------------------------------------------------------
// 1. Failures
//
// Every `fail` here is a case where a picture would otherwise have to be invented: an input that is
// absent, a record that contradicts another record, or an identity that the run did not write down.
// ---------------------------------------------------------------------------------------------

function fail(message) {
  const err = new Error(message);
  err.isActivityError = true;
  throw err;
}

// ---------------------------------------------------------------------------------------------
// 2. Small readers
//
// JSONL is read strictly: a line that does not parse is a partial record, and a matrix that silently
// drops the invocation a truncated line carried is exactly the "blank where the data was missing"
// failure this tool exists to avoid. `scripts/find-bad-jsonl-line.mjs` locates such a line.
// ---------------------------------------------------------------------------------------------

function readJsonlStrict(path, what) {
  if (!existsSync(path)) fail(`missing ${what}: ${path}`);
  const raw = readFileSync(path, 'utf8');
  const out = [];
  raw.split(/\r?\n/).forEach((line, i) => {
    if (line.trim() === '') return;
    try {
      out.push(JSON.parse(line));
    } catch (err) {
      fail(`${what} has an unparseable line ${i + 1} of ${path}: ${String(err)} — `
        + 'locate it with `node scripts/find-bad-jsonl-line.mjs <file>`');
    }
  });
  if (out.length === 0) fail(`${what} holds no records: ${path}`);
  return out;
}

function readJson(path, what) {
  if (!existsSync(path)) fail(`missing ${what}: ${path}`);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    fail(`${what} is not readable JSON (${path}): ${String(err)}`);
    return undefined;
  }
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Strictly numeric, so a string field where a number belongs is an error and not a silent 0. */
function numOf(record, field, where) {
  const v = record?.[field];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    fail(`${where}: field \`${field}\` is not a finite number (got ${JSON.stringify(v)})`);
  }
  return v;
}

const shortId = (id, n = 8) => (id.length > n ? id.slice(0, n) : id);

/**
 * A segment id as a row label. The chunk suffix is kept — `95e3cc48…f33a#0` and `…#1` are two rows of one
 * longer event, and truncating them to the same eight characters would print two rows with one name.
 */
function rowLabelId(id) {
  const chunk = /^(.+)#(\d+)$/.exec(id);
  if (chunk) return `${chunk[1].slice(0, 8)}#${chunk[2]}`;
  return shortId(id);
}
const pad2 = (n) => String(n).padStart(2, '0');

/** Wall clock of a record stamp, in the reading host's zone (the round directory is named in it too). */
function clock(ts) {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

/** Greedy word wrap, used for the notes the figure carries. */
function wrap(text, max) {
  const lines = [];
  let line = '';
  for (const word of String(text).split(' ')) {
    if (line !== '' && (line + ' ' + word).length > max) {
      lines.push(line);
      line = word;
    } else {
      line = line === '' ? word : `${line} ${word}`;
    }
  }
  if (line !== '') lines.push(line);
  return lines;
}

/**
 * A path that fits the caption. A session store lives under a directory named after the whole workspace
 * path, so the interesting part of it is at the END; whole middle segments are dropped rather than the
 * tail, because "session.v4.jsonl.zstd" is the part a reader needs to find the file.
 */
function elidePath(path, max = 132) {
  if (path.length <= max) return path;
  const parts = String(path).split('/');
  const head = [parts[0]];
  const tail = parts.slice(1);
  while (tail.length > 1 && `${head.join('/')}/…/${tail.join('/')}`.length > max) tail.shift();
  return `${head.join('/')}/…/${tail.join('/')}`;
}

// ---------------------------------------------------------------------------------------------
// 3. Multi-frame zstd reader (carried from `scripts/cell-report.mjs`, which carried it from
//    `.s1cap-ablation/session-store.mjs`)
//
// The harness session store is appended to one zstd frame per write, and Node's `zstdDecompressSync`
// stops at the end of the FIRST frame: a naive read of a 40 KB store returns the session header and
// nothing else. Turn/step attribution needs the `step/start` events, which are in the later frames,
// so the frames are walked explicitly.
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
  if (!singleSegment) p += 1;
  p += [0, 1, 2, 4][dictFlag];
  p += fcsFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][fcsFlag];
  for (;;) {
    const header = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
    p += 3;
    const last = header & 1;
    const blockType = (header >> 1) & 3;
    const blockSize = header >> 3;
    if (blockType === 1) p += 1;
    else p += blockSize;
    if (last) break;
  }
  if (hasChecksum) p += 4;
  return p - off;
}

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
    if (magic !== ZSTD_MAGIC) break; // a trailing partial frame is the only expected case
    const size = frameSize(buf, off);
    parts.push(zstdDecompressSync(buf.subarray(off, off + size)).toString('utf8'));
    off += size;
  }
  const events = [];
  for (const line of parts.join('').split(/\r?\n/)) {
    if (line.trim() === '') continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      /* an unparseable session line is not part of the control plane; the events read are reported */
    }
  }
  return { events, frames: parts.length, bytes: buf.length };
}

// ---------------------------------------------------------------------------------------------
// 4. The run's inputs
//
// Four files and one snapshot. Each is required for a stated reason; the error message says which
// state it carries, because "the chart is missing a column" is not a useful failure to receive.
// ---------------------------------------------------------------------------------------------

function loadControl(runDir, cell) {
  const path = join(runDir, 'evidence', cell, 'control.jsonl');
  const records = readJsonlStrict(path, `the control plane of cell ${cell}`);
  const assemblies = records.filter((r) => r?.type === 'assembly');
  if (assemblies.length === 0) {
    fail(`${path} records no \`assembly\` event: cell ${cell} ran no recall invocation, so there is no matrix `
      + 'to draw (this is not an empty chart, it is a missing one)');
  }
  assemblies.forEach((a, i) => {
    const where = `assembly #${i + 1} of ${path}`;
    numOf(a, 'ts', where);
    numOf(a, 'seq', where);
    numOf(a, 'candidates', where);
    numOf(a, 'selected', where);
    numOf(a, 'bfsDepth', where);
    numOf(a, 'windowN', where);
    if (a.recallTree === null || typeof a.recallTree !== 'object' || Array.isArray(a.recallTree)) {
      // `{}` is a reading ("the walk found nothing") and must be present; an absent field is not one.
      fail(`${where}: \`recallTree\` is ${JSON.stringify(a.recallTree)} — the walk's own record of the ids it `
        + 'returned is what the candidate state is read from, and a missing field is not an empty walk');
    }
    if (a.blocks === null || typeof a.blocks !== 'object') fail(`${where}: no \`blocks\` token accounting`);
  });
  const deliveries = records.filter((r) => r?.type === 'context_delivery');
  for (const d of deliveries) {
    if (typeof d.cell === 'string' && d.cell !== cell) {
      fail(`${path}: a context_delivery record is stamped cell ${JSON.stringify(d.cell)} but --cell ${cell} was `
        + 'asked for — the evidence does not belong to this cell');
    }
    if (d.delivered === true && (typeof d.payloadId !== 'string' || d.payloadId === '')) {
      fail(`${path}: a delivered context_delivery at ts ${d.ts} carries no payloadId, so the selected ids it `
        + 'delivered cannot be located');
    }
    if (d.delivered === true && !Array.isArray(d.blocks)) {
      fail(`${path}: a delivered context_delivery at ts ${d.ts} carries no \`blocks\` list`);
    }
  }
  const sessionIds = [...new Set(assemblies.concat(deliveries)
    .map((r) => r.sessionId)
    .filter((s) => typeof s === 'string' && s !== ''))];
  return { path, records, assemblies, deliveries, sessionIds };
}

function loadSnapshot(runDir, cell, sessionIds) {
  const dir = join(runDir, 'home', cell, '.s1cap', 'rg');
  if (!existsSync(dir)) fail(`missing the association-graph snapshot directory: ${dir}`);
  const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.json')).sort();
  if (files.length === 0) fail(`no association-graph snapshot in ${dir} — the rows of the matrix are its segments`);
  const parsed = files.map((f) => {
    const path = join(dir, f);
    return { file: f, path, doc: readJson(path, 'the association-graph snapshot') };
  });
  const wanted = new Set(sessionIds);
  const matching = parsed.filter((p) => wanted.has(p.doc.sessionId));
  let chosen;
  if (matching.length === 1) chosen = matching[0];
  else if (matching.length === 0 && parsed.length === 1 && wanted.size === 0) {
    // No sessionId anywhere in the control plane and exactly one snapshot: the association is by
    // uniqueness, which is stated rather than assumed.
    chosen = parsed[0];
  } else if (matching.length > 1) {
    fail(`${dir} holds ${matching.length} snapshots of session ${[...wanted].join(', ')} (${matching.map((m) => m.file).join(', ')}) `
      + '— which graph the matrix is drawn from cannot be decided here');
  } else {
    fail(`${dir} holds no snapshot of session ${[...wanted].join(', ') || '(none recorded in the control plane)'} `
      + `(${parsed.map((p) => `${p.file}: session ${JSON.stringify(p.doc.sessionId)}`).join(', ')})`);
  }
  const doc = chosen.doc;
  if (!Array.isArray(doc.segments) || doc.segments.length === 0) {
    fail(`${chosen.path}: \`segments\` is not a non-empty array`);
  }
  doc.segments.forEach((s, i) => {
    const where = `segment #${i + 1} of ${chosen.path}`;
    if (typeof s.id !== 'string' || s.id === '') fail(`${where}: no id`);
    numOf(s, 'ts', where);
    numOf(s, 'tokens', where);
  });
  const byId = new Map(doc.segments.map((s) => [s.id, s]));
  if (byId.size !== doc.segments.length) fail(`${chosen.path}: duplicate segment ids`);
  let order;
  if (Array.isArray(doc.order) && doc.order.length > 0) {
    order = doc.order;
    if (order.length !== doc.segments.length || new Set(order).size !== order.length) {
      fail(`${chosen.path}: \`order\` is not a permutation of \`segments\` (${order.length} vs ${doc.segments.length})`);
    }
    for (const id of order) if (!byId.has(id)) fail(`${chosen.path}: \`order\` names ${id}, which is not a segment`);
  } else if (doc.segments.every((s) => typeof s.seq === 'number')) {
    // Append order is the graph's own order. `seq` is the session-log sequence of the message that
    // produced the segment, so ordering by it reproduces that order; said out loud, not assumed.
    order = [...doc.segments].sort((a, b) => a.seq - b.seq || a.ts - b.ts).map((s) => s.id);
    if (new Set(order).size !== order.length) fail(`${chosen.path}: cannot order segments by \`seq\` (ties)`);
  } else {
    fail(`${chosen.path}: neither \`order\` nor a per-segment \`seq\` is present, so the row order — oldest `
      + 'first — cannot be stated');
  }
  return { path: chosen.path, file: chosen.file, doc, byId, order, segments: order.map((id) => byId.get(id)) };
}

function loadTape(runDir, cell) {
  const path = join(runDir, 'home', cell, '.s1cap', 'tape.jsonl');
  const records = readJsonlStrict(path, `the tape of cell ${cell}`);
  const wiring = records.filter((r) => r?.kind === 'wiring');
  if (wiring.length === 0) {
    fail(`${path} holds no \`kind:"wiring"\` record; the switches the cell ran with are stated there and nowhere `
      + 'else, and the knobs are read from it rather than assumed');
  }
  const recall = wiring[0].recall;
  if (recall === null || typeof recall !== 'object') fail(`${path}: the wiring record carries no \`recall\` block`);
  // A round can write the wiring record more than once — the plugin states its switches at every
  // activation, and a restart mid-round is normal. Agreement is what makes them one set of knobs; two
  // records that disagree cannot be attributed to a column (the record carries no timestamp), so the
  // knobs would be a guess and the figure is refused instead.
  const shape = (r) => JSON.stringify(r?.recall ?? null);
  const distinct = [...new Set(wiring.map(shape))];
  if (distinct.length > 1) {
    fail(`${path} holds ${wiring.length} \`kind:"wiring"\` records that disagree about the recall knobs `
      + `(${distinct.join(' vs ')}); they carry no timestamp, so which invocation ran with which cannot be read `
      + 'off the tape — the annotation would be a guess');
  }
  const knobs = {
    w: numOf(recall, 'w', `the wiring record of ${path}`),
    r: numOf(recall, 'r', `the wiring record of ${path}`),
    d: numOf(recall, 'd', `the wiring record of ${path}`),
  };
  if (typeof recall.wait === 'number') knobs.wait = recall.wait;
  // **The knobs the session actually ran with, which are not always the ones the wiring record states.**
  //
  // The wiring record is written at activation; the settings panel's stored tuning is applied on the *first step*
  // (`primeOnce` in `packages/dsh-plugin/src/index.ts`, where the credential service becomes answerable) and it
  // writes a `kind:"tuning-file"` record carrying `effective`. Reading only the wiring record is how a round that ran
  // `r = 0.6` could be drawn with `r = 0.55` annotated on it — measured on `round-20261004-1618`, whose tuning file
  // said 0.6 while its wiring record said 0.55, and this figure printed the wiring value. `cell-report.mjs` already
  // reads both (`recall.w`, then `effective.window`) and calls the second "the value in force after a retune"; this
  // is that rule applied to the knobs this figure annotates.
  //
  // The pre-tuning values are kept beside the effective ones, so the printed line can say a retune happened rather
  // than quietly printing a number the wiring record does not carry.
  const tuning = records.filter((r) => r?.kind === 'tuning-file');
  const retuned = {};
  if (tuning.length > 0) {
    const shapeOf = (t) =>
      JSON.stringify([t.effective?.depth, t.effective?.relevanceThreshold, t.effective?.window, t.effective?.anchorWaitMs]);
    const shapes = [...new Set(tuning.map(shapeOf))];
    if (shapes.length > 1) {
      fail(`${path} holds ${tuning.length} \`kind:"tuning-file"\` records that disagree about the effective knobs `
        + `(${shapes.join(' vs ')}); like the wiring records they carry no timestamp, so which invocation ran with `
        + 'which cannot be read off the tape and the annotation would be a guess');
    }
    const eff = tuning[0].effective ?? {};
    if (typeof eff.window === 'number') knobs.w = eff.window;
    if (typeof eff.relevanceThreshold === 'number') knobs.r = eff.relevanceThreshold;
    if (typeof eff.depth === 'number') knobs.d = eff.depth;
    if (typeof eff.anchorWaitMs === 'number') knobs.wait = eff.anchorWaitMs;
    for (const k of ['w', 'r', 'd', 'wait']) {
      if (knobs[k] !== (k === 'wait' ? recall.wait : recall[k])) {
        retuned[k] = { from: k === 'wait' ? recall.wait : recall[k], to: knobs[k] };
      }
    }
  }
  // The step payload records: `{schema, sessionId, step, systemPrompt, messages}` — what the harness
  // handed the pre-step hook. They carry the ids a step itself brought, which is the same-step
  // existence correction (see the header).
  const payloads = records.filter((r) => r && r.kind === undefined && Array.isArray(r.messages) && typeof r.step === 'number');
  // How many times the cell stated its switches. More than one is a restart mid-round, which is worth
  // printing rather than swallowing: it is the one fact that explains a step payload record appearing twice.
  return { path, knobs, retuned, payloads, wiringCount: wiring.length };
}

function loadStepBoundaries(runDir, cell, sessionIds) {
  const root = join(runDir, 'home', cell, 'sessions');
  if (!existsSync(root)) {
    fail(`missing the cell's session store directory: ${root} — the turn/step a column ran in is read from its `
      + 'step/start events, and the columns must be labelled');
  }
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name === 'session.v4.jsonl.zstd') found.push({ path: p, sessionId: basename(dirname(p)) });
    }
  };
  walk(root);
  if (found.length === 0) fail(`no session.v4.jsonl.zstd under ${root}`);
  const wanted = new Set(sessionIds);
  const matching = found.filter((f) => wanted.has(f.sessionId));
  let chosen;
  if (matching.length === 1) chosen = matching[0];
  else if (matching.length === 0 && found.length === 1 && wanted.size === 0) chosen = found[0];
  else if (matching.length > 1) {
    fail(`${root} holds ${matching.length} session stores of session ${[...wanted].join(', ')} `
      + `(${matching.map((m) => m.path).join(', ')}) — the step boundaries are ambiguous`);
  } else {
    fail(`${root} holds no session store of session ${[...wanted].join(', ') || '(none recorded)'} `
      + `(${found.map((f) => `${f.sessionId}`).join(', ')}) — without it a column cannot be mapped to a turn/step`);
  }
  const { events, frames, bytes } = readSessionStore(chosen.path);
  const steps = events
    .filter((e) => e?.type === 'step/start' && typeof e.time === 'number')
    .map((e) => ({ time: e.time, turn: e.data?.turn ?? null, step: e.data?.step ?? null, seq: e.seq ?? null }))
    .sort((a, b) => a.time - b.time);
  if (steps.length === 0) {
    fail(`${chosen.path} records no readable \`step/start\` event (${frames} zstd frame(s), ${bytes} bytes) — a `
      + 'column label is the turn and step the invocation ran in');
  }
  if (steps.some((s) => s.turn === null || s.step === null)) {
    fail(`${chosen.path}: a step/start event carries no \`data.turn\`/\`data.step\``);
  }
  return { path: chosen.path, steps, frames, events };
}

/**
 * Texts of the messages the harness logged, by id: the **evidence copy** of the session stream, and the
 * **session store** as a fallback for a message the stream file does not carry - which is what this function
 * has always done, and what its sources are ordered for.
 *
 * It used to also *require* the two to be byte-identical, and that check was wrong. Measured on round
 * `20261004-1239`: of 26 injected messages, 24 agreed exactly and 2 did not, and the disagreements run in both
 * directions -
 *
 *   - two injected messages carried **exactly 63 trailing spaces** more in the store than in the evidence copy,
 *     with `store.includes(evidence) === true` and the converse false, so the store holds the evidence text plus
 *     padding;
 *   - a compaction summary differed by **2 characters**: the evidence copy reads `<compacted-summary>\n\n##` and
 *     the store reads `<compacted-summary>##`.
 *
 * So the two artifacts record the same payload with **different whitespace layout, in both directions**, and no
 * single normalisation makes them equal without also erasing layout that may carry meaning in a markdown body.
 * The check therefore compared two representations and called the difference a disagreement about content, which
 * it is not - and it made the figure unrenderable on a round whose payloads are fine.
 *
 * The store keeps its documented role (a fallback) and any divergence is **counted and reported**, never silent:
 * a reader is told the two copies were not byte-identical and by how much, rather than being shown a figure that
 * quietly assumed agreement.
 */
function loadMessageTexts(runDir, cell, stepInfo) {
  const map = new Map();
  const sources = [];
  const divergent = [];
  const evidence = join(runDir, 'evidence', cell, 'session.jsonl');
  if (existsSync(evidence)) {
    for (const record of readJsonlStrict(evidence, `the session stream of cell ${cell}`)) {
      if (typeof record?.id === 'string' && typeof record.text === 'string') map.set(record.id, record.text);
    }
    sources.push(evidence);
  }
  for (const e of stepInfo.events) {
    if (e?.type !== 'user/message') continue;
    const data = e.data;
    if (typeof data?.id !== 'string' || !Array.isArray(data.content)) continue;
    const text = data.content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
    const previous = map.get(data.id);
    if (previous !== undefined && previous !== text) {
      // Both have it and they are not byte-identical. The evidence copy wins - it is this function's primary
      // source and the record of what the cell was actually sent - and the divergence is reported below.
      let i = 0;
      while (i < previous.length && i < text.length && previous[i] === text[i]) i++;
      divergent.push({ id: data.id, at: i, evidenceChars: previous.length, storeChars: text.length });
    }
    map.set(data.id, text);
    map.set(data.id, text);
  }
  sources.push(stepInfo.path);
  if (divergent.length > 0) {
    // Never silent: a reader has to know the two copies were not byte-identical, or the quoted text would look
    // like an exact agreement it is not. The evidence copy is what is quoted.
    const detail = divergent.slice(0, 3)
      .map((d) => `${d.id} (first difference at char ${d.at}; ${d.evidenceChars} vs ${d.storeChars} chars)`)
      .join('; ');
    process.stderr.write(`s1-activity: ${divergent.length} of the delivered messages are NOT byte-identical between the evidence `
      + `copy and the session store. The evidence copy is quoted. ${detail}${divergent.length > 3 ? '; …' : ''}\n`);
  }
  return { map, sources };
}

// ---------------------------------------------------------------------------------------------
// 5. Attribution: which turn and step each invocation ran in
//
// The control plane carries `ts` but no turn/step (its `seq` is the plugin's own running message
// counter, not a step number), so records are attributed by time: the pre-step hook runs immediately
// before the step it belongs to, so an invocation belongs to the first `step/start` at or after it.
// The mapping must be injective and order-preserving; anything else is reported rather than guessed.
// ---------------------------------------------------------------------------------------------

const ATTRIBUTION_WINDOW_MS = 120000;
/** How far after its invocation a message a step carried may be stamped before the match is refused. */
const CARRY_SLACK_MS = 60000;
/**
 * How far after an invocation a segment's row may be stamped and still count as having existed for it.
 *
 * This is the async-upkeep lag, and it is a property of the system rather than a slack in the reader:
 * `AssociationGraph.addSegments` runs on the upkeep queue, which is deferred by `schedule` (a `setTimeout`), while
 * `assembly.ts` is the step's own stamp. A segment that a step carried - and, in a delivered block, that the run
 * *selected* - can therefore be written a few tens of milliseconds after the invocation that used it. Measured in
 * round `20261002-2037`: 37 ms, with the delivery that carried the segment 26 ms after the assembly. 250 ms is an
 * order of magnitude above the observed lag and three orders below `ATTRIBUTION_WINDOW_MS`, so it cannot absorb a
 * real ordering error: the self-test's "a selection that does not exist yet" defect is 50 ms late and still fails,
 * and a separate self-test case asserts that a lag inside this window draws instead of throwing.
 */
const ASYNC_LAG_TOLERANCE_MS = 250;

function attributeToSteps(invocations, steps, what) {
  const claims = new Map();
  return invocations.map((record, i) => {
    const next = steps.find((s) => s.time >= record.ts);
    if (next === undefined) {
      fail(`${what} #${i + 1} (ts ${record.ts}) has no \`step/start\` at or after it — it cannot be placed in a `
        + 'turn/step, and a column without a label is not drawn');
    }
    const gap = next.time - record.ts;
    if (gap > ATTRIBUTION_WINDOW_MS) {
      fail(`${what} #${i + 1} (ts ${record.ts}) is ${gap} ms before the next step/start (turn ${next.turn} step `
        + `${next.step}) — further than the attribution window of ${ATTRIBUTION_WINDOW_MS} ms, so the attribution `
        + 'would be a guess');
    }
    const key = `${next.turn}/${next.step}`;
    if (claims.has(key)) {
      fail(`${what} #${claims.get(key) + 1} and #${i + 1} both attribute to turn ${next.turn} step ${next.step} — `
        + 'two records claiming one step means the attribution rule does not fit this run');
    }
    claims.set(key, i);
    return { ...next, gapMs: gap };
  });
}

// ---------------------------------------------------------------------------------------------
// 6. The activity derivation
// ---------------------------------------------------------------------------------------------

/** Ids of every node of a `recallTree`, and its root. */
function treeIds(tree) {
  const ids = [];
  const walk = (node) => {
    for (const key of Object.keys(node)) {
      ids.push(key);
      const child = node[key];
      if (child && typeof child === 'object') walk(child);
    }
  };
  walk(tree);
  return ids;
}

/**
 * `recallTree` read as WHAT THE WALK SAW AT WHICH DEPTH: id -> layer, where the single node under the
 * tree object is the anchor the walk started from (layer 0), its children are layer 1, and so on. The
 * nesting is the layer — nothing here is a distance, a score, or an ordering invented by this tool.
 *
 * It refuses on every shape it cannot read rather than defaulting a layer, because a default depth is a
 * silent lie in a figure whose whole claim is that its colours are measured:
 *
 *   - more than one node at the top level. The tree object holds the walk's single root; two of them
 *     means the record is not this tool's shape (and `Object.keys(tree)[0]` above would silently pick
 *     one of the two and call it "the root").
 *   - a node whose value is not a plain object (`null`, an array, a string, a number): there is no
 *     recorded child list under it, so its own layer is all there is, and its children's layers are absent.
 *   - an id that appears twice, at the same layer or at two different ones. A walk that reached the
 *     same segment at two depths recorded a graph it did not search, or a serialisation that is not a
 *     tree, and there is no honest single layer for the cell.
 *
 * `treeIds` above is deliberately the looser reader (it predates the layer and only has to enumerate);
 * this is the strict one, and it is the one the colour is read from.
 */
function treeLayers(tree, where) {
  const depths = new Map();
  const top = Object.keys(tree);
  if (top.length > 1) {
    fail(`${where}: \`recallTree\` holds ${top.length} nodes at the top level (${top.join(', ')}) where a walk `
      + 'records exactly one - the anchor it started from. Which one is the root, and therefore which is '
      + 'layer 0, is not something this tool may guess');
  }
  let deepest = -1;
  const walk = (node, layer) => {
    for (const key of Object.keys(node)) {
      if (depths.has(key)) {
        const at = depths.get(key);
        fail(`${where}: \`recallTree\` names ${key} at layer ${at} and again at layer ${layer}. A walk that `
          + 'reached the same segment at two depths did not record a tree, and a cell can only be drawn at one layer');
      }
      depths.set(key, layer);
      if (layer > deepest) deepest = layer;
      const child = node[key];
      const plain = child !== null && typeof child === 'object' && !Array.isArray(child);
      if (!plain) {
        fail(`${where}: \`recallTree\`.${key} is ${JSON.stringify(child)} rather than the object that would hold `
          + `its children. Layer ${layer} for ${key} is all this tool can read, and the layer of anything under `
          + 'it is absent rather than zero, so the shading would be invented');
      }
      walk(child, layer + 1);
    }
  };
  walk(tree, 0);
  return { depths, deepest };
}

/**
 * The provenance lines of a delivered payload, in order: one per selected segment, each naming the
 * segment — or, for a chunked long event, its passage parent, which is what `renderSegment` writes.
 */
function provenanceIds(text) {
  const ids = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^## earlier .+ turn, quoted verbatim · (.+?)\s*$/.exec(line);
    if (m) ids.push(m[1]);
  }
  return ids;
}

function derive({ control, snapshot, tape, stepInfo, messages }) {
  const invocations = control.assemblies
    .map((a, i) => ({ index: i, record: a }))
    .sort((x, y) => x.record.ts - y.record.ts || x.index - y.index);
  const places = attributeToSteps(invocations.map((v) => v.record), stepInfo.steps, 'an assembly record');

  // Tape payload records are the observed steps in file order. They are matched to invocations by the
  // step they name, greedily and in order, because a run's step numbers restart with every turn.
  const carried = new Map(); // invocation index -> [ids]
  const unsegmentedCarry = [];
  // Invocations whose record's `bfsDepth` is not the depth of the tree it walked. Not a defect in the round: the
  // field is set in the assembler's *selection* loop, so a walk that returned hits but placed none records 0.
  // Counted and printed rather than refused - see the note where the shade is read.
  const depthDivergences = [];
  // Walked ids the snapshot cannot place in time because a positional chunk id was reused by a re-chunked passage
  // (see the existence check). Counted and printed; the cells are still drawn.
  const reusedIds = [];
  const stepDuration = (place) => {
    const next = stepInfo.steps.find((s) => s.time > place.time);
    return next === undefined ? ATTRIBUTION_WINDOW_MS : next.time - place.time;
  };
  let cursor = 0;
  invocations.forEach((v, k) => {
    const place = places[k];
    const ids = [];
    let matched = false;
    for (let p = cursor; p < tape.payloads.length; p += 1) {
      const rec = tape.payloads[p];
      if (rec.step !== place.step) continue;
      matched = true;
      cursor = p + 1;
      for (const message of rec.messages) {
        const id = message?.id;
        if (typeof id !== 'string') continue;
        const segment = snapshot.byId.get(id);
        if (segment === undefined) {
          unsegmentedCarry.push({ at: k, id });
          continue;
        }
        // A step's own payload can only carry a message that step observed, and the graph stamps it
        // when the upkeep lane writes it - during the step, not minutes later. A carried id stamped
        // long after the invocation means the record matched by step NUMBER belongs to another turn's
        // step of the same number (step numbers restart every turn), so the correction would invent a
        // row. Refused rather than drawn.
        const late = segment.ts - v.record.ts;
        if (late > stepDuration(place) + CARRY_SLACK_MS) {
          fail(`assembly #${k + 1} (ts ${v.record.ts}, turn ${place.turn} step ${place.step}) matched the tape's `
            + `step-${place.step} payload record, but the message ${id} it carries was created ${late} ms later — `
            + 'that record belongs to another step of the same number and the tape is missing the one for this '
            + 'step, so which messages this invocation carried cannot be established');
        }
        ids.push(id);
      }
      break;
    }
    if (!matched) {
      // An unmatched step is not the same as a step that carried nothing: the second is a record with an
      // empty `messages` list, the first is no record at all. Without it the segments this step itself
      // brought would read as "not yet created" at the invocation that used them - a blank where the run
      // has an answer - so the matrix is refused rather than drawn from the creation stamps alone.
      fail(`assembly #${k + 1} (turn ${place.turn} step ${place.step}) has no matching step payload record on `
        + `${tape.path} after ${cursor} record(s) — what the step itself carried is that record's message ids, and `
        + 'without it the step\'s own segments would be drawn as not yet created. A run writes them when the '
        + 'plugin observes in `tape` mode (`observation: "tape"`); a run that did not cannot show this state.');
    }
    carried.set(k, { ids, matched });
  });

  const deliveriesByInvocation = new Map();
  /**
   * A delivery that carried nothing reports no selection, so there is nothing for an invocation to own — and it
   * is therefore not an *unattributable selection*, which is the state the refusal below exists to catch. The
   * two are counted apart rather than treated alike. Round `20261003-2104`'s C2 is the case that forced the
   * distinction: it wrote 31 `delivered:false` records, and one of them (step 22, ts 1791040326565, nearest
   * assembly 123 139 ms back) refused the entire figure over a record that by construction had nothing to attach.
   * The empty count is printed, not silently dropped, and the refusal stays exactly as it was for a record that
   * *did* carry a selection.
   */
  let emptyDeliveries = 0;
  for (const delivery of control.deliveries) {
    if (delivery.delivered !== true) {
      emptyDeliveries += 1;
      continue;
    }
    const owner = invocations
      .map((v, k) => ({ k, ts: v.record.ts }))
      .filter((c) => c.ts <= delivery.ts)
      .sort((a, b) => b.ts - a.ts)[0];
    if (owner === undefined || delivery.ts - owner.ts > ATTRIBUTION_WINDOW_MS) {
      fail(`a context_delivery at ts ${delivery.ts} follows no assembly within ${ATTRIBUTION_WINDOW_MS} ms — the `
        + 'selection it reports cannot be attached to an invocation');
    }
    const place = places[owner.k];
    if (!(delivery.ts >= place.time - ATTRIBUTION_WINDOW_MS && delivery.ts <= place.time + ATTRIBUTION_WINDOW_MS)) {
      fail(`a context_delivery at ts ${delivery.ts} does not belong to the step of assembly #${owner.k + 1}`);
    }
    deliveriesByInvocation.set(owner.k, delivery);
  }

  // When the harness compacted the surface. A segment stamped at one of these moments was **re-stamped** by the
  // compaction, so its `ts` is not when it was created and cannot be compared against an assembly's time. Read off
  // the session store's own `compaction/prune` records (`stepInfo.events`); empty when none ran, which leaves the
  // check exactly as strict as it was.
  const restampTimes = (stepInfo.events ?? [])
    .filter((e) => e?.type === 'compaction/prune' && typeof e.time === 'number')
    .map((e) => e.time);

  const columns = invocations.map((v, k) => {
    const a = v.record;
    const place = places[k];
    const strict = new Set(snapshot.segments.filter((s) => s.ts <= a.ts).map((s) => s.id));
    const carryIds = carried.get(k).ids;
    /**
     * Did this segment exist at this invocation?
     *
     * Two recorded facts, in order of strength: the creation stamp (`ts <= assembly.ts`), and the step's own tape
     * payload (the ids the step carried, which the upkeep lane had not necessarily written yet). The third and
     * weakest is the bounded async-upkeep lag above - a row stamped just after the invocation that used it. It is
     * applied to the id set and to the selected-id check through this one function, so the two can never disagree
     * about a cell.
     */
    const existedAt = (id) => {
      const segment = snapshot.byId.get(id);
      if (segment === undefined) return false;
      if (segment.ts <= a.ts) return true;
      if (carryIds.includes(id)) return true;
      // A stamp that lands on a compaction prune is a **re-stamp**, not a creation, so it cannot be used to place
      // the segment in time. Measured on round `20261004-1239`: two `compaction/prune` records at 1791089625052 and
      // 1791089625057, and the segments the check flagged carry stamps 20 ms and 22 ms after them - 33 772 ms after
      // the assembly that selected them, which is far outside any upkeep lag and is the whole reason the check
      // fired. Compaction rewrites the surface and the rows it keeps are stamped when it ran.
      //
      // The test is deliberately narrow - within `ASYNC_LAG_TOLERANCE_MS` of a prune, i.e. the same bound the
      // upkeep-lag branch uses - so this cannot quietly excuse a stamp that has nothing to do with a compaction.
      if (restampTimes.some((t) => Math.abs(segment.ts - t) <= ASYNC_LAG_TOLERANCE_MS)) return true;
      return segment.ts - a.ts <= ASYNC_LAG_TOLERANCE_MS;
    };
    const lagIds = snapshot.segments
      .filter((s) => s.ts > a.ts && s.ts - a.ts <= ASYNC_LAG_TOLERANCE_MS)
      .map((s) => s.id)
      .filter((id) => !carryIds.includes(id));
    const existed = new Set([...strict, ...carryIds, ...lagIds]);
    const treeList = treeIds(a.recallTree);
    const root = Object.keys(a.recallTree)[0] ?? null;
    const candidates = treeList.filter((id) => id !== root);
    if (candidates.length !== a.candidates) {
      fail(`assembly #${k + 1} (ts ${a.ts}) records candidates=${a.candidates} but its recallTree holds `
        + `${candidates.length} hit(s) under the root — the walk's id list and its count disagree, so neither can `
        + 'be drawn as fact');
    }
    // The colour of a recalled cell is its BFS layer, read from the tree's own nesting — the walk's own record.
    //
    // `assembly.recall.bfsDepth` is **not** that number, and requiring them to agree refused a whole round on
    // 2026-10-05 over a field that means something else. `packages/core/src/assembler.ts` sets it inside the
    // *selection* loop (`bfsDepth = Math.max(bfsDepth, hit.depth)`), so it is the deepest layer among the segments
    // that were **placed**, not the deepest layer the walk **reached**. The two part company whenever the walk
    // returns hits that are not selected: on round `20261004-1458` assembly 1 recorded `candidates=2, selected=0,
    // bfsDepth=0` with a layer-1 node in its tree, because nothing was placed and the loop never ran. That is a
    // real and reportable difference between the walk and the delivery, not a contradiction to resolve by
    // choosing, so this tool now **shades from the tree** and counts the divergence instead of refusing. The
    // record's own `bfsDepth` is carried beside it as `selectedDepth`, which is the fact it actually holds.
    const where = `assembly #${k + 1} (ts ${a.ts})`;
    const { depths, deepest } = treeLayers(a.recallTree, where);
    const walkDepth = Math.max(0, deepest);
    if (walkDepth !== a.bfsDepth) {
      depthDivergences.push({ where, recorded: a.bfsDepth, walk: walkDepth, candidates: a.candidates, selected: a.selected });
    }
    // The tree is the walk's record and the shade is read from it; the field is restamped so everything downstream
    // — the run's shared ramp, the per-column truncation, the tooltip — is shaded by one fact and not two.
    a.bfsDepth = walkDepth;
    // The existence check's bound is the step's **window**, not its start, and where a stamp falls outside it the
    // invocation is **counted and reported rather than refused** — because the round that first exercised this
    // showed the stamp is not always about timing.
    //
    // `assembly.ts` is the step's **start**; the walk runs at the step's **end**, and the step's own working life
    // happens in between. Round `20261004-1458`'s assembly 1 shows it whole: its `ts` is 1791097336125, while the
    // step's own input is segmented at +413 ms and its trace, toolCall and toolResult land at +1794, +1795 and
    // +2491 ms. So a segment stamped after the assembly but before the next one is one the walk could legitimately
    // have reached, and requiring `ts <= assembly.ts` refused the round over the ordinary case.
    //
    // What is left is **identifier reuse**, and it is not a timing question at all. Assembly 10's tree names
    // `464d481d-…#4`, stamped 39 185 ms after it; that passage holds 38 chunks whose stamps fall into two groups —
    // `#5…#37` at 1791097384227 (before the assembly) and `#0…#4` at 1791097455126 (39 s after). One passage is not
    // chunked into two stamp groups, so it was chunked twice, and chunk ids are **positional** (`#N`): the id the
    // walk wrote down names a different piece of text in the final snapshot than it did at the time. The tool
    // cannot place such a cell in time from the snapshot, so it says so and leaves the placement uncertain rather
    // than inventing one — the figure still draws the hit, and the summary names every id this happened to.
    const stepEnd = (k) => (invocations[k + 1] !== undefined ? invocations[k + 1].record.ts : Infinity);
    const bound = stepEnd(k);
    for (const id of treeList) {
      const s = snapshot.byId.get(id);
      if (s !== undefined && s.ts < bound) continue;
      if (existed.has(id)) continue;
      reusedIds.push({ where: `assembly #${k + 1}`, id, ts: s?.ts ?? null, bound: bound === Infinity ? null : bound });
    }
    for (const id of carryIds) {
      if (strict.has(id)) {
        // The correction is a boundary correction by construction; a carried id that was already there
        // means the rule added nothing, which is worth saying rather than hiding.
        continue;
      }
    }

    const delivery = deliveriesByInvocation.get(k);
    let selected = null;
    let selectedSource = 'none';
    if (delivery !== undefined && delivery.delivered === true) {
      const text = messages.map.get(delivery.payloadId);
      if (text === undefined) {
        fail(`assembly #${k + 1} delivered payload ${delivery.payloadId}, but no logged message carries that id `
          + `(looked in ${messages.sources.join(' and ')}) — the selected ids of this invocation are not in the `
          + 'evidence, so the ring cannot be drawn from them');
      }
      const ids = provenanceIds(text);
      // One provenance line per *recalled* block. `stateProxy` is a block the injected message can also carry,
      // and it is the model's own serialized trace rather than a recalled turn - it has no provenance line and
      // no selected segment behind it, so counting every block here would fail every delivering cell. A block
      // name this tool does not know is reported rather than ignored: see the header, "THE SELECTED SET".
      const recallBlocks = delivery.blocks.filter((b) => b === 'recalled').length;
      const otherBlocks = [...new Set(delivery.blocks.filter((b) => b !== 'recalled'))];
      if (ids.length !== recallBlocks) {
        fail(`the delivered payload ${delivery.payloadId} holds ${ids.length} provenance line(s) but the `
          + `context_delivery record lists ${recallBlocks} recalled block(s)`
          + (otherBlocks.length > 0 ? ` beside ${delivery.blocks.length - recallBlocks} non-recall block(s): `
            + `${otherBlocks.join(', ')}` : ''));
      }
      // **A delivery may name fewer segments than were selected, and since 2026-10-05 that is the normal case.**
      // `context-delivery.ts` reads the harness's own projection and suppresses a segment whose id and text are
      // already visible, so it emits only what the model is not already looking at: `selected` counts what the walk
      // chose, and the payload names what had to be *sent*. The equality this line asserted was true of the
      // append-only delivery it was written against and is false now - and because it `fail()`ed, a finished round
      // whose logs are complete could not be drawn at all. The difference is the suppression: a recorded fact, not
      // corruption, so it is counted and carried to the summary. The direction that cannot happen - more delivered
      // lines than selected segments - is still refused.
      if (ids.length > a.selected) {
        fail(`assembly #${k + 1} records selected=${a.selected} but its delivered payload names ${ids.length} `
          + 'segment(s) — more was delivered than was selected, which no delivery path can produce');
      }
      // The difference needs no new counter: the summary's `countOnly` is already
      // `selectedTotal - (segments whose identity a payload names)`, which is exactly this suppression - a selected
      // segment that the delivery did not have to re-inject because the model could already see it.
      selected = [];
      for (const id of ids) {
        if (snapshot.byId.has(id)) {
          selected.push({ id, rows: [id], passage: false });
          continue;
        }
        const chunks = snapshot.segments.filter((s) => s.chunkOf === id);
        if (chunks.length === 0) {
          fail(`the delivered payload ${delivery.payloadId} names ${id}, which is neither a segment of `
            + `${snapshot.file} nor the passage parent of one — the snapshot is not the graph that invocation saw`);
        }
        // One provenance line per selected segment, but a chunked event is named by its passage parent:
        // the identity of which chunk was selected is not in the payload, and is not invented here.
        selected.push({ id, rows: chunks.map((c) => c.id), passage: chunks.length > 1 });
      }
      selectedSource = 'delivered payload';
    } else if (delivery !== undefined) {
      selectedSource = 'not delivered';
    }
    if (selected !== null) {
      for (const entry of selected) {
        for (const row of entry.rows) {
          if (!existedAt(row)) {
            const segment = snapshot.byId.get(row);
            const late = segment === undefined ? 0 : segment.ts - a.ts;
            fail(`assembly #${k + 1} selected ${row}, which did not exist at ts ${a.ts} — a segment cannot be `
              + `selected before it exists${late > ASYNC_LAG_TOLERANCE_MS
                ? ` (its row is stamped ${late} ms after the invocation, beyond the ${ASYNC_LAG_TOLERANCE_MS} ms `
                  + 'async-upkeep tolerance: the ordering is a contradiction, not a race)'
                : ''}`);
          }
        }
        if (entry.rows.includes(root)) {
          fail(`assembly #${k + 1} selected its own walk root ${root}, which the assembler excludes from recall`);
        }
      }
    }
    return {
      index: k + 1,
      record: a,
      place,
      strictIds: strict,
      carryIds,
      lagIds,
      existed,
      root,
      candidates,
      depths,
      deepestLayer: deepest,
      selected,
      selectedSource,
      delivery,
      payloadId: delivery?.delivered === true ? delivery.payloadId : '',
      fallback: typeof a.fallback === 'string' ? a.fallback : '',
    };
  });

  // The matrix: one state per (segment row, invocation column). `absent` is the default and every
  // other state is set from a recorded fact, so no state can appear without evidence for it.
  const rows = snapshot.segments.map((segment, row) => ({ row, segment, cells: [] }));
  const counts = { absent: 0, candidate: 0, root: 0, existed: 0, selectedIds: 0, selectedPassage: 0 };
  for (const row of rows) {
    for (const column of columns) {
      let state = 'absent';
      if (column.existed.has(row.segment.id)) {
        if (row.segment.id === column.root) state = 'root';
        else if (column.candidates.includes(row.segment.id)) state = 'candidate';
        else state = 'existed';
      }
      let overlay = '';
      if (column.selected !== null) {
        for (const entry of column.selected) {
          if (!entry.rows.includes(row.segment.id)) continue;
          overlay = entry.passage ? 'passage' : 'selected';
          break;
        }
      }
      // `layer` is the BFS layer read from this invocation's own `recallTree` (root 0, its children 1, …),
      // and it is `-1` for every state that is not a `recallTree` node — `existed` and `absent` carry no
      // layer because they are not part of the walk. It changes no state: the taxonomy above is decided
      // before it, and the fill of a recalled cell is read from it.
      let layer = -1;
      if (state === 'candidate' || state === 'root') {
        const read = column.depths.get(row.segment.id);
        if (read === undefined) {
          fail(`assembly #${column.index} row ${row.row} is ${state} but its ${row.segment.id} has no layer in `
            + 'the recallTree it was read from — a cell the shading would have to guess a depth for');
        }
        layer = read;
      }
      row.cells.push({ state, overlay, layer });
      counts[state] += 1;
      if (overlay === 'selected') counts.selectedIds += 1;
      if (overlay === 'passage') counts.selectedPassage += 1;
    }
  }

  const carryCells = columns.reduce((n, c) => n + c.carryIds.filter((id) => !c.strictIds.has(id)).length, 0);
  // Cells that exist only because of the bounded async-upkeep lag - neither by their creation stamp nor by the
  // step's own payload. Counted apart from the carry, because they are a different justification: the carry is a
  // recorded fact about what the step handed the graph, this is a race with a measured size.
  const lagCells = columns.reduce((n, c) => n + c.lagIds.length, 0);
  const maxLagMs = columns.reduce((n, c) => Math.max(n, ...c.lagIds.map((id) => (snapshot.byId.get(id)?.ts ?? 0) - c.record.ts), 0), 0);
  const selectedTotal = columns.reduce((n, c) => n + c.record.selected, 0);
  const identityColumns = columns.filter((c) => c.selected !== null).length;
  const identityRows = counts.selectedIds;
  const passageColumns = columns.filter((c) => c.selected !== null && c.selected.some((e) => e.passage)).length;
  const countOnly = selectedTotal - columns.reduce((n, c) => n + (c.selected === null ? 0 : c.selected.length), 0);
  const rowsById = new Map(rows.map((r) => [r.segment.id, r]));
  // The one shading rule for the whole figure. `maxLayer` is the maximum `bfsDepth` recorded across THIS
  // run's invocations — a recorded fact, and the one that decides how many shades there are — so the same
  // colour means the same layer in every column and the columns can be compared against one another.
  const maxLayer = columns.reduce((n, c) => Math.max(n, c.record.bfsDepth), 0);
  const depthRamp = buildDepthRamp(maxLayer);
  return {
    columns,
    rows,
    counts,
    maxLayer,
    depthRamp,
    carryCells,
    lagCells,
    maxLagMs,
    lagToleranceMs: ASYNC_LAG_TOLERANCE_MS,
    emptyDeliveries,
    deliveriesTotal: control.deliveries.length,
    unsegmentedCarry,
    depthDivergences,
    reusedIds,
    selectedTotal,
    identityColumns,
    identityRows,
    passageColumns,
    countOnly,
    rowsById,
    snapshot,
    tape,
    control,
    stepInfo,
    messages,
    knobs: tape.knobs,
  };
}

// ---------------------------------------------------------------------------------------------
// 7. The figure
//
// One column of the matrix per invocation, one row per segment, oldest at the BOTTOM (row 0), so the
// "not yet created" region reads as a corner: time advances to the right and creation order upwards.
// The count bars sit directly above the matrix on the same column grid, because the two are the same
// columns — the counts are what the identity does not always record.
// ---------------------------------------------------------------------------------------------

const W = 1240;
const MARGIN = 30;
const GUTTER = 272; // row labels; must hold "21 trace 332t 95e3cc48#0" plus a margin
const ROW_H = 24;
const ROW_GAP = 2;
const SVG_FONT = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const COLOUR = {
  absent: '#ffffff',
  absentEdge: '#dfe5ee',
  existed: '#d7e0ee',
  candidate: '#2f6fd0',
  root: '#d7e0ee',
  ring: '#b0483f',
  // The backing under every ring. A mark that encodes its own recorded fact is never removed to make a
  // layer legible; the layer yields the contrast instead, and this is how the ring keeps it.
  ringHalo: '#ffffff',
  halo: '#d7e0ee',
  bar: '#2f6fd0',
  barSoft: '#bcd2ee',
  fallback: '#d08a2f',
  ink: '#171a1f',
  muted: '#5c6675',
  rule: '#e3e8ef',
  ruleFaint: '#f0f3f7',
  axis: '#9aa5b4',
  paper: '#ffffff',
};

// ---------------------------------------------------------------------------------------------
// 7a. The BFS-layer ramp
//
// One hue, derived from the `candidate` blue the figure already used, and one scale for the whole run.
//
//   layer 0 (the walk's own anchor) is the most intense: `#2f6fd0`, which is the pre-existing candidate
//   colour and therefore exactly this blue at this lightness. Each layer above it steps one notch
//   lighter along the SAME hue and saturation, so the ramp is one family rather than a second one
//   bolted beside the first. The run's deepest recorded layer (`maxLayer`, the maximum `bfsDepth` across
//   its invocations) lands on lightness 63%.
//
// Two bounds are asserted in code, not in a comment, because both are the difference between "layered"
// and "worse": the deepest shade must stay unmistakably darker than `existed`, and the ramp must decay
// monotonically. `buildDepthRamp` refuses a hue whose top two shades cannot be told apart.
// ---------------------------------------------------------------------------------------------

const LAYER_HUE = 216; // the hue of COLOUR.candidate, read off it rather than chosen beside it
const LAYER_SAT = 63; // likewise its saturation
const LAYER_LIGHT_ROOT = 50; // % lightness at layer 0 — COLOUR.candidate itself
const LAYER_LIGHT_DEEP = 63; // % lightness at the run's deepest recorded layer

function hslToHex(h, s, l) {
  const sat = s / 100;
  const lum = l / 100;
  const c = (1 - Math.abs(2 * lum - 1)) * sat;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r, g, b] = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x]
    : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = lum - c / 2;
  return `#${[r, g, b].map((v) => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('')}`;
}

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

/** WCAG relative luminance — the one number here that is not a taste decision. */
function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1–21. */
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The run-global ramp: `[{ layer, lightness, colour }]` from the anchor down to `maxLayer`, one entry
 * per BFS layer, with layer 0 the most intense and each step measurably weaker than the one above it.
 * It is built from the run's recorded `bfsDepth`, never from the depth a particular column happened to
 * reach, because a ramp fitted per column would make the columns incomparable.
 */
function buildDepthRamp(maxLayer) {
  const top = Math.max(0, Math.floor(maxLayer));
  const ramp = [];
  for (let layer = 0; layer <= top; layer += 1) {
    const t = top === 0 ? 0 : layer / top;
    const lightness = LAYER_LIGHT_ROOT + (LAYER_LIGHT_DEEP - LAYER_LIGHT_ROOT) * t;
    ramp.push({ layer, lightness, colour: hslToHex(LAYER_HUE, LAYER_SAT, lightness) });
  }
  for (let i = 1; i < ramp.length; i += 1) {
    if (ramp[i].lightness <= ramp[i - 1].lightness) {
      fail(`the BFS-layer ramp is not decaying: layer ${i} is at lightness ${ramp[i].lightness} and layer ${i - 1} `
        + `at ${ramp[i - 1].lightness}, so brightness would not mean layer`);
    }
  }
  const deepest = ramp[ramp.length - 1].colour;
  if (contrast(deepest, COLOUR.existed) < 1.35) {
    fail(`the BFS-layer ramp's deepest shade ${deepest} is not clearly stronger than "existed" ${COLOUR.existed} `
      + `(contrast ${contrast(deepest, COLOUR.existed).toFixed(2)} < 1.35) — a recalled cell would read as a blank one`);
  }
  return ramp;
}

/**
 * The shade one cell is filled with. `absent` and `existed` keep the colours they have always had and
 * are not part of the ramp; `candidate` and `root` are the walk's own blue, shaded by the BFS layer read
 * out of the `recallTree`.
 */
function fillOf(cell, ramp) {
  if (cell.state === 'absent') return COLOUR.absent;
  if (cell.state !== 'candidate' && cell.state !== 'root') return COLOUR.existed;
  if (cell.layer < 0 || cell.layer > ramp.length - 1) {
    // Unreachable by construction — the matrix above refuses a recalled cell with no layer, and the ramp
    // is sized to the run's deepest recorded `bfsDepth` — but a blank cell would be an invented fact.
    fail(`cell at row ${cell.r} column ${cell.col + 1} is ${cell.state} at BFS layer ${cell.layer}, which the `
      + `run-global ramp (layers 0–${ramp.length - 1}) has no shade for`);
  }
  return ramp[cell.layer].colour;
}

/**
 * The ink of a mark drawn on a given fill. A ring, a caret and a `hit` each encode their own recorded
 * fact, so none of them is dropped when a layer darkens or lightens the cell under it — the one thing
 * that may change is which of the two existing inks (paper white, or the figure's `#171a1f`) reads on it.
 */
function markInk(fill) {
  return contrast(fill, COLOUR.paper) >= contrast(fill, COLOUR.ink) ? COLOUR.paper : COLOUR.ink;
}

function niceStep(range, ticks) {
  if (range <= 0) return 1;
  const raw = range / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  // A count axis wants few, whole ticks: `2.5` printed over a bar chart of record counts reads as a
  // measurement, and 15 as the top of a 9-high axis wastes half the panel.
  for (const mult of [1, 1.5, 2, 2.5, 3, 4, 5, 10]) if (raw <= mag * mult) return mag * mult;
  return mag * 10;
}

// ---------------------------------------------------------------------------------------------
// 7b. Aggregation — what a 277 x 1 398 matrix has to become before it can be drawn
//
// The live case: cell C2 of round `20261002-2037` is 277 invocations by 1 398 segments. Drawn exactly it is
// `width="1240" height="42957"` and 56.7 MB of `<rect>` - a document no viewer opens and no reader scrolls, which
// is the same as no figure at all. Above the ceilings below the matrix is therefore rolled up: consecutive
// invocations become column blocks, consecutive segments (in append order) become row blocks, and one drawn cell
// is one block. The same run at the defaults is 1240 x 8789 and 4.2 MB.
//
// **The states survive the roll-up, and that is the whole design.** A block is `candidate` if its walk returned
// anything in it, `selected` if the delivered payload named anything in it, `root` if it holds a walk root,
// `existed` if anything in it existed, and `absent` only when nothing did. The strongest recorded fact wins, so a
// roll-up can never turn a hit into a blank; what it can no longer show is *which* cell inside the block carried
// it, which is why the caption states the block size and the summary line says the figure is aggregated.
//
// Nothing is dropped from the counts: the per-invocation table below the matrix is always exact (one row per
// invocation), the bar panel keeps the maximum recorded count in each column block, and every state total in the
// summary line is computed from the full matrix before any of this happens.
//
// The per-invocation table is what keeps the height in the thousands: 277 rows of 20 px plus a 120-row grid is
// ~8 800 px, so this figure is for scrolling to a region rather than for taking in at once. That is a deliberate
// trade against 43 000 px, and the summary line states the drawn size so a caller can see which one it got.
// ---------------------------------------------------------------------------------------------

/** Ceilings above which the matrix is rolled up. 120 rows is ~3200 px of grid: tall, and openable. */
const MAX_COLS_EXACT = 120;
const MAX_ROWS_EXACT = 120;

/** Divisions used when a total is not a multiple of the block count; the remainder is spread, never dropped. */
function blocksOf(count, blockCount) {
  const out = [];
  const size = Math.floor(count / blockCount);
  let extra = count - size * blockCount;
  let at = 0;
  for (let i = 0; i < blockCount; i += 1) {
    const width = size + (extra > 0 ? 1 : 0);
    if (extra > 0) extra -= 1;
    out.push({ from: at, to: at + width, width });
    at += width;
  }
  return out;
}

/**
 * The drawn grid: either the exact matrix, or a block roll-up of it. The renderer reads only this, so the two
 * modes cannot drift apart in how a state is drawn.
 */
function layoutOf(model, opts = {}) {
  const maxCols = opts.maxCols ?? MAX_COLS_EXACT;
  const maxRows = opts.maxRows ?? MAX_ROWS_EXACT;
  const exactCols = model.columns.length;
  const exactRows = model.rows.length;
  const colBlocks = Math.min(exactCols, maxCols);
  const rowBlocks = Math.min(exactRows, maxRows);
  const aggregated = colBlocks < exactCols || rowBlocks < exactRows;
  if (!aggregated) {
    return {
      aggregated: false,
      mode: 'exact',
      note: `one cell per (segment, invocation): ${exactCols} x ${exactRows}, unaggregated`,
      nCols: exactCols,
      nRows: exactRows,
      colBlocks: model.columns.map((_, i) => ({ from: i, to: i + 1, width: 1 })),
      rowBlocks: model.rows.map((_, i) => ({ from: i, to: i + 1, width: 1 })),
      cells: model.rows.map((r, ri) => r.cells.map((c) => ({
        ...c, state: c.state, overlay: c.overlay, layer: c.layer, col: 1, row: 1, r: ri,
      }))),
      colCounts: model.columns.map((c) => ({ candidates: c.record.candidates, selected: c.record.selected })),
      columns: model.columns,
      rows: model.rows,
    };
  }
  const colRanges = blocksOf(exactCols, colBlocks);
  const rowRanges = blocksOf(exactRows, rowBlocks);
  const rank = { absent: 0, existed: 1, root: 2, candidate: 3, selected: 4, passage: 5 };
  const cells = [];
  const stateTally = { absent: 0, candidate: 0, root: 0, existed: 0, selectedIds: 0, selectedPassage: 0 };
  for (const range of rowRanges) {
    const line = [];
    for (const crange of colRanges) {
      let state = 'absent';
      let overlay = '';
      // The layer of the block is the layer of the state that won it, by the same rule the state itself is:
      // the most intense recorded layer in the block. Depth is a second axis of "what the walk returned",
      // so a block that holds hits at several depths is drawn at the shallowest of them — the strongest
      // claim in the block, and never darker than any cell it stands for. What the roll-up gives up is
      // named rather than hidden: the matrix panel says a block shows one layer, not which cell had it.
      let layer = -1;
      for (let r = range.from; r < range.to; r += 1) {
        const row = model.rows[r];
        for (let c = crange.from; c < crange.to; c += 1) {
          const cell = row.cells[c];
          if (rank[cell.state] > rank[state]) state = cell.state;
          if (cell.overlay !== '' && rank[cell.overlay] > rank[overlay === '' ? 'absent' : overlay]) overlay = cell.overlay;
          if (cell.state === 'candidate' || cell.state === 'root') {
            layer = layer === -1 ? cell.layer : Math.min(layer, cell.layer);
          }
        }
      }
      stateTally[state] += 1;
      if (overlay === 'selected') stateTally.selectedIds += 1;
      if (overlay === 'passage') stateTally.selectedPassage += 1;
      line.push({ state, overlay, layer: state === 'candidate' || state === 'root' ? layer : -1, col: crange.width, row: range.width, r: range.from });
    }
    cells.push(line);
  }
  return {
    aggregated: true,
    mode: 'aggregated',
    note: `aggregated: ${colRanges.length} column block(s) of ~${Math.round(exactCols / colBlocks)} invocation(s) `
      + `x ${rowRanges.length} row block(s) of ~${Math.round(exactRows / rowBlocks)} segment(s); one cell is one block, `
      + 'shaded by the strongest recorded state in it',
    nCols: colRanges.length,
    nRows: rowRanges.length,
    colBlocks: colRanges,
    rowBlocks: rowRanges,
    cells,
    // The bar panel keeps the recorded counts, rolled up by maximum: `assembly.candidates` is a count per
    // invocation, and a block's bar answers "what did the busiest invocation in this block return".
    colCounts: colRanges.map((r) => ({
      candidates: Math.max(...model.columns.slice(r.from, r.to).map((c) => c.record.candidates)),
      selected: Math.max(...model.columns.slice(r.from, r.to).map((c) => c.record.selected)),
    })),
    columns: colRanges.map((r) => model.columns[r.from]),
    rows: rowRanges.map((r) => ({ ...model.rows[r.from], blockFrom: r.from, blockTo: r.to, blockWidth: r.width })),
    stateTally,
  };
}

/**
 * One row label for a block of rows. A block can hold several kinds, so the label says how many rows it stands
 * for and names its first and last segment rather than pretending to be one segment.
 */
function blockRowLabel(row) {
  const width = row.blockWidth ?? 1;
  const at = row.blockFrom ?? row.row;
  if (width === 1) {
    return `${at} ${row.segment.kind} ${row.segment.tokens}t ${rowLabelId(row.segment.id)}`
      + `${row.segment.chunkOf ? ` +${shortId(row.segment.chunkOf, 6)}` : ''}`;
  }
  return `${at}–${row.blockTo - 1} (${width}) —`;
}

function renderFigure(model, meta) {
  const { columns, rows } = model;
  // The one shade scale of the whole figure, built once from the run's deepest recorded BFS depth. Every
  // cell below reads its fill through it, so a colour means one layer in every column.
  const ramp = model.depthRamp;
  // What is actually drawn: the exact matrix when it fits, a block roll-up of it when it does not. Everything
  // below reads `grid`, so the two modes cannot disagree about how a state is drawn or counted.
  const grid = layoutOf(model, meta.grid);
  const exactCols = columns.length;
  const exactRows = rows.length;
  const nCols = grid.nCols;
  const nRows = grid.nRows;
  const plotLeft = MARGIN + GUTTER;
  const plotWidth = W - MARGIN - plotLeft;
  const colPitch = plotWidth / nCols;
  const cellW = Math.max(24, colPitch - 8);
  const colX = (i) => plotLeft + i * colPitch + (colPitch - cellW) / 2;

  const maxCount = Math.max(1, ...grid.colCounts.map((c) => Math.max(c.candidates, c.selected)));
  const barStep = niceStep(maxCount * 1.15, 4);
  const axisMax = Math.max(barStep, Math.ceil((maxCount * 1.15) / barStep) * barStep);

  const body = [];
  let y = 0;
  const band = (name, height) => {
    const at = y;
    y += height;
    return { at, height, name };
  };
  const bands = [];

  // -- band: header -------------------------------------------------------------------------
  // Every caption is wrapped to the page before it is measured: a sentence that runs off the right
  // edge is the failure mode a figure forwarded on its own cannot recover from.
  const subLines = meta.subtitle.flatMap((line) => wrap(line, 148));
  const headH = 46 + (subLines.length - 1) * 15 + 18;
  bands.push(band('header', headH));

  // -- band: selection counts, on the matrix's columns ---------------------------------------
  const countsNote = wrap(meta.countsNote, 150);
  const barsTop = 42 + countsNote.length * 15 + 20;
  const barsH = 150;
  bands.push(band('counts', barsTop + barsH + 64));

  // -- band: the matrix ----------------------------------------------------------------------
  const matrixNote = wrap(meta.matrixNote, 150);
  const layerNote = wrap(meta.layerNote, 150);
  const matrixTop = 42 + matrixNote.length * 15 + 20;
  const gridH = nRows * (ROW_H + ROW_GAP) - ROW_GAP;
  bands.push(band('matrix', matrixTop + gridH + 61 + layerNote.length * 15));

  // -- band: legend and notes ------------------------------------------------------------------
  const legendItems = [
    ['ramp', 'shade = BFS layer; ONE run-global scale, the same in every column. Darkest = layer 0, the anchor.'],
    ['absent', 'not yet created — the recorded creation stamp is later than the invocation'],
    ['existed', 'existed, and the recorded walk did not return it (not a `recallTree` node)'],
    ['candidate', 'existed, and the recorded walk returned it (a `recallTree` node), shaded by its BFS layer'],
    ['selected', 'ring — the id is in the delivered payload: the only recorded selected id'],
    ['passage', 'dashed ring — the payload names a passage parent; the chunk is not recorded'],
    ['root', 'caret — that walk\'s root (its layer 0, the anchor), which is not a hit'],
  ];
  const legendRows = Math.ceil(legendItems.length / 2);
  // The ramp strip draws its layer numbers under its swatches, so the band is a little taller than the
  // row grid alone needs — that margin is what holds them, not the row pitch.
  const noteLines = meta.notes.flatMap((n) => wrap(n, 150));
  const legendH = 34 + legendRows * 19 + 26 + noteLines.length * 15 + 16;
  bands.push(band('legend', legendH));

  // -- band: the per-invocation record ---------------------------------------------------------
  const tableCols = [
    { key: 'n', label: '#', w: 34, align: 'end' },
    { key: 'when', label: 'turn · step', w: 84 },
    { key: 'clock', label: 'time (local)', w: 92 },
    { key: 'seq', label: 'seq', w: 48, align: 'end' },
    { key: 'w', label: 'w', w: 52, align: 'end' },
    { key: 'cand', label: 'cand', w: 50, align: 'end' },
    { key: 'sel', label: 'sel', w: 44, align: 'end' },
    { key: 'depth', label: 'depth', w: 54, align: 'end' },
    { key: 'pairs', label: 'pairs j/s', w: 84, align: 'end' },
    // Deferred pairs, beside the coverage ratio the table already prints. A live cell can reach seven digits here
    // (round `20261002-2037` walked 860 672 pairs), so the column is wide enough for one and shows an em dash when
    // the run recorded nothing rather than a zero it cannot support.
    { key: 'deferred', label: 'deferred', w: 72, align: 'end' },
    { key: 'fallback', label: 'recorded fallback', w: 118 },
    { key: 'ids', label: 'selected ids (recorded?)', w: 0 },
  ];
  const tableW = W - 2 * MARGIN;
  const fixedW = tableCols.reduce((n, c) => n + c.w, 0);
  tableCols[tableCols.length - 1].w = tableW - fixedW;
  const tableNote = wrap(meta.tableNote, 150);
  const tableBand = 40 + 22 + nCols * 20 + 14 + tableNote.length * 15;
  bands.push(band('record', tableBand));
  const sourceLines = meta.sources.flatMap((line) => wrap(line, 150));
  const footH = 24 + sourceLines.length * 15 + 10;
  bands.push(band('sources', footH));
  const height = y;

  // -- header --------------------------------------------------------------------------------
  body.push(`<g class="band" data-band="header" transform="translate(0,${bands[0].at})">`);
  body.push(`  <text x="${MARGIN}" y="34" class="doc-title">${escapeXml(meta.title)}</text>`);
  subLines.forEach((line, i) => {
    body.push(`  <text x="${MARGIN}" y="${58 + i * 15}" class="doc-sub">${escapeXml(line)}</text>`);
  });
  body.push('</g>');

  // -- counts --------------------------------------------------------------------------------
  const { at: cAt } = bands[1];
  const baseY = barsTop + barsH;
  const yOf = (v) => baseY - (v / axisMax) * barsH;
  body.push(`<g class="band" data-band="counts" transform="translate(0,${cAt})">`);
  body.push(`  <text x="${MARGIN}" y="24" class="panel-title">What each invocation returned and selected</text>`);
  countsNote.forEach((line, i) => {
    body.push(`  <text x="${MARGIN}" y="${42 + i * 15}" class="panel-note">${escapeXml(line)}</text>`);
  });
  for (const t of Array.from({ length: axisMax / barStep + 1 }, (_, i) => i * barStep)) {
    const yy = yOf(t);
    body.push(`  <line x1="${plotLeft}" y1="${yy.toFixed(1)}" x2="${(plotLeft + plotWidth).toFixed(1)}" y2="${yy.toFixed(1)}" class="grid"/>`);
    body.push(`  <text x="${plotLeft - 10}" y="${(yy + 4).toFixed(1)}" class="tick" text-anchor="end">${t}</text>`);
  }
  body.push(`  <line x1="${plotLeft}" y1="${baseY}" x2="${(plotLeft + plotWidth).toFixed(1)}" y2="${baseY}" class="axis"/>`);
  body.push(`  <text x="${plotLeft - 10}" y="${(baseY + 15).toFixed(1)}" class="axis-label" text-anchor="end">recall hits / selected</text>`);
  const barW = Math.min(30, (cellW - 10) / 2);
  grid.columns.forEach((column, i) => {
    const count = grid.colCounts[i];
    const groupCx = plotLeft + i * colPitch + colPitch / 2;
    const x0 = groupCx - barW - 3;
    const x1 = groupCx + 3;
    const candH = Math.max(count.candidates > 0 ? 1.5 : 0, (count.candidates / axisMax) * barsH);
    const selH = Math.max(count.selected > 0 ? 1.5 : 0, (count.selected / axisMax) * barsH);
    body.push(`  <rect class="bar" data-kind="candidates" data-col="${i + 1}" x="${x0.toFixed(1)}" y="${(baseY - candH).toFixed(1)}" width="${barW.toFixed(1)}" height="${candH.toFixed(1)}" fill="${COLOUR.barSoft}"/>`);
    body.push(`  <rect class="bar" data-kind="selected" data-col="${i + 1}" x="${x1.toFixed(1)}" y="${(baseY - selH).toFixed(1)}" width="${barW.toFixed(1)}" height="${selH.toFixed(1)}" fill="${COLOUR.bar}"/>`);
    body.push(`  <text x="${(x0 + barW / 2).toFixed(1)}" y="${(baseY - candH - 5).toFixed(1)}" class="bar-value" text-anchor="middle">${count.candidates}</text>`);
    body.push(`  <text x="${(x1 + barW / 2).toFixed(1)}" y="${(baseY - selH - 5).toFixed(1)}" class="bar-value" text-anchor="middle">${count.selected}</text>`);
    // The two badges are the honest half of this chart: whether the selected ids exist for this
    // invocation, and whether the recorded selection came from the recency window rather than a walk.
    if (column.fallback !== '') {
      body.push(`  <text x="${(groupCx).toFixed(1)}" y="${(baseY + 14).toFixed(1)}" class="badge-fallback" text-anchor="middle">recency-window</text>`);
    }
    const idsLabel = column.selected === null
      ? (column.record.selected === 0 ? 'ids: none selected' : 'ids: not recorded')
      : `ids: recorded (${column.record.selected})`;
    body.push(`  <text x="${(groupCx).toFixed(1)}" y="${(baseY + 30).toFixed(1)}" class="badge-${column.selected === null ? 'no' : 'yes'}" text-anchor="middle">${escapeXml(idsLabel)}</text>`);
    body.push(`  <text x="${(groupCx).toFixed(1)}" y="${(baseY + 48).toFixed(1)}" class="col-label" text-anchor="middle">#${column.index} · T${column.place.turn}·S${column.place.step}</text>`);
  });
  body.push('</g>');

  // -- matrix --------------------------------------------------------------------------------
  const { at: mAt } = bands[2];
  const blockClause = grid.aggregated
    ? ` — AGGREGATED: the matrix is ${exactCols} x ${exactRows} and is drawn as blocks (see the note below)`
    : '';
  body.push(`<g class="band" data-band="matrix" transform="translate(0,${mAt})">`);
  body.push(`  <text x="${MARGIN}" y="24" class="panel-title">The matrix — ${nRows} rows (oldest at the bottom) × ${nCols} columns${escapeXml(blockClause)}</text>`);
  matrixNote.forEach((line, i) => {
    body.push(`  <text x="${MARGIN}" y="${42 + i * 15}" class="panel-note">${escapeXml(line)}</text>`);
  });
  body.push(`  <line x1="${MARGIN}" y1="${matrixTop - 8}" x2="${W - MARGIN}" y2="${matrixTop - 8}" class="axis"/>`);
  const rowY = (row) => matrixTop + (nRows - 1 - row) * (ROW_H + ROW_GAP);
  grid.rows.forEach((row, r) => {
    const yy = rowY(r);
    body.push(`  <line x1="${MARGIN}" y1="${(yy + ROW_H + 1).toFixed(1)}" x2="${W - MARGIN}" y2="${(yy + ROW_H + 1).toFixed(1)}" class="grid-faint"/>`);
    body.push(`  <text x="${plotLeft - 12}" y="${(yy + ROW_H / 2 + 4).toFixed(1)}" class="row-label" text-anchor="end">`
      + `${escapeXml(blockRowLabel(row))}</text>`);
    grid.cells[r].forEach((cell, c) => {
      const x = colX(c);
      const stroke = cell.state === 'absent' ? COLOUR.absentEdge : 'none';
      const fill = fillOf(cell, ramp);
      const ink = markInk(fill);
      body.push(`  <rect class="cell" data-row="${cell.r}" data-col="${c + 1}" data-state="${cell.state}"`
        + `${cell.layer >= 0 ? ` data-layer="${cell.layer}"` : ''}`
        + `${grid.aggregated ? ` data-block="${cell.row}x${cell.col}"` : ''}`
        + `${cell.overlay ? ` data-overlay="${cell.overlay}"` : ''} x="${x.toFixed(1)}" y="${yy.toFixed(1)}"`
        + ` width="${cellW.toFixed(1)}" height="${ROW_H}" fill="${fill}"${stroke === 'none' ? '' : ` stroke="${stroke}"`}/>`);
      if (cell.state === 'candidate') {
        body.push(`  <text x="${(x + cellW / 2).toFixed(1)}" y="${(yy + ROW_H / 2 + 3).toFixed(1)}" class="cell-mark" text-anchor="middle" fill="${ink}">${grid.aggregated ? '·' : 'hit'}</text>`);
      }
      if (cell.state === 'root') {
        // The caret marks the walk's own anchor. It is layer 0, so it sits on the deepest shade of the
        // ramp: the mark is kept and its ink is picked against the shade rather than the other way round.
        body.push(`  <path d="M ${(x + 6).toFixed(1)} ${(yy + ROW_H - 6).toFixed(1)} l 4.5 -8 l 4.5 8 z" fill="${ink}" class="root-mark"/>`);
      }
      if (cell.overlay) {
        const dashed = cell.overlay === 'passage' ? ' stroke-dasharray="4 3"' : '';
        // Two strokes, one mark. The wider pale one is a backing, not a second encoding: it is there so
        // the ring keeps its contrast over a `#2f6fd0` layer-0 cell as well as over a `#d7e0ee` `existed`
        // one, and the dash pattern (which says passage-only) still belongs to the ring alone.
        body.push(`  <rect class="ring-halo" data-row="${cell.r}" data-col="${c + 1}" data-overlay="${cell.overlay}"`
          + ` x="${(x + 1.5).toFixed(1)}" y="${(yy + 1.5).toFixed(1)}" width="${(cellW - 3).toFixed(1)}"`
          + ` height="${ROW_H - 3}" fill="none" stroke="${COLOUR.ringHalo}" stroke-width="5" opacity="0.9"/>`);
        body.push(`  <rect class="ring" data-row="${cell.r}" data-col="${c + 1}" data-overlay="${cell.overlay}"`
          + ` x="${(x + 1.5).toFixed(1)}" y="${(yy + 1.5).toFixed(1)}" width="${(cellW - 3).toFixed(1)}"`
          + ` height="${ROW_H - 3}" fill="none" stroke="${COLOUR.ring}" stroke-width="2.5"${dashed}/>`);
      }
    });
  });
  body.push(`  <line x1="${MARGIN}" y1="${(matrixTop + gridH + 1).toFixed(1)}" x2="${W - MARGIN}" y2="${(matrixTop + gridH + 1).toFixed(1)}" class="axis"/>`);
  body.push(`  <text x="${MARGIN}" y="${(matrixTop + gridH + 22).toFixed(1)}" class="panel-note">${escapeXml(grid.aggregated
    ? `Row 0 is the oldest segment; each drawn row stands for ${grid.rowBlocks[0].width === 1 ? '1 segment' : `up to ${Math.max(...grid.rowBlocks.map((b) => b.width))} segments`} of the graph's append order, and each column for ${Math.max(...grid.colBlocks.map((b) => b.width))} invocation(s). The per-invocation table below is exact.`
    : `row 0 is the oldest segment of ${exactRows}; every row above it is one segment later in the graph's append order.`)}</text>`);
  layerNote.forEach((line, i) => {
    body.push(`  <text x="${MARGIN}" y="${(matrixTop + gridH + 37 + i * 15).toFixed(1)}" class="panel-note">${escapeXml(line)}</text>`);
  });
  body.push('</g>');

  // -- legend ---------------------------------------------------------------------------------
  const { at: lAt } = bands[3];
  body.push(`<g class="band" data-band="legend" transform="translate(0,${lAt})">`);
  body.push(`  <text x="${MARGIN}" y="24" class="panel-title">Legend — what each cell state is read from, and what its shade is</text>`);
  legendItems.forEach(([kind, text], i) => {
    const col = i % 2;
    const rowI = Math.floor(i / 2);
    const lx = MARGIN + col * 600;
    const ly = 48 + rowI * 19;
    if (kind === 'ramp') {
      // The ramp is drawn at the width its layers have in the figure: the anchor (`hit`) at the left,
      // the deepest recorded layer at the right, each swatch one layer wide, and the shades exactly the
      // ones a cell of that layer is filled with.
      const sw = 16;
      const usable = sw * ramp.length;
      const gap = ramp.length > 1 ? 4 : 0;
      const stepPx = ramp.length > 1 ? Math.max(sw, (usable - gap) / (ramp.length - 1) + gap) : sw;
      const stripEnd = lx + stepPx * (ramp.length - 1) + sw;
      ramp.forEach((entry, k) => {
        const sx = lx + k * stepPx;
        body.push(`  <rect x="${sx.toFixed(1)}" y="${ly - 12}" width="${sw}" height="14" fill="${entry.colour}"/>`);
        body.push(`  <text x="${(sx + sw / 2).toFixed(1)}" y="${(ly + 16).toFixed(1)}" class="ramp-tick"`
          + ` text-anchor="middle">${entry.layer}</text>`);
      });
      // The two values the strip has to be read against, drawn on the same scale rather than described.
      for (const [cx, fill, label] of [
        [stripEnd + 14, COLOUR.existed, 'existed'],
        [stripEnd + 62, COLOUR.absent, 'absent'],
      ]) {
        body.push(`  <rect x="${cx}" y="${ly - 12}" width="${sw}" height="14" fill="${fill}"${fill === COLOUR.absent ? ` stroke="${COLOUR.absentEdge}"` : ''}/>`);
        body.push(`  <text x="${(cx + sw / 2).toFixed(1)}" y="${(ly + 16).toFixed(1)}" class="ramp-tick" text-anchor="middle">${label}</text>`);
      }
      body.push(`  <text x="${(stripEnd + 92).toFixed(1)}" y="${ly}" class="legend">${escapeXml(text)}</text>`);
      return;
    }
    // The ring swatches are drawn on the same backing the cells use, so the legend shows the ring as it
    // reads over a fill rather than as it reads over nothing.
    if (kind === 'candidate') {
      body.push(`  <rect x="${lx}" y="${ly - 12}" width="26" height="14" fill="${ramp[0].colour}"/>`);
      body.push(`  <text x="${lx + 11}" y="${ly - 1}" class="cell-mark" text-anchor="middle" fill="${markInk(ramp[0].colour)}">hit</text>`);
    } else if (kind === 'absent') {
      body.push(`  <rect x="${lx}" y="${ly - 12}" width="26" height="14" fill="${COLOUR.absent}" stroke="${COLOUR.absentEdge}"/>`);
    } else if (kind === 'existed') {
      body.push(`  <rect x="${lx}" y="${ly - 12}" width="26" height="14" fill="${COLOUR.existed}"/>`);
    } else if (kind === 'selected' || kind === 'passage') {
      body.push(`  <rect x="${lx}" y="${ly - 12}" width="26" height="14" fill="${COLOUR.existed}"/>`);
      body.push(`  <rect x="${lx + 1.5}" y="${ly - 10.5}" width="23" height="11" fill="none" stroke="${COLOUR.ringHalo}" stroke-width="5" opacity="0.9"/>`);
      body.push(`  <rect x="${lx + 1.5}" y="${ly - 10.5}" width="23" height="11" fill="none" stroke="${COLOUR.ring}"`
        + ` stroke-width="2.5"${kind === 'passage' ? ' stroke-dasharray="4 3"' : ''}/>`);
    } else {
      body.push(`  <rect x="${lx}" y="${ly - 12}" width="26" height="14" fill="${ramp[0].colour}"/>`);
      body.push(`  <path d="M ${lx + 6} ${ly - 2} l 4.5 -8 l 4.5 8 z" fill="${markInk(ramp[0].colour)}"/>`);
    }
    body.push(`  <text x="${lx + 36}" y="${ly}" class="legend">${escapeXml(text)}</text>`);
  });
  noteLines.forEach((line, i) => {
    body.push(`  <text x="${MARGIN}" y="${(48 + legendRows * 19 + 14 + i * 15).toFixed(1)}" class="panel-note">${escapeXml(line)}</text>`);
  });
  body.push('</g>');

  // -- the per-invocation record ---------------------------------------------------------------
  const { at: tAt } = bands[4];
  body.push(`<g class="band" data-band="record" transform="translate(0,${tAt})">`);
  body.push(`  <text x="${MARGIN}" y="24" class="panel-title">Per-invocation record (control plane and tape, as recorded)</text>`);
  let tx = MARGIN;
  const headerYs = 52;
  for (const col of tableCols) {
    body.push(`  <text x="${col.align === 'end' ? (tx + col.w - 8).toFixed(1) : tx.toFixed(1)}" y="${headerYs}" class="table-head"${col.align === 'end' ? ' text-anchor="end"' : ''}>${escapeXml(col.label)}</text>`);
    tx += col.w;
  }
  columns.forEach((column, i) => {
    const ty = headerYs + 20 + i * 20;
    const a = column.record;
    const cells = {
      n: String(column.index),
      when: `T${column.place.turn} · S${column.place.step}`,
      clock: clock(a.ts),
      seq: String(a.seq),
      w: String(a.windowN) + (a.windowN !== model.knobs.w ? ' *' : ''),
      cand: String(a.candidates),
      sel: String(a.selected),
      depth: String(a.bfsDepth),
      pairs: `${a.judgedPairs ?? '?'}/${a.scoredPairs ?? '?'}`,
      // A reading, or a dash: a run whose assembly records predate the field has no deferral number, and printing 0
      // for it would claim nothing was ever held back.
      deferred: a.deferredPairs === undefined ? '—' : String(a.deferredPairs),
      fallback: column.fallback === '' ? '—' : column.fallback,
      ids: column.selected === null
        ? (a.selected === 0 ? 'none selected (count 0)' : `not recorded — count only (${a.selected})`)
        : column.selected.map((e) => (e.passage ? `${shortId(e.id)}→passage` : shortId(e.id))).join(', '),
    };
    tx = MARGIN;
    for (const col of tableCols) {
      const value = cells[col.key] ?? '';
      const cls = col.key === 'ids'
        ? (column.selected === null ? (a.selected === 0 ? 'table-cell' : 'table-cell-warn') : 'table-cell-ok')
        : 'table-cell';
      body.push(`  <text x="${col.align === 'end' ? (tx + col.w - 8).toFixed(1) : tx.toFixed(1)}" y="${ty}" class="${cls}"${col.align === 'end' ? ' text-anchor="end"' : ''}>${escapeXml(value)}</text>`);
      tx += col.w;
    }
  });
  tableNote.forEach((line, i) => {
    body.push(`  <text x="${MARGIN}" y="${(headerYs + 20 + nCols * 20 + 14 + i * 15).toFixed(1)}" class="panel-note">${escapeXml(line)}</text>`);
  });
  body.push('</g>');

  // -- sources ---------------------------------------------------------------------------------
  const { at: sAt } = bands[5];
  body.push(`<g class="band" data-band="sources" transform="translate(0,${sAt})">`);
  body.push(`  <line x1="${MARGIN}" y1="0" x2="${W - MARGIN}" y2="0" class="grid"/>`);
  sourceLines.forEach((line, i) => {
    body.push(`  <text x="${MARGIN}" y="${16 + i * 15}" class="source">${escapeXml(line)}</text>`);
  });
  body.push('</g>');

  const style = `<style>
    text { font-family: ${SVG_FONT}; }
    .doc-title { fill: ${COLOUR.ink}; font-size: 19px; font-weight: 600; }
    .doc-sub { fill: ${COLOUR.muted}; font-size: 12px; }
    .panel-title { fill: ${COLOUR.ink}; font-size: 14.5px; font-weight: 600; }
    .panel-note { fill: ${COLOUR.muted}; font-size: 11px; }
    .legend { fill: #3b4553; font-size: 11px; }
    .tick { fill: ${COLOUR.muted}; font-size: 10.5px; }
    .axis-label { fill: ${COLOUR.muted}; font-size: 10.5px; }
    .bar-value { fill: ${COLOUR.ink}; font-size: 10.5px; }
    .cell-mark { fill: #ffffff; font-size: 9.5px; }
    .ramp-tick { fill: ${COLOUR.muted}; font-size: 9px; }
    .row-label { fill: ${COLOUR.ink}; font-size: 11px; }
    .col-label { fill: ${COLOUR.ink}; font-size: 11.5px; font-weight: 600; }
    .badge-fallback { fill: ${COLOUR.fallback}; font-size: 9.5px; }
    .badge-yes { fill: #2f6fd0; font-size: 9.5px; }
    .badge-no { fill: ${COLOUR.ring}; font-size: 9.5px; }
    .table-head { fill: ${COLOUR.muted}; font-size: 10.5px; }
    .table-cell { fill: ${COLOUR.ink}; font-size: 11px; }
    .table-cell-ok { fill: #21618c; font-size: 11px; }
    .table-cell-warn { fill: ${COLOUR.ring}; font-size: 11px; }
    .source { fill: ${COLOUR.muted}; font-size: 10.5px; }
    .grid { stroke: ${COLOUR.rule}; stroke-width: 1; }
    .grid-faint { stroke: ${COLOUR.ruleFaint}; stroke-width: 1; }
    .axis { stroke: ${COLOUR.axis}; stroke-width: 1.2; }
  </style>`;
  const banner = '<!-- generated by scripts/s1-activity.mjs (S1CAP recall activity); self-contained, no script, no external font -->';
  return `${banner}
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}" data-chart="s1-activity" data-chart-mode="${grid.mode}" role="img" aria-label="${escapeXml(meta.title)}">
  <title>${escapeXml(meta.title)}</title>
  <rect x="0" y="0" width="${W}" height="${height}" fill="#ffffff"/>
  ${style}
${body.join('\n')}
</svg>
`;
}

// ---------------------------------------------------------------------------------------------
// 8. The summary line
//
// One line, so a caller can sanity-check the figure without opening it: the dimensions, how many cells
// of each state, and — the number that decides how much of the picture is missing — how many selected
// segments have a recorded identity and how many are a count with no id behind it. It also states the
// drawing mode (exact or aggregated, and at what block size) and the async-upkeep lag it tolerated, so a
// caller that expected an exact matrix can see that it did not get one without parsing the SVG.
// ---------------------------------------------------------------------------------------------

function summaryLine(model, meta) {
  const { counts, columns } = model;
  const cells = counts.absent + counts.candidate + counts.root + counts.existed;
  const grid = meta.gridInfo;
  return `s1-activity: ${meta.cell} @ ${meta.runName} — ${columns.length} invocations x ${model.rows.length} segments `
    + `(${cells} cells): not-created ${counts.absent}, candidate ${counts.candidate}, walk-root ${counts.root}, `
    + `existed-not-returned ${counts.existed} · selected ${model.selectedTotal} `
    + `(ids recorded ${model.identityRows} on ${model.identityColumns}/${columns.length} invocations`
    + `${model.passageColumns > 0 ? ` + ${counts.selectedPassage} passage-only row(s)` : ''}, count-only ${model.countOnly}) `
    + `· recall hits shaded by BFS layer on one run-global ramp sized for depth ${model.maxLayer} `
    + `(${model.depthRamp.map((e) => `L${e.layer} ${e.colour}`).join(', ')}) `
    + `· knobs w=${model.knobs.w} r=${model.knobs.r} d=${model.knobs.d}`
    + `${model.knobs.wait === undefined ? '' : ` wait=${model.knobs.wait}`}`
    + ` · ${model.carryCells} same-step carry cell(s)`
    + ` · ${model.lagCells} async-lag cell(s) within ${model.lagToleranceMs} ms (max ${model.maxLagMs} ms)`
    + ` · ${model.emptyDeliveries} of ${model.deliveriesTotal} delivery record(s) carried nothing and own no `
    + 'invocation (no selection to attach; counted, not refused)'
    + ` · drawing ${grid.mode}${grid.aggregated
      ? ` (${columns.length}x${model.rows.length} exact, drawn as ${grid.nCols}x${grid.nRows} blocks of up to `
        + `${Math.max(...grid.colBlocks.map((b) => b.width))}x${Math.max(...grid.rowBlocks.map((b) => b.width))})`
      : ` (${grid.nCols}x${grid.nRows})`}`
    + ' · SVG only (no rasteriser in this repository: a PNG path would need a dependency this tool does not take)';
}

/**
 * `--explain`: the derivation behind each column, in words. The figure states what it read; this states
 * where each state came from, so a reader can check the figure against the run without re-deriving it.
 */
function explainLines(model) {
  const lines = [];
  for (const column of model.columns) {
    const a = column.record;
    const carried = column.carryIds.length === 0
      ? 'none'
      : column.carryIds.map((id) => {
        const s = model.snapshot.byId.get(id);
        return `${id} (+${s.ts - a.ts} ms)`;
      }).join(', ');
    lines.push(`invocation #${column.index} · turn ${column.place.turn} step ${column.place.step} · ts ${a.ts} (${clock(a.ts)}) `
      + `· seq ${a.seq} · windowN ${a.windowN} · candidates ${a.candidates} · selected ${a.selected} · bfsDepth ${a.bfsDepth}`
      + `${column.fallback === '' ? '' : ` · fallback ${column.fallback}`}`);
    lines.push(`  exists: ${column.existed.size} of ${model.rows.length} segments `
      + `(${column.strictIds.size} by creation stamp, carry: ${carried})`);    lines.push(`  walk: ${column.root === null ? 'no tree recorded (recall returned no hit)' : `root ${column.root}`}`
      + `${column.candidates.length === 0 ? '' : `, hits ${column.candidates.join(', ')}`}`);
    // The layers are printed per invocation, not just per figure, because that is what the fill was read
    // from: `depth` here is the BFS layer, and the sentence says which layer the run-global ramp draws it at.
    lines.push(`  layers (BFS, 0 = the walk's own anchor; the run-global ramp is sized for depth ${model.maxLayer}): `
      + `${column.root === null ? 'the walk returned no tree, so no cell is layered'
        : [...column.depths.entries()].map(([id, d]) => `${id}=L${d} → ${model.depthRamp[d].colour}`).join(', ')}`);
    lines.push(`  selected: ${column.selected === null
      ? (a.selected === 0 ? 'none (recorded count 0)' : `count only (${a.selected}), no id recorded`)
      : `${column.selected.map((e) => (e.passage ? `${e.id} → passage of ${e.rows.length} chunk(s)` : e.id)).join(', ')} `
        + `from the delivered payload ${column.payloadId}`}`);
  }
  if (model.unsegmentedCarry.length > 0) {
    lines.push(`carried messages that produced no segment (the adapter could not read their shape, so they have no row): `
      + `${model.unsegmentedCarry.map((u) => `${u.id} at invocation #${u.at + 1}`).join(', ')}`);
  }
  if (model.depthDivergences.length > 0) {
    lines.push(`invocations whose recorded bfsDepth is not the depth of the tree they walked: `
      + `${model.depthDivergences.length} of ${model.columns.length} - the field is set in the assembler's selection `
      + `loop, so a walk that returned hits and placed none records 0 while its tree still holds them. The cells are `
      + `shaded from the tree. `
      + model.depthDivergences.map((d) => `${d.where}: recorded ${d.recorded}, walked ${d.walk} `
        + `(candidates ${d.candidates}, selected ${d.selected})`).join('; '));
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------
// 9. main
// ---------------------------------------------------------------------------------------------

function usage() {
  return [
    'usage: node scripts/s1-activity.mjs --run <run-dir> --cell <name> [--out <run-dir>/report/s1-activity.svg]',
    '                                   [--grid <maxCols>x<maxRows>] [--explain]',
    '       node scripts/s1-activity.mjs --self-test',
    '',
    'Output is SVG only. There is no PNG path: rasterising an SVG needs a dependency (sharp, canvas, resvg) that this',
    'repository does not take for a figure whose geometry is already asserted as text, so a `--out *.png` is refused',
    'rather than written as an SVG under a PNG name.',
    '',
    `Matrices larger than ${MAX_COLS_EXACT} columns or ${MAX_ROWS_EXACT} rows are drawn aggregated (consecutive invocations`,
    'and consecutive segments roll up into blocks, shaded by the strongest recorded state in each). --grid raises or',
    'lowers those ceilings; the summary line always states which mode was used, and every count stays exact.',
    '',
    'A walked cell (recall candidate / walk root) is shaded by its BFS layer, read from the recallTree\'s own nesting:',
    'layer 0 is the walk\'s own anchor, its children layer 1, and so on. The ramp is one hue derived from the',
    'candidate blue and is sized ONCE for the whole figure from the run\'s deepest recorded bfsDepth, so the same shade',
    'means the same layer in every column. Layer changes the fill only: the selection ring and the root caret encode',
    'other recorded facts and are kept, with their ink chosen for contrast against the shade under them.',
  ].join('\n');
}

/** `--grid <cols>x<rows>`: the aggregation ceilings, for a caller that wants the exact matrix whatever its size. */
function parseGrid(value) {
  if (value === undefined) return undefined;
  const m = /^(\d+)x(\d+)$/.exec(value);
  if (m === null) fail(`--grid must look like 120x200 (columns x rows), got ${JSON.stringify(value)}`);
  const maxCols = Number(m[1]);
  const maxRows = Number(m[2]);
  if (maxCols < 1 || maxRows < 1) fail(`--grid must be at least 1x1, got ${JSON.stringify(value)}`);
  return { maxCols, maxRows };
}

function run(options) {
  const runDir = resolve(options.run);
  if (!existsSync(runDir)) fail(`no such run directory: ${runDir}`);
  const control = loadControl(runDir, options.cell);
  const snapshot = loadSnapshot(runDir, options.cell, control.sessionIds);
  const tape = loadTape(runDir, options.cell);
  const stepInfo = loadStepBoundaries(runDir, options.cell, control.sessionIds);
  const messages = loadMessageTexts(runDir, options.cell, stepInfo);
  const model = derive({ control, snapshot, tape, stepInfo, messages });
  const rel = (p) => relative(runDir, p).split(sep).join('/');
  // The two clauses that only sometimes apply are built away from the note array: a nested template
  // inside a conditional inside a template is where a caption stops being readable in the source too.
  const passageClause = model.counts.selectedPassage > 0
    ? `, plus ${model.counts.selectedPassage} row(s) whose delivered provenance names a passage parent rather than `
      + 'the chunk that was selected'
    : '';
  const unsegmentedClause = model.unsegmentedCarry.length > 0
    ? ` ${model.unsegmentedCarry.length} message(s) a step carried produced no segment at all (the adapter could not read `
      + 'their shape), so they have no row here.'
    : '';
  const runName = basename(runDir);
  const displayName = runName.startsWith('round-') ? runName.slice('round-'.length) : runName;
  const span = model.columns.length > 0
    ? `${clock(model.columns[0].record.ts)} – ${clock(model.columns[model.columns.length - 1].record.ts)}`
    : '-';
  const knobs = `w=${model.knobs.w} r=${model.knobs.r} d=${model.knobs.d}`
    + `${model.knobs.wait === undefined ? '' : ` wait=${model.knobs.wait}ms`}`;
  // What the figure will actually be, decided before the captions are written so the subtitle can say it.
  const gridInfo = layoutOf(model, options.grid);
  const lagClause = model.lagCells > 0
    ? ` A further ${model.lagCells} cell(s) exist only because of the bounded async-upkeep lag: those segments' rows are `
      + `stamped after the invocation, by at most ${model.maxLagMs} ms, inside the documented ${model.lagToleranceMs} ms window `
      + '(the graph write follows the assembly, and the round that forced this window measured 37 ms).'
    : '';
  const aggregateClause = gridInfo.aggregated
    ? ` The matrix is drawn AGGREGATED: ${model.columns.length} x ${model.rows.length} exact cells become `
      + `${gridInfo.nCols} x ${gridInfo.nRows} blocks, each shaded by the strongest recorded state in it, because the exact `
      + `figure would be ${model.columns.length} columns x ${model.rows.length} rows. Every count in this document is still `
      + 'computed from the full matrix, and the per-invocation table below is exact.'
    : '';
  /**
   * What the ramp is, in one sentence the figure prints under the matrix — and the clause that only
   * sometimes applies, which is the case this ramp is most easily misread in: a walk that did not reach
   * as deep as the run did. The scale stays the run's; the walk's own `bfsDepth` says how far down it
   * goes, so a shade never means a layer that walk never visited.
   */
  const ramp = model.depthRamp;
  const shallowWalk = model.columns.filter((c) => c.record.bfsDepth < model.maxLayer);
  const shallowClause = shallowWalk.length === 0
    ? ''
    : ` ${shallowWalk.length} of ${model.columns.length} invocation(s) did not reach the run's deepest layer; `
      + `their own recorded bfsDepth (${shallowWalk.map((c) => c.record.bfsDepth).join(', ')}) is the floor under `
      + 'their cells, so a shade there never claims a depth that walk did not walk.';
  const layerNote = model.maxLayer === 0
    // The honest special case: a run whose every walk recorded depth 0 has no layer-1 cell to shade, and a
    // ramp fitted to what is present would print two shades that mean the same thing. The scale stays the
    // run's (one shade), and the figure says the run never walked past its anchor rather than implying it did.
    ? `This cell's walks all recorded bfsDepth 0, so no invocation of this run reached past its own anchor and there is `
      + `no layer above 0 to shade: the ramp is a single shade (${ramp[0].colour}), and no recalled cell is drawn in this `
      + `figure (${model.counts.candidate} candidate, ${model.counts.root} walk-root).`
    : `Shading of a walked cell is its BFS layer, read from the recallTree's own nesting: layer 0 is the anchor `
      + `the walk started from, layer 1 what it found one step out, and so on to this run's deepest recorded layer ${model.maxLayer}. `
      + `The ramp (${ramp.map((e) => e.colour).join(' → ')}) is sized ONCE from that run-global depth, so one shade means one `
      + `layer in every column and the columns can be compared against each other; the deepest shade is still unmistakably `
      + `darker than "existed" (#d7e0ee) and "absent" (#ffffff), which is the line a recalled cell must stay on the right of.${shallowClause}`;
  const meta = {
    runName,
    cell: options.cell,
    grid: options.grid,
    gridInfo,
    title: `S1CAP recall activity — cell ${options.cell}, round ${displayName}`,
    subtitle: [
      `${model.columns.length} recall invocations × ${model.rows.length} segments (the cell's final segment count), `
        + `oldest segment at the bottom · records span ${span}`,
      `recall knobs, in force for the run: ${knobs}`
        + (Object.keys(tape.retuned ?? {}).length === 0
          ? ' (the wiring record states these and no retune was recorded)'
          : ` — **RETUNED on the first step**, so the wiring record states other values: `
            + Object.entries(tape.retuned).map(([k, v]) => `${k} ${String(v.from)} -> ${String(v.to)}`).join(', '))
        + ` · the window each invocation itself ran with is its assembly record's windowN`
        + `${model.columns.every((c) => c.record.windowN === model.knobs.w) ? ' (all equal to w)' : ' (marked * in the table where it differs)'}`,
      `cell states: not yet created ${model.counts.absent} · recall candidate ${model.counts.candidate} · `
        + `walk root ${model.counts.root} · existed but not returned ${model.counts.existed}`
        + ` · selected ids recorded ${model.identityRows} of ${model.selectedTotal}`,
      `walked cells are shaded by BFS layer 0–${model.maxLayer} on ONE run-global ramp `
        + `(layer 0 = the walk's own anchor, the most intense): ${ramp.map((e) => e.colour).join(' → ')}`,
      gridInfo.note,
    ],
    layerNote,
    countsNote: 'left bar: assembly.candidates (the walk\'s hits) · right bar: assembly.selected (how many were taken). '
      + 'Both are recorded counts; the ring below is the only recorded per-segment identity of a selection.'
      + (gridInfo.aggregated ? ' In a column block the bars are the largest recorded count in that block.' : ''),
    matrixNote: gridInfo.aggregated
      ? 'one cell per BLOCK of (segments, invocations) — see the fifth subtitle line for the block size. Blue = the recorded '
        + 'walk returned something in the block, and the shade is the BFS layer it returned them at; dim = something existed in it '
        + 'and the walk did not return it; blank = nothing in it existed yet. A ring marks a block in which a delivered payload '
        + 'named a segment, which is where a selected id is written down. A `·` in a filled block is a rolled-up hit, not a '
        + 'single one, and a block holding hits of several depths is drawn at the most intense of them.'
      : 'one cell per (segment, invocation). Blue = the recorded walk returned that segment, and the shade is the BFS layer '
        + 'it returned it at (darkest = the walk\'s own anchor); dim = it existed and the walk did not return it; blank = it did '
        + 'not exist yet. A ring marks a delivered selection, which is where a selected id is written down. Row labels: '
        + '`+parent` marks one chunk of a longer event, so `id#n` is the chunk.',
    notes: [
      `Brightness is a measurement, not an emphasis: the walk root and its first layer out are both at the top of this figure's `
        + `blue and differ by exactly one step of a ${ramp.length}-shade ramp, because the only thing that separates them in the `
        + `record is the depth they were reached at. Every shade on it stays on the recalled side of "existed" `
        + `(the deepest is ${contrast(ramp[ramp.length - 1].colour, COLOUR.existed).toFixed(2)}:1 against it), so a cell read as `
        + 'remembered can never be mistaken for a cell read as merely present.',
      `The selected identity is recorded for ${model.identityColumns} of ${model.columns.length} invocations. assembly.selected `
        + 'is a count: the control plane stores no per-segment id list for it, and recallTree is the candidate walk rather '
        + 'than the ranking. A ring is drawn only where a delivered payload names the segment (its provenance line, keyed by '
        + 'context_delivery.payloadId); elsewhere the recorded count stands alone in the bar, the table below, and this note.',
      `Of ${model.selectedTotal} selected segments, ${model.identityRows} have a recorded id and ${model.countOnly} are a count `
        + `with no id${passageClause}. Nothing here infers the missing ones.`,
      `"Existed but not returned" is not "judged irrelevant": the walk only follows edges at or above r=${model.knobs.r}, from the `
        + `anchor it chose, and a pair inside the window that was never scored has no edge to follow. ${model.carryCells} cell(s) `
        + 'exist by their own step\'s recorded payload although their creation stamp is a few milliseconds later than the '
        + `invocation (the graph write follows the assembly) — counted, not silently tolerated.${lagClause}${aggregateClause}${unsegmentedClause}`,
      `The shade scale is sized once for the whole figure from this run's deepest recorded walk depth `
        + `(bfsDepth ${model.maxLayer}, across ${model.columns.map((c) => c.record.bfsDepth).join(', ')} for its `
        + `${model.columns.length} invocation(s)), not per column. A ramp fitted per column would make every column look `
        + `alike and the comparison between them — the whole reason the shade is layered — impossible.${shallowClause}`,
    ],
    tableNote: 'seq is the plugin\'s own running message counter, not a step number; the turn/step column is attributed by time '
      + '(the pre-step hook runs immediately before its step/start event). "ids: not recorded" means the run holds a count and no id list. '
      + 'depth is the invocation\'s own recorded bfsDepth, which this tool checks against the deepest layer in its recallTree.',
    sources: [
      `control plane: ${elidePath(rel(control.path))}`,
      `association graph snapshot: home/${options.cell}/.s1cap/rg/${snapshot.file} (session ${snapshot.doc.sessionId ?? '?'})`,
      `tape (wiring + step payloads): ${elidePath(rel(tape.path))}`
        + ` — ${tape.wiringCount} wiring record(s)${tape.wiringCount > 1 ? ', all stating the same knobs (the cell restarted)' : ''}, `
        + `${tape.payloads.length} step payload record(s)`,
      `session store (turn/step attribution): ${elidePath(rel(stepInfo.path))}`,
      `delivered payload text: ${messages.sources.map((p) => elidePath(rel(p))).join(' + ')}`,
      'self-contained SVG: no script, no external font, no network — the figure stands alone. **SVG only**: this tool',
      'writes no PNG, because a rasteriser is a dependency (sharp/canvas/resvg) that this repository does not take for a',
      'figure no test can read back. A `.png` path is refused rather than written as an SVG under a PNG name.',
    ],
  };
  const svg = renderFigure(model, meta);
  return { model, meta, svg, line: summaryLine(model, meta) };
}

// ---------------------------------------------------------------------------------------------
// 10. --self-test
//
// A synthetic run is built under the OS temp directory — a real control.jsonl, a real association-graph
// snapshot, a real tape, a real multi-frame zstd session store and a real delivered payload — and the
// arithmetic is asserted on what the tool derives from it. The three assertions the tool owes its
// caller are here: the state counts, that nothing is selected before it exists, and that the row count
// is the final segment count. The defect cases are asserted too, because a rule that only ever passes
// is indistinguishable from no rule.
// ---------------------------------------------------------------------------------------------

const FIXTURE_SESSION = 'session-fixture-0001';

/** Frames of a multi-frame store, one zstd frame per group of lines (the shape a live store has). */
function zstdFrames(text, chunkLines) {
  const lines = text.split('\n').filter((l) => l !== '');
  const frames = [];
  for (let i = 0; i < lines.length; i += chunkLines) {
    frames.push(zstdCompressSync(Buffer.from(lines.slice(i, i + chunkLines).join('\n') + '\n', 'utf8')));
  }
  return Buffer.concat(frames);
}

const FIXTURE_SEGMENTS = [
  { id: 'u1', kind: 'user', seq: 8, ts: 1010, tokens: 191, text: 'first question' },
  { id: 'u2', kind: 'user', seq: 9, ts: 1100, tokens: 98, text: 'runtime context' },
  { id: 't1', kind: 'trace', seq: 18, ts: 1500, tokens: 217, text: 'reasoning' },
  { id: 'P#0', kind: 'trace', seq: 20, ts: 1600, tokens: 506, chunkOf: 'P', text: 'long answer, first chunk' },
  { id: 'P#1', kind: 'trace', seq: 20, ts: 1600, tokens: 152, chunkOf: 'P', text: 'long answer, second chunk' },
  { id: 'r1', kind: 'toolResult', seq: 24, ts: 2500, tokens: 17, text: 'tool output' },
  { id: 'r2', kind: 'toolResult', seq: 31, ts: 3050, tokens: 12, text: 'later tool output' },
];

/**
 * The fixture's five invocations, one per step: a walk that found nothing (fallback), a walk whose
 * selection is recorded in a delivered payload, a walk that selected a chunked event (recorded only
 * at passage granularity), a walk selected again from a delivered payload, and a fallback selection
 * whose ids the run never wrote down — the case the figure must show as a count and not as a state.
 * `defects` each break exactly one recorded relation, so the tool has to fail rather than draw around it.
 *
 * `defects.lagSelected` is the one that does *not* break a relation: it moves a selected segment's creation stamp
 * `lagSelected` ms past the invocation that selected it, which is what the association-graph upkeep does on a live
 * run (round `20261002-2037` measured 37 ms). Inside `ASYNC_LAG_TOLERANCE_MS` that is a race and the figure draws;
 * `defects.selectNotYetExisting` stamps a selected segment 600 ms past its invocation, which is outside the window
 * and is therefore refused - the two cases are the two sides of the one bound the tolerance draws.
 *
 * `defects.deepTree` replaces the last invocation's walk with a five-layer one, because a two-layer ramp cannot
 * tell a decaying scale from a two-value lookup: the runs that need this shaded by layer reach three and more.
 * `defects.treeShape` corrupts one node of a walk instead, which is the shape the layer reader refuses rather
 * than guesses - a layer that no record states is worse than no layer at all.
 */
function fixtureInvocations(defects = {}) {
  const inv = [
    { ts: 1000, seq: 0, windowN: 1024, candidates: 0, selected: 0, bfsDepth: 0, recallTree: {}, fallback: 'recency-window' },
    { ts: 2000, seq: 5, windowN: 1024, candidates: 2, selected: 1, bfsDepth: 1, recallTree: { u1: { u2: {}, t1: {} } } },
    { ts: 3000, seq: 9, windowN: 1024, candidates: 1, selected: 1, bfsDepth: 1, recallTree: { t1: { 'P#0': {} } } },
    { ts: 4000, seq: 12, windowN: 2048, candidates: 2, selected: 2, bfsDepth: 1, recallTree: { r1: { r2: {}, t1: {} } } },
    { ts: 5000, seq: 15, windowN: 1024, candidates: 0, selected: 2, bfsDepth: 0, recallTree: {}, fallback: 'recency-window' },
  ];
  // Five layers on the one invocation that already exists, so the state taxonomy and every count in the
  // default fixture stay exactly as they were and this case can be asserted on its own.
  if (defects.deepTree) {
    inv[4] = {
      ...inv[4],
      candidates: 4,
      bfsDepth: 4,
      recallTree: { u1: { u2: { t1: { r1: { r2: {} } } } } },
      fallback: undefined,
    };
  }
  if (defects.treeShape === 'notAnObject') inv[1].recallTree = { u1: { u2: [], t1: {} } };
  if (defects.treeShape === 'idAtTwoLayers') {
    // The repeat is inside the tree, and the id list minus the root still has the two hits the record
    // claims, so the existing candidates agreement check passes: this case is caught by the layer reader
    // and by nothing else, which is the point of asserting it.
    inv[1].recallTree = { u1: { u2: {}, t1: { u1: {} } } };
  }
  if (defects.treeShape === 'twoRoots') inv[1].recallTree = { u1: {}, u2: { t1: {} } };
  if (defects.treeShape === 'depthMismatch') inv[1].bfsDepth = 3;
  if (defects.candidateCount) inv[1].candidates = 3;
  if (defects.selectedCount) inv[3].selected = 3;
  // The direction that is still impossible: a payload naming more segments than the assembly selected. The other
  // direction - fewer, which `selectedCount` produces - became legal with delta delivery on 2026-10-05, because a
  // selected segment the model can already see is not re-injected.
  if (defects.selectedCountTooLow) inv[3].selected = 1;
  return inv.map((a, i) => ({
    windowN: a.windowN,
    scoredPairs: i * 7,
    judgedPairs: i * 7,
    type: 'assembly',
    schema: 1,
    ts: a.ts,
    sessionId: FIXTURE_SESSION,
    seq: a.seq,
    candidates: a.candidates,
    selected: a.selected,
    bfsDepth: a.bfsDepth,
    budgetUsed: 920,
    budgetTotal: 118800,
    blocks: { pinned: 700, stateProxy: 29, recalled: 0, tail: 0, anchor: 191 },
    prefixTokensStable: 700,
    layoutOrder: ['pinned', 'stateProxy', 'anchor', 'recalled', 'tail'],
    xFirst: true,
    layoutStableTokens: 920,
    cutAfterBlock: 'anchor',
    tokensAfterCut: 0,
    recallTree: a.recallTree,
    ...(a.fallback === undefined ? {} : { fallback: a.fallback }),
  }));
}

/**
 * Deliveries, and the prose payload the harness logged for each. The provenance line is written by
 * `renderSegment` as `## earlier <kind> turn, quoted verbatim · <chunkOf ?? id>`, which is what makes
 * a chunked event's selection readable only at passage granularity.
 */
function fixtureDeliveries(defects = {}) {
  const out = [
    { ts: 2005, payloadId: 's1cap-aaaa1111', names: ['u2'], blocks: 1 },
    { ts: 3005, payloadId: 's1cap-bbbb2222', names: defects.selectNotYetExisting ? ['r2'] : ['P'], blocks: 1 },
    { ts: 4005, payloadId: 's1cap-cccc3333', names: ['r2', 't1'], blocks: 2 },
  ];
  // The far side of the attribution bound: a record that DID deliver a selection, moved past every assembly by
  // far more than `ATTRIBUTION_WINDOW_MS`. Nothing can own it, so the figure is refused - the state the empty
  // records above are deliberately not confused with.
  if (defects.deliveredFarFromAssembly) out[2].ts = 900000;
  return out.map((d) => ({
    delivery: {
      type: 'context_delivery',
      schema: 1,
      ts: d.ts,
      sessionId: FIXTURE_SESSION,
      cell: 'C9',
      delivered: true,
      reason: `inserted one message carrying ${d.blocks} block(s): recalled`,
      messagesBefore: 1,
      messagesAfter: 2,
      kept: 1,
      dropped: 0,
      inserted: 1,
      blocks: Array.from({ length: d.blocks }, () => 'recalled'),
      payloadId: d.payloadId,
      order: ['pinned', 'stateProxy', 'anchor', 'recalled', 'tail'],
    },
    text: d.names.map((id) => `## earlier trace turn, quoted verbatim · ${id}\n…${id} body…`).join('\n\n'),
  }));
}

function buildFixture(dir, defects = {}) {
  const runDir = join(dir, 'round-fixture');
  const cellDir = join(runDir, 'evidence', 'C9');
  const stateDir = join(runDir, 'home', 'C9', '.s1cap');
  const storeDir = join(runDir, 'home', 'C9', 'sessions', '--ws--', FIXTURE_SESSION);
  mkdirSync(cellDir, { recursive: true });
  mkdirSync(join(stateDir, 'rg'), { recursive: true });
  mkdirSync(storeDir, { recursive: true });

  const controlLines = [];
  for (const a of fixtureInvocations(defects)) controlLines.push(JSON.stringify(a));
  if (defects.noDelivery) {
    // nothing delivered at all
  } else {
    for (const d of fixtureDeliveries(defects)) controlLines.push(JSON.stringify(d.delivery));
  }
  // An empty record a long way past every assembly (the last is at ts 5000): the state round `20261003-2104`'s
  // C2 wrote 31 of. It reports no selection, so it must be counted and must NOT refuse the figure.
  if (defects.emptyDeliveryFarFromAssembly) {
    controlLines.push(JSON.stringify({
      type: 'context_delivery',
      schema: 1,
      ts: 900000,
      sessionId: FIXTURE_SESSION,
      cell: 'C9',
      delivered: false,
      assembled: false,
      reason: 'the decision carried no messages',
      messagesBefore: 0,
      messagesAfter: 0,
      kept: 0,
      dropped: 0,
      inserted: 0,
      blocks: [],
      order: [],
    }));
  }
  const controlPath = join(cellDir, 'control.jsonl');
  writeFileSync(controlPath, controlLines.join('\n') + '\n', 'utf8');

  const segments = defects.dropSegment
    ? FIXTURE_SEGMENTS.filter((s) => s.id !== defects.dropSegment)
    : FIXTURE_SEGMENTS;
  const stamped = defects.lagSelected !== undefined
    ? segments.map((s) => (s.id === 'P#1' ? { ...s, ts: 3000 + defects.lagSelected } : s))
    // A selected segment stamped 600 ms after the invocation that selected it: outside the async-upkeep window, so
    // the figure must refuse rather than draw a segment that did not exist when it was chosen.
    : defects.selectNotYetExisting === true
      ? segments.map((s) => (s.id === 'r2' ? { ...s, ts: 3600 } : s))
      : segments;  const snapshot = {
    schema: 2,
    order: segments.map((s) => s.id),
    segments: stamped.map((s) => ({ sessionId: FIXTURE_SESSION, role: 'user', taskTag: 'user', ...s })),
    edges: [],
    scores: [],
    scored: segments.length,
    scoredPairs: 21,
    judgedPairs: 21,
    sessionId: defects.wrongSnapshotSession ? 'session-other' : FIXTURE_SESSION,
  };
  writeFileSync(join(stateDir, 'rg', `rg-${FIXTURE_SESSION}-deadbeef.json`), JSON.stringify(snapshot), 'utf8');

  const tapeLines = [];
  const wiring = {
    schema: 0,
    kind: 'wiring',
    s1: { provider: 'laya-serve', mode: 'local', baseUrl: 'http://127.0.0.1:8008' },
    relevance: true,
    xFirst: true,
    recall: { d: 2, r: 0.55, w: 1024, wait: 10000 },
    tas: { on: true, tMaxChars: 8000, updatePolicy: 'perTask' },
  };
  if (!defects.noWiring) {
    tapeLines.push(JSON.stringify(wiring));
    // A round that restarted states its switches again; identical records are one set of knobs.
    if (defects.duplicateWiring) tapeLines.push(JSON.stringify(wiring));
    if (defects.disagreeingWiring) {
      tapeLines.push(JSON.stringify({ ...wiring, recall: { ...wiring.recall, r: 0.9 } }));
    }
  }
  // One payload record per observed step, in step order: the same-step existence correction. The step
  // numbers restart with every turn, which is why they are read from the fixture's own step list
  // rather than derived from the index.
  const steps = [[1, 1, 1005], [1, 2, 2005], [2, 1, 3005], [2, 2, 4005], [2, 3, 5005]];
  const carried = [['u1'], [], [], [], []];
  carried.forEach((ids, i) => {
    if (defects.missingPayloadForStep === steps[i][1] && i > 0) return;
    tapeLines.push(JSON.stringify({
      schema: 1,
      sessionId: i === 0 ? 'unassigned' : FIXTURE_SESSION,
      step: steps[i][1],
      systemPrompt: 'sys',
      messages: ids.map((id) => ({ id, role: 'user' })),
    }));
  });
  writeFileSync(join(stateDir, 'tape.jsonl'), tapeLines.join('\n') + '\n', 'utf8');

  const storeLines = [];
  storeLines.push(JSON.stringify({ type: 'session', seq: 1, time: 900, data: { sessionId: FIXTURE_SESSION } }));
  for (const [turn, step, time] of steps) {
    storeLines.push(JSON.stringify({ type: 'turn/start', seq: 2, time: time - 40, data: { turn } }));
    storeLines.push(JSON.stringify({ type: 'step/start', seq: 3, time, data: { turn, step } }));
  }
  for (const d of fixtureDeliveries(defects)) {
    storeLines.push(JSON.stringify({
      type: 'user/message',
      seq: 40,
      time: d.delivery.ts,
      data: { id: d.delivery.payloadId, role: 'user', source: { kind: 'system-prompt', form: 's1cap' }, content: [{ type: 'text', text: d.text }] },
    }));
  }
  writeFileSync(join(storeDir, 'session.v4.jsonl.zstd'), zstdFrames(storeLines.join('\n'), 3));

  // The evidence copy of the session stream: the same delivered texts, plus the segments themselves.
  const stream = segments.map((s) => JSON.stringify({ ...s, sessionId: FIXTURE_SESSION }));
  if (!defects.noDelivery) {
    for (const d of fixtureDeliveries(defects)) {
      stream.push(JSON.stringify({ id: d.delivery.payloadId, sessionId: FIXTURE_SESSION, seq: 40, kind: 'user', role: 'user', taskTag: 'system-prompt', ts: d.delivery.ts, text: d.text }));
    }
  }
  writeFileSync(join(cellDir, 'session.jsonl'), stream.join('\n') + '\n', 'utf8');
  return runDir;
}

function selfTest() {
  const assertEqual = (actual, expected, what) => {
    if (actual !== expected) {
      throw new Error(`self-test FAILED: ${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  };
  const assertTrue = (cond, what) => {
    if (!cond) throw new Error(`self-test FAILED: ${what}`);
  };
  const assertFails = (fn, match, what) => {
    try {
      fn();
    } catch (err) {
      if (!err.isActivityError) throw new Error(`self-test FAILED: ${what}: threw a non-activity error: ${String(err)}`);
      if (match && !String(err.message).includes(match)) {
        throw new Error(`self-test FAILED: ${what}: message ${JSON.stringify(err.message)} does not mention ${JSON.stringify(match)}`);
      }
      return String(err.message);
    }
    throw new Error(`self-test FAILED: ${what}: no error was raised`);
  };
  const say = (what) => process.stdout.write(`  ok   ${what}\n`);

  const tmp = mkdtempSync(join(tmpdir(), 's1-activity-'));
  try {
    const runDir = buildFixture(tmp);
    const out = run({ run: runDir, cell: 'C9' });
    const { model } = out;

    // --- the three assertions this tool owes its caller -------------------------------------
    // (1) the state counts, from the fixture's own arithmetic
    assertEqual(model.columns.length, 5, 'invocations');
    assertEqual(model.rows.length, FIXTURE_SEGMENTS.length, 'row count is the final segment count');
    // 7 cells are later than their invocation, and of those 2 are inside the async-upkeep tolerance, so they count
    // as existing instead of blank: `u2` at invocation #1 (ts 1100, 100 ms after the assembly that selected it - the
    // runtime-context message that arrives in the same step as `u1`, which the tape payload carries but the graph
    // did not yet hold) and `r2` at invocation #3 (ts 3050, 50 ms after the assembly that selected it). The
    // tolerance is doing exactly what it is for, and this is the count it moves: 9 blank cells before the window
    // existed, 7 now.
    assertEqual(model.counts.absent, 7, 'not-yet-created cells');
    assertEqual(model.lagCells, 2, 'cells that exist only because of the bounded async-upkeep lag');
    assertEqual(model.maxLagMs, 100, 'the largest lag this fixture tolerates, in ms');
    assertEqual(model.counts.candidate, 5, 'candidate cells');
    assertEqual(model.counts.root, 3, 'walk-root cells');
    assertEqual(model.counts.existed, 20, 'existed-but-not-returned cells');
    assertEqual(model.counts.absent + model.counts.candidate + model.counts.root + model.counts.existed,
      model.columns.length * model.rows.length, 'the four states partition the matrix');
    say('state counts: absent 7, candidate 5, walk-root 3, existed 20 over 5x7 cells (2 by the async-lag window)');

    // (1b) the BFS layer every walked cell is shaded by, read from the recallTree's own nesting.
    // The taxonomy above is unchanged by it - `existed` and `absent` carry no layer at all - so these are
    // assertions about which of two walked cells is which shade, not about the four counts.
    assertEqual(model.columns[1].depths.get('u1'), 0, 'the walk root sits at layer 0, the anchor itself');
    assertEqual(model.columns[1].depths.get('u2'), 1, 'what the walk found one step out is layer 1');
    assertEqual(model.columns[1].depths.get('t1'), 1, 'and its sibling is layer 1 too, not layer 2');
    assertEqual(model.columns[1].deepestLayer, 1, 'the deepest layer of that walk is the one its own bfsDepth records');
    assertEqual(model.maxLayer, 1, 'the run-global ramp is sized by the deepest walk the run recorded');
    assertEqual(model.depthRamp.length, 2, 'so it has one shade per layer of that run, and not one per column');
    {
      const root = model.rows.find((r) => r.segment.id === 'u1').cells[1];
      const hit = model.rows.find((r) => r.segment.id === 'u2').cells[1];
      // A cell the walk did not return: `u1` exists by invocation #4 (ts 4000) but that walk started from
      // `r1`, so it is recorded as present-and-not-returned rather than as a hit at some depth.
      const dim = model.rows.find((r) => r.segment.id === 'u1').cells[3];
      const blank = model.rows.find((r) => r.segment.id === 'r1').cells[0];
      assertEqual(root.layer, 0, 'the walk-root cell records its layer');
      assertEqual(hit.layer, 1, 'the depth-1 candidate cell records its layer');
      assertEqual(dim.layer, -1, 'an existed-but-not-returned cell is not in the walk and has no layer');
      assertTrue(fillOf(root, model.depthRamp) !== fillOf(hit, model.depthRamp),
        'the walk root and a depth-1 hit are drawn in different shades');
      assertTrue(fillOf(hit, model.depthRamp) !== fillOf(dim, model.depthRamp),
        'a depth-1 hit and an existed-but-not-returned cell are told apart by shade');
      assertTrue(contrast(fillOf(hit, model.depthRamp), COLOUR.existed) >= 1.35,
        'the deepest shade of this run is still unmistakably stronger than "existed"');
      assertEqual(fillOf(dim, model.depthRamp), COLOUR.existed, '"existed" keeps the colour it has always had');
      assertEqual(fillOf(blank, model.depthRamp), COLOUR.absent,
        '"absent" keeps the colour it has always had');
    }
    say(`layer: root L0 ${model.depthRamp[0].colour}, depth-1 ${model.depthRamp[1].colour}, `
      + 'run-global over both layers; existed and absent untouched');

    // (1c) the same ramp has to mean the same layer in every column, or the columns cannot be compared -
    // which is the entire reason the shading is layered at all. Two columns with walks of different depth
    // are the case a per-column ramp would get wrong, so one is built here on purpose.
    {
      const dir = mkdtempSync(join(tmp, 'ramp-'));
      const fixture = buildFixture(dir, { deepTree: true });
      const deep = run({ run: fixture, cell: 'C9' });
      assertEqual(deep.model.maxLayer, 4, 'a five-layer walk sizes the run-global ramp');
      assertEqual(deep.model.depthRamp.length, 5, 'one shade per layer, not per column');
      assertEqual(deep.model.depthRamp[0].colour, COLOUR.candidate, 'layer 0 is the colour candidate has always had');
      assertEqual(deep.model.depthRamp[0].lightness, 50, 'and the darkest lightness of the ramp');
      // Monotone decay, measured rather than asserted about the code: relative luminance falls at every step.
      for (let k = 1; k < deep.model.depthRamp.length; k += 1) {
        const above = luminance(deep.model.depthRamp[k - 1].colour);
        const below = luminance(deep.model.depthRamp[k].colour);
        assertTrue(below > above, `layer ${k} (${deep.model.depthRamp[k].colour}) is weaker than layer ${k - 1} `
          + `(${deep.model.depthRamp[k - 1].colour})`);
      }
      assertTrue(contrast(deep.model.depthRamp[4].colour, COLOUR.existed) >= 1.35,
        `the deepest shade ${deep.model.depthRamp[4].colour} is still unmistakably stronger than "existed"`);
      assertTrue(contrast(deep.model.depthRamp[4].colour, COLOUR.absent) > contrast(deep.model.depthRamp[4].colour, COLOUR.existed),
        'and unmistakably stronger than "absent", which is the lighter of the two');
      // Run-global, not per column: the shallow columns of this same figure are drawn on the five-shade
      // scale, so a layer-1 hit is the SAME shade as a layer-1 hit in the deep column, not a paler one.
      const shallowFill = fillOf(deep.model.rows.find((r) => r.segment.id === 'u2').cells[1], deep.model.depthRamp);
      const deepFill = fillOf(deep.model.rows.find((r) => r.segment.id === 'u2').cells[4], deep.model.depthRamp);
      assertEqual(deepFill, shallowFill, 'a layer-1 hit is the same shade in a shallow and a deep column');
      assertEqual(deep.model.columns[4].record.bfsDepth, 4, 'and the deep column records the depth it really reached');
      assertTrue(deep.model.columns[0].record.bfsDepth < deep.model.maxLayer,
        'while a column that never walked past the anchor is said so rather than shaded as if it had');
      assertTrue(deep.svg.includes(deep.model.depthRamp[2].colour), 'the legend draws the shade layer 2 is filled with');
      assertTrue(deep.line.includes('run-global ramp sized for depth 4'), 'and the summary line names the scale it used');
      say(`ramp: 5 shades from one run-global depth (${deep.model.depthRamp.map((e) => e.colour).join(' → ')}), `
        + 'monotone, and identical across columns of different walk depth');
    }

    // (2) selection identity, and its absence, are both read rather than assumed
    assertEqual(model.identityColumns, 3, 'invocations whose delivered payload records the selected ids');
    assertEqual(model.identityRows, 3, 'rows ringed as recorded selections');
    assertEqual(model.counts.selectedPassage, 2, 'rows ringed as passage-only selections');
    assertEqual(model.selectedTotal, 0 + 1 + 1 + 2 + 2, 'recorded selected counts');
    assertEqual(model.countOnly, 2, 'selected segments with no recorded id');
    assertEqual(model.columns[2].selected.length, 1, 'the chunked selection is one provenance line');
    assertEqual(model.columns[2].selected[0].rows.length, 2, 'the passage resolves to both of its chunks');
    assertTrue(model.columns[2].selected[0].passage, 'the passage entry is flagged as passage-granularity');
    assertTrue(model.columns[4].selected === null, 'an invocation that delivered nothing records no ids');
    say('selected identity: recorded on 3/5 invocations, 2 passage-only rows, counts agree with the payloads');

    // (3) the same-step carry is the recorded correction it claims to be, and only that
    assertEqual(model.carryCells, 1, 'cells that exist only because the step\'s own payload carried them');
    assertTrue(model.columns[0].existed.has('u1'), 'the first invocation sees the segment its payload carried');
    // And the correction is scoped to the payload, not to the step: `u2` is in the same step and in the same window,
    // but it is the async-lag tolerance (100 ms), not the carry, that admits it. `carryIds` is the boundary.
    assertTrue(!model.columns[0].carryIds.includes('u2'), 'a segment the step did not carry is not a carry');
    assertTrue(model.columns[0].lagIds.includes('u2'), 'it is admitted by the bounded async-lag window instead');
    assertTrue(model.columns[0].strictIds.size === 0, 'and nothing in this fixture is strict at invocation #1');
    say('same-step carry: 1 cell, from the step payload record on the tape');

    // --- the figure itself -------------------------------------------------------------------
    assertTrue(out.svg.includes('data-chart="s1-activity"'), 'the SVG carries its classifier marker');
    assertTrue(!/<script/i.test(out.svg), 'the SVG contains no script');
    assertTrue(!/@font-face|@import|<image|href="https?:|src="https?:/.test(out.svg),
      'the SVG embeds no font and references no external resource (its only URL is the SVG namespace)');
    assertTrue(out.svg.includes('xmlns="http://www.w3.org/2000/svg"'), 'the xmlns is the only absolute URL it carries');
    assertTrue(out.svg.includes('w=1024 r=0.55 d=2'), 'the knobs are printed from the tape wiring record');
    assertTrue(out.svg.includes('not recorded — count only (2)'), 'a count without an id says so in the table');
    assertTrue(out.svg.includes('ids: recorded (2)'), 'a recorded identity says so above the matrix');
    assertTrue(out.svg.includes('ids: not recorded'), 'a count without an id says so above the matrix too');
    assertTrue(out.svg.includes('recency-window'), 'the recorded fallback flag is shown');
    assertTrue(out.svg.includes('>2048 *<'), 'a per-invocation window that differs from w is marked in the table');
    // The drawing mode is on the root element, so a reader (or a test) can tell an aggregated figure from an exact
    // one without guessing from the geometry.
    assertTrue(out.svg.includes('data-chart-mode="exact"'),
      'a matrix that fits the ceilings is drawn exactly, and says so on the root element');
    assertTrue(out.line.includes('drawing exact (5x7)'), 'and the summary line states the mode and the drawn size');

    // Geometry, read back out of the finished document rather than recomputed: every cell lies in
    // its row and column, cells do not overlap, and every band lies inside the document.
    const doc = out.svg;
    const docW = Number(/<svg[^>]*\swidth="(\d+)"/.exec(doc)[1]);
    const docH = Number(/<svg[^>]*\sheight="(\d+)"/.exec(doc)[1]);
    const cells = [...doc.matchAll(/<rect class="cell"([^>]*)\/>/g)].map((m) => {
      const attr = (name) => Number(new RegExp(`\\s${name}="(-?[\\d.]+)"`).exec(m[1])?.[1]);
      return {
        x: attr('x'), y: attr('y'), w: attr('width'), h: attr('height'),
        state: /\sdata-state="([a-z]+)"/.exec(m[1])?.[1] ?? '?',
      };
    });
    assertEqual(cells.length, model.columns.length * model.rows.length, 'one rect per matrix cell');
    assertTrue(cells.every((c) => c.x >= 0 && c.y >= 0 && c.x + c.w <= docW && c.y + c.h <= docH), 'every cell is inside the document');
    const stateTally = {};
    for (const c of cells) stateTally[c.state] = (stateTally[c.state] ?? 0) + 1;
    assertEqual(stateTally.absent ?? 0, 7, 'the drawn blank cells equal the derived count');
    assertEqual(stateTally.candidate ?? 0, 5, 'the drawn candidate cells equal the derived count');
    assertEqual(stateTally.root ?? 0, 3, 'the drawn walk-root cells equal the derived count');
    assertEqual(stateTally.existed ?? 0, 20, 'the drawn dim cells equal the derived count');
    assertEqual((doc.match(/class="ring"/g) ?? []).length, 5, 'one ring per recorded selected row');
    // The rings now carry a pale backing stroke so they keep their contrast over a layer-0 blue. That
    // backing is one mark drawn twice, not two marks: the count of rings is the count of recorded
    // selections, and a halo without a ring under it would be a mark encoding nothing.
    assertEqual((doc.match(/class="ring-halo"/g) ?? []).length, 5,
      'every ring has its contrast backing, and the backing is never drawn without a ring');
    {
      const geometry = (html) => /x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"/.exec(html)?.slice(1).join(' ');
      const ringGeometry = new Set([...doc.matchAll(/<rect class="ring"[^>]*\/>/g)].map((m) => geometry(m[0])));
      for (const m of doc.matchAll(/<rect class="ring-halo"[^>]*\/>/g)) {
        assertTrue(ringGeometry.has(geometry(m[0])), 'a ring is drawn under its backing, at the same place');
      }
    }
    // Every mark that stays on a walked cell keeps its ink legible against the layer's shade: the mark is
    // never removed or moved, and the one thing a layer may change is which of the two inks is drawn.
    for (const m of doc.matchAll(/class="cell-mark"[^>]*fill="(#\w{6})"/g)) {
      assertTrue(contrast(m[1], COLOUR.ink) >= 1.8 || contrast(m[1], COLOUR.paper) >= 1.8,
        `the hit mark on ${m[1]} has no readable ink`);
    }
    for (const m of doc.matchAll(/<path d="M [^"]+" fill="(#\w{6})" class="root-mark"/g)) {
      assertTrue(contrast(m[1], COLOUR.ink) >= 1.8 || contrast(m[1], COLOUR.paper) >= 1.8,
        `the root caret on ${m[1]} has no readable ink`);
    }
    assertTrue(doc.includes('data-state="root" data-layer="0"') && doc.includes('data-state="candidate" data-layer="1"'),
      'a walked cell states its BFS layer in the document, so the shading can be read back without the ramp');
    for (const m of doc.matchAll(/<g class="band"[^>]*transform="translate\(0,(-?[\d.]+)\)"/g)) {
      assertTrue(Number(m[1]) >= 0 && Number(m[1]) <= docH, `band offset ${m[1]} is inside the document`);
    }
    // The audit's own failure mode: a caption that runs off the page or out of its gutter. Widths are
    // estimated from each class's declared font size, which is what the class-based CSS carries.
    const sizes = new Map([...doc.matchAll(/\.([a-z-]+) \{ fill: [^;]+; font-size: ([\d.]+)px/g)].map((m) => [m[1], Number(m[2])]));
    const estimate = (text, cls) => [...text].length * (sizes.get(cls) ?? 11) * 0.56;
    for (const m of doc.matchAll(/<text x="([\d.]+)" y="[\d.]+" class="(panel-note|doc-sub|legend|source|table-cell|table-cell-ok|table-cell-warn)"[^>]*>([^<]*)</g)) {
      const width = Number(m[1]) + estimate(m[3], m[2]);
      assertTrue(width <= docW - 10, `a ${m[2]} caption runs off the page (${width.toFixed(0)} > ${docW}): ${m[3].slice(0, 60)}`);
    }
    for (const m of doc.matchAll(/<text x="([\d.]+)" y="[\d.]+" class="row-label" text-anchor="end">([^<]*)</g)) {
      const left = Number(m[1]) - estimate(m[2], 'row-label');
      assertTrue(left >= 10, `a row label runs off the left edge (left ${left.toFixed(0)}): ${m[2]}`);
    }
    say('figure: cells tile the matrix, rings match the recorded selections, no caption overflows');

    // --- aggregation: the same run, drawn as blocks -------------------------------------------
    //
    // The live case this exists for: cell C2 of round `20261002-2037` is 277 invocations x 1 398 segments, and drawn
    // exactly that is `width="1240" height="42957"` and 56.7 MB of `<rect>`. The claim to check is not that the
    // figure got smaller - it is that it got smaller **without changing what it says**: every state total is still
    // computed from the full matrix, and what a block adds is only "the strongest recorded fact in here".
    {
      const small = run({ run: runDir, cell: 'C9', grid: { maxCols: 3, maxRows: 3 } });
      assertTrue(small.svg.includes('data-chart-mode="aggregated"'), 'a matrix over the ceilings is drawn aggregated');
      assertTrue(small.svg.includes('AGGREGATED'), 'and the matrix panel says so where a reader will see it');
      assertTrue(small.line.includes('drawing aggregated'), 'and so does the summary line');
      assertTrue(small.line.includes('5x7 exact, drawn as 3x3 blocks'), 'naming the exact size it replaced');
      // Counts are the full matrix's, not the blocks': these are the same numbers the exact figure prints.
      assertEqual(small.model.counts.absent, model.counts.absent, 'aggregation does not change the derived blank count');
      assertEqual(small.model.counts.candidate, model.counts.candidate, 'nor the candidate count');
      assertEqual(small.model.counts.existed, model.counts.existed, 'nor the existed count');
      assertEqual(small.model.selectedTotal, model.selectedTotal, 'nor the recorded selection total');
      assertEqual(small.model.countOnly, model.countOnly, 'nor the count-without-id total');
      assertTrue(small.line.includes('not-created 7, candidate 5, walk-root 3, existed-not-returned 20'),
        'the summary line prints the same state counts as the exact figure');
      // What the roll-up costs, stated rather than hidden: a state can only be promoted, never erased, so no block
      // is blank unless every cell in it was - which is the one thing the aggregated figure can still say for
      // certain. The expected number of blank blocks is computed from the fixture's own matrix here, and then the
      // drawn blocks are checked against it.
      const layout = layoutOf(small.model, { maxCols: 3, maxRows: 3 });
      const rowSpans = [[0, 3], [3, 5], [5, 7]];
      const colSpans = [[0, 2], [2, 4], [4, 5]];
      let expectedBlankBlocks = 0;
      for (const [r0, r1] of rowSpans) {
        for (const [c0, c1] of colSpans) {
          let anyExisted = false;
          for (let r = r0; r < r1; r += 1) {
            for (let c = c0; c < c1; c += 1) if (model.rows[r].cells[c].state !== 'absent') anyExisted = true;
          }
          if (!anyExisted) expectedBlankBlocks += 1;
        }
      }
      assertEqual(layout.cells.flat().length, 9, 'nine blocks tile the aggregated matrix');
      assertTrue(layout.cells.flat().every((c) => c.col >= 1 && c.row >= 1), 'every block records how many cells it stands for');
      // A block carries the layer of the state that won it, and only that state has one: the layer of the
      // roll-up is not an average of the block, and a block of `existed`/`absent` cells has no layer.
      assertTrue(layout.cells.flat().every((c) => (c.state === 'candidate' || c.state === 'root'
        ? c.layer >= 0 && c.layer <= small.model.maxLayer
        : c.layer === -1)), 'a block carries a layer exactly when its state is a walked one, and within the ramp');
      // A block that holds hits of more than one depth is drawn at the most intense of them — never darker
      // than any cell it stands for — which is the roll-up's existing "the strongest recorded fact wins"
      // applied to the second axis of that fact rather than a second, contradictory rule.
      for (const [ri, rowSp] of rowSpans.entries()) {
        for (const [ci, colSp] of colSpans.entries()) {
          const inBlock = [];
          for (let r = rowSp[0]; r < rowSp[1]; r += 1) {
            for (let c = colSp[0]; c < colSp[1]; c += 1) {
              const cell = model.rows[r].cells[c];
              if (cell.state === 'candidate' || cell.state === 'root') inBlock.push(cell.layer);
            }
          }
          const drawn = layout.cells[ri][ci];
          if (inBlock.length === 0) {
            assertEqual(drawn.layer, -1, 'a block with no walked cell in it carries no layer');
          } else {
            assertEqual(drawn.layer, Math.min(...inBlock),
              `block ${ri},${ci} is drawn at the most intense layer it holds (of ${inBlock.join(', ')})`);
          }
        }
      }
      assertTrue(layout.cells.flat().some((c) => c.state !== 'absent' && c.layer === 0)
        && layout.cells.flat().some((c) => c.state !== 'absent' && c.layer === 1),
        'this fixture has blocks at two different layers, so the roll-up is exercised rather than trivially agreeing');
      assertEqual(layout.cells.flat().filter((c) => c.state === 'absent').length, expectedBlankBlocks,
        `a block is blank only when every cell in it was (${expectedBlankBlocks} of 9 here)`);
      assertTrue(layout.cells.flat().filter((c) => c.state !== 'absent').length >= model.counts.candidate + model.counts.root,
        'and every block that holds a hit or a walk root is drawn as one');
      const ringed = layout.cells.flat().filter((c) => c.overlay !== '');
      assertTrue(ringed.length > 0 && ringed.length <= layout.cells.flat().filter((c) => c.state !== 'absent').length,
        'a delivered selection is ringed on its block, and never on a block drawn blank');
      assertEqual(ringed.length, 4,
        'two selections in different invocations can share a column block, which is exactly what the roll-up hides: '
        + '5 rings exactly, 4 blocks ringed here');
      // The table below the matrix is the exact per-invocation record in both modes: aggregation is a drawing
      // decision, never a reporting one.
      assertTrue(small.svg.includes('>2048 *<'), 'the per-invocation table is still exact under aggregation');
      assertTrue(small.svg.includes('not recorded — count only (2)'), 'and still reports the count-only selection');
      say('aggregation: 5x7 -> 3x3 blocks, same state totals, the exact table kept below');
    }

    // --- the async-upkeep lag, inside and outside its window ----------------------------------
    {
      const dir = mkdtempSync(join(tmp, 'lag-'));
      const fixture = buildFixture(dir, { lagSelected: 200 });
      const lagged = run({ run: fixture, cell: 'C9' });
      assertTrue(lagged.model.lagCells >= 1, `the row stamped after its invocation is counted, got ${lagged.model.lagCells}`);
      assertTrue(lagged.model.columns[2].existed.has('P#1'),
        'a segment whose row is stamped 200 ms after the invocation still existed for it (inside the 250 ms window)');
      assertTrue(lagged.line.includes(`3 async-lag cell(s) within ${ASYNC_LAG_TOLERANCE_MS} ms (max 200 ms)`),
        'and the summary line states the lag it tolerated, and how large it was');
      assertTrue(lagged.model.columns[2].selected !== null, 'the selection that forced this window now draws');
      say('async-upkeep lag: a row 200 ms after its invocation draws and is counted, not silently tolerated');
    }

    // --- output format: SVG only, and a .png is refused ---------------------------------------
    {
      const dir = mkdtempSync(join(tmp, 'png-'));
      const fixture = buildFixture(dir);
      const code = main(['--run', fixture, '--cell', 'C9', '--out', join(dir, 's1-activity.png')]);
      assertEqual(code, 2, 'a .png output path is refused with a status, not written as an SVG under a PNG name');
      assertTrue(!existsSync(join(dir, 's1-activity.png')), 'and no file is left at that name');
      assertTrue(usage().includes('SVG only') && usage().includes('no PNG path'),
        'the usage text says plainly that the tool is SVG-only and why');
      say('output: SVG only; `--out *.png` exits 2 with the reason (no rasteriser dependency in this repository)');
    }

    // --- the summary line ---------------------------------------------------------------------
    assertTrue(out.line.startsWith('s1-activity: C9 @ round-fixture'), 'the summary names the cell and the run');
    assertTrue(out.line.includes('5 invocations x 7 segments (35 cells)'), 'the summary prints the dimensions');
    assertTrue(out.line.includes('not-created 7, candidate 5, walk-root 3, existed-not-returned 20'), 'the summary prints every state');
    assertTrue(out.line.includes('recall hits shaded by BFS layer on one run-global ramp sized for depth 1'),
      'and says the layer scale is run-global and how deep it was sized for');
    assertTrue(out.line.includes('ids recorded 3 on 3/5 invocations'), 'the summary prints the recorded-identity coverage');
    assertTrue(out.line.includes('2 passage-only row(s)'), 'the summary prints the passage-granularity rows');
    assertTrue(out.line.includes('count-only 2'), 'the summary prints how many selections have no id behind them');
    assertTrue(out.line.includes('1 same-step carry cell(s)'), 'the summary prints the boundary correction');
    say('summary line carries dimensions, every state, identity coverage and the carry count');

    // --- --explain says where each state came from -------------------------------------------
    const explained = explainLines(model).join('\n');
    assertTrue(explained.includes('carry: u1 (+10 ms)'), '--explain names the carried id and its stamp lag');
    assertTrue(explained.includes('count only (2), no id recorded'), '--explain distinguishes a count from an id');
    assertTrue(explained.includes('passage of 2 chunk(s)'), '--explain states the passage granularity');
    assertTrue(explained.includes('turn 2 step 1'), '--explain labels the column with its turn and step');
    assertTrue(explained.includes('u1=L0 → #2f6fd0'), '--explain states the BFS layer of each walked id, and the shade drawn');
    assertTrue(explained.includes('the run-global ramp is sized for depth 1'),
      'and says the scale the layer was read against');
    say('--explain reports the derivation behind every column (carry, walk, selection provenance)');

    // --- what must fail loudly ------------------------------------------------------------------
    const bad = (name, defects, match) => {
      const dir = mkdtempSync(join(tmp, 'defect-'));
      const fixture = buildFixture(dir, defects);
      const message = assertFails(() => run({ run: fixture, cell: 'C9' }), match, name);
      say(`${name} fails loudly: ${message.replace(tmp, '…').slice(0, 110)}…`);
    };
    bad('a selection that does not exist yet',
      { selectNotYetExisting: true },
      'a segment cannot be selected before it exists');
    bad('a candidate count that disagrees with the walk',
      { candidateCount: true },
      'the walk\'s id list and its count disagree');
    // **This case asserted the wrong rule from 2026-10-05, and the correction is the point of the note.** It made a
    // payload name *fewer* segments than were selected and required a refusal; with delta delivery that is the normal
    // case (`context-delivery.ts` suppresses what the model can already see), and refusing it made a finished round
    // undrawable. What is still impossible is the other direction, so that is what this checks.
    bad('a delivered payload naming more segments than the assembly selected',
      { selectedCountTooLow: true },
      'more was delivered than was selected');
    bad('a wiring record that is not on the tape',
      { noWiring: true },
      'the knobs are read from it rather than assumed');
    bad('a tape with no payload record for a step',
      { missingPayloadForStep: 3 },
      'has no matching step payload record');
    bad('wiring records that disagree about the knobs',
      { disagreeingWiring: true },
      'disagree about the recall knobs');
    bad('a snapshot of another session',
      { wrongSnapshotSession: true },
      'holds no snapshot of session');

    // --- the shapes a BFS layer cannot be read out of ----------------------------------------------------------------
    // Each of these is a walk whose record does not state a layer, or states one the tree contradicts.
    // The tool refuses the first three rather than drawing a shade at a guessed depth: a colour that means
    // "about this deep" is worse than no colour, because it reads as a measurement.
    bad('a walk root that is not an object',
      { treeShape: 'notAnObject' },
      'rather than the object that would hold its children');
    bad('a segment the walk reached at two different layers',
      { treeShape: 'idAtTwoLayers' },
      'did not record a tree');
    bad('two walk roots in one recallTree',
      { treeShape: 'twoRoots' },
      'this tool may guess');
    // The fourth is **not** refused any more, and that reversal is the fix rather than a loosening. `bfsDepth` is
    // set in the assembler's *selection* loop, so it is the deepest layer among the segments that were **placed**;
    // the tree is the deepest layer the walk **reached**. A walk that returns hits and places none parts them
    // legitimately - round `20261004-1458`'s assembly 1 did exactly that - so the shade is now read from the tree
    // and the divergence is counted and printed. What still has to hold is that the count is reported: a silent
    // disagreement would leave a reader comparing `bfsDepth` against a shade and finding no reason for the gap.
    {
      const dir = mkdtempSync(join(tmp, 'depthgap-'));
      const fixture = buildFixture(dir, { treeShape: 'depthMismatch' });
      const gap = run({ run: fixture, cell: 'C9' });
      assertEqual(gap.model.depthDivergences.length, 1,
        'the invocation whose recorded bfsDepth is not its tree depth is counted, not refused');
      assertEqual(gap.model.columns[1].record.bfsDepth, 1,
        'and the shade is read from the tree, so the column carries the depth it really walked');
      // The lines `--explain` prints, read from the same function that prints them. The self-test used to read a
      // `summaryLines` field off `run()`'s return value; that field does not exist (the return value is
      // `{ model, meta, svg, line }` and the explanation is built by `explainLines(model)`), so this assertion threw
      // a TypeError instead of checking anything - the self-test itself was broken, and the tool's own presence in
      // the suite is why that matters.
      const told = explainLines(gap.model).find((l) => l.includes('not the depth of the tree they walked'));
      assertTrue(told !== undefined, 'and the divergence is printed rather than left for a reader to notice');
    }
    // And the roll-up's one honest loss, which is a drawing cost and not a rule: a block that holds hits
    // of more than one depth is drawn at the most intense of them, so what a block cannot say is which of
    // its cells carried which depth. The exact figure below the matrix still can.
    {
      const dir = mkdtempSync(join(tmp, 'ramp-'));
      const fixture = buildFixture(dir, { deepTree: true });
      const rolled = run({ run: fixture, cell: 'C9', grid: { maxCols: 2, maxRows: 3 } });
      const rolledLayout = layoutOf(rolled.model, { maxCols: 2, maxRows: 3 });
      const deepCell = rolled.model.rows.find((r) => r.segment.id === 'r2').cells[4];
      assertEqual(deepCell.layer, 4, 'the exact matrix still carries every layer it read from the walk');
      assertTrue(rolledLayout.cells.flat().some((c) => c.layer === 0),
        'a rolled-up block can still be drawn at the walk root, where the run-global ramp is darkest');
      say('a rolled-up block shows one layer at a time: the most intense it holds, never darker than its own cells');
    }

    // --- the empty deliveries, and the line between them and an unattributable selection --------------------
    // Both sides are asserted, because the change that introduced the count could otherwise be read as having
    // loosened the refusal: an empty record owns no invocation, a record that carried a selection still must.
    {
      const dir = mkdtempSync(join(tmp, 'defect-'));
      const fixture = buildFixture(dir, { emptyDeliveryFarFromAssembly: true });
      const withEmpty = run({ run: fixture, cell: 'C9' });
      assertEqual(withEmpty.model.emptyDeliveries, 1, 'empty delivery records are counted');
      assertEqual(withEmpty.model.deliveriesTotal, 4, 'and the total they are counted against');
      assertEqual(withEmpty.model.columns.length, 5, 'an empty record adds no invocation');
      assertEqual(withEmpty.model.identityColumns, 3, 'and changes no selection identity');
      say('an empty delivery 895 000 ms past every assembly is counted, not refused (1 of 4, 5 invocations)');
    }
    bad('a delivered selection beyond the attribution window',
      { deliveredFarFromAssembly: true },
      'follows no assembly within');

    // The remaining two are file-level absences rather than record-level contradictions.
    {
      const dir = mkdtempSync(join(tmp, 'defect-'));
      const fixture = buildFixture(dir);
      rmSync(join(fixture, 'home', 'C9', '.s1cap', 'rg'), { recursive: true, force: true });
      assertFails(() => run({ run: fixture, cell: 'C9' }), 'missing the association-graph snapshot directory',
        'a missing snapshot is an error, never a blank matrix');
      say('a missing snapshot fails loudly (not an empty matrix)');
    }
    {
      const dir = mkdtempSync(join(tmp, 'defect-'));
      const fixture = buildFixture(dir);
      rmSync(join(fixture, 'home', 'C9', 'sessions'), { recursive: true, force: true });
      assertFails(() => run({ run: fixture, cell: 'C9' }), 'missing the cell\'s session store directory',
        'a missing session store is an error (columns must be labelled)');
      say('a missing session store fails loudly (a column needs a turn/step label)');
    }
    {
      const dir = mkdtempSync(join(tmp, 'defect-'));
      const fixture = buildFixture(dir);
      const controlPath = join(fixture, 'evidence', 'C9', 'control.jsonl');
      writeFileSync(controlPath, readFileSync(controlPath, 'utf8') + '{"type":"assembly","ts":\n', 'utf8');
      assertFails(() => run({ run: fixture, cell: 'C9' }), 'unparseable line',
        'a truncated control-plane line is an error, not a dropped column');
      say('a truncated control-plane line fails loudly (with the tool that locates it)');
    }

    {
      // A restarted cell writes the wiring record again. Identical records are one set of knobs and the
      // matrix still draws; the two real rounds of this project both carry two.
      const dir = mkdtempSync(join(tmp, 'defect-'));
      const fixture = buildFixture(dir, { duplicateWiring: true });
      const restarted = run({ run: fixture, cell: 'C9' });
      assertEqual(restarted.model.knobs.r, 0.55, 'two agreeing wiring records state one set of knobs');
      assertTrue(restarted.svg.includes('r=0.55'), 'and the annotation still names them');
      say('two agreeing wiring records (a restarted cell) still draw: agreement is what makes them one set');
    }

    // An SVG that carries someone else's marker is still not this chart: the classifier is decisive.
    assertTrue(!/<g class="panels"/.test(out.svg), 'the figure does not claim the metric-chart panel wrapper');
    say('the figure declares itself with data-chart="s1-activity" and no chart panel wrapper');

    process.stdout.write('s1-activity --self-test: PASS\n');
    return 0;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function main(argv) {
  if (argv.includes('--self-test')) return selfTest();
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const value = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const runDir = value('run');
  const cell = value('cell');
  if (runDir === undefined || cell === undefined) {
    process.stderr.write(`${usage()}\ns1-activity: --run and --cell are both required\n`);
    return 2;
  }
  const out = value('out') ?? join(resolve(runDir), 'report', 's1-activity.svg');
  // The one thing this tool will not do with the output path: pretend to write a raster. An `.svg` document under a
  // `.png` name is worse than a missing file - the caller's next step renders nothing and reports it as a figure.
  if (/\.png$/i.test(out)) {
    process.stderr.write(
      's1-activity: this tool writes SVG only, and `--out` ends in .png. There is no rasteriser in this repository: '
      + 'a PNG path needs a dependency (sharp, canvas, resvg) that this figure does not justify, and adding one to a '
      + 'script whose geometry is asserted as text is the kind of weight this project does not take. Write the SVG '
      + 'and convert it where the conversion belongs (a viewer, a document build), or name an .svg output.\n',
    );
    return 2;
  }
  const result = run({ run: runDir, cell, grid: parseGrid(value('grid')) });
  // `--out -` writes the SVG to stdout, so the summary goes to stderr there: a caller redirecting the
  // document into a file must get the document, and the sanity-check line must not land inside it.
  const say = out === '-' ? (line) => process.stderr.write(line) : (line) => process.stdout.write(line);
  if (argv.includes('--explain')) {
    say(`${explainLines(result.model).join('\n')}\n`);
  }
  if (out === '-') {
    process.stdout.write(result.svg);
  } else {
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(resolve(out), result.svg, 'utf8');
  }
  say(`${result.line}${out === '-' ? '' : ` · wrote ${resolve(out)}`}\n`);
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  if (err?.isActivityError) {
    process.stderr.write(`s1-activity: ${err.message}\n`);
    process.exitCode = 1;
  } else {
    throw err;
  }
}
