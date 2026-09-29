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
import { apply, preStepMiddleware } from '../src/index.ts';
import type { CommandSpec, PluginContext } from '../src/index.ts';
import { commandPayload } from './command-contract.ts';
import { createStepObserver } from '../src/step-observer.ts';

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

test('a pre-step call emits one assembly record and returns the harness decision untouched', async () => {
  const records: { type?: unknown }[] = [];
  const observer = observerWith(records);
  const middleware = preStepMiddleware(harness().ctx, observer);
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

  const stats = observer.stats();
  assert.equal(stats.steps, 1);
  assert.equal(stats.observed, 1);
  assert.equal(stats.skipped, 0);
  assert.equal(stats.errors, 0);
  assert.equal(stats.lastSegments, MESSAGES.length);
  assert.ok(stats.lastWouldSaveTokens >= 0);
  assert.deepEqual(stats.unknownRoles, [], 'the DSH role table covers every role in the fixture');
});

test('a payload without a message list is skipped, not guessed at', async () => {
  const records: unknown[] = [];
  const observer = observerWith(records);
  const middleware = preStepMiddleware(harness().ctx, observer);

  await middleware({ step: 1 }, async () => ({ kind: 'accept', messages: [] }));
  await middleware(undefined, async () => ({ kind: 'accept', messages: [] }));

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
  const decision = { kind: 'accept', messages: [] };

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
    s1: { provider: 'none' },
    laya: { enabled: false },
    telemetry: { sessionJsonl: session, controlJsonl: control },
  });

  const handler = h.handlers.get('agent/pre-step');
  await handler?.({ messages: MESSAGES, step: 1 }, async () => ({ kind: 'accept', messages: [] }));
  await handler?.({ messages: MESSAGES, step: 2 }, async () => ({ kind: 'accept', messages: [] }));

  const lines = readFileSync(control, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2, 'one control-plane record per observed step');
  const record = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
  assert.equal(record['type'], 'assembly');
  assert.equal(record['schema'], 1);
  assert.equal(record['seq'], 0, 'the first observed step starts the observation sequence');
  assert.equal(typeof record['budgetUsed'], 'number');
  assert.equal('kind' in record, false, 'a control-plane record carries `type`, never a session `kind`');
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

// --- N1 / N2 (2026-09-28): the pinned block gets the real system prompt, upkeep leaves the critical path ---

test('a captured system prompt becomes the pinned block, and upkeep never runs inside observe()', async () => {
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
  assert.equal(statsBefore.upkeep.applied, 0, 'observe() must not drain upkeep');
  assert.ok(statsBefore.systemPromptTokens > 0, 'the prompt is tokenised for the pinned block');
  assert.equal(ticks.length, 1, 'one deferred tick was scheduled, not one per event');

  await middleware({ messages: MESSAGES, step: 1 }, async () => ({ kind: 'accept', messages: [] }));

  const record = records[records.length - 1];
  assert.ok((record?.blocks?.['pinned'] ?? 0) > 0, 'the pinned block is no longer empty');
  assert.equal(record?.prefixTokensStable, record?.blocks?.['pinned'], 'the cache-stable prefix is the pinned block');
  assert.equal(observer.stats().upkeep.applied, 0, 'assembly did not wait for upkeep');

  // the deferred tick drains the queue outside the hook
  ticks[0]?.();
  const after = observer.stats();
  assert.equal(after.upkeep.applied, 2);
  assert.equal(after.upkeep.pending, 0);
  assert.ok(after.graphSegments >= MESSAGES.length, 'the graph has the session events');
  assert.equal(after.upkeep.overLag, false);
});

test('upkeep lag is visible in the stats and clears when the tick runs', async () => {
  const ticks: (() => void)[] = [];
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
