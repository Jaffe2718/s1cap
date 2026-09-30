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
                                                                                                                         
import { defaultPolicy, validatePolicy, TELEMETRY_SCHEMA_VERSION } from '@s1cap/core';
                                                                      
import {
  DEFAULT_WEIGHTS_CACHE_DIR,
  LayaServer,
  createNodeDiscoveryDeps,
  createNodeLaunchDeps,
  defaultLayaConfig,
  discoverLayaPython,
  installHint,
  layaBaseUrl,
  validateLayaConfig,
  weightsCacheDir,
  weightsEnvVar,
} from '@s1cap/laya-runtime';
import { S1Client, describeS1Backend, redactKey, resolveS1Backend, singleBackendIssues } from '@s1cap/s1-client';
                                                          
import { ControlPlaneLog, createRgFileStore } from '@s1cap/core';
import { createControlSink, resolveTelemetryPath } from './control-log.js';
import { deliverContext } from './context-delivery.js';
                                                                   
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { primeSystemPrompt } from './system-prompt.js';
                                                                 
import { TUNING_REF, parseEnvName, parsePath, parseProvider, parseTuning, parseTuningArgs, readCredential } from './credentials.js';
                                               
import { createStepObserver } from './step-observer.js';
                                                       
import { createS1Relevance } from './s1-relevance.js';
import { createPlanGate } from './plan-gate-runtime.js';

                                                           
                                                                                               
   
                    
     
                                                                                                         
                                                                                                   
                                                                                                      
   
                                       
     
                                                                                       
                                                                                 
                                                          
   
                                                                                   
                    
 

                                 
                       
                       
                                                                                   
   
                    
 

export const DEFAULT_TELEMETRY                 = {
  sessionJsonl: './.s1cap/session.jsonl',
  controlJsonl: './.s1cap/control.jsonl',
  tapeJsonl: './.s1cap/tape.jsonl',
};

                                       
                            
                           
                       
                            
                                                                                    
   
                      
                            
                                                                            
   
                                      
                              
 

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
export function resolvePluginConfig(raw                             )                       {
  const source = (raw ?? {})                           ;
  const policy = validatePolicy(source, ['laya', 'telemetry', 'enabled', 'observation']);
  const laya = validateLayaConfig(source.laya);

  const telemetryErrors           = [];
  const telemetry                 = { ...DEFAULT_TELEMETRY };
  const rawTelemetry = (source.telemetry ?? {})                           ;  for (const key of ['sessionJsonl', 'controlJsonl']         ) {
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
  }                     ;

  // Observation mode is validated here (not in core): it is a plugin-level switch, not part of the
  // frozen assembly policy. Fail-safe like everything else — an unknown value keeps the default.
  const observationErrors           = [];
  let observation                         = 'log';
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
export function resolveConfig(raw                             )                    {
  return resolvePluginConfig(raw).config;
}

/** Minimal structural shape of the Cordis plugin context we rely on (verified against DSH 0.1.7-rc.2).
 */
                              
               
                      
                           
                                                   
 

/**
 * The host's `CommandResult`, read from `@deepseek-ai/dsh-commands` (`normalizeResult`).
 *
 * This is not optional and not a convention: the registry validates the handler's return value and throws
 * `command "<name>" handler must return a CommandResult` if it is not one of these two shapes. Every `/s1*`
 * command returned a plain object, so every one of them failed at the boundary — the status was computed, the
 * log line was written, and the user saw an error instead of the answer. `text` is the only channel a result has,
 * so anything worth reading goes there.
 */
export function commandSuccess(text        )                                    {
  return { kind: 'success', text };
}

/** An error result must carry non-empty text; the registry rejects an empty one. */
export function commandError(text        )                                  {
  return { kind: 'error', text: text.trim() === '' ? 'no reason given' : text };
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
function registerCommands(ctx               , specs               )           {
  const registered           = [];
  if (typeof ctx.commands?.register !== 'function') {
    ctx.logger?.warn?.('[s1cap] command service unavailable in this profile — /s1 commands disabled');
    return registered;
  }
  for (const spec of specs) {
    const register = ()       => {
      ctx.commands?.register?.(spec);
      registered.push(spec.name);
    };
    if (typeof ctx.effect === 'function') ctx.effect(register);
    else register();
    ctx.logger?.info?.(`[s1cap] command registered: /${spec.name}`);
  }
  return registered;
}

                                   
                                                      
                  
                      
                 
     
                                                                                
    
                                                                                                                
                                                                                                                
                                                                                                                
                                                                                  
     
                                                 
                          
 

/**
 * Resolve the interpreter, start `laya-serve` when configured, and expose the state
 * the settings surface renders. Returns a handle so the plugin (or a UI panel) can
 * stop the server and re-run discovery.
 */
export class LayaRuntime {
  #config            ;
  #server            ;
  #pythonPath         ;
  #error         ;

  constructor(config            ) {
    this.#config = config;
    this.#server = new LayaServer(config, createNodeLaunchDeps());
  }

  /** `discover` only probes interpreters; `start` also spawns the server.
 */
  async discover()                                                                                    {
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

  async start()                            {
    const discovered = await this.discover();
    if (!discovered.hasLaya || !discovered.pythonPath) {
      return this.state();
    }
    await this.#server.start(discovered.pythonPath);
    if (this.#server.status !== 'ready') this.#error = this.#server.error;
    return this.state();
  }

  async stop()                            {
    await this.#server.stop();
    return this.state();
  }

  state()                   {
    return {
      status: this.#server.status,
      baseUrl: layaBaseUrl(this.#config),
      ...(this.#pythonPath ? { pythonPath: this.#pythonPath } : {}),
      ...(this.#error ?? this.#server.error ? { error: this.#error ?? this.#server.error } : {}),
      weights: { cacheDir: weightsCacheDir(this.#config), envVar: weightsEnvVar(this.#config) },
      logs: this.#server.logs,
    };
  }

  /**
   * Compact status for the command surface (docs/CONTROL_PLANE_LOGGING.md §5): the
   * backend's raw stdout/stderr stays a bounded diagnostic buffer and is never handed
   * to the agent as command output, so it cannot become a session segment.
   *
   * The last few lines ride along, and that is a change forced by a failed launch: the buffer held 50 lines and
   * this function reported `logLines: 50`, so a start that died told the reader *how much* had been said and none
   * of *what*. Diagnosing it meant reproducing the spawn outside the host to get the same text by hand. The bound
   * is deliberate — this is a status line, not a log dump — and it is the tail, because that is where a Python
   * traceback ends.
 */
  summary(tailLines         )                                                                           {
    const { logs, ...rest } = this.state();
    // A backend that is not ready gets the whole buffer, up to a bound. The tail-only version was the second
    // version: the first reported a count, and when the failure finally became readable it was the *end* of a
    // Python traceback that mattered — the network error and the file it was fetching are at the top, and a
    // twelve-line tail of a fifty-line buffer is exactly the part that does not say why.
    const bound = tailLines ?? (rest.status === 'ready' ? 12 : 64);
    return { ...rest, logLines: logs.length, logTail: logs.slice(-bound) };
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
let primeOnce                                   ;

/**
 * Where the System-1 credential lives. The settings panel writes `<scope>/<id>`, and the host reads it back
 * through the credentials service when the config leaves `s1.apiKey` empty (env vars remain the headless
 * fallback). The key itself is only ever surfaced through `redactKey()`.
 */
const CREDENTIAL_REF = 's1cap/jev';
let credentialKey                    ;
let credentialSource = 'config-or-env';
/** recall tuning the panel stored, applied to the live policy at session start
 */
let appliedTuning         = {};
/** the plugin's own store for the two recall knobs; relative paths resolve against DSH_HOME
 */
const TUNING_FILE = './.s1cap/tuning.json';

/** the panel's Save route: a prefix on the same server that serves the UI, following dsh-pet's /dsh-pet-7340
 */
const TUNING_ROUTE = '/s1cap-7340';

export function readTuningFile()         {
  try {
    const raw = readFileSync(resolveTelemetryPath(TUNING_FILE), 'utf8');
    const parsed = JSON.parse(raw)                           ;
    const out         = {};
    if (typeof parsed.depth === 'number' && Number.isInteger(parsed.depth) && parsed.depth > 0) out.depth = parsed.depth;
    // A file written before the rename still carries the old key: read either, so an upgrade does not silently
    // drop a researcher's stored threshold.
    const threshold = typeof parsed.relevanceThreshold === 'number' ? parsed.relevanceThreshold : (parsed                         ).releTao;
    if (typeof threshold === 'number' && threshold >= 0 && threshold <= 1) out.relevanceThreshold = threshold;
    if (typeof parsed.window === 'number' && Number.isInteger(parsed.window) && parsed.window >= 64) out.window = parsed.window;
    // The bounded anchor wait, read back through the same bounds `parseTuningArgs` applies (0 disables it). The
    // asymmetry with the HTTP route is deliberate: the route answers 400 for a truncated or over-long wait, and this
    // reader - which reads a file a previous version of this plugin may have written - falls back to the default.
    if (
      typeof parsed.anchorWaitMs === 'number' &&
      Number.isInteger(parsed.anchorWaitMs) &&
      parsed.anchorWaitMs >= 0 &&
      parsed.anchorWaitMs <= 60_000
    ) {
      out.anchorWaitMs = parsed.anchorWaitMs;
    }
    // `false` is a real value here, not an absence, so this tests the type rather than truthiness. The first
    // version omitted the field from this reader entirely, so the panel wrote it, the route echoed it back from
    // the in-memory copy, and the layout stayed on its default - a stored setting that looked saved everywhere
    // except in the prompt it was supposed to change.
    if (typeof parsed.xFirst === 'boolean') out.xFirst = parsed.xFirst;
    // The Laya fields, read through the same validators the command line uses. A live run found the gap this
    // closes: the panel wrote an interpreter path, the route echoed it back from the in-memory copy, and the
    // session still came up `provider=none` for a missing path — the write half existed and the read half did
    // not, which is the identical shape to the xFirst bug above and just as invisible from the outside.
    const pythonPath = parsePath(typeof parsed.layaPythonPath === 'string' ? parsed.layaPythonPath : undefined);
    if (pythonPath !== undefined) out.layaPythonPath = pythonPath;
    const cacheDir = parsePath(typeof parsed.layaWeightsCacheDir === 'string' ? parsed.layaWeightsCacheDir : undefined);
    if (cacheDir !== undefined) out.layaWeightsCacheDir = cacheDir;
    const envVar = parseEnvName(typeof parsed.layaWeightsEnvVar === 'string' ? parsed.layaWeightsEnvVar : undefined);
    if (envVar !== undefined) out.layaWeightsEnvVar = envVar;
    // The backend the radio selected, read through the same validator the command line uses. Without this reader
    // the write half would be complete and the read half missing — the exact shape of the xFirst and Laya gaps
    // above: the panel writes `laya-serve`, the file holds it, and the next start comes up on the profile's
    // provider with the radio showing something else.
    const provider = parseProvider(typeof parsed.provider === 'string' ? parsed.provider : undefined);
    if (provider !== undefined) out.provider = provider;
    return out;
  } catch {
    return {};
  }
}

/**
 * Persist the knobs. The failure reason is returned rather than swallowed: a Save that reports "not persisted"
 * without saying why is the same silent-failure shape this project keeps rejecting, and the panel prints it.
 */
function writeTuningFile(values        )                                  {
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
function readRequestBody(req                 )                  {
  return new Promise((resolve, reject) => {
    let text = '';
    req.setEncoding?.('utf8');
    req.on('data', (chunk        ) => {
      text += chunk;
      if (text.length > 4096) reject(new Error('request body too large'));
    });
    req.on('end', () => resolve(text));
    req.on('error', reject);
  });
}
function sendJson(res                , status        , obj         )       {
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
let activeObserver                          ;
let probeOut                                      ;
/** events that arrive before observation is wired (bounded; drained once the observer exists)
 */
const earlySessionEvents            = [];
const EARLY_EVENT_LIMIT = 16;

/**
 * A narrow check for "this payload is an object I can read fields from".
 *
 * The pre-step payload is untyped here on purpose: its shape is read out of the packaged harness, and this is
 * where the two fields delivery depends on (`messages` and `step`) are pulled from it. A wrong guess about the
 * payload must cost a skip and a recorded reason, never a crash inside the loop.
 */
function isRecord(value         )                                   {
  return typeof value === 'object' && value !== null;
}

                                 
                          
                                                                                                                  
                    
                                                                                                            
                                                                                                               
                                                                                                  
     
                                                                                                                    
                                    
 

export function preStepMiddleware(
  ctx               ,
  /**
   * Delivery options, or a bare observer (the shape this function had before delivery existed). The legacy form
   * is still accepted and means "observe and report, change nothing" — so an existing caller keeps its exact
   * previous behaviour instead of silently gaining an intervention it never asked for.
   */
  optionsOrObserver                                ,
)                                                                       {
  const options                             =
    optionsOrObserver === undefined
      ? undefined
      : 'observe' in optionsOrObserver
        ? undefined
        : optionsOrObserver;
  const observer                           =
    optionsOrObserver !== undefined && 'observe' in optionsOrObserver ? optionsOrObserver : options?.observer;
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
    let observation                             ;
    try {
      // Segment, recall and assemble for real, and record the result in the control plane. `observe()` never
      // throws, and neither does this catch: a failed observation costs the record, never the step.
      observation = await observer?.observe(payload);
    } catch (err) {
      ctx.logger?.warn?.(`[s1cap] pre-step observation failed (ignored): ${String(err)}`);
    }

    // Context delivery - the step where an assembled layout becomes what the model is shown.
    //
    // The first three guards are the harness's own, read out of the packaged `dsh-agent` source rather than
    // assumed: a rejected or aborted decision goes back exactly as it arrived, and a decision without messages
    // has nothing to rewrite. Everything after them is ours, and every failure in it returns the untouched
    // decision: the failure mode of the intervention is that it does not happen, never a broken round.
    if (options === undefined || observation === undefined) return decision;
    const record = decision                                                                          ;
    const before = Array.isArray(record.messages) ? record.messages.length : 0;
    const report = (delivered         , reason        , extra                          = {})       => {
      try {
        options.emit({
          type: 'context_delivery',
          schema: TELEMETRY_SCHEMA_VERSION,
          ts: Date.now(),
          ...(typeof observation?.event.sessionId === 'string' ? { sessionId: observation.event.sessionId } : {}),
          cell: options.cell,
          delivered,
          reason,
          messagesBefore: before,
          messagesAfter: before,
          kept: 0,
          dropped: 0,
          inserted: 0,
          blocks: [],
          payloadId: '',
          order: observation?.layout.order ?? [],
          ...extra,
        }                  );
      } catch (err) {
        ctx.logger?.warn?.(`[s1cap] context_delivery record rejected: ${String(err)}`);
      }
    };
    if (record.kind === 'reject' || record.signal?.aborted === true || !Array.isArray(record.messages)) {
      report(
        false,
        record.kind === 'reject'
          ? 'the step was rejected, so the decision passes through unchanged'
          : record.signal?.aborted === true
            ? 'the step was aborted, so the decision passes through unchanged'
            : 'the decision carried no messages to rewrite',
      );
      return decision;
    }
    try {
      const result = options.deliver(observation, decision                           , payload);
      if (!result.delivered || result.messages === null) {
        report(false, result.reason, { blocks: result.blocks, order: observation.layout.order });
        return decision;
      }
      report(true, result.reason, {
        messagesAfter: result.messages.length,
        kept: result.kept,
        // `dropped` is reported as the harness's own number rather than a hard zero: if a future change ever
        // removed a message here, the record would have to change with it, and a record that cannot be wrong is
        // a record nobody reads.
        dropped: result.dropped,
        inserted: result.inserted,
        blocks: result.blocks,
        payloadId: result.payloadId,
        order: observation.layout.order,
      });
      return { ...(decision                           ), messages: result.messages };
    } catch (err) {
      // Worth a warning: it means the intervention silently did not happen for this step, which is the failure
      // this whole file exists to make impossible to miss.
      ctx.logger?.warn?.(`[s1cap] context delivery failed (decision passed through unchanged): ${String(err)}`);
      return decision;
    }
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
function findService   (ctx               , name        )                {
  try {
    const registry = (ctx                                                                  ).registry;
    if (typeof registry?.values !== 'function') return undefined;
    for (const runtime of registry.values()) {
      const fibers = (runtime                                  ).fibers ?? [];
      for (const fiber of fibers) {
        const impl = (fiber                                             ).store?.[name];
        if (impl?.value !== undefined) return impl.value;
        try {
          const value = (fiber                               ).ctx?.[name];
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

export function apply(ctx               , raw                             )       {
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

function applyInner(ctx               , raw                             )       {
  const source = (raw ?? {})                           ;
  if (source.enabled !== true) {
    ctx.logger?.info?.('[s1cap] not enabled (config.enabled !== true) — inert: no hooks, no commands, no System-1 calls');
    return;
  }
  // First registration, before anything that can throw, and before the observer exists: events that arrive
  // early are buffered (bounded) and drained once observation is wired. The marker proves delivery, which is
  // the difference between "the hook name is wrong" and "this profile emits nothing during the run".
  ctx.on('session/event', (_session         , event         ) => {
    probeOut?.(
      JSON.stringify({
        schema: 0,
        kind: 'session-event',
        type: (event                             )?.type ?? typeof event,
      }) + '\n',
    );
    if (activeObserver !== undefined) activeObserver.noteSessionEvent(event);
    else if (earlySessionEvents.length < EARLY_EVENT_LIMIT) earlySessionEvents.push(event);
  });

  const resolved = resolvePluginConfig(raw);
  const config = resolved.config;
  const layaConfig = config.laya ?? defaultLayaConfig();
  // The checkpoint cache is anchored, not relative. `./.s1cap/laya-cache` resolves against whatever directory the
  // host happens to have as its working directory, so the same profile put the weights in one place when a person
  // ran the backend by hand and in another when the plugin started it - and the second one re-downloaded a 421M
  // checkpoint, or failed trying, while both runs reported the same configuration. Anchored against DSH_HOME it is
  // the same directory every time, and it is the same directory the telemetry paths already use. A path the user
  // supplied is left exactly as they wrote it, relative or not.
  if (layaConfig.weightsCacheDir === undefined || layaConfig.weightsCacheDir === DEFAULT_WEIGHTS_CACHE_DIR) {
    layaConfig.weightsCacheDir = resolveTelemetryPath('./.s1cap/laya-cache');
  }
  const runtime = new LayaRuntime(layaConfig);

  for (const issue of resolved.policy.warnings) ctx.logger?.warn(`[s1cap] config ${issue.path}: ${issue.message}`);
  for (const issue of resolved.laya.warnings) ctx.logger?.warn(`[s1cap] config ${issue.path}: ${issue.message}`);
  for (const issue of [...resolved.policy.errors, ...resolved.laya.errors]           ) {
    ctx.logger?.warn(`[s1cap] config ${issue.path}: ${issue.message} (default kept)`);
  }
  for (const message of resolved.telemetryErrors) ctx.logger?.warn(`[s1cap] config telemetry: ${message}`);
  for (const message of resolved.observationErrors) ctx.logger?.warn(`[s1cap] config observation: ${message}`);

  // One S1 backend at a time (docs/AGENT_BRIEF.md §0.9). A conflict is reported and the session
  // degrades to observation mode rather than silently picking a governor.
  for (const conflict of resolved.conflicts) ctx.logger?.warn(`[s1cap] ${conflict}`);
  // Re-resolvable, because the panel's Laya fields are read on the first step rather than at activation (the
  // interpreter must be in place before the first observation, and the host may not have the credential service
  // yet when it activates a plugin). A session that started with an empty path therefore *resolves* the conflict
  // on step one — and with these as plain consts it kept the `none` backend it was built with, so the conflict
  // cleared in `/s1` while the session still made no System-1 calls at all. A live run with the panel's value
  // arriving on step one is what exposed it: conflicts none, calls zero.
  const buildBackend = ()                                                               => {
    const backend                    = resolveS1Backend(
      resolved.conflicts.length > 0 ? { ...config.s1, provider: 'none' } : config.s1,
      layaConfig,
    );
    const client =
      backend.mode !== 'none' && backend.baseUrl
        ? new S1Client({
            baseUrl: backend.baseUrl,
            ...(backend.apiKey ? { apiKey: backend.apiKey } : {}),
            ...(backend.model ? { model: backend.model } : {}),
          })
        : undefined;
    return { backend, client };
  };
  const initial = buildBackend();
  let backend                    = initial.backend;
  let client                       = initial.client;

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
      .catch((err         ) => ctx.logger?.warn(`[s1cap] laya startup failed: ${String(err)}`));
  }

  // M1 observation mode. Real SEGMENTER + RECALL + ASSEMBLER on every LLM call, recorded in the
  // control plane, with the prompt the model receives returned untouched — nothing here can change a
  // round. `off` skips it entirely. The context window comes from constants for now: `ctx.tokenMeter`'s
  // semantics are not verified yet, and a wrong window would silently distort every budget number.
  let observer                          ;
  /**
   * The two System-1 components, hoisted for the same reason `observer` is: they are constructed inside the
   * enabled-branch and reported by `/s1` outside it. A `const` in the inner block is correct at the construction
   * site and invisible to the status command, which is how a declared-and-constructed component can look present
   * in the log while the counter that would prove it ran cannot be printed.
   */
  let relevance                                                  ;
  let planGate                                               ;
  /**
   * Sink counters, closure-level so `/s1` can read them. This project's dominant failure is a component that is
   * constructed and wired but never actually fed - the block-scoped `sink`/`sessionSink` live inside the
   * observation branch and the status command cannot reach them, so the only way to tell "the session stream is
   * written" from "the session stream is declared" is a counter hoisted to where the command can print it. These
   * are incremented at the emit site, not at construction.
   */
  let controlRecords = 0;
  let sessionLines = 0;
  let s1CallRecords = 0;
  let s1CallFailures = 0;
  // The session the current System-1 call belongs to. Upkeep scores one session's events at a time and awaits
  // inside that work, so a scope variable set by the delegate that starts the call is read back by the record
  // the call produces; the alternative was threading an id through three layers of scorer that have no use for it.
  let s1SessionScope = 'unassigned';
  /**
   * The control log, hoisted out of the observation branch. `preStepMiddleware` is registered after that block
   * and has to write delivery records, and a block-scoped const would simply not be visible there — the same
   * "constructed where it cannot be reached" shape this project keeps meeting.
   */
  let controlLogRef                             ;
  /** one assemble() per session; awaited by the first pre-step call (a short round can exit before a fire-and-forget promise settles)
 */
  let priming                           ;
  if (resolved.observation !== 'off') {
    const probeSink =
      resolved.observation === 'tape'
        ? createControlSink({ path: resolveTelemetryPath(resolved.telemetry.tapeJsonl), onError: () => undefined })
        : undefined;
    if (probeSink !== undefined) {
      // One-shot introspection: the real method names of the systemPrompt service. Reading a service that
      // was not injected throws in Cordis, so both outcomes are written down instead of guessed at.
      try {
        const svc = (ctx                                       ).get?.('systemPrompt');
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
                const built = (svc                                ).assemble?.();
                return built === null || typeof built !== 'object' ? typeof built : Object.keys(built          ).slice(0, 20);
              } catch (err) {
                return `threw:${String(err)}`;
              }
            })(),
            assemblyPreview: (() => {
              try {
                const built = (svc                                ).assemble?.()                                                    ;
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
        const svc = (ctx                                       ).get?.('systemPrompt');
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
                const built = (svc                                ).assemble?.();
                return built === null || typeof built !== 'object' ? typeof built : Object.keys(built          ).slice(0, 20);
              } catch (err) {
                return `threw:${String(err)}`;
              }
            })(),
            assemblyPreview: (() => {
              try {
                const built = (svc                                ).assemble?.()                                                    ;
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
    // One association graph per session, in one file per session, under the same anchored directory the
    // weights cache uses. Two reasons, both measured rather than designed for:
    //  - the graphs were shared, so a "new chat" in the same host process started with the previous conversation
    //    in its recall candidates (269 segments read as one long session, and were in fact several);
    //  - the graphs were not written anywhere, so a restart threw away every pair the System-1 backend had been
    //    paid to score and the session scored them again.
    const rgStore = createRgFileStore({
      dir: resolveTelemetryPath('./.s1cap/rg'),
      onWarn: (message) => ctx.logger?.warn?.(message),
    });
    const sink = createControlSink({
      path: resolveTelemetryPath(resolved.telemetry.controlJsonl),
      onError: (message) => ctx.logger?.warn?.(`[s1cap] control sink: ${message}`),
    });
    const controlLog = new ControlPlaneLog((line) => {
      sink.write(line);
      controlRecords += 1;
    });
    controlLogRef = controlLog;
    // The session-content stream, the other file the two-stream config names. It is a separate sink object with
    // its own path because I4 forbids content and control records from ever sharing a file; resolvePluginConfig
    // already rejects identical paths. Declared-but-unwritten was the gap: a field pointing at a file no code
    // touched. Every adapted session event is written here as one JSONL line, and a broken sink costs a line,
    // never a round - the same containment the control sink uses.
    const sessionSink = createControlSink({
      path: resolveTelemetryPath(resolved.telemetry.sessionJsonl),
      onError: (message) => ctx.logger?.warn?.(`[s1cap] session sink: ${message}`),
    });
    // The `s1_call` cost record. Everything it carries is measured, not estimated: the client times the call
    // itself and normalizes `usage`, so ms and token counts are what the call actually cost. Emitted once per
    // successful backend call — a call that throws costs nothing and records nothing, matching the failure
    // policy everywhere else. A sink that throws must never take the scoring round down with it, so the emit
    // is wrapped; the telemetry is the thing under study, but it is still only a passenger in the harness.
    const recordS1Call = (
      role                     ,
      kind                     ,
      questions        ,
      result   
                                                                
                    
                       
                                                    
       ,
      sessionId        ,
    )       => {
      try {
        controlLog.emit({
          type: 's1_call',
          schema: TELEMETRY_SCHEMA_VERSION,
          ts: Date.now(),
          provider: config.s1.provider,
          // Which conversation paid for this call. Without it the log is a per-process pile, and a run that
          // mixed two sessions cannot be split apart afterwards.
          sessionId,
          role,
          kind,
          questions,
          inputTokens: result.usage?.input_tokens ?? 0,
          outputTokens: result.usage?.output_tokens ?? 0,
          ms: result.ms ?? 0,
          ok: true,
          ...(result.model !== undefined ? { routedModel: result.model } : {}),
          // The address and the checkpoint that answered, not the name this plugin was configured with: a stub
          // answering on the configured port calls itself `laya-serve` too, and only the server's own `routing`
          // block tells the two apart afterwards.
          ...(backend.baseUrl !== '' ? { endpoint: backend.baseUrl } : {}),
          ...(result.routing?.repo !== undefined ? { repo: result.routing.repo } : {}),
        });
        s1CallRecords += 1;
      } catch (err) {
        ctx.logger?.warn?.(`[s1cap] s1_call record rejected: ${String(err)}`);
      }
    };
    // A call that threw used to record nothing at all, which is how a session reached `s1CallRecords: 0` while
    // every score silently came from the lexical fallback: the failure existed only in a logger line this host
    // never shows. Recording it costs one line and turns "the backend is not being used" from an inference into
    // a measurement.
    const recordS1Failure = (
      role                     ,
      kind                     ,
      questions        ,
      err         ,
      sessionId        ,
    )       => {
      try {
        controlLog.emit({
          type: 's1_call',
          schema: TELEMETRY_SCHEMA_VERSION,
          ts: Date.now(),
          provider: config.s1.provider,
          sessionId,
          role,
          kind,
          questions,
          inputTokens: 0,
          outputTokens: 0,
          ms: 0,
          ok: false,
          error: String(err).slice(0, 300),
          ...(backend.baseUrl !== '' ? { endpoint: backend.baseUrl } : {}),
        });
        s1CallFailures += 1;
      } catch (nested) {
        ctx.logger?.warn?.(`[s1cap] s1_call failure record rejected: ${String(nested)}`);
      }
    };
    // One System-1 call per new segment, scoring the whole window. Both of these are built **unconditionally** and
    // read the current `client` at call time, rather than being built when a client happens to exist. The previous
    // shape — `client === undefined ? undefined : createS1Relevance(...)`, handed to the observer as a snapshot — is
    // what a real three-turn run exposed: the interpreter arrives on the first step and the backend is started by
    // hand after that, so `client` was defined by the time `/s1` reported it and `relevance` was `undefined` anyway.
    // The session then reported a working System-1 backend, scored 66 and 78 pairs, and every one of those scores
    // came from the lexical fallback, with `s1CallRecords: 0`. A delegate that answers `undefined` when there is no
    // client is the same thing the missing object meant, so behaviour is unchanged when nothing is configured —
    // `packages/core/src/assoc-graph.ts` treats an `undefined` batch as "score these lexically".
    relevance = createS1Relevance({
      decide: async (state, questions) => {
        if (client === undefined) return undefined;
        const count = Object.keys(questions).length;
        try {
          const result = await client.decide(state, questions);
          recordS1Call('assoc', 'noul', count, result, s1SessionScope);
          return result;
        } catch (err) {
          // Recorded, then **rethrown**. Returning `undefined` here looked like the same thing - the scorer below
          // turns either into "no weights, use the lexical fallback" - but it destroyed the reason: the scorer's
          // own catch received a `TypeError: cannot read properties of undefined (reading 'answers')` instead of
          // the `S1TimeoutError` that actually happened, so the one line a human reads named the wrong failure.
          // A cancelled caller is reported as a cancellation and is not a reason to re-score lexically; the
          // scorer treats it the same way only because a cancelled batch has no answer to keep.
          recordS1Failure('assoc', 'noul', count, err, s1SessionScope);
          throw err;
        }
      },
      questionsPerCall: config.s1.questionsPerCall,
      onWarn: (message) => ctx.logger?.warn?.(message),
    });
    if (client !== undefined) {
      ctx.logger?.info?.(
        `[s1cap] relevance: S1 batch scoring active (${describeS1Backend(backend)}, up to ${config.s1.questionsPerCall} candidates per call)`,
      );
    }
    // The plan gate scores the model's own candidate plans with a choice question. It is advisory: the order is
    // computed and recorded, and nothing in this plugin feeds it back into a prompt or a stop decision.
    planGate = createPlanGate(
      { policy: config, emit: (event) => controlLog.emit(event), onWarn: (m) => ctx.logger?.warn?.(m) },
      async (state, questions) => {
        if (client === undefined) return undefined;
        const count = Object.keys(questions).length;
        try {
          const result = await client.decide(state, questions);
          recordS1Call('decide', 'choice', count, result, s1SessionScope);
          return result;
        } catch (err) {
          recordS1Failure('decide', 'choice', count, err, s1SessionScope);
          return undefined;
        }
      },
    );
    observer = createStepObserver({
      policy: config,
      // Every session gets its own graph, and the graph is written to disk as it changes, so "start a new chat"
      // no longer inherits the previous conversation's recall candidates and a restart does not re-pay for
      // scoring the previous process had already bought.
      rgStore,
      scoreBatch: (state, candidates) => {
        // The candidates are segments, and segments know their session; the scoring that follows is theirs.
        s1SessionScope = candidates[0]?.sessionId ?? s1SessionScope;
        // `relevance` **is** the scorer: `createS1Relevance` returns the batch function itself and hangs `stats`
        // off it (`s1-relevance.ts`: `const relevance = scoreBatch as S1Relevance`). Calling `relevance.scoreBatch`
        // therefore threw `not a function` on every segment, the upkeep catch swallowed it, and the session
        // reported a healthy graph with zero edges, zero `scoredPairs` and zero System-1 calls. Nothing in the
        // toolchain could catch it: the build is type erasure (`stripTypeScriptTypes`) and `typescript` is not
        // installed, so a property that does not exist on the declared type ships silently.
        return relevance === undefined ? Promise.resolve(undefined) : relevance(state, candidates);
      },
      planGate: {
        consider: async (...args) => {
          s1SessionScope = String(args[1] ?? s1SessionScope);
          return planGate?.consider(...(args                                        ));
        },
        considerTodos: async (...args) => {
          s1SessionScope = String(args[1] ?? s1SessionScope);
          return planGate?.considerTodos(...(args                                             ));
        },
        stats: () => planGate?.stats() ?? null,
      },
      emit: (event) => {
        try {
          controlLog.emit(event);
        } catch (err) {
          // I4 in reverse: a session segment must never reach the control-plane log.
          ctx.logger?.warn?.(`[s1cap] control record rejected: ${String(err)}`);
        }
      },
      onSessionEvent: (event) => {
        sessionSink.write(JSON.stringify(event) + '\n');
        sessionLines += 1;
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
        if (typeof (timer                          ).unref === 'function') (timer                         ).unref();
      },
      // The anchor wait's clock, injected for the same reason `schedule` is: the observer keeps no timer of its own
      // (step-observer.ts header), and its tests must not sleep. This is the only place a real timer exists, so an
      // `anchorWaitMs` of 0 and a dead backend both cost the step nothing beyond this one option.
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      // The observer's diagnostic channel. This wrote a bare newline and dropped its argument, so every line the
      // observer tried to report - the session-event shapes, the early-buffer drain - went nowhere while the
      // tape still looked healthy, because the *other* probe sink (`probeOut`, used by the session/event hook)
      // was writing fine. Two channels, one of them silently dead, and the dead one was the one that would have
      // answered "which shapes actually arrive".
      onProbe: (line) => probeSink?.write(JSON.stringify(line) + '\n'),
      ...(resolved.observation === 'tape'
        ? {
            onTape: (step        , messages                    , systemPrompt                    ) => {
              tapeSink?.write(
                `${JSON.stringify({
                  schema: 1,
                  // The id of the session this step belongs to, read back from the observer that just saw it.
                  // It used to be the literal 'live', which made a tape from two conversations indistinguishable
                  // from one long one - and separating them after the fact is not possible from a constant.
                  sessionId: observer?.stats().sessionId ?? 'unassigned',
                  step,
                  ...(systemPrompt !== undefined ? { systemPrompt } : {}),
                  messages,
                })}\n`,
              );
            },
          }
        : {}),
    });
    ctx.logger?.info?.(`[s1cap] observation mode: ${resolved.observation} -> ${resolveTelemetryPath(resolved.telemetry.controlJsonl)}${resolved.observation === 'tape' ? ` + tape ${resolveTelemetryPath(resolved.telemetry.tapeJsonl)}` : ''} (prompt untouched)`);
    // What this process actually wired, written where it can be read back. The class of bug this project keeps
    // hitting is a component that is configured, constructed and never called, and from the control plane alone
    // that is invisible: a pair scored by System-1 and a pair scored lexically produce the same record. So the
    // wiring is stated once, at activation, on the same diagnostic tape as `service-probe` and `tuning-file`.
    probeSink?.write(
      JSON.stringify({
        schema: 0,
        kind: 'wiring',
        s1: backend.mode === 'none' ? 'none' : { provider: backend.provider, mode: backend.mode, baseUrl: backend.baseUrl },
        // Whether the scorers will actually reach a backend, not whether the objects exist. They are built
        // unconditionally now so that a late-arriving client is picked up, which makes "the object is there" a
        // statement about nothing and "there is a client to call" the fact worth writing down.
        relevance: client !== undefined,
        planGate: client !== undefined,
        xFirst: config.xFirst,
        recall: { d: config.recall.depth, r: config.recall.threshold, w: config.recall.window, wait: config.recall.anchorWaitMs },
        tas: config.tas,
      }) + '\n',
    );


    // The service lookup happens inside the thunk, not here: at activation time the systemPrompt service may
    // not be provided yet, so it is resolved on the first step instead (see preStepMiddleware).
    primeOnce = async () => {
      // N4 host half, first step: ask the credential service for the key the user is meant to type into the
      // settings panel. The read is written to the tape either way, so the next real round names the entry
      // point that actually answers instead of us guessing one.
      const credential = await readCredential({
        ref: CREDENTIAL_REF,
        service: (ctx                                       ).get?.('credentials'),
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
        service: (ctx                                       ).get?.('credentials'),
        report: (line) => probeSink?.write(JSON.stringify({ ...line, kind: 'credential-tuning' }) + '\n'),
      });
      appliedTuning = parseTuning(tuningRead.key);
      const fromFile = readTuningFile();
      if (fromFile.depth !== undefined) appliedTuning.depth = fromFile.depth;
      if (fromFile.relevanceThreshold !== undefined) appliedTuning.relevanceThreshold = fromFile.relevanceThreshold;
      if (fromFile.window !== undefined) appliedTuning.window = fromFile.window;
      if (fromFile.anchorWaitMs !== undefined) appliedTuning.anchorWaitMs = fromFile.anchorWaitMs;
      if (fromFile.xFirst !== undefined) appliedTuning.xFirst = fromFile.xFirst;
      if (fromFile.layaPythonPath !== undefined) appliedTuning.layaPythonPath = fromFile.layaPythonPath;
      if (fromFile.layaWeightsCacheDir !== undefined) appliedTuning.layaWeightsCacheDir = fromFile.layaWeightsCacheDir;
      if (fromFile.layaWeightsEnvVar !== undefined) appliedTuning.layaWeightsEnvVar = fromFile.layaWeightsEnvVar;
      if (fromFile.provider !== undefined) appliedTuning.provider = fromFile.provider;
      // The cell preset values before the volatile layer touches them. A tuning file written during one live test
      // silently overrode the cell it was not part of: C4 ran with xFirst=false and window=1200 for an entire
      // verification session - and nothing in any counter said so. The override itself is right (the panel owns
      // these knobs), but a *silent* one deforms an ablation run invisibly, which is this project's dominant
      // failure mode. Say it out loud at activation, and tell the reader how to get a cell-pure run.
      const cellBefore = {
        depth: config.recall.depth,
        relevanceThreshold: config.recall.threshold,
        window: config.recall.window,
        anchorWaitMs: config.recall.anchorWaitMs,
        xFirst: config.xFirst,
      };
      if (appliedTuning.depth !== undefined) config.recall.depth = appliedTuning.depth;
      if (appliedTuning.relevanceThreshold !== undefined) config.recall.threshold = appliedTuning.relevanceThreshold;
      if (appliedTuning.window !== undefined) config.recall.window = appliedTuning.window;
      if (appliedTuning.anchorWaitMs !== undefined) config.recall.anchorWaitMs = appliedTuning.anchorWaitMs;
      if (appliedTuning.xFirst !== undefined) config.xFirst = appliedTuning.xFirst;
      // The backend the panel's radio selected. Applied to the live config *before* the conflict check and the
      // rebuild below, because those two are what make the choice real: a provider written into the config object
      // alone leaves the session calling the backend the user just switched away from.
      if (appliedTuning.provider !== undefined) config.s1.provider = appliedTuning.provider;
      // The panel's Laya fields land on the *live* config object — the same one the launcher, the conflict check
      // and the status route read. This line previously declared a local of the same name from
      // `validateLayaConfig(...).config`, a normalised copy nothing else holds, so the panel's interpreter was
      // written into a dead object: the route still reported an empty path, the conflict still fired, and a
      // launch would have used no interpreter at all. A shadowed name is invisible from the outside, which is why
      // the test for this reads the value back out of the `/s1` payload instead of trusting the assignment.
      if (appliedTuning.layaPythonPath !== undefined) layaConfig.pythonPath = appliedTuning.layaPythonPath;
      if (appliedTuning.layaWeightsCacheDir !== undefined) layaConfig.weightsCacheDir = appliedTuning.layaWeightsCacheDir;
      if (appliedTuning.layaWeightsEnvVar !== undefined) layaConfig.weightsEnvVar = appliedTuning.layaWeightsEnvVar;
      if (
        appliedTuning.layaPythonPath !== undefined ||
        appliedTuning.layaWeightsCacheDir !== undefined ||
        appliedTuning.layaWeightsEnvVar !== undefined ||
        appliedTuning.provider !== undefined
      ) {
        const after = singleBackendIssues(config.s1, layaConfig);
        const was = resolved.conflicts.length;
        resolved.conflicts = after;
        if (after.length !== was) {
          ctx.logger?.info?.(
            `[s1cap] the panel supplied ${String(appliedTuning.layaPythonPath !== undefined)} Laya path(s) and ` +
              `provider=${String(appliedTuning.provider ?? '(unchanged)')}: ` +
              `${was} conflict(s) before, ${after.length} after${after.length > 0 ? ` — ${after.join('; ')}` : ''}`,
          );
        }
        // Re-resolve the backend, or clearing the conflict would be cosmetic: the client was built at activation
        // from the conflicted config and would keep making no calls for the rest of the session.
        const rebuilt = buildBackend();
        if (rebuilt.backend.mode !== backend.mode || rebuilt.backend.baseUrl !== backend.baseUrl) {
          ctx.logger?.info?.(
            `[s1cap] System-1 backend re-resolved on the first step: ${describeS1Backend(backend)} -> ` +
              `${describeS1Backend(rebuilt.backend)}`,
          );
        }
        backend = rebuilt.backend;
        client = rebuilt.client;
      }
      for (const knob of ['depth', 'relevanceThreshold', 'window', 'anchorWaitMs', 'xFirst']         ) {
        const after =
          knob === 'depth'
            ? config.recall.depth
            : knob === 'relevanceThreshold'
              ? config.recall.threshold
              : knob === 'window'
                ? config.recall.window
                : knob === 'anchorWaitMs'
                  ? config.recall.anchorWaitMs
                  : config.xFirst;
        if (after !== cellBefore[knob]) {
          ctx.logger?.warn?.(
            `[s1cap] tuning overrides the running cell: ${knob} ${String(cellBefore[knob])} -> ${String(after)} ` +
              `(delete the tuning file for a cell-pure run)`,
          );
        }
      }
      probeSink?.write(JSON.stringify({ schema: 0, kind: 'tuning-file', read: fromFile, effective: { depth: config.recall.depth, relevanceThreshold: config.recall.threshold, window: config.recall.window, anchorWaitMs: config.recall.anchorWaitMs, xFirst: config.xFirst, provider: config.s1.provider } }) + '\n');
      await primeSystemPrompt({
        service: (ctx                                       ).get?.('systemPrompt'),
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
        if (reread.relevanceThreshold !== undefined) config.recall.threshold = reread.relevanceThreshold;
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
  // The delivery path, wired once. `config.deliver` is the cell's own switch: the baseline cell (C1) leaves it
  // off, and `deliverContext` then answers "not delivered" with the reason, so a cell that assembles a layout
  // nobody receives says so in the control plane instead of looking identical to one that delivers.
  const emitControl = (event                )       => {
    try {
      controlLogRef?.emit(event);
    } catch (err) {
      ctx.logger?.warn?.(`[s1cap] control record rejected: ${String(err)}`);
    }
  };
  ctx.on(
    'agent/pre-step',
    preStepMiddleware(ctx, {
      observer,
      cell: config.cell,
      emit: emitControl,
      deliver: (built, decision, payload) =>
        deliverContext({
          enabled: config.deliver,
          order: built.layout.order,
          ...(built.layout.stateProxy !== undefined ? { stateProxy: built.layout.stateProxy } : {}),
          recalled: built.layout.recalled,
          anchor: built.layout.anchor,
          messages: Array.isArray((decision                          ).messages)
            ? ((decision                           ).messages             )
            : [],
          // The harness's `claimed` list, read from the pre-step payload exactly as dsh-agent-instructions
          // reads it. It defines where a delivered block goes: after the last message this step will append to
          // the log, which is after the question being answered, not before it.
          ...(isRecord(payload) && Array.isArray(payload['messages'])
            ? { claimed: payload['messages']              }
            : {}),
          ...(isRecord(payload) && typeof payload['step'] === 'number' ? { step: payload['step'] } : {}),
        }),
    }),
  );

  // The `/s1` surface. Registration follows the verified Cordis shape:
  // is ctx.effect(() => ctx.commands.register({ name, description, input, handler })) - all verified
  // `/s1 status` never prints the API key: the resolved backend goes through redactKey().
  /**
   * One place that turns parsed knobs into effect: merge into what is stored, apply to the live policy, persist, and
   * answer with the effective triple. The `/s1-tune` command and the panel's Save button share it, so the command
   * line and the button cannot drift apart in what they accept or what they report.
 */
  const applyTuning = (parsed        )                                                                                                                          => {
    const layaOnly =
      parsed.layaPythonPath === undefined &&
      parsed.layaWeightsCacheDir === undefined &&
      parsed.layaWeightsEnvVar === undefined;
    if (
      parsed.depth === undefined &&
      parsed.relevanceThreshold === undefined &&
      parsed.window === undefined &&
      parsed.anchorWaitMs === undefined &&
      parsed.xFirst === undefined &&
      parsed.provider === undefined &&
      layaOnly
    ) {
      return {
        ok: false,
        reason:
          'nothing to set: depth d must be an integer > 0, threshold r between 0 and 1, window w an integer >= 64, wait an integer 0..60000 (0 disables the anchor wait), xFirst on/off, provider=jev|laya-serve, or a Laya field (laya=, weights=, layaWeightsEnvVar=)',
      };
    }
    appliedTuning = { ...appliedTuning, ...parsed };
    // A panel value has to take effect now, not at the next start: the field the user just filled in is the one
    // that decides whether System-1 calls happen at all, and a backend that waits for a restart to pick it up
    // reports itself as broken for as long as the panel looks like it did nothing. The launcher reads the live
    // config when it starts, and the conflicts are recomputed below so a path that resolves a conflict says so.
    if (parsed.layaPythonPath !== undefined) layaConfig.pythonPath = parsed.layaPythonPath;
    if (parsed.layaWeightsCacheDir !== undefined) layaConfig.weightsCacheDir = parsed.layaWeightsCacheDir;
    if (parsed.layaWeightsEnvVar !== undefined) layaConfig.weightsEnvVar = parsed.layaWeightsEnvVar;
    // The radio. Written into the live config the same way the Laya fields are, and for the same reason: this is
    // the object `buildBackend` reads, so the edit and the re-resolution below have to see the same value.
    if (parsed.provider !== undefined) config.s1.provider = parsed.provider;
    if (
      parsed.layaPythonPath !== undefined ||
      parsed.layaWeightsCacheDir !== undefined ||
      parsed.layaWeightsEnvVar !== undefined ||
      parsed.provider !== undefined
    ) {
      const after = singleBackendIssues(config.s1, layaConfig);
      resolved.conflicts = after;
      ctx.logger?.info?.(
        `[s1cap] backend settings applied from the panel: provider=${config.s1.provider} ` +
          `interpreter=${String(layaConfig.pythonPath ?? '(unset)')} ` +
          `weights=${String(layaConfig.weightsCacheDir ?? '(default)')} var=${String(layaConfig.weightsEnvVar ?? '(default)')} ` +
          `— ${after.length} conflict(s)${after.length > 0 ? `: ${after.join('; ')}` : ''}`,
      );
      // Re-resolve the backend, or the radio would only look switched. The client was built at activation from
      // the config as it stood then, so without this the session keeps calling the backend the user just switched
      // away from — and, when a panel value clears or raises a conflict, keeps reporting a state that is no longer
      // true. The first-step path does the same thing (`primeOnce`); this is that treatment for a mid-session save.
      const rebuilt = buildBackend();
      if (rebuilt.backend.provider !== backend.provider || rebuilt.backend.baseUrl !== backend.baseUrl) {
        ctx.logger?.info?.(
          `[s1cap] System-1 backend re-resolved by the panel: ${describeS1Backend(backend)} -> ` +
            `${describeS1Backend(rebuilt.backend)}`,
        );
      }
      backend = rebuilt.backend;
      client = rebuilt.client;
    }
    if (parsed.depth !== undefined) config.recall.depth = parsed.depth;
    if (parsed.relevanceThreshold !== undefined) config.recall.threshold = parsed.relevanceThreshold;
    if (parsed.window !== undefined) config.recall.window = parsed.window;
    if (parsed.anchorWaitMs !== undefined) config.recall.anchorWaitMs = parsed.anchorWaitMs;
    if (parsed.xFirst !== undefined) config.xFirst = parsed.xFirst;
    const persist = writeTuningFile(appliedTuning);
    const persisted = persist.ok;
    ctx.logger?.info?.(
      `[s1cap] recall tuning: provider=${config.s1.provider} depth=${config.recall.depth} relevanceThreshold=${config.recall.threshold} window=${config.recall.window} anchorWaitMs=${config.recall.anchorWaitMs} xFirst=${String(config.xFirst)}${persisted ? '' : ' (not persisted: file write failed)'}`,
    );
    return {
      ok: true,
      effective: {
        depth: config.recall.depth,
        relevanceThreshold: config.recall.threshold,
        window: config.recall.window,
        anchorWaitMs: config.recall.anchorWaitMs,
        xFirst: config.xFirst,
        provider: config.s1.provider,
      },
      persisted,
      ...(persist.ok ? {} : { persistError: persist.error }),
    };
  };
  registerCommands(ctx, [
    {
      name: 's1-tune',
      description:
        'S1CAP: set the recall/layout knobs — BFS depth d, relevance threshold r (0..1), S1 window w (>= 64), anchor wait in ms (0 disables), xFirst on/off — the backend (provider=jev|laya-serve) and the Laya fields (laya=, weights=, layaWeightsEnvVar=)',
      input: {
        hint: 'd r w xFirst   (e.g. "3 0.7 512 on", or "d=3", "r=0.7", "w=512", "wait=10000", "xFirst=off", "provider=laya-serve", or laya="D:/conda/envs/ml/python.exe")',
      },
      handler: ({ rawInput }) => {
        const outcome = applyTuning(parseTuningArgs(rawInput));
        if (!outcome.ok) return commandError(outcome.reason ?? 'the tuning was refused');
        const eff = outcome.effective;
        // The provider leads the answer on purpose: it is the one field here that changes *which* program answers,
        // so a save that switched the backend has to say so in the line the user reads.
        const backendPart = `provider=${String(eff?.provider)}`;
        // A Laya-only save has no depth/threshold to report, and printing four defaults for it would tell the
        // user the button did nothing.
        const layaPart =
          outcome.layaApplied === true
            ? `laya interpreter=${String(layaConfig.pythonPath ?? '(unset)')} weights=${String(
                layaConfig.weightsCacheDir ?? '(default)',
              )} var=${String(layaConfig.weightsEnvVar ?? '(default)')}`
            : `depth=${String(eff?.depth)} relevanceThreshold=${String(eff?.relevanceThreshold)} ` +
              `window=${String(eff?.window)} wait=${String(eff?.anchorWaitMs)} xFirst=${eff?.xFirst === true ? 'on' : 'off'}`;
        return commandSuccess(
          backendPart +
            ' ' +
            layaPart +
            (outcome.persisted === true ? ' (persisted)' : ` (in effect, NOT persisted: ${outcome.persistError ?? 'unknown'})`),
        );
      },
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
              relevanceThreshold: config.recall.threshold,
              window: config.recall.window,
              anchorWaitMs: config.recall.anchorWaitMs,
              xFirst: config.xFirst,
              // The provider the radio selected, reported beside the knobs for the same reason they are: it is a
              // value this panel owns now, and "what did the save actually set" must be answerable from `/s1`.
              provider: config.s1.provider,
            },
            keySource: credentialSource,
          },
          tail: config.tail,
          xFirst: config.xFirst,
          planGate: config.planGate,
          s1: {
            provider: backend.provider,
            // What the config asks for, next to what the session actually resolved to. The two differ whenever a
            // conflict demotes the session to `none`, and that difference is exactly what a reader (or the panel's
            // radio) needs in order to tell "nobody selected a backend" from "one was selected and refused".
            configuredProvider: config.s1.provider,
            mode: backend.mode,
            baseUrl: backend.baseUrl,
            model: backend.model,
            key: redactKey(backend.apiKey),
            questionsPerCall: config.s1.questionsPerCall,
          },
          // The interpreter is reported here and not only on the panel's route: "which python will this run
          // use" is a question an operator asks at the command line, and `runtime.summary()` answers everything
          // about the *server* and nothing about the environment it would be launched from. A run that fell
          // back to a different interpreter, or to none, was invisible from `/s1` entirely.
          laya: { ...runtime.summary(), pythonPath: layaConfig.pythonPath ?? null },
          // Each component reports its own counters, because "constructed" and "called" are different states and
          // only the counters can tell them apart. `relevance.calls` and `planGate.calls` are the two numbers
          // that say whether the System-1 path ran at all in this process.
          relevance: relevance?.stats() ?? null,
          planGate: planGate?.stats() ?? null,
          observation: observer
            ? { mode: resolved.observation, sink: resolved.telemetry.controlJsonl, ...observer.stats() }
            : { mode: resolved.observation, steps: 0, observed: 0, skipped: 0, errors: 0 },
          telemetry: resolved.telemetry,
          // Live sink counters. `controlRecords` and `sessionLines` are the only proof that the two content/
          // control streams are actually being written rather than just declared, and `s1CallRecords` is what
          // makes the System-1 spend visible per call (role, kind, tokens, ms). "configured and constructed but
          // never called" is this project's recurring bug; these three numbers are what says it did not recur.
          streams: {
            controlRecords,
            sessionLines,
            s1CallRecords,
            // Calls that threw. `s1CallRecords` alone cannot distinguish "the backend was never configured" from
            // "it was configured and every call failed", and those two want opposite responses.
            s1CallFailures,
            sessionPath: resolveTelemetryPath(resolved.telemetry.sessionJsonl),
            controlPath: resolveTelemetryPath(resolved.telemetry.controlJsonl),
            // Where the per-session graphs live, and which sessions have one. The listing is what makes the
            // isolation claim checkable from the outside instead of something the code comments assert.
            rgDir: resolveTelemetryPath('./.s1cap/rg'),
            rgSessions: observer?.stats().sessions ?? [],
          },
          configIssues: {
            errors: resolved.policy.errors.concat(resolved.laya.errors           ).map((i) => `${i.path}: ${i.message}`),
            warnings: resolved.policy.warnings.concat(resolved.laya.warnings           ).map((i) => `${i.path}: ${i.message}`),
            conflicts: resolved.conflicts,
            telemetry: resolved.telemetryErrors,
          },
        };
        ctx.logger?.info?.(`[s1cap] ${JSON.stringify(status, null, 2)}`);
        return commandSuccess(JSON.stringify(status, null, 2));
      },
    },
    {
      name: 's1-ping',
      description: 'S1CAP: probe the resolved System-1 backend (GET /health)',
      handler: async () => {
        if (!client) return commandError('provider=none (no System-1 backend is active)');
        const started = Date.now();
        const ok = await client.health();
        const result = { ok, baseUrl: backend.baseUrl, model: backend.model, ms: Date.now() - started };
        ctx.logger?.info?.(`[s1cap] ping ${ok ? 'ok' : 'unreachable'} ${String(backend.baseUrl)} in ${result.ms}ms`);
        return ok
          ? commandSuccess(`reachable: ${String(result.baseUrl)} (model ${String(result.model)}) in ${result.ms}ms`)
          : commandError(`unreachable: ${String(result.baseUrl)} did not answer /health in ${result.ms}ms`);
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
          return commandSuccess(JSON.stringify(result, null, 2));
        }
        if (verb === 'start') {
          await runtime.start();
          const state = runtime.summary();
          ctx.logger?.info?.(`[s1cap] laya start: ${JSON.stringify(state, null, 2)}`);
          if (state.status === 'failed') {
            // A failed start writes its diagnostics to a file, not just to a status line. The buffer lives in this
            // process, so when the host exits the reason a real backend would not start goes with it — and the
            // first time this happened, the evidence was a count ("50 diagnostic lines buffered") and a manual
            // re-run by hand. The file is append-only and beside the other run artifacts.
            const path = resolveTelemetryPath('./.s1cap/laya-launch.log');
            try {
              mkdirSync(dirname(path), { recursive: true });
              writeFileSync(
                path,
                [
                  `=== ${new Date().toISOString()} start failed: ${state.error ?? 'no reason reported'}`,
                  `command: ${state.pythonPath ?? '(no interpreter)'}`,
                  '',
                  ...state.logTail,
                  '',
                ].join('\n'),
                'utf8',
                { flag: 'a' },
              );
            } catch (err) {
              ctx.logger?.warn?.(`[s1cap] could not write ${path}: ${(err         ).message}`);
            }
          }
          // A successful start makes the client usable, which is not the same as the server running. The client was
          // built on the first step and, in the ordinary case, while the port was still dead - so a session that
          // starts the backend by hand kept a client pointed at a socket that refused connections, and the run made
          // no System-1 calls while `/s1 laya status` said `ready`. Re-resolve here, where readiness is known.
          if (state.status === 'ready') {
            const rebuilt = buildBackend();
            if (rebuilt.client === undefined || rebuilt.backend.baseUrl !== backend.baseUrl) {
              ctx.logger?.info?.(
                `[s1cap] System-1 backend picked up after start: ${describeS1Backend(backend)} -> ` +
                  `${describeS1Backend(rebuilt.backend)}`,
              );
            }
            backend = rebuilt.backend;
            client = rebuilt.client;
          }
          return state.status === 'failed'
            ? commandError(
                `laya start failed: ${state.error ?? 'no reason reported'}\n` +
                  state.logTail.map((l) => `  | ${l}`).join('\n'),
              )
            : commandSuccess(`laya ${state.status}: ${state.baseUrl}`);
        }
        if (verb === 'stop') {
          await runtime.stop();
          const state = runtime.summary();
          ctx.logger?.info?.(`[s1cap] laya stop: ${JSON.stringify(state, null, 2)}`);
          return commandSuccess(`laya ${state.status}`);
        }
        const state = runtime.summary();
        ctx.logger?.info?.(
          `[s1cap] laya status: ${state.status}${state.pythonPath ? ` (python: ${state.pythonPath})` : ''}${state.weights ? ` (checkpoints: ${state.weights.envVar}=${state.weights.cacheDir})` : ''}${state.error ? ` - ${state.error}` : ''}${state.logLines ? ` [${state.logLines} diagnostic lines buffered]` : ''}`,
        );
        return commandSuccess(
          `laya ${state.status}${state.baseUrl ? ` at ${state.baseUrl}` : ''}` +
            `${state.pythonPath ? ` (python: ${state.pythonPath})` : ''}` +
            `${state.weights ? ` (checkpoints: ${state.weights.envVar}=${state.weights.cacheDir})` : ''}` +
            `${state.error ? ` - ${state.error}` : ''}` +
            // The tail only when the backend is not healthy: a running server has nothing to explain, and a dead
            // one is exactly when "50 diagnostic lines buffered" is the least useful sentence in the world.
            (state.status === 'ready' || state.logTail.length === 0
              ? ''
              : `\n${state.logTail.map((l) => `  | ${l}`).join('\n')}`),
        );
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
    if (storedNow.relevanceThreshold !== undefined) config.recall.threshold = storedNow.relevanceThreshold;
    if (storedNow.window !== undefined) config.recall.window = storedNow.window;
    if (storedNow.anchorWaitMs !== undefined) config.recall.anchorWaitMs = storedNow.anchorWaitMs;
    if (storedNow.xFirst !== undefined) config.xFirst = storedNow.xFirst;
    // The provider the panel's radio stored, applied here and not only on the first step: this block is what makes
    // a saved backend survive a restart, and the initial `buildBackend()` above ran before the file was read — so
    // the choice is applied and then re-resolved, or the session would run the profile's provider while both the
    // file and the panel said otherwise. Said out loud as a `warn`, like every other tuning override of a cell:
    // which backend answers is not a value that may change silently between two runs of an ablation.
    if (storedNow.provider !== undefined && storedNow.provider !== config.s1.provider) {
      ctx.logger?.warn?.(
        `[s1cap] tuning overrides the running cell: provider ${config.s1.provider} -> ${storedNow.provider} ` +
          `(delete the tuning file for a cell-pure run)`,
      );
      config.s1.provider = storedNow.provider;
      resolved.conflicts = singleBackendIssues(config.s1, layaConfig);
      const rebuilt = buildBackend();
      ctx.logger?.info?.(
        `[s1cap] System-1 backend re-resolved from the stored provider: ${describeS1Backend(backend)} -> ` +
          `${describeS1Backend(rebuilt.backend)}`,
      );
      backend = rebuilt.backend;
      client = rebuilt.client;
    }
  }

  const webServer = findService                                       (ctx, 'webServer');
  if (webServer !== undefined) {
    const registerRoute = ()       => {
      webServer.register({
        kind: 'prefix',
        path: TUNING_ROUTE,
        handler: async (req                 , res                ) => {
          try {
            const method = (req.method ?? 'GET').toUpperCase();
            if (method === 'GET') {
              // The panel needs the effective knobs to fill itself; the system check needs the live counters, and
              // it cannot get them from the instance log — this plugin's logger does not reach that file, which
              // is exactly what the first version of the check assumed. One route, both readers, and no second
              // surface invented for the sake of a test.
              // The effective policy is `resolved.policy.policy` — `validatePolicy` returns the *result* object,
              // whose `policy` field is the defaults with every valid override applied. Two wrong paths were taken
              // here first, and both failed silently or loudly in instructive ways: reading the top-level
              // `config.xFirst` reported nothing at all for a cell-pure run (the override slot is empty exactly
              // when the cell is in charge), and reading `config.policy` 500s, because that field belongs to the
              // validation result and not to the config.
              const effective = resolved.policy.policy;
              sendJson(res, 200, {
                ok: true,
                stored: { ...readTuningFile(), ...appliedTuning },
                effective: {
                  depth: config.recall.depth,
                  relevanceThreshold: config.recall.threshold,
                  window: config.recall.window,
                  anchorWaitMs: config.recall.anchorWaitMs,
                  xFirst: effective.xFirst,
                  // The provider the radio selected, so the GET answers the same shape the PUT echoes back and the
                  // panel can fill the radio from the same place it fills the knobs.
                  provider: config.s1.provider,
                },
                status: {
                  cell: config.cell,
                  tas: effective.tas.on,
                  tier1: config.recall.tier1,
                  planGate: effective.planGate.on,
                  deliver: effective.deliver,
                  xFirst: effective.xFirst,
                  s1: { provider: backend.provider, configuredProvider: config.s1.provider, mode: backend.mode, baseUrl: backend.baseUrl },
                  // The Laya half the panel needs in order to render and validate its own fields: what was
                  // supplied, what the plugin resolved it to, and the conflicts that decide whether the backend
                  // runs at all. Without it the panel can write a path and never learn whether it took effect.
                  laya: {
                    supplied: {
                      pythonPath: layaConfig.pythonPath ?? null,
                      weightsCacheDir: layaConfig.weightsCacheDir ?? null,
                      weightsEnvVar: layaConfig.weightsEnvVar ?? null,
                    },
                    state: runtime.summary(),
                    conflicts: resolved.conflicts,
                  },
                  observation: observer ? { ...observer.stats(), mode: resolved.observation } : null,
                  streams: { controlRecords, sessionLines, s1CallRecords },
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
