import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultLayaConfig } from '../src/types.ts';
import { LayaServer, buildLaunchPlan, consoleScriptPath } from '../src/launcher.ts';
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
  setFetch(fn: typeof fetch): void;
  clock(): { t: number; advance(ms: number): void };
}

function harness(opts: { hasConsoleScript?: boolean; platform?: string } = {}): Harness {
  const fake = makeChild();
  const plan: Harness['plan'] = {};
  let t = 0;
  let impl: typeof fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch;
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
    fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) => impl(input, init)) as typeof fetch,
  };
  return {
    deps,
    plan,
    fake,
    setFetch(fn) {
      impl = fn;
    },
    clock: () => ({ get t() { return t; }, advance(ms: number) { t += ms; } }),
  };
}

test('consoleScriptPath targets the environment layout of each platform', () => {
  assert.equal(consoleScriptPath(PY, 'win32'), 'D:\\conda_store\\envs\\ml\\Scripts\\laya-serve.exe');
  assert.equal(consoleScriptPath('/opt/conda/envs/ml/bin/python', 'linux'), '/opt/conda/envs/ml/bin/laya-serve');
});

test('buildLaunchPlan prefers the console script, falls back to `-m laya serve`, honours overrides', () => {
  const cfg = { ...defaultLayaConfig(), port: 9001, serveArgs: ['--device', 'cpu'] };

  const viaScript = buildLaunchPlan(cfg, PY, 'win32', true);
  assert.equal(viaScript.command, 'D:\\conda_store\\envs\\ml\\Scripts\\laya-serve.exe');
  assert.deepEqual(viaScript.args, ['--host', '127.0.0.1', '--port', '9001', '--device', 'cpu']);

  const viaModule = buildLaunchPlan(cfg, PY, 'win32', false);
  assert.equal(viaModule.command, PY);
  assert.deepEqual(viaModule.args, ['-m', 'laya', 'serve', '--host', '127.0.0.1', '--port', '9001', '--device', 'cpu']);

  const viaCommand = buildLaunchPlan({ ...cfg, serveCommand: 'C:\\wrap\\laya.cmd' }, PY, 'win32', true);
  assert.equal(viaCommand.command, 'C:\\wrap\\laya.cmd');

  const env = buildLaunchPlan({ ...cfg, env: { LAYA_THREADS: '8', HF_ENDPOINT: 'https://hf-mirror.com' } }, PY, 'win32', false).env;
  assert.equal(env.LAYA_THREADS, '8');
  assert.equal(env.HF_ENDPOINT, 'https://hf-mirror.com');
  assert.equal(env.LAYA_PORT, '9001');
});

test('LayaServer.start spawns, polls /v1/models and reaches ready', async () => {
  const h = harness();
  let polls = 0;
  h.setFetch((async () => {
    polls += 1;
    if (polls < 3) throw new Error('ECONNREFUSED');
    return new Response('{"data":[]}', { status: 200 });
  }) as typeof fetch);

  const cfg = { ...defaultLayaConfig(), enabled: true, pollIntervalMs: 500, env: { LAYA_THREADS: '8' } };
  const server = new LayaServer(cfg, h.deps);
  const result = await server.start(PY);

  assert.equal(result.ok, true);
  assert.equal(result.baseUrl, 'http://127.0.0.1:8008');
  assert.equal(server.status, 'ready');
  assert.equal(server.pid, 4242);
  assert.equal(polls, 3);
  assert.deepEqual(h.plan.args, ['-m', 'laya', 'serve', '--host', '127.0.0.1', '--port', '8008']);
  assert.equal(h.plan.env?.LAYA_THREADS, '8');
});

test('LayaServer.start reports a startup timeout instead of hanging', async () => {
  const h = harness();
  let polls = 0;
  h.setFetch((async () => {
    polls += 1;
    throw new Error('ECONNREFUSED');
  }) as typeof fetch);

  const cfg = { ...defaultLayaConfig(), enabled: true, startupTimeoutMs: 1000, pollIntervalMs: 500 };
  const server = new LayaServer(cfg, h.deps);
  const result = await server.start(PY);

  assert.equal(result.ok, false);
  assert.equal(server.status, 'failed');
  assert.match(String(server.error), /timed out/);
  assert.equal(polls, 2);
});

test('LayaServer.start surfaces an early process exit', async () => {
  const h = harness();
  h.setFetch((async () => {
    h.fake.emit('exit', 1);
    throw new Error('ECONNREFUSED');
  }) as typeof fetch);

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
