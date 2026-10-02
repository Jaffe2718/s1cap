/**
 * Tests for `scripts/paired-stats.mjs` — the registered analysis protocol of `docs/FORMULAS.md` §8.
 *
 * Layering, stated so the two are not read as duplicates:
 *
 *   - `node scripts/paired-stats.mjs --self-test` is the tool's own fixture, and it is the one the tool's
 *     header promises: a hand-checkable McNemar case, a bootstrap that reproduces under a fixed seed, a Holm
 *     family worked by hand, an unpaired input and a one-task input, each asserting the tool's *arithmetic*.
 *     137 assertions, exit 0.
 *   - this file asserts the parts a caller depends on that the self-test cannot reach: that importing the
 *     module does not run its CLI, that the three outcomes are three distinct states in-process, and — where
 *     the runner permits a child process at all — that the exit codes and the seed reproducibility hold
 *     across a process boundary.
 *
 * Two of the tests below need a child process, and this sandbox refuses to create one with piped stdio
 * (`spawnSync EPERM`; the same boundary that makes the repository's default `node --test` report 30 files
 * failing to spawn, which is why the suite is run with `--experimental-test-isolation=none`). Those tests
 * detect the refusal at runtime and `skip` with the reason instead of failing, so this file is honest in the
 * sandbox and complete on a machine that can spawn. Nothing about the tool's arithmetic is skipped: that is
 * the self-test, and it runs everywhere.
 *
 *   node --test --experimental-test-isolation=none "scripts/paired-stats.test.mjs"
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  analyze,
  asymptoticJustified,
  holm,
  isCliEntry,
  mcnemarExactOneSided,
  pairedBootstrap,
  validateInput,
} from './paired-stats.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = join(REPO, 'scripts', 'paired-stats.mjs');

/** Raw JSON the CLI can take: the file shape, not the validated spec the library takes. */
function rawFixture() {
  return {
    baseline: 'C0',
    arms: ['C0', 'C2'],
    primary: { metric: 'solved', margin: 0 },
    metrics: {
      solved: { kind: 'binary', higherIsBetter: true },
      cost: { kind: 'continuous', higherIsBetter: false, minRelImprovement: 0.1 },
    },
    family: ['cost'],
    tasks: {
      t1: { taskId: 't1', C0: { solved: 0, cost: 1.0 }, C2: { solved: 1, cost: 0.9 } },
      t2: { taskId: 't2', C0: { solved: 1, cost: 1.1 }, C2: { solved: 1, cost: 1.0 } },
      t3: { taskId: 't3', C0: { solved: 1, cost: 1.2 }, C2: { solved: 0, cost: 1.1 } },
      t4: { taskId: 't4', C0: { solved: 0, cost: 1.3 }, C2: { solved: 1, cost: 0.8 } },
    },
  };
}

/** Whether this environment lets a child process have its output captured at all. */
function canSpawnCaptured() {
  try {
    execFileSync(process.execPath, ['-e', '0'], { encoding: 'utf8', stdio: 'pipe' });
    return true;
  } catch (err) {
    if (err && err.code === 'EPERM') return false;
    throw err;
  }
}

const SPAWN = canSpawnCaptured();
const SPAWN_SKIP = 'this sandbox refuses to spawn a child process with piped stdio (EPERM); run on an unconfined machine';

test('the module is importable: importing the tool does not run its CLI', () => {
  // The regression this pins: as first written, `paired-stats.mjs` called `main(process.argv)` at module
  // scope, so importing a single function from it parsed the *importing* process's argv, printed this tool's
  // usage text and set exit code 3. A test file or a future CSV reader could not use it at all.
  assert.equal(isCliEntry, false, 'the test process is not the tool process, so the CLI must not have run');
  assert.equal(process.exitCode, undefined, 'and the import must not have set an exit code');
  assert.equal(typeof analyze, 'function');
  assert.equal(typeof holm, 'function');
  assert.equal(typeof pairedBootstrap, 'function');
});

test('the three outcomes are three distinct states, and only one of them produces numbers', () => {
  const spec = (tasks) => validateInput({ ...rawFixture(), tasks });
  const full = analyze(spec(rawFixture().tasks), { minN: 2, B: 500, seed: 11 });
  assert.equal(full.status, 'ok');
  assert.equal(full.pairing.pairsUsed, 4);
  assert.equal(full.verdict !== null, true);

  const ragged = rawFixture().tasks;
  delete ragged.t4.C2;
  const unpaired = analyze(spec(ragged), { minN: 2, B: 500, seed: 11 });
  assert.equal(unpaired.status, 'refused: insufficient-pairing');
  assert.equal(unpaired.refusal, 'insufficient-pairing');
  assert.equal(unpaired.comparisons.length, 0, 'a refusal produces no comparison at all');
  assert.equal(unpaired.verdict, null);

  const one = analyze(spec({ t1: rawFixture().tasks.t1 }), { minN: 20, B: 500, seed: 11 });
  assert.equal(one.status, 'refused: insufficient-n');
  assert.equal(one.refusal, 'insufficient-n');
  assert.equal(one.comparisons.length, 0);
  assert.equal(one.verdict, null);
  assert.equal(one.inputs.minN, 20, 'the minimum is recorded in the output');
});

test('the refusal for insufficient pairing is never a silent drop (DEFECT-GATE F7\'s hazard)', () => {
  const ragged = { ...rawFixture().tasks };
  ragged.t4 = { taskId: 't4', C0: { solved: 0, cost: 1.3 } };
  const spec = validateInput({ ...rawFixture(), tasks: ragged });
  const res = analyze(spec, { minN: 2, B: 200, seed: 11 });
  assert.equal(res.status, 'refused: insufficient-pairing');
  assert.deepEqual(res.pairing.droppedKeysJson, ['t4'], 'the key it would have dropped is named');
  assert.equal(res.comparisons.length, 0);
  // And the narrowing route states what it gave up rather than contracting quietly.
  const narrowed = analyze(spec, { minN: 2, B: 200, seed: 11, allowDrop: true });
  assert.equal(narrowed.status, 'ok');
  assert.equal(narrowed.pairing.pairsUsed, 3);
  assert.deepEqual(narrowed.pairing.droppedKeys, ['t4']);
});

test('a Holm family of one is the raw p, so a one-metric family is not silently corrected', () => {
  const single = holm([0.031], 0.05);
  assert.equal(single.K, 1);
  assert.equal(single.entries[0].adjusted, 0.031);
  assert.equal(single.entries[0].reject, true);
  // The exact test's own floor: b+c = 6 is the smallest n that can reject at 0.05, and it does.
  assert.equal(2 * mcnemarExactOneSided(6, 0) <= 0.05, true);
  assert.equal(2 * mcnemarExactOneSided(5, 0) <= 0.05, false);
  assert.equal(asymptoticJustified(6, 0), false, 'and six discordant pairs are not asymptotic territory');
});

test('the bootstrap seed reproduces the interval across a process boundary, not just across calls', { skip: SPAWN ? false : SPAWN_SKIP }, () => {
  // Within one process is the easy half. The claim in the tool's header is that "re-running with the same
  // --seed reproduces the interval bit for bit", which is a claim about two runs of the program.
  const inProcess = analyze(validateInput(rawFixture()), { B: 4000, seed: 987654, minN: 2 });
  const dir = mkdtempSync(join(tmpdir(), 'paired-stats-'));
  const inputPath = join(dir, 'results.json');
  try {
    writeFileSync(inputPath, JSON.stringify(rawFixture()), 'utf8');
    const run = () => JSON.parse(execFileSync(
      process.execPath,
      [TOOL, '--input', inputPath, '--b', '4000', '--seed', '987654', '--min-n', '2', '--json'],
      { encoding: 'utf8' },
    ));
    const first = run();
    const second = run();
    assert.equal(first.inputs.seed, 987654, 'the seed is recorded');
    assert.equal(first.inputs.B, 4000, 'B is recorded');
    const cost = (r) => r.comparisons[0].secondary[0];
    assert.deepEqual(
      [cost(first).ciLow, cost(first).ciHigh, cost(first).pTwoSided],
      [cost(second).ciLow, cost(second).ciHigh, cost(second).pTwoSided],
      'two processes with the same seed must print the same interval',
    );
    assert.equal(first.pairing.pairsUsed, 4, 'and the pair count it used');
    // The library and the CLI must be one tool, not two.
    assert.equal(cost(first).ciLow, inProcess.comparisons[0].secondary[0].ciLow);
    assert.equal(cost(first).ciHigh, inProcess.comparisons[0].secondary[0].ciHigh);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the three outcomes have three exit codes', { skip: SPAWN ? false : SPAWN_SKIP }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'paired-stats-'));
  const okPath = join(dir, 'ok.json');
  const raggedPath = join(dir, 'ragged.json');
  const onePath = join(dir, 'one.json');
  const run = (args) => {
    try {
      return { code: 0, stdout: execFileSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', stdio: 'pipe' }) };
    } catch (err) {
      return { code: err.status, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') };
    }
  };
  try {
    writeFileSync(okPath, JSON.stringify(rawFixture()), 'utf8');
    const ragged = rawFixture();
    delete ragged.tasks.t4.C2; // t4 ran under C0 and not under C2 — the ragged case
    writeFileSync(raggedPath, JSON.stringify(ragged), 'utf8');
    writeFileSync(onePath, JSON.stringify({ ...rawFixture(), tasks: { t1: rawFixture().tasks.t1 } }), 'utf8');

    const ok = run(['--input', okPath, '--min-n', '2']);
    assert.equal(ok.code, 0);
    assert.match(ok.stdout, /status: ok/);
    assert.match(ok.stdout, /pairs used by this run {2}: 4/);

    const unpaired = run(['--input', raggedPath, '--min-n', '2']);
    assert.equal(unpaired.code, 2, 'refusal for insufficient pairing exits 2');
    assert.match(unpaired.stdout, /refused: insufficient-pairing/);
    assert.doesNotMatch(unpaired.stdout, /p \(one-sided\)/, 'a refusal prints no p-value');

    const tooFew = run(['--input', onePath, '--min-n', '20']);
    assert.equal(tooFew.code, 2, 'insufficient n is a refusal (2), not a malformed input (1)');
    assert.match(tooFew.stdout, /refused: insufficient-n/);
    assert.match(tooFew.stdout, /nothing to resample/, 'and says why one task is not enough');

    const malformed = run(['--input', onePath, '--min-n', '1', '--family', 'nope']);
    assert.equal(malformed.code, 1, 'a malformed input exits 1, distinct from a statistical refusal');
    assert.match(malformed.stderr, /not declared in metrics/);

    const usage = run([]);
    assert.equal(usage.code, 3, 'a usage error exits 3');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
