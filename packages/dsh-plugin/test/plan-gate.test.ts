/**
 * PLAN GATE (runtime) — the right-hand column of the figure: candidate plans -> choice scores -> advisory order.
 *
 * The property worth testing is the restraint. The gate may reorder plans the model wrote down, and it may do
 * nothing else: it may not invent plans, it may not reorder prose into plans, and a backend that cannot answer
 * must leave the model's own order alone rather than guess one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createPlanGate, extractPlans } from '../src/plan-gate-runtime.ts';
import type { PlanGateOptions, PlanGateStats } from '../src/plan-gate-runtime.ts';

const POLICY = {
  planGate: { on: true, maxPlans: 3, attemptCap: 2, abstainConfidence: 0.5 },
};

function harness(answer?: { probabilities: Record<string, number>; confidence: number }) {
  const events: unknown[] = [];
  const stats: PlanGateStats = { inspected: 0, withPlans: 0, calls: 0, abstained: 0, skipped: 0 };
  const opts: PlanGateOptions = { policy: POLICY, emit: (e) => events.push(e) };
  let calls = 0;
  const gate = createPlanGate(opts, async () => {
    calls += 1;
    if (answer === undefined) throw new Error('no backend');
    return { answers: { first: { type: 'choice', probabilities: answer.probabilities, confidence: answer.confidence } } };
  });
  return { gate, events, callsRef: () => calls };
}

test('plans are read from the model\'s own step list, and prose is not mistaken for one', () => {
  const plans = extractPlans('My plan:\n1. read the failing test\n2. patch the assertion\n3. run the suite');
  assert.deepEqual(plans.map((p) => p.id), ['p1', 'p2', 'p3']);
  assert.equal(plans[0]?.summary, 'read the failing test');

  // A hyphen inside a sentence, and a numbered reference to a line of code, are not plans. Inventing plans from
  // prose is the one failure that would make the gate a second decision-maker rather than an adviser.
  assert.deepEqual(extractPlans('The fix is in src/a.ts - line 42 - and it is a one-liner.'), []);
  assert.deepEqual(extractPlans('See issue 3. It was fixed in 2.4.0.'), []);
  assert.deepEqual(extractPlans('No list here at all.'), []);
});

test('the candidate list is capped by policy, so m <= 3 is enforced in one place', () => {
  const many = Array.from({ length: 8 }, (_, i) => `${i + 1}. step ${i + 1}`).join('\n');
  assert.equal(extractPlans(many).length, 3);
  assert.equal(extractPlans(many, 2).length, 2);
});

test('two plans are scored in one call and returned in probability order', async () => {
  const { gate, events, callsRef } = harness({ probabilities: { p1: 0.9, p2: 0.3 }, confidence: 0.8 });
  const decision = await gate.consider('1. read the test\n2. patch it', 'S', 4);
  assert.equal(callsRef(), 1, 'the candidate list costs one System-1 call');
  assert.equal(decision?.order[0], 'p1');
  assert.equal(decision?.abstained, false);
  assert.equal(events.length, 1, 'and exactly one control-plane record');
  const event = events[0] as { type: string; executed: string[]; verified: boolean; order: string[] };
  assert.equal(event.type, 'plan_gate');
  // The two fields that make "advisory" legible in the log: nothing was executed and nothing was verified.
  assert.deepEqual(event.executed, []);
  assert.equal(event.verified, false);
  assert.deepEqual(event.order, ['p1', 'p2']);
});

test('a single candidate is not a decision, and no call is spent on it', async () => {
  const { gate, callsRef } = harness({ probabilities: { p1: 1 }, confidence: 1 });
  assert.equal(await gate.consider('1. just the one step', 'S', 1), undefined);
  assert.equal(callsRef(), 0, 'reordering one plan is not worth a System-1 call');
});

test('low confidence abstains and keeps the model\'s own order', async () => {
  const { gate } = harness({ probabilities: { p1: 0.9, p2: 0.8 }, confidence: 0.2 });
  const decision = await gate.consider('1. alpha\n2. beta', 'S', 2);
  assert.equal(decision?.abstained, true);
  assert.deepEqual(decision?.order, ['p1', 'p2'], 'the order the model wrote is kept verbatim');
});

test('a backend that cannot answer leaves the model\'s order alone instead of guessing', async () => {
  const failing = harness(undefined);
  assert.equal(await failing.gate.consider('1. alpha\n2. beta', 'S', 3), undefined);
  assert.equal(failing.events.length, 0, 'and records nothing, because there is no decision to record');

  // An answer with no probabilities is the same situation wearing a different hat: readable response, no
  // usable score. It abstains rather than inventing a uniform distribution and calling it an ordering.
  const unreadable = harness(undefined);
  const gate = createPlanGate(
    { policy: POLICY, emit: () => undefined },
    async () => ({ answers: { first: { type: 'choice' } } }),
  );
  assert.equal(await gate.consider('1. alpha\n2. beta', 'S', 3), undefined);
  assert.equal(unreadable.callsRef(), 0);
});

test('a gate that is switched off never scores, even with a backend present', async () => {
  let calls = 0;
  const gate = createPlanGate(
    { policy: { planGate: { ...POLICY.planGate, on: false } }, emit: () => undefined },
    async () => {
      calls += 1;
      return { answers: {} };
    },
  );
  assert.equal(await gate.consider('1. alpha\n2. beta', 'S', 1), undefined);
  assert.equal(calls, 0, 'C1 runs with the gate off and must make no System-1 calls');
});
