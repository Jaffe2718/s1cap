import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultLayaConfig } from '../src/types.ts';
import {
  PROBE_SCRIPT,
  candidatesFromPyLauncher,
  candidatesFromWhich,
  collectCandidates,
  condaEnvsFromJson,
  discoverLayaPython,
  installHint,
  parseProbe,
  probePython,
  pythonExecutable,
} from '../src/discovery.ts';
import type { DiscoveryDeps, RunResult } from '../src/discovery.ts';

/** Real `conda env list --json` shape from a machine whose envs_dirs is redirected. */
const CONDA_JSON = JSON.stringify({
  envs: ['D:\\ProgramData\\miniforge3', 'D:\\conda_store\\envs\\ml'],
  envs_details: {
    'D:\\ProgramData\\miniforge3': { name: 'base', base: true },
    'D:\\conda_store\\envs\\ml': { name: 'ml', base: false },
  },
});

function probeLine(laya: boolean, torch = true, serve = false): string {
  return JSON.stringify({ version: '3.13.15', laya, torch, serve });
}

function fakeDeps(overrides: Partial<Record<string, RunResult>> = {}, platform = 'win32'): DiscoveryDeps {
  return {
    platform,
    // Keep mocked discovery independent of the Node installation running tests.
    execPath: platform === 'win32' ? 'C:\\node\\node.exe' : '/usr/bin/node',
    env: { S1CAP_PYTHON: 'C:\\env-python\\python.exe' },
    async run(command: string, args: string[]): Promise<RunResult> {
      const key = `${command} ${args.join(' ')}`;
      const hit = overrides[key];
      if (hit) return hit;
      return { code: 1, stdout: '', stderr: `no fake for: ${key}` };
    },
  };
}

test('conda envs are resolved from `conda env list --json`, never from a guessed path', () => {
  const envs = condaEnvsFromJson(CONDA_JSON);
  assert.deepEqual(envs, [
    { name: 'base', path: 'D:\\ProgramData\\miniforge3' },
    { name: 'ml', path: 'D:\\conda_store\\envs\\ml' },
  ]);
  assert.deepEqual(condaEnvsFromJson('not json'), []);
});

test('pythonExecutable places the interpreter per platform', () => {
  assert.equal(pythonExecutable('D:\\conda_store\\envs\\ml', 'win32'), 'D:\\conda_store\\envs\\ml\\python.exe');
  assert.equal(pythonExecutable('/opt/conda/envs/ml', 'linux'), '/opt/conda/envs/ml/bin/python');
});

test('launcher and PATH output parsers pick out interpreter paths', () => {
  const viaPy = candidatesFromPyLauncher(' -V:3.13 *        C:\\Python313\\python.exe\n -V:3.11          C:\\Python311\\python.exe\n');
  assert.deepEqual(viaPy.map((c) => c.path), ['C:\\Python313\\python.exe', 'C:\\Python311\\python.exe']);

  const viaWhich = candidatesFromWhich('C:\\Program Files\\nodejs\\node.exe\nD:\\conda_store\\envs\\ml\\python.exe\n');
  assert.deepEqual(viaWhich.map((c) => c.path), ['D:\\conda_store\\envs\\ml\\python.exe']);
});

test('collectCandidates orders config > extra > env > conda env > conda base > PATH > py launcher, deduped', async () => {
  const cfg = { ...defaultLayaConfig(), pythonPath: 'C:\\cfg\\python.exe', condaEnv: 'ml', extraCandidates: ['C:\\extra\\python.exe'] };
  const deps = fakeDeps({
    'conda env list --json': { code: 0, stdout: CONDA_JSON, stderr: '' },
    'where python': { code: 0, stdout: 'D:\\conda_store\\envs\\ml\\python.exe\r\nC:\\Windows\\py.exe\r\n', stderr: '' },
    'py -0p': { code: 1, stdout: '', stderr: '' },
  });
  const out = await collectCandidates(cfg, deps);
  assert.deepEqual(out.map((c) => c.path), [
    'C:\\cfg\\python.exe',
    'C:\\extra\\python.exe',
    'C:\\env-python\\python.exe',
    'D:\\conda_store\\envs\\ml\\python.exe', // conda env "ml" (deduped against the PATH hit)
    'D:\\ProgramData\\miniforge3\\python.exe',
  ]);
  assert.equal(out[3]?.source, 'conda-env');
  assert.equal(out[3]?.label, 'ml');
});

test('probePython reports version, laya, torch and the serve extra', async () => {
  const ok = await probePython('D:\\conda_store\\envs\\ml\\python.exe', {
    platform: 'win32',
    async run() {
      return { code: 0, stdout: `${probeLine(true, true, true)}\n`, stderr: '' };
    },
  });
  assert.deepEqual(ok, {
    path: 'D:\\conda_store\\envs\\ml\\python.exe',
    ok: true,
    version: '3.13.15',
    laya: true,
    torch: true,
    serve: true,
  });

  const broken = await probePython('C:\\nope\\python.exe', {
    platform: 'win32',
    async run() {
      return { code: 1, stdout: '', stderr: 'No such file' };
    },
  });
  assert.equal(broken.ok, false);
  assert.equal(broken.error, 'No such file');
  assert.equal(parseProbe('garbage'), undefined);
  assert.ok(PROBE_SCRIPT.includes('find_spec'));
});

test('discoverLayaPython chooses the environment that can import laya', async () => {
  const deps: DiscoveryDeps = {
    platform: 'win32',
    env: {},
    async run(command, args) {
      if (command === 'conda') return { code: 0, stdout: CONDA_JSON, stderr: '' };
      if (command === 'where') return { code: 0, stdout: '', stderr: '' };
      if (command === 'py') return { code: 1, stdout: '', stderr: '' };
      // interpreter probes
      const withLaya = args[1] === PROBE_SCRIPT && command.includes('conda_store');
      return { code: 0, stdout: withLaya ? probeLine(true) : probeLine(false), stderr: '' };
    },
  };
  const cfg = { ...defaultLayaConfig(), condaEnv: 'ml' };
  const report = await discoverLayaPython(cfg, deps);
  assert.equal(report.chosen?.path, 'D:\\conda_store\\envs\\ml\\python.exe');
  assert.equal(report.chosen?.laya, true);
  assert.equal(report.withLaya.length, 1);
  assert.ok(report.candidates.length >= 2, 'base and ml are both probed');

  const hint = installHint(report.chosen?.path ?? '');
  assert.equal(hint, 'D:\\conda_store\\envs\\ml\\python.exe -m pip install "laya[serve]"');
});
