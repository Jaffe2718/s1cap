import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultPolicy } from '../src/types.ts';
import { validatePolicy } from '../src/config.ts';
import { cellPolicyOf, resolveWithPreset } from './preset-fixture.ts';
import type { Cell } from '../src/types.ts';
import { AttemptController, orderPlans } from '../src/plan-gate.ts';

const CELLS: Cell[] = ['C0', 'C1', 'C2'];

test('the loop is model-owned and the hook is bounded, in every cell (policy literals)', () => {
  const p = defaultPolicy();
  assert.equal(p.termination, 'model-owned');
  assert.equal(p.rgMaintenance.mode, 'async');
  assert.ok(p.assemblyDeadlineMs > 0 && p.assemblyDeadlineMs <= 2000, 'the sync hook needs a hard deadline');

  for (const cell of CELLS) {
    const cp = cellPolicyOf(cell);
    assert.equal(cp.termination, 'model-owned', `${cell}: S1CAP never owns termination`);
    assert.equal(cp.rgMaintenance.mode, 'async', `${cell}: graph upkeep stays off the critical path`);
    assert.ok(cp.rgMaintenance.maxLagTurns >= 0);
  }
});

/**
 * The ablation has to be able to say what it measured.
 *
 * **Rewritten 2026-10-05, twice in one day, and both old assertions were wrong rather than stale.** The first
 * required the *question's* position to vary across the ablation — `xFirst: false` for C0 and `xFirst: true` for
 * C1/C2 — on the argument that a layout axis constant across every cell could not be attributed to anything. The
 * argument was sound and the variable was the wrong one: the paper holds the question last in all three of its
 * conditions and varies where the *trace* sits, so the axis that had to vary was `tracePlacement`, and what the old
 * test called "the intervention" was the project recording a layout the paper does not have in every cell.
 * `tracePlacement` is asserted constant here for the opposite reason: it is the paper's contrast, both arms must be
 * runnable, and a preset that picked a side would redefine which arm that cell *is*.
 *
 * The second assertion pinned the question's position as a policy field — a "stated, not implied" layout axis every
 * cell carried. That field is now **deleted**, not renamed: `q` is the last block of every order by construction, so
 * there is nothing for a cell to state, and a field that recorded one value forever is exactly the kind of knob this
 * project removes rather than documents.
 */
test('the layout axis is stated, constant across the ablation, and chosen by a round rather than a preset', () => {
  for (const cell of CELLS) {
    const p = cellPolicyOf(cell);
    // The method, in every cell. `'trace-as-state'` is `M([T, x, q])`, which is what the paper calls Trace as State
    // and what this project exists to measure; a cell that preset the control arm would be the control arm.
    assert.equal(p.tracePlacement, 'trace-as-state', `${cell}: every arm runs the paper's method, not its control`);
    // And no cell carries a question position, because there is no such field: the paper fixes the question last in
    // every condition, so the only thing a cell could say about it is the only thing that ever happens.
    assert.equal('questionPlacement' in p, false, `${cell}: the question's position is not a field any more`);
  }
  // The factors that *do* vary, stated so a change to any of them has to be argued for here: the trace's presence
  // (`tas.on`), the recall selection (`tier1`), and delivery.
  assert.equal(cellPolicyOf('C0').tas.on, false, 'the baseline carries no trace');
  assert.equal(cellPolicyOf('C1').tas.on, true, 'C1 carries the trace');
  assert.equal(cellPolicyOf('C2').tas.on, true, 'and so does C2');
  assert.equal(cellPolicyOf('C1').recall.tier1 !== cellPolicyOf('C2').recall.tier1, true, 'and only C2 selects');
  // The plan gate used to be asserted here as the second half of what separates C1 from C2. It is gone, and the
  // assertion that replaces it is the one that keeps it gone: no cell carries a gate, because a gate that cannot
  // fire is not a factor of the ablation (`types.ts` carries the measurement).
  for (const cell of CELLS) {
    assert.equal('planGate' in cellPolicyOf(cell), false, `${cell}: no plan gate is configured`);
  }
});

test('every cell leaves the assembled layout readable, whichever arm it runs', () => {
  for (const cell of CELLS) {
    const p = cellPolicyOf(cell);
    assert.equal(typeof p.tracePlacement, 'string', `${cell}: the layout is a real branch, not an omission`);
    assert.equal(p.cell, cell, `${cell}: the record says which cell produced it`);
    // The question's place is not part of what a cell states — it is a property of the layout every cell builds
    // (`core.test.ts` asserts the recorded order ends in `anchor` for all three).
    assert.equal('questionPlacement' in p, false, `${cell}: no cell states a question position`);
  }
});

/**
 * A cell that exists in the type and in the preset, and in neither of the two places that decide what runs, is
 * worse than a cell that does not exist: it looks configured.
 *
 * `deliver` was added to `AssemblyPolicy` and to `cellPolicy` in the N6 commit, and to neither `BOOLEAN_PATHS`
 * nor the runtime's base policy. A live C2 session then reported `policy.deliver is off` on all twelve steps,
 * with 8 of 12 assemblies carrying a non-empty recalled block: the content was assembled, delivered nowhere, and
 * the record only said "off" because the cell name in the log is the cell *asked for*, not the policy that ran.
 */
test('a cell preset is what the runtime actually starts from, and an override still wins', () => {
  // C0 is the baseline: no TAS, no selection, the paper's baseline layout, and it delivers nothing at all.
  const c0 = cellPolicyOf('C0');
  assert.equal(c0.tas.on, false, 'C0 must not order by TAS');
  assert.equal(c0.recall.tier1, 'off', 'C0 must not select');
  assert.equal('questionPlacement' in c0, false, 'C0 is `M([x, q])` through the layout, not through a field');
  assert.equal(c0.tracePlacement, 'trace-as-state', 'and with no trace to place, the arm is inert rather than absent');
  assert.equal(c0.deliver, false, 'C0 leaves the whole model view to the harness');

  // C1 is the paper's arm: the trace reaches the model and nothing else does. It carried `deliver: false` from
  // 2026-10-02 to 2026-10-04, because delivery then inserted the `recalled` block only and this arm has
  // `tier1: 'off'`, so the channel was structurally empty - a switch reporting `off` for a cell that wanted it
  // `on`. `tas.on` now implies the trace is delivered, so the channel carries `T` alone and fires.
  //
  // **This assertion was wrong, not merely stale.** It encoded "C1 delivers nothing, so C0-vs-C1 must show no
  // difference", and C1 now delivers the paper's own mechanism: keeping the old value would have preserved a
  // placebo in the one arm that exists to stop the trace and the recall selection being conflated in C0-vs-C2.
  const c1 = cellPolicyOf('C1');
  assert.equal(c1.tas.on, true, 'C1 carries the trace');
  assert.equal(c1.recall.tier1, 'off', 'and selects nothing: that is the variable it holds still');
  assert.equal(c1.deliver, true, 'so the trace is what reaches the model');
  // The System-1 lane being *absent* rather than merely unscoped is asserted nowhere here, and deliberately: it is
  // `bench/cells/C1.json` that carries `s1.provider: 'none'`, not this function. `cellPolicyOf('C1')` inherits the
  // base's `'jev'`, so an assertion about the lane has to be made against a resolved *preset*, not against the
  // policy object this test is about.

  // C2 is the full configuration: the paper's arm, selecting, and delivering the trace plus the turns it found.
  const c2 = cellPolicyOf('C2');
  assert.equal(c2.tas.on, true, 'C2 orders by TAS');
  assert.equal(c2.tracePlacement, 'trace-as-state', 'C2 lays out the method, not the control');
  assert.equal('questionPlacement' in c2, false, 'and states nothing about the question, which is always last');
  assert.equal(c2.deliver, true, 'C2 delivers');
  assert.equal(c2.recall.tier1, 's1', 'C2 selects, through the tier-1 mode that exists');

  // The invariant F1 was: a cell that delivers must be able to fill the one block delivery can insert. **Restated
  // 2026-10-04, because the rule's *reason* changed and so did its answer.** It read `tier1 !== 'off'`, because
  // delivery inserted the recalled block alone and that block is empty by construction when selection is off.
  // Delivery now inserts the trace first (`context-delivery.ts`), so a trace alone is a complete delivery and C1
  // delivers with `tier1: 'off'` on purpose. The invariant is the question it was always asking: does this arm have
  // *anything* to insert? A cell that delivers nothing is the switch that reports `on` and cannot fire.
  for (const cell of CELLS) {
    const p = cellPolicyOf(cell);
    if (p.deliver) {
      assert.ok(
        p.tas.on || p.recall.tier1 !== 'off',
        `${cell}: with tas off and tier1 "off" there is nothing to insert, so delivery could only refuse`,
      );
    }
  }
  // Two arms deliver and the third does not, which is what makes the registered contrasts `C0 -> C1` and
  // `C1 -> C2` rather than `C0 -> C2`: C0-vs-C2 alone now moves the trace *and* the recall selection at once.
  assert.deepEqual(
    CELLS.filter((cell) => cellPolicyOf(cell).deliver),
    ['C1', 'C2'],
    'the baseline is the only arm that delivers nothing; C1 delivers the trace, C2 the trace and the selection',
  );

  // What C2's "full configuration" is made of, stated so a future addition has to be argued for here: the state
  // proxy, recall selection, the arm it lays out, delivery, the System-1 lane's own settings, and the assembly
  // trigger. Nothing else - there is no plan gate in the preset, the policy, the schema or the report.
  //
  // The layout surface is **one field** since 2026-10-05, and it used to be two: `tracePlacement` names the arm, and
  // the field that used to sit beside it (`questionPlacement`, and `xFirst` before that) is deleted rather than
  // renamed, because the paper fixes the question last in every condition and a field whose other value produced
  // `[T, q, x]` was never a variable. So the surface is one field smaller than the two-axis version, and what
  // changed is not the number of knobs but the fact that `q` can no longer be laid out anywhere but last.
  assert.deepEqual(
    Object.keys(c2).filter((k) => k !== 'cell').sort(),
    [
      'assemblyDeadlineMs',
      'assemblyTrigger',
      'cache',
      'deliver',
      'recall',
      'rgMaintenance',
      's1',
      'tail',
      'tas',
      'termination',
      'tracePlacement',
    ],
    'the policy surface is exactly this, and a new knob is a change to the ablation',
  );

  // `assemblyTrigger` was added 2026-10-03 for round `20261003-2104`'s measured defect (33 model calls, 2
  // assemblies), and it is the one knob whose *permissive* value no arm may carry: the point of it is that a
  // single round flips it in one profile and moves one variable, so a preset that set `'every-step'` would
  // confound that round before it started. Asserted over the presets rather than against today's three cells,
  // so a fourth cell cannot quietly arrive pre-flipped.
  for (const cell of CELLS) {
    assert.equal(
      cellPolicyOf(cell).assemblyTrigger,
      'every-step',
      `${cell}: no preset moves the trigger off the default the brief requires`,
    );
  }

  // The arm is the same case for the same reason, and the reason is stronger here: Trace as State against Trace
  // Append is the paper's own control, whose whole point is that *both* arms get run. A preset carrying a value
  // would put a cell on one side of it and redefine which arm that cell is. Every cell keeps the default, which is
  // the method - and the contrast is measured by a round that writes the other value in one profile.
  for (const cell of CELLS) {
    assert.equal(
      cellPolicyOf(cell).tracePlacement,
      'trace-as-state',
      `${cell}: the arm is the default method - a cell that opts into the control is a changed ablation`,
    );
  }

  // Precedence: the cell is the base, an explicit knob in the patch is the deviation, and it wins.
  //
  // The cell's half comes from its preset (`resolveWithPreset`), which is where C0's `recall.tier1: 'off'` lives since
  // 2026-10-05; a bare `validatePolicy({ cell: 'C0', ... })` would apply no preset and assert the defaults instead -
  // the value this line reads would be `'s1'`, and the claim "the rest of the cell still applies" would be untested.
  const deviated = resolveWithPreset('C0', { deliver: true, tracePlacement: 'trace-append' });
  assert.equal(deviated.ok, true, JSON.stringify(deviated.errors));
  assert.equal(deviated.policy.deliver, true, 'a patch may turn delivery on for a cell that leaves it off');
  assert.equal(deviated.policy.tracePlacement, 'trace-append', 'and may name the arm for its own round');
  assert.equal(deviated.policy.recall.tier1, 'off', 'while the rest of the cell still applies');
  // The deleted axis is not a deviation a patch can make: it is an error, and the cell's own policy still runs.
  const deleted = validatePolicy({ cell: 'C0', questionPlacement: 'first' });
  assert.equal(deleted.ok, false, 'a profile cannot move the question, because there is no field for it to write');
  assert.equal(deleted.policy.cell, 'C0', 'and the cell it patched still applies');
  assert.equal('questionPlacement' in deleted.policy, false);

  // A cell that is not a cell is an error, and falls back to C2 rather than to half a cell.
  const bogus = validatePolicy({ cell: 'C9' });
  assert.equal(bogus.ok, false);
  assert.equal(bogus.policy.cell, 'C2', 'an unusable cell name costs the C2 defaults, not a partial cell');
});

/**
 * `recall.tier1` names the tier-1 mode that runs, and only two of the three designed modes exist.
 *
 * C2's preset carried `embed` until 2026-10-02 while nothing implemented it and the only read of the field in the
 * whole implementation was `!== 'off'` - so the cell was described by a mechanism it did not use, and the value
 * composed, appeared in every dump and was never resolved. `config.test.ts` pins the rejection of the legacy
 * literal; this pins the surface: the default, the cell, and the fact that no cell declares a mode that is missing.
 */
test('tier-1 names what runs: s1 and off are the implemented values, and C2 states the one it uses', () => {
  assert.equal(defaultPolicy().recall.tier1, 's1', 'the policy default is the mode that exists');
  assert.equal(cellPolicyOf('C2').recall.tier1, 's1', 'and the full configuration states it explicitly');
  for (const cell of CELLS) {
    const tier: string = cellPolicyOf(cell).recall.tier1;
    assert.ok(
      tier === 'off' || tier === 's1',
      `${cell}: tier-1 must be one of the implemented values (got ${JSON.stringify(tier)})`,
    );
  }
  // `embedModel` is the embed mode's model name, nothing reads it, and it stays declared rather than deleted:
  // removing a config path is its own decision, and the declared field is what the warning is about
  // (`packages/core/src/config.ts`), so a profile that sets it is told rather than ignored.
  assert.equal('embedModel' in defaultPolicy().recall, true, 'the inert field stays declared and warned about');
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
