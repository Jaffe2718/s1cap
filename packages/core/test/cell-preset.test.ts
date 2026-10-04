import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mergeCellPreset, CELL_PRESET_META_KEY } from '../src/cell-preset.ts';
import { validatePolicy } from '../src/config.ts';
import { cellPolicy, defaultPolicy } from '../src/types.ts';
import type { Cell } from '../src/types.ts';

/**
 * `bench/cells/<cell>.json` is a layer of the policy, not a description of one.
 *
 * The measurements these tests exist for, both taken on 2026-10-05:
 *
 *   - `bench/cells/C2.json` was given `recall.threshold: 0.6` and the round that followed ran **0.55**, because
 *     nothing loaded the file. `cellPolicy('C2')` moves neither the threshold nor the window, so the policy came
 *     from `defaultPolicy()` and the preset was decoration.
 *   - `scripts/check-doc-pointers.mjs`'s `effectivePolicy()` merges the preset over `cellPolicy(cell)` and calls
 *     the result "the policy a cell actually runs" — so every documented value was being checked against a policy
 *     the runtime did not have.
 *
 * The end-to-end test at the bottom reads the real files, so a preset edited by hand and a policy resolved by the
 * build cannot part company without this going red.
 */

function presetOf(cell: Cell): unknown {
  return JSON.parse(readFileSync(new URL(`../../../bench/cells/${cell}.json`, import.meta.url), 'utf8'));
}

test('the preset is the base and the profile patch still wins', () => {
  const merged = mergeCellPreset(
    { cell: 'C2', recall: { threshold: 0.7 } },
    { _meta: { role: 'x' }, cell: 'C2', recall: { threshold: 0.6, depth: 16 } },
  );
  assert.deepEqual(merged.issues, [], 'a matching cell with ordinary keys reports nothing');
  assert.equal(merged.raw['cell'], 'C2');
  assert.deepEqual(merged.raw['recall'], { threshold: 0.7, depth: 16 },
    'the patch threshold replaces the preset one and the preset depth survives — a layer merge, not a replace');
  assert.deepEqual(merged.fromPreset, ['cell', 'recall.depth', 'recall.threshold']);
  assert.deepEqual(merged.overridden, ['recall.threshold'],
    'both layers supplying a leaf is the case where "which value ran" was unknowable before — `cell` is excluded ' +
    'because it names the file and is checked by identity, not by a rule');
});

test('a preset is not allowed to name a different cell than the profile asks for', () => {
  const merged = mergeCellPreset({ cell: 'C0' }, { cell: 'C2', recall: { tier1: 's1' } });
  assert.equal(merged.issues.length, 1, 'a mismatched preset is reported');
  assert.equal(merged.issues[0]?.path, 'cell');
  assert.match(merged.issues[0]?.message ?? '', /tells? cell C2 but the profile asks for C0|says cell C2 but the profile asks for C0/);
});

test('_meta is bookkeeping, never policy, and never reaches the merged config', () => {
  const merged = mergeCellPreset({ cell: 'C2' }, { _meta: { recallThreshold: 'a note, not a value' }, cell: 'C2' });
  assert.equal(CELL_PRESET_META_KEY in merged.raw, false, 'the merged config has no _meta at all');
  assert.equal(merged.fromPreset.includes('_meta'), false, 'and the provenance does not claim it supplied one');
});

test('an absent preset is not an error, a malformed one is', () => {
  const absent = mergeCellPreset({ cell: 'C2' }, undefined);
  assert.deepEqual(absent.issues, []);
  assert.deepEqual(absent.fromPreset, []);
  assert.equal(absent.cell, 'C2');

  const broken = mergeCellPreset({ cell: 'C2' }, 'C2.json');
  assert.equal(broken.issues.length, 1);
  assert.match(broken.issues[0]?.message ?? '', /rather than an object/);
});

test('the preset reaches the policy through the one rule table, and the cell code no longer decides alone', () => {
  // The whole point. `cellPolicy('C2')` resolves the threshold to the default; the preset says otherwise, and
  // after the merge the resolved policy is the preset's value.
  assert.equal(cellPolicy('C2').recall.threshold, defaultPolicy().recall.threshold,
    'the hardcoded cell does not move the threshold — that is why the preset had to become a layer');

  const preset = presetOf('C2') as Record<string, unknown>;
  const merged = mergeCellPreset({ cell: 'C2' }, preset);
  const result = validatePolicy(merged.raw);
  assert.deepEqual(result.errors, [], 'the shipped preset validates cleanly');
  assert.equal(result.policy.recall.threshold, 0.6, 'the value in the JSON is the value the policy carries');
  assert.equal(merged.overridden.length, 0, 'with no patch, the preset is not overridden by anything');
});

test('every shipped preset reaches the policy it declares, read from disk', () => {
  for (const cell of ['C0', 'C1', 'C2'] as const) {
    const preset = presetOf(cell) as Record<string, unknown>;
    const merged = mergeCellPreset({ cell }, preset);
    assert.deepEqual(merged.issues, [], `${cell}: the shipped preset and its own name agree`);

    const result = validatePolicy(merged.raw);
    assert.deepEqual(result.errors, [], `${cell}: the shipped preset validates`);

    // Compare the resolved policy against the preset leaf by leaf — the check that was missing, and the reason a
    // hand-edit to the JSON could go unread for a whole round.
    const p = result.policy as unknown as Record<string, unknown>;
    for (const path of merged.fromPreset) {
      if (path === 'cell') continue;
      const want = path.split('.').reduce<unknown>((acc, part) => (acc as Record<string, unknown>)?.[part], merged.raw);
      const got = path.split('.').reduce<unknown>((acc, part) => (acc as Record<string, unknown>)?.[part], p);
      assert.deepEqual(got, want, `${cell}: ${path} in the JSON must be the value the policy carries`);
    }
  }
});

test('a preset key the build does not know is an error, not a value dropped in silence', () => {
  // The failure this closes, measured on 2026-10-05: `validatePolicy` walks the *top level* for unknown keys, so a
  // typo inside a known section (`recall.thrsehold`) produced **no warning at all** and simply did not apply — the
  // policy kept its default and nothing in any record said a value had been written and ignored. A preset is this
  // project's own file, so the same mistake there is an error rather than a warning: the file and the build
  // disagree, and a round that ran anyway would be running a policy nobody wrote.
  const merged = mergeCellPreset({ cell: 'C2' }, { cell: 'C2', recall: { thrsehold: 0.6 } });
  assert.equal(merged.issues.length, 1, 'the typo is named');
  assert.equal(merged.issues[0]?.path, 'recall.thrsehold', 'by its full path, not by its section');
  assert.equal(merged.issues[0]?.severity, 'error');

  // And the claim the old behaviour made silently is stated here instead: the typo changes nothing.
  const result = validatePolicy(merged.raw);
  assert.equal(result.policy.recall.threshold, defaultPolicy().recall.threshold,
    'the typo still changed nothing — but now a record says so');
});

test('the strict path check does not fire on a section the caller declared', () => {
  // `laya` and `telemetry` are the plugin's own keys, not policy. A preset under one of them is not this build's
  // business and must not be reported, which is why the caller can name them.
  const strict = mergeCellPreset({ cell: 'C2' }, { cell: 'C2', laya: { enabled: true } });
  assert.equal(strict.issues.length, 1, 'without the declaration it is reported');

  const declared = mergeCellPreset({ cell: 'C2' }, { cell: 'C2', laya: { enabled: true } }, { extraTopLevel: ['laya'] });
  assert.deepEqual(declared.issues, [], 'and with it, it is not');
});
