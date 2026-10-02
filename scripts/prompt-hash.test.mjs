/**
 * Tests for `scripts/prompt-hash.mjs` — the machinery behind `docs/CELLS-RUN.md`'s prompt rule.
 *
 * Layering, stated so the two are not read as duplicates:
 *
 *   - `node scripts/prompt-hash.mjs --self-test` is the tool's own fixtures, and they are the ones its header
 *     promises: identical files, a one-byte difference with a named offset, a trailing-line-ending-only
 *     difference, three-way identical, three-way with one cell off, a two-newline difference, a session store, a
 *     piped text and the usage errors — 72 assertions, each also asserting that the *wrong* verdict is absent.
 *   - this file asserts the parts a caller depends on that the self-test cannot reach: that importing the module
 *     does not run its CLI, that the comparison's four states are distinct states of a pure function, that a
 *     digest is the full 64 hex of the bytes and cannot drift back to the 16-hex banner form, that a delivered
 *     text is read from the record type the round records name, that the exit codes hold across a process
 *     boundary, and that the tool reproduces the one prompt hash this repository has actually recorded
 *     (round 20261002-2037's `fbdf4b54…` / `65db8ffc…`).
 *
 *   node --test --experimental-test-isolation=none "scripts/prompt-hash.test.mjs"
 *
 * Two tests spawn the tool. This sandbox refuses a child process with piped stdio (`spawnSync EPERM`, the same
 * boundary that makes the repository run its suite with `--experimental-test-isolation=none`), and it does allow
 * `stdio: 'ignore'`, so the exit codes are checked through a real process while the piped-stdout cases skip with
 * the reason instead of failing. Nothing about the comparison itself is skipped.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  TOOL,
  compareBytes,
  finalLineEnding,
  groupCells,
  isCliEntry,
  main,
  readSessionPrompt,
  sha256Hex,
  stripFinalLineEnding,
} from './prompt-hash.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOOL_PATH = join(REPO, 'scripts', 'prompt-hash.mjs');
const buffers = (...texts) => texts.map((text) => Buffer.from(text, 'utf8'));
const lastLine = (out) => out.trimEnd().split('\n').at(-1);

/** Whether a child process can be created with this stdio at all, in this sandbox. */
function spawnWorks(stdio) {
  try {
    return !spawnSync(process.execPath, ['-e', '0'], { stdio }).error;
  } catch {
    return false;
  }
}

const IGNORED = spawnWorks('ignore');
const PIPED = spawnWorks('pipe');
const IGNORED_SKIP = 'this sandbox refuses to create the child process at all; run on an unconfined machine';
const PIPED_SKIP = 'this sandbox refuses a child process with piped stdio (spawnSync EPERM); run on an unconfined machine';

test('the module is importable: importing the tool does not run its CLI', () => {
  // The regression this pins: a tool that calls `main(process.argv)` at module scope parses the *importing*
  // process's arguments as a side effect of the import, which is how `paired-stats.mjs` was first written.
  assert.equal(isCliEntry, false, 'the test process is not the tool process, so the CLI must not have run');
  assert.equal(process.exitCode, undefined, 'and the import must not have set an exit code');
  assert.equal(typeof compareBytes, 'function');
  assert.equal(typeof readSessionPrompt, 'function');
  assert.equal(typeof main, 'function');
});

test('the comparison has four distinct states, and only one of them is a finding', () => {
  const [a, b, c, d, f] = buffers('abc\n', 'abc\r\n', 'abc', 'abd\n', 'ab');

  const same = compareBytes(a, a);
  assert.equal(same.verdict, 'identical');
  assert.equal(same.ok, true);
  assert.equal(same.firstDifference, undefined, 'an identical pair has no first difference');

  // LF against CRLF, and a missing final newline, are the same state in both directions.
  for (const [left, right] of [[a, b], [b, a], [a, c], [c, a]]) {
    const trimmed = compareBytes(left, right);
    assert.equal(trimmed.verdict, 'identical-except-final-line-ending', `${JSON.stringify(left.toString())} vs ${JSON.stringify(right.toString())}`);
    assert.equal(trimmed.ok, true);
    assert.equal(trimmed.firstDifference, undefined, 'the line-ending state has no first difference to name');
  }
  assert.deepEqual(compareBytes(a, c).lineEnding, { source: 'LF', delivered: 'none' });
  assert.deepEqual(compareBytes(a, b).lineEnding, { source: 'LF', delivered: 'CRLF' });

  // One byte inside the text: the offset is named, and both lengths are reported.
  const off = compareBytes(a, d);
  assert.equal(off.verdict, 'different');
  assert.equal(off.ok, false);
  assert.equal(off.firstDifference.offset, 2);
  assert.equal(off.firstDifference.sourceByte, 'c'.charCodeAt(0));
  assert.equal(off.firstDifference.deliveredByte, 'd'.charCodeAt(0));
  assert.equal(off.sourceBytes, 4);
  assert.equal(off.deliveredBytes, 4);

  // One side a prefix of the other: the offset is the end of the shorter side, and that side has no byte there.
  const truncated = compareBytes(a, f);
  assert.equal(truncated.verdict, 'different');
  assert.equal(truncated.firstDifference.offset, 2);
  assert.equal(truncated.firstDifference.sourceByte, 'c'.charCodeAt(0));
  assert.equal(truncated.firstDifference.deliveredByte, null, 'the delivered text ended at the offset');
  assert.equal(truncated.deliveredBytes, 2);
});

test('exactly one final line ending is forgiven, and nothing else', () => {
  // The hazard this pins: a comparison that strips *all* trailing whitespace, or every trailing newline, calls a
  // lost blank line "the same text". The line-ending state is granted for one ending and only at the end.
  assert.equal(compareBytes(...buffers('abc\n\n', 'abc\n')).verdict, 'different', 'a lost blank line is a difference');
  assert.equal(compareBytes(...buffers('abc \n', 'abc\n')).verdict, 'different', 'trailing space is not a line ending');
  assert.equal(compareBytes(...buffers('abc\n\t', 'abc\n')).verdict, 'different', 'trailing tab is not a line ending');
  assert.equal(compareBytes(...buffers('\n', '')).verdict, 'identical-except-final-line-ending');
  assert.equal(compareBytes(...buffers('', '')).verdict, 'identical');

  assert.equal(stripFinalLineEnding(Buffer.from('abc\r\n')).toString(), 'abc');
  assert.equal(stripFinalLineEnding(Buffer.from('abc\n')).toString(), 'abc');
  assert.equal(stripFinalLineEnding(Buffer.from('abc\n\n')).toString(), 'abc\n', 'one ending, not all of them');
  assert.equal(stripFinalLineEnding(Buffer.from('abc')).toString(), 'abc');
  assert.equal(stripFinalLineEnding(Buffer.from('abc\r')).toString(), 'abc\r', 'a lone CR is not a line ending here');

  assert.equal(finalLineEnding(Buffer.from('abc\r\n')), 'CRLF');
  assert.equal(finalLineEnding(Buffer.from('abc\n')), 'LF');
  assert.equal(finalLineEnding(Buffer.from('abc')), 'none');
});

test('the digest is the full 64 hex of the bytes, and cannot drift to the 16-hex banner form', () => {
  // `build-route-svg.mjs` stamps generated SVGs with `source sha256:` plus 16 hex. That is a banner for a build
  // product; a prompt hash has to compare with the 64-hex digests the round records already carry, so this test
  // fails if anyone shortens it.
  assert.equal(sha256Hex(Buffer.from('', 'utf8')), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256Hex(Buffer.from('abc', 'utf8')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.match(sha256Hex(Buffer.from('abc', 'utf8')), /^[0-9a-f]{64}$/);
  // Bytes, not characters: the byte length and the digest both follow the encoding.
  assert.notEqual(sha256Hex(Buffer.from('é', 'utf8')), sha256Hex(Buffer.from('é', 'latin1')));
  assert.equal(Buffer.from('é', 'utf8').length, 2);
});

test('a delivered text is the first kind:"user" role:"user" record, and no other shape is guessed at', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prompt-hash-test-'));
  try {
    const text = 'alpha\nbeta\ngamma';
    const store = join(dir, 'session.jsonl');
    writeFileSync(store, [
      JSON.stringify({ kind: 'trace', role: 'assistant', text: 'not the prompt' }),
      JSON.stringify({ kind: 'user', role: 'user', text }),
      JSON.stringify({ kind: 'user', role: 'user', text: 'a later message that must not be read' }),
    ].join('\n') + '\n', 'utf8');
    assert.equal(readSessionPrompt(store).toString('utf8'), text, 'the first user/user record is the delivered text');

    const wrong = join(dir, 'wrong-shape.jsonl');
    writeFileSync(wrong, `${JSON.stringify({ kind: 'assistant', role: 'assistant', text })}\n`, 'utf8');
    assert.throws(() => readSessionPrompt(wrong), (err) => err.isUsageError === true && /assistant\/assistant x1/.test(err.message),
      'a store with no user/user record must refuse loudly, naming the shapes it saw');

    // And the refusal is exit 2 through the CLI, not a crash and not a wrong hash.
    const source = join(dir, 'source.txt');
    writeFileSync(source, `${text}\n`, 'utf8');
    const refused = main(['verify', source, `@session:${wrong}`]);
    assert.equal(refused.code, 2);
    assert.equal(refused.out, '');
    assert.match(refused.err, /no record with kind "user", role "user" and a text field/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the exit codes hold across a process boundary (0 clean, 1 finding, 2 usage)', { skip: IGNORED ? false : IGNORED_SKIP }, () => {
  // Exit codes are the part of the contract a shell depends on, so they are read from a real exit status and not
  // only from `main()`'s return value. `stdio: 'ignore'` is used because this sandbox allows it and refuses a
  // piped child; the output itself is asserted in-process elsewhere in this file.
  const code = (...args) => spawnSync(process.execPath, [TOOL_PATH, ...args], { stdio: 'ignore' }).status;
  const missing = join(REPO, 'scripts', 'no-such-prompt-file.txt');
  assert.equal(code(), 2, 'no arguments is a usage error');
  assert.equal(code('hash', missing), 2, 'an unreadable input is a usage error');
  assert.equal(code('verify', TOOL_PATH, TOOL_PATH), 0, 'a file against itself is identical');
  assert.equal(code('cells', `C0=${TOOL_PATH}`, `C1=${TOOL_PATH}`), 0, 'and so are two cells');
  assert.equal(code('cells', `C0=${TOOL_PATH}`), 2, 'one cell is not a comparison');
});

test('the CLI writes the summary line to stdout and the usage error to stderr', { skip: PIPED ? false : PIPED_SKIP }, () => {
  const run = (...args) => spawnSync(process.execPath, [TOOL_PATH, ...args], { encoding: 'utf8' });
  const hash = run('hash', TOOL_PATH);
  assert.equal(hash.status, 0);
  assert.match(hash.stdout.trim(), new RegExp(`^${TOOL} hash: .* ${readFileSync(TOOL_PATH).length} bytes, sha256 [0-9a-f]{64}$`));
  assert.equal(hash.stderr, '');

  const usage = run();
  assert.equal(usage.status, 2);
  assert.equal(usage.stdout, '', 'a usage error writes nothing to stdout');
  assert.match(usage.stderr, /usage: node scripts\/prompt-hash\.mjs/);
  assert.match(usage.stderr, new RegExp(`^${TOOL}: `, 'm'));
});

test('--json is one record whose line is the summary line verbatim', () => {
  const human = main(['verify', TOOL_PATH, TOOL_PATH]);
  const json = main(['verify', TOOL_PATH, TOOL_PATH, '--json']);
  assert.equal(json.code, 0);
  assert.equal(json.err, '');
  const record = JSON.parse(json.out);
  assert.equal(record.tool, TOOL);
  assert.equal(record.mode, 'verify');
  assert.equal(record.verdict, 'identical');
  assert.equal(record.ok, true);
  assert.equal(record.line, lastLine(human.out), 'the record carries the summary line the human report ends with');
  assert.ok(human.out.includes(record.line));
  assert.equal(record.source.sha256, sha256Hex(readFileSync(TOOL_PATH)));
  assert.equal(record.source.bytes, readFileSync(TOOL_PATH).length);
  assert.equal(record.lengthDelta, 0);
});

test('cells groups by digest, largest group first, and names every cell in the reading', () => {
  const cells = ['C0', 'C1', 'C2'].map((label, index) => ({ label, bytes: Buffer.from(index === 1 ? 'x\n' : 'y\n', 'utf8') }));
  const groups = groupCells(cells);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].cells.map((cell) => cell.label), ['C0', 'C2']);
  assert.deepEqual(groups[1].cells.map((cell) => cell.label), ['C1']);
  assert.equal(groups[0].sha256, sha256Hex(Buffer.from('y\n', 'utf8')));

  const dir = mkdtempSync(join(tmpdir(), 'prompt-hash-test-'));
  try {
    const same = join(dir, 'same.txt');
    const odd = join(dir, 'odd.txt');
    writeFileSync(same, 'y\n', 'utf8');
    writeFileSync(odd, 'x\n', 'utf8');
    const disagree = main(['cells', `C0=${same}`, `C1=${odd}`, `C2=${same}`]);
    assert.equal(disagree.code, 1);
    assert.match(lastLine(disagree.out), /NOT byte-identical — differing: C1 \(/);
    assert.match(lastLine(disagree.out), /agreeing: C0, C2 \(/);
    const agree = main(['cells', `C0=${same}`, `C1=${same}`, `C2=${same}`]);
    assert.equal(agree.code, 0);
    for (const label of ['C0', 'C1', 'C2']) assert.ok(lastLine(agree.out).includes(`${label} sha256 ${sha256Hex(Buffer.from('y\n', 'utf8'))}`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the tool reproduces the recorded prompt hash of round 20261002-2037, or says why it cannot', (t) => {
  // The one prompt hash this repository has recorded: that round's `ROUND-REPORT.md` records prompt.txt as
  // `fbdf4b54…` at 4,102 bytes and what all three cells received as `65db8ffc…` at 4,101 bytes. This test is what
  // makes "the convention is matched" a reading rather than a claim. The round directory is a frozen record that
  // may be moved or deleted by a cleanup, so its absence skips rather than fails.
  const root = resolve(REPO, '..', '.s1cap-ablation');
  const prompt = join(root, 'longtask', 'sqlparse-splitter-begin-transaction', 'prompt.txt');
  const stores = ['C0', 'C1', 'C2'].map((cell) => join(root, 'round-20261002-2037', 'evidence', cell, 'session.jsonl'));
  if (!existsSync(prompt) || stores.some((store) => !existsSync(store))) {
    t.skip(`the round's record is not in this checkout (${prompt})`);
    return;
  }
  const SOURCE_SHA = 'fbdf4b546b4edc0337c63b346ae8a64ae7bc0111cc4d64ed0f3ea4770afead98';
  const DELIVERED_SHA = '65db8ffc24d8f289af4fe2d410d8a68e4073c8e02fc7783694ba9efc74850037';

  const sourceBytes = readFileSync(prompt);
  assert.equal(sourceBytes.length, 4102);
  assert.equal(sha256Hex(sourceBytes), SOURCE_SHA);

  for (const store of stores) {
    const delivered = readSessionPrompt(store);
    assert.equal(delivered.length, 4101, `${store}: the recorded delivery is 4,101 bytes`);
    assert.equal(sha256Hex(delivered), DELIVERED_SHA, `${store}: the recorded delivery digest`);
    const cmp = compareBytes(sourceBytes, delivered);
    assert.equal(cmp.verdict, 'identical-except-final-line-ending', 'the recorded delivery is the source minus its final newline');
    assert.deepEqual(cmp.lineEnding, { source: 'LF', delivered: 'none' });
  }

  const run = main(['cells', ...stores.map((store, index) => `C${index}=@session:${store}`), '--source', prompt]);
  assert.equal(run.code, 0);
  assert.match(lastLine(run.out), /all 3 delivered texts are byte-identical/);
  assert.match(lastLine(run.out), /IDENTICAL TEXT, final line ending only/);
});
