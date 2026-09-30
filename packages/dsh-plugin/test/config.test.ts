import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_TELEMETRY, apply, resolvePluginConfig } from '../src/index.ts';
import type { PluginContext } from '../src/index.ts';
import { parseTuning, parseTuningArgs } from '../src/credentials.ts';
import { commandPayload, commandKind, commandText } from './command-contract.ts';

interface Harness {
  ctx: PluginContext;
  logs: string[];
  warns: string[];
  commands: Map<string, (arg: { rawInput?: string }) => unknown>;
  events: string[];
  handlers: Map<string, (...args: unknown[]) => unknown>;
}

/**
 * Run `body` with DSH_HOME pointing at an empty temporary directory.
 *
 * Activation reads the stored tuning file, so without this a test's expectations depend on whatever the machine
 * running it happens to have in ~/.dsh - a failure that looks like a code bug and is not one.
 */
function withEmptyHome<T>(body: () => T): T {
  const previous = process.env['DSH_HOME'];
  const dir = mkdtempSync(join(tmpdir(), 's1cap-test-home-'));
  process.env['DSH_HOME'] = dir;
  try {
    return body();
  } finally {
    if (previous === undefined) delete process.env['DSH_HOME'];
    else process.env['DSH_HOME'] = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the layout switch survives both wire formats, and a typo never flips a layout', () => {
  // The credential string is the four-field form the host writes; the command line is what a human types.
  assert.equal(parseTuning('2 0.55 1024 on').xFirst, true);
  assert.equal(parseTuning('2 0.55 1024 off').xFirst, false);
  assert.equal(parseTuning('2 0.55 1024 1').xFirst, true);
  assert.equal(parseTuning('2 0.55 1024 0').xFirst, false);
  assert.equal(parseTuning('2 0.55 1024').xFirst, undefined, 'absent means: leave the policy default alone');

  // A misspelling must be dropped rather than guessed at. `off` and `on` are one character apart, so a guess
  // here would silently reorder the prompt, which is the one thing an ablation must never do by accident.
  assert.equal(parseTuning('2 0.55 1024 of').xFirst, undefined);
  assert.equal(parseTuning('2 0.55 1024 maybe').xFirst, undefined);

  assert.equal(parseTuningArgs('xFirst=on').xFirst, true);
  assert.equal(parseTuningArgs('xf=off').xFirst, false);
  assert.equal(parseTuningArgs('3 0.7 512 off').xFirst, false, 'fourth positional is the switch');
  assert.equal(parseTuningArgs('xFirst=perhaps').xFirst, undefined);
  // A dropped switch must not take the other three fields down with it.
  assert.deepEqual(parseTuningArgs('3 0.7 512 of'), { depth: 3, relevanceThreshold: 0.7, window: 512 });
});

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
// An enabled Laya carries the interpreter the user typed: choosing the local backend means committing to a
// specific python.exe, so these fixtures state one. The rule that demands it has its own test in s1-client.
const layaIdle = {
  enabled: true,
  autoStart: false,
  host: '127.0.0.1',
  port: 8008,
  pythonPath: 'D:/tools/laya_py/env/python.exe',
};

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
    laya: {
      enabled: true,
      autoStart: false,
      host: '127.0.0.1',
      port: 9123,
      model: 'english',
      pythonPath: 'D:/tools/laya_py/env/python.exe',
    },
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

test('enabling Laya without an interpreter path is a conflict, not a warning', () => {
  // The host-side half of "the settings panel must have a path for Laya": the panel is another repository, so
  // what this side owes is a refusal that the panel can read. A conflict drops the session to provider=none and
  // is reported in `/s1` and the log, which is what makes the field fillable rather than advisory.
  const resolved = resolvePluginConfig({
    s1: { provider: 'laya-serve' },
    laya: { enabled: true, autoStart: false, host: '127.0.0.1', port: 8008 },
  });
  assert.equal(resolved.conflicts.length, 1, `expected one conflict, got ${JSON.stringify(resolved.conflicts)}`);
  assert.match(resolved.conflicts[0] ?? '', /laya\.pythonPath is empty/);
  assert.ok(
    !resolved.config.laya?.pythonPath,
    'and no path is invented behind the user: the field stays as given, which is what the panel fills',
  );
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

  assert.deepEqual(h.events, ['session/event', 'loader/volatile-update', 'agent/pre-step'], 'agent/request-error stays unregistered until its contract is verified');
  assert.deepEqual([...h.commands.keys()], ['s1-tune', 's1', 's1-ping', 's1-laya']);
  assert.ok(h.logs.some((l) => l.includes('command registered: /s1')));
  assert.ok(h.warns.some((w) => w.includes('only one S1 backend')));
  assert.ok(h.warns.some((w) => w.includes('makes no System-1 calls')));

  const status = commandPayload(h.commands.get('s1')?.({})) as {
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

  const status = commandPayload(h.commands.get('s1')?.({})) as { s1: { provider: string; key: string; baseUrl: string } };
  assert.equal(status.s1.provider, 'jev');
  assert.equal(status.s1.baseUrl, 'https://api.typesafe.ai');
  assert.match(status.s1.key, /^sk-l…89/);
  assert.ok(!status.s1.key.includes('SUPERSECRET'));

  // `s1-ping` reaches the network, so its result is asserted through the contract rather than for a value: a
  // reachable backend is `success`, an unreachable one is `error`, and both must be legal results.
  const ping = await h.commands.get('s1-ping')?.({});
  assert.ok(['success', 'error'].includes(commandKind(ping) ?? ''), `ping returned ${String(commandKind(ping))}`);
  commandPayload(ping === undefined ? {} : { ...(ping as object), kind: 'success' });

  const none = harness();
  apply(none.ctx, { enabled: true, s1: { provider: 'none' } });
  const idle = await none.commands.get('s1-ping')?.({});
  assert.equal(commandKind(idle), 'error', 'no backend is reported as an error, not as a silent success');
  assert.match(commandText(idle), /provider=none/);
});

test('every config problem is reported as a warning and the session keeps its defaults', () => {
  const h = harness();
  // Point the home directory at an empty one first. Activation now folds the stored tuning file into the live
  // policy - that is the point, so a profile reports the researcher's values without waiting for a session - and
  // this test is about *profile* validation falling back to defaults, not about what a developer's own
  // ~/.dsh/.s1cap/tuning.json happens to hold. Reading the real home made this assertion depend on the machine.
  withEmptyHome(() => {
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
  const status = commandPayload(h.commands.get('s1')?.({})) as { recall: { relevanceThreshold: number }; cell: string };
  assert.equal(status.recall.relevanceThreshold, 0.55, 'invalid value falls back to the default');
  assert.equal(status.cell, 'C4');
  });
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

test('a stored xFirst=false reaches the config: the write, the read and the apply agree', () => {
  // This is the test whose absence cost a live debugging round. `parseTuning` handling `off` was verified, the
  // route echoed `xFirst: false` back, the file on disk held `false` - and the layout still ran on its default,
  // because the reader between the file and the config never looked at the field at all. Asserting the parser
  // alone could not see that, so this drives the real path: write the file, activate, read the config.
  withEmptyHome(() => {
    const home = process.env['DSH_HOME'];
    assert.ok(home !== undefined);
    const file = join(home, '.s1cap', 'tuning.json');
    mkdirSync(join(home, '.s1cap'), { recursive: true });
    writeFileSync(file, JSON.stringify({ depth: 5, relevanceThreshold: 0.7, window: 1600, xFirst: false }), 'utf8');

    const h = harness();
    apply(h.ctx, { enabled: true, s1: { provider: 'none' } });

    const status = JSON.parse(JSON.stringify(commandPayload(h.commands.get('s1')?.({})) ?? {})) as {
      xFirst?: boolean;
      recall?: { depth?: number; window?: number };
      tuning?: { effective?: { xFirst?: boolean } };
    };
    // The status command reports the live config object the observer holds, so this is the value assembly sees.
    assert.equal(status.xFirst, false, 'a stored false must override the default true');
    assert.equal(status.recall?.depth, 5, 'and the numeric knobs still arrive alongside it');
    assert.equal(status.recall?.window, 1600);
    assert.equal(status.tuning?.effective?.xFirst, false, 'and the route reports the same value it applied');
  });
});
