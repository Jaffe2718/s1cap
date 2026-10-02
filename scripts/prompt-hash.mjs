#!/usr/bin/env node
/**
 * The machinery for the prompt rule: read the stimulus from its source, paste it, never retype it, and record
 * and verify what was actually delivered.
 *
 * ## The rule, and the gap this file closes
 *
 * `docs/CELLS-RUN.md` ("One fixed prompt, sent as recorded") and the handover require the delivered stimulus to
 * be read from a source file, pasted rather than retyped, and hash-verified, and the three cells' delivered
 * texts to be shown byte-identical. Until this file there was no machinery for any of it: nothing in `scripts/`
 * hashed a prompt, and the one round that did verify a prompt (20261002-2037) did it by hand — its own report
 * says so ("**No prompt hash is recorded in `tokens.json` or `task.json`**"). A rule whose only implementation
 * is a person remembering is the defect class this repository has been removing all session.
 *
 * ## The convention, matched rather than invented
 *
 * The one recorded prompt hash in this tree is round 20261002-2037's `ROUND-REPORT.md`, and this tool prints the
 * same form: **the full 64-hex lowercase SHA-256 of the file's bytes, beside the byte length.** That report
 * records the source as `fbdf4b546b4edc0337c63b346ae8a64ae7bc0111cc4d64ed0f3ea4770afead98` at 4,102 bytes and
 * the delivered text as `65db8ffc24d8f289af4fe2d410d8a68e4073c8e02fc7783694ba9efc74850037` at 4,101 bytes.
 * Both are reproduced by this tool against those files, which is what "comparable" has to mean.
 *
 * What is deliberately *not* copied is the other digest in this tree: `build-route-svg.mjs` and
 * `check-diagram.mjs` stamp a generated SVG with a 16-hex prefix (`source sha256:8d419a9580b38545`). That is a
 * generator banner for a build product, not a prompt hash, and a truncated digest would make an old round
 * record and a new one unequal as strings. Digest once, print it whole.
 *
 * ## The three readings, and why the middle one is not "different"
 *
 *   IDENTICAL                                the two byte sequences are equal;
 *   IDENTICAL TEXT (final line ending only)  equal apart from one final LF/CRLF. The recorded round delivered
 *                                            4,102 bytes as 4,101 with the trailing newline trimmed, and a
 *                                            checker that files that under "different" is a checker that gets
 *                                            switched off. It is its own state, both endings are printed, and
 *                                            it exits 0 — while never claiming byte-identity;
 *   DIFFERENT                                everything else, with the first differing byte offset (0-based),
 *                                            both byte values, both lengths and a preview of the neighbourhood.
 *
 * The middle state is granted only for the *final* line ending, and for one of them only: `"abc\n\n"` against
 * `"abc\n"` is DIFFERENT, and `--self-test` asserts that, because a checker that quietly forgives a blank line
 * is worse than one that reports a trimmed newline as a mismatch.
 *
 * ## Where the delivered text is read from
 *
 * A file, `-` for stdin, or `@session:<path>`: the first `kind:"user"`, `role:"user"` record's `text` in a DSH
 * session store — the record round 20261002-2037 names as the delivered text
 * (`evidence/{C0,C1,C2}/session.jsonl`). The session form exists because that is where a round's delivered text
 * actually lives; without it the operator is back to transcribing it by hand, which is the defect. The reader
 * refuses loudly (exit 2, printing the `kind`/`role` shapes it saw) rather than guessing when no such record
 * exists.
 *
 * USAGE
 *   node scripts/prompt-hash.mjs hash   <source>
 *   node scripts/prompt-hash.mjs verify <source> <delivered>
 *   node scripts/prompt-hash.mjs cells  <name>=<text> <name>=<text> [<name>=<text> ...] [--source <source>]
 *   node scripts/prompt-hash.mjs --self-test
 *
 * The usage text below spells the three commands a round runs against a round's own paths.
 *
 * EXIT CODES (the convention of every other tool in scripts/)
 *   0 clean · 1 a byte differs, or the delivered texts do not agree · 2 usage error or an unreadable input
 *
 * READ-ONLY. It opens files for reading and writes nothing outside a system temp directory during
 * `--self-test`, which removes what it wrote.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOOL = 'prompt-hash';
export const VERSION = 1;

/** The empty-input SHA-256, so a broken digest path cannot pass as "some 64 characters". */
const SHA256_EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const USAGE = `usage: node scripts/prompt-hash.mjs hash   <source>
       node scripts/prompt-hash.mjs verify <source> <delivered>
       node scripts/prompt-hash.mjs cells  <name>=<text> <name>=<text> [<name>=<text> ...] [--source <source>]
       node scripts/prompt-hash.mjs --self-test

The prompt rule of docs/CELLS-RUN.md, made checkable: hash the stimulus at its source, hash what the cell was
given, and read the cells' hashes off one line instead of asserting they agree.

where a text is read from
  <path>            a file, read as bytes
  -                 standard input, read as bytes
  @session:<path>   the first \`kind:"user"\`, \`role:"user"\` record's \`text\` in a DSH session store, which
                    is where a round's delivered text actually lives

what the verdicts mean
  IDENTICAL                                  the two byte sequences are equal
  IDENTICAL TEXT (final line ending only)    equal apart from one final LF/CRLF. The source's 4,102 bytes
                                             delivered as 4,101 with the trailing newline trimmed (round
                                             20261002-2037) is this case, and it is not a difference
  DIFFERENT                                  the first differing byte offset and both lengths are printed

options
  --source <text>    in \`cells\`: compare every cell against the source prompt as well
  --json             print one JSON record instead of the report; its \`line\` is the summary line verbatim
  --quiet            print only the summary line
  -h, --help         this text
  --self-test        run the fixtures (identical, one byte off, trailing line ending only, three-way
                     identical, three-way with one cell off, a two-newline difference, unreadable input) and
                     exit 0 only if every one behaves as declared

exit codes: 0 clean · 1 a byte differs, or the delivered texts do not agree · 2 usage error or an unreadable
input

the three commands a round runs, against the round's own paths
  node scripts/prompt-hash.mjs hash   <round>/prompt.txt
  node scripts/prompt-hash.mjs verify <round>/prompt.txt @session:<run>/evidence/<cell>/session.jsonl
  node scripts/prompt-hash.mjs cells  C0=@session:<run>/evidence/C0/session.jsonl \\
                                      C1=@session:<run>/evidence/C1/session.jsonl \\
                                      C2=@session:<run>/evidence/C2/session.jsonl --source <round>/prompt.txt`;

// ---------------------------------------------------------------------------------------------
// 1. The primitives: hash, final line ending, byte comparison
// ---------------------------------------------------------------------------------------------

/** The full 64-hex lowercase SHA-256 of these bytes — the form the recorded rounds print. */
export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

const LF = 0x0a;
const CR = 0x0d;

/** These bytes with one final line ending removed (`\r\n` first, then `\n`). One, and only at the end. */
export function stripFinalLineEnding(bytes) {
  if (bytes.length >= 2 && bytes[bytes.length - 2] === CR && bytes[bytes.length - 1] === LF) {
    return bytes.subarray(0, bytes.length - 2);
  }
  if (bytes.length >= 1 && bytes[bytes.length - 1] === LF) {
    return bytes.subarray(0, bytes.length - 1);
  }
  return bytes;
}

/** The final line ending, named for a report: `LF`, `CRLF` or `none`. */
export function finalLineEnding(bytes) {
  if (bytes.length >= 2 && bytes[bytes.length - 2] === CR && bytes[bytes.length - 1] === LF) return 'CRLF';
  if (bytes.length >= 1 && bytes[bytes.length - 1] === LF) return 'LF';
  return 'none';
}

/** How a line ending is written in a report, so `none` cannot be read as an empty character. */
export function endingText(name) {
  if (name === 'LF') return 'LF ("\\n")';
  if (name === 'CRLF') return 'CRLF ("\\r\\n")';
  return 'none';
}

const CONTEXT = 24;

/** A short utf8 preview of the bytes around `offset`; a cut multi-byte character shows as U+FFFD, honestly. */
function preview(bytes, offset) {
  const from = Math.max(0, offset - CONTEXT);
  const to = Math.min(bytes.length, offset + CONTEXT);
  return JSON.stringify(bytes.subarray(from, to).toString('utf8'));
}

/** A byte as it is printed: its value always, its character when it has one. */
function byteText(value) {
  if (value === null) return 'end of input';
  return `0x${value.toString(16).padStart(2, '0')} ${JSON.stringify(String.fromCharCode(value))}`;
}

/**
 * The comparison this whole tool exists for. Returns one of three verdicts:
 *
 *   { verdict: 'identical', ok: true }
 *   { verdict: 'identical-except-final-line-ending', ok: true, lineEnding: { source, delivered } }
 *   { verdict: 'different', ok: false, firstDifference: { offset, sourceByte, deliveredByte, ... } }
 *
 * `firstDifference.offset` is 0-based, and equal to the shorter input's length when one is a prefix of the
 * other (`sourceByte`/`deliveredByte` is then `null` on the side that ended).
 */
export function compareBytes(source, delivered) {
  const lengths = { sourceBytes: source.length, deliveredBytes: delivered.length };
  const lineEnding = { source: finalLineEnding(source), delivered: finalLineEnding(delivered) };
  if (source.equals(delivered)) return { verdict: 'identical', ok: true, ...lengths, lineEnding };
  if (stripFinalLineEnding(source).equals(stripFinalLineEnding(delivered))) {
    return { verdict: 'identical-except-final-line-ending', ok: true, ...lengths, lineEnding };
  }
  const shortest = Math.min(source.length, delivered.length);
  let offset = 0;
  while (offset < shortest && source[offset] === delivered[offset]) offset += 1;
  return {
    verdict: 'different',
    ok: false,
    ...lengths,
    lineEnding,
    firstDifference: {
      offset,
      sourceByte: offset < source.length ? source[offset] : null,
      deliveredByte: offset < delivered.length ? delivered[offset] : null,
      sourcePreview: preview(source, offset),
      deliveredPreview: preview(delivered, offset),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// 2. Reading a text: a file, stdin, or a cell's session store
// ---------------------------------------------------------------------------------------------

/** A usage error is exit 2: bad arguments, or an input that cannot be read or recognized. */
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.isUsageError = true;
  }
}

const slash = (value) => String(value).replace(/\\/g, '/');

const readFailure = (what, err) => new UsageError(
  `cannot read ${what}: ${err && err.code === 'ENOENT' ? 'no such file' : err && err.message ? err.message : String(err)}`,
);

/**
 * The delivered text of a cell, from its DSH session store: the first record that is both `kind:"user"` and
 * `role:"user"` and carries a string `text`. That is the record round 20261002-2037 names, and re-encoding it
 * reproduces that round's `65db8ffc…` at 4,101 bytes for all three cells. No fallback is attempted: a store
 * whose shape has changed must fail loudly here, not hand back the wrong message's hash.
 */
export function readSessionPrompt(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw readFailure(`session store ${slash(path)}`, err);
  }
  const shapes = new Map();
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      shapes.set('unparsable-line', (shapes.get('unparsable-line') ?? 0) + 1);
      continue;
    }
    const shape = `${record.kind ?? '?'}/${record.role ?? '?'}`;
    shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
    if (record.kind === 'user' && record.role === 'user' && typeof record.text === 'string') {
      return Buffer.from(record.text, 'utf8');
    }
  }
  const seen = [...shapes].map(([shape, count]) => `${shape} x${count}`).join(', ') || 'no records';
  throw new UsageError(
    `${slash(path)}: no record with kind "user", role "user" and a text field — saw ${seen}. The delivered text is the first such record of a cell's session store; pass the text itself as a file, or on stdin, if the store's shape has changed`,
  );
}

/** Resolve a text spec into `{ spec, label, path, bytes }`. Throws `UsageError` (exit 2) when it cannot. */
export function loadText(spec, io) {
  if (spec === '-') {
    let bytes;
    try {
      bytes = io.readStdin();
    } catch (err) {
      throw new UsageError(`cannot read stdin: ${err && err.message ? err.message : String(err)} (a "-" input needs a pipe or a redirect)`);
    }
    return { spec, label: 'stdin', path: null, bytes };
  }
  if (spec.startsWith('@session:')) {
    const path = spec.slice('@session:'.length);
    if (path === '') throw new UsageError('@session: needs a path');
    return { spec, label: `session:${slash(path)}`, path, bytes: readSessionPrompt(path) };
  }
  try {
    return { spec, label: slash(spec), path: spec, bytes: readFileSync(spec) };
  } catch (err) {
    throw readFailure(slash(spec), err);
  }
}

function inputRecord(input) {
  return { spec: input.spec, label: input.label, path: input.path, bytes: input.bytes.length, sha256: sha256Hex(input.bytes) };
}

// ---------------------------------------------------------------------------------------------
// 3. Rendering: one line per input, then exactly one summary line
// ---------------------------------------------------------------------------------------------

const hashAndBytes = (input) => `${input.bytes.length} bytes, sha256 ${sha256Hex(input.bytes)}`;

function inputLine(role, input) {
  return `${role.padEnd(10)} ${input.label} — ${hashAndBytes(input)}`;
}

/** The finding itself, phrased once so the detail line and the summary line cannot drift apart. */
function firstDifferenceText(first) {
  const offset = `byte ${first.offset} (0-based)`;
  if (first.sourceByte === null) {
    return `${offset}: the source ends there (${first.offset} bytes) and the delivered text continues with ${byteText(first.deliveredByte)}`;
  }
  if (first.deliveredByte === null) {
    return `${offset}: the delivered text ends there (${first.offset} bytes) and the source continues with ${byteText(first.sourceByte)}`;
  }
  return `${offset}: source ${byteText(first.sourceByte)} vs delivered ${byteText(first.deliveredByte)}`;
}

function lineEndingText(lineEnding) {
  const { source, delivered } = lineEnding;
  const change = source !== 'none' && delivered === 'none' ? 'removed from the delivery'
    : source === 'none' && delivered !== 'none' ? 'added by the delivery'
      : 'changed by the delivery';
  return `line ending: source ${endingText(source)}, delivered ${endingText(delivered)} — the final line ending was ${change}; no other byte differs`;
}

function verifyLine(source, delivered, cmp) {
  if (cmp.verdict === 'identical') {
    return `${TOOL} verify: IDENTICAL — ${hashAndBytes(source)}, from ${source.label} and ${delivered.label}`;
  }
  if (cmp.verdict === 'identical-except-final-line-ending') {
    return `${TOOL} verify: IDENTICAL TEXT, final line ending only — source ${source.label} ${hashAndBytes(source)} ends with ${endingText(cmp.lineEnding.source)}, delivered ${delivered.label} ${hashAndBytes(delivered)} ends with ${endingText(cmp.lineEnding.delivered)}; no other byte differs`;
  }
  return `${TOOL} verify: DIFFERENT — ${firstDifferenceText(cmp.firstDifference)}; source ${source.label} ${hashAndBytes(source)}, delivered ${delivered.label} ${hashAndBytes(delivered)}`;
}

const cellLine = (cell) => `${cell.label.padEnd(8)} ${hashAndBytes(cell)} — ${slash(cell.spec)}`;

/** Group cells by their digest, largest group first, ties broken by the order the cells were given. */
export function groupCells(cells) {
  const groups = [];
  for (const cell of cells) {
    const sha256 = sha256Hex(cell.bytes);
    let group = groups.find((candidate) => candidate.sha256 === sha256);
    if (group === undefined) {
      group = { sha256, bytes: cell.bytes.length, cells: [] };
      groups.push(group);
    }
    group.cells.push(cell);
  }
  return groups.sort((a, b) => b.cells.length - a.cells.length || cells.indexOf(a.cells[0]) - cells.indexOf(b.cells[0]));
}

/**
 * The one line that answers "did the same prompt go to all three cells": when they agree, every cell under its
 * own name with its own hash; when they do not, the cells grouped by the hash they share, with the group that
 * broke away named first and the offset at which it broke away.
 */
function cellsLine(cells, groups, source, sourceCmp) {
  let line;
  if (groups.length === 1) {
    const shared = groups[0];
    const each = cells.map((cell) => `${cell.label} sha256 ${sha256Hex(cell.bytes)}`).join(' · ');
    line = `${TOOL} cells: all ${cells.length} delivered texts are byte-identical — ${shared.bytes} bytes, sha256 ${shared.sha256} · ${each}`;
  } else {
    const named = (group) => `${group.cells.map((cell) => cell.label).join(', ')} (${group.bytes} bytes, sha256 ${group.sha256})`;
    const differing = groups.slice(1);
    const against = groups[0].cells[0];
    const offsets = differing.map((group) => {
      const first = group.cells[0];
      const cmp = compareBytes(against.bytes, first.bytes);
      const at = cmp.firstDifference === undefined ? 'no byte differs' : `first differs at ${firstDifferenceText(cmp.firstDifference)}`;
      return `${first.label} vs ${against.label} ${at}`;
    });
    line = `${TOOL} cells: NOT byte-identical — differing: ${differing.map(named).join(' · ')} · agreeing: ${named(groups[0])}; ${offsets.join('; ')}`;
  }
  if (source !== null && sourceCmp !== undefined) {
    const endings = sourceCmp.verdict === 'identical-except-final-line-ending'
      ? ` (source ${endingText(sourceCmp.lineEnding.source)}, delivered ${endingText(sourceCmp.lineEnding.delivered)})`
      : '';
    const verdict = sourceCmp.verdict === 'identical' ? 'IDENTICAL'
      : sourceCmp.verdict === 'identical-except-final-line-ending' ? 'IDENTICAL TEXT, final line ending only'
        : `DIFFERENT — ${firstDifferenceText(sourceCmp.firstDifference)}`;
    line += ` · vs source ${source.label} (${source.bytes.length} bytes): ${verdict}${endings}`;
  }
  return line;
}

const commandLine = (argv) => [TOOL, ...argv].join(' ');

function emit(flags, record, lines) {
  if (flags.json) return { code: record.ok ? 0 : 1, out: `${JSON.stringify(record, null, 2)}\n`, err: '' };
  const out = [...(flags.quiet ? [] : lines), record.line];
  return { code: record.ok ? 0 : 1, out: `${out.join('\n')}\n`, err: '' };
}

// ---------------------------------------------------------------------------------------------
// 4. The three modes
// ---------------------------------------------------------------------------------------------

function runHash(spec, flags, io) {
  const source = loadText(spec, io);
  const line = `${TOOL} hash: ${source.label} — ${hashAndBytes(source)}`;
  const record = {
    tool: TOOL,
    version: VERSION,
    mode: 'hash',
    command: commandLine(['hash', spec]),
    ok: true,
    verdict: 'hashed',
    source: inputRecord(source),
    line,
  };
  return emit(flags, record, []);
}

function runVerify(sourceSpec, deliveredSpec, flags, io) {
  const source = loadText(sourceSpec, io);
  const delivered = loadText(deliveredSpec, io);
  const cmp = compareBytes(source.bytes, delivered.bytes);
  const line = verifyLine(source, delivered, cmp);
  const record = {
    tool: TOOL,
    version: VERSION,
    mode: 'verify',
    command: commandLine(['verify', sourceSpec, deliveredSpec]),
    ok: cmp.ok,
    verdict: cmp.verdict,
    source: inputRecord(source),
    delivered: inputRecord(delivered),
    lengthDelta: delivered.bytes.length - source.bytes.length,
    lineEnding: cmp.lineEnding,
    ...(cmp.firstDifference === undefined ? {} : { firstDifference: cmp.firstDifference }),
    line,
  };
  const lines = [inputLine('source', source), inputLine('delivered', delivered)];
  if (cmp.verdict === 'identical-except-final-line-ending') lines.push(lineEndingText(cmp.lineEnding));
  if (cmp.firstDifference !== undefined) {
    lines.push(`first difference: ${firstDifferenceText(cmp.firstDifference)}`);
    lines.push(`around it: source ${cmp.firstDifference.sourcePreview}, delivered ${cmp.firstDifference.deliveredPreview}`);
  }
  return emit(flags, record, lines);
}

function runCells(cells, sourceSpec, flags, io) {
  const loaded = cells.map((cell) => ({ ...loadText(cell.spec, io), label: cell.label }));
  const groups = groupCells(loaded);
  const source = sourceSpec === null ? null : loadText(sourceSpec, io);
  const sourceCmp = source === null ? undefined : compareBytes(source.bytes, groups[0].cells[0].bytes);
  const ok = groups.length === 1 && (sourceCmp === undefined || sourceCmp.ok);
  const line = cellsLine(loaded, groups, source, sourceCmp);
  const record = {
    tool: TOOL,
    version: VERSION,
    mode: 'cells',
    command: commandLine(flags.raw),
    ok,
    verdict: groups.length === 1 ? 'all-identical' : 'not-all-identical',
    cells: loaded.map(inputRecord),
    identical: groups.length === 1,
    groups: groups.map((group) => ({ cells: group.cells.map((cell) => cell.label), bytes: group.bytes, sha256: group.sha256 })),
    outliers: groups.slice(1).flatMap((group) => group.cells.map((cell) => cell.label)),
    source: source === null ? null : inputRecord(source),
    sourceVerdict: sourceCmp === undefined ? null : sourceCmp.verdict,
    sourceFirstDifference: sourceCmp === undefined || sourceCmp.firstDifference === undefined ? null : sourceCmp.firstDifference,
    line,
  };
  const lines = loaded.map(cellLine);
  if (source !== null) lines.push(inputLine('source', source));
  for (const group of groups.slice(1)) {
    const first = group.cells[0];
    const against = groups[0].cells[0];
    const cmp = compareBytes(against.bytes, first.bytes);
    lines.push(`${first.label} vs ${against.label}: ${cmp.firstDifference === undefined ? 'no byte differs' : firstDifferenceText(cmp.firstDifference)}`);
  }
  if (sourceCmp !== undefined && sourceCmp.verdict === 'identical-except-final-line-ending') {
    lines.push(`source vs ${groups[0].cells[0].label}: ${lineEndingText(sourceCmp.lineEnding)}`);
  }
  return emit(flags, record, lines);
}

// ---------------------------------------------------------------------------------------------
// 5. The self-test: fixtures that fail loudly, including the ones that must NOT pass
// ---------------------------------------------------------------------------------------------

/**
 * Every fixture is asserted through `main()`, so what is checked is the exit code and the summary line a round
 * would actually see, not a helper's return value. Each case also asserts that the *wrong* verdict is absent:
 * a self-test that only ever passes cannot tell a working comparison from one that always says IDENTICAL.
 */
export function selfTest({ quiet = false } = {}) {
  const lines = [];
  const problems = [];
  let checks = 0;
  const say = (text) => { lines.push(text); };
  const ok = (what, condition) => {
    checks += 1;
    if (!condition) problems.push(what);
  };
  const lastLine = (out) => out.trimEnd().split('\n').at(-1);

  const SOURCE = 'alpha\nbeta\ngamma\n';
  const OFFSET = SOURCE.indexOf('beta'); // 6: where the one-byte fixture differs
  const ONE_BYTE = `${SOURCE.slice(0, OFFSET)}B${SOURCE.slice(OFFSET + 1)}`;
  // The three cells are given the delivered form of the source — its text without the final newline — so the
  // fixture reproduces the recorded round exactly: a source of N bytes delivered as N-1.
  const TRIMMED = 'alpha\nbeta\ngamma';
  const CELL_ODD = `${TRIMMED.slice(0, OFFSET)}X${TRIMMED.slice(OFFSET + 1)}`;
  const SHORT = 'alpha\nbe'; // a differing length with no shared prefix problem
  const SOURCE_BYTES = Buffer.byteLength(SOURCE);
  const sha = sha256Hex(Buffer.from(SOURCE, 'utf8'));
  const shaDelivered = sha256Hex(Buffer.from(TRIMMED, 'utf8'));

  const dir = mkdtempSync(join(tmpdir(), 'prompt-hash-'));
  const path = (name) => join(dir, name);
  const write = (name, text) => {
    writeFileSync(path(name), text, 'utf8');
    return path(name);
  };
  try {
    const src = write('source.txt', SOURCE);
    const same = write('same.txt', SOURCE);
    const oneByte = write('one-byte.txt', ONE_BYTE);
    const trimmed = write('trimmed.txt', TRIMMED);
    const short = write('short.txt', SHORT);
    const cellA = write('cell-a.txt', TRIMMED);
    const cellB = write('cell-b.txt', TRIMMED);
    const cellC = write('cell-c.txt', TRIMMED);
    const cellOdd = write('cell-odd.txt', CELL_ODD);
    const sessionStore = write('session.jsonl', `${JSON.stringify({ kind: 'trace', role: 'assistant', text: 'not the prompt' })}\n${JSON.stringify({ kind: 'user', role: 'user', text: TRIMMED })}\n`);
    const wrongStore = write('wrong-shape.jsonl', `${JSON.stringify({ kind: 'assistant', role: 'assistant', text: 'x' })}\n`);
    const stdin = { readStdin: () => Buffer.from(TRIMMED, 'utf8') };
    const run = (argv, io) => main(argv, io);

    // 1. the source hash: path, byte length, full digest.
    const hash = run(['hash', src]);
    ok('hash: exit 0', hash.code === 0);
    ok('hash: the summary line carries the path, the byte length and the full 64-hex digest',
      new RegExp(`^${TOOL} hash: .*source\\.txt — ${SOURCE_BYTES} bytes, sha256 [0-9a-f]{64}$`).test(hash.out.trim()));
    ok('hash: the digest is the digest of those bytes', hash.out.includes(sha));
    say(`hash: ${hash.out.trim()}`);

    const identical = run(['verify', src, same]);
    ok('identical: exit 0', identical.code === 0);
    ok('identical: the summary line says IDENTICAL', lastLine(identical.out).startsWith(`${TOOL} verify: IDENTICAL — `));
    ok('identical: and never says DIFFERENT', !identical.out.includes('DIFFERENT'));
    say(`identical: ${lastLine(identical.out)}`);

    // 2. a one-byte difference names the offset, in the summary line and as its own finding.
    const one = run(['verify', src, oneByte]);
    ok('one byte: exit 1', one.code === 1);
    ok('one byte: the summary line says DIFFERENT', lastLine(one.out).startsWith(`${TOOL} verify: DIFFERENT — `));
    ok(`one byte: the first differing offset is named as byte ${OFFSET} (0-based)`, one.out.includes(`byte ${OFFSET} (0-based)`));
    ok('one byte: both byte values are named', one.out.includes('0x42 "B"') && one.out.includes('0x62 "b"'));
    ok('one byte: no verdict claims identity', !one.out.includes('IDENTICAL'));
    ok('one byte: both lengths are printed', one.out.includes(`${SOURCE_BYTES} bytes, sha256`) && one.out.includes(`${Buffer.byteLength(ONE_BYTE)} bytes, sha256`));
    say(`one byte: ${lastLine(one.out)}`);

    // 2b. differing lengths with no shared ending: both lengths and the offset are the reading.
    const shorter = run(['verify', src, short]);
    ok('shorter delivered: exit 1', shorter.code === 1);
    ok('shorter delivered: the offset is the end of the shorter side', shorter.out.includes(`byte ${Buffer.byteLength(SHORT)} (0-based): the delivered text ends there`));
    ok('shorter delivered: both lengths are printed', shorter.out.includes(`${SOURCE_BYTES} bytes, sha256`) && shorter.out.includes(`${Buffer.byteLength(SHORT)} bytes, sha256`));
    say(`shorter delivered: ${lastLine(shorter.out)}`);

    // 3. a trailing-newline-only difference is the line-ending case, and is not called different.
    const trim = run(['verify', src, trimmed]);
    ok('trailing newline: exit 0', trim.code === 0);
    ok('trailing newline: the summary line says IDENTICAL TEXT, final line ending only', lastLine(trim.out).startsWith(`${TOOL} verify: IDENTICAL TEXT, final line ending only — `));
    ok('trailing newline: the word DIFFERENT does not appear anywhere in the report', !trim.out.includes('DIFFERENT'));
    ok('trailing newline: both endings are named', trim.out.includes('LF ("\\n")') && trim.out.includes('none'));
    ok('trailing newline: the detail line says no other byte differs', trim.out.includes('no other byte differs'));
    ok('trailing newline: the length difference is still visible in the hashes and the counts', trim.out.includes(`${SOURCE_BYTES} bytes, sha256 ${sha}`) && trim.out.includes(`${Buffer.byteLength(TRIMMED)} bytes, sha256`));
    say(`trailing newline: ${lastLine(trim.out)}`);

    // 3b. the state is exactly one final line ending, and only that. A blank line is a difference.
    const blankLine = run(['verify', write('blank-a.txt', 'abc\n\n'), write('blank-b.txt', 'abc\n')]);
    ok('two newlines vs one: exit 1', blankLine.code === 1);
    ok('two newlines vs one: DIFFERENT, not the line-ending state', lastLine(blankLine.out).startsWith(`${TOOL} verify: DIFFERENT — `));
    say(`one extra blank line: ${lastLine(blankLine.out)}`);
    const added = run(['verify', write('added-a.txt', 'abc'), write('added-b.txt', 'abc\n')]);
    ok('a newline the source lacks: the line-ending state, and it says the ending was added',
      added.code === 0 && lastLine(added.out).includes('final line ending only') && added.out.includes('added by the delivery'));
    const crlf = run(['verify', write('crlf-a.txt', 'abc\r\n'), write('crlf-b.txt', 'abc\n')]);
    ok('CRLF delivered as LF: the line-ending state names both endings',
      crlf.code === 0 && lastLine(crlf.out).includes('CRLF ("\\r\\n")') && lastLine(crlf.out).includes('LF ("\\n")'));

    // 4. three-way identical: one line, every cell's hash.
    const threeSame = run(['cells', `C0=${cellA}`, `C1=${cellB}`, `C2=${cellC}`]);
    ok('three identical: exit 0', threeSame.code === 0);
    ok('three identical: the summary line says all three are byte-identical', lastLine(threeSame.out).includes('all 3 delivered texts are byte-identical'));
    ok('three identical: every cell is named with its own hash', ['C0', 'C1', 'C2'].every((label) => lastLine(threeSame.out).includes(`${label} sha256 ${shaDelivered}`)));
    ok('three identical: one summary line, not one per cell', lastLine(threeSame.out).startsWith(`${TOOL} cells: `));
    say(`three identical: ${lastLine(threeSame.out)}`);

    // 5. three-way with one different: names which one, and never claims agreement.
    const oneOdd = run(['cells', `C0=${cellA}`, `C1=${cellOdd}`, `C2=${cellC}`]);
    ok('one cell off: exit 1', oneOdd.code === 1);
    ok('one cell off: the summary line says NOT byte-identical', lastLine(oneOdd.out).includes('NOT byte-identical'));
    ok('one cell off: it names C1 as the one that differs', lastLine(oneOdd.out).includes('differing: C1 ('));
    ok('one cell off: it names the two that agree, with their shared hash', lastLine(oneOdd.out).includes(`agreeing: C0, C2 (${Buffer.byteLength(TRIMMED)} bytes, sha256 ${shaDelivered})`));
    ok('one cell off: the first differing offset against the agreeing cells is named', lastLine(oneOdd.out).includes(`C1 vs C0 first differs at byte ${OFFSET} (0-based)`));
    ok('one cell off: it never says all three are identical', !oneOdd.out.includes('all 3 delivered texts are byte-identical'));
    say(`one cell off: ${lastLine(oneOdd.out)}`);

    // 5b. --source adds the comparison the rule is really about, and it is the recorded round's own shape:
    // a source of 17 bytes with its final newline, three cells that received the 16-byte trimmed text.
    const withSource = run(['cells', `C0=${cellA}`, `C1=${cellB}`, `C2=${cellC}`, '--source', src]);
    ok('cells --source: exit 0 when the cells agree and are the source text (newline aside)', withSource.code === 0);
    ok('cells --source: the source comparison is stated in the summary line, with the source\'s own byte count', lastLine(withSource.out).includes('vs source') && lastLine(withSource.out).includes(`(${SOURCE_BYTES} bytes): IDENTICAL TEXT, final line ending only (source LF ("\\n"), delivered none)`));
    ok('cells --source: the source comparison is also a detail line, with both endings', withSource.out.includes('line ending: source LF ("\\n"), delivered none'));
    const sourceOff = run(['cells', `C0=${cellA}`, `C1=${cellB}`, `C2=${cellC}`, '--source', oneByte]);
    ok('cells --source: exit 1 when the cells agree with each other but not with the source', sourceOff.code === 1 && lastLine(sourceOff.out).includes('vs source') && lastLine(sourceOff.out).includes('DIFFERENT'));
    say(`cells --source: ${lastLine(withSource.out)}`);

    // 6. a delivered text read from a cell's session store, and the recorded comparison against its source.
    const fromSession = run(['verify', src, `@session:${sessionStore}`]);
    ok('session store: the user/user record is the delivered text', fromSession.code === 0 && lastLine(fromSession.out).includes('final line ending only'));
    ok('session store: the digest is the delivered text\'s, not the store\'s', fromSession.out.includes(sha256Hex(Buffer.from(TRIMMED, 'utf8'))));
    const wrongShape = run(['verify', src, `@session:${wrongStore}`]);
    ok('session store of the wrong shape: exit 2', wrongShape.code === 2);
    ok('session store of the wrong shape: the shapes it saw are printed', wrongShape.err.includes('assistant/assistant x1'));
    say(`session store: ${lastLine(fromSession.out)}`);

    // 7. stdin, so a delivered text can be piped rather than written to a file.
    const piped = run(['verify', src, '-'], stdin);
    ok('stdin: the piped text is compared', piped.code === 0 && lastLine(piped.out).includes('final line ending only'));
    ok('stdin: the input is labelled stdin', piped.out.includes('delivered  stdin — '));
    const pipedOff = run(['verify', src, '-'], { readStdin: () => Buffer.from(ONE_BYTE, 'utf8') });
    ok('stdin: a piped text that differs exits 1', pipedOff.code === 1 && pipedOff.out.includes(`byte ${OFFSET} (0-based)`));

    // 8. usage errors, unreadable inputs and the cells minimum.
    const noArgs = run([]);
    ok('no arguments: exit 2 and the usage text', noArgs.code === 2 && noArgs.err.includes('usage: node scripts/prompt-hash.mjs'));
    const oneCell = run(['cells', `C0=${cellA}`]);
    ok('one cell: exit 2', oneCell.code === 2 && oneCell.err.includes('at least two'));
    const noSuchFile = run(['hash', path('absent.txt')]);
    ok('a missing file: exit 2, and the path is named', noSuchFile.code === 2 && noSuchFile.err.includes('absent.txt') && noSuchFile.err.includes('no such file'));
    const unknownFlag = run(['hash', src, '--nope']);
    ok('an unknown flag: exit 2', unknownFlag.code === 2 && unknownFlag.err.includes('--nope'));
    const twoStdin = run(['cells', 'C0=-', 'C1=-'], stdin);
    ok('two stdin inputs: exit 2', twoStdin.code === 2 && twoStdin.err.includes('only one'));
    const badCell = run(['cells', cellA, cellB]);
    ok('a cells input without a name: exit 2', badCell.code === 2 && badCell.err.includes('name=text'));
    const duplicate = run(['cells', `C0=${cellA}`, `C0=${cellB}`]);
    ok('two cells with one name: exit 2', duplicate.code === 2 && duplicate.err.includes('share a name'));
    ok('the usage text names all three modes and the exit codes',
      USAGE.includes('hash   <source>') && USAGE.includes('verify <source> <delivered>') && USAGE.includes('cells  <name>=<text>') && USAGE.includes('0 clean'));

    // 9. the JSON record: the thing a round embeds.
    const human = run(['verify', src, trimmed]);
    const json = run(['verify', src, trimmed, '--json']);
    let record = null;
    try {
      record = JSON.parse(json.out);
    } catch (err) {
      problems.push(`--json: the output is not JSON: ${err.message}`);
    }
    ok('--json: exit 0 for the line-ending case', json.code === 0);
    ok('--json: nothing but the record is printed', json.err === '' && json.out.trimEnd().endsWith('}'));
    ok('--json: the verdict is the line-ending state', record !== null && record.verdict === 'identical-except-final-line-ending' && record.ok === true);
    ok('--json: the full 64-hex digest is recorded for both sides', record !== null && record.source.sha256 === sha && record.delivered.sha256 === sha256Hex(Buffer.from(TRIMMED, 'utf8')));
    ok('--json: the byte lengths are recorded for both sides', record !== null && record.source.bytes === SOURCE_BYTES && record.delivered.bytes === Buffer.byteLength(TRIMMED));
    ok('--json: both endings are recorded', record !== null && record.lineEnding.source === 'LF' && record.lineEnding.delivered === 'none');
    ok('--json: line is the summary line, verbatim, of the same run without --json', record !== null && record.line === lastLine(human.out));
    const jsonOne = JSON.parse(run(['verify', src, oneByte, '--json']).out);
    ok('--json: a difference records the offset and both byte values', jsonOne.firstDifference.offset === OFFSET && jsonOne.firstDifference.sourceByte === 0x62 && jsonOne.firstDifference.deliveredByte === 0x42);
    const jsonCells = run(['cells', `C0=${cellA}`, `C1=${cellOdd}`, `C2=${cellC}`, '--json']);
    const cellsRecord = JSON.parse(jsonCells.out);
    ok('--json cells: exit 1 when they disagree', jsonCells.code === 1);
    ok('--json cells: the outlier is recorded by name', cellsRecord.outliers.length === 1 && cellsRecord.outliers[0] === 'C1');
    ok('--json cells: every cell carries its own 64-hex hash', cellsRecord.cells.length === 3 && cellsRecord.cells.every((cell) => /^[0-9a-f]{64}$/.test(cell.sha256)));
    ok('--json cells: the agreeing pair is one group', cellsRecord.groups.length === 2 && cellsRecord.groups[0].cells.join() === 'C0,C2');
    ok('--json cells: the group of one is the outlier group', cellsRecord.groups[1].cells.join() === 'C1' && cellsRecord.groups[1].bytes === Buffer.byteLength(TRIMMED));

    // 10. --quiet is the summary line and nothing else.
    const quiet = run(['verify', src, oneByte, '--quiet']);
    ok('--quiet: exactly one line', quiet.out.trimEnd().split('\n').length === 1);
    ok('--quiet: and it is the summary line', quiet.out.trim() === lastLine(run(['verify', src, oneByte]).out));

    // 11. the convention itself: 64 hex characters, the empty-input vector, no truncation anywhere.
    ok('convention: the empty input hashes to the published vector', sha256Hex(Buffer.from('', 'utf8')) === SHA256_EMPTY);
    ok('convention: digests are 64 hex characters, not truncated', sha.length === 64);
    ok('convention: the byte length is the byte length, not the character count', SOURCE_BYTES === 17 && Buffer.from('é', 'utf8').length === 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const verdict = problems.length === 0 ? `PASS (${checks} assertions)` : `FAIL (${problems.length} of ${checks} assertions)`;
  say(`${TOOL} --self-test: ${verdict}`);
  if (problems.length === 0) {
    return { ok: true, checks, problems, out: quiet ? `${TOOL} --self-test: ${verdict}\n` : `${lines.join('\n')}\n`, err: '' };
  }
  return {
    ok: false,
    checks,
    problems,
    out: quiet ? '' : `${lines.join('\n')}\n`,
    err: `${problems.map((problem) => `  - ${problem}`).join('\n')}\n${TOOL} --self-test: ${verdict}\n`,
  };
}

// ---------------------------------------------------------------------------------------------
// 6. CLI
// ---------------------------------------------------------------------------------------------

const usageError = (message) => ({ code: 2, out: '', err: `${USAGE}\n${TOOL}: ${message}\n` });

/** `name=text`, the one form `cells` takes: unambiguous, and the name is what the report calls the cell. */
function parseCell(word) {
  const eq = word.indexOf('=');
  if (eq <= 0 || eq === word.length - 1) return null;
  const label = word.slice(0, eq);
  if (!/^[A-Za-z0-9_.:-]+$/.test(label)) return null;
  return { label, spec: word.slice(eq + 1) };
}

export function main(argv, io) {
  const words = [];
  const flags = { json: false, quiet: false, source: null, selfTest: false, help: false, raw: argv };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') flags.json = true;
    else if (arg === '--quiet') flags.quiet = true;
    else if (arg === '--self-test') flags.selfTest = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg === '--source') {
      if (argv[i + 1] === undefined) return usageError('--source needs a text');
      flags.source = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--')) return usageError(`unknown flag ${arg}`);
    else words.push(arg);
  }

  if (flags.help) return { code: 0, out: `${USAGE}\n`, err: '' };
  if (flags.selfTest) {
    const result = selfTest({ quiet: flags.json || flags.quiet });
    if (flags.json) {
      const record = { tool: TOOL, version: VERSION, mode: 'self-test', ok: result.ok, assertions: result.checks, problems: result.problems };
      return { code: result.ok ? 0 : 1, out: `${JSON.stringify(record, null, 2)}\n`, err: result.err };
    }
    return { code: result.ok ? 0 : 1, out: result.out, err: result.err };
  }

  try {
    const mode = words[0];
    if (mode === 'hash') {
      if (words.length !== 2) return usageError('hash needs exactly one <source>');
      if (flags.source !== null) return usageError('--source belongs to cells');
      return runHash(words[1], flags, io);
    }
    if (mode === 'verify') {
      if (words.length !== 3) return usageError('verify needs a <source> and a <delivered>');
      if (flags.source !== null) return usageError('--source belongs to cells');
      return runVerify(words[1], words[2], flags, io);
    }
    if (mode === 'cells') {
      const parsed = words.slice(1).map(parseCell);
      if (parsed.some((cell) => cell === null)) return usageError('every cells input is name=text, e.g. C0=prompt.txt or C1=@session:<store>');
      if (parsed.length < 2) return usageError('cells needs at least two named texts to compare');
      const labels = parsed.map((cell) => cell.label);
      if (new Set(labels).size !== labels.length) return usageError(`two cells share a name: ${labels.join(', ')}`);
      if (parsed.filter((cell) => cell.spec === '-').length > 1) return usageError('only one cells input can come from stdin');
      return runCells(parsed, flags.source, flags, io);
    }
    if (mode === undefined) return usageError('no mode given');
    return usageError(`unknown mode ${mode}`);
  } catch (err) {
    if (err && err.isUsageError) return usageError(err.message);
    throw err;
  }
}

/**
 * The CLI runs only when this file is the process entry point, so a test can import `compareBytes`,
 * `readSessionPrompt` or `main` without the import parsing the importing process's arguments.
 */
export const isCliEntry = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCliEntry) {
  try {
    const result = main(process.argv.slice(2), { readStdin: () => readFileSync(0) });
    if (result.out !== '') process.stdout.write(result.out);
    if (result.err !== '') process.stderr.write(result.err);
    process.exitCode = result.code;
  } catch (err) {
    process.stderr.write(`${TOOL}: ${err && err.stack ? err.stack : String(err)}\n`);
    process.exitCode = 1;
  }
}
