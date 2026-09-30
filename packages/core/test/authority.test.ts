import test from 'node:test';
import assert from 'node:assert/strict';

import { cellPolicy, defaultPolicy } from '../src/types.ts';
import { validatePolicy } from '../src/config.ts';
import type { Cell } from '../src/types.ts';
import { AttemptController, orderPlans } from '../src/plan-gate.ts';

const CELLS: Cell[] = ['C1', 'C2', 'C3', 'C4'];

test('the loop is model-owned and the hook is bounded, in every cell (policy literals)', () => {
  const p = defaultPolicy();
  assert.equal(p.termination, 'model-owned');
  assert.equal(p.rgMaintenance.mode, 'async');
  assert.ok(p.assemblyDeadlineMs > 0 && p.assemblyDeadlineMs <= 2000, 'the sync hook needs a hard deadline');

  for (const cell of CELLS) {
    const cp = cellPolicy(cell);
    assert.equal(cp.termination, 'model-owned', `${cell}: S1CAP never owns termination`);
    assert.equal(cp.rgMaintenance.mode, 'async', `${cell}: graph upkeep stays off the critical path`);
    assert.ok(cp.rgMaintenance.maxLagTurns >= 0);
  }
});

/**
 * The ablation has to be able to say what it measured.
 *
 * `xFirst` was left at the policy default in all four cells, so C1 and C3 - the two chronological cells - carried
 * the same position intervention as C2 and C4, the two ordered ones. The layout axis was therefore constant
 * across the whole 2x2 and no table could have attributed anything to it, which is invisible from the presets
 * alone: each cell looked individually correct.
 */
test('the layout axis actually varies across the ablation, in the direction the cells are named for', () => {
  const chronological: Cell[] = ['C1', 'C3'];
  const ordered: Cell[] = ['C2', 'C4'];
  for (const cell of chronological) {
    assert.equal(cellPolicy(cell).xFirst, false, `${cell} is a chronological cell: x belongs after the recalled block`);
  }
  for (const cell of ordered) {
    assert.equal(cellPolicy(cell).xFirst, true, `${cell} is an ordering cell: x-first is the intervention`);
  }
  // And the two factors stay orthogonal: within each layout, the other axis still varies.
  assert.equal(cellPolicy('C1').recall.tier1 !== cellPolicy('C3').recall.tier1, true, 'tier1 varies within the chronological pair');
  assert.equal(cellPolicy('C2').tas.on !== cellPolicy('C4').tas.on, false, 'C2 and C4 both order by TAS');
  assert.equal(cellPolicy('C2').planGate.on !== cellPolicy('C4').planGate.on, true, 'the gate varies within the ordered pair');
});

test('every cell leaves the assembled layout readable, whichever side x lands on', () => {
  for (const cell of CELLS) {
    const p = cellPolicy(cell);
    assert.equal(typeof p.xFirst, 'boolean', `${cell}: the layout is a real branch, not an omission`);
    assert.equal(p.cell, cell, `${cell}: the record says which cell produced it`);
  }
});

/**
 * A cell that exists in the type and in the preset, and in neither of the two places that decide what runs, is
 * worse than a cell that does not exist: it looks configured.
 *
 * `deliver` was added to `AssemblyPolicy` and to `cellPolicy` in the N6 commit, and to neither `BOOLEAN_PATHS`
 * nor the runtime's base policy. A live C4 session then reported `policy.deliver is off` on all twelve steps,
 * with 8 of 12 assemblies carrying a non-empty recalled block: the content was assembled, delivered nowhere, and
 * the record only said "off" because the cell name in the log is the cell *asked for*, not the policy that ran.
 */
test('a cell preset is what the runtime actually starts from, and an override still wins', () => {
  // C1 is the baseline: no TAS, no selection, no gate, chronological, and it delivers nothing.
  const c1 = validatePolicy({ cell: 'C1' });
  assert.equal(c1.ok, true, JSON.stringify(c1.errors));
  assert.equal(c1.policy.tas.on, false, 'C1 must not order by TAS');
  assert.equal(c1.policy.recall.tier1, 'off', 'C1 must not select');
  assert.equal(c1.policy.planGate.on, false, 'C1 has no gate');
  assert.equal(c1.policy.xFirst, false, 'C1 is chronological');
  assert.equal(c1.policy.deliver, false, 'C1 is the only cell that leaves history to the harness');

  // C3 is the arm that must be able to say "S1 governance only".
  const c3 = validatePolicy({ cell: 'C3' });
  assert.equal(c3.policy.recall.tier1, 'embed', 'C3 selects');
  assert.equal(c3.policy.planGate.on, true, 'C3 gates');
  assert.equal(c3.policy.tas.on, false, 'C3 does not order by TAS');
  assert.equal(c3.policy.xFirst, false, 'C3 is chronological');
  assert.equal(c3.policy.deliver, true, 'and it delivers what it selected, or it measures nothing');

  // C2/C4: ordered, and delivering.
  for (const cell of ['C2', 'C4'] as Cell[]) {
    const p = validatePolicy({ cell }).policy;
    assert.equal(p.tas.on, true, `${cell} orders by TAS`);
    assert.equal(p.xFirst, true, `${cell} is x-first`);
    assert.equal(p.deliver, true, `${cell} delivers`);
  }

  // Precedence: the cell is the base, an explicit knob in the patch is the deviation, and it wins.
  const deviated = validatePolicy({ cell: 'C3', deliver: false, xFirst: true });
  assert.equal(deviated.policy.deliver, false, 'a patch may turn delivery off on purpose');
  assert.equal(deviated.policy.xFirst, true, 'and may reorder a cell it disagrees with');
  assert.equal(deviated.policy.recall.tier1, 'embed', 'while the rest of the cell still applies');

  // A cell that is not a cell is an error, and falls back to C4 rather than to half a cell.
  const bogus = validatePolicy({ cell: 'C9' });
  assert.equal(bogus.ok, false);
  assert.equal(bogus.policy.cell, 'C4', 'an unusable cell name costs the C4 defaults, not a partial cell');
});

test('the gate never invents a plan: an empty model plan list stays empty', () => {  const decision = orderPlans([], [], 0.5);
  assert.deepEqual(decision.order, []);
  assert.equal(decision.abstained, true, 'nothing to order means: keep the model order (nothing)');
});

test('the gate only reorders what the model produced', () => {
  const plans = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const decision = orderPlans(
    plans,
    [
      { id: 'b', prob: 0.7, confidence: 0.8 },
      { id: 'a', prob: 0.2, confidence: 0.8 },
      { id: 'c', prob: 0.1, confidence: 0.8 },
    ],
    0.5,
  );
  assert.deepEqual([...decision.order].sort(), ['a', 'b', 'c']);
  assert.equal(decision.order[0], 'b');
});

test('the attempt controller stops at the cap, at the end of the model list, or on a model stop', () => {
  const capped = new AttemptController(['a', 'b', 'c'], 2);
  assert.equal(capped.next(), 'a');
  capped.record('a', false);
  assert.equal(capped.next(), 'b');
  capped.record('b', false);
  assert.equal(capped.next(), undefined, 'cap reached — the gate hands out nothing more');
  assert.equal(capped.attempts, 2);
  assert.deepEqual(capped.unexecuted(), ['c']);

  const exhausted = new AttemptController(['a'], 5);
  assert.equal(exhausted.next(), 'a');
  exhausted.record('a', false);
  assert.equal(exhausted.next(), undefined, 'the model offered one plan; S1CAP has nothing to add');

  const empty = new AttemptController([], 3);
  assert.equal(empty.next(), undefined);

  const stopped = new AttemptController(['a', 'b'], 2);
  stopped.stop();
  assert.equal(stopped.next(), undefined, "the model's stop outranks remaining plans");
  assert.deepEqual(stopped.unexecuted(), ['a', 'b']);

  const won = new AttemptController(['a', 'b'], 2);
  assert.equal(won.next(), 'a');
  won.record('a', true);
  assert.equal(won.next(), undefined, 'success ends the loop');
  assert.equal(won.succeeded, 'a');
  assert.deepEqual(won.unexecuted(), ['b']);
});
