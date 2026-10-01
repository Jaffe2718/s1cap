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
    cell: 'C1',
    assemblyDeadlineMs: 500,
    rgMaintenance: { mode: 'async', maxLagTurns: 5 },
    cache: { reselectPolicy: 'threshold', blockTokens: 128 },
    tas: { on: false, tMaxChars: 4000, updatePolicy: 'perTurn' },
    recall: { threshold: 0.7, depth: 3, fanout: 16, tier1: 's1', budgetRatio: 0.5, minRecalledShare: 0.1 },
    tail: { k: 6 },
    planGate: { on: false, maxPlans: 4, attemptCap: 3, abstainConfidence: 0.6 },
    s1: { provider: 'laya-serve', timeoutMs: 5000, questionsPerCall: 10, model: 'english', retryAttempts: 3 },
    telemetry: { sessionJsonl: 'a.jsonl', controlJsonl: 'b.jsonl' },
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.policy.cell, 'C1');
  assert.equal(result.policy.assemblyDeadlineMs, 500);
  assert.equal(result.policy.rgMaintenance.maxLagTurns, 5);
  assert.equal(result.policy.cache.reselectPolicy, 'threshold');
  assert.equal(result.policy.cache.blockTokens, 128);
  assert.equal(result.policy.tas.on, false);
  assert.equal(result.policy.tas.updatePolicy, 'perTurn');
  assert.equal(result.policy.recall.threshold, 0.7);
  assert.equal(result.policy.recall.tier1, 's1');
  assert.equal(result.policy.tail.k, 6);
  assert.equal(result.policy.planGate.attemptCap, 3);
  assert.equal(result.policy.s1.provider, 'laya-serve');
  assert.equal(result.policy.s1.model, 'english');
  assert.equal(result.policy.s1.retryAttempts, 3);
  // `timeoutMs` is not a policy path and must not become one: it was removed for exactly this reason.
  assert.equal('timeoutMs' in result.policy.s1, false);
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
    ['recall.threshold', 1.5],
    ['recall.threshold', 'high'],
    ['recall.depth', 0],
    ['recall.depth', 2.5],
    ['recall.budgetRatio', 1],
    ['assemblyDeadlineMs', 0],
    ['planGate.attemptCap', 0],
    ['planGate.abstainConfidence', 2],
    ['cache.blockTokens', 0],
    ['s1.questionsPerCall', 100],
    ['s1.retryAttempts', 0],
    ['s1.retryAttempts', 9],
    ['s1.retryAttempts', 2.5],
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

test('the bounded anchor wait has a default, a bound, and 0 as a real value', () => {
  // `KNOWN_PATHS` coverage in the first test is what proves the rule resolves on the default policy; this pins the
  // two facts a reader of the rule table cannot see - the default itself, and that 0 (wait disabled) is accepted
  // rather than treated as an absent value.
  assert.equal(defaultPolicy().recall.anchorWaitMs, 10_000);
  const disabled = validatePolicy({ recall: { anchorWaitMs: 0 } });
  assert.equal(disabled.ok, true);
  assert.equal(disabled.policy.recall.anchorWaitMs, 0, '0 survives validation: it is the value that turns the wait off');
  const tooLong = validatePolicy({ recall: { anchorWaitMs: 60_001 } });
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.policy.recall.anchorWaitMs, 10_000, 'and an out-of-range value falls back to the default');
});

test('the recalled-segment count floor is a settable path, bounded on both sides', () => {
  // Found by the bench/ review: the field exists on `AssemblyPolicy` and the assembler reads it, but it was missing
  // from `NUMBER_RULES` - so it was not in `KNOWN_PATHS`, no profile or preset could set it, and setting it was
  // reported as an unknown config path while the default silently stood. The bounds are pinned here rather than in
  // the rule table alone: 1 is the least that is still a selection, and the count guard is deliberately not
  // switchable off (0), because the type documents it as the guard against a selector that returned nothing.
  assert.equal(defaultPolicy().recall.minRecalledSegments, 1);
  for (const accepted of [1, 8]) {
    const result = validatePolicy({ recall: { minRecalledSegments: accepted } });
    assert.equal(result.ok, true, `${accepted} is in bounds`);
    assert.deepEqual(result.warnings, [], `${accepted} is a known path, not a typo`);
    assert.equal(result.policy.recall.minRecalledSegments, accepted, 'and it is applied, not dropped');
  }
  for (const rejected of [0, 9, 2.5]) {
    const result = validatePolicy({ recall: { minRecalledSegments: rejected } });
    assert.equal(result.ok, false, `${rejected} is out of bounds or not an integer`);
    assert.equal(result.errors[0]?.path, 'recall.minRecalledSegments');
    assert.equal(result.policy.recall.minRecalledSegments, 1, `${rejected} falls back to the default`);
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
  const warned = validatePolicy({ recoll: { threshold: 0.5 } });
  assert.equal(warned.ok, true);
  assert.equal(warned.warnings.length, 1);
  assert.match(warned.warnings[0]?.message ?? '', /unknown config key/);

  const withPluginKeys = validatePolicy({ laya: { enabled: false }, telemetry: {} }, ['laya']);
  assert.deepEqual(withPluginKeys.warnings, []);
});

test('non-object config is an error, and the rule tables stay coherent', () => {
  assert.equal(validatePolicy('C2').ok, false);
  assert.equal(validatePolicy([]).ok, false);
  for (const rule of NUMBER_RULES) {
    assert.ok(rule.min < rule.max, `${rule.path}: min must be below max`);
  }
  assert.equal(new Set(NUMBER_RULES.map((r) => r.path)).size, NUMBER_RULES.length, 'no duplicate rules');
});

test('recall selection without the state proxy warns: that pairing measured worse than the baseline, per step', () => {
  // The pairing is `tas.on: false` with `recall.tier1: 'embed'`, and no cell selects it - the arm that did was
  // dropped - so reaching it now takes two explicit knobs. That is exactly why it needs a warning rather than a
  // paragraph in a run report: a combination no preset chooses is one a profile must not choose by accident.
  // Measured in round `20261001-1300`, per step: 3 625 uncached input tokens against the baseline's 2 595,
  // 2 574 output tokens against 1 523, and a 79.2% cache hit rate against 86.7%; TAS on with recall off (cell C1)
  // measured 1 783 uncached input tokens and 1 493 output tokens per step.
  const pairing = validatePolicy({ tas: { on: false }, recall: { tier1: 'embed' } });
  assert.equal(pairing.ok, true, 'a warning and never an error: a session must not fail over a combination');
  const warning = pairing.warnings.find((issue) => issue.path === 'recall.tier1');
  assert.notEqual(warning, undefined, `the pairing must be reported: ${JSON.stringify(pairing.issues)}`);
  // Both sides of both pairs, because a warning that says "this is worse" and not "worse by how much" is the
  // kind of claim this project keeps having to retract.
  for (const [what, needle] of [
    ['the pairing hit rate', '79.2%'],
    ['the baseline hit rate', '86.7%'],
    ['the pairing uncached input per step', '3 625'],
    ['the baseline uncached input per step', '2 595'],
    ['the pairing output per step', '2 574'],
    ['the baseline output per step', '1 523'],
    ['the counterpart uncached input per step', '1 783'],
    ['the counterpart output per step', '1 493'],
  ] as const) {
    assert.ok(warning.message.includes(needle), `${what} (${needle}) belongs in the message: ${warning.message}`);
  }
  // And the quantities are the whole of it: a warning reasoned from a price-weighted share of a bill is a
  // statement about a price list, and the three token types carry three prices that differ by model and provider.
  assert.equal(/\$|USD|bill|cost|price/i.test(warning.message), false, `no currency or price scalar: ${warning.message}`);
  assert.equal(pairing.policy.tas.on, false, 'and nothing is changed: the warning is advice, not a correction');
  assert.equal(pairing.policy.recall.tier1, 'embed', 'the configured tier is kept as written');

  // Absent in all three cells, and it is the *pairing* that decides - not "S1CAP is on" and not the cell
  // name. A rule written against the cell would be a rule about a preset rather than about the mechanism.
  assert.deepEqual(validatePolicy({ cell: 'C0' }).warnings, [], 'both halves off: the baseline is not the pairing');
  assert.deepEqual(validatePolicy({ cell: 'C1' }).warnings, [], 'the stabiliser with recall off is the counterpart, not the pairing');
  assert.deepEqual(validatePolicy({ cell: 'C2' }).warnings, [], "the project's own configuration runs both halves and is silent");

  // And it follows the effective policy, so an override creates or removes it wherever the value came from.
  assert.deepEqual(
    validatePolicy({ tas: { on: true }, recall: { tier1: 'embed' } }).warnings,
    [],
    'turning the stabiliser on fixes the pairing',
  );
  assert.equal(
    validatePolicy({ cell: 'C0', recall: { tier1: 's1' } }).warnings[0]?.path,
    'recall.tier1',
    'turning recall on inside the baseline creates it, even though the baseline itself is silent',
  );
  assert.equal(
    validatePolicy({ cell: 'C2', tas: { on: false } }).warnings.filter((i) => i.path === 'recall.tier1').length,
    1,
    'and turning the stabiliser off inside the full configuration creates it too',
  );
  assert.deepEqual(
    validatePolicy({ cell: 'C1', recall: { tier1: 's1' } }).warnings,
    [],
    'while the same recall tier inside a cell that keeps tas.on is the pairing this warning is not about',
  );
});
