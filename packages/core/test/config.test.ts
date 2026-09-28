import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultPolicy } from '../src/types.ts';
import { KNOWN_PATHS, NUMBER_RULES, validatePolicy } from '../src/config.ts';

test('no config means the defaults, and every documented path exists on the policy', () => {
  const result = validatePolicy(undefined);
  assert.equal(result.ok, true);
  assert.deepEqual(result.policy, defaultPolicy());
  assert.deepEqual(result.issues, []);
  // every advertised path must resolve on the default policy (no doc/code drift)
  for (const path of KNOWN_PATHS) {
    let cursor = result.policy;
    for (const part of path.split('.')) {
      assert.equal(typeof cursor, 'object', `path ${path} breaks at ${part}`);
      cursor = cursor[part];
    }
    assert.notEqual(cursor, undefined, `path ${path} is documented but missing`);
  }
});

test('valid overrides are applied, nested sections included', () => {
  const result = validatePolicy({
    cell: 'C2',
    assemblyDeadlineMs: 500,
    rgMaintenance: { mode: 'async', maxLagTurns: 5 },
    cache: { reselectPolicy: 'threshold', blockTokens: 128 },
    tas: { on: false, tMaxChars: 4000, updatePolicy: 'perTurn' },
    recall: { tau: 0.7, depth: 3, fanout: 16, tier1: 's1', budgetRatio: 0.5, minRecalledShare: 0.1 },
    tail: { k: 6 },
    planGate: { on: false, maxPlans: 4, attemptCap: 3, abstainConfidence: 0.6 },
    s1: { provider: 'laya-serve', timeoutMs: 5000, questionsPerCall: 10, model: 'english' },
    telemetry: { sessionJsonl: 'a.jsonl', controlJsonl: 'b.jsonl' },
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.policy.cell, 'C2');
  assert.equal(result.policy.assemblyDeadlineMs, 500);
  assert.equal(result.policy.rgMaintenance.maxLagTurns, 5);
  assert.equal(result.policy.cache.reselectPolicy, 'threshold');
  assert.equal(result.policy.cache.blockTokens, 128);
  assert.equal(result.policy.tas.on, false);
  assert.equal(result.policy.tas.updatePolicy, 'perTurn');
  assert.equal(result.policy.recall.tau, 0.7);
  assert.equal(result.policy.recall.tier1, 's1');
  assert.equal(result.policy.tail.k, 6);
  assert.equal(result.policy.planGate.attemptCap, 3);
  assert.equal(result.policy.s1.provider, 'laya-serve');
  assert.equal(result.policy.s1.model, 'english');
});

test('the two design invariants cannot be configured away', () => {
  for (const [path, value] of [
    ['termination', 'harness-owned'],
    ['rgMaintenance.mode', 'sync'],
  ] as const) {
    const result = validatePolicy({ [path.split('.')[0]]: path.includes('.') ? { mode: value } : value });
    assert.equal(result.ok, false, `${path} must be rejected`);
    assert.match(result.errors[0]?.message ?? '', /fixed by design/);
  }
  // the correct values are accepted and normalised back
  const ok = validatePolicy({ termination: 'model-owned', rgMaintenance: { mode: 'async', maxLagTurns: 1 } });
  assert.equal(ok.ok, true);
  assert.equal(ok.policy.termination, 'model-owned');
  assert.equal(ok.policy.rgMaintenance.mode, 'async');
});

test('a bad value is reported and the default is kept (fail-safe)', () => {
  const cases: Array<[string, unknown]> = [
    ['recall.tau', 1.5],
    ['recall.tau', 'high'],
    ['recall.depth', 0],
    ['recall.depth', 2.5],
    ['recall.budgetRatio', 1],
    ['assemblyDeadlineMs', 0],
    ['planGate.attemptCap', 0],
    ['planGate.abstainConfidence', 2],
    ['cache.blockTokens', 0],
    ['s1.questionsPerCall', 100],
    ['tail.k', 50],
  ];
  for (const [path, value] of cases) {
    const raw: Record<string, unknown> = {};
    const [head, tail] = path.split('.');
    if (tail) raw[head as string] = { [tail]: value };
    else raw[head as string] = value;
    const result = validatePolicy(raw);
    assert.equal(result.ok, false, `${path}=${JSON.stringify(value)} must be rejected`);
    assert.equal(result.errors[0]?.path, path);
    const kept = path.split('.').reduce<unknown>((acc, part) => (acc as Record<string, unknown>)[part], result.policy);
    const fallback = path.split('.').reduce<unknown>((acc, part) => (acc as Record<string, unknown>)[part], defaultPolicy());
    assert.equal(kept, fallback, `${path} should fall back to its default`);
  }
});

test('enums, booleans and strings are checked', () => {
  assert.equal(validatePolicy({ cell: 'C9' }).ok, false);
  assert.equal(validatePolicy({ cache: { reselectPolicy: 'never' } }).ok, false);
  assert.equal(validatePolicy({ recall: { tier1: 'ann' } }).ok, false);
  assert.equal(validatePolicy({ tas: { on: 'yes' } }).ok, false);
  assert.equal(validatePolicy({ s1: { provider: 'gpt' } }).ok, false);
  assert.equal(validatePolicy({ s1: { baseUrl: 'api.typesafe.ai' } }).ok, false, 'needs a scheme');
  assert.equal(validatePolicy({ s1: { baseUrl: 'https://api.typesafe.ai' } }).ok, true);
  assert.equal(validatePolicy({ s1: { baseUrl: '', model: '' } }).ok, true, 'empty string means "not set"');
});

test('unknown keys warn instead of failing, and plugin keys can be declared', () => {
  const warned = validatePolicy({ recoll: { tau: 0.5 } });
  assert.equal(warned.ok, true);
  assert.equal(warned.warnings.length, 1);
  assert.match(warned.warnings[0]?.message ?? '', /unknown config key/);

  const withPluginKeys = validatePolicy({ laya: { enabled: false }, telemetry: {} }, ['laya']);
  assert.deepEqual(withPluginKeys.warnings, []);
});

test('non-object config is an error, and the rule tables stay coherent', () => {
  assert.equal(validatePolicy('C4').ok, false);
  assert.equal(validatePolicy([]).ok, false);
  for (const rule of NUMBER_RULES) {
    assert.ok(rule.min < rule.max, `${rule.path}: min must be below max`);
  }
  assert.equal(new Set(NUMBER_RULES.map((r) => r.path)).size, NUMBER_RULES.length, 'no duplicate rules');
});
