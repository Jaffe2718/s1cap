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
import type { AssemblyPolicy, Issue, ValidationResult } from '@s1cap/core';
import { defaultPolicy, validatePolicy } from '@s1cap/core';
import type { LayaConfig, LayaValidation } from '@s1cap/laya-runtime';
import {
  LayaServer,
  createNodeDiscoveryDeps,
  createNodeLaunchDeps,
  defaultLayaConfig,
  discoverLayaPython,
  installHint,
  layaBaseUrl,
  validateLayaConfig,
} from '@s1cap/laya-runtime';
import { S1Client, describeS1Backend, redactKey, resolveS1Backend, singleBackendIssues } from '@s1cap/s1-client';
import type { ResolvedS1Backend } from '@s1cap/s1-client';

export interface S1CapPluginConfig extends AssemblyPolicy {
  /**
   * Two independent sinks (docs/CONTROL_PLANE_LOGGING.md): the session log is the only
   * source of segments; the control-plane log records LLM/S1/tool calls and gate
   * decisions and is never segmented or sent to System-1.
   */
  telemetry?: { sessionJsonl?: string; controlJsonl?: string };
  laya?: LayaConfig;
}

export interface TelemetrySinks {
  sessionJsonl: string;
  controlJsonl: string;
}

export const DEFAULT_TELEMETRY: TelemetrySinks = {
  sessionJsonl: './.s1cap/session.jsonl',
  controlJsonl: './.s1cap/control.jsonl',
};

export interface ResolvedPluginConfig {
  config: S1CapPluginConfig;
  policy: ValidationResult;
  laya: LayaValidation;
  telemetry: TelemetrySinks;
  /** single-backend violations: a conflict degrades the session to observation mode */
  conflicts: string[];
  telemetryErrors: string[];
}

/**
 * Validate and normalise the whole plugin config. Fail-safe: invalid values are reported and
 * the default is kept, so a typo in a profile patch can never break a live session.
 */
export function resolvePluginConfig(raw?: Partial<S1CapPluginConfig>): ResolvedPluginConfig {
  const source = (raw ?? {}) as Record<string, unknown>;
  const policy = validatePolicy(source, ['laya', 'telemetry']);
  const laya = validateLayaConfig(source.laya);

  const telemetryErrors: string[] = [];
  const telemetry: TelemetrySinks = { ...DEFAULT_TELEMETRY };
  const rawTelemetry = (source.telemetry ?? {}) as Record<string, unknown>;
  for (const key of ['sessionJsonl', 'controlJsonl'] as const) {
    const value = rawTelemetry[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.trim() === '') {
      telemetryErrors.push(`${key} must be a non-empty string (default kept)`);
      continue;
    }
    telemetry[key] = value;
  }
  if (telemetry.sessionJsonl === telemetry.controlJsonl) {
    // merging the streams would let control-plane records become segments (docs/CONTROL_PLANE_LOGGING.md)
    telemetryErrors.push('sessionJsonl and controlJsonl must differ — the two streams may never be merged');
    telemetry.sessionJsonl = DEFAULT_TELEMETRY.sessionJsonl;
    telemetry.controlJsonl = DEFAULT_TELEMETRY.controlJsonl;
  }

  const config = {
    ...policy.policy,
    telemetry,
    laya: laya.config,
  } as S1CapPluginConfig;

  return {
    config,
    policy,
    laya,
    telemetry,
    conflicts: singleBackendIssues(config.s1, laya.config),
    telemetryErrors,
  };
}

/** Kept for callers that only want the merged config. */
export function resolveConfig(raw?: Partial<S1CapPluginConfig>): S1CapPluginConfig {
  return resolvePluginConfig(raw).config;
}

/** Minimal structural shape of the Cordis plugin context we rely on (M1 fills the types). */
export interface PluginContext {
  on(event: string, handler: (...args: unknown[]) => unknown, options?: { prepend?: boolean }): void;
  command?(spec: { name: string; description: string; run: (...args: unknown[]) => unknown }): void;
  tokenMeter?: { total(): number; fixedOverhead(): number };
  logger?: { info(msg: string): void; warn(msg: string): void };
}

export const name = 'dsh-s1cap';

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

  /**
   * Compact status for the command surface (docs/CONTROL_PLANE_LOGGING.md §5): the
   * backend's raw stdout/stderr stays a bounded diagnostic buffer and is never handed
   * to the agent as command output, so it cannot become a session segment.
   */
  summary(): Omit<LayaRuntimeState, 'logs'> & { logLines: number } {
    const { logs, ...rest } = this.state();
    return { ...rest, logLines: logs.length };
  }
}

export function apply(ctx: PluginContext, raw?: Partial<S1CapPluginConfig>): void {
  const resolved = resolvePluginConfig(raw);
  const config = resolved.config;
  const layaConfig = config.laya ?? defaultLayaConfig();
  const runtime = new LayaRuntime(layaConfig);

  for (const issue of resolved.policy.warnings) ctx.logger?.warn(`[s1cap] config ${issue.path}: ${issue.message}`);
  for (const issue of resolved.laya.warnings) ctx.logger?.warn(`[s1cap] config ${issue.path}: ${issue.message}`);
  for (const issue of [...resolved.policy.errors, ...resolved.laya.errors] as Issue[]) {
    ctx.logger?.warn(`[s1cap] config ${issue.path}: ${issue.message} (default kept)`);
  }
  for (const message of resolved.telemetryErrors) ctx.logger?.warn(`[s1cap] config telemetry: ${message}`);

  // One S1 backend at a time (docs/AGENT_BRIEF.md §0.9). A conflict is reported and the session
  // degrades to observation mode rather than silently picking a governor.
  for (const conflict of resolved.conflicts) ctx.logger?.warn(`[s1cap] ${conflict}`);
  const backend: ResolvedS1Backend = resolveS1Backend(
    resolved.conflicts.length > 0 ? { ...config.s1, provider: 'none' } : config.s1,
    layaConfig,
  );
  const client =
    backend.mode !== 'none' && backend.baseUrl
      ? new S1Client({
          baseUrl: backend.baseUrl,
          ...(backend.apiKey ? { apiKey: backend.apiKey } : {}),
          ...(backend.model ? { model: backend.model } : {}),
          timeoutMs: config.s1.timeoutMs,
        })
      : undefined;

  ctx.logger?.info(
    `[s1cap] cell=${config.cell} tas=${String(config.tas.on)} tier1=${config.recall.tier1} planGate=${String(config.planGate.on)} laya=${String(layaConfig.enabled)}`,
  );
  ctx.logger?.info(`[s1cap] s1 backend: ${describeS1Backend(backend)}`);
  if (resolved.conflicts.length > 0) ctx.logger?.warn('[s1cap] this session makes no System-1 calls (provider=none)');

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

  // `/s1 status` never prints the API key: the resolved backend is described through redactKey().
  ctx.command?.({
    name: 's1',
    description: 'S1CAP status: policy, resolved System-1 backend, Laya state, sinks',
    run: () => {
      const status = {
        cell: config.cell,
        termination: config.termination,
        assemblyDeadlineMs: config.assemblyDeadlineMs,
        rgMaintenance: config.rgMaintenance,
        cache: config.cache,
        tas: config.tas,
        recall: config.recall,
        tail: config.tail,
        planGate: config.planGate,
        s1: {
          provider: backend.provider,
          mode: backend.mode,
          baseUrl: backend.baseUrl,
          model: backend.model,
          key: redactKey(backend.apiKey),
          timeoutMs: config.s1.timeoutMs,
          questionsPerCall: config.s1.questionsPerCall,
        },
        laya: runtime.summary(),
        telemetry: resolved.telemetry,
        configIssues: {
          errors: resolved.policy.errors.concat(resolved.laya.errors as Issue[]).map((i) => `${i.path}: ${i.message}`),
          warnings: resolved.policy.warnings.concat(resolved.laya.warnings as Issue[]).map((i) => `${i.path}: ${i.message}`),
          conflicts: resolved.conflicts,
          telemetry: resolved.telemetryErrors,
        },
      };
      ctx.logger?.info(`[s1cap] ${JSON.stringify(status, null, 2)}`);
      return status;
    },
  });

  // Closed-loop probe: proves the configured backend is actually reachable.
  ctx.command?.({
    name: 's1 ping',
    description: 'S1CAP: probe the resolved System-1 backend (GET /health)',
    run: async () => {
      if (!client) return { ok: false, reason: 'provider=none (no System-1 backend is active)' };
      const started = Date.now();
      const ok = await client.health();
      const result = { ok, baseUrl: backend.baseUrl, model: backend.model, ms: Date.now() - started };
      ctx.logger?.info(`[s1cap] ping ${ok ? 'ok' : 'unreachable'} ${String(backend.baseUrl)} in ${result.ms}ms`);
      return result;
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
        await runtime.start();
        const state = runtime.summary();
        ctx.logger?.info(`[s1cap] laya start: ${JSON.stringify(state, null, 2)}`);
        return state;
      }
      if (verb === 'stop') {
        await runtime.stop();
        const state = runtime.summary();
        ctx.logger?.info(`[s1cap] laya stop: ${JSON.stringify(state, null, 2)}`);
        return state;
      }
      const state = runtime.summary();
      ctx.logger?.info(
        `[s1cap] laya status: ${state.status}${state.pythonPath ? ` (python: ${state.pythonPath})` : ''}${state.error ? ` - ${state.error}` : ''}${state.logLines ? ` [${state.logLines} diagnostic lines buffered]` : ''}`,
      );
      return state;
    },
  });
}
