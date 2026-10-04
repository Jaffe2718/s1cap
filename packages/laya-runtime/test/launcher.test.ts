import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultLayaConfig } from '../src/types.ts';
import {
  DEFAULT_WEIGHTS_CACHE_DIR,
  DEFAULT_WEIGHTS_ENV_VAR,
  LayaServer,
  buildLaunchPlan,
  consoleScriptPath,
  weightsCacheDir,
  weightsEnvVar,
} from '../src/launcher.ts';
import type { LaunchDeps, SpawnedProcess, StartResult } from '../src/launcher.ts';

const PY = 'D:\\conda_store\\envs\\ml\\python.exe';

/**
 * `LAYA_POLL_TIMEOUT_MS`, written out rather than imported, and asserted against the export at the end of the test
 * that uses it.
 *
 * The reason is the *before* run: against a launcher that has no bound at all, a static named import of a constant
 * that does not exist yet is a module *link* error, so the whole file would fail to load and none of these tests
 * would get to demonstrate the hang they were written for. A local band plus one dynamic cross-check keeps the
 * before-run honest and the after-run unable to drift.
 */
const PER_POLL_BOUND_MS = 5_000;

interface FakeChild {
  child: SpawnedProcess;
  emit(event: 'exit' | 'error', arg?: unknown): void;
  killed: boolean;
}

function makeChild(): FakeChild {
  const handlers: Record<string, ((arg?: unknown) => void)[]> = {};
  const state = { killed: false };
  const child: SpawnedProcess = {
    pid: 4242,
    on(event, cb) {
      (handlers[event] ??= []).push(cb);
    },
    kill() {
      state.killed = true;
      return true;
    },
    stdout: { on() {} },
    stderr: { on() {} },
  };
  return {
    child,
    emit(event, arg) {
      for (const h of handlers[event] ?? []) h(arg);
    },
    get killed() {
      return state.killed;
    },
  };
}

interface Harness {
  deps: LaunchDeps;
  plan: { command?: string; args?: string[]; env?: Record<string, string> };
  fake: FakeChild;
  fetched: string[];
  /** `init` is handed to the mock as well, so a mock can watch whatever the launcher passes alongside the URL. */
  setFetch(fn: (url: string, init?: RequestInit) => Promise<Response>): void;
}

function harness(opts: { hasConsoleScript?: boolean; platform?: string } = {}): Harness {
  const fake = makeChild();
  const plan: Harness['plan'] = {};
  const fetched: string[] = [];
  let t = 0;
  let impl = async (_url: string, _init?: RequestInit): Promise<Response> => new Response('{}', { status: 200 });
  const deps: LaunchDeps = {
    platform: opts.platform ?? 'win32',
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    fileExists: async () => opts.hasConsoleScript ?? false,
    spawn: (command, args, options) => {
      plan.command = command;
      plan.args = args;
      plan.env = options.env;
      return fake.child;
    },
    fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      fetched.push(url);
      return impl(url, init);
    }) as typeof fetch,
  };
  return {
    deps,
    plan,
    fake,
    fetched,
    setFetch(fn) {
      impl = fn;
    },
  };
}

/**
 * A backend socket that **accepts the connection and never answers** — the one shape every other mock in this file
 * cannot produce.
 *
 * A refusal fails in microseconds, so the readiness loop always got back to its own `while (now < deadline)` and
 * `startupTimeoutMs` looked like it worked. A socket that is accepted and then goes silent is what parks that loop
 * on an `await` that never returns, so the counter here is what tells the two cases apart: `armed` counts the polls
 * that arrived with an `AbortSignal` (a poll without one is a socket nothing can interrupt), `aborted` counts the
 * ones whose bound actually expired while the socket stayed silent.
 */
interface BlackHole {
  fetch(url: string, init?: RequestInit): Promise<Response>;
  calls: number;
  armed: number;
  aborted: number;
}

function makeBlackHole(): BlackHole {
  const hole: BlackHole = {
    calls: 0,
    armed: 0,
    aborted: 0,
    fetch(_url: string, init?: RequestInit): Promise<Response> {
      hole.calls += 1;
      const signal = init?.signal;
      // No signal: nothing can cut this off, which is exactly the unfixed call. It never settles, and neither did
      // the launcher that made it.
      if (!signal) return new Promise<Response>(() => {});
      hole.armed += 1;
      return new Promise<Response>((_resolve, reject) => {
        const onAbort = (): void => {
          hole.aborted += 1;
          reject(new DOMException('This operation was aborted', 'AbortError'));
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      });
    },
  };
  return hole;
}

/** Let every microtask behind an abort settle, without advancing a mocked clock. */
function drain(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test('consoleScriptPath targets the environment layout of each platform', () => {
  assert.equal(consoleScriptPath(PY, 'win32'), 'D:\\conda_store\\envs\\ml\\Scripts\\laya-serve.exe');
  assert.equal(consoleScriptPath('/opt/conda/envs/ml/bin/python', 'linux'), '/opt/conda/envs/ml/bin/laya-serve');
});

test('buildLaunchPlan configures Laya through the environment, not CLI flags', () => {
  const cfg = { ...defaultLayaConfig(), port: 9001, serveArgs: ['--extra'] };

  const viaScript = buildLaunchPlan(cfg, PY, 'win32', true);
  assert.equal(viaScript.command, 'D:\\conda_store\\envs\\ml\\Scripts\\laya-serve.exe');
  assert.deepEqual(viaScript.args, ['--extra'], 'laya-serve 0.3.21 takes no host/port flags');
  assert.equal(viaScript.env.LAYA_HOST, '127.0.0.1');
  assert.equal(viaScript.env.LAYA_PORT, '9001');

  const viaModule = buildLaunchPlan(cfg, PY, 'win32', false);
  assert.equal(viaModule.command, PY);
  assert.deepEqual(viaModule.args, ['-m', 'laya', 'serve', '--extra']);

  const viaCommand = buildLaunchPlan({ ...cfg, serveCommand: 'C:\\wrap\\laya.cmd' }, PY, 'win32', true);
  assert.equal(viaCommand.command, 'C:\\wrap\\laya.cmd');

  const env = buildLaunchPlan(
    { ...cfg, env: { LAYA_THREADS: '8', LAYA_MODELS: 'typed-decisions', HF_ENDPOINT: 'https://hf-mirror.com' } },
    PY,
    'win32',
    false,
  ).env;
  assert.equal(env.LAYA_THREADS, '8');
  assert.equal(env.LAYA_MODELS, 'typed-decisions');
  assert.equal(env.HF_ENDPOINT, 'https://hf-mirror.com');
  assert.equal(env.LAYA_PORT, '9001');
});

test('checkpoints go to a cache S1CAP owns, and the user is not asked to place them', () => {
  // The convenience requirement: a user who has a working Python environment should not also have to download or
  // place a checkpoint. The environment fetches on first start, so the only thing S1CAP has to get right is
  // where the download lands — and a default under S1CAP's own data directory is a location the user never has
  // to think about and never has to clean up by hand.
  const cfg = defaultLayaConfig();
  const env = buildLaunchPlan(cfg, PY, 'win32', false).env;
  assert.equal(env[weightsEnvVar(cfg)], DEFAULT_WEIGHTS_CACHE_DIR);
  assert.equal(env[DEFAULT_WEIGHTS_ENV_VAR], DEFAULT_WEIGHTS_CACHE_DIR, 'HF_HOME is the conventional name, by default');
  assert.equal(weightsCacheDir(cfg), DEFAULT_WEIGHTS_CACHE_DIR);
  assert.equal(weightsEnvVar(cfg), DEFAULT_WEIGHTS_ENV_VAR);
});

test('a weights variable the user named is honoured, and an explicit value is never overwritten', () => {
  // Two separate overrides, and both have to win: the variable *name* (their Laya may not read HF_HOME) and the
  // value (their machine may keep models elsewhere). A default that overwrites an explicit value is the kind of
  // quiet override that makes a run impossible to explain afterwards.
  const renamed = defaultLayaConfig();
  renamed.weightsEnvVar = 'LAYA_CACHE_DIR';
  assert.equal(buildLaunchPlan(renamed, PY, 'win32', false).env.LAYA_CACHE_DIR, DEFAULT_WEIGHTS_CACHE_DIR);
  assert.equal(
    buildLaunchPlan(renamed, PY, 'win32', false).env[DEFAULT_WEIGHTS_ENV_VAR],
    undefined,
    'and the conventional name is not also set, so the two cannot disagree',
  );

  const elsewhere = defaultLayaConfig();
  elsewhere.weightsCacheDir = 'E:/models/laya';
  assert.equal(weightsCacheDir(elsewhere), 'E:/models/laya');
  assert.equal(buildLaunchPlan(elsewhere, PY, 'win32', false).env[DEFAULT_WEIGHTS_ENV_VAR], 'E:/models/laya');

  const explicit = defaultLayaConfig();
  explicit.env = { [DEFAULT_WEIGHTS_ENV_VAR]: 'D:/already/configured' };
  assert.equal(
    buildLaunchPlan(explicit, PY, 'win32', false).env[DEFAULT_WEIGHTS_ENV_VAR],
    'D:/already/configured',
    'a value the user set under the same name stays theirs',
  );

  // An empty string is treated as unset rather than as a path of "", which would be a directory named nothing.
  const blank = defaultLayaConfig();
  blank.weightsCacheDir = '';
  blank.weightsEnvVar = '';
  assert.equal(weightsCacheDir(blank), DEFAULT_WEIGHTS_CACHE_DIR);
  assert.equal(weightsEnvVar(blank), DEFAULT_WEIGHTS_ENV_VAR);
});

test('LayaServer.start spawns, polls GET /health and reaches ready', async () => {
  const h = harness();
  let healthCalls = 0;
  h.setFetch(async (url) => {
    if (url.endsWith('/health')) {
      healthCalls += 1;
      if (healthCalls < 3) return new Response('starting', { status: 503 });
      return new Response('{"status":"ok"}', { status: 200 });
    }
    return new Response('not found', { status: 404 });
  });

  const cfg = { ...defaultLayaConfig(), enabled: true, pollIntervalMs: 500, env: { LAYA_THREADS: '8' } };
  const server = new LayaServer(cfg, h.deps);
  const result = await server.start(PY);

  assert.equal(result.ok, true);
  assert.equal(result.baseUrl, 'http://127.0.0.1:8008');
  assert.equal(server.status, 'ready');
  assert.equal(server.pid, 4242);
  assert.equal(healthCalls, 3);
  assert.deepEqual(h.plan.args, ['-m', 'laya', 'serve']);
  assert.equal(h.plan.env?.LAYA_HOST, '127.0.0.1');
  assert.equal(h.plan.env?.LAYA_PORT, '8008');
  assert.equal(h.plan.env?.LAYA_THREADS, '8');
  assert.deepEqual(h.fetched.slice(0, 2), ['http://127.0.0.1:8008/health', 'http://127.0.0.1:8008/v1/models']);
});

test('LayaServer.waitForReady falls back to /v1/models for Jev-style deployments', async () => {
  const h = harness();
  h.setFetch(async (url) =>
    url.endsWith('/health') ? new Response('nope', { status: 404 }) : new Response('{"data":[]}', { status: 200 }),
  );
  const cfg = { ...defaultLayaConfig(), enabled: true, startupTimeoutMs: 1000, pollIntervalMs: 100 };
  const server = new LayaServer(cfg, h.deps);
  const result = await server.start(PY);

  assert.equal(result.ok, true);
  assert.equal(server.status, 'ready');
  assert.ok(h.fetched.some((u) => u.endsWith('/v1/models')));
});

test('LayaServer.start reports a startup timeout when the connection is refused', async () => {
  const h = harness();
  h.setFetch(async () => {
    throw new Error('ECONNREFUSED');
  });

  const cfg = { ...defaultLayaConfig(), enabled: true, startupTimeoutMs: 1000, pollIntervalMs: 500 };
  const server = new LayaServer(cfg, h.deps);
  const result = await server.start(PY);

  assert.equal(result.ok, false);
  assert.equal(server.status, 'failed');
  assert.match(String(server.error), /timed out/);
  assert.equal(h.fetched.length, 4, 'two poll rounds, two candidate paths each');
});

// ---- the black hole ----
//
// Every mock above refuses the connection or answers it, and that is why the readiness loop's missing bound was
// invisible: a refusal fails in microseconds, so the loop always got back to its own `while (now < deadline)` and
// `startupTimeoutMs` looked like a budget. A socket that *accepts* and then goes silent is the one shape that parks
// the loop on an `await` that never returns - and a loop parked there can never observe its own deadline, so the
// startup timeout did not exist for that backend and `start()` never returned.
//
// The two tests below pin the two halves of the fix: the poll is bounded (and its bound is a cap of its own, not
// the whole budget), and a poll that times out is *retried* rather than reported, because the budget - not one
// silent answer - is what decides that a backend is not coming.
//
// Both drive the clock with mocked timers. `Date` is mocked as well as `setTimeout`, so the loop's own clock
// advances exactly when a poll's bound expires - which is the one thing a virtual `sleep`-driven clock cannot show,
// because it does not move while a poll is open.

test('LayaServer.start gives up on a socket that accepts and never answers', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = harness();
  const hole = makeBlackHole();
  h.setFetch(hole.fetch);
  h.deps.now = () => Date.now();

  const cfg = { ...defaultLayaConfig(), enabled: true, startupTimeoutMs: 1_000, pollIntervalMs: 100 };
  const server = new LayaServer(cfg, h.deps);
  let settled: StartResult | undefined;
  void server.start(PY).then((value) => {
    settled = value;
  });
  await drain();

  assert.deepEqual(h.fetched, ['http://127.0.0.1:8008/health'], 'the first candidate path is the one in flight');
  t.mock.timers.tick(999);
  await drain();
  assert.equal(settled, undefined, 'the poll gave up before the budget it was given: a slow backend still gets its time');
  assert.equal(hole.aborted, 0, 'and nothing was cut off early');

  // The assertion the unbounded version cannot satisfy at any tick: the socket will never answer, and the loop has
  // to report its own deadline instead of waiting for a reply that is not coming.
  t.mock.timers.tick(1);
  await drain();
  assert.equal(hole.aborted, 1, 'the silent poll was cut off at the budget rather than left open');
  assert.equal(hole.armed, hole.calls, 'every poll carried the guard signal');
  assert.deepEqual(h.fetched, ['http://127.0.0.1:8008/health'], 'the spent budget left nothing for /v1/models');
  assert.equal(settled?.ok, false);
  assert.equal(server.status, 'failed');
  assert.match(String(server.error), /timed out after 1000ms/);
});

test('a poll that stayed silent is retried, and one poll may not outlast its own bound', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = harness();
  const hole = makeBlackHole();
  let calls = 0;
  h.setFetch(async (url, init) => {
    calls += 1;
    if (calls === 1) return hole.fetch(url, init); // the first /health poll: accepted, never answered
    if (url.endsWith('/health')) return new Response('{"status":"ok"}', { status: 200 });
    return new Response('no', { status: 404 });
  });
  h.deps.now = () => Date.now();

  // The real default budget, 120 000 ms. If one poll were allowed to use it, the cap below would not exist and this
  // loop would sit silent for two minutes on a socket that will never answer.
  const cfg = { ...defaultLayaConfig(), enabled: true };
  const server = new LayaServer(cfg, h.deps);
  let ready: boolean | undefined;
  void server.waitForReady().then((value) => {
    ready = value;
  });
  await drain();

  t.mock.timers.tick(PER_POLL_BOUND_MS - 1);
  await drain();
  assert.equal(hole.aborted, 0, 'the poll was still open - 4 999 ms of silence is not yet a dead socket');
  assert.equal(ready, undefined, 'nothing has answered yet, so nothing has been decided');

  t.mock.timers.tick(1);
  await drain();
  assert.equal(hole.aborted, 1, 'the bound expired, not the 120 s budget');
  assert.equal(ready, true, 'a timed-out poll is "ask again", not "the backend is not coming"');
  assert.deepEqual(
    h.fetched,
    ['http://127.0.0.1:8008/health', 'http://127.0.0.1:8008/v1/models', 'http://127.0.0.1:8008/health'],
    'the round after the timeout asked /health again, and that answer is the one that counted',
  );
  assert.equal(hole.calls, 1, 'only the first poll met the black hole');

  // The band above is written out so this test can run against a launcher that has no bound at all (where the
  // import would not resolve). This keeps it honest against the launcher that does.
  const launcher = await import('../src/launcher.ts');
  assert.equal(launcher.LAYA_POLL_TIMEOUT_MS, PER_POLL_BOUND_MS, 'the test band and the module constant cannot drift');
});

test('LayaServer.start surfaces an early process exit', async () => {
  const h = harness();
  h.setFetch(async () => {
    h.fake.emit('exit', 1);
    throw new Error('ECONNREFUSED');
  });

  const cfg = { ...defaultLayaConfig(), enabled: true, startupTimeoutMs: 5000, pollIntervalMs: 100 };
  const server = new LayaServer(cfg, h.deps);
  const result = await server.start(PY);

  assert.equal(result.ok, false);
  assert.equal(server.status, 'failed');
  assert.match(String(server.error), /exited \(code 1\)/);
});

test('LayaServer.stop terminates the process; disabled config never spawns', async () => {
  const h = harness();
  const cfg = { ...defaultLayaConfig(), enabled: true };
  const server = new LayaServer(cfg, h.deps);
  await server.start(PY);
  assert.equal(server.status, 'ready');
  await server.stop();
  assert.equal(server.status, 'stopped');
  assert.equal(h.fake.killed, true);

  const disabled = new LayaServer({ ...defaultLayaConfig(), enabled: false }, h.deps);
  const result = await disabled.start(PY);
  assert.equal(result.ok, false);
  assert.match(String(result.error), /disabled/);
});
