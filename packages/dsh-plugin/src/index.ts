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
import { ControlPlaneLog } from '@s1cap/core';
import { createControlSink, resolveTelemetryPath } from './control-log.ts';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { primeSystemPrompt } from './system-prompt.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { TUNING_REF, parseTuning, parseTuningArgs, readCredential } from './credentials.ts';
import type { Tuning } from './credentials.ts';
import { createStepObserver } from './step-observer.ts';
import type { StepObserver } from './step-observer.ts';
import { createS1Relevance } from './s1-relevance.ts';
import { createPlanGate } from './plan-gate-runtime.ts';

export interface S1CapPluginConfig extends AssemblyPolicy {
  /** master switch: anything other than true keeps the plugin completely inert (default false)
 */
  enabled?: boolean;
  /**
   * Per-LLM-call observation (M1). `log` (default) runs SEGMENTER → RECALL → ASSEMBLER on every call and
   * writes the result to the control-plane log **without touching the prompt the model receives**;
   * `off` does nothing. Rewriting the model view is a separate, later switch that does not exist yet.
 */
  observation?: 'off' | 'log' | 'tape';
  /**
   * Two independent sinks (docs/CONTROL_PLANE_LOGGING.md): the session log is the only
   * source of segments; the control-plane log records LLM/S1/tool calls and gate
   * decisions and is never segmented or sent to System-1.
 */
  telemetry?: { sessionJsonl?: string; controlJsonl?: string; tapeJsonl?: string };
  laya?: LayaConfig;
}

export interface TelemetrySinks {
  sessionJsonl: string;
  controlJsonl: string;
  /** M1 N3: replay tape (session content) - written only in observation: tape mode
 */
  tapeJsonl: string;
}

export const DEFAULT_TELEMETRY: TelemetrySinks = {
  sessionJsonl: './.s1cap/session.jsonl',
  controlJsonl: './.s1cap/control.jsonl',
  tapeJsonl: './.s1cap/tape.jsonl',
};

export interface ResolvedPluginConfig {
  config: S1CapPluginConfig;
  policy: ValidationResult;
  laya: LayaValidation;
  telemetry: TelemetrySinks;
  /** single-backend violations: a conflict degrades the session to observation mode
 */
  conflicts: string[];
  telemetryErrors: string[];
  /** effective M1 observation mode (`log` unless the config says otherwise)
 */
  observation: 'off' | 'log' | 'tape';
  observationErrors: string[];
}

/** Context accounting defaults, used when the harness token meter is unavailable.
 */
const CONTEXT_WINDOW_DEFAULT = 128_000;
const RESERVE_OUTPUT_DEFAULT = 8_000;
const FIXED_OVERHEAD_DEFAULT = 1_200;
const DECAY_LAMBDA_MS = 36 * 60 * 60 * 1000;

/**
 * Validate and normalise the whole plugin config. Fail-safe: invalid values are reported and
 * the default is kept, so a typo in a profile patch can never break a live session.
 */
export function resolvePluginConfig(raw?: Partial<S1CapPluginConfig>): ResolvedPluginConfig {
  const source = (raw ?? {}) as Record<string, unknown>;
  const policy = validatePolicy(source, ['laya', 'telemetry', 'enabled', 'observation']);
  const laya = validateLayaConfig(source.laya);

  const telemetryErrors: string[] = [];
  const telemetry: TelemetrySinks = { ...DEFAULT_TELEMETRY };
  const rawTelemetry = (source.telemetry ?? {}) as Record<string, unknown>;  for (const key of ['sessionJsonl', 'controlJsonl'] as const) {
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

  // Observation mode is validated here (not in core): it is a plugin-level switch, not part of the
  // frozen assembly policy. Fail-safe like everything else — an unknown value keeps the default.
  const observationErrors: string[] = [];
  let observation: 'off' | 'log' | 'tape' = 'log';
  const rawObservation = source.observation;
  if (rawObservation !== undefined) {
    if (rawObservation === 'off' || rawObservation === 'log' || rawObservation === 'tape') observation = rawObservation;
    else observationErrors.push(`observation must be "off", "log" or "tape" (default kept: ${observation})`);
  }
  config.observation = observation;

  return {
    config,
    policy,
    laya,
    telemetry,
    conflicts: singleBackendIssues(config.s1, laya.config),
    telemetryErrors,
    observation,
    observationErrors,
  };
}

/** Kept for callers that only want the merged config.
 */
export function resolveConfig(raw?: Partial<S1CapPluginConfig>): S1CapPluginConfig {
  return resolvePluginConfig(raw).config;
}

/** Minimal structural shape of the Cordis plugin context we rely on (verified against DSH 0.1.7-rc.2).
 */
export interface CommandSpec {
  name: string;
  description: string;
  input?: { hint: string };
  handler: (arg: { rawInput?: string }) => unknown;
}

export interface PluginContext {
  on(event: string, handler: (...args: unknown[]) => unknown, options?: { prepend?: boolean }): void;
  /** Cordis disposal helper: registrations inside it are torn down when the plugin unloads
 */
  effect?(fn: () => unknown): unknown;
  /** the command service (`commands`, injected as an optional dependency)
 */
  commands?: { register?(spec: CommandSpec): unknown };
  tokenMeter?: { total(): number; fixedOverhead(): number };
  logger?: { info?(msg: string): void; warn?(msg: string): void };
}

export const name = 'dsh-s1cap';

/**
 * Services this plugin consumes. The plain-array form is what the shipped plugins use
 * (verified against `dsh-pet`); an object form such as `{ optional: [...] }` makes Cordis wait on a
 * service literally named "optional". `commands` comes from `@deepseek-ai/dsh-commands`, which every
 * profile mounts through `@deepseek-ai/dsh-base`; the defensive checks below still tolerate its
 * absence (tests, stripped-down profiles).
 * webServer is deliberately NOT declared here: declaring it makes a profile without the service refuse to apply this
 */
export const inject = ['commands'];

/** Register the `/s1` surface; tolerant of a profile that does not mount the command service.
 */
function registerCommands(ctx: PluginContext, specs: CommandSpec[]): string[] {
  const registered: string[] = [];
  if (typeof ctx.commands?.register !== 'function') {
    ctx.logger?.warn?.('[s1cap] command service unavailable in this profile — /s1 commands disabled');
    return registered;
  }
  for (const spec of specs) {
    const register = (): void => {
      ctx.commands?.register?.(spec);
      registered.push(spec.name);
    };
    if (typeof ctx.effect === 'function') ctx.effect(register);
    else register();
    ctx.logger?.info?.(`[s1cap] command registered: /${spec.name}`);
  }
  return registered;
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

  /** `discover` only probes interpreters; `start` also spawns the server.
 */
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

/**
 * `agent/pre-step` is a **waterfall middleware**, verified against `dsh-agent`'s packaged source:
 *
    {
    }
    const decision = await next();
 *     if (decision.kind === 'reject' || signal.aborted) return decision;
 *     return { ...decision, messages: [...] };
 *   }, { prepend: true });
 *
 * The contract is absolute: a handler MUST await `next()` and return that decision, optionally
 * modified. Returning `undefined` — which an earlier stub of this plugin did — makes the harness read
 * `decision.kind` of nothing and kills the round:
 * `Cannot read properties of undefined (reading 'kind')`.
 *
 * This wrapper therefore (1) calls `next()` first so harness errors propagate unchanged and are never
 * swallowed, (2) returns the decision untouched until M1 actually assembles context, and (3) isolates
 * its own bookkeeping: a failure in our code is logged and cannot affect the round.
 */
/** one lazy priming thunk per session, run by the first pre-step call (see preStepMiddleware)
 */
let primeOnce: (() => Promise<void>) | undefined;

/**
 * Where the System-1 credential lives. The settings panel writes `<scope>/<id>`, and the host reads it back
 * through the credentials service when the config leaves `s1.apiKey` empty (env vars remain the headless
 * fallback). The key itself is only ever surfaced through `redactKey()`.
 */
const CREDENTIAL_REF = 's1cap/jev';
let credentialKey: string | undefined;
let credentialSource = 'config-or-env';
/** recall tuning the panel stored, applied to the live policy at session start
 */
let appliedTuning: Tuning = {};
/** the plugin's own store for the two recall knobs; relative paths resolve against DSH_HOME
 */
const TUNING_FILE = './.s1cap/tuning.json';

/** the panel's Save route: a prefix on the same server that serves the UI, following dsh-pet's /dsh-pet-7340
 */
const TUNING_ROUTE = '/s1cap-7340';

function readTuningFile(): Tuning {
  try {
    const raw = readFileSync(resolveTelemetryPath(TUNING_FILE), 'utf8');
    const parsed = JSON.parse(raw) as { depth?: unknown; relevanceThreshold?: unknown; window?: unknown; xFirst?: unknown };
    const out: Tuning = {};
    if (typeof parsed.depth === 'number' && Number.isInteger(parsed.depth) && parsed.depth > 0) out.depth = parsed.depth;
    // A file written before the rename still carries the old key: read either, so an upgrade does not silently
    // drop a researcher's stored threshold.
    const threshold = typeof parsed.relevanceThreshold === 'number' ? parsed.relevanceThreshold : (parsed as { releTao?: unknown }).releTao;
    if (typeof threshold === 'number' && threshold >= 0 && threshold <= 1) out.relevanceThreshold = threshold;
    if (typeof parsed.window === 'number' && Number.isInteger(parsed.window) && parsed.window >= 64) out.window = parsed.window;
    // `false` is a real value here, not an absence, so this tests the type rather than truthiness. The first
    // version omitted the field from this reader entirely, so the panel wrote it, the route echoed it back from
    // the in-memory copy, and the layout stayed on its default - a stored setting that looked saved everywhere
    // except in the prompt it was supposed to change.
    if (typeof parsed.xFirst === 'boolean') out.xFirst = parsed.xFirst;
    return out;
  } catch {
    return {};
  }
}

/**
 * Persist the knobs. The failure reason is returned rather than swallowed: a Save that reports "not persisted"
 * without saying why is the same silent-failure shape this project keeps rejecting, and the panel prints it.
 */
function writeTuningFile(values: Tuning): { ok: boolean; error?: string } {
  const path = resolveTelemetryPath(TUNING_FILE);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(values) + '\n', 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: path + ": " + (e instanceof Error ? e.message : String(e)) };
  }
}

/** Read a small request body as text. Bounded, so a stray large PUT cannot exhaust memory.
 */
function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    req.setEncoding?.('utf8');
    req.on('data', (chunk: string) => {
      text += chunk;
      if (text.length > 4096) reject(new Error('request body too large'));
    });
    req.on('end', () => resolve(text));
    req.on('error', reject);
  });
}
function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * The session-event lane is wired at the very top of `applyInner`, before anything that can throw, so an
 * activation failure later in the function cannot silently cost us the lane. These three live at module level
 * because the observer and the tape sink do not exist yet when the subscription is registered.
 */
let activeObserver: StepObserver | undefined;
let probeOut: ((line: string) => void) | undefined;
/** events that arrive before observation is wired (bounded; drained once the observer exists)
 */
const earlySessionEvents: unknown[] = [];
const EARLY_EVENT_LIMIT = 16;

export function preStepMiddleware(
  ctx: PluginContext,
  observer?: StepObserver,
): (payload: unknown, next: () => Promise<unknown>) => Promise<unknown> {
  return async (payload, next) => {
    if (primeOnce !== undefined) {
      // Prime lazily, on the first step: at activation time other plugins may not have provided the
      // systemPrompt service yet, which is why an earlier attempt read it too early and pinned nothing.
      // One assemble() per session; the primer reports its own failures, so a rejection is swallowed here.
      const prime = primeOnce;
      primeOnce = undefined;
      try {
        await prime();
      } catch {
        /* reported by the primer
 */
      }
    }
    const decision = await next();
    try {
      // M1 observation mode: segment, recall and assemble for real, record the result in the control
      // plane, and return the decision completely untouched. `observe()` never throws.
      await observer?.observe(payload);
    } catch (err) {
      ctx.logger?.warn?.(`[s1cap] pre-step observation failed (ignored): ${String(err)}`);
    }
    return decision;
  };
}

/**
 * Activation is wrapped so a half-built governor can never break the harness: any throw is logged and
 * the plugin stays inert. `enabled` defaults to false, so merely registering the bundle changes nothing
 * — no hooks, no commands, no System-1 calls.
 */
/**
 * Look a service up WITHOUT declaring it in `inject`.
 *
 * Declaring `webServer` is the obvious route, and it is what `dsh-pet` does - but a declared dependency is a hard
 * gate: cordis applies a plugin only once every injected service exists, so a headless profile with no web server
 * would stop applying this plugin at all and take the observation lane and /s1-tune down with it. That was measured,
 * not assumed: with the declaration, a headless profile went from one control-plane record to zero.
 *
 * Reading the service out of the registry instead keeps this plugin applicable everywhere - the route exists in a
 * web profile and is simply absent in a headless one, which is the degradation the panel already handles. Cordis
 * resolves `ctx.<name>` by walking up the fiber chain and `ctx.registry` is always present, so the same walk is
 * available without declaring. Every step is guarded: a future cordis that reorganises this yields "no route",
 * never a crash.
 */
function findService<T>(ctx: PluginContext, name: string): T | undefined {
  try {
    const registry = (ctx as unknown as { registry?: { values?: () => Iterable<unknown> } }).registry;
    if (typeof registry?.values !== 'function') return undefined;
    for (const runtime of registry.values()) {
      const fibers = (runtime as { fibers?: Iterable<unknown> }).fibers ?? [];
      for (const fiber of fibers) {
        const impl = (fiber as { store?: Record<string, { value?: T }> }).store?.[name];
        if (impl?.value !== undefined) return impl.value;
        try {
          const value = (fiber as { ctx?: Record<string, T> }).ctx?.[name];
          if (value !== undefined) return value;
        } catch {
          /* the owning fiber does not expose it either - keep looking */
        }
      }
    }
  } catch {
    /* the registry shape changed - degrade to no route */
  }
  return undefined;
}

export function apply(ctx: PluginContext, raw?: Partial<S1CapPluginConfig>): void {
  try {
    applyInner(ctx, raw);
  } catch (err) {
    try {
      ctx.logger?.warn?.(`[s1cap] activation failed; plugin stays inert: ${String(err)}`);
    } catch {
      // nothing left to do — never rethrow from here
    }
  }
}

function applyInner(ctx: PluginContext, raw?: Partial<S1CapPluginConfig>): void {
  const source = (raw ?? {}) as Record<string, unknown>;
  if (source.enabled !== true) {
    ctx.logger?.info?.('[s1cap] not enabled (config.enabled !== true) — inert: no hooks, no commands, no System-1 calls');
    return;
  }
  // First registration, before anything that can throw, and before the observer exists: events that arrive
  // early are buffered (bounded) and drained once observation is wired. The marker proves delivery, which is
  // the difference between "the hook name is wrong" and "this profile emits nothing during the run".
  ctx.on('session/event', (_session: unknown, event: unknown) => {
    probeOut?.(
      JSON.stringify({
        schema: 0,
        kind: 'session-event',
        type: (event as { type?: unknown } | null)?.type ?? typeof event,
      }) + '\n',
    );
    if (activeObserver !== undefined) activeObserver.noteSessionEvent(event);
    else if (earlySessionEvents.length < EARLY_EVENT_LIMIT) earlySessionEvents.push(event);
  });

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
  for (const message of resolved.observationErrors) ctx.logger?.warn(`[s1cap] config observation: ${message}`);

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

  // M1 observation mode. Real SEGMENTER + RECALL + ASSEMBLER on every LLM call, recorded in the
  // control plane, with the prompt the model receives returned untouched — nothing here can change a
  // round. `off` skips it entirely. The context window comes from constants for now: `ctx.tokenMeter`'s
  // semantics are not verified yet, and a wrong window would silently distort every budget number.
  let observer: StepObserver | undefined;
  /** one assemble() per session; awaited by the first pre-step call (a short round can exit before a fire-and-forget promise settles)
 */
  let priming: Promise<void> | undefined;
  if (resolved.observation !== 'off') {
    const probeSink =
      resolved.observation === 'tape'
        ? createControlSink({ path: resolveTelemetryPath(resolved.telemetry.tapeJsonl), onError: () => undefined })
        : undefined;
    if (probeSink !== undefined) {
      // One-shot introspection: the real method names of the systemPrompt service. Reading a service that
      // was not injected throws in Cordis, so both outcomes are written down instead of guessed at.
      try {
        const svc = (ctx as { get?: (name: string) => unknown }).get?.('systemPrompt');
        probeSink.write(
          `${JSON.stringify({
            schema: 0,
            kind: 'service-probe',
            service: svc === undefined ? 'absent' : typeof svc,
            methods:
              svc === null || typeof svc !== 'object'
                ? []
                : Object.getOwnPropertyNames(Object.getPrototypeOf(svc)).slice(0, 40),
            assemblyKeys: (() => {
              try {
                const built = (svc as { assemble?: () => unknown }).assemble?.();
                return built === null || typeof built !== 'object' ? typeof built : Object.keys(built as object).slice(0, 20);
              } catch (err) {
                return `threw:${String(err)}`;
              }
            })(),
            assemblyPreview: (() => {
              try {
                const built = (svc as { assemble?: () => unknown }).assemble?.() as { text?: unknown; prompt?: unknown } | undefined;
                const text = typeof built?.text === 'string' ? built.text : typeof built?.prompt === 'string' ? built.prompt : undefined;
                return text === undefined ? 'none' : text.slice(0, 160);
              } catch {
                return 'threw';
              }
            })(),
          })}
`,
        );
      } catch (err) {
        probeSink.write(`${JSON.stringify({ schema: 0, kind: 'service-probe', service: 'threw', error: String(err) })}
`);
      }
    }
    const tapeSink =
      resolved.observation === 'tape'
        ? createControlSink({
            path: resolveTelemetryPath(resolved.telemetry.tapeJsonl),
            onError: (message) => ctx.logger?.warn?.(`[s1cap] tape sink: ${message}`),
          })
        : undefined;
    if (probeSink !== undefined) {
      // One-shot introspection: the real method names of the systemPrompt service. Reading a service that
      // was not injected throws in Cordis, so both outcomes are written down instead of guessed at.
      try {
        const svc = (ctx as { get?: (name: string) => unknown }).get?.('systemPrompt');
        probeSink.write(
          `${JSON.stringify({
            schema: 0,
            kind: 'service-probe',
            service: svc === undefined ? 'absent' : typeof svc,
            methods:
              svc === null || typeof svc !== 'object'
                ? []
                : Object.getOwnPropertyNames(Object.getPrototypeOf(svc)).slice(0, 40),
            assemblyKeys: (() => {
              try {
                const built = (svc as { assemble?: () => unknown }).assemble?.();
                return built === null || typeof built !== 'object' ? typeof built : Object.keys(built as object).slice(0, 20);
              } catch (err) {
                return `threw:${String(err)}`;
              }
            })(),
            assemblyPreview: (() => {
              try {
                const built = (svc as { assemble?: () => unknown }).assemble?.() as { text?: unknown; prompt?: unknown } | undefined;
                const text = typeof built?.text === 'string' ? built.text : typeof built?.prompt === 'string' ? built.prompt : undefined;
                return text === undefined ? 'none' : text.slice(0, 160);
              } catch {
                return 'threw';
              }
            })(),
          })}
`,
        );
      } catch (err) {
        probeSink.write(`${JSON.stringify({ schema: 0, kind: 'service-probe', service: 'threw', error: String(err) })}
`);
      }
    }
    const sink = createControlSink({
      path: resolveTelemetryPath(resolved.telemetry.controlJsonl),
      onError: (message) => ctx.logger?.warn?.(`[s1cap] control sink: ${message}`),
    });
    const controlLog = new ControlPlaneLog((line) => sink.write(line));
    // One System-1 call per new segment, scoring the whole window. Absent when no backend is configured, and
    // that absence is the point: the graph then scores lexically, which is what keeps observation mode free,
    // offline and deterministic. A configured backend that fails answers `undefined` and degrades the same way.
    const relevance =
      client === undefined
        ? undefined
        : createS1Relevance({
            decide: (state, questions) => client.decide(state, questions),
            questionsPerCall: config.s1.questionsPerCall,
            onWarn: (message) => ctx.logger?.warn?.(message),
          });
    if (relevance !== undefined) {
      ctx.logger?.info?.(
        `[s1cap] relevance: S1 batch scoring active (${describeS1Backend(backend)}, up to ${config.s1.questionsPerCall} candidates per call)`,
      );
    }
    // The plan gate scores the model's own candidate plans with a choice question. It is advisory: the order is
    // computed and recorded, and nothing in this plugin feeds it back into a prompt or a stop decision. The gate
    // only runs when a System-1 backend exists, since without one it would just return the model's own order.
    const planGate =
      client === undefined
        ? undefined
        : createPlanGate(
            { policy: config, emit: (event) => controlLog.emit(event), onWarn: (m) => ctx.logger?.warn?.(m) },
            (state, questions) => client.decide(state, questions),
          );
    observer = createStepObserver({
      policy: config,
      ...(relevance !== undefined ? { scoreBatch: relevance } : {}),
      ...(planGate !== undefined ? { planGate } : {}),
      emit: (event) => {
        try {
          controlLog.emit(event);
        } catch (err) {
          // I4 in reverse: a session segment must never reach the control-plane log.
          ctx.logger?.warn?.(`[s1cap] control record rejected: ${String(err)}`);
        }
      },
      now: () => Date.now(),
      contextWindow: CONTEXT_WINDOW_DEFAULT,
      reserveOutputTokens: RESERVE_OUTPUT_DEFAULT,
      fixedOverheadTokens: FIXED_OVERHEAD_DEFAULT,
      lambdaMs: DECAY_LAMBDA_MS,
      maxLagTurns: config.rgMaintenance.maxLagTurns,
      onWarn: (message) => ctx.logger?.warn?.(`[s1cap] ${message}`),
      onObserved: (summary) => ctx.logger?.info?.(`[s1cap] observed ${summary}`),
      // The upkeep queue is what folds the session-event stream into the association graph, and the queue
      // only drains when something asks it to. Nothing did: `schedule` was left out, so the queue filled and
      // was never flushed outside tests, and the graph stayed empty for the whole run. That is the second
      // half of why every live recall count read zero. The tick is deferred (setTimeout, unref'd) so upkeep
      // never runs on the critical path of a step, and the unref keeps it from holding the process open.
      schedule: (tick) => {
        const timer = setTimeout(tick, 0);
        if (typeof (timer as { unref?: () => void }).unref === 'function') (timer as { unref: () => void }).unref();
      },
      onProbe: (line) => probeSink?.write(`
`),
      ...(resolved.observation === 'tape'
        ? {
            onTape: (step: number, messages: readonly unknown[], systemPrompt: string | undefined) => {
              tapeSink?.write(
                `${JSON.stringify({ schema: 1, sessionId: 'live', step, ...(systemPrompt !== undefined ? { systemPrompt } : {}), messages })}\n`,
              );
            },
          }
        : {}),
    });
    ctx.logger?.info?.(`[s1cap] observation mode: ${resolved.observation} -> ${resolveTelemetryPath(resolved.telemetry.controlJsonl)}${resolved.observation === 'tape' ? ` + tape ${resolveTelemetryPath(resolved.telemetry.tapeJsonl)}` : ''} (prompt untouched)`);


    // The service lookup happens inside the thunk, not here: at activation time the systemPrompt service may
    // not be provided yet, so it is resolved on the first step instead (see preStepMiddleware).
    primeOnce = async () => {
      // N4 host half, first step: ask the credential service for the key the user is meant to type into the
      // settings panel. The read is written to the tape either way, so the next real round names the entry
      // point that actually answers instead of us guessing one.
      const credential = await readCredential({
        ref: CREDENTIAL_REF,
        service: (ctx as { get?: (name: string) => unknown }).get?.('credentials'),
        report: (line) => probeSink?.write(JSON.stringify(line) + '\n'),
      });
      if (credential.key !== undefined) {
        credentialKey = credential.key;
        credentialSource = `credentials:${credential.method ?? 'unknown'}`;
      }
      // The two recall knobs the panel owns: BFS depth d (int > 0) and relevance threshold r (0..1). Applied to
      // the live policy object before the first observation, so the whole session runs at the stored values.
      const tuningRead = await readCredential({
        ref: TUNING_REF,
        service: (ctx as { get?: (name: string) => unknown }).get?.('credentials'),
        report: (line) => probeSink?.write(JSON.stringify({ ...line, kind: 'credential-tuning' }) + '\n'),
      });
      appliedTuning = parseTuning(tuningRead.key);
      const fromFile = readTuningFile();
      if (fromFile.depth !== undefined) appliedTuning.depth = fromFile.depth;
      if (fromFile.relevanceThreshold !== undefined) appliedTuning.relevanceThreshold = fromFile.relevanceThreshold;
      if (fromFile.window !== undefined) appliedTuning.window = fromFile.window;
      if (fromFile.xFirst !== undefined) appliedTuning.xFirst = fromFile.xFirst;
      if (appliedTuning.depth !== undefined) config.recall.depth = appliedTuning.depth;
      if (appliedTuning.relevanceThreshold !== undefined) config.recall.relevanceThreshold = appliedTuning.relevanceThreshold;
      if (appliedTuning.window !== undefined) config.recall.window = appliedTuning.window;
      if (appliedTuning.xFirst !== undefined) config.xFirst = appliedTuning.xFirst;
      probeSink?.write(JSON.stringify({ schema: 0, kind: 'tuning-file', read: fromFile, effective: { depth: config.recall.depth, relevanceThreshold: config.recall.relevanceThreshold, window: config.recall.window, xFirst: config.xFirst } }) + '\n');
      await primeSystemPrompt({
        service: (ctx as { get?: (name: string) => unknown }).get?.('systemPrompt'),
        observer,
        onText: (text, tokens) => observer.setSystemPrompt(text, tokens),
        write: (line) => probeSink?.write(line),
        onWarn: (message) => ctx.logger?.warn?.(`[s1cap] ${message}`),
      });
    };

    // A live-config edit should not need a restart: when the loader reports a volatile update, re-read the tuning
    // store and re-apply it to the live policy. Registered before the pre-step middleware on purpose - the
    // subscription order is part of what the plugin tests pin. The handler is wrapped: an event that never fires
    // costs nothing, and a throw would take the harness down with it.
    ctx.on('loader/volatile-update', () => {
      try {
        const reread = readTuningFile();
        if (reread.depth !== undefined) config.recall.depth = reread.depth;
        if (reread.relevanceThreshold !== undefined) config.recall.relevanceThreshold = reread.relevanceThreshold;
        if (reread.window !== undefined) config.recall.window = reread.window;
        appliedTuning = { ...appliedTuning, ...reread };
      } catch (err) {
        ctx.logger?.warn?.(`[s1cap] volatile update ignored: ${String(err)}`);
      }
    });
    // Wire the lane that was registered at the top of applyInner: hand it the observer, the tape sink, and the
    // events that arrived before either existed.
    activeObserver = observer;
    probeOut = (line) => probeSink?.write(line);
    for (const early of earlySessionEvents.splice(0)) observer.noteSessionEvent(early);
    observer.probe({ schema: 0, kind: 'session-subscribed', drained: earlySessionEvents.length });
  } else {
    ctx.logger?.info?.('[s1cap] observation mode: off');
  }

  // The only lifecycle hook we register, in the verified middleware shape. `agent/request-error`
  // is deliberately NOT registered: its contract is unverified, and an unverified hook is exactly
  // what took a round down before.
  ctx.on('agent/pre-step', preStepMiddleware(ctx, observer, priming));

  // The `/s1` surface. Registration follows the verified Cordis shape:
  // is ctx.effect(() => ctx.commands.register({ name, description, input, handler })) - all verified
  // `/s1 status` never prints the API key: the resolved backend goes through redactKey().
  /**
   * One place that turns parsed knobs into effect: merge into what is stored, apply to the live policy, persist, and
   * answer with the effective triple. The `/s1-tune` command and the panel's Save button share it, so the command
   * line and the button cannot drift apart in what they accept or what they report.
 */
  const applyTuning = (parsed: Tuning): { ok: boolean; reason?: string; effective?: Tuning; persisted?: boolean; persistError?: string } => {
    if (
      parsed.depth === undefined &&
      parsed.relevanceThreshold === undefined &&
      parsed.window === undefined &&
      parsed.xFirst === undefined
    ) {
      return {
        ok: false,
        reason:
          'nothing to set: depth d must be an integer > 0, threshold r between 0 and 1, window w an integer >= 64, xFirst on/off',
      };
    }
    appliedTuning = { ...appliedTuning, ...parsed };
    if (parsed.depth !== undefined) config.recall.depth = parsed.depth;
    if (parsed.relevanceThreshold !== undefined) config.recall.relevanceThreshold = parsed.relevanceThreshold;
    if (parsed.window !== undefined) config.recall.window = parsed.window;
    if (parsed.xFirst !== undefined) config.xFirst = parsed.xFirst;
    const persist = writeTuningFile(appliedTuning);
    const persisted = persist.ok;
    ctx.logger?.info?.(
      `[s1cap] recall tuning: depth=${config.recall.depth} relevanceThreshold=${config.recall.relevanceThreshold} window=${config.recall.window} xFirst=${String(config.xFirst)}${persisted ? '' : ' (not persisted: file write failed)'}`,
    );
    return {
      ok: true,
      effective: {
        depth: config.recall.depth,
        relevanceThreshold: config.recall.relevanceThreshold,
        window: config.recall.window,
        xFirst: config.xFirst,
      },
      persisted,
      ...(persist.ok ? {} : { persistError: persist.error }),
    };
  };
  registerCommands(ctx, [
    {
      name: 's1-tune',
      description: 'S1CAP: set the recall/layout knobs — BFS depth d, relevance threshold r (0..1), S1 window w (>= 64), xFirst on/off',
      input: { hint: 'd r w xFirst   (e.g. "3 0.7 512 on", or "d=3", "r=0.7", "w=512", "xFirst=off")' },
      handler: ({ rawInput }) => applyTuning(parseTuningArgs(rawInput)),
    },
    {
      name: 's1',
      description: 'S1CAP status: policy, resolved System-1 backend, Laya state, sinks',
      handler: () => {
        const status = {
          cell: config.cell,
          termination: config.termination,
          assemblyDeadlineMs: config.assemblyDeadlineMs,
          rgMaintenance: config.rgMaintenance,
          cache: config.cache,
          tas: config.tas,
          recall: config.recall,
          tuning: {
            stored: appliedTuning,
            effective: {
              depth: config.recall.depth,
              relevanceThreshold: config.recall.relevanceThreshold,
              window: config.recall.window,
              xFirst: config.xFirst,
            },
            keySource: credentialSource,
          },
          tail: config.tail,
          xFirst: config.xFirst,
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
          observation: observer
            ? { mode: resolved.observation, sink: resolved.telemetry.controlJsonl, ...observer.stats() }
            : { mode: resolved.observation, steps: 0, observed: 0, skipped: 0, errors: 0 },
          telemetry: resolved.telemetry,
          configIssues: {
            errors: resolved.policy.errors.concat(resolved.laya.errors as Issue[]).map((i) => `${i.path}: ${i.message}`),
            warnings: resolved.policy.warnings.concat(resolved.laya.warnings as Issue[]).map((i) => `${i.path}: ${i.message}`),
            conflicts: resolved.conflicts,
            telemetry: resolved.telemetryErrors,
          },
        };
        ctx.logger?.info?.(`[s1cap] ${JSON.stringify(status, null, 2)}`);
        return status;
      },
    },
    {
      name: 's1-ping',
      description: 'S1CAP: probe the resolved System-1 backend (GET /health)',
      handler: async () => {
        if (!client) return { ok: false, reason: 'provider=none (no System-1 backend is active)' };
        const started = Date.now();
        const ok = await client.health();
        const result = { ok, baseUrl: backend.baseUrl, model: backend.model, ms: Date.now() - started };
        ctx.logger?.info?.(`[s1cap] ping ${ok ? 'ok' : 'unreachable'} ${String(backend.baseUrl)} in ${result.ms}ms`);
        return result;
      },
    },
    {
      name: 's1-laya',
      description: 'S1CAP Laya backend: discover | start | stop | status',
      input: { hint: 'discover | start | stop | status' },
      handler: async ({ rawInput }) => {
        const verb = (rawInput ?? '').trim().split(/\s+/)[0] ?? 'status';
        if (verb === 'discover') {
          const result = await runtime.discover();
          ctx.logger?.info?.(`[s1cap] laya discover: ${JSON.stringify(result, null, 2)}`);
          return result;
        }
        if (verb === 'start') {
          await runtime.start();
          const state = runtime.summary();
          ctx.logger?.info?.(`[s1cap] laya start: ${JSON.stringify(state, null, 2)}`);
          return state;
        }
        if (verb === 'stop') {
          await runtime.stop();
          const state = runtime.summary();
          ctx.logger?.info?.(`[s1cap] laya stop: ${JSON.stringify(state, null, 2)}`);
          return state;
        }
        const state = runtime.summary();
        ctx.logger?.info?.(
          `[s1cap] laya status: ${state.status}${state.pythonPath ? ` (python: ${state.pythonPath})` : ''}${state.error ? ` - ${state.error}` : ''}${state.logLines ? ` [${state.logLines} diagnostic lines buffered]` : ''}`,
        );
        return state;
      },
    },
  ]);
  /**
   * The panel's Save button, the way `dsh-pet` does it: the host half registers a prefixed HTTP route on the same
   * web server that serves the UI, and the client half is a plain relative `fetch`. That is deliberately chosen over
   * writing through a settings namespace or a credential ref - both need declarations this out-of-tree plugin cannot
   * make (docs/STATUS.md rounds 33-41) - while the route needs nothing beyond the service the UI already runs on.
   *
   * GET returns the stored and effective triples, so the panel can fill itself from the host instead of guessing.
   * PUT takes the same text the command line takes ("3 0.7 512", or d=/r=/w=) and answers with the effective
   * triple, so a successful Save is proven by the response body rather than by the absence of an error.
 */
  // Apply the stored knobs at activation, not only at the first step of a session. Waiting for that first step
  // meant a freshly loaded profile answered /s1 and the panel with the built-in defaults while the file on disk
  // already held other values - the panel looked unconfigured next to a configuration about to be used.
  {
    const storedNow = readTuningFile();
    appliedTuning = { ...appliedTuning, ...storedNow };
    if (storedNow.depth !== undefined) config.recall.depth = storedNow.depth;
    if (storedNow.relevanceThreshold !== undefined) config.recall.relevanceThreshold = storedNow.relevanceThreshold;
    if (storedNow.window !== undefined) config.recall.window = storedNow.window;
    if (storedNow.xFirst !== undefined) config.xFirst = storedNow.xFirst;
  }

  const webServer = findService<{ register: (spec: unknown) => void }>(ctx, 'webServer');
  if (webServer !== undefined) {
    const registerRoute = (): void => {
      webServer.register({
        kind: 'prefix',
        path: TUNING_ROUTE,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          try {
            const method = (req.method ?? 'GET').toUpperCase();
            if (method === 'GET') {
              sendJson(res, 200, {
                ok: true,
                stored: { ...readTuningFile(), ...appliedTuning },
                effective: {
                  depth: config.recall.depth,
                  relevanceThreshold: config.recall.relevanceThreshold,
                  window: config.recall.window,
                  xFirst: config.xFirst,
                },
              });
              return;
            }
            if (method !== 'PUT' && method !== 'POST') {
              sendJson(res, 405, { ok: false, reason: 'use GET to read, PUT to write' });
              return;
            }
            const parsed = parseTuningArgs(await readRequestBody(req));
            const result = applyTuning(parsed);
            sendJson(res, result.ok ? 200 : 400, result);
          } catch (e) {
            sendJson(res, 500, { ok: false, reason: e instanceof Error ? e.message : String(e) });
          }
        },
      });
    };
    if (typeof ctx.effect === 'function') ctx.effect(registerRoute);
    else registerRoute();
  } else {
    ctx.logger?.warn?.('[s1cap] no web server service in this profile - the panel Save button stays disabled; /s1-tune still works');
  }
}
