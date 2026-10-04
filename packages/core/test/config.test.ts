import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { cellPolicy, defaultPolicy } from '../src/types.ts';
import {
  ENUM_RULES,
  KNOWN_PATHS,
  LEGACY_POLICY_KEYS,
  NUMBER_RULES,
  UNENFORCED_KNOBS,
  validatePolicy,
} from '../src/config.ts';
import { mergeCellPreset } from '../src/cell-preset.ts';

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
    recall: { threshold: 0.7, depth: 3, tier1: 's1', minRecalledShare: 0.1 },
    tail: { k: 6 },
    tracePlacement: 'trace-append',
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
  assert.equal(result.policy.tracePlacement, 'trace-append', 'the arm is settable from a profile');
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

test('the recall defaults and both of their bounds are pinned, because the values are the ablation', () => {
  // The two recall knobs are the ones a round's cost turns on, and both moved on 2026-10-05: `recall.window` from
  // 1024 to 16 (a window at or above the session's segment count scores every pair, so it saves nothing and costs
  // the full quadratic) and `recall.depth` from 2 to 16 (what a bounded walk reaches is `w x d`, and `d` costs the
  // scoring axis nothing). `docs/FORMULAS.md`'s 2026-10-05 correction carries the measurement; this test is what
  // fails if either value moves without a decision.
  //
  // The defaults are asserted **by value** rather than against `defaultPolicy()`: the first test in this file
  // already proves `validatePolicy(undefined).policy` equals the defaults, so an assertion written the other way
  // round would pass whatever the defaults became.
  assert.equal(defaultPolicy().recall.window, 16, 'the scoring window is 16, not a value no session reaches');
  assert.equal(defaultPolicy().recall.depth, 16, 'the walk depth carries the reach the window gave up');
  // The threshold is deliberately not part of this decision: it stays where the brief's reading put it.
  assert.equal(defaultPolicy().recall.threshold, 0.55);

  // `recall.window`: the floor is 4, and it is the *panel's* floor as well (`packages/dsh-plugin/src/credentials.ts`),
  // so a profile cannot write a window the settings panel would refuse. 3 is refused, so the floor is a floor.
  for (const accepted of [4, 16, 1024]) {
    const result = validatePolicy({ recall: { window: accepted } });
    assert.equal(result.ok, true, `w = ${accepted} is in bounds`);
    assert.deepEqual(result.warnings, [], `w = ${accepted} is a known path, not a typo`);
    assert.equal(result.policy.recall.window, accepted, 'and it is applied, not dropped');
  }
  for (const rejected of [3, 0, -1, 4.5]) {
    const result = validatePolicy({ recall: { window: rejected } });
    assert.equal(result.ok, false, `w = ${rejected} is out of bounds or not an integer`);
    assert.equal(result.errors[0]?.path, 'recall.window');
    assert.equal(result.policy.recall.window, 16, `w = ${rejected} falls back to the default`);
  }

  // `recall.depth`: the cap moved to 16 with the default, and 17 is refused.
  for (const accepted of [1, 8, 16]) {
    const result = validatePolicy({ recall: { depth: accepted } });
    assert.equal(result.ok, true, `d = ${accepted} is in bounds`);
    assert.deepEqual(result.warnings, [], `d = ${accepted} is a known path`);
    assert.equal(result.policy.recall.depth, accepted, 'and it is applied');
  }
  for (const rejected of [0, 17, 2.5]) {
    const result = validatePolicy({ recall: { depth: rejected } });
    assert.equal(result.ok, false, `d = ${rejected} is out of bounds or not an integer`);
    assert.equal(result.errors[0]?.path, 'recall.depth');
    assert.equal(result.policy.recall.depth, 16, `d = ${rejected} falls back to the default`);
  }

  // And the two bounds the rule table carries are the ones just exercised - a table edited without this test, or a
  // test edited without the table, fails here rather than in a round.
  const windowRule = NUMBER_RULES.find((r) => r.path === 'recall.window');
  const depthRule = NUMBER_RULES.find((r) => r.path === 'recall.depth');
  assert.deepEqual(
    { min: windowRule?.min, max: windowRule?.max },
    { min: 4, max: 1048576 },
    'recall.window is 4..1048576',
  );
  assert.deepEqual({ min: depthRule?.min, max: depthRule?.max }, { min: 1, max: 16 }, 'recall.depth is 1..16');
});

test('the cell presets carry the depth explicitly and inherit the window, which is what the change decided', () => {
  // Found by the 2026-10-05 change: all three presets wrote `"depth": 2` explicitly (so a new *default* did not
  // reach them) and none wrote `window` (so the default did). That asymmetry is a property of the presets rather
  // than of the policy, and it is exactly the kind of thing that is assumed rather than checked - a preset that
  // started carrying `window: 1024` would silently re-create the quadratic round this change removed, and one that
  // dropped `depth` would still be correct but would stop recording the value it ran.
  for (const cell of ['C0', 'C1', 'C2'] as const) {
    const preset = JSON.parse(readFileSync(new URL(`../../../bench/cells/${cell}.json`, import.meta.url), 'utf8')) as {
      recall?: Record<string, unknown>;
    };
    assert.equal(preset.recall?.['depth'], 16, `${cell} carries the depth the default also sets`);
    assert.equal('window' in (preset.recall ?? {}), false, `${cell} inherits recall.window rather than pinning it`);
    // `cellPolicy()` starts from the defaults and moves neither field, so **the preset is not where this value comes
    // from in this path** - the two agree because both are 16. The earlier wording here said the depth "resolves from
    // its own preset value", which was false: nothing in `cellPolicy` reads the file, and that gap is what
    // `mergeCellPreset` closes. The preset-driven path is asserted where it now lives, in `cell-preset.test.ts`
    // ("every shipped preset reaches the policy it declares, read from disk").
    const policy = cellPolicy(cell);
    assert.equal(policy.recall.window, 16, `${cell} resolves the window from defaultPolicy()`);
    assert.equal(policy.recall.depth, 16, `${cell} resolves the depth from defaultPolicy() as well`);
  }
});

test('a bad value is reported and the default is kept (fail-safe)', () => {
  // `recall.budgetRatio` used to be a case here (`['recall.budgetRatio', 1]`, out of `0.05..0.95`). It is not a
  // path any more: the cap it configured was removed, so there is no rule left to violate and no default to fall
  // back to. The case is deleted rather than retargeted - a test that asserted a rejection for a retired key would
  // be asserting the key still exists.
  const cases: Array<[string, unknown]> = [
    ['recall.threshold', 1.5],
    ['recall.threshold', 'high'],
    ['recall.depth', 0],
    ['recall.depth', 2.5],
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

test('the assembly trigger is a settable path whose default is the measured behaviour', () => {
  // The switch exists so a single round can assemble on every step that will issue a request instead of only on
  // the steps whose decision claims messages (round `20261003-2104`: 33 model calls, 2 assemblies). Three facts
  // have to hold for it to be a switch rather than a knob that only looks configured, and each is asserted here:
  // the default is the behaviour the brief requires, a profile can actually set the narrow value (a field
  // missing from `KNOWN_PATHS` composes, is warned about as a typo and is dropped - `deliver`'s own measured
  // history), and an unusable value keeps the default rather than half-applying.
  //
  // The default moved on 2026-10-04, from `'claimed-only'` to `'every-step'`. `'claimed-only'` assembled only on
  // steps that claimed messages, which round `20261004-0205` measured as 2 assemblies in 53 steps in C2 - the 51
  // steps of the model's own self-directed input got no recall, against the originating brief's idea 3 ("the user
  // input *or* the model's own self-directed input"). It stays a value because that round is on disk.
  assert.equal(defaultPolicy().assemblyTrigger, 'every-step', 'the brief\'s requirement is the default');
  assert.ok(KNOWN_PATHS.includes('assemblyTrigger'), 'declared, so a profile patch can set it');
  // The cell is supplied the way the runtime supplies it — its own preset under the patch — because `deliver` moved
  // out of `cellPolicy()` on 2026-10-05 and a bare `validatePolicy({ cell: 'C2' })` would leave it at the default.
  const c2Preset = JSON.parse(readFileSync(new URL('../../../bench/cells/C2.json', import.meta.url), 'utf8')) as unknown;
  const narrow = validatePolicy(mergeCellPreset({ cell: 'C2', assemblyTrigger: 'claimed-only' }, c2Preset).raw);
  assert.equal(narrow.ok, true, JSON.stringify(narrow.errors));
  assert.deepEqual(narrow.warnings, [], 'a declared path, not an unknown key');
  assert.equal(narrow.policy.assemblyTrigger, 'claimed-only', 'and the narrow value is the one applied');
  assert.equal(narrow.policy.deliver, true, 'the cell preset it was patched onto still applies');
  const bogus = validatePolicy({ assemblyTrigger: 'everyStep' });
  assert.equal(bogus.ok, false);
  assert.match(bogus.errors[0]?.message ?? '', /must be one of claimed-only \| every-step/);
  assert.equal(bogus.policy.assemblyTrigger, 'every-step', 'an unknown value keeps the default rather than half-applying');
});

test('the trace placement is a settable path, and it is enforced rather than merely registered', () => {
  // The paper's variable: Trace as State (`M([T, x, q])`, the method and the default) against Trace Append
  // (`M([x, T, q])`, the control). The two arms use the same long context and the same proxy and differ only in the
  // order of `T` and the context. Four facts make this a knob rather than a comment, and each is asserted here.
  //
  // 1. It is a declared path, so a profile patch can set it. A field missing from `KNOWN_PATHS` composes, is
  //    reported as an unknown key and is dropped - the measured way a configured experiment runs the default
  //    anyway (`deliver`'s history, and `assemblyTrigger`'s comment above).
  // 2. The default is the method under test, not "whatever ran before" (`defaultPolicy`).
  // 3. Both values are accepted and applied, and an unusable one keeps the default rather than half-applying.
  // 4. It is **enforced**, which is the property `UNENFORCED_KNOBS` exists to police: `assemble()` branches on it
  //    when it builds `layout.order`, so it is absent from that registry. The registry check below compares the two
  //    sets in both directions, so putting this in there would fail the suite rather than quietly downgrade the
  //    claim - asserted explicitly here too, because "a knob with no reader" is the failure this repository keeps
  //    re-finding under another name.
  assert.equal(defaultPolicy().tracePlacement, 'trace-as-state', 'the paper\'s method is the default arm');
  assert.ok(KNOWN_PATHS.includes('tracePlacement'), 'declared, so a profile patch can set it');
  assert.ok(ENUM_RULES.some((rule) => rule.path === 'tracePlacement'), 'and it is an enum rule with a closed value set');
  assert.equal(
    'tracePlacement' in UNENFORCED_KNOBS,
    false,
    'NOT in UNENFORCED_KNOBS: the layout computation reads it, so it is enforced',
  );

  for (const value of ['trace-as-state', 'trace-append'] as const) {
    const applied = validatePolicy({ tracePlacement: value });
    assert.equal(applied.ok, true, `${value} is a real arm: ${JSON.stringify(applied.errors)}`);
    assert.deepEqual(applied.warnings, [], `${value} is a declared path, not an unknown key`);
    assert.equal(applied.policy.tracePlacement, value, `and ${value} is the value applied`);
  }
  // The mechanism names the previous field carried are **not** values of this one. They described where `T` sat
  // rather than which arm was running, which is the whole distinction this rename exists to make: accepting them as
  // aliases would keep a round's record saying "before-context" instead of naming the condition it ran. A profile
  // that still uses the old *key* is translated and told so (the test below); a profile that uses the old key with a
  // value that is not one of its two, keeps the default.
  for (const bad of ['before-context', 'after-context', 'state', 'append', '', 0, true]) {
    const rejected = validatePolicy({ tracePlacement: bad });
    assert.equal(rejected.ok, false, `${JSON.stringify(bad)} is not an arm`);
    assert.equal(rejected.errors[0]?.path, 'tracePlacement');
    assert.equal(rejected.policy.tracePlacement, 'trace-as-state', `${JSON.stringify(bad)} keeps the default arm`);
  }
});

/**
 * The question's position is **not** a setting any more (deleted 2026-10-05), and this test replaces one that
 * asserted it was.
 *
 * **The old assertion was wrong, not stale.** It pinned `questionPlacement` as a declared path with `'first'` a
 * legal, applied, recorded value — described in its own comment as "a layout the paper has no condition for" — and
 * that description is the defect: the paper separates the question from the long context and places it "at the end
 * of every input", so a field whose other value lays out `[T, q, x]` does not make the question a variable, it makes
 * a layout the paper does not have reachable by configuration. Keeping the assertion would have kept that
 * capability documented and tested.
 *
 * What replaces it is the surface the deletion has to leave behind: the key is gone from every declared path, from
 * the enum rules and from the unenforced registry (a registered path that is not declared fails the check below),
 * and the one layout field that remains is the arm. The *reading* of the old spellings is the next test's subject.
 */
test('the question\'s position is not a declared path any more, and the arm is the only layout field', () => {
  assert.equal('questionPlacement' in defaultPolicy(), false, 'deleted from the policy');
  assert.equal(KNOWN_PATHS.includes('questionPlacement'), false, 'and from everything a profile patch may set');
  assert.equal(ENUM_RULES.some((rule) => rule.path === 'questionPlacement'), false, 'and from the enum rules');
  assert.equal(KNOWN_PATHS.includes('tracePlacement'), true, 'while the arm stays a settable path');
  for (const cell of ['C0', 'C1', 'C2'] as const) {
    const p = cellPolicy(cell);
    assert.equal('questionPlacement' in p, false, `${cell}: no cell carries a question position`);
    assert.equal(typeof p.tracePlacement, 'string', `${cell}: the arm is the layout field the cell states`);
  }
  // Nothing else moved with it: a profile that sets the arm still composes with its cell.
  const composed = validatePolicy({ cell: 'C2', tracePlacement: 'trace-append' });
  assert.equal(composed.ok, true, JSON.stringify(composed.errors));
  assert.equal(composed.policy.tracePlacement, 'trace-append', 'the control arm is reachable');
  assert.equal(composed.policy.tas.on, true, 'while the rest of the cell still applies');
});

/**
 * The retired layout keys, and why the two values of one of them are treated differently.
 *
 * `xFirst: boolean` and `stateProxyPosition: 'before-context' | 'after-context'` were the layout surface until
 * 2026-10-05, and `xFirst` was renamed to `questionPlacement` before that field was deleted later the same day. The
 * question this test answers is what a profile that still carries any of those spellings gets:
 *
 *   - `xFirst: false` ("question last") and `stateProxyPosition` name a real setting with one unambiguous successor —
 *     a translation, reported as a warning with both spellings, so a profile that is merely out of date keeps
 *     running *and* is told what changed. Dropping them would silently run the default, which is the failure this
 *     project keeps measuring: a key that looks configured and resolves to nothing.
 *   - `xFirst: true` ("question first", `[T, q, x]`) names a layout this build **cannot produce**. It is refused
 *     with an error carrying the paper sentence that retired it, because there is nothing to translate it into: a
 *     warning would let the file keep asking for a deleted layout while the session silently laid out another one,
 *     which is exactly the "composes, appears in every dump, is never read" shape this repository keeps removing.
 *     An error is still fail-safe here — the resolved policy keeps its defaults and the session runs.
 */
test('a retired layout key is read and reported, and the question-first value is refused rather than coerced', () => {
  const harmless = validatePolicy({ cell: 'C2', xFirst: false });
  assert.equal(harmless.ok, true, 'the question-last spelling asks for what every layout does, so it is not an error');
  const note = harmless.warnings.find((issue) => issue.path === 'xFirst');
  assert.notEqual(note, undefined, `the retirement must be named: ${JSON.stringify(harmless.issues)}`);
  assert.match(note?.message ?? '', /retired/, 'as a retirement, not as a rename into a live field');
  assert.match(note?.message ?? '', /place it at the end of every input|end of every input/, 'with the paper sentence');
  assert.match(note?.message ?? '', /tracePlacement/, 'and the axis that exists instead');
  assert.equal('questionPlacement' in harmless.policy, false, 'nothing is written for it: there is no field');

  // The retired value itself, and the spellings a hand-written patch is likely to carry for it (the panel's old
  // command line accepted `on`/`off`, and `1`/`yes` were the same setting in a stored string).
  for (const value of [true, 'on', '1', 'yes'] as const) {
    const refused = validatePolicy({ cell: 'C2', xFirst: value });
    assert.equal(refused.ok, false, `xFirst: ${JSON.stringify(value)} must be refused, not dropped`);
    const error = refused.errors.find((issue) => issue.path === 'xFirst');
    assert.notEqual(error, undefined, `the key must be named: ${JSON.stringify(refused.issues)}`);
    assert.match(error?.message ?? '', /cannot produce/, 'the message says the layout is not producible');
    assert.match(error?.message ?? '', /\[T, q, x\]/, 'and names the order it asked for');
    assert.match(error?.message ?? '', /place it at the end of every input/, 'and quotes the sentence that retired it');
    assert.match(error?.message ?? '', /arXiv:2609\.02702/, 'with the paper it comes from');
    assert.match(error?.message ?? '', /tracePlacement/, 'and the setting that exists instead');
    // Refused rather than coerced: no field is written for it, and the rest of the profile still applies.
    assert.equal('questionPlacement' in refused.policy, false, 'no question position is written');
    assert.equal(refused.policy.tas.on, true, 'the cell the profile patched still applies');
    assert.equal(refused.policy.tracePlacement, 'trace-as-state', 'and the arm is untouched');
  }

  // The spelling the rename itself introduced is the same request under a newer name, so it gets the same treatment.
  const renamedFirst = validatePolicy({ questionPlacement: 'first' });
  assert.equal(renamedFirst.ok, false, 'the newer spelling of the deleted layout is refused too');
  assert.equal(renamedFirst.errors[0]?.path, 'questionPlacement', 'under its own key');
  assert.match(renamedFirst.errors[0]?.message ?? '', /place it at the end of every input/);
  const renamedLast = validatePolicy({ questionPlacement: 'last' });
  assert.equal(renamedLast.ok, true, 'while the question-last spelling is harmless and reported');
  assert.ok(renamedLast.warnings.some((issue) => issue.path === 'questionPlacement'));

  // `stateProxyPosition` is a genuine rename with a live successor: translated, applied, reported. Its order is the
  // same one as the value it maps to *because* the question is last in both, which is the note in the table.
  const armByOldKey = validatePolicy({ cell: 'C2', stateProxyPosition: 'after-context' });
  assert.equal(armByOldKey.ok, true);
  assert.equal(armByOldKey.policy.tracePlacement, 'trace-append', 'after-context was Trace Append, and still is');
  assert.ok(
    armByOldKey.warnings.some((issue) => issue.path === 'stateProxyPosition'),
    'reported as a rename, like the other key',
  );
  assert.equal(
    validatePolicy({ stateProxyPosition: 'before-context' }).policy.tracePlacement,
    'trace-as-state',
    'before-context was Trace as State',
  );

  // A retired key is never *also* reported as an unknown key: one sentence per key, or a reader cannot tell whether
  // the value was ignored or read. That is what `allowedTop` in `validatePolicy` is for.
  const both = validatePolicy({ xFirst: false, stateProxyPosition: 'after-context', questionPlacement: 'last' });
  assert.equal(
    both.issues.filter((issue) => /unknown config key/.test(issue.message)).length,
    0,
    `no retired spelling is reported as a typo: ${JSON.stringify(both.issues)}`,
  );

  // A value the *retired* key cannot read at all is refused as well: with no successor field there is nothing to
  // fall back to, and a warning would leave the file asking for something this build cannot answer.
  const unusable = validatePolicy({ xFirst: 'perhaps' });
  assert.equal(unusable.ok, false);
  assert.equal(unusable.errors[0]?.path, 'xFirst');
  assert.match(unusable.errors[0]?.message ?? '', /retired, and unusable/);
  // The rename with a live successor keeps its old, softer behaviour for an unreadable value: dropped, warned about,
  // and the key still named — a profile that wrote a value this key never had is not asking for a deleted layout.
  const unusableArm = validatePolicy({ stateProxyPosition: 'sideways' });
  assert.equal(unusableArm.ok, true);
  assert.ok(unusableArm.warnings.some((issue) => issue.path === 'stateProxyPosition' && /unusable/.test(issue.message)));
});

/**
 * The per-node expansion cap is **retired** (2026-10-05), and a profile that still writes it is told so.
 *
 * `recall.fanout` (`k`) bounded how many neighbours each node of the recall walk expanded, sorted by weight. It is
 * removed because it was never in the originating brief, never in the tape's `kind:"wiring"` record, and never in
 * the settings panel - its only home was the three cell presets. **This test's subject is the reporting, not the
 * removal:** a key that is deleted while a stored profile still writes it is how a saved line turns into different
 * behaviour without a word, which is the failure `LEGACY_LAYOUT_KEYS` was built for and the reason the table was
 * widened to `LEGACY_POLICY_KEYS` rather than a second mechanism being invented beside it.
 *
 * Three things are asserted, and each is a property rather than a spelling: the key is gone from everything a
 * profile may set; a profile carrying it is warned about by name, with the sentence naming what replaced it; and
 * the retirement is a **warning**, not an error, because the request it carried *is* answerable - by
 * `recall.threshold`, the brief's own knob - which is what separates it from `xFirst: true` (a condition this
 * build cannot produce) and keeps a session from failing over a config it can honour.
 */
test('the retired per-node cap is reported by name, and points at recall.threshold', () => {
  // Gone from every declared surface. The `KNOWN_PATHS` sweep in the first test is what proves no rule still
  // resolves it; these two pin the absence explicitly, so a future rule table cannot quietly readmit it.
  assert.equal('fanout' in defaultPolicy().recall, false, 'removed from AssemblyPolicy.recall');
  assert.equal(KNOWN_PATHS.includes('recall.fanout'), false, 'and from every path a profile patch may set');
  assert.equal(NUMBER_RULES.some((rule) => rule.path === 'recall.fanout'), false, 'and from the numeric rules');
  for (const cell of ['C0', 'C1', 'C2'] as const) {
    assert.equal('fanout' in cellPolicy(cell).recall, false, `${cell}: no cell carries the cap`);
  }
  // The key the validator actually reads is the dotted one, which is what a profile writes: `recall: { fanout: 8 }`.
  assert.ok(
    LEGACY_POLICY_KEYS.some((entry) => entry.key === 'recall.fanout'),
    'and it is in the retirement table, which is what turns a stale line into a sentence',
  );

  const stale = validatePolicy({ cell: 'C2', recall: { fanout: 8, threshold: 0.7 } });
  assert.equal(stale.ok, true, 'a retired knob must not break a session');
  const note = stale.warnings.find((issue) => issue.path === 'recall.fanout');
  assert.notEqual(note, undefined, `the retirement must be named: ${JSON.stringify(stale.issues)}`);
  assert.match(note?.message ?? '', /retired/, 'as a retirement');
  // The value is named as written: a number, because that is what the profile carried. The quoted form the other
  // two tables use ("8") would be a different claim from `JSON.stringify(8)`, and the reader is repairing a file.
  assert.match(note?.message ?? '', /: 8 is retired/, 'naming the value that was written');
  assert.match(note?.message ?? '', /never in the originating brief/, 'and that the brief never asked for it');
  assert.match(note?.message ?? '', /no record and no panel/, 'and that no record and no panel carried it');
  // The measurement that retired it, with both of its numbers: the agreement, and the disagreement.
  assert.match(note?.message ?? '', /63\.2 %/, 'the share of anchors whose reachable sets agree');
  assert.match(note?.message ?? '', /84 of 228/, 'and the anchors that differ');
  // The cost of removing it, rather than a claim that there is none.
  assert.match(note?.message ?? '', /\+27/, 'the median segment growth where the cap bit');
  assert.match(note?.message ?? '', /\+69/, 'and the worst case');
  // And the knob that does the job now, named so the reader can act on the sentence.
  assert.match(note?.message ?? '', /recall\.threshold/, 'the setting that replaced it');
  assert.match(note?.message ?? '', /cannot be computed from the old/, 'with the reason its old value does not carry over');
  // Fail-safe: the rest of the profile applies, the retired field is absent from the resolved policy, and the value
  // is *read* rather than crashing anything.
  assert.equal(stale.policy.recall.threshold, 0.7, 'the keys beside it still apply');
  assert.equal('fanout' in stale.policy.recall, false, 'and nothing is written for the retired key');
  // One sentence per key: it is not *also* reported as a typo. `recall` is a declared top-level key, so the
  // unknown-key loop never sees `fanout` at all - which is exactly why the table below it is load-bearing rather
  // than belt-and-braces.
  assert.equal(
    stale.issues.filter((issue) => /unknown config key/.test(issue.message)).length,
    0,
    `no retired spelling is reported as a typo: ${JSON.stringify(stale.issues)}`,
  );
  // Every value the key could take gets the same sentence: the cap is gone as a *setting*, so there is no value
  // left to compare against the old ones - which is why `values` is empty for it and why the generic
  // "retired, and unusable" branch (which would call the value unreadable) must not be the one that answers.
  for (const value of [1, 8, 64, 0, 'eight'] as const) {
    const each = validatePolicy({ recall: { fanout: value } });
    assert.equal(each.ok, true, `${JSON.stringify(value)} is reported, not rejected`);
    assert.deepEqual(
      each.warnings.map((issue) => issue.path),
      ['recall.fanout'],
      `${JSON.stringify(value)} gets exactly the retirement sentence`,
    );
    assert.equal(
      /unusable/.test(each.warnings[0]?.message ?? ''),
      false,
      'and never the "not one of the old values" wording, which would be false here',
    );
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

test('a retired *nested* key is ignored in silence, and the silence is pinned here on purpose', () => {
  // `recall.budgetRatio` was a declared path until the cap it configured was removed (2026-10-05,
  // `packages/core/src/types.ts` - `AssemblyPolicy.recall`). Deleting a path is not the same as retiring a *key*:
  // `validatePolicy` checks unknown keys only at the top level (`KNOWN_TOP_LEVEL`), so a profile that still writes
  // `recall: { budgetRatio: 0.35 }` - `packages/dsh-plugin/cordis.patch.yml` does, line 62 - passes validation
  // with no warning, and the value it carries buys nothing. This test states that reading rather than leaving it to
  // be rediscovered as a mystery, and it is the reason the retirement is also recorded beside the rule table
  // (`packages/core/src/config.ts`).
  //
  // It fails if someone adds nested-key checking: that would be a *better* validator, and this expectation (with
  // the comment above it) is then the thing to change, deliberately, rather than a surprise.
  const stale = validatePolicy({ recall: { budgetRatio: 0.35, threshold: 0.7 } });
  assert.equal(stale.ok, true, 'a retired key must not break a session');
  assert.deepEqual(stale.warnings, [], 'and nothing names it: nested keys are not checked for staleness');
  assert.equal('budgetRatio' in stale.policy.recall, false, 'the retired path is gone from the resolved policy');
  assert.equal(stale.policy.recall.threshold, 0.7, 'while the keys beside it still apply');

  // The contrast that makes the silence a property of the *shape* and not of the key: the same key one level up is
  // reported, because top-level keys are checked.
  const topLevel = validatePolicy({ budgetRatio: 0.35 });
  assert.equal(topLevel.warnings.length, 1);
  assert.match(topLevel.warnings[0]?.message ?? '', /unknown config key/);
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
