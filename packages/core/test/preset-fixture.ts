/**
 * The policy a cell runs, resolved the way the runtime resolves it — for tests.
 *
 * `cellPolicy(cell)` no longer answers this question and is not a substitute: since 2026-10-05 it returns
 * `defaultPolicy()` with the cell's name stamped on it, because a cell's configuration moved into
 * `bench/cells/<cell>.json` (see `packages/core/src/types.ts` above `cellPolicy`). A test that asks for "C0's
 * policy" and gets the defaults would be asserting the wrong thing while looking like it asserts the right one —
 * which is exactly what happened when the move landed: eight tests that read C0/C1's switches off `cellPolicy()`
 * began to read the defaults instead.
 *
 * So the fixture reads the file the same way `setup.mjs` copies it and `resolvePluginConfig` folds it in, and a
 * preset edited by hand changes what these tests see.
 */
import { readFileSync } from 'node:fs';
import { cellPolicyFromPreset, mergeCellPreset } from '../src/cell-preset.ts';
import { validatePolicy } from '../src/config.ts';
import type { ValidationResult } from '../src/config.ts';
import type { AssemblyPolicy, Cell } from '../src/types.ts';

/** The parsed contents of `bench/cells/<cell>.json`, verbatim — `_meta` included, as a loader would hand it over. */
export function presetOf(cell: Cell): unknown {
  return JSON.parse(readFileSync(new URL(`../../../bench/cells/${cell}.json`, import.meta.url), 'utf8')) as unknown;
}

/**
 * @param extra stands for the profile patch: keys folded in last, so a test can say "this cell, with this deviation"
 *   in one call instead of assembling three layers by hand.
 */
export function cellPolicyOf(cell: Cell, extra: Record<string, unknown> = {}): AssemblyPolicy {
  return cellPolicyFromPreset(cell, presetOf(cell), { extra });
}

/**
 * The whole validation **result** for a cell plus its preset, for tests that assert what the validator says
 * (warnings, errors, fail-safe fallbacks) rather than only what the policy ends up as.
 *
 * It exists because several of those assertions read the cell's switches: `validatePolicy({ cell: 'C0' })` alone
 * applies no preset, so since 2026-10-05 it describes the defaults with a name on them and not the baseline. A test
 * that means "the baseline" has to hand the validator the file that says what the baseline is.
 */
export function resolveWithPreset(cell: Cell, extra: Record<string, unknown> = {}): ValidationResult {
  const merged = mergeCellPreset({ cell, ...extra }, presetOf(cell), {
    extraTopLevel: ['laya', 'telemetry', 'enabled', 'observation'],
  });
  return validatePolicy(merged.raw, ['laya', 'telemetry', 'enabled', 'observation']);
}
