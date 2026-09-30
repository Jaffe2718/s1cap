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
import type { LaunchDeps, SpawnedProcess } from '../src/launcher.ts';

const PY = 'D:\\conda_store\\envs\\ml\\python.exe';

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
  setFetch(fn: (url: string) => Promise<Response>): void;
}

function harness(opts: { hasConsoleScript?: boolean; platform?: string } = {}): Harness {
  const fake = makeChild();
  const plan: Harness['plan'] = {};
  const fetched: string[] = [];
  let t = 0;
  let impl = async (_url: string): Promise<Response> => new Response('{}', { status: 200 });
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
    fetchImpl: ((input: RequestInfo | URL) => {
      const url = String(input);
      fetched.push(url);
      return impl(url);
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

test('LayaServer.start reports a startup timeout instead of hanging', async () => {
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
