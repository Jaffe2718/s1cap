/**
 * dsh-s1cap — plugin skeleton (M0).
 *
 * Hook map verified against the local DSH install and the community plugin
 * `dsh-command-context-trim` (docs/AGENT_BRIEF.md §1.5):
 *
 *   - `agent/pre-step`        run ASSEMBLER before each LLM call; emit model-only
 *                             surface ops (`surfaceOp: {op:'replace'}`) — the
 *                             user-facing transcript stays strictly chronological
 *   - message-append events   SEGMENTER + tier-1 RECALL, incrementally
 *   - `ctx.tokenMeter`        budget + fixed overhead accounting
 *   - `agent/request-error`   prepend listener: degrade to tier-0 + recency window
 *                             instead of failing the session
 *   - commands                /s1 status | config | graph | why <seq> | laya
 *
 * The Laya half is implemented: `@s1cap/laya-runtime` discovers a Python environment
 * that can `import laya`, launches `laya-serve` and health-checks `/v1/models`.
 * Context-lifecycle hooks stay skeletons until M1.
 */
import type { AssemblyPolicy } from '@s1cap/core';
import { defaultPolicy } from '@s1cap/core';
import type { LayaConfig } from '@s1cap/laya-runtime';
import {
  LayaServer,
  createNodeDiscoveryDeps,
  createNodeLaunchDeps,
  defaultLayaConfig,
  discoverLayaPython,
  installHint,
  layaBaseUrl,
} from '@s1cap/laya-runtime';

export interface S1CapPluginConfig extends AssemblyPolicy {
  telemetry?: { jsonl?: string };
  laya?: LayaConfig;
}

/** Minimal structural shape of the Cordis plugin context we rely on (M1 fills the types). */
export interface PluginContext {
  on(event: string, handler: (...args: unknown[]) => unknown, options?: { prepend?: boolean }): void;
  command?(spec: { name: string; description: string; run: (...args: unknown[]) => unknown }): void;
  tokenMeter?: { total(): number; fixedOverhead(): number };
  logger?: { info(msg: string): void; warn(msg: string): void };
}

export const name = 'dsh-s1cap';

/** Cordis resolves config through schemastery in production; skeleton keeps the raw shape. */
export function resolveConfig(raw: Partial<S1CapPluginConfig> | undefined): S1CapPluginConfig {
  const base = defaultPolicy();
  const laya = { ...defaultLayaConfig(), ...(raw?.laya ?? {}) };
  return { ...base, ...(raw ?? {}), laya } as S1CapPluginConfig;
}

export interface LayaRuntimeState {
  status: 'stopped' | 'starting' | 'ready' | 'failed';
  baseUrl: string;
  pythonPath?: string;
  error?: string;
  logs: readonly string[];
}

/**
 * Resolve the interpreter, start `laya-serve` when configured, and expose the state
 * the settings surface renders. Returns a handle so the plugin (or a UI panel) can
 * stop the server and re-run discovery.
 */
export class LayaRuntime {
  #config: LayaConfig;
  #server: LayaServer;
  #pythonPath?: string;
  #error?: string;

  constructor(config: LayaConfig) {
    this.#config = config;
    this.#server = new LayaServer(config, createNodeLaunchDeps());
  }

  /** `discover` only probes interpreters; `start` also spawns the server. */
  async discover(): Promise<{ pythonPath?: string; hasLaya: boolean; hint?: string; error?: string }> {
    const report = await discoverLayaPython(this.#config, createNodeDiscoveryDeps());
    const chosen = report.chosen;
    if (!chosen) {
      this.#error = 'no usable Python interpreter found';
      return { hasLaya: false, error: this.#error };
    }
    this.#pythonPath = chosen.path;
    if (!chosen.laya) {
      this.#error = `the laya package is not importable in ${chosen.path}`;
      return { pythonPath: chosen.path, hasLaya: false, hint: installHint(chosen.path), error: this.#error };
    }
    this.#error = undefined;
    return {
      pythonPath: chosen.path,
      hasLaya: true,
      ...(chosen.serve ? {} : { hint: `${installHint(chosen.path)}   # the serving extra (fastapi + uvicorn) is missing` }),
    };
  }

  async start(): Promise<LayaRuntimeState> {
    const discovered = await this.discover();
    if (!discovered.hasLaya || !discovered.pythonPath) {
      return this.state();
    }
    await this.#server.start(discovered.pythonPath);
    if (this.#server.status !== 'ready') this.#error = this.#server.error;
    return this.state();
  }

  async stop(): Promise<LayaRuntimeState> {
    await this.#server.stop();
    return this.state();
  }

  state(): LayaRuntimeState {
    return {
      status: this.#server.status,
      baseUrl: layaBaseUrl(this.#config),
      ...(this.#pythonPath ? { pythonPath: this.#pythonPath } : {}),
      ...(this.#error ?? this.#server.error ? { error: this.#error ?? this.#server.error } : {}),
      logs: this.#server.logs,
    };
  }
}

export function apply(ctx: PluginContext, raw?: Partial<S1CapPluginConfig>): void {
  const config = resolveConfig(raw);
  const layaConfig = config.laya ?? defaultLayaConfig();
  const runtime = new LayaRuntime(layaConfig);

  ctx.logger?.info(
    `[s1cap] cell=${config.cell} tas=${String(config.tas.on)} tier1=${config.recall.tier1} planGate=${String(config.planGate.on)} s1=${config.s1.provider} laya=${String(layaConfig.enabled)}`,
  );

  if (layaConfig.enabled && layaConfig.autoStart) {
    void runtime
      .start()
      .then((state) => {
        if (state.status === 'ready') ctx.logger?.info(`[s1cap] laya-serve ready at ${state.baseUrl} (python: ${state.pythonPath ?? 'unknown'})`);
        else ctx.logger?.warn(`[s1cap] laya-serve not ready: ${state.error ?? state.status} — System-1 calls fall back to tier-0`);
      })
      .catch((err: unknown) => ctx.logger?.warn(`[s1cap] laya startup failed: ${String(err)}`));
  }

  ctx.on('agent/pre-step', () => {
    // M1: assemble(input) from @s1cap/core and emit surface replace ops.
    return undefined;
  });

  ctx.on('agent/request-error', () => {
    // M1: degradation path — tier-0 metadata + recency window, then request a retry.
    return undefined;
  });

  ctx.command?.({
    name: 's1',
    description: 'S1CAP: status | config | graph | why <seq>',
    run: () => {
      ctx.logger?.info(`[s1cap] ${JSON.stringify({ cell: config.cell, policy: config }, null, 2)}`);
      return undefined;
    },
  });

  // Settings surface for the local Laya backend. `[VERIFY]` the exact command
  // registration shape against the DSH release in use (M1).
  ctx.command?.({
    name: 's1 laya',
    description: 'S1CAP Laya backend: discover | start | stop | status',
    run: async (action?: unknown) => {
      const verb = typeof action === 'string' ? action : 'status';
      if (verb === 'discover') {
        const result = await runtime.discover();
        ctx.logger?.info(`[s1cap] laya discover: ${JSON.stringify(result, null, 2)}`);
        return result;
      }
      if (verb === 'start') {
        const state = await runtime.start();
        ctx.logger?.info(`[s1cap] laya start: ${JSON.stringify(state, null, 2)}`);
        return state;
      }
      if (verb === 'stop') {
        const state = await runtime.stop();
        ctx.logger?.info(`[s1cap] laya stop: ${JSON.stringify(state, null, 2)}`);
        return state;
      }
      const state = runtime.state();
      ctx.logger?.info(
        `[s1cap] laya status: ${state.status}${state.pythonPath ? ` (python: ${state.pythonPath})` : ''}${state.error ? ` — ${state.error}` : ''}`,
      );
      return state;
    },
  });
}
