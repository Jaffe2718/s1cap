/**
 * PLAN GATE (runtime) — the right-hand column of the figure: candidate plans -> choice scores -> advisory order.
 *
 * The property worth testing is the restraint. The gate may reorder plans the model wrote down, and it may do
 * nothing else: it may not invent plans, it may not reorder prose into plans, and a backend that cannot answer
 * must leave the model's own order alone rather than guess one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createPlanGate, extractPlans, extractTodoEvent, extractTodos } from '../src/plan-gate-runtime.ts';
import type { PlanGateOptions, PlanGateStats } from '../src/plan-gate-runtime.ts';

const POLICY = {
  planGate: { on: true, maxPlans: 3, attemptCap: 2, abstainConfidence: 0.5 },
};

function harness(answer?: { probabilities: Record<string, number>; confidence: number }) {
  const events: unknown[] = [];
  const stats: PlanGateStats = {
    inspected: 0,
    withPlans: 0,
    calls: 0,
    abstained: 0,
    skipped: 0,
    todoEvents: 0,
    todoWithPlans: 0,
  };
  const opts: PlanGateOptions = { policy: POLICY, emit: (e) => events.push(e) };
  let calls = 0;
  const gate = createPlanGate(opts, async () => {
    calls += 1;
    if (answer === undefined) throw new Error('no backend');
    return { answers: { first: { type: 'choice', probabilities: answer.probabilities, confidence: answer.confidence } } };
  });
  return { gate, events, callsRef: () => calls };
}

test('a plan the model wrote with the todo tool is gated too', async () => {
  // The defect this closes: plans were only ever read from prose the model typed, so a run whose model plans with
  // the host's todo tool produced `inspected: 0` and an empty decision column while the model was plainly
  // planning. The event shape is the host's own (`todo/write` carrying `TodoItem[]`), and the gate is the same one
  // — same question, same normalization, same abstain rule — because comparing two different gates under one
  // column would measure the difference between them.
  const todoWrite = {
    type: 'todo/write',
    data: {
      todos: [
        { content: 'read the failing test', status: 'pending' },
        { content: 'patch the assertion', status: 'in_progress' },
        { content: 'run the suite', status: 'pending' },
      ],
    },
  };
  const todos = extractTodoEvent(todoWrite);
  assert.ok(todos !== undefined, 'the event is read');
  assert.equal(todos?.length, 3);

  const { gate, events, callsRef } = harness({ probabilities: { p1: 0.2, p2: 0.9, p3: 0.4 }, confidence: 0.8 });
  const decision = await gate.considerTodos(todos ?? [], 'S', 7);
  assert.equal(callsRef(), 1, 'one System-1 choice call, same as the prose path');
  assert.deepEqual(decision?.order, ['p2', 'p3', 'p1'], 'the tool-written order is what gets reordered');
  assert.equal(events.length, 1, 'and one control-plane record, so the decision is in the log either way');
  const stats = gate.stats();
  assert.equal(stats.todoEvents, 1, 'todo-written plans are counted apart from inspected messages');
  assert.equal(stats.todoWithPlans, 1);
  assert.equal(stats.inspected, 0, 'a todo event is not an assistant message and is not counted as one');
});

test('a completed step is not a candidate, and the host order is kept as the baseline', async () => {
  // A step the model already finished is not one it is choosing between. And the order the host logged is the
  // model's own order, which is exactly the baseline the gate is measured against: re-sorting it here would
  // destroy the thing being compared.
  const plans = extractTodos([
    { content: 'read the failing test', status: 'completed' },
    { content: 'patch the assertion', status: 'in_progress' },
    { content: '  run the suite  ', status: 'pending' },
  ]);
  assert.deepEqual(
    plans.map((p) => p.id),
    ['p1', 'p2'],
    'ids are assigned after the completed step is dropped, so they stay contiguous',
  );
  assert.equal(plans[1]?.summary, 'run the suite', 'and the summary is trimmed');
  assert.deepEqual(extractTodos([{ content: '   ', status: 'pending' }]), [], 'a blank step is not a candidate');
  // One candidate is a list of one, not a decision. Extraction does not apply that rule — the gate does, where
  // the System-1 call lives, so both sources are held to it in the same place.
  const { gate, callsRef } = harness({ probabilities: { p1: 0.9 }, confidence: 0.9 });
  const decision = await gate.considerTodos([{ content: 'only one', status: 'pending' }], 'S', 1);
  assert.equal(decision ?? null, null, 'one step is not a decision');
  assert.equal(callsRef(), 0, 'and no System-1 call is spent to learn there was nothing to decide');
});

test('an unreadable todo event costs one event, not a session', () => {
  // The stream is `unknown` at the boundary. Every one of these is a shape S1CAP declines to guess at, and all
  // of them have to end the same way: no plan read, no decision, and no exception.
  assert.equal(extractTodoEvent({ type: 'user/message', data: { role: 'user' } }), undefined, 'not a todo event');
  assert.equal(extractTodoEvent({ type: 'todo/write' }), undefined, 'no data');
  assert.equal(extractTodoEvent({ type: 'todo/write', data: {} }), undefined, 'no todos field');
  assert.equal(extractTodoEvent({ type: 'todo/write', data: { todos: 'nope' } }), undefined, 'todos is not an array');
  assert.equal(extractTodoEvent(null), undefined);
  assert.equal(extractTodoEvent('todo/write'), undefined);
  assert.deepEqual(
    extractTodoEvent({
      type: 'todo/write',
      // A host build that renames or widens a field: the readable items survive, the others are skipped, and the
      // result is still a plan list rather than a crash or a silent half-order.
      data: { todos: [{ content: 'keep me', status: 'pending' }, { summary: 'no content field' }, { content: 7 }] },
    }),
    [{ content: 'keep me', status: 'pending' }],
  );
});

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
  assert.equal(calls, 0, 'C0 runs with the gate off and must make no System-1 calls');
});
