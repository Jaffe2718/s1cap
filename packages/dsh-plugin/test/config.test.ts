import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_TELEMETRY, apply, resolvePluginConfig } from '../src/index.ts';
import type { PluginContext } from '../src/index.ts';

interface Harness {
  ctx: PluginContext;
  logs: string[];
  warns: string[];
  commands: Map<string, (arg: { rawInput?: string }) => unknown>;
  events: string[];
  handlers: Map<string, (...args: unknown[]) => unknown>;
}

function harness(): Harness {
  const logs: string[] = [];
  const warns: string[] = [];
  const commands = new Map<string, (arg: { rawInput?: string }) => unknown>();
  const events: string[] = [];
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ctx: PluginContext = {
    on(event, handler) {
      events.push(event);
      handlers.set(event, handler as (...args: unknown[]) => unknown);
    },
    effect(fn) {
      return fn();
    },
    commands: {
      register(spec) {
        commands.set(spec.name, spec.handler);
      },
    },
    logger: {
      info: (m: string) => logs.push(m),
      warn: (m: string) => warns.push(m),
    },
  };
  return { ctx, logs, warns, commands, events, handlers };
}

/** A Laya block that never spawns anything (autoStart off) and needs no probe. */
const layaIdle = { enabled: true, autoStart: false, host: '127.0.0.1', port: 8008 };

test('defaults: C4 policy, provider jev, two distinct sinks, no conflicts', () => {
  const resolved = resolvePluginConfig(undefined);
  assert.equal(resolved.config.cell, 'C4');
  assert.equal(resolved.config.termination, 'model-owned');
  assert.deepEqual(resolved.telemetry, DEFAULT_TELEMETRY);
  assert.deepEqual(resolved.conflicts, []);
  assert.deepEqual(resolved.telemetryErrors, []);
  assert.equal(resolved.policy.ok, true);
  assert.equal(resolved.laya.ok, true);
});

test('layausa runtime endpoint drives the resolved base URL when provider is laya-serve', () => {
  const resolved = resolvePluginConfig({
    s1: { provider: 'laya-serve', timeoutMs: 4000 },
    laya: { enabled: true, autoStart: false, host: '127.0.0.1', port: 9123, model: 'english' },
  });
  assert.deepEqual(resolved.conflicts, []);
  assert.equal(resolved.config.s1.provider, 'laya-serve');
  assert.equal(resolved.config.laya?.port, 9123);
  assert.equal(resolved.config.laya?.autoStart, false);
});

test('enabling Laya while a cloud provider is selected is a conflict, never a priority rule', () => {
  const resolved = resolvePluginConfig({ s1: { provider: 'jev' }, laya: layaIdle });
  assert.equal(resolved.conflicts.length, 1);
  assert.match(resolved.conflicts[0] ?? '', /only one S1 backend/);
});

test('merging the two telemetry streams is refused and the defaults are restored', () => {
  const merged = resolvePluginConfig({
    telemetry: { sessionJsonl: './x.jsonl', controlJsonl: './x.jsonl' },
  });
  assert.equal(merged.telemetryErrors.length, 1);
  assert.match(merged.telemetryErrors[0] ?? '', /may never be merged/);
  assert.deepEqual(merged.telemetry, DEFAULT_TELEMETRY);

  const bad = resolvePluginConfig({ telemetry: { sessionJsonl: 42 as unknown as string } });
  assert.equal(bad.telemetryErrors.length, 1);
  assert.deepEqual(bad.telemetry, DEFAULT_TELEMETRY);
});

test('apply() registers the hooks and commands, and a conflict degrades to observation mode', () => {
  const h = harness();
  apply(h.ctx, { enabled: true, s1: { provider: 'jev', apiKey: 'sk-live-SUPERSECRET-0123456789' }, laya: layaIdle });

  assert.deepEqual(h.events, ['session/event', 'agent/pre-step'], 'agent/request-error stays unregistered until its contract is verified');
  assert.deepEqual([...h.commands.keys()], ['s1-tune', 's1', 's1-ping', 's1-laya']);
  assert.ok(h.logs.some((l) => l.includes('command registered: /s1')));
  assert.ok(h.warns.some((w) => w.includes('only one S1 backend')));
  assert.ok(h.warns.some((w) => w.includes('makes no System-1 calls')));

  const status = h.commands.get('s1')?.({}) as {
    s1: { provider: string; mode: string; key: string };
    telemetry: { sessionJsonl: string; controlJsonl: string };
    configIssues: { conflicts: string[] };
  };
  assert.equal(status.s1.provider, 'none', 'a conflicted session makes no System-1 calls');
  assert.equal(status.s1.mode, 'none');
  assert.equal(status.s1.key, '(none)');
  assert.deepEqual(status.telemetry, DEFAULT_TELEMETRY);
  assert.equal(status.configIssues.conflicts.length, 1);

  const everything = [...h.logs, ...h.warns].join('\n');
  assert.ok(!everything.includes('SUPERSECRET'), 'no log line may contain key material');
});

test('apply() reports the resolved backend without leaking the key, and ping is honest', async () => {
  const h = harness();
  apply(h.ctx, { enabled: true, s1: { provider: 'jev', apiKey: 'sk-live-SUPERSECRET-0123456789' }, laya: { enabled: false } });

  const info = h.logs.join('\n');
  assert.match(info, /provider=jev \(cloud\)/);
  assert.ok(!info.includes('SUPERSECRET'));

  const status = h.commands.get('s1')?.({}) as { s1: { provider: string; key: string; baseUrl: string } };
  assert.equal(status.s1.provider, 'jev');
  assert.equal(status.s1.baseUrl, 'https://api.typesafe.ai');
  assert.match(status.s1.key, /^sk-l…89/);
  assert.ok(!status.s1.key.includes('SUPERSECRET'));

  const ping = (await h.commands.get('s1-ping')?.({})) as { ok: boolean };
  assert.equal(typeof ping.ok, 'boolean', 'ping reports reachability as a boolean');

  const none = harness();
  apply(none.ctx, { enabled: true, s1: { provider: 'none' } });
  const idle = (await none.commands.get('s1-ping')?.({})) as { ok: boolean; reason: string };
  assert.equal(idle.ok, false);
  assert.match(idle.reason, /provider=none/);
});

test('every config problem is reported as a warning and the session keeps its defaults', () => {
  const h = harness();
  apply(h.ctx, {
    enabled: true,
    cell: 'C9' as unknown as 'C4',
    termination: 'harness-owned' as unknown as 'model-owned',
    recall: { relevanceThreshold: 3 } as never,
    laya: { enabled: true, autoStart: false, port: 99999 },
  });
  const warns = h.warns.join('\n');
  assert.match(warns, /cell: must be one of/);
  assert.match(warns, /termination: must be "model-owned"/);
  assert.match(warns, /recall\.relevanceThreshold: must be within/);
  assert.match(warns, /laya\.port: must be within/);
  const status = h.commands.get('s1')?.({}) as { recall: { relevanceThreshold: number }; cell: string };
  assert.equal(status.recall.relevanceThreshold, 0.55, 'invalid value falls back to the default');
  assert.equal(status.cell, 'C4');
});

test('the plugin is inert unless explicitly enabled', () => {
  const off = harness();
  apply(off.ctx, undefined);
  assert.deepEqual(off.events, [], 'no hooks without enabled: true');
  assert.equal(off.commands.size, 0, 'no commands without enabled: true');
  assert.ok(off.logs.some((l) => l.includes('not enabled')));

  const explicit = harness();
  apply(explicit.ctx, { enabled: false, s1: { provider: 'jev' } });
  assert.deepEqual(explicit.events, []);
  assert.equal(explicit.commands.size, 0);
});

test('the pre-step middleware honours the waterfall contract (call next once, return its decision)', async () => {
  const h = harness();
  apply(h.ctx, { enabled: true, s1: { provider: 'none' } });
  const handler = h.handlers.get('agent/pre-step');
  assert.equal(typeof handler, 'function');

  const decision = { kind: 'accept', messages: [{ kind: 'user' }] };
  let calls = 0;
  const returned = await handler?.({ agent: {}, messages: [], signal: {}, step: 1 }, async () => {
    calls += 1;
    return decision;
  });
  assert.equal(calls, 1, 'next() must be awaited exactly once');
  assert.equal(returned, decision, 'the decision must be returned unchanged (identity preserved)');

  // a harness error must propagate untouched, never be swallowed by our bookkeeping
  await assert.rejects(
    async () => handler?.({}, async () => {
      throw new Error('harness blew up');
    }),
    /harness blew up/,
  );
});

test('activation can never throw: a hostile context leaves the plugin inert and the harness alive', () => {
  const logs: string[] = [];
  const hostile = {
    on() {
      throw new Error('no event service');
    },
    commands: {
      register() {
        throw new Error('no command service');
      },
    },
    logger: { warn: (m: string) => logs.push(m), info: () => undefined },
  } as unknown as PluginContext;

  assert.doesNotThrow(() => apply(hostile, { enabled: true, s1: { provider: 'jev' } }));
  assert.ok(logs.some((l) => l.includes('activation failed')), 'the failure is reported, not thrown');

  const brokenLogger = {
    on() {
      throw new Error('boom');
    },
    logger: {
      warn() {
        throw new Error('logger also broken');
      },
      info() {
        throw new Error('logger also broken');
      },
    },
  } as unknown as PluginContext;
  assert.doesNotThrow(() => apply(brokenLogger, { enabled: true }));
});
