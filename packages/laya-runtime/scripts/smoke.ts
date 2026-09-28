/**
 * End-to-end smoke test for the local Laya backend.
 *
 *   node --experimental-strip-types packages/laya-runtime/scripts/smoke.ts \
 *     --python <interpreter> [--port 8008] [--preload 1] [--models typed-decisions] [--call]
 *
 * Starts `laya-serve` through the real launcher, waits for readiness, optionally makes one
 * `noul` decision over /v1/systemone, then shuts the server down.
 * Without `--call` nothing is downloaded: the check is "does the server come up".
 */
import { defaultLayaConfig } from '../src/types.ts';
import type { LayaConfig } from '../src/types.ts';
import { LayaServer } from '../src/launcher.ts';
import { createNodeLaunchDeps } from '../src/node-deps.ts';
import { S1Client, noul } from '../../s1-client/src/index.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const python = arg('python');
if (!python) {
  console.error('usage: smoke.ts --python <interpreter> [--port 8008] [--preload 1] [--models <list>] [--call]');
  process.exit(2);
}

const port = Number(arg('port') ?? 8008);
const preload = arg('preload') ?? '0';
const models = arg('models');
const doCall = process.argv.includes('--call');

const env: Record<string, string> = {
  LAYA_PRELOAD: preload,
  LAYA_THREADS: arg('threads') ?? '8',
  LAYA_LOG_LEVEL: arg('log') ?? 'info',
  ...(models ? { LAYA_MODELS: models } : {}),
  ...(process.env.HF_ENDPOINT ? { HF_ENDPOINT: process.env.HF_ENDPOINT } : {}),
};

const cfg: LayaConfig = {
  ...defaultLayaConfig(),
  enabled: true,
  host: '127.0.0.1',
  port,
  startupTimeoutMs: Number(arg('timeout') ?? 600_000),
  env,
};

const server = new LayaServer(cfg, createNodeLaunchDeps());
console.log(`[smoke] starting laya-serve on ${server.baseUrl} (LAYA_PRELOAD=${preload}, python=${python})`);
const started = await server.start(python);
console.log(`[smoke] start -> ok=${started.ok} status=${server.status}${started.error ? ` error=${started.error}` : ''}`);
for (const line of server.logs.slice(-8)) console.log(`[server] ${line}`);
if (!started.ok) process.exit(1);

if (doCall) {
  const client = new S1Client({ baseUrl: server.baseUrl, timeoutMs: 600_000 });
  console.log('[smoke] calling POST /v1/systemone (this may download the checkpoint on first use)');
  const result = await client.decide('The export button crashes in Safari on macOS 15.', {
    relevant: noul('Does this segment describe a software bug?'),
    browser: noul('Is this bug specific to one browser?'),
  });
  console.log(`[smoke] answers: ${JSON.stringify(result.answers)}`);
  console.log(`[smoke] usage: ${JSON.stringify(result.usage)} in ${result.ms} ms`);
}

await server.stop();
console.log(`[smoke] stopped (status=${server.status})`);
