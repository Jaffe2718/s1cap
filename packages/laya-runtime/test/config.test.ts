import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultLayaConfig } from '../src/types.ts';
import { validateLayaConfig } from '../src/config.ts';

test('empty config yields the defaults, and a full valid block is applied', () => {
  assert.deepEqual(validateLayaConfig(undefined).config, defaultLayaConfig());

  const result = validateLayaConfig({
    enabled: true,
    condaEnv: 'ml',
    condaPath: 'D:\\ProgramData\\miniforge3\\Scripts\\conda.exe',
    extraCandidates: ['D:\\conda_store\\envs\\ml\\python.exe'],
    preferConsoleScript: false,
    host: '127.0.0.1',
    port: 9100,
    healthPath: '/health',
    model: 'typed-decisions',
    autoStart: false,
    startupTimeoutMs: 600000,
    pollIntervalMs: 250,
    env: { LAYA_THREADS: '8', HF_ENDPOINT: 'https://hf-mirror.com', HF_HUB_DISABLE_XET: '1' },
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.config.enabled, true);
  assert.equal(result.config.condaEnv, 'ml');
  assert.equal(result.config.port, 9100);
  assert.equal(result.config.startupTimeoutMs, 600000);
  assert.equal(result.config.env?.LAYA_THREADS, '8');
});

test('bad values are reported and the default kept', () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ port: 70000 }, 'laya.port'],
    [{ port: 8008.5 }, 'laya.port'],
    [{ startupTimeoutMs: 500 }, 'laya.startupTimeoutMs'],
    [{ pollIntervalMs: 10 }, 'laya.pollIntervalMs'],
    [{ healthPath: 'health' }, 'laya.healthPath'],
    [{ host: '   ' }, 'laya.host'],
    [{ enabled: 'yes' }, 'laya.enabled'],
    [{ extraCandidates: ['ok', 42] }, 'laya.extraCandidates'],
    [{ env: { LAYA_THREADS: 8 } }, 'laya.env'],
  ];
  for (const [raw, path] of cases) {
    const result = validateLayaConfig(raw);
    assert.equal(result.ok, false, `${path} must be rejected`);
    assert.equal(result.errors[0]?.path, path);
  }
  assert.equal(validateLayaConfig({ port: 70000 }).config.port, defaultLayaConfig().port);
});

test('unknown keys warn without failing', () => {
  const result = validateLayaConfig({ layaPort: 8008 });
  assert.equal(result.ok, true);
  assert.equal(result.warnings[0]?.path, 'laya.layaPort');
});
