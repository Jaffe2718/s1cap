import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_TELEMETRY, apply, readTuningFile, resolvePluginConfig } from '../src/index.ts';
import type { PluginContext } from '../src/index.ts';
import { parseTuning, parseTuningArgs } from '../src/credentials.ts';
import { commandPayload, commandKind, commandText } from './command-contract.ts';
// The cell policy is the authority for every governance number asserted below. Imported from source rather than
// restated, because this file used to assert `admissionLimit === 8` as a literal and silently became a test of a
// number the build no longer used when the policy moved to 2 on 2026-10-05.
import { cellPolicy } from '../../core/src/types.ts';

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
  // The gap this closes was invisible from the outside and identical in shape to the layout-key one: the panel wrote
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
        tracePlacement: 'trace-append',
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
  assert.equal(stored.tracePlacement, 'trace-append', 'a stored arm is a value, not an absence');
  assert.equal('questionPlacement' in stored, false, 'and the deleted question axis is not a field of the reader');
  assert.equal(stored.layaPythonPath, 'D:\\conda_store\\envs\\ml\\python.exe');
  assert.equal(stored.layaWeightsCacheDir, 'D:/hf-cache');
  assert.equal(stored.layaWeightsEnvVar, 'HF_HOME');
  // The backend the radio selected. Read through the same validator the command line uses, because the panel's
  // write half was already complete and a missing read half is invisible from the panel: the file holds the
  // choice, the radio shows it, and the next start comes up on the profile's provider instead.
  assert.equal(stored.provider, 'laya-serve');

  // **A file written before 2026-10-05 still carries the question's old slot, and the two values are treated
  // differently on purpose.** `xFirst: false` meant "the question last", which is now simply the only order this
  // build lays out: it is read, reported (`notes`) and otherwise ignored. `xFirst: true` meant the question *first*
  // — `[T, q, x]` — which no setting produces any more, so it is refused (`refused`, with the sentence that retired
  // it) and nothing is applied. Neither is silent, which is the property this block exists to pin: a stored layout
  // setting that resolves to nothing is this project's most-repeated failure.
  const legacy = withEmptyHome(() => {
    const dir = join(process.env['DSH_HOME'] as string, '.s1cap');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'tuning.json'), JSON.stringify({ depth: 3, xFirst: false }), 'utf8');
    return readTuningFile();
  });
  assert.equal(legacy.depth, 3, 'the knobs beside it still load');
  assert.equal(legacy.tracePlacement, undefined, 'and the arm was not stored, so the default stands');
  assert.equal(legacy.refused, undefined, 'the question-last spelling is not a refusal');
  assert.equal(legacy.notes?.length, 1, 'it is a retirement note');
  assert.match(legacy.notes?.[0] ?? '', /xFirst: false/, 'which names the spelling that was read');
  assert.match(legacy.notes?.[0] ?? '', /end of every input/, 'and the paper sentence behind the retirement');

  const refused = withEmptyHome(() => {
    const dir = join(process.env['DSH_HOME'] as string, '.s1cap');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'tuning.json'), JSON.stringify({ xFirst: true }), 'utf8');
    return readTuningFile();
  });
  assert.equal(refused.refused?.length, 1, 'the question-first spelling is refused');
  assert.equal(refused.notes, undefined, 'and is not also noted as harmless');
  assert.match(refused.refused?.[0]?.message ?? '', /xFirst: true/, 'the refusal names the key and the value');
  assert.match(refused.refused?.[0]?.message ?? '', /\[T, q, x\]/, 'and the layout it asked for');
  assert.match(refused.refused?.[0]?.message ?? '', /end of every input/, 'and the paper sentence');

  // The same two outcomes for the spelling the rename introduced, which lived for one day.
  const renamed = withEmptyHome(() => {
    const dir = join(process.env['DSH_HOME'] as string, '.s1cap');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'tuning.json'), JSON.stringify({ questionPlacement: 'first' }), 'utf8');
    return readTuningFile();
  });
  assert.match(renamed.refused?.[0]?.message ?? '', /questionPlacement: "first"/, 'named as it was stored');

  // The same validators the command line uses, so a hand-edited file cannot smuggle in a value the Save button
  // would have refused: an unusable entry is dropped and the default stands.
  const partial = withEmptyHome(() => {
    const dir = join(process.env['DSH_HOME'] as string, '.s1cap');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'tuning.json'),
      JSON.stringify({ layaPythonPath: 'python', layaWeightsEnvVar: 42, depth: 0, provider: 'openai', tracePlacement: 'append' }),
      'utf8',
    );
    return readTuningFile();
  });
  assert.equal(partial.layaPythonPath, undefined, 'a bare token is not a path');
  assert.equal(partial.layaWeightsEnvVar, undefined, 'a number is not a variable name');
  assert.equal(partial.depth, undefined, 'and the numeric rules still hold');
  assert.equal(partial.provider, undefined, 'and a provider no policy allows is dropped rather than guessed at');
  assert.equal(partial.tracePlacement, undefined, 'and an arm outside the paper\'s two is dropped, not clamped');
});

test('the arm survives both wire formats, and the retired question spellings are refused or noted', () => {
  // The credential string is the four-field form the host writes (`d r w <question>`); the command line is what a
  // human types. The paper's arm is keyed (`trace=`), because it has no legacy positional slot: it did not exist
  // when the four-token form was defined.
  //
  // **The question's own token is no longer a setting either way.** It is read so that an older saved command line
  // is never silently reinterpreted, and what it asks for decides the outcome: `last`/`off` asks for what every
  // layout does (`notes`), `first`/`on` asks for `[T, q, x]`, which no setting produces (`refused`, with the paper
  // sentence). The parser no longer returns a question value at all, because there is no field to return it for.
  assert.equal('questionPlacement' in parseTuning('2 0.55 1024 last'), false);
  assert.equal(parseTuning('2 0.55 1024 last').notes?.length, 1, 'the question-last spelling is noted');
  assert.equal(parseTuning('2 0.55 1024').notes, undefined, 'absent means: nothing was written and nothing to say');
  assert.equal(parseTuning('2 0.55 1024 first').refused?.length, 1, 'and the question-first spelling is refused');
  assert.match(parseTuning('2 0.55 1024 first').refused?.[0]?.message ?? '', /end of every input/);
  // The old boolean spellings are read through core's own table for *which* of the two they mean, so an older write
  // keeps its meaning: `on` was "question first" (now unproducible) and `off` was "question last" (now the only
  // layout). A misspelling is dropped: `first` and `frist` are one transposition apart, and guessing here would
  // refuse a save nobody asked to refuse.
  assert.equal(parseTuning('2 0.55 1024 on').refused?.length, 1, 'the legacy question-first spelling is refused');
  assert.equal(parseTuning('2 0.55 1024 off').notes?.length, 1, 'the legacy question-last spelling is noted');
  assert.equal(parseTuning('2 0.55 1024 1').refused?.length, 1);
  assert.equal(parseTuning('2 0.55 1024 0').notes?.length, 1);
  assert.equal(parseTuning('2 0.55 1024 frist').refused, undefined, 'a typo is dropped, not refused');
  assert.equal(parseTuning('2 0.55 1024 frist').notes, undefined);

  assert.equal(parseTuningArgs('q=first').refused?.length, 1);
  assert.equal(parseTuningArgs('q=first').refused?.[0]?.key, 'q=first', 'the refusal names the spelling');
  assert.equal(parseTuningArgs('q=last').notes?.length, 1);
  assert.equal(parseTuningArgs('questionPlacement=first').refused?.length, 1, 'the newer name is the same request');
  assert.equal(parseTuningArgs('3 0.7 512 last').notes?.length, 1, 'fourth positional is the question slot');
  assert.equal(parseTuningArgs('xFirst=on').refused?.length, 1, 'the old key is read, and refused for its meaning');
  assert.equal(parseTuningArgs('xf=off').notes?.length, 1);
  assert.equal(parseTuningArgs('q=perhaps').refused, undefined, 'and a value the slot never had is still dropped');
  // The arm, under the paper's names and only those: `state`/`append` are not values of `TracePlacement`, and a
  // parser that accepted them would let a round record an arm the policy validator would reject.
  assert.equal(parseTuningArgs('trace=trace-append').tracePlacement, 'trace-append');
  assert.equal(parseTuningArgs('tracePlacement=trace-as-state').tracePlacement, 'trace-as-state');
  assert.equal(parseTuningArgs('trace=append').tracePlacement, undefined, 'the mechanism word is not an arm name');
  assert.equal(parseTuningArgs('trace=after-context').tracePlacement, undefined, 'nor is the retired value');
  // A dropped token must not take the other three fields down with it - and a *refused* one travels beside them
  // rather than replacing them, so the host can name the other fields it would have applied.
  assert.deepEqual(parseTuningArgs('3 0.7 512 frist'), { depth: 3, relevanceThreshold: 0.7, window: 512 });
  const withRefusal = parseTuningArgs('d=3 xFirst=on');
  assert.equal(withRefusal.depth, 3, 'the knobs are still parsed');
  assert.equal(withRefusal.refused?.length, 1, 'and the refusal rides with them');
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
  assert.equal(g['admissionLimit'], cellPolicy('C2').s1.admissionLimit,
    'the limit the C2 policy resolves to, read from the policy rather than restated, so a policy change cannot leave '
      + 'this test asserting a number the build no longer uses');
  assert.equal(g['scoring'], 'on-demand',
    'how the association lane was driven: the per-sweep pair budget that used to sit here bounded a burst the '
      + 'eager sweep could produce, and on-demand scoring cannot');
  assert.equal('maxPairsPerSweep' in g, false,
    'the removed knob is not recorded as if it governed this run');
  assert.deepEqual(g['breaker'], {
    // Wired straight from the admission limit (`packages/dsh-plugin/src/index.ts`, `maxInFlight:
    // config.s1.admissionLimit`), which is why this is read from the policy: before 2026-10-05 the literal `8` here
    // and the literal `8` above were the same number asserted twice, so moving the limit left this test passing
    // against a breaker the build no longer built.
    maxInFlight: cellPolicy('C2').s1.admissionLimit,
    openAfterRefusals: 5,
    windowMs: 15_000,
    cooldownMs: 15_000,
  }, 'the breaker thresholds actually in force, defaults included');
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
      // Stage the cell preset the way a round does: `setup.mjs` copies `bench/cells/<cell>.json` to
      // `<DSH_HOME>/.s1cap/cell-preset.json`, and `readCellPresetFile()` reads it there.
      //
      // **Without this the assertions below would be about the defaults, not about the cells.** `deliver` moved out
      // of `cellPolicy()` and into the preset on 2026-10-05 (see `packages/core/src/types.ts`), so a home with no
      // preset is a cell with no configuration — and C1/C2 would read `deliver: false`, which is what this test
      // caught when the move landed. The preset is part of what a cell *is* now, so a test about the wiring record
      // has to stage it.
      const cell = String(raw['cell'] ?? 'C2');
      const home = process.env['DSH_HOME'] as string;
      mkdirSync(join(home, '.s1cap'), { recursive: true });
      writeFileSync(
        join(home, '.s1cap', 'cell-preset.json'),
        readFileSync(new URL(`../../../bench/cells/${cell}.json`, import.meta.url), 'utf8'),
        'utf8',
      );
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
  // C1 delivers now: with `tier1: off` its recall selects nothing, but `tas.on: true` means the state proxy
  // alone is a complete delivery, so the channel carries the paper's trace and nothing else.
  assert.equal(c1['deliver'], true, 'C1 delivers the state proxy alone: with tier1 off the recalled block is empty by construction, but T is not');
  assert.equal((c1['recall'] as Record<string, unknown>)['tier1'], 'off', 'and it selects no turns');

  const c2 = record({ cell: 'C2', s1: { provider: 'none' }, laya: layaIdle });
  assert.equal(c2['deliver'], true, 'C2 delivers: the state proxy ahead of the turns S1 selected');
  assert.equal((c2['recall'] as Record<string, unknown>)['tier1'], 's1', 'and the tier it runs is the System-1 one');

  // The three readings together are what `verify-wiring.mjs` can now assert: `false, true, true`.
  assert.deepEqual(
    [c0['deliver'], c1['deliver'], c2['deliver']],
    [false, true, true],
    'the delivery arm of the ablation: C0 nothing, C1 the trace alone, C2 the trace plus the recall',
  );
  assert.ok(
    'deliver' in c2 && 'tracePlacement' in c2,
    'and it sits beside the layout field, so the delivery arm and the layout arm are read from one place',
  );
  // **The tape's layout keys changed on 2026-10-05, twice.** The key was `xFirst: boolean`, which moved the question
  // while reading like the paper's variable; it was renamed to `questionPlacement`, and then deleted, because the
  // paper fixes the question last in every condition and a field that can only ever say `'last'` is not a setting.
  // `tracePlacement` now names which of the paper's two conditions the cell lays out, and `layoutOrder` on every
  // assembly says where the question is — last — in the layout's own words. A round compared against one recorded
  // before this date has to compare the new key *and* read the order, because the old key is gone from both sides.
  for (const [name, cellRecord] of [['C0', c0], ['C1', c1], ['C2', c2]] as const) {
    assert.equal(cellRecord['tracePlacement'], 'trace-as-state', `${name}: the record names the arm, not a mechanism`);
    assert.equal('questionPlacement' in cellRecord, false, `${name}: no record states a question position`);
    assert.equal('xFirst' in cellRecord, false, `${name}: and the imprecise key is long gone`);
  }
  // A layout the profile overrides is recorded as what ran, so the round can be read back without its profile.
  const overridden = record({ cell: 'C2', s1: { provider: 'none' }, laya: layaIdle, tracePlacement: 'trace-append' });
  assert.equal(overridden['tracePlacement'], 'trace-append', 'the control arm is recordable too');
  assert.equal('questionPlacement' in overridden, false, 'and moving the trace does not state a question position');

  // `assemblyTrigger` is on the same record for the same reason, and it is a *different* question from `deliver`:
  // `deliver` says whose assembled view reaches the model, this says which steps were assembled at all. Round
  // `20261003-2104` is why the second question needed an answer in the artifacts - 33 model calls, 2 assemblies,
  // and nothing in the record said the lane had skipped 31 steps by design. Every cell must state the value it
  // ran: a round that flips this switch moves one variable, so a profile or preset that moved it silently would
  // confound that round, and this assertion is where the flip would show up first in the suite.
  //
  // The value is `every-step` since 2026-10-04. `'claimed-only'` assembled on 2 of C2's 53 steps in round
  // `20261004-0205`, leaving the model's own self-directed input without recall - see `defaultPolicy`.
  assert.deepEqual(
    [c0['assemblyTrigger'], c1['assemblyTrigger'], c2['assemblyTrigger']],
    ['every-step', 'every-step', 'every-step'],
    'all three cells assemble on every model-requesting step: the narrow value is a per-round switch, not a preset',
  );
  assert.equal(
    record({ cell: 'C2', s1: { provider: 'none' }, laya: layaIdle, assemblyTrigger: 'every-step' })['assemblyTrigger'],
    'every-step',
    'and the record carries whatever the profile resolved, so the round that flips it can be read back',
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

test('a stored layout setting reaches the config: the write, the read and the apply agree', () => {
  // This is the test whose absence cost a live debugging round. The parser handling the value was verified, the
  // route echoed it back, the file on disk held it - and the layout still ran on its default, because the reader
  // between the file and the config never looked at the field at all. Asserting the parser alone could not see
  // that, so this drives the real path: write the file, activate, read the config.
  //
  // **The subject is the arm only since 2026-10-05.** It used to drive `questionPlacement: 'first'` as well, and a
  // rename that stops reading a stored setting is the defect this test was written for one rename later — but the
  // field behind the question is *deleted* rather than renamed, so what the reader owes a file that still carries it
  // is the refusal the test below pins, not an application.
  withEmptyHome(() => {
    const home = process.env['DSH_HOME'];
    assert.ok(home !== undefined);
    const file = join(home, '.s1cap', 'tuning.json');
    mkdirSync(join(home, '.s1cap'), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({ depth: 5, relevanceThreshold: 0.7, window: 1600, tracePlacement: 'trace-append' }),
      'utf8',
    );

    const h = harness();
    apply(h.ctx, { enabled: true, s1: { provider: 'none' } });

    const status = JSON.parse(JSON.stringify(commandPayload(h.commands.get('s1')?.({})) ?? {})) as {
      tracePlacement?: string;
      questionPlacement?: string;
      recall?: { depth?: number; window?: number };
      tuning?: { effective?: { tracePlacement?: string; questionPlacement?: string } };
    };
    // The status command reports the live config object the observer holds, so this is the value assembly sees.
    assert.equal(status.tracePlacement, 'trace-append', 'a stored arm must override the default');
    assert.equal('questionPlacement' in status, false, 'and no stored question position is reported, because none exists');
    assert.equal(status.recall?.depth, 5, 'and the numeric knobs still arrive alongside it');
    assert.equal(status.recall?.window, 1600);
    assert.equal(status.tuning?.effective?.tracePlacement, 'trace-append', 'and the route reports the same value it applied');
    assert.equal('questionPlacement' in (status.tuning?.effective ?? {}), false);
  });
});

test('a stored layout is reported by /s1, so a round can read back the arm it actually ran', () => {
  // The read-back half of the test above. `/s1` is the surface a reader asks "which of the paper's two conditions
  // is this session running", and the field has to be there *and* agree with what was applied: a status route
  // that reported the default while the assembler laid out the override would be the same defect as a stored key
  // nobody reads, one layer further out. The question's position is not reported because it is not a setting: every
  // assembly's `layoutOrder` ends in `anchor`, and that is where the fact lives.
  //
  // **What this test does not assert, and why.** No deviation line is logged for this field when the tuning file is
  // read at activation: `primeOnce` compares the live config against a `cellBefore` snapshot taken *after* the
  // activation-time read has already applied the file, so the two agree and the comparison is silent. That is
  // pre-existing behaviour on this path — the provider deviation is logged from a different block, and the panel
  // route's `applyTuning` does warn — it is not something this change introduced, and it is reported rather than
  // fixed here because "which values reached the config" is what this test is for and changing when the warning
  // fires would change what a round's log says.
  const payload = withEmptyHome(() => {
    const home = process.env['DSH_HOME'];
    assert.ok(home !== undefined);
    mkdirSync(join(home, '.s1cap'), { recursive: true });
    writeFileSync(join(home, '.s1cap', 'tuning.json'), JSON.stringify({ tracePlacement: 'trace-append' }), 'utf8');
    const h = harness();
    // `laya.enabled: false`: the subject is the layout read-back, and a Laya block that tried to spawn would make
    // this test depend on a python interpreter being present on the machine running the suite.
    apply(h.ctx, { enabled: true, s1: { provider: 'none' }, laya: { enabled: false } });
    return JSON.parse(JSON.stringify(commandPayload(h.commands.get('s1')?.({})) ?? {})) as {
      tracePlacement?: string;
      questionPlacement?: string;
      tuning?: { effective?: { tracePlacement?: string; questionPlacement?: string } };
    };
  });
  assert.equal(payload.tracePlacement, 'trace-append', '/s1 names the arm the session is running');
  assert.equal('questionPlacement' in payload, false, 'and does not report a question position');
  assert.equal(payload.tuning?.effective?.tracePlacement, 'trace-append', 'the panel route agrees with it');
  assert.equal('questionPlacement' in (payload.tuning?.effective ?? {}), false);
});

test('a stored question-first setting is refused loudly and never applied; the question-last one is noted', () => {
  // The legacy key, through the same full path: stored by an older panel, read by this build, and **refused**.
  // `xFirst: true` (and `questionPlacement: 'first'`) asked for `[T, q, x]` — the question in front of the long
  // context — which no setting produces any more, so applying the rest of the file while saying nothing would leave
  // a researcher with a stored layout the build does not have and a session quietly running another one. The
  // refusal is an `error` line naming the key, the value and the paper sentence, and the status payload carries it
  // as well, so a reader of `/s1` sees what the file asked for.
  withEmptyHome(() => {
    const home = process.env['DSH_HOME'];
    assert.ok(home !== undefined);
    mkdirSync(join(home, '.s1cap'), { recursive: true });
    writeFileSync(join(home, '.s1cap', 'tuning.json'), JSON.stringify({ xFirst: true }), 'utf8');

    const h = harness();
    apply(h.ctx, { enabled: true, s1: { provider: 'none' }, laya: { enabled: false } });
    const status = JSON.parse(JSON.stringify(commandPayload(h.commands.get('s1')?.({})) ?? {})) as {
      questionPlacement?: string;
      tuning?: { stored?: { refused?: { key?: string; message?: string }[]; notes?: string[] } };
    };
    assert.equal('questionPlacement' in status, false, 'the old key does not set a field, because there is none');
    assert.equal(status.tuning?.stored?.refused?.length, 1, 'and the file is reported as refused rather than applied');
    assert.match(status.tuning?.stored?.refused?.[0]?.message ?? '', /xFirst: true/, 'the refusal names the spelling');
    assert.match(status.tuning?.stored?.refused?.[0]?.message ?? '', /end of every input/, 'and the paper sentence');
  });

  // The harness's logger in this suite has `info` and `warn` only, so the loud channel is asserted through the
  // status payload above; this half pins the *harmless* value end to end: `xFirst: false` is read, noted, and the
  // session runs.
  withEmptyHome(() => {
    const home = process.env['DSH_HOME'];
    assert.ok(home !== undefined);
    mkdirSync(join(home, '.s1cap'), { recursive: true });
    writeFileSync(join(home, '.s1cap', 'tuning.json'), JSON.stringify({ depth: 6, xFirst: false }), 'utf8');

    const h = harness();
    apply(h.ctx, { enabled: true, s1: { provider: 'none' }, laya: { enabled: false } });
    const status = JSON.parse(JSON.stringify(commandPayload(h.commands.get('s1')?.({})) ?? {})) as {
      recall?: { depth?: number };
      tuning?: { stored?: { refused?: unknown[]; notes?: string[] } };
    };
    assert.equal(status.recall?.depth, 6, 'the rest of the file still applies');
    assert.equal(status.tuning?.stored?.refused, undefined, 'a question-last spelling is not a refusal');
    assert.equal(status.tuning?.stored?.notes?.length, 1, 'it is a note, so the file is not read in silence');
  });
});

test('a legacy question spelling on the command line is refused or noted, and a refused save writes nothing', () => {
  // The wire half of the deletion, driven through the surface a researcher actually uses: `/s1-tune`, whose handler
  // calls the same `applyTuning` the panel's PUT route does. `xFirst=on` and its spellings asked for the question in
  // front of the long context — `[T, q, x]` — and the field behind them is deleted, so the save is **refused**, with
  // the sentence that retired it, rather than coerced into a layout nobody asked for. `xFirst=off` and its spellings
  // asked for the question last, which is every condition of the paper: accepted, noted, and changing nothing.
  const h = harness();
  withEmptyHome(() => {
    const home = process.env['DSH_HOME'] as string;
    apply(h.ctx, { enabled: true, s1: { provider: 'none' }, laya: { enabled: false } });

    for (const raw of ['xFirst=on', 'xf=on', 'q=first', 'questionPlacement=first', '3 0.7 512 on']) {
      const refused = h.commands.get('s1-tune')?.({ rawInput: raw });
      assert.equal(commandKind(refused), 'error', `${raw} must be refused, got ${commandText(refused)}`);
      const text = commandText(refused);
      assert.match(text, /no setting here produces it/, `${raw}: the message says the layout is not producible`);
      assert.match(text, /\[T, q, x\]/, `${raw}: and names the order it asked for`);
      assert.match(text, /end of every input/, `${raw}: and quotes the paper sentence that retired it`);
      assert.match(text, /trace/, `${raw}: and names the axis that exists instead`);
    }
    // Nothing was persisted for any of them: a refusal that still wrote a file would leave the next start reading a
    // layout the save said it would not apply.
    assert.equal(existsSync(join(home, '.s1cap', 'tuning.json')), false, 'a refused save writes no file');

    for (const raw of ['xFirst=off', 'xf=off', 'q=last']) {
      const accepted = h.commands.get('s1-tune')?.({ rawInput: `${raw} d=3` });
      assert.equal(commandKind(accepted), 'success', `${raw} asks for what every layout does: ${commandText(accepted)}`);
      assert.match(commandText(accepted), /retired/, `${raw}: the answer says the setting is retired`);
      assert.match(commandText(accepted), /end of every input/, `${raw}: and quotes the paper sentence`);
      assert.match(commandText(accepted), /d=3|depth=3/, `${raw}: while the knobs beside it were applied`);
    }
    // And what was written is settings only: the readings never reach the file the next launch parses.
    const stored = JSON.parse(readFileSync(join(home, '.s1cap', 'tuning.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(stored['depth'], 3);
    assert.equal('notes' in stored, false, 'the retirement note is a reading, not a setting');
    assert.equal('refused' in stored, false);
    assert.equal('questionPlacement' in stored, false, 'and the deleted axis is not in the file at all');
  });
});

test('a cell named with no preset beside it is reported, because the defaults are not that arm', () => {
  // `cellPolicy()` stopped setting a cell's switches on 2026-10-05, so a profile naming `cell: C0` with no preset
  // resolves to `defaultPolicy()` — trace on, recall selection on, delivery on, which is **C2's shape labelled C0**.
  // Every value is legal and nothing refuses, so the only thing that can catch it is a sentence, and `setup.mjs` is
  // the only thing that puts the file there.
  const c0 = JSON.parse(readFileSync(new URL('../../../bench/cells/C0.json', import.meta.url), 'utf8')) as unknown;
  const staged = resolvePluginConfig({ cell: 'C0' } as never, { file: '/tmp/cell-preset.json', value: c0 });
  assert.equal(
    staged.policy.warnings.filter((i) => i.path === 'cell').length,
    0,
    'a cell whose preset was read says nothing: this is the ordinary path',
  );
  assert.equal(staged.policy.policy.tas.on, false, 'and it runs the baseline, because the file said so');

  const bare = resolvePluginConfig({ cell: 'C0' } as never, { file: null, value: undefined });
  const warning = bare.policy.warnings.find((i) => i.path === 'cell');
  assert.notEqual(warning, undefined, `the missing preset must be reported: ${JSON.stringify(bare.policy.issues)}`);
  assert.match(warning?.message ?? '', /no cell preset was read/, 'it names what is missing');
  assert.match(warning?.message ?? '', /not the settings C0 is defined by/, 'and what the run therefore is not');
  assert.equal(bare.policy.ok, true, 'and it stays a warning: a session that means the defaults is legitimate');
  // The claim the warning makes is a measured one, so the test measures it: the defaults are not C0. This is the
  // difference `setup.mjs` exists to prevent, and it is one field deep — which is exactly why nothing would notice.
  assert.equal(bare.policy.policy.recall.tier1, 's1', 'the default selects with s1');
  assert.equal(staged.policy.policy.recall.tier1, 'off', 'while C0 — as its file defines it — selects nothing');
});

test('every path a cell preset writes has a field on the wiring record', () => {
  // The record is the authority for "what did this cell run", and a preset path with no field here is a value that
  // reaches the session and no artifact: `bench/cells/C2.json` carried `recall.threshold: 0.6` through a round that
  // ran 0.55 precisely because the file and the record were not joined up. `cellPreset.fromPreset` names the paths,
  // which is what let the gap be found; this asserts the values, and it is written as a walk over the files so a path
  // added to a preset later fails here instead of vanishing from the record.
  const record = (cell: string): Record<string, unknown> => {
    const h = harness();
    return withEmptyHome(() => {
      const home = process.env['DSH_HOME'] as string;
      mkdirSync(join(home, '.s1cap'), { recursive: true });
      writeFileSync(
        join(home, '.s1cap', 'cell-preset.json'),
        readFileSync(new URL(`../../../bench/cells/${cell}.json`, import.meta.url), 'utf8'),
        'utf8',
      );
      // No `s1` override: the point is to read back what the *preset* supplied, so the patch must not replace it.
      apply(h.ctx, { enabled: true, observation: 'tape', laya: layaIdle });
      const tape = readFileSync(join(process.env['DSH_HOME'] as string, '.s1cap', 'tape.jsonl'), 'utf8');
      const found = tape
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .find((r) => r['kind'] === 'wiring');
      assert.ok(found, 'the tape must hold a wiring record');
      return found;
    });
  };

  /** Preset path → where its value has to appear on the wiring record. A path with no entry fails the test below. */
  const FIELD: Record<string, (r: Record<string, unknown>) => unknown> = {
    tas: (r) => (r['tas'] as Record<string, unknown>)['on'],
    'tas.on': (r) => (r['tas'] as Record<string, unknown>)['on'],
    'tas.tMaxChars': (r) => (r['tas'] as Record<string, unknown>)['tMaxChars'],
    'tas.updatePolicy': (r) => (r['tas'] as Record<string, unknown>)['updatePolicy'],
    'recall.threshold': (r) => (r['recall'] as Record<string, unknown>)['r'],
    'recall.depth': (r) => (r['recall'] as Record<string, unknown>)['d'],
    'recall.tier1': (r) => (r['recall'] as Record<string, unknown>)['tier1'],
    deliver: (r) => r['deliver'],
    'tail.k': (r) => (r['tail'] as Record<string, unknown>)['k'],
    's1.provider': (r) => r['configuredProvider'],
    's1.questionsPerCall': (r) => (r['s1Knobs'] as Record<string, unknown>)['questionsPerCall'],
    's1.retryAttempts': (r) => (r['s1Knobs'] as Record<string, unknown>)['retryAttempts'],
    's1.admissionLimit': (r) => (r['governance'] as Record<string, unknown>)['admissionLimit'],
    // `cell` is provenance rather than a policy value: it decides which file is read, and the record states the file.
    cell: (r) => (r['cellPreset'] as Record<string, unknown>)['file'] !== null,
  };

  for (const cell of ['C0', 'C1', 'C2']) {
    const preset = JSON.parse(readFileSync(new URL(`../../../bench/cells/${cell}.json`, import.meta.url), 'utf8')) as Record<
      string,
      unknown
    >;
    const record_ = record(cell);
    const leaves: string[] = [];
    const walk = (obj: Record<string, unknown>, prefix: string): void => {
      for (const [key, value] of Object.entries(obj)) {
        if (key === '_meta') continue;
        const path = prefix === '' ? key : `${prefix}.${key}`;
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) walk(value as Record<string, unknown>, path);
        else leaves.push(path);
      }
    };
    walk(preset, '');
    for (const path of leaves) {
      const read = FIELD[path];
      assert.notEqual(
        read,
        undefined,
        `${cell}: the preset writes \`${path}\`, which the wiring record has no field for — a value that reaches the ` +
          'session and no artifact',
      );
      if (path === 'cell') continue; // provenance: what is asserted is that the record names a file at all
      const plain = (o: Record<string, unknown>, p: string): unknown =>
        p.split('.').reduce<unknown>((acc, k) => (acc as Record<string, unknown>)?.[k], o);
      assert.deepEqual(
        read(record_),
        plain(preset, path),
        `${cell}: the wiring record's value for \`${path}\` must be the one its file wrote`,
      );
    }
  }
});
