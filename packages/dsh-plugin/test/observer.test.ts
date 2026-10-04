/**
 * Observation wiring (M1): the plugin must record what it *would* have selected, and must not be able to
 * change what the model sees. These tests cover the middleware contract, the sink, and the isolation
 * between the two streams — the point of the whole control-plane design.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defaultPolicy } from '@s1cap/core';
import type { AssemblyTrigger, StepObservation } from '@s1cap/core';
import { apply, preStepMiddleware } from '../src/index.ts';
import type { CommandSpec, PluginContext, PreStepOptions } from '../src/index.ts';
import { commandPayload } from './command-contract.ts';
import { deliverContext } from '../src/context-delivery.ts';
import type { ContextDeliveryResult } from '../src/context-delivery.ts';
import { createStepObserver } from '../src/step-observer.ts';
import type { StepObserver } from '../src/step-observer.ts';

const MESSAGES = [
  { id: 'sys', role: 'system', content: [{ type: 'text', text: 'You are a coding agent.' }], source: { kind: 'system-prompt' } },
  { id: 'u1', role: 'user', content: [{ type: 'text', text: 'Fix the failing test in auth.ts' }] },
  { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'Inspecting auth.ts.' }], source: { kind: 'model' } },
  { id: 't1', role: 'tool', content: [{ type: 'text', text: 'auth.ts: 120 lines' }], source: { kind: 'tool' } },
  { id: 'r1', role: 'assistant', content: [{ type: 'reasoning', text: 'the comparison is off by one' }], source: { kind: 'model' } },
  { id: 'u2', role: 'user', content: [{ type: 'text', text: 'also check expiry' }] },
];

interface Harness {
  ctx: PluginContext;
  logs: string[];
  warns: string[];
  commands: Map<string, CommandSpec['handler']>;
  handlers: Map<string, (...args: unknown[]) => unknown>;
}

function harness(): Harness {
  const logs: string[] = [];
  const warns: string[] = [];
  const commands = new Map<string, CommandSpec['handler']>();
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ctx: PluginContext = {
    on(event, handler) {
      handlers.set(event, handler as (...args: unknown[]) => unknown);
    },
    effect: (fn) => fn(),
    commands: {
      register(spec) {
        commands.set(spec.name, spec.handler);
      },
    },
    logger: { info: (m: string) => logs.push(m), warn: (m: string) => warns.push(m) },
  };
  return { ctx, logs, warns, commands, handlers };
}

function observerWith(records: unknown[], overrides: Partial<{ throws: boolean }> = {}) {
  return createStepObserver({
    policy: defaultPolicy(),
    emit: (event) => {
      if (overrides.throws === true) throw new Error('sink exploded');
      records.push(event);
    },
    now: () => 1_790_000_000_000,
    contextWindow: 128_000,
    reserveOutputTokens: 8_000,
    fixedOverheadTokens: 1_200,
    lambdaMs: 36 * 60 * 60 * 1000,
  });
}

/**
 * Build a middleware the way `index.ts` does, with the delivery path included.
 *
 * The default `deliver` answers "nothing to insert", which is what a cell with no recalled block produces — so
 * every test that is not about delivery keeps asserting the old, still-load-bearing property: the harness's own
 * decision object comes back by identity.
 */
function preStep(observer: StepObserver, overrides: Partial<PreStepOptions> = {}): {
  middleware: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>;
  emitted: { type?: string; delivered?: boolean; reason?: string; messagesBefore?: number; messagesAfter?: number; order?: string[]; blocks?: string[] }[];
} {
  const emitted: { type?: string; delivered?: boolean; reason?: string; messagesBefore?: number; messagesAfter?: number; order?: string[]; blocks?: string[] }[] = [];
  return {
    emitted,
    middleware: preStepMiddleware(harness().ctx, {
      observer,
      cell: 'C2',
      emit: (event) => emitted.push(event as never),
      deliver: () => SKIPPED,
      ...overrides,
    }),
  };
}

/**
 * What `deliverContext` returns when there is nothing to deliver: a reported skip, with the harness's own list
 * passed through. Spelled out here rather than imported so this file keeps testing the middleware's handling of
 * a result, and `context-delivery.test.ts` keeps testing the result itself.
 */
const SKIPPED = {
  delivered: false,
  reason: 'nothing to insert: no recalled block and no state proxy',
  messages: null,
  blocks: [] as string[],
  kept: 0,
  dropped: 0,
  inserted: 0,
  payloadId: '',
};

test('a pre-step call emits one assembly record and returns the harness decision untouched', async () => {
  const records: { type?: unknown }[] = [];
  const observer = observerWith(records);
  const { middleware, emitted } = preStep(observer);
  const decision = { kind: 'accept', messages: [{ kind: 'user' }] };
  let calls = 0;

  const returned = await middleware({ messages: MESSAGES, step: 2 }, async () => {
    calls += 1;
    return decision;
  });

  assert.equal(calls, 1, 'next() is awaited exactly once');
  assert.equal(returned, decision, 'identity preserved: the harness sees its own object');
  assert.equal(records.length, 1);
  assert.equal(records[0]?.type, 'assembly');

  // The delivery record is the difference between "assembled" and "delivered", so it is written on every step,
  // including the steps where nothing was delivered. A record that only appears on success is a record that
  // cannot be used to prove the intervention ran.
  const delivery = emitted.find((e) => e.type === 'context_delivery');
  assert.ok(delivery !== undefined, 'a context_delivery record is written even when nothing was delivered');
  assert.equal(delivery?.delivered, false, 'this test cell delivers nothing');
  assert.ok(typeof delivery?.reason === 'string' && delivery.reason !== '', 'and says why, in words');

  const stats = observer.stats();
  assert.equal(stats.steps, 1);
  assert.equal(stats.observed, 1);
  assert.equal(stats.skipped, 0);
  assert.equal(stats.errors, 0);
  assert.equal(stats.lastSegments, MESSAGES.length);
  assert.ok(stats.lastWouldSaveTokens >= 0);
  assert.deepEqual(stats.unknownRoles, [], 'the DSH role table covers every role in the fixture');
});

test('a step that produced nothing delivers nothing and still reports why', async () => {
  const records: unknown[] = [];
  const observer = observerWith(records);
  const { middleware, emitted } = preStep(observer);

  // No message list, so the observer has nothing to assemble: the delivery path must not run at all.
  const decision = { kind: 'accept', messages: [{ id: 'x' }] };
  const returned = await middleware({ step: 1 }, async () => decision);

  assert.equal(returned, decision, 'identity preserved');
  assert.equal(observer.stats().skipped, 1);
  assert.equal(emitted.length, 0, 'with no assembly there is no delivery to report');
});

// --- Defect 1: a decision that carries no messages is not paid for ---

/**
 * The measured defect, as a test.
 *
 * A real three-cell round produced 277 assemblies and 2 deliveries: 275 of the steps had a decision with no
 * messages, `deliverContext` refused all 275 with "the decision carried no messages", and every one of them had
 * already been assembled - the walk, the anchor wait, T's rebuild, 1,205,029 recalled tokens assembled against
 * 1,597 delivered. The refusal is correct and stays; what these two tests pin is that the work now stops before
 * it is spent, and that the read still happens.
 */
test('a decision with no messages costs no assembly, and the step is still read into the graph', async () => {
  const records: { type?: unknown }[] = [];
  const observer = observerWith(records);
  const { middleware, emitted } = preStep(observer);
  const decision = { kind: 'accept', messages: [] as unknown[] };

  const returned = await middleware({ messages: MESSAGES, step: 7 }, async () => decision);

  assert.equal(returned, decision, 'the harness sees its own object');
  assert.equal(records.length, 0, 'no assembly record: the walk was never run, so there is nothing to record');
  const stats = observer.stats();
  assert.equal(stats.steps, 1, 'the step was seen');
  assert.equal(stats.ingestOnly, 1, 'counted as a skip, not as a failure to read');
  assert.equal(stats.observed, 0);
  assert.equal(stats.empty, 0, 'and not as an unreadable payload: the two diagnoses are opposite');
  assert.equal(stats.lastSegments, MESSAGES.length, 'the payload was segmented, which is what keeps the graph whole');

  const delivery = emitted.find((e) => e.type === 'context_delivery');
  assert.ok(delivery !== undefined, 'the refusal is still reported, on every step');
  assert.equal(delivery?.delivered, false);
  // The sentence is unchanged on purpose: the report scripts count refusals by it, and this event is the same
  // event it always was. Only its cost changed.
  assert.equal(delivery?.reason, 'the decision carried no messages');
  assert.equal(delivery?.messagesBefore, 0, 'and the field the analysis reads says the same thing it said before');
});

/**
 * F1: the refusal has to say *which* refusal it was.
 *
 * `delivered: false, reason: "the decision carried no messages"` is produced identically by three different states:
 * the step was read and the assembly was deliberately not paid for (this path), the observer was missing or
 * `observe()` threw, and the assembly ran and the delivery module declined for a reason of its own. The counters
 * that separate them (`ingestOnly`, `errors`) live only on the `/s1` route, which a round does not persist - so
 * before this pair of fields, a defect in the observation path was written down identically to the lane working as
 * designed. The audit's finding is that the D1 fix converts a *measured* waste into an *unmeasured* absence; these
 * two fields are what makes it measured again, without changing what the model receives.
 */
test('the refusal records that the step was ingested and not assembled', async () => {
  const records: unknown[] = [];
  const observer = observerWith(records);
  const { middleware, emitted } = preStep(observer);

  await middleware({ messages: MESSAGES, step: 7 }, async () => ({ kind: 'accept', messages: [] }));

  const delivery = emitted.find((e) => e.type === 'context_delivery');
  assert.ok(delivery !== undefined);
  assert.equal(
    (delivery as { assembled?: boolean }).assembled,
    false,
    'the walk did not run, and the record says so rather than leaving it to be inferred from the reason',
  );
  assert.equal(
    (delivery as { ingested?: boolean }).ingested,
    true,
    'and the step *was* read: its segments are in the graph, which is the other half of the state',
  );
  assert.equal((delivery as { step?: number }).step, 7, 'the step number the refusal was about');
});

test('a refusal with no observer behind it reports `ingested: false`, not the same record', async () => {
  // The other state, and the reason the flag is read from the observation rather than assumed from the decision:
  // with no observer there is nothing to read the payload, so `assembled` and `ingested` are both false and the
  // record is distinguishable from the one above. This is the "the lane was never there" case.
  const emitted: Record<string, unknown>[] = [];
  const middleware = preStepMiddleware(harness().ctx, {
    cell: 'C2',
    emit: (event) => emitted.push(event as never),
    deliver: () => SKIPPED,
  });

  const decision = { kind: 'accept', messages: [] as unknown[] };
  const returned = await middleware({ messages: MESSAGES, step: 5 }, async () => decision);

  assert.equal(returned, decision, 'the harness still sees its own object');
  const delivery = emitted.find((e) => e['type'] === 'context_delivery') as Record<string, unknown> | undefined;
  assert.ok(delivery !== undefined, 'and the refusal is still reported');
  assert.equal(delivery['assembled'], false);
  assert.equal(delivery['ingested'], false, 'nothing read this step: the two states are legible apart');
  assert.equal(delivery['step'], 5);
});

test('a delivered step records `assembled: true`, so the three states are all distinct', async () => {
  const records: unknown[] = [];
  const observer = observerWith(records);
  const delivered: string[] = [];
  const middleware = preStepMiddleware(harness().ctx, {
    observer,
    cell: 'C2',
    emit: (event) => {
      const e = event as { type?: string; assembled?: boolean; delivered?: boolean; payloadId?: string };
      if (e.type === 'context_delivery') delivered.push(JSON.stringify(e));
    },
    deliver: (_observation, decision) => {
      const messages = (decision as { messages: unknown[] }).messages;
      const injected = { id: 's1cap-test', role: 'user', content: [{ type: 'text', text: '## earlier user turn' }] };
      return {
        delivered: true,
        reason: 'inserted one message',
        messages: [...messages, injected],
        blocks: ['recalled'],
        kept: messages.length,
        dropped: 0,
        inserted: 1,
        payloadId: 's1cap-test',
      };
    },
  });

  await middleware({ messages: MESSAGES, step: 2 }, async () => ({ kind: 'enter', messages: [{ id: 'u7' }] }));

  const record = JSON.parse(delivered[0] ?? '{}') as Record<string, unknown>;
  assert.equal(record['delivered'], true);
  assert.equal(record['assembled'], true, 'a delivered step is the one case where both flags are on one side');
  assert.equal(record['ingested'], undefined, '`ingested` marks the read-and-declined path, and this is not it');
});

/**
 * The other half of the per-session duplicate guard: a *different* payload is still delivered.
 *
 * The guard keys on the digest S1CAP computed, so the risk it carries is refusing too much - a run that delivered
 * once and then declined everything. This pins the boundary: the second step gets a different payload id and is
 * delivered, which is what makes the guard a de-duplication rather than a one-shot.
 */
test('the dedup guard is per session, and it keys on the digest rather than on the text', async () => {
  const records: unknown[] = [];
  const observer = observerWith(records);
  const emitted: Record<string, unknown>[] = [];
  const middleware = preStepMiddleware(harness().ctx, {
    observer,
    cell: 'C2',
    emit: (event) => emitted.push(event as never),
    // A `deliver` whose digest is *content-derived*, like the real one (`context-delivery.ts`: FNV-1a over the
    // rendered text). A counter-based fixture would make every step a new payload and the guard would never be
    // exercised - which is the shape of test that lets a dead guard look alive.
    deliver: (observation, decision) => {
      const messages = (decision as { messages: unknown[] }).messages;
      const payloadId = `s1cap-${observation.layout.anchor.id}`;
      return {
        delivered: true,
        reason: `inserted ${payloadId}`,
        messages: [...messages, { id: payloadId, role: 'user', content: [{ type: 'text', text: payloadId }] }],
        blocks: ['recalled'],
        kept: messages.length,
        dropped: 0,
        inserted: 1,
        payloadId,
      };
    },
  });

  // The anchor comes from the graph, so two steps over the same transcript select the same payload - which is the
  // situation the guard exists for (the harness's increment never carries the previous injection back). The second
  // step is therefore refused, and that is a *measurement*: it shows the guard firing in the one case a live run
  // produces, rather than a fixture that had to be arranged to reach it.
  const session = { session: { id: 'session-a' } };
  const claimed = { id: 'u7', role: 'user', content: [{ type: 'text', text: 'and now the fix' }] };
  await middleware({ messages: MESSAGES, step: 2, agent: session }, async () => ({ kind: 'enter', messages: [claimed] }));
  await middleware({ messages: MESSAGES, step: 3, agent: session }, async () => ({ kind: 'enter', messages: [claimed] }));

  const deliveries = emitted.filter((e) => e['type'] === 'context_delivery');
  assert.equal(deliveries.length, 2, 'one report per step, as always');
  assert.equal(deliveries[0]?.['delivered'], true, 'the first payload is delivered');
  assert.equal(deliveries[1]?.['delivered'], false, 'the identical one after it is refused');
  assert.match(String(deliveries[1]?.['reason']), /already delivered in this session/);
  assert.equal(deliveries[1]?.['assembled'], true, 'the refusal is about the repeat: that step was assembled too');
  assert.equal(
    deliveries[1]?.['payloadId'],
    deliveries[0]?.['payloadId'],
    'and the record names the payload that was already sent',
  );

  // A different session is a different guard: the key carries the session, so nothing leaks across conversations.
  await middleware({ messages: MESSAGES, step: 4, agent: { session: { id: 'session-b' } } }, async () => ({
    kind: 'enter',
    messages: [claimed],
  }));
  const third = emitted.filter((e) => e['type'] === 'context_delivery')[2] as Record<string, unknown>;
  assert.equal(third['delivered'], true, 'the same payload in another session is not a repeat');
  assert.equal(third['sessionId'], 'session-b', 'and the record says which session it was delivered to');
});

test('a step that can receive context is assembled in full', async () => {
  const records: { type?: unknown }[] = [];
  const observer = observerWith(records);
  const { middleware } = preStep(observer);
  const decision = { kind: 'enter', messages: [{ id: 'u7', role: 'user' }] };

  await middleware({ messages: MESSAGES, step: 8 }, async () => decision);

  assert.equal(records.length, 1, 'one assembly, as before');
  const stats = observer.stats();
  assert.equal(stats.observed, 1);
  assert.equal(stats.ingestOnly, 0, 'the two conditions are disjoint, which is the whole finding');
});

/**
 * The two conditions the middleware decides on, at the seam where it decides them.
 *
 * `assemble: false` is what stops the work, so it has to be asserted on the call rather than inferred from a
 * counter: a middleware that got the condition backwards would skip the two steps that *can* deliver, and the
 * delivery records alone cannot tell that apart from a cell that selected nothing.
 */
test('the middleware asks for an assembly exactly when the decision can receive one', async () => {
  const seen: (boolean | undefined)[] = [];
  const noop = (): undefined => undefined;
  const spy = {
    async observe(_payload: unknown, options?: { assemble?: boolean }) {
      seen.push(options?.assemble);
      return undefined;
    },
    noteSessionEvent: noop,
    setSystemPrompt: noop,
    probe: noop,
    flushUpkeep: () => 0,
    stats: () => ({}) as never,
  } as unknown as StepObserver;
  const middleware = preStepMiddleware(harness().ctx, { observer: spy, cell: 'C2', emit: () => undefined, deliver: () => SKIPPED });

  await middleware({ messages: MESSAGES, step: 1 }, async () => ({ kind: 'enter', messages: [{ id: 'a' }] }));
  await middleware({ messages: MESSAGES, step: 2 }, async () => ({ kind: 'enter', messages: [] }));
  // A rejected step is the other cheap class: nothing to deliver, and no reason to assemble either.
  await middleware({ messages: MESSAGES, step: 3 }, async () => ({ kind: 'reject', messages: [{ id: 'b' }] }));
  await middleware({ messages: MESSAGES, step: 4 }, async () => ({ kind: 'enter', signal: { aborted: true }, messages: [{ id: 'c' }] }));

  assert.deepEqual(seen, [true, false], 'only the step with claimed messages is assembled');
});

/**
 * The same seam under the permissive value, which is what `policy.assemblyTrigger: 'every-step'` buys.
 *
 * The measured defect is the second entry below: a step whose decision claims nothing is *not* a step that sends
 * no request — round `20261003-2104` made 33 model calls on 33 steps, one `LLM calls` record each — so under this
 * value the assembly is asked for rather than skipped. What must not move with it is stated in the same test,
 * because a switch that also assembled rejected, aborted or unreadable steps would be a different, wrong change:
 * those three still return before the observer is ever called, which is why the `seen` array stays at two entries
 * for the five steps driven here.
 */
test('under every-step the middleware assembles a step that claimed nothing, and only that changes', async () => {
  const seen: (boolean | undefined)[] = [];
  const noop = (): undefined => undefined;
  const spy = {
    async observe(_payload: unknown, options?: { assemble?: boolean }) {
      seen.push(options?.assemble);
      return undefined;
    },
    noteSessionEvent: noop,
    setSystemPrompt: noop,
    probe: noop,
    flushUpkeep: () => 0,
    stats: () => ({}) as never,
  } as unknown as StepObserver;
  const middleware = preStepMiddleware(harness().ctx, {
    observer: spy,
    cell: 'C2',
    emit: () => undefined,
    deliver: () => SKIPPED,
    assemblyTrigger: 'every-step',
  });

  await middleware({ messages: MESSAGES, step: 2 }, async () => ({ kind: 'enter', messages: [] }));
  // Step 1 with nothing claimed is the harness's own turn-boundary guard, and the switch leaves it alone: the
  // evidence for `every-step` is about the steps after the first, and the host's instructions plugin declines
  // there too. Assembled: no - but still read, which is the `false` this records.
  await middleware({ messages: MESSAGES, step: 1 }, async () => ({ kind: 'enter', messages: [] }));
  // The three cheap classes: rejected, aborted, and a decision whose `messages` is not a list at all. None of
  // them reaches the observer, so none of them is paid for and none of them can be inserted into.
  await middleware({ messages: MESSAGES, step: 3 }, async () => ({ kind: 'reject', messages: [{ id: 'b' }] }));
  await middleware({ messages: MESSAGES, step: 4 }, async () => ({ kind: 'enter', signal: { aborted: true }, messages: [{ id: 'c' }] }));
  await middleware({ messages: MESSAGES, step: 5 }, async () => ({ kind: 'enter' }));

  assert.deepEqual(
    seen,
    [true, false],
    'the empty decision is assembled, the first step is read but not assembled, and the other three never arrive',
  );
});

test('a delivery that returns a list returns it, and a throwing one changes nothing', async () => {
  const records: unknown[] = [];
  const observer = observerWith(records);
  const decision = { kind: 'enter', messages: [{ id: 'sys', role: 'system' }, { id: 'u2', role: 'user' }] };
  // `kind: 'enter'` is the kind the packaged loop produces on a normal step (dsh-agent-loop `preStep`); a test that
  // used a made-up kind would pass for the wrong reason if the guard ever came to check it.
  const injected = { id: 's1cap-abc', role: 'user', content: [{ type: 'text', text: '# context assembled' }] };

  const delivered = preStep(observer, {
    deliver: () => ({
      delivered: true,
      reason: 'inserted one message after the last claimed message',
      messages: [decision.messages[0], injected, decision.messages[1]],
      blocks: ['recalled'],
      kept: 2,
      dropped: 0,
      inserted: 1,
      payloadId: 's1cap-abc',
    }),
  });
  const returned = await delivered.middleware({ messages: MESSAGES, step: 3 }, async () => decision);
  assert.notEqual(returned, decision, 'a delivered step returns a new decision object');
  assert.deepEqual(
    (returned as { messages: unknown[] }).messages,
    [decision.messages[0], injected, decision.messages[1]],
    'with exactly the list the delivery built',
  );
  const record = delivered.emitted.find((e) => e.type === 'context_delivery');
  assert.equal(record?.delivered, true);
  assert.equal(record?.messagesBefore, 2);
  assert.equal(record?.messagesAfter, 3, 'one more than it started with: an insertion, not a rewrite');
  assert.deepEqual(record?.blocks, ['recalled'], 'and the record says which blocks the model was given');

  const rejecting = preStep(observer, {
    deliver: () => {
      throw new Error('delivery blew up');
    },
  });
  const untouched = await rejecting.middleware({ messages: MESSAGES, step: 4 }, async () => decision);
  assert.equal(untouched, decision, 'a throwing delivery costs the intervention, never the round');
});

test('a rejected or aborted step is never rewritten', async () => {
  const records: unknown[] = [];
  const observer = observerWith(records);
  const { middleware, emitted } = preStep(observer, {
    deliver: () => ({ ...SKIPPED, delivered: true, messages: [{ id: 'nope' }] }),
  });

  const rejected = { kind: 'reject', messages: [{ id: 'u' }] };
  assert.equal(await middleware({ messages: MESSAGES, step: 1 }, async () => rejected), rejected);

  const aborted = { kind: 'accept', signal: { aborted: true }, messages: [{ id: 'u' }] };
  assert.equal(await middleware({ messages: MESSAGES, step: 2 }, async () => aborted), aborted);

  assert.equal(emitted.length, 2, 'both skips are reported');
  assert.ok(emitted.every((e) => e.delivered === false));
  assert.ok(emitted.some((e) => (e.reason ?? '').includes('rejected')));
  assert.ok(emitted.some((e) => (e.reason ?? '').includes('aborted')));
});

/**
 * The switch end to end: the middleware's trigger and the delivery module's insertion, wired the way `index.ts`
 * wires them (`deliver: (built, decision, payload) => deliverContext({...})`), on the step the switch exists for.
 *
 * Three facts are asserted together because each is a way the change could be wrong while looking right:
 * the empty decision is *assembled* (a middleware that only stopped refusing would deliver nothing, because
 * `deliverContext` would have no layout to build from); the block lands at the end of the increment rather than
 * nowhere; and the per-session duplicate guard still bounds it, which is the constraint `DEFECT-GATE.md` records
 * as Update 5 - `deliverContext`'s own content check scans an empty decision and finds nothing, so on this path
 * the guard in `index.ts` is the only one there is.
 */
const SWITCH_SEGMENT_A = { id: 'h1', kind: 'assistant', text: 'package.json scripts: build, test, dsh:add' };
const SWITCH_SEGMENT_B = { id: 'h7', kind: 'assistant', text: 'and the loop driver lives in dsh-agent-loop' };

/** An observer that answers with one fixed layout, as a real one does after a walk. Nothing else is exercised. */
function recallStub(selectionOf: () => { id: string; kind: string; text: string }[]): StepObserver {
  const noop = (): undefined => undefined;
  // The one counter a caller reads off the observer besides the assembly: `ingestOnly` advances on the steps that
  // were read and deliberately not assembled (see `step-observer.ts`), which is what makes `ingested` on a refusal
  // record mean "the payload reached the graph". A stub that left it at zero would make the flag untestable.
  let ingestOnly = 0;
  return {
    async observe(_payload: unknown, options?: { assemble?: boolean }) {
      if (options?.assemble !== true) ingestOnly += 1;
      return {
        layout: {
          order: ['pinned', 'stateProxy', 'anchor', 'recalled', 'tail'],
          recalled: selectionOf(),
          anchor: { id: 'u2', kind: 'user', text: 'and now the fix' },
        },
      };
    },
    noteSessionEvent: noop,
    setSystemPrompt: noop,
    probe: noop,
    flushUpkeep: () => 0,
    stats: () => ({ ingestOnly }) as never,
  } as unknown as StepObserver;
}

/** `index.ts`'s own `deliver` callback, with the trigger under test passed in instead of read from a config. */
function realDeliver(trigger: AssemblyTrigger) {
  return (built: StepObservation, decision: Record<string, unknown>, payload: unknown): ContextDeliveryResult => {
    const claimed = (payload as { messages?: unknown } | undefined)?.messages;
    const step = (payload as { step?: unknown } | undefined)?.step;
    return deliverContext({
      enabled: true,
      trigger,
      order: built.layout.order,
      recalled: built.layout.recalled,
      anchor: built.layout.anchor,
      messages: Array.isArray(decision['messages']) ? (decision['messages'] as unknown[]) : [],
      ...(Array.isArray(claimed) ? { claimed: claimed as unknown[] } : {}),
      ...(typeof step === 'number' ? { step } : {}),
    });
  };
}

test('under every-step an empty decision is given the block, and the per-session guard still bounds the repeats', async () => {
  const ctx = harness();
  const emitted: Record<string, unknown>[] = [];
  let selection = [SWITCH_SEGMENT_A];
  const middleware = preStepMiddleware(ctx.ctx, {
    observer: recallStub(() => selection),
    cell: 'C2',
    emit: (event) => emitted.push(event as never),
    assemblyTrigger: 'every-step',
    deliver: realDeliver('every-step'),
  });
  // The payload a step after the first really has: `inbox.claim(target, turn)` returned nothing, so the decision
  // carries no messages and the payload claims none. Round `20261003-2104` measured 31 such steps against 33
  // `LLM calls`.
  const payload = (step: number): unknown => ({ messages: [], step, agent: { session: { id: 'session-switch' } } });

  const first = { kind: 'enter', messages: [] as unknown[] };
  const returned = await middleware(payload(2), async () => first);

  assert.notEqual(returned, first, 'the step gets a new decision: the block had somewhere to go');
  const list = (returned as { messages: unknown[] }).messages;
  assert.equal(list.length, 1, 'an empty increment becomes the one injected message');
  assert.match(
    (list[0] as { content: { text: string }[] }).content[0].text,
    /package\.json scripts: build, test, dsh:add/,
    'and it carries the recalled text, which only exists because the walk ran',
  );

  const record = emitted.find((e) => e['type'] === 'context_delivery') as Record<string, unknown>;
  assert.equal(record['delivered'], true, String(record['reason']));
  assert.equal(record['assembled'], true, 'the walk ran: that is the whole point of the switch');
  assert.equal(record['messagesBefore'], 0, 'on a step that claimed nothing at all');
  assert.equal(record['messagesAfter'], 1);
  assert.equal(record['inserted'], 1);
  assert.equal(record['kept'], 0, 'nothing the harness sent was removed, because it sent nothing');
  assert.equal(record['sessionId'], 'session-switch');
  assert.match(String(record['reason']), /at the end of the step's increment/);

  // The repeat. The selection is stable, so the digest is the same - and on this path the delivery module's own
  // content check sees an empty list and cannot fire.
  const second = { kind: 'enter', messages: [] as unknown[] };
  const again = await middleware(payload(3), async () => second);
  assert.equal(again, second, 'the repeat is refused and the harness gets its own decision object back');
  const repeat = emitted.filter((e) => e['type'] === 'context_delivery')[1] as Record<string, unknown>;
  assert.equal(repeat['delivered'], false);
  assert.match(String(repeat['reason']), /already delivered in this session/);
  assert.equal(repeat['assembled'], true, 'the refusal is about the repeat, not about the step being unreadable');
  assert.equal(repeat['payloadId'], record['payloadId'], 'and the record names the payload it refused');

  // A changed selection is a changed payload: the guard bounds copies per payload, it is not a one-shot.
  selection = [SWITCH_SEGMENT_B];
  const third = { kind: 'enter', messages: [] as unknown[] };
  const changed = await middleware(payload(4), async () => third);
  assert.notEqual(changed, third, 'a different selection is delivered');
  assert.equal(((changed as { messages: unknown[] }).messages).length, 1);
  const thirdRecord = emitted.filter((e) => e['type'] === 'context_delivery')[2] as Record<string, unknown>;
  assert.equal(thirdRecord['delivered'], true);
  assert.notEqual(thirdRecord['payloadId'], record['payloadId'], 'with a digest of its own');
});

test('the same wiring on claimed-only refuses the empty decision before the walk, as it always did', async () => {
  // The value every cell runs, through the same two modules: no assembly is asked for, nothing is inserted, and
  // the recorded reason is the string the report scripts count. This is the default-preservation pin - if the
  // switch ever leaked into the conservative branch, this test and the delivery module's own test both fail.
  const ctx = harness();
  const emitted: Record<string, unknown>[] = [];
  const middleware = preStepMiddleware(ctx.ctx, {
    observer: recallStub(() => [SWITCH_SEGMENT_A]),
    cell: 'C2',
    emit: (event) => emitted.push(event as never),
    assemblyTrigger: 'claimed-only',
    deliver: realDeliver('claimed-only'),
  });

  const decision = { kind: 'enter', messages: [] as unknown[] };
  const returned = await middleware({ messages: [], step: 2, agent: { session: { id: 'session-switch' } } }, async () => decision);

  assert.equal(returned, decision, 'identity preserved: the harness sees its own object');
  const refusal = emitted.find((e) => e['type'] === 'context_delivery') as Record<string, unknown>;
  assert.equal(refusal['delivered'], false);
  assert.equal(refusal['reason'], 'the decision carried no messages', 'the sentence the refusal counts are read through');
  assert.equal(refusal['assembled'], false, 'and it was not paid for: the walk never ran');
  assert.equal(refusal['ingested'], true, 'while the step was still read into the graph');
});

test('a payload without a message list is skipped, not guessed at', async () => {
  const records: unknown[] = [];
  const observer = observerWith(records);
  const middleware = preStepMiddleware(harness().ctx, observer);

  await middleware({ step: 1 }, async () => ({ kind: 'accept', messages: [{ id: 'u' }] }));
  await middleware(undefined, async () => ({ kind: 'accept', messages: [{ id: 'u' }] }));

  assert.equal(records.length, 0);
  const stats = observer.stats();
  assert.equal(stats.steps, 2);
  assert.equal(stats.skipped, 2);
  assert.equal(stats.errors, 0);
});

test('a broken emitter is counted and never breaks the round', async () => {
  const observer = observerWith([], { throws: true });
  const ctx = harness();
  const middleware = preStepMiddleware(ctx.ctx, observer);
  // The decision carries the claimed message, because a step that can receive context is the only kind that
  // assembles: an empty decision is now answered before the walk, and a broken emitter would then never be
  // reached, which would make this test pass without testing anything.
  const decision = { kind: 'accept', messages: [{ id: 'u1', role: 'user' }] };

  const returned = await middleware({ messages: MESSAGES, step: 1 }, async () => decision);

  assert.equal(returned, decision);
  assert.equal(observer.stats().errors, 1);
});

test('harness errors propagate unchanged: the observer never swallows them', async () => {
  const observer = observerWith([]);
  const middleware = preStepMiddleware(harness().ctx, observer);

  await assert.rejects(
    async () =>
      middleware({ messages: MESSAGES }, async () => {
        throw new Error('harness blew up');
      }),
    /harness blew up/,
  );
  assert.equal(observer.stats().steps, 0, 'the observer only runs after a successful next()');
});

test('observation mode off registers the hook but writes nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 's1cap-off-'));
  const h = harness();
  apply(h.ctx, {
    enabled: true,
    observation: 'off',
    s1: { provider: 'none' },
    laya: { enabled: false },
    telemetry: { sessionJsonl: join(dir, 'session.jsonl'), controlJsonl: join(dir, 'control.jsonl') },
  });

  const handler = h.handlers.get('agent/pre-step');
  assert.equal(typeof handler, 'function', 'the hook is still registered in the verified middleware shape');
  await handler?.({ messages: MESSAGES, step: 1 }, async () => ({ kind: 'accept', messages: [] }));

  assert.throws(() => readFileSync(join(dir, 'control.jsonl'), 'utf8'), 'no control-plane file is created');
  const status = commandPayload(h.commands.get('s1')?.({})) as { observation: { mode: string; observed: number } };
  assert.equal(status.observation.mode, 'off');
  assert.equal(status.observation.observed, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('enabled + observation log writes the record to the configured sink, isolated from the session log', async () => {
  const dir = mkdtempSync(join(tmpdir(), 's1cap-log-'));
  const control = join(dir, 'nested', 'control.jsonl');
  const session = join(dir, 'session.jsonl');
  const h = harness();
  apply(h.ctx, {
    enabled: true,
    // `deliver` is off in the base policy (a layout nobody receives is the safe default; `cellPolicy('C2')` is
    // what turns it on), so this is stated here rather than inherited: the fixture has to be a step that is
    // assembled *and* shown, or the test exercises the refusal path while looking like it exercises the sink.
    deliver: true,
    s1: { provider: 'none' },
    laya: { enabled: false },
    telemetry: { sessionJsonl: session, controlJsonl: control },
  });

  const handler = h.handlers.get('agent/pre-step');
  // The decision carries a claimed message, and that is the fixture keeping up with the behaviour rather than the
  // assertion being relaxed: since 2026-10-02 a decision with no messages is *ingested but not assembled* (it
  // cannot receive context, so the walk is not paid for - see "a decision with no messages costs no assembly"
  // above), and this test's subject is the record a real assembly writes to the configured sink. A fixture that
  // claimed nothing would write no assembly record at all, and the two-line assertion below would pass for the
  // wrong reason.
  const claimed = { id: 'u7', role: 'user', content: [{ type: 'text', text: 'and now the fix' }] };
  await handler?.({ messages: MESSAGES, step: 1 }, async () => ({ kind: 'accept', messages: [claimed] }));
  // The same decision again. This step is here on purpose and it is the second half of the delivery contract: the
  // block it would insert is byte-identical to the one the step above delivered, so `preStepMiddleware` refuses it.
  // That guard exists because the harness's increment never carries the previous injection back (see
  // `deliveredPayloads`), and without it a stable selection would be re-appended to the log on every step.
  await handler?.({ messages: MESSAGES, step: 2 }, async () => ({ kind: 'accept', messages: [claimed] }));

  const lines = readFileSync(control, 'utf8').trim().split('\n');
  // Two kinds of control record per step now: the assembly, and the delivery report that says whether the model
  // was shown it. The delivery report is the reason this test's count changed, and it is the reason it matters:
  // without it, "assembled" and "delivered" were indistinguishable in every log this project produced.
  const records = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.equal(records.filter((r) => r['type'] === 'assembly').length, 2, 'one assembly per observed step');
  const deliveries = records.filter((r) => r['type'] === 'context_delivery');
  assert.equal(deliveries.length, 2, 'one delivery report per step');
  // The fixture claims a message so that the first step is a *delivered* one rather than a refused one, and the
  // report says so: with `delivered: false` on both, the whole test would still pass while exercising only the
  // refusal paths, which is the shape of fixture that let "assembled" and "shown" look alike in the first place.
  assert.equal(
    deliveries[0]?.['delivered'],
    true,
    `the first step was assembled *and* delivered, which is what the sink is being asked to record: ${JSON.stringify(deliveries[0]?.['reason'])}`,
  );
  assert.deepEqual(
    deliveries.map((d) => d['delivered']),
    [true, false],
    `and the identical one after it is refused rather than repeated: ${JSON.stringify(deliveries.map((d) => d['reason']))}`,
  );
  assert.match(
    String(deliveries[1]?.['reason']),
    /already delivered in this session/,
    'the refusal names the guard that refused it, rather than blaming the harness',
  );
  assert.equal(deliveries[1]?.['messagesBefore'], 1, 'the step was still read and still reported');
  assert.equal(deliveries[1]?.['assembled'], true, 'and it was assembled: the refusal is about the repeat, not the walk');
  const record = records.find((r) => r['type'] === 'assembly') as Record<string, unknown>;
  assert.equal(record['schema'], 1);
  assert.equal(record['seq'], 0, 'the first observed step starts the observation sequence');
  assert.equal(typeof record['budgetUsed'], 'number');
  assert.ok(
    records.every((r) => !('kind' in r)),
    'a control-plane record carries `type`, never a session `kind`',
  );
  assert.throws(() => readFileSync(session, 'utf8'), 'the session sink is untouched by observation');

  const status = commandPayload(h.commands.get('s1')?.({})) as {
    observation: { mode: string; observed: number; lastSegments: number; sink: string };
  };
  assert.equal(status.observation.mode, 'log');
  assert.equal(status.observation.observed, 2);
  assert.equal(status.observation.lastSegments, MESSAGES.length);
  assert.equal(status.observation.sink, control);
  assert.ok(h.logs.some((l) => l.includes('observation mode: log')), 'the mode is announced once');
  rmSync(dir, { recursive: true, force: true });
});

test('an unknown observation value falls back to the default and is reported', async () => {
  const h = harness();
  apply(h.ctx, {
    enabled: true,
    s1: { provider: 'none' },
    laya: { enabled: false },
    observation: 'sometimes' as unknown as 'log',
  });

  assert.ok(h.warns.some((w) => w.includes('observation must be')), 'the typo is reported');
  const status = commandPayload(h.commands.get('s1')?.({})) as { observation: { mode: string } };
  assert.equal(status.observation.mode, 'log', 'the default is kept, fail-safe');
});

/**
 * F10: the tape line carried the *previous* step's session id.
 *
 * `stats.sessionId = sessionId` sat with the other `stats` writes, after `opts.emit(...)` and therefore after the
 * tape callback, so the first line of a session was written with the initial `'unassigned'` and every later line
 * with the id of the step before it. Round `20261002-2037`'s own tape shows it: line 1 `"sessionId":"unassigned"`,
 * the other 276 the real id. It matters beyond cosmetics because `noteSessionEvent` uses `stats.sessionId` as the
 * fallback when a session-event envelope carries none (envelopes are `{type, seq, time, data, surfaceOp}`) and
 * `graphFor` keys the per-session graph on it - so a content event arriving before the first assembled step would
 * be folded into a shared `'unassigned'` graph, which is the cross-session leak `rg-session-isolation.test.ts`
 * exists to prevent.
 *
 * The fixture is the *ingest-only* path on purpose, because that is where the ordering is load-bearing: a step
 * whose decision is empty still writes its tape line, still reads the payload, and never reaches the assembled
 * branch where the assignment used to live.
 */
test('the tape line for a step carries that step\'s session, including on an ingest-only step', async () => {
  const records: unknown[] = [];
  const observer = observerWith(records);
  const tape: { sessionId: string; step: number; messages: number }[] = [];
  const emitting = createStepObserver({
    policy: defaultPolicy(),
    emit: (event) => records.push(event),
    now: () => 1_790_000_000_000,
    contextWindow: 128_000,
    reserveOutputTokens: 8_000,
    fixedOverheadTokens: 1_200,
    lambdaMs: 36 * 60 * 60 * 1000,
    onTape: (step, messages, _prompt, sessionId) => tape.push({ sessionId, step, messages: messages.length }),
  });
  const { middleware } = preStep(
    emitting,
  );

  // Step 1: an ingest-only step (the decision carries no messages), on a page that names its session.
  const payload = { messages: MESSAGES, step: 1, agent: { session: { id: 'session-441e3bc3' } } };
  await middleware(payload, async () => ({ kind: 'accept', messages: [] as unknown[] }));

  assert.equal(tape.length, 1, 'the tape line is written on the ingest-only path too - that is the design');
  assert.deepEqual(
    tape[0],
    { sessionId: 'session-441e3bc3', step: 1, messages: MESSAGES.length },
    'and it names the session the step belongs to, not the previous one and not `unassigned`',
  );
  // The two readings agree, which is the property the off-by-one statement broke: the tape is written with the id
  // the counters already hold, so a later reader cannot get a different answer from `/s1` than from the tape.
  assert.equal(emitting.stats().sessionId, 'session-441e3bc3');

  // A second step from a different session, to prove the id is read per step rather than latched at activation.
  const other = { messages: MESSAGES, step: 1, agent: { session: { id: 'session-9f2c' } } };
  await middleware(other, async () => ({ kind: 'accept', messages: [] as unknown[] }));
  assert.equal(tape[1]?.sessionId, 'session-9f2c', 'the next session is named on its own first line');
  assert.equal(emitting.stats().sessionId, 'session-9f2c');
});

// --- N1 / N2 (2026-09-28): the pinned block gets the real system prompt, upkeep leaves the critical path ---

test('a captured system prompt becomes the pinned block, and the anchor wait cannot hold a step open past its deadline', async () => {
  // This test used to assert that assembly never touched the upkeep queue, and the anchor wait (`recall.anchorWaitMs`)
  // changed exactly that: with events queued, the wait drains them, because that drain is what gives a scoring call the
  // chance to finish. What survives - and what is asserted here - is the bound rather than the absence. The queue is
  // applied during the step, and the step still returns: `statsBefore` below is the proof that it was pending
  // beforehand, and the middleware call is awaited with a real, unadvanced clock, so a wait that could not terminate
  // would hang this test rather than fail it.
  const records: { blocks?: Record<string, number>; prefixTokensStable?: number }[] = [];
  const ticks: (() => void)[] = [];
  const observer = createStepObserver({
    policy: defaultPolicy(),
    emit: (event) => records.push(event as never),
    now: () => 1_790_000_000_000,
    contextWindow: 128_000,
    reserveOutputTokens: 8_000,
    fixedOverheadTokens: 1_200,
    lambdaMs: 36 * 60 * 60 * 1000,
    maxLagTurns: 2,
    schedule: (tick) => ticks.push(tick),
  });
  const middleware = preStepMiddleware(harness().ctx, observer);

  // one session event carries the rendered system prompt, another is an ordinary message
  observer.noteSessionEvent({
    type: 'step/end',
    message: { role: 'system', content: [{ type: 'text', text: 'You are a coding agent with tools.' }] },
  });
  observer.noteSessionEvent({ message: { role: 'user', content: [{ type: 'text', text: 'go' }] } });

  const statsBefore = observer.stats();
  assert.equal(statsBefore.upkeep.enqueued, 2, 'session events are queued, not applied inline');
  assert.equal(statsBefore.upkeep.pending, 2, 'and they are still pending when the step begins');
  assert.ok(statsBefore.systemPromptTokens > 0, 'the prompt is tokenised for the pinned block');
  assert.equal(ticks.length, 1, 'one deferred tick was scheduled, not one per event');

  // The decision carries a claimed message, and that is load-bearing since the no-message skip exists: a step with
  // nothing to deliver is answered before the assembly, so an empty decision here would assert nothing about the
  // pinned block. The session events above are still what supply the prompt.
  await middleware({ messages: MESSAGES, step: 1 }, async () => ({ kind: 'accept', messages: [{ id: 'u9', role: 'user' }] }));

  const record = records[records.length - 1];
  assert.ok((record?.blocks?.['pinned'] ?? 0) > 0, 'the pinned block is no longer empty');
  assert.equal(record?.prefixTokensStable, record?.blocks?.['pinned'], 'the cache-stable prefix is the pinned block');
  const afterStep = observer.stats();
  assert.equal(afterStep.upkeep.applied, 2, 'the wait drained the pending events, which is what it is for');
  assert.equal(afterStep.upkeep.errors, 0);

  // the deferred tick still drains whatever is left, outside the hook
  ticks[0]?.();
  const after = observer.stats();
  assert.equal(after.upkeep.pending, 0);
  assert.ok(after.graphSegments >= MESSAGES.length, 'the graph has the session events');
  assert.equal(after.upkeep.overLag, false);
});

test('upkeep lag is visible in the stats and clears when the tick runs', async () => {  const ticks: (() => void)[] = [];
  const observer = createStepObserver({
    policy: defaultPolicy(),
    emit: () => undefined,
    now: () => 0,
    contextWindow: 128_000,
    reserveOutputTokens: 8_000,
    fixedOverheadTokens: 1_200,
    lambdaMs: 1,
    maxLagTurns: 1,
    schedule: (tick) => ticks.push(tick),
  });
  observer.noteSessionEvent({ message: { role: 'user', content: [{ type: 'text', text: 'a' }] } });
  observer.noteSessionEvent({ message: { role: 'user', content: [{ type: 'text', text: 'b' }] } });

  assert.equal(observer.stats().upkeep.overLag, true, 'two pending against maxLagTurns 1');
  ticks[0]?.();
  assert.equal(observer.stats().upkeep.overLag, false);
});

/**
 * The plan gate used to be exercised here: the observer was handed a gate and this test asserted that the model's
 * own output reached it, in both the `assistant` and the `trace` shape.
 *
 * It is deleted with the wiring it tested - the observer has no `planGate` option any more, because the policy field
 * is gone (`packages/core/src/types.ts` carries the measurement: round `20261002-2037` recorded no `plan_gate` event
 * in any artifact). The trap it documented is worth keeping in view for whoever wires a gate back in: a message
 * whose parts are only text adapts to `assistant`, and one carrying reasoning *and* text - which is what this model
 * emits - adapts to `trace` with both merged, so filtering on `assistant` alone inspects nothing while the model
 * writes numbered plans the whole time.
 */
