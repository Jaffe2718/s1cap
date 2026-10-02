import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultPolicy } from '../src/types.ts';
import { ENUM_RULES, KNOWN_PATHS, NUMBER_RULES, UNENFORCED_KNOBS, validatePolicy } from '../src/config.ts';

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
    s1: { provider: 'laya-serve', timeoutMs: 5000, questionsPerCall: 10, model: 'english', retryAttempts: 3, admissionLimit: 4 },
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
  assert.equal(result.policy.s1.provider, 'laya-serve');
  assert.equal(result.policy.s1.model, 'english');
  assert.equal(result.policy.s1.retryAttempts, 3);
  assert.equal(result.policy.s1.admissionLimit, 4);
  // `timeoutMs` is not a policy path and must not become one: it was removed for exactly this reason.
  assert.equal('timeoutMs' in result.policy.s1, false);
  // And `planGate` is not one either, as of 2026-10-02: a knob the run cannot observe is not a setting. A patch
  // that still carries one is reported as an unknown key rather than silently accepted.
  assert.equal('planGate' in result.policy, false);
  const legacy = validatePolicy({ cell: 'C2', planGate: { on: true, maxPlans: 3, attemptCap: 2, abstainConfidence: 0.5 } });
  assert.equal(legacy.ok, true, 'a removed key is a warning, not a session-breaking error');
  assert.equal(legacy.warnings.some((w) => w.path === 'planGate'), true, 'and it is named');
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
    ['s1.admissionLimit', 0],
    ['s1.admissionLimit', 65],
    ['s1.admissionLimit', 2.5],
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

/**
 * Tier-1 `embed` named a mode the build does not have, and it was accepted as if it did.
 *
 * C2's preset carried it, `defaultPolicy()` carried it, and the only read of the field anywhere in the
 * implementation was `!== 'off'` (`packages/core/src/assembler.ts`) - so the value composed, appeared in every
 * dump, and selected through the System-1 backend while the recipe named an embedder. The fix is not "name the
 * value differently somewhere else": it is that the *config* must not be able to state a mode that does not run.
 * The rejection therefore has to be an error, and it has to say why - which is what keeps it from being reverted
 * to a warning the day someone adds the value back to the enum by reflex.
 */
test('tier-1 "embed" is rejected with its own reason, not read as "not off"', () => {
  const legacy = validatePolicy({ recall: { tier1: 'embed' } });
  assert.equal(legacy.ok, false, 'a mode with no implementation is not a legal value');
  const error = legacy.errors.find((i) => i.path === 'recall.tier1');
  assert.notEqual(error, undefined, `the path must be named: ${JSON.stringify(legacy.issues)}`);
  assert.match(error?.message ?? '', /not implemented/, 'the message says the mode is missing');
  assert.match(error?.message ?? '', /no embedder or ANN index exists/, 'and what is missing, concretely');
  assert.match(error?.message ?? '', /!== "off"/, 'and the read that made it look alive');
  assert.match(error?.message ?? '', /"s1"/, 'and names the value that runs instead');
  // Fail-safe, as everywhere in this file: reported, and the cell's own value is kept - for C2 that is now `s1`,
  // so a legacy profile runs the tier its cell names rather than the one it asked for.
  assert.equal(legacy.policy.recall.tier1, 's1', 'C2 is the base policy and C2 selects with s1');
  assert.equal(validatePolicy({ cell: 'C1', recall: { tier1: 'embed' } }).policy.recall.tier1, 'off', 'a control arm falls back to its own value');
  // The generic enum path still exists for genuinely unknown strings, and the legacy sentence is not printed for
  // them: "not a value I know" and "a mode I do not implement" are different facts.
  const unknown = validatePolicy({ recall: { tier1: 'ann' } });
  assert.equal(unknown.ok, false);
  assert.match(unknown.errors[0]?.message ?? '', /must be one of s1 \| off/);
  assert.equal(/not implemented/.test(unknown.errors[0]?.message ?? ''), false);
  // And the values that do exist are accepted, applied, and silent.
  for (const value of ['s1', 'off'] as const) {
    const accepted = validatePolicy({ recall: { tier1: value } });
    assert.equal(accepted.ok, true, `${value} is implemented and must be accepted`);
    assert.equal(accepted.policy.recall.tier1, value, `${value} is applied`);
    assert.deepEqual(accepted.warnings, [], `${value} is not a warning: it is the mode that runs`);
  }
});

/**
 * `recall.embedModel` is the embed mode's model name, and nothing loads a model for it.
 *
 * It is the residue of the mode F2 removed: the field composes, is dumped with the policy, and has no reader. It
 * is warned about rather than deleted, because deleting a config path is its own decision and because a warning
 * is what makes an inert knob visible from a run instead of from a grep - the treatment `planGate`'s leftover key
 * got. The empty string stays silent: `cordis.patch.yml` ships `""`, and every `STRING_PATHS` entry documents
 * that as "not set".
 */
test('a non-empty recall.embedModel is reported as having no reader, and "" stays silent', () => {
  const named = validatePolicy({ recall: { embedModel: 'bge-small-en' } });
  assert.equal(named.ok, true, 'a knob with no reader is not a session-breaking error');
  const warning = named.warnings.find((i) => i.path === 'recall.embedModel');
  assert.notEqual(warning, undefined, `the inert key must be named: ${JSON.stringify(named.issues)}`);
  assert.match(warning?.message ?? '', /no reader/);
  assert.match(warning?.message ?? '', /not implemented/, 'and why it has none');
  assert.match(warning?.message ?? '', /"bge-small-en"/, 'and which value is being ignored');
  assert.equal(named.policy.recall.embedModel, 'bge-small-en', 'the value is kept: the warning is advice, not a correction');

  for (const empty of ['', undefined]) {
    const quiet = validatePolicy(empty === undefined ? {} : { recall: { embedModel: empty } });
    assert.equal(quiet.ok, true);
    assert.deepEqual(quiet.warnings, [], `${JSON.stringify(empty)} means "not set" and says nothing`);
  }
  // It is still a declared path, so a profile can round-trip it without being told it is a typo.
  assert.equal(KNOWN_PATHS.includes('recall.embedModel'), true, 'the inert field stays a known path, not an unknown key');
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
  // The pairing is `tas.on: false` with recall selection on (`recall.tier1: 's1'` - the only selecting value since
  // 2026-10-02; it used to be spelled `'embed'`, which named a mode nothing implements), and no cell selects it -
  // the arm that did was dropped - so reaching it now takes two explicit knobs. That is exactly why it needs a
  // warning rather than a paragraph in a run report: a combination no preset chooses is one a profile must not
  // choose by accident.
  // Measured in round `20261001-1300`, per step: 3 625 uncached input tokens against the baseline's 2 595,
  // 2 574 output tokens against 1 523, and a 79.2% cache hit rate against 86.7%; TAS on with recall off (cell C1)
  // measured 1 783 uncached input tokens and 1 493 output tokens per step.
  const pairing = validatePolicy({ tas: { on: false }, recall: { tier1: 's1' } });
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
  assert.equal(pairing.policy.recall.tier1, 's1', 'the configured tier is kept as written');

  // Absent in all three cells, and it is the *pairing* that decides - not "S1CAP is on" and not the cell
  // name. A rule written against the cell would be a rule about a preset rather than about the mechanism.
  assert.deepEqual(validatePolicy({ cell: 'C0' }).warnings, [], 'both halves off: the baseline is not the pairing');
  assert.deepEqual(validatePolicy({ cell: 'C1' }).warnings, [], 'the stabiliser with recall off is the counterpart, not the pairing');
  assert.deepEqual(validatePolicy({ cell: 'C2' }).warnings, [], "the project's own configuration runs both halves and is silent");

  // And it follows the effective policy, so an override creates or removes it wherever the value came from.
  assert.deepEqual(
    validatePolicy({ tas: { on: true }, recall: { tier1: 's1' } }).warnings,
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

/**
 * F6: the unenforced knobs are a registry, and the registry is checked against the declarations.
 *
 * The finding is "a knob that composes and does nothing": `assemblyDeadlineMs` (nothing enforces a deadline),
 * `cache.reselectPolicy` / `cache.blockTokens` (no caller for `decideReselect` / `alignToCacheBlocks`),
 * `rgMaintenance.maxLagTurns` (compared against a count of pending *events* and acted on by nothing) and
 * `recall.embedModel` (the model name of an unimplemented tier, read by nothing). Three of them survived the pass
 * that deleted the plan gate, because that removal was swept for in the presets, the schema and the report and
 * nothing swept for the rest - so the sweep is mechanical now: this test fails when the two sets drift apart, in
 * either direction.
 */
test('every declared knob is either enforced or in the unenforced registry', () => {
  const declared = new Set<string>([
    ...NUMBER_RULES.map((r) => r.path),
    ...ENUM_RULES.map((r) => r.path),
    ...KNOWN_PATHS,
  ]);
  const registered = Object.keys(UNENFORCED_KNOBS);

  for (const path of registered) {
    assert.ok(declared.has(path), `UNENFORCED_KNOBS names "${path}", which is not a declared policy path`);
    // Every entry has to resolve on the policy, or it is documenting a field that does not exist.
    let cursor: unknown = defaultPolicy();
    for (const part of path.split('.')) {
      assert.equal(typeof cursor, 'object', `unenforced path ${path} breaks at ${part}`);
      cursor = (cursor as Record<string, unknown>)[part];
    }
    assert.notEqual(cursor, undefined, `unenforced path ${path} is registered but missing from the policy`);
  }

  // The closed set, stated rather than inferred: a sixth entry is a change to what this build claims, and it has
  // to be made here on purpose. Removing an entry means the knob is enforced now, which is a stronger claim and
  // needs its own test - `recall.tier1` is the worked example: it was `embed | s1 | off` with `embed` inert, and
  // the fix was to remove the value rather than to document it (`LEGACY_TIER1` rejects it, and the union is now
  // `off | s1`), so it left this registry.
  assert.deepEqual(
    registered.sort(),
    [
      'assemblyDeadlineMs',
      'cache.blockTokens',
      'cache.reselectPolicy',
      'recall.embedModel',
      'rgMaintenance.maxLagTurns',
    ],
    'the knobs this build accepts and does not enforce - adding one, or enforcing one, is a deliberate edit here',
  );

  // Each entry has to say what it claims and what would make the claim true: a registry of bare names would repeat
  // the defect it exists to remove, which is an unenforced knob nobody can name.
  for (const [path, entry] of Object.entries(UNENFORCED_KNOBS)) {
    assert.equal(entry.enforced, false, `${path}: this registry holds unenforced knobs only`);
    assert.ok(entry.claims.length > 20, `${path}: the entry names what the knob claims`);
    assert.ok(entry.wouldNeed.length > 20, `${path}: and what it would take to enforce it`);
  }
});

test('a profile that names a knob this build does not enforce is still accepted, and the value survives', () => {
  // The registry marks the knobs; it does not reject them. A cell recipe that carries one has to keep running - the
  // alternative is a session that fails over a legal setting - and the resolved value is what `/s1` and the wiring
  // record print, so the reader can see which values were in force.
  const result = validatePolicy({
    assemblyDeadlineMs: 400,
    cache: { reselectPolicy: 'threshold', blockTokens: 128 },
    rgMaintenance: { mode: 'async', maxLagTurns: 5 },
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.policy.assemblyDeadlineMs, 400, 'the value is applied even though nothing enforces it');
  assert.equal(result.policy.cache.reselectPolicy, 'threshold');
  assert.equal(result.policy.cache.blockTokens, 128);
  assert.equal(result.policy.rgMaintenance.maxLagTurns, 5);
});
