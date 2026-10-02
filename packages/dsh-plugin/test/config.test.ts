import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_TELEMETRY, apply, readTuningFile, resolvePluginConfig } from '../src/index.ts';
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

/**
 * The same, for a body that awaits.
 *
 * The synchronous version cannot be used with an async callback: it restores DSH_HOME in its `finally` as soon as
 * `body()` hands back the pending promise, so everything the body awaited afterwards ran against the real
 * ~/.dsh. The test that exposed it failed with "no interpreter", which is exactly the symptom a reader would
 * misread as an implementation bug.
 */
async function withEmptyHomeAsync<T>(body: () => Promise<T>): Promise<T> {
  const previous = process.env['DSH_HOME'];
  const dir = mkdtempSync(join(tmpdir(), 's1cap-test-home-'));
  process.env['DSH_HOME'] = dir;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env['DSH_HOME'];
    else process.env['DSH_HOME'] = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the reader picks up every field the writer can store, Laya included', () => {
  // The gap this closes was invisible from the outside and identical in shape to the xFirst one: the panel wrote
  // an interpreter path, the route echoed it back out of the in-memory copy, and the session still started with
  // `provider=none` and "fill in the interpreter path in the settings panel" — a file that existed, was readable,
  // and was not being read. Testing the parser alone would never have found it; the reader is the half that broke.
  const stored = withEmptyHome(() => {
    const dir = join(process.env['DSH_HOME'] as string, '.s1cap');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'tuning.json'),
      JSON.stringify({
        depth: 4,
        relevanceThreshold: 0.4,
        window: 1600,
        xFirst: false,
        layaPythonPath: 'D:\\conda_store\\envs\\ml\\python.exe',
        layaWeightsCacheDir: 'D:/hf-cache',
        layaWeightsEnvVar: 'HF_HOME',
        provider: 'laya-serve',
      }),
      'utf8',
    );
    return readTuningFile();
  });

  assert.equal(stored.depth, 4);
  assert.equal(stored.relevanceThreshold, 0.4);
  assert.equal(stored.window, 1600);
  assert.equal(stored.xFirst, false, 'false is a value, not an absence');
  assert.equal(stored.layaPythonPath, 'D:\\conda_store\\envs\\ml\\python.exe');
  assert.equal(stored.layaWeightsCacheDir, 'D:/hf-cache');
  assert.equal(stored.layaWeightsEnvVar, 'HF_HOME');
  // The backend the radio selected. Read through the same validator the command line uses, because the panel's
  // write half was already complete and a missing read half is invisible from the panel: the file holds the
  // choice, the radio shows it, and the next start comes up on the profile's provider instead.
  assert.equal(stored.provider, 'laya-serve');

  // The same validators the command line uses, so a hand-edited file cannot smuggle in a value the Save button
  // would have refused: an unusable entry is dropped and the default stands.
  const partial = withEmptyHome(() => {
    const dir = join(process.env['DSH_HOME'] as string, '.s1cap');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'tuning.json'),
      JSON.stringify({ layaPythonPath: 'python', layaWeightsEnvVar: 42, depth: 0, provider: 'openai' }),
      'utf8',
    );
    return readTuningFile();
  });
  assert.equal(partial.layaPythonPath, undefined, 'a bare token is not a path');
  assert.equal(partial.layaWeightsEnvVar, undefined, 'a number is not a variable name');
  assert.equal(partial.depth, undefined, 'and the numeric rules still hold');
  assert.equal(partial.provider, undefined, 'and a provider no policy allows is dropped rather than guessed at');
});

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

/** Let the effects `apply` scheduled run to completion. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 1));
}

test('an interpreter the panel stored reaches the live config, read back through /s1', async () => {
  // Written this way on purpose: the bug it catches was a *shadowed variable* — the activation code assigned the
  // panel's path to a local copy of the Laya config that nothing else holds, so the assignment "worked" and the
  // session still had no interpreter, still reported the conflict, and would have launched nothing. A test that
  // only checked the assignment would have passed. This one asks the same question the operator does: what does
  // the plugin say it is going to use?
  const h = harness();
  await withEmptyHomeAsync(async () => {
    const dir = join(process.env['DSH_HOME'] as string, '.s1cap');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'tuning.json'),
      JSON.stringify({ layaPythonPath: 'D:\\conda_store\\envs\\ml\\python.exe', layaWeightsEnvVar: 'HF_HOME' }),
      'utf8',
    );
    // `apply` takes the context first and the config second, and the config needs `enabled: true` — without it
    // activation returns inert before any command is registered, which is what the first run of this test did.
    await apply(h.ctx, {
      enabled: true,
      s1: { provider: 'laya-serve' },
      laya: { ...layaIdle, pythonPath: '' },
    });
    // The panel's store is read by `primeOnce`, which runs on the first agent step and not at activation — that
    // is deliberate (the knobs must be in place before the first observation), and it means a test that only
    // activates is testing nothing about this path. One real step, through the host's waterfall.
    const step = h.handlers.get('agent/pre-step');
    assert.equal(typeof step, 'function', 'the pre-step hook must be registered');
    await step?.({ agent: {}, messages: [], signal: {}, step: 1 }, async () => ({ kind: 'enter', messages: [] }));
    await settle();
  });

  const payload = JSON.parse(JSON.stringify(commandPayload(h.commands.get('s1')?.({})) ?? {})) as {
    laya?: { pythonPath?: string; weights?: { envVar?: string; cacheDir?: string }; state?: unknown };
    s1?: { provider?: string; mode?: string; baseUrl?: string };
    configIssues?: { conflicts?: string[] };
  };
  assert.equal(
    payload.laya?.pythonPath,
    'D:\\conda_store\\envs\\ml\\python.exe',
    'the interpreter the panel stored is the one the plugin reports',
  );
  assert.equal(
    (payload.laya as { weights?: { envVar?: string } } | undefined)?.weights?.envVar,
    'HF_HOME',
    'and the weights variable name the panel stored is the one the launcher will set',
  );
  assert.deepEqual(
    (payload.configIssues?.conflicts ?? []).filter((c) => c.includes('pythonPath')),
    [],
    'and supplying it clears the conflict, rather than leaving a stored value that only exists in a file',
  );

  // And the cleared conflict has to be *load-bearing*. Before this, the conflict list emptied while the session
  // kept the `provider=none` client it was built with at activation: `/s1` said the run was fine and the process
  // made zero System-1 calls. The backend is therefore re-resolved on the first step, and this is the assertion
  // that says so — the number a run is actually judged on.
  const s1 = payload.s1 as { provider?: string; mode?: string; baseUrl?: string } | undefined;
  assert.equal(s1?.provider, 'laya-serve', 'the re-resolved provider is the one configured, not the demoted one');
  assert.notEqual(s1?.mode, 'none', 'and the session actually calls System-1 once the path is known');
});

test('switching the backend from the panel re-resolves the client, not just the config object', async () => {
  // The mirror of the test above, for the radio. Writing `config.s1.provider` is the easy half and the wrong thing
  // to assert: the save could set it and leave the session calling the client it was built with at activation —
  // a radio that looks switched while the same backend keeps answering, or while none does. The assertion is
  // therefore the provider `/s1` reports, which is read from the *resolved* backend, plus the conflict count that
  // decided it.
  const h = harness();
  await withEmptyHomeAsync(async () => {
    apply(h.ctx, { enabled: true, s1: { provider: 'jev', apiKey: 'sk-live-SWITCHED-0123456789' }, laya: layaIdle });

    const read = () =>
      JSON.parse(JSON.stringify(commandPayload(h.commands.get('s1')?.({})) ?? {})) as {
        s1?: { provider?: string; configuredProvider?: string; mode?: string };
        configIssues?: { conflicts?: string[] };
        tuning?: { effective?: { provider?: string } };
      };

    // A profile that enables Laya while selecting the cloud backend is the demoted case: one conflict, no System-1
    // calls, and a resolved provider of `none` rather than the configured `jev`.
    const before = read();
    assert.equal(before.s1?.provider, 'none', 'the conflicting profile starts demoted');
    assert.equal(before.s1?.configuredProvider, 'jev', 'while the config still names the cloud backend');
    assert.equal(before.configIssues?.conflicts?.length, 1);

    // Exactly what the radio's Save sends, through the same parser the PUT route uses.
    const saved = h.commands.get('s1-tune')?.({ rawInput: 'provider=laya-serve' });
    assert.equal(commandKind(saved), 'success', commandText(saved));
    assert.match(commandText(saved), /provider=laya-serve/, 'the answer names the backend it switched to');

    const after = read();
    assert.equal(after.s1?.configuredProvider, 'laya-serve');
    assert.equal(
      after.s1?.provider,
      'laya-serve',
      'the re-resolved provider is the one the radio sent, not the demoted one the client was built with',
    );
    assert.notEqual(after.s1?.mode, 'none', 'and the session calls the backend it just selected');
    assert.deepEqual(after.configIssues?.conflicts, [], 'selecting the local backend resolves the conflict it was about');
    assert.equal(after.tuning?.effective?.provider, 'laya-serve', 'and /s1 reports the value the save applied');

    // Persisted, because the panel's only durable store is this file: a switch that lives in memory until the host
    // exits is a radio the next start contradicts.
    const file = JSON.parse(readFileSync(join(process.env['DSH_HOME'] as string, '.s1cap', 'tuning.json'), 'utf8')) as {
      provider?: string;
    };
    assert.equal(file.provider, 'laya-serve');

    // An unknown provider is dropped before it reaches the host, so the running backend is left alone.
    const refused = h.commands.get('s1-tune')?.({ rawInput: 'provider=openai' });
    assert.equal(commandKind(refused), 'error', 'a provider no policy allows is refused, not clamped');
    assert.equal(read().s1?.provider, 'laya-serve', 'and the session keeps the backend it had');
  });
});

test('switching the backend off from the panel leaves the session with no client at all', async () => {
  // The mirror of the test above, for the Off choice. `provider=none` could always be written by hand, so the
  // parser accepting it proves nothing about the thing that matters: whether the running session *loses its
  // client*. A save that set `config.s1.provider = 'none'` and kept the client built at activation would report
  // `mode: none` while the same cloud backend kept answering every relevance window — the exact shape of the
  // Laya gap this suite already pins twice (a value that is written, echoed, and never applied).
  const h = harness();
  await withEmptyHomeAsync(async () => {
    apply(h.ctx, { enabled: true, s1: { provider: 'jev', apiKey: 'sk-live-SWITCHEDOFF-0123456789' }, laya: { enabled: false } });

    const read = () =>
      JSON.parse(JSON.stringify(commandPayload(h.commands.get('s1')?.({})) ?? {})) as {
        s1?: { provider?: string; configuredProvider?: string; mode?: string; baseUrl?: string; key?: string };
        tuning?: { effective?: { provider?: string } };
      };

    const before = read();
    assert.equal(before.s1?.provider, 'jev', 'the profile starts on the cloud backend');
    assert.equal(before.s1?.mode, 'cloud');
    assert.equal(before.s1?.baseUrl, 'https://api.typesafe.ai');

    // Exactly what the Off radio's Save sends, through the same parser the PUT route uses.
    const saved = h.commands.get('s1-tune')?.({ rawInput: 'provider=none' });
    assert.equal(commandKind(saved), 'success', commandText(saved));
    assert.match(commandText(saved), /provider=none/, 'the answer names the state it switched to');

    const after = read();
    assert.equal(after.s1?.configuredProvider, 'none', 'the config asks for no backend');
    assert.equal(after.s1?.provider, 'none', 'and the session resolved to no backend, not to the demoted cloud one');
    assert.equal(after.s1?.mode, 'none');
    assert.equal(after.s1?.baseUrl, undefined, 'no endpoint is resolved, so there is no client to build from one');
    assert.equal(after.s1?.key, '(none)', 'and no credential is carried into a session that makes no calls');
    assert.equal(after.tuning?.effective?.provider, 'none', 'and /s1 reports the value the save applied');

    // The client itself, not a string about it: `s1-ping` is the one command that reaches for the live `client`
    // and errors when there is none. That variable is the same one `relevance`'s delegate reads, so "no client"
    // here is "the relevance path answers no weights" there (a missing client is `undefined` from the delegate,
    // which the scorer reads as "score lexically" rather than as an empty answer).
    const ping = await h.commands.get('s1-ping')?.({});
    assert.equal(commandKind(ping), 'error', 'there is no client to probe');
    assert.match(commandText(ping), /no System-1 backend is active/);

    // Persisted, because the panel's only durable store is this file: a switch that lives in memory until the host
    // exits is an Off that the next start contradicts — and the run restarts between cells.
    const file = JSON.parse(readFileSync(join(process.env['DSH_HOME'] as string, '.s1cap', 'tuning.json'), 'utf8')) as {
      provider?: string;
    };
    assert.equal(file.provider, 'none');
  });
});

test('a stored provider is applied at activation and re-resolved, so a switch survives the restart', async () => {
  // The read half of the same switch. `readTuningFile` dropping this field would be invisible from the panel: the
  // radio would show the backend the user picked, the file would hold it, and the next start would come up on the
  // profile's provider — the identical shape to the xFirst and Laya read-half gaps this suite already pins.
  const h = harness();
  await withEmptyHomeAsync(async () => {
    const dir = join(process.env['DSH_HOME'] as string, '.s1cap');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'tuning.json'), JSON.stringify({ provider: 'laya-serve' }), 'utf8');

    // The profile says the cloud backend; the panel's file says the local one. Laya is enabled but its interpreter
    // arrives on the first step (the panel's Laya fields are read there, deliberately), so this asserts the
    // *selection*, not a conflict-free session.
    await apply(h.ctx, { enabled: true, s1: { provider: 'jev' }, laya: { ...layaIdle, pythonPath: '' } });

    const status = JSON.parse(JSON.stringify(commandPayload(h.commands.get('s1')?.({})) ?? {})) as {
      s1?: { provider?: string; configuredProvider?: string };
      tuning?: { effective?: { provider?: string } };
    };
    assert.equal(status.s1?.configuredProvider, 'laya-serve', 'the stored provider is the selected one, not the profile');
    assert.equal(status.tuning?.effective?.provider, 'laya-serve', 'and /s1 reports the same value the panel wrote');
    // An override of the profile is said out loud, like every other tuning override of a cell: which backend
    // answers is not a value that may change silently between two runs of an ablation.
    assert.ok(
      h.warns.some((w) => w.includes('provider jev -> laya-serve')),
      `the override is reported, got: ${h.warns.join(' | ')}`,
    );
  });
});

test('defaults: C2 policy, provider jev, two distinct sinks, no conflicts', () => {
  const resolved = resolvePluginConfig(undefined);
  assert.equal(resolved.config.cell, 'C2');
  assert.equal(resolved.config.termination, 'model-owned');
  assert.deepEqual(resolved.telemetry, DEFAULT_TELEMETRY);
  assert.deepEqual(resolved.conflicts, []);
  assert.deepEqual(resolved.telemetryErrors, []);
  assert.equal(resolved.policy.ok, true);
  assert.equal(resolved.laya.ok, true);
});

test('layausa runtime endpoint drives the resolved base URL when provider is laya-serve', () => {
  const resolved = resolvePluginConfig({
    s1: { provider: 'laya-serve' },
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

test('the wiring record makes a demoted lane distinguishable from a cell with no lane, and carries the governance', () => {
  // Two defects, one artifact (`s1cap-audit-lane.md` F3 and F4).
  //
  // F3: a configuration conflict demotes the session to `provider: "none"` (`buildBackend`), so the wiring record
  // said `s1: "none"` - the same string a deliberate no-System-1 control writes. `cell-report.mjs` reads exactly
  // that string to decide a cell had no lane, so a C2 demoted by a conflict printed "undefined - no S1 lane" and
  // its zeroes read as by construction. The distinguishing fields (`configuredProvider`, the conflict text) existed
  // only on the live `/s1` route, and the run's log file carries zero `[s1cap]` lines, so the warning was durable
  // nowhere. This reads the tape the round keeps.
  //
  // F4: `admissionLimit`, the per-sweep pair budget and the breaker's thresholds appeared in no persisted record
  // at all, so "which knobs actually governed this run" was unanswerable from a later round's evidence. They are
  // asserted *resolved* here - the breaker's defaults included - because the question is what ran, not what was
  // configured.
  const h = harness();
  const tape = withEmptyHome(() => {
    apply(h.ctx, {
      enabled: true,
      observation: 'tape',
      s1: { provider: 'jev', apiKey: 'sk-live-SECRET-0123456789' },
      laya: layaIdle,
    });
    return readFileSync(join(process.env['DSH_HOME'] as string, '.s1cap', 'tape.jsonl'), 'utf8');
  });

  const records = tape.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as Record<string, unknown>);
  const wiring = records.find((r) => r['kind'] === 'wiring');
  assert.ok(wiring, `the tape must hold a wiring record; it held ${JSON.stringify(records.map((r) => r['kind']))}`);

  // F3: the two readings the report exists to keep apart.
  assert.equal(wiring['s1'], 'none', 'a conflict drops the resolved backend to none');
  assert.equal(wiring['configuredProvider'], 'jev', 'while the record still names what the recipe asked for');
  const conflicts = wiring['conflicts'] as string[];
  assert.equal(Array.isArray(conflicts) && conflicts.length, 1, 'and carries the reason, not just the fact');
  assert.match(conflicts[0] ?? '', /only one S1 backend/);

  // The deliberate no-lane control, for contrast: same `s1`, different `configuredProvider`, no conflict. A reader
  // that only compares `s1` cannot tell these two apart, which is the defect.
  const none = harness();
  const tapeNone = withEmptyHome(() => {
    apply(none.ctx, { enabled: true, observation: 'tape', s1: { provider: 'none' } });
    return readFileSync(join(process.env['DSH_HOME'] as string, '.s1cap', 'tape.jsonl'), 'utf8');
  });
  const wiringNone = tapeNone.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as Record<string, unknown>)
    .find((r) => r['kind'] === 'wiring') as Record<string, unknown>;
  assert.equal(wiringNone['s1'], 'none', 'the control arm also resolves to none');
  assert.equal(wiringNone['configuredProvider'], 'none', 'but it was configured that way');
  assert.deepEqual(wiringNone['conflicts'], [], 'and nothing was demoted');

  // F4: the governance block, resolved.
  const g = wiring['governance'] as Record<string, unknown>;
  assert.ok(g, 'the wiring record must state the governance that ran');
  assert.equal(g['admissionLimit'], 8, 'C2 policy default admission limit');
  assert.equal(g['maxPairsPerSweep'], 2048, 'the per-sweep pair budget, which was a literal in a call');
  assert.deepEqual(g['breaker'], { maxInFlight: 8, openAfterRefusals: 5, windowMs: 15_000, cooldownMs: 15_000 },
    'the breaker thresholds actually in force, defaults included');
  assert.equal(g['contextWindow'], 128_000);
  assert.equal(g['reserveOutputTokens'], 8_000);
  const recall = g['recall'] as Record<string, number>;
  assert.equal(recall['minRecalledShare'], 0, 'the fill floor the documents state is off by default');
  assert.equal(recall['minRecalledSegments'], 1, 'and the count floor is the guard that actually fires');

  // The record is the authority for the *wiring*, so it must not claim a component the policy does not have.
  assert.equal('planGate' in wiring, false, 'no wiring record may announce the removed plan gate');
  // And it must not carry key material: this file is kept with the round.
  assert.ok(!tape.includes('SECRET'), 'the wiring record never carries a credential');
});

test('the wiring record says which cells deliver, and which recall tier they resolved', () => {
  // Two fields, one reason: a round has to be able to prove its own arms from its own artifacts.
  //
  // `deliver` is the switch that decides whether the model ever sees an assembled layout, and it is the difference
  // between the ablation's arms: C0 leaves it off by choice (the baseline lets the harness manage history), C1
  // leaves it off because its channel is structurally empty (`recall.tier1: 'off'` selects nothing, so there is
  // nothing to insert), and C2 is the only delivering cell. `verify-wiring.mjs` asserted `tas.on`/`xFirst` and
  // stopped there, so nothing in a round's evidence stated which cells actually delivered.
  //
  // `tier1` is the knob that decides *how* candidates are generated, and it appeared in no persisted record at all:
  // the startup log line was the only place, and a later reader has the cell's recipe rather than the process. The
  // values are now a closed union (`off` | `s1`) with the unimplemented `embed` rejected in `config.ts`; recording
  // the resolved value is what lets a run state which of the two it ran.
  const record = (raw: Record<string, unknown>): Record<string, unknown> => {
    const h = harness();
    const tape = withEmptyHome(() => {
      apply(h.ctx, { enabled: true, observation: 'tape', ...raw });
      return readFileSync(join(process.env['DSH_HOME'] as string, '.s1cap', 'tape.jsonl'), 'utf8');
    });
    const found = tape
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((r) => r['kind'] === 'wiring');
    assert.ok(found, 'the tape must hold a wiring record');
    return found;
  };

  const c0 = record({ cell: 'C0', s1: { provider: 'none' }, laya: layaIdle });
  assert.equal(c0['deliver'], false, 'C0 is the baseline: the harness manages history');
  assert.equal((c0['recall'] as Record<string, unknown>)['tier1'], 'off', 'and it selects nothing');

  const c1 = record({ cell: 'C1', s1: { provider: 'none' }, laya: layaIdle });
  assert.equal(c1['deliver'], false, 'C1 does not deliver either: with tier1 off its block is always empty');
  assert.equal((c1['recall'] as Record<string, unknown>)['tier1'], 'off');

  const c2 = record({ cell: 'C2', s1: { provider: 'none' }, laya: layaIdle });
  assert.equal(c2['deliver'], true, 'C2 is the only delivering cell');
  assert.equal((c2['recall'] as Record<string, unknown>)['tier1'], 's1', 'and the tier it runs is the System-1 one');

  // The three readings together are what `verify-wiring.mjs` can now assert: `false, false, true`.
  assert.deepEqual(
    [c0['deliver'], c1['deliver'], c2['deliver']],
    [false, false, true],
    'the delivery arm of the ablation, stated by the run rather than by the recipe',
  );
  assert.ok(
    'deliver' in c2 && 'xFirst' in c2,
    'and it sits beside the layout field, so the two axes of the ablation are read from one place',
  );
});

test('apply() reports the resolved backend without leaking the key, and ping is honest', async () => {  const h = harness();
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
    cell: 'C9' as unknown as 'C2',
    termination: 'harness-owned' as unknown as 'model-owned',
    recall: { threshold: 3 } as never,
    laya: { enabled: true, autoStart: false, port: 99999 },
  });
  const warns = h.warns.join('\n');
  assert.match(warns, /cell: must be one of/);
  assert.match(warns, /termination: must be "model-owned"/);
  assert.match(warns, /recall\.threshold: must be within/);
  assert.match(warns, /laya\.port: must be within/);
  const status = commandPayload(h.commands.get('s1')?.({})) as { recall: { threshold: number }; cell: string };
  assert.equal(status.recall.threshold, 0.55, 'invalid value falls back to the default');
  assert.equal(status.cell, 'C2');
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
