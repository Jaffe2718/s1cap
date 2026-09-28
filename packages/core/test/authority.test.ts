import test from 'node:test';
import assert from 'node:assert/strict';

import { cellPolicy, defaultPolicy } from '../src/types.ts';
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

test('the gate never invents a plan: an empty model plan list stays empty', () => {
  const decision = orderPlans([], [], 0.5);
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
