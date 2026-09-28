import test from 'node:test';
import assert from 'node:assert/strict';

import { PROVIDERS } from '../src/providers.ts';
import { describeS1Backend, redactKey, resolveS1Backend, singleBackendIssues } from '../src/resolve.ts';

const layaOn = { enabled: true, host: '127.0.0.1', port: 8008 };
const layaOff = { enabled: false, host: '127.0.0.1', port: 8008 };

test('the local Laya backend resolves to the runtime endpoint, not the built-in default', () => {
  const resolved = resolveS1Backend({ provider: 'laya-serve' }, { ...layaOn, port: 9100 }, {});
  assert.equal(resolved.mode, 'local');
  assert.equal(resolved.baseUrl, 'http://127.0.0.1:9100');
  assert.equal(resolved.model, PROVIDERS['laya-serve'].model);
  assert.equal(resolved.apiKey, undefined, 'a local server needs no key by default');
});

test('per-provider overrides win: explicit baseUrl, explicit model, Laya checkpoint name', () => {
  const explicit = resolveS1Backend({ provider: 'laya-serve', baseUrl: 'http://10.0.0.5:8000/', model: 'english' }, layaOn, {});
  assert.equal(explicit.baseUrl, 'http://10.0.0.5:8000', 'trailing slash stripped');
  assert.equal(explicit.model, 'english');

  const fromLaya = resolveS1Backend({ provider: 'laya-serve', model: '' }, { ...layaOn, model: 'typed-decisions' }, {});
  assert.equal(fromLaya.model, 'typed-decisions');
});

test('the cloud key comes from config first, then the provider environment variables', () => {
  const fromEnv = resolveS1Backend({ provider: 'jev' }, layaOff, { TYPESAFE_API_KEY: 'env-key-1234567890' });
  assert.equal(fromEnv.mode, 'cloud');
  assert.equal(fromEnv.baseUrl, PROVIDERS.jev.baseUrl);
  assert.equal(fromEnv.apiKey, 'env-key-1234567890');

  const fromConfig = resolveS1Backend({ provider: 'jev', apiKey: 'cfg-key-abcdefghij' }, layaOff, {
    TYPESAFE_API_KEY: 'env-key-1234567890',
  });
  assert.equal(fromConfig.apiKey, 'cfg-key-abcdefghij', 'explicit config wins over the environment');

  const generic = resolveS1Backend({ provider: 'edgejev' }, layaOff, { S1CAP_API_KEY: 'generic-key-999' });
  assert.equal(generic.apiKey, 'generic-key-999', 'generic fallback for runtimes without a dedicated variable');

  const missing = resolveS1Backend({ provider: 'jev' }, layaOff, {});
  assert.equal(missing.apiKey, undefined);
});

test('provider "none" resolves to observation mode with no endpoint', () => {
  const resolved = resolveS1Backend({ provider: 'none' }, layaOff, { TYPESAFE_API_KEY: 'ignored' });
  assert.equal(resolved.mode, 'none');
  assert.equal(resolved.baseUrl, undefined);
  assert.equal(resolved.apiKey, undefined);
  assert.match(describeS1Backend(resolved), /provider=none/);
});

test('only one S1 backend may be active at a time', () => {
  assert.deepEqual(singleBackendIssues({ provider: 'laya-serve' }, layaOn), []);
  assert.deepEqual(singleBackendIssues({ provider: 'jev' }, layaOff), []);

  const both = singleBackendIssues({ provider: 'jev' }, layaOn);
  assert.equal(both.length, 1);
  assert.match(both[0] ?? '', /only one S1 backend/);
  assert.match(both[0] ?? '', /set provider to "laya-serve", or disable Laya/);

  const neverStarts = singleBackendIssues({ provider: 'laya-serve' }, layaOff);
  assert.match(neverStarts[0] ?? '', /laya.enabled is false/);

  const disabledButEnabled = singleBackendIssues({ provider: 'none' }, layaOn);
  assert.match(disabledButEnabled[0] ?? '', /s1.provider is "none"/);
});

test('credentials never reach a log line: redaction and the status summary', () => {
  const key = 'sk-live-SUPERSECRETVALUE-0123456789';
  assert.equal(redactKey(undefined), '(none)');
  assert.match(redactKey('short'), /5 chars/);
  const redacted = redactKey(key);
  assert.ok(!redacted.includes(key), 'the raw key must not appear');
  assert.ok(!redacted.includes('SUPERSECRET'), 'no middle fragment either');
  assert.match(redacted, /35 chars/);

  const summary = describeS1Backend(resolveS1Backend({ provider: 'jev', apiKey: key }, layaOff, {}));
  assert.ok(!summary.includes(key), 'the summary must not contain the key');
  assert.ok(!summary.includes('SUPERSECRET'));
  assert.match(summary, /provider=jev \(cloud\)/);
  assert.match(summary, /key=sk-l…89/);
});
