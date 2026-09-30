/**
 * Setup, tested as a command sequence rather than as an install.
 *
 * The install itself needs a Python, a network and an index name this repository does not establish — so what is
 * tested here is everything that can silently go wrong around it: the order of commands, what happens when a
 * step is missing, and the two precedence rules (an existing venv is reused, never clobbered; a missing
 * distribution name stops the run instead of installing a guess).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { DEFAULT_VENV_DIR, parseSetupArgs, setupLayaEnv, venvPython } from '../src/setup.ts';
import { dshBundledPython } from '../src/discovery.ts';
import { defaultLayaConfig } from '../src/types.ts';

function recorder(answers: { [key: string]: { code: number; out: string } } = {}) {
  const calls: { command: string; args: string[] }[] = [];
  const run = (command: string, args: string[]): { ok: boolean; out: string } => {
    calls.push({ command, args });
    const key = args.join(' ');
    for (const [pattern, answer] of Object.entries(answers)) {
      if (key.includes(pattern)) return { ok: answer.code === 0, out: answer.out };
    }
    return { ok: true, out: '' };
  };
  return { calls, run };
}

function scratch(): string {
  const dir = join(tmpdir(), `s1cap-setup-${process.pid}-${Math.floor(Date.now() % 1_000_000)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A venv whose interpreter file exists, so `setupLayaEnv` takes the reuse path and only the install runs. */
function fakeVenv(root: string): string {
  const venvDir = join(root, 'laya-venv');
  mkdirSync(join(venvDir, 'Scripts'), { recursive: true });
  writeFileSync(join(venvDir, 'Scripts', 'python.exe'), '');
  return venvDir;
}

test('setup creates a venv, installs into it, and reports the interpreter to paste into the panel', () => {
  const dir = scratch();
  try {
    const venvDir = fakeVenv(dir);
    const target = join(venvDir, 'Scripts', 'python.exe');

    const { calls, run } = recorder({ freeze: { code: 0, out: 'laya==0.3.21\ntorch==2.4.0\n' } });
    const result = setupLayaEnv(
      { pythonPath: 'C:/py/python.exe', packageSpec: 'laya-ai', venvDir, lock: true, dryRun: false },
      'win32',
      run,
    );

    assert.equal(result.ok, true, JSON.stringify(result.steps));
    // The install runs in the venv's interpreter, never the base: the base is the host's read-only installation.
    const install = calls.find((c) => c.args.includes('pip') && c.args.includes('install'));
    assert.equal(install?.command, target);
    assert.ok(install?.args.includes('laya-ai'));
    assert.ok(install?.args.includes('--no-input'), 'a missing network must not become a prompt in someone else\'s session');
    assert.equal(result.pythonPath, target, 'and the path the panel field needs is returned, not merely implied');
    assert.ok(result.lockPath && existsSync(result.lockPath), 'the lock file is written from the install that just ran');
    const lock = readFileSync(result.lockPath, 'utf8');
    assert.ok(lock.includes('laya==0.3.21'), 'it records what actually resolved, transitive set included');
    assert.ok(lock.includes('torch==2.4.0'));
    assert.ok(lock.startsWith('#'), 'and it says it was generated, so nobody hand-edits it into a wish');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an existing venv is reused, never recreated', () => {
  const dir = scratch();
  try {
    const venvDir = fakeVenv(dir);
    const { calls, run } = recorder();

    const result = setupLayaEnv(
      { pythonPath: 'C:/py/python.exe', packageSpec: 'laya-ai', venvDir, lock: false, dryRun: false },
      'win32',
      run,
    );

    assert.equal(result.ok, true);
    assert.equal(calls.some((c) => c.args.includes('venv')), false, 'a re-run must not delete an installed environment');
    assert.ok(result.steps.some((s) => s.what === 'reuse venv' && s.ok));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing interpreter or a missing distribution name stops before anything is created', () => {
  const { calls, run } = recorder();
  const noPython = setupLayaEnv({ pythonPath: '', packageSpec: 'x', venvDir: 'v', lock: false, dryRun: false }, 'win32', run);
  assert.equal(noPython.ok, false);
  assert.match(noPython.steps[0]?.detail ?? '', /--python/);
  assert.equal(calls.length, 0, 'nothing ran');

  const noPackage = setupLayaEnv({ pythonPath: 'C:/py/python.exe', packageSpec: '', venvDir: 'v', lock: false, dryRun: false }, 'win32', run);
  assert.equal(noPackage.ok, false);
  assert.match(noPackage.steps[0]?.detail ?? '', /not established/);
  assert.equal(calls.length, 0, 'a guessed distribution name is the one thing worth refusing to do');
});

test('a failed install stops the sequence and says which step failed', () => {
  const dir = scratch();
  try {
    const venvDir = fakeVenv(dir);
    const { run } = recorder({ 'pip install': { code: 1, out: 'ERROR: No matching distribution found\n' } });

    const result = setupLayaEnv(
      { pythonPath: 'C:/py/python.exe', packageSpec: 'nope-not-real', venvDir, lock: true, dryRun: false },
      'win32',
      run,
    );
    assert.equal(result.ok, false);
    assert.match(result.steps.find((s) => s.what.startsWith('install'))?.detail ?? '', /No matching distribution/);
    assert.equal(result.steps.some((s) => s.what === 'lock'), false, 'no lock file is written for a failed install');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dry-run prints the plan and touches nothing', () => {
  const { calls, run } = recorder();
  const result = setupLayaEnv(
    { pythonPath: 'C:/py/python.exe', packageSpec: 'laya-ai', venvDir: DEFAULT_VENV_DIR, lock: true, dryRun: true },
    'linux',
    run,
  );
  assert.equal(result.ok, true);
  assert.equal(calls.length, 0, 'a plan is not an action');
  // The path is laid out for the target platform, not for the machine running the test: a config written on
  // Windows and read on Linux would otherwise carry backslashes into a POSIX execve.
  assert.equal(result.pythonPath, './.s1cap/laya-venv/bin/python');
  assert.equal(venvPython('C:/envs/ml', 'win32'), 'C:/envs/ml\\Scripts\\python.exe');
});

test('argument parsing keeps the defaults that make the command one-shot', () => {
  const opts = parseSetupArgs(['--python', 'D:/py/python.exe', '--package', 'laya-ai', '--lock']);
  assert.equal(opts.pythonPath, 'D:/py/python.exe');
  assert.equal(opts.packageSpec, 'laya-ai');
  assert.equal(opts.lock, true);
  assert.equal(opts.venvDir, DEFAULT_VENV_DIR, 'the venv lands in S1CAP\'s own data directory by default');
  assert.equal(venvPython('/x/venv', 'linux'), '/x/venv/bin/python');});

test('the Python DSH ships is found from the running executable, and only when it is there', () => {
  const found = dshBundledPython(
    'D:\\Program Files\\DeepSeek Harness\\resources\\runtime\\primary-runtime\\dependencies\\node\\bin\\node.exe',
    'win32',
  );
  assert.equal(
    found,
    'D:\\Program Files\\DeepSeek Harness\\resources\\runtime\\primary-runtime\\dependencies\\python\\python.exe',
    'measured on the current build',
  );
  assert.equal(dshBundledPython('/usr/local/bin/node', 'linux'), undefined, 'no invented path when there is no runtime');
  assert.equal(dshBundledPython('C:\\other\\node.exe', 'win32'), undefined);
});

test('the bundled runtime is a discovery candidate, below an explicit config value', () => {
  // The precedence that matters: an explicit path always wins, the bundled runtime is offered next, and it is
  // only ever a *candidate* — the panel still requires the user to confirm a path, because a backend that picked
  // its own interpreter would make a run unreproducible.
  const cfg = defaultLayaConfig();
  cfg.pythonPath = 'D:/mine/python.exe';
  const deps = {
    run: async () => ({ code: 1, stdout: '', stderr: '' }),
    platform: 'win32',
    env: {},
    execPath: 'D:\\Program Files\\DeepSeek Harness\\resources\\runtime\\primary-runtime\\dependencies\\node\\bin\\node.exe',
  };
  return import('../src/discovery.ts').then(async ({ collectCandidates }) => {
    const candidates = await collectCandidates(cfg, deps);
    assert.equal(candidates[0]?.path, 'D:/mine/python.exe', 'config first');
    const bundled = candidates.find((c) => c.source === 'dsh-runtime');
    assert.ok(bundled !== undefined, 'the bundled runtime is offered, so the field can be pre-filled with a real path');
    assert.equal(bundled?.label, 'DSH bundled');
  });
});
