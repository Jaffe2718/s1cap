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
                                                                                                                         
                                                   
import { defaultPolicy, mergeCellPreset, validatePolicy, TELEMETRY_SCHEMA_VERSION, UNENFORCED_KNOBS } from '@s1cap/core';
                                                                      
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
import { deliverContext, visibleMessagesOf } from './context-delivery.js';
import { selectToolContext } from './context-selection.js';
                                                                   
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { primeSystemPrompt } from './system-prompt.js';
                                                                 
import {
  TUNING_REF,
  parseEnvName,
  parsePath,
  parseProvider,
  parseTuning,
  parseTuningArgs,
  questionFirstRefusal,
  questionLastNote,
  questionSlotOutcome,
  readCredential,
} from './credentials.js';
                                               
import { createStepObserver } from './step-observer.js';
                                                       
import { createS1Relevance } from './s1-relevance.js';
import { createBackpressure, BACKPRESSURE_DEFAULTS } from './s1-backpressure.js';
                                                         

                                                           
                                                                                               
   
                    
     
                                                                                                         
                                                                                                   
                                                                                                      
   
                                       
     
                                                                                       
                                                                                 
                                                          
   
                                                                                   
                    
 

                                 
                       
                       
                                                                                   
   
                    
 

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
 * How the association lane is driven: **on demand, since 2026-10-05**.
 *
 * It used to be eager - upkeep called `scoreNew` for every event it folded in, with `MAX_PAIRS_PER_SWEEP = 2048`
 * as the per-tick budget across those segments - and that constant is deleted rather than kept, because it bounded
 * work the build no longer does. What bounds the lane now is the *walk*: a step's recall asks the graph for the
 * rows it needs (`AssociationGraph.recallDemand`), one level of the walk at a time, and `recall.anchorWaitMs` is
 * the deadline those demands are issued under. The pair budget that replaces it is not a number at all: a row is
 * `min(index, w)` pairs, and how many rows a step buys is how far its walk spreads before the deadline.
 *
 * It is recorded in the wiring record's `governance` block as a string, so a round can tell which mechanism drove
 * the lane it is reading - the two produce very different `scoredPairs` for the same session, and nothing in the
 * artifacts would otherwise say which one ran.
 */
const SCORING_MODE = 'on-demand';

/**
 * The cell preset this process last resolved, for the wiring record. The same idiom as `appliedTuning` below: the
 * resolution is pure and the record is written much later by activation, so the provenance travels in a module
 * binding rather than through every caller.
 *
 * It exists because the alternative was measured and failed: `bench/cells/C2.json` was given
 * `recall.threshold: 0.6` on 2026-10-05 and the round that followed ran **0.55**, since nothing loaded the file —
 * and no artifact said a value had been written and ignored. A round's `kind:"wiring"` record now names the preset
 * file it read and which fields that file supplied, so "which JSON produced this run" is readable afterwards.
 */
let appliedCellPreset                                                                                               = null;

/** What the last `resolvePluginConfig` read from a cell preset, for the wiring record. */
export function lastCellPreset()                                                                                               {
  return appliedCellPreset;
}

/**
 * Validate and normalise the whole plugin config. Fail-safe: invalid values are reported and
 * the default is kept, so a typo in a profile patch can never break a live session.
 *
 * @param preset the parsed `bench/cells/<cell>.json`, and the path it came from. **The preset is a layer of the
 *   policy, not a description of one** — `mergeCellPreset` folds it under the profile's own keys, so a value written
 *   in the JSON reaches the session and a value the profile also sets still wins. Precedence:
 *   `defaultPolicy()` < cell preset < explicit config in the profile patch.
 */
export function resolvePluginConfig(
  raw                             ,
  preset                                           ,
)                       {
  const source = (raw ?? {})                           ;
  const merged = mergeCellPreset(source, preset?.value, {
    extraTopLevel: ['laya', 'telemetry', 'enabled', 'observation'],
  });
  const policy = validatePolicy(merged.raw, ['laya', 'telemetry', 'enabled', 'observation']);
  // ---------------------------------------------------------------------------------------------------------------
  // A cell named with no preset beside it is a configuration that is not the arm it says it is
  // ---------------------------------------------------------------------------------------------------------------
  //
  // `cellPolicy()` stopped setting a cell's switches on 2026-10-05, so a profile writing `cell: C0` and no preset now
  // resolves to `defaultPolicy()` — and the two are not the same policy. Measured against the defaults: C0's file
  // says `recall.tier1: 'off'` where the default is `'s1'`; C1's file says `tas.on: true`, `tier1: 'off'` and
  // `deliver: true` where the defaults say `false`, `'s1'`, `false`; C2's says `tas.on: true` and `deliver: true`
  // where the defaults say `false`. Every one of those values is legal and nothing refuses, so nothing but a sentence
  // can catch it — and `setup.mjs` is the only thing that puts the file there.
  //
  // A warning rather than an error: a session that names a cell and means the defaults is a legitimate thing to run
  // (that is what every round before this change did), and the plugin must not refuse to start over a missing
  // convenience copy. What it must not do is stay quiet while a run filed under a cell's name behaves like a
  // different configuration.
  const namedCell = typeof source['cell'] === 'string' ? (source['cell']          ) : null;
  if (namedCell !== null && (preset?.file ?? null) === null) {
    policy.issues.push({
      path: 'cell',
      severity: 'warning',
      message:
        `this profile names cell ${namedCell} but no cell preset was read (\`<DSH_HOME>/.s1cap/cell-preset.json\` is ` +
        `absent, and \`setup.mjs\` is what copies it from bench/cells/${namedCell}.json). Since 2026-10-05 a cell's ` +
        `switches live in that file, so this session runs \`defaultPolicy()\` — not the settings ${namedCell} is ` +
        'defined by. Measured, the defaults are not that cell: C0 differs in `tas.on` (true against the file\'s ' +
        'false) and `recall.tier1` (s1 against off), and C1 and C2 differ in `tas.on` and `deliver` as well. A round ' +
        'recorded under this name would be filed as an arm it did not run',
    });
    policy.warnings = policy.issues.filter((i) => i.severity === 'warning');
    policy.ok = policy.issues.filter((i) => i.severity === 'error').length === 0;
  }
  // A preset issue is an **error**, not a warning: the file is this project's own and a path it does not have means
  // the file and the build disagree about what will run. `validatePolicy` walks only the top level for unknown keys,
  // so without this a typo inside a section (`recall.thrsehold`) was dropped with nothing said at all.
  if (merged.issues.length > 0) {
    for (const issue of merged.issues) {
      policy.issues.push({ path: issue.path, message: `cell preset: ${issue.message}`, severity: 'error' });
    }
    policy.errors = policy.issues.filter((i) => i.severity === 'error');
    policy.warnings = policy.issues.filter((i) => i.severity === 'warning');
    policy.ok = policy.errors.length === 0;
  }
  appliedCellPreset = { file: preset?.file ?? null, fromPreset: merged.fromPreset, overridden: merged.overridden };
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

/**
 * Where a profile says its cell preset is, relative to `DSH_HOME` like every other path this plugin resolves.
 *
 * The presets themselves live in the repository (`bench/cells/<cell>.json`) and are **not reachable from a deployed
 * profile**: `setup.mjs` copies each package into the profile's `node_modules`, and a round's own copy of
 * `@s1cap/core` resolves to the profile, not to the working tree — measured on round `20261004-1618`, where
 * `realpath` on `@s1cap/core/lib/config.js` stayed inside `home/C2/profiles/C2test/node_modules`. So the preset is
 * copied in beside the profile and named here, rather than guessed at by walking up from a module.
 */
const CELL_PRESET_FILE = './.s1cap/cell-preset.json';

/**
 * Read the cell preset a profile names, if it names one.
 *
 * The failure shapes are returned rather than thrown, so activation can put them in the same channel every other
 * configuration problem goes to. A profile that names no preset is **not** a failure — that is every round before
 * this one, and it keeps the cell and the defaults.
 */
export function readCellPresetFile()                                                          {
  const path = resolveTelemetryPath(CELL_PRESET_FILE);
  let raw        ;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    // Absent is the ordinary case for every profile written before this change, so it is not reported.
    return { file: null, value: undefined };
  }
  try {
    return { file: path, value: JSON.parse(raw)            };
  } catch (err) {
    return { file: path, value: undefined, error: `${path} could not be read as JSON: ${(err         ).message}` };
  }
}

/** the panel's Save route: a prefix on the same server that serves the UI, following dsh-pet's /dsh-pet-7340
 */
const TUNING_ROUTE = '/s1cap-7340';

export function readTuningFile()         {
  try {
    const raw = readFileSync(resolveTelemetryPath(TUNING_FILE), 'utf8');
    const parsed = JSON.parse(raw)                           ;
    const out         = {};
    // The panel's bound mirrors `NUMBER_RULES` for `recall.depth` (1..16) rather than being "an integer > 0": the
    // core validator caps the path, so a file writing 17 would be applied by this reader and refused by the next
    // profile validation — two surfaces disagreeing about the same knob is the drift this check exists to stop.
    if (typeof parsed.depth === 'number' && Number.isInteger(parsed.depth) && parsed.depth >= 1 && parsed.depth <= 16) out.depth = parsed.depth;
    // A file written before the rename still carries the old key: read either, so an upgrade does not silently
    // drop a researcher's stored threshold.
    const threshold = typeof parsed.relevanceThreshold === 'number' ? parsed.relevanceThreshold : (parsed                         ).releTao;
    if (typeof threshold === 'number' && threshold >= 0 && threshold <= 1) out.relevanceThreshold = threshold;
    if (typeof parsed.window === 'number' && Number.isInteger(parsed.window) && parsed.window >= 4) out.window = parsed.window;
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
    // **The question's old slot, read only to be reported (2026-10-05).** The setting behind it is deleted — the
    // paper places the question last in every condition and `q` is now the last block by construction — and a stored
    // file is the surface where silence would cost the most: a value that resolves to nothing is this project's
    // most-repeated failure, and a researcher's stored layout reverting without a word is exactly what it looks like
    // from the outside. So the two spellings a previous panel wrote are read, and what they ask for decides between
    // a **refusal** (`refused`: the question first, `[T, q, x]`, a layout no setting produces) and a **note**
    // (`notes`: the question last, which is what every layout does now). Nothing is stored for either, because there
    // is no field left to store it in, and an unrecognized value is dropped exactly as this reader always dropped
    // one. The sentences are `credentials.ts`'s own, so the file, the command line and the panel cannot drift apart
    // on what `true` or `first` means.
    if (typeof parsed.questionPlacement === 'string' || typeof parsed.xFirst === 'boolean') {
      const where =
        typeof parsed.questionPlacement === 'string'
          ? `questionPlacement: ${JSON.stringify(parsed.questionPlacement)}`
          : `xFirst: ${String(parsed.xFirst)}`;
      const value = typeof parsed.questionPlacement === 'string' ? parsed.questionPlacement : String(parsed.xFirst);
      const asks = questionSlotOutcome(value);
      if (asks === 'first') out.refused = [questionFirstRefusal(where, value)];
      else if (asks === 'last') out.notes = [questionLastNote(where, value)];
    }
    // And the paper's arm, which is the only layout axis: `tracePlacement` is a closed two-value union, so an
    // unknown string is dropped rather than clamped - the same rule as every other value in this reader.
    if (parsed.tracePlacement === 'trace-as-state' || parsed.tracePlacement === 'trace-append') {
      out.tracePlacement = parsed.tracePlacement;
    }
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
 *
 * **Only the settings are written, field by field.** The in-memory `appliedTuning` also carries the *readings* that
 * are not settings — `refused` and `notes`, the sentences a legacy question-axis spelling earned (`credentials.ts`)
 * — and those belong in the log and on `/s1`, not in a file the next launch parses as configuration. Writing the
 * object wholesale is what put them there the first time this file was touched, which is why the projection is
 * explicit rather than a delete of the two keys.
 */
function writeTuningFile(values        )                                  {
  const path = resolveTelemetryPath(TUNING_FILE);
  try {
    mkdirSync(dirname(path), { recursive: true });
    const stored         = {
      ...(values.depth !== undefined ? { depth: values.depth } : {}),
      ...(values.relevanceThreshold !== undefined ? { relevanceThreshold: values.relevanceThreshold } : {}),
      ...(values.window !== undefined ? { window: values.window } : {}),
      ...(values.anchorWaitMs !== undefined ? { anchorWaitMs: values.anchorWaitMs } : {}),
      ...(values.tracePlacement !== undefined ? { tracePlacement: values.tracePlacement } : {}),
      ...(values.layaPythonPath !== undefined ? { layaPythonPath: values.layaPythonPath } : {}),
      ...(values.layaWeightsCacheDir !== undefined ? { layaWeightsCacheDir: values.layaWeightsCacheDir } : {}),
      ...(values.layaWeightsEnvVar !== undefined ? { layaWeightsEnvVar: values.layaWeightsEnvVar } : {}),
      ...(values.provider !== undefined ? { provider: values.provider } : {}),
    };
    writeFileSync(path, JSON.stringify(stored) + '\n', 'utf8');
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

/**
 * The session id on the pre-step payload: `agent.session.id`, the same path the observer reads.
 *
 * It is read here, and not taken from the assembly record, because the delivery report is now written on steps
 * that assemble nothing - and on those the assembly record does not exist. The alternative was to drop the field
 * exactly where the refusals are, which would make `context_delivery` records split into two shapes by whether
 * the step could deliver, in the one file this project reads to tell those two apart.
 */
function readPayloadSessionId(payload         )         {
  if (!isRecord(payload)) return 'unassigned';
  const agent = payload['agent'];
  if (!isRecord(agent)) return 'unassigned';
  const session = agent['session'];
  if (!isRecord(session)) return 'unassigned';
  const id = session['id'];
  return typeof id === 'string' && id !== '' ? id : 'unassigned';
}

/**
 * The delivery path's options, plus the switch that decides which steps reach it at all.
 *
 * `assemblyTrigger` is `policy.assemblyTrigger` (`packages/core/src/types.ts`): omitted means `'every-step'`, the
 * value the originating brief requires, so a caller that predates the switch gets the full mechanism. `'claimed-only'`
 * is the narrow value: the assembly runs only on steps whose decision claims messages, which round `20261004-0205`
 * measured as 2 assemblies in C2's 53 steps. Nothing in this repository sets it; it exists so that round stays
 * reproducible and so a single-variable round can flip back to it.
 */
                                 
                          
                                                                                                                  
                    
                                                                                                            
                                                                                                               
                                                                                                  
     
                                                                                            
                                                                 
                                    
                                    
                                                                                               
                                                                       
 

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
  /**
   * Legacy fallback for hosts without Session.deriveMessages(). Real sessions use
   * the current visible surface, so a removed injection can be delivered again.
   *
   * The duplicate guard, and the reason it is here rather than only in `deliverContext`: that module's check scans
   * `decision.messages` for the text of the previous injection, on the premise that "the previous injection is
   * part of the log and comes back through the decision". **It does not.** `decision.messages` is
   * `inbox.claim(...)` plus one projected context message; `claim` removes what it returns, and a message appended
   * to the session (the channel this middleware's insert takes) never enters the inbox at all - the round's tape
   * shows it, with the payload's message count `{0: 276, 1: 1}` over 277 steps and the single non-empty one
   * carrying the human prompt rather than the block. So the content check cannot fire in production, and the
   * consequence would be structural: the same block re-appended to the log on every step, one copy per step, with
   * `ledger.json` and `composition.json` inflating alongside it - the D4 failure mode, arrived at from the fix
   * side. It is invisible today only because delivery fired twice in the whole round, with different payloads.
   *
   * **`'every-step'` makes this set the load-bearing guard rather than a safety net.** On the steps that switch
   * exists for, `decision.messages` is empty, so `deliverContext`'s content check scans nothing and this set is
   * the only thing standing between a stable selection and one appended copy per step. The consequence
   * `DEFECT-GATE.md` records (Update 5, item 5) follows from it directly, and belongs in any round that flips
   * the switch: a stable selection delivers **at most once per distinct payload per session**, so a delivered
   * total is bounded by distinct payloads and not by delivering steps.
   *
   * Keyed on the digest S1CAP itself computed (`context-delivery.ts`, content-derived and already recorded on
   * every delivery, so this needs no new hashing) and on the session, so cross-session safety falls out of the
   * key rather than out of a comparison of message text. The content check stays as the cheap first test.
   */
  const deliveredPayloads = new Map                     ();
  return async (payload, next) => {
    const timingStartedAt = performance.now();
    const timestamp = Date.now();
    let downstreamMs = 0;
    let observationMs = 0;
    let contextMs = 0;
    try {
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
    const downstreamStartedAt = performance.now();
    const decision = await next();
    downstreamMs = performance.now() - downstreamStartedAt;
    const record = decision                                                                          ;
    const before = Array.isArray(record.messages) ? record.messages.length : 0;
    // `position.step`, for the one reason the delivery module reads it: the harness treats "step 1 with nothing
    // claimed" as no step at all, and that is a more specific cause than "the decision carried no messages".
    const step = isRecord(payload) && typeof payload['step'] === 'number' ? payload['step'] : 0;
    const report = (delivered         , reason        , extra                          = {})       => {
      try {
        options?.emit({
          type: 'context_delivery',
          schema: TELEMETRY_SCHEMA_VERSION,
          ts: Date.now(),
          // The session id used to be read off the assembly record, which is now absent on exactly the steps that
          // are reported here without having assembled anything. It is the same session either way, and the
          // payload carries it: `agent.session.id`, read the way the observer reads it, with `unassigned` only
          // when the payload does not expose one - which is a fact about the payload, not a missing value.
          sessionId: readPayloadSessionId(payload),
          cell: options?.cell ?? 'unassigned',
          delivered,
          reason,
          messagesBefore: before,
          messagesAfter: before,
          kept: 0,
          dropped: 0,
          inserted: 0,
          blocks: [],
          payloadId: '',
          order: [],
          ...extra,
        }                  );
      } catch (err) {
        ctx.logger?.warn?.(`[s1cap] context_delivery record rejected: ${String(err)}`);
      }
    };

    // The cheap check, and it has to be cheap because it is the whole point of it: whether this step can receive a
    // block at all, decided from the harness's own decision and *before* anything is assembled.
    //
    // **An empty `decision.messages` does not mean the step sends no request, and the comment here used to say it
    // did.** The packaged harness appends the decision and then builds and streams the request unconditionally,
    // because the request is built from the session log and not from the decision -
    // `dsh-agent-loop/lib/index.js`: the append at L1061 (`if (firstAttempt) for (const message of
    // decision.messages) this.session.append("user/message", …)`), `buildRequest` at L1063, `stream` at L1072.
    // Round `20261002-2037` measures the consequence rather than the claim: 277 `step/start` events against 277
    // `assistant/message` events, one `turn/start`, and no `turn/end` at all, so every one of the 275
    // empty-decision steps did call the model. The host's own instructions plugin inserts into exactly such a
    // decision in this very profile (`dsh-agent-instructions`: `decision.messages.toSpliced(lastClaimedIndex + 1,
    // 0, desired)`, where a claimed list of nothing gives index 0), and it did so at step 4 of that round.
    //
    // The refusal is kept anyway, for a reason that is about *termination* and not about capability: the empty
    // decision is also how the loop decides the turn is over, so a plugin that returns a message there prevents
    // the turn from ending and buys another model call - repeated, a livelock. The two places the loop skips on an
    // empty decision are `if (turnEnds && decision.messages.length === 0) break` (L962) and the step-0 case at
    // L963, both turn-boundary tests. S1CAP cannot see `turnEnds` - it is a local of `turn()`, and the payload
    // carries `{messages, turn, step, signal}` - so the plugin cannot tell a terminal pre-step from an ordinary
    // one, and `termination: 'model-owned'` (the harness stops when the model stops, and no S1CAP output may
    // prolong or veto that exit) decides the matter in favour of declining. The refusal protects termination by
    // construction instead of by accident, and that is now what it says.
    //
    // What was wrong was paying for it: a measured diagnostic round assembled 1,205,029 recalled tokens over 277
    // steps and delivered 1,597 of them (0.133%), because 275 of those steps reached the assembler - the walk, the
    // anchor wait, T's rebuild - before anyone asked whether the assembled view had anywhere to go. The same
    // condition is not a quirk of that cell: the control cell's refusals are 74 of 76 for the same reason.
    //
    // And the blindness that fix would otherwise introduce is closed below: the refusal record carries
    // `assembled: false, ingested: true`, so "the lane read this step and declined" is distinguishable in the
    // control plane from "the observation never ran or threw" - which the `/s1`-only `ingestOnly`/`errors`
    // counters could say only to a live reader.
    //
    // A rejected or aborted decision is the same cheap class and is reported in the same place, for the same
    // reason: three fields tell us the answer, and the assembly is downstream of all three.
    //
    // **The trigger.** Two values, one knob (`policy.assemblyTrigger`, `packages/core/src/types.ts`), and the
    // default is the expression this shipped with:
    //
    //   - `'claimed-only'`: assemble exactly when the decision itself carries messages — character for
    //     character the condition the D1 fix introduced. This was the default until 2026-10-04; it is kept as a
    //     value because round `20261004-0205` ran it and its record has to stay readable.
    //   - `'every-step'` (default): assemble on every step that will actually issue a request. At this hook the whole of
    //     that condition is the negation of the two facts already tested below: `record.kind === 'reject'` and
    //     `record.signal?.aborted === true`. Nothing else observable separates a step that sends no request from
    //     one that does: the packaged loop appends the decision (`dsh-agent-loop` L1061) and then builds and
    //     streams the request from the session log whatever `decision.messages` holds (L1063/L1072). The
    //     evidence is the round that measures the defect this switch exists for — `20261003-2104` made **33 model
    //     calls on 33 steps, one `LLM calls` record per step**, turn ended `1:completed`, and assembled twice —
    //     so in that round an empty decision did not mean "no request". `step === 1` with nothing claimed is
    //     excluded even here: the harness's own `step === 1 && messages.length === 0` is a turn-boundary test,
    //     the host's instructions plugin declines there too, and that round's evidence is about the steps after
    //     the first.
    //
    // **What is deliberately not overruled.** The empty decision is also how the loop decides the turn is over
    // (`if (turnEnds && decision.messages.length === 0) break`, L962), and `turnEnds` is a local the payload does
    // not carry — so a plugin cannot tell a terminal pre-step from an ordinary one, returning a message at a
    // terminal step prevents the turn from ending, and repeated, that is a livelock. `termination: 'model-owned'`
    // says no S1CAP output may prolong or veto the model's exit, and `DEFECT-GATE.md` records the refusal on an
    // empty decision as a design decision rather than a capability limit (D1's correction, Update 2026-10-02).
    // That is why this is a switch with a conservative default and not a fix: **the round that flips it has to
    // show that the empty-decision steps it acts on are non-terminal** — the 33-of-33 count shows they issued
    // requests, which is not the same claim — and the switch is what lets exactly that round be run without
    // moving any other variable.
    const stepMessages = record.messages;
    const everyStep = options?.assemblyTrigger === 'every-step';
    const requestsModel = record.kind !== 'reject' && record.signal?.aborted !== true;
    const claimsMessages = Array.isArray(stepMessages) && stepMessages.length > 0;
    const firstStepWithNothingClaimed = step === 1 && Array.isArray(stepMessages) && stepMessages.length === 0;
    const deliverable = firstStepWithNothingClaimed
      ? false
      : everyStep
        ? requestsModel && Array.isArray(stepMessages)
        : claimsMessages;
    if (record.kind === 'reject' || record.signal?.aborted === true || !Array.isArray(stepMessages)) {
      // These are the only refusals left under `'every-step'`, and they are the reason the switch is safe to
      // offer: a rejected or aborted step sends no request, and a decision whose `messages` is not a list is a
      // shape this lane does not understand — inserting a list where the harness had something else would be a
      // rewrite, not the insertion the delivery module promises.
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
    // A step that cannot receive context still gets *read*: the observer ingests the payload's segments into the
    // graph and stops before the assembly. Skipping the observation outright would leave the graph missing exactly
    // the steps the harness claims nothing for, which in the measured round was 275 of 277 - the segments would
    // simply never exist.
    let observation                             ;
    // Whether this step was *read*: the payload adapted, segmented and folded into the graph, with the assembly as
    // the part that was skipped. It cannot be read off `observation`, which is `undefined` both for the ingest-only
    // path and for the empty and failed ones - that ambiguity is the whole of the finding. It is read off the
    // observer's own counter, which advances on exactly one of those paths and neither throws nor lies: comparing
    // the counter across the call is what turns three identical records into three legible ones, and an undefined
    // observer leaves it at zero, which is the correct answer for "nothing read this step".
    const ingestOnlyBefore = observer?.stats().ingestOnly ?? 0;
    const visibleMessages = visibleMessagesOf(payload);
    const observationStartedAt = performance.now();
    try {
      // Segment, recall and assemble for real, and record the result in the control plane. `observe()` never
      // throws, and neither does this catch: a failed observation costs the record, never the step.
      observation = await observer?.observe(payload, {
        assemble: deliverable,
        ...(visibleMessages === undefined ? {} : { visibleMessages: [...visibleMessages, ...stepMessages] }),
      });
    } catch (err) {
      ctx.logger?.warn?.(`[s1cap] pre-step observation failed (ignored): ${String(err)}`);
    } finally {
      observationMs = performance.now() - observationStartedAt;
    }
    const ingested = (observer?.stats().ingestOnly ?? 0) > ingestOnlyBefore;
    if (!deliverable) {
      // Reported in the delivery module's own words, because the record has to stay the same record: the report
      // scripts count refusals by `delivered: false` and read this reason, and a new sentence here would make the
      // same event look like a different one. What is new is only that the step no longer paid for it first. The
      // harness's sharper first-step reason is kept ahead of it, exactly as `deliverContext` orders the two.
      //
      // Under `'every-step'` this branch is reached by exactly two states, and neither is the measured defect:
      // `step === 1` with nothing claimed — the harness's own turn-boundary guard, excluded from the trigger
      // above — and a decision whose `messages` is not a list, which the guard further up already returned on.
      // The reason strings are unchanged, so a round's refusal count keeps meaning what it meant.
      //
      // The two flags are the whole of the added information, and they are read from the observation's own counters
      // rather than assumed: `ingested` is true exactly when `observeStep` returned the ingest-only shape, i.e. the
      // payload was adapted, segmented and folded into the graph and the assembly was the part that was skipped.
      // `false` is therefore either "the observer was absent" or "`observe()` threw" - a step nobody read - which is
      // the state that used to be indistinguishable from this one in a persisted record.
      report(false, step === 1
        ? 'step 1 with no claimed messages: the harness treats this as no step at all'
        : 'the decision carried no messages', {
        assembled: false,
        ingested,
        step,
      });
      return decision;
    }

    // Context delivery - the step where an assembled layout becomes what the model is shown.
    //
    // The harness's own guards ran above, before the assembly; everything after here is ours, and every failure in
    // it returns the untouched decision: the failure mode of the intervention is that it does not happen, never a
    // broken round.
    if (options === undefined || observation === undefined) return decision;
    const contextStartedAt = performance.now();
    try {
      options.selectContext?.(observation, payload);
      // Re-read after the observation's awaits: a concurrent compaction may have
      // replaced the surface used for the scoring-admission check.
      const deliveryVisibleMessages = visibleMessagesOf(payload);
      const result = options.deliver(observation, decision                           , payload, deliveryVisibleMessages);
      if (!result.delivered || result.messages === null) {
        // `assembled: true`, because it did: reaching this line means the walk ran, and the reason says only why
        // the *delivery* was declined. Three states produce `delivered: false` and this flag is what separates
        // this one from the two above (read-and-declined, and never read).
        report(false, result.reason, { assembled: true, blocks: result.blocks, order: observation.layout.order,
          recallDelivery: result.recallDelivery });
        return decision;
      }
      // Already sent this exact payload to this session: refuse it, and say so in the record. Without this the
      // block is re-appended on every step whose selection is stable, because the harness's increment never
      // carries the previous injection back (see `deliveredPayloads` above). The check is on the digest and not on
      // the text so a *different* layout with the same digest is still recognised, and the empty payloadId - which
      // is what a refusal leaves behind, and a delivery never does - is not allowed to mark a session as seen.
      const payloadId = result.payloadId;
      // A lifetime digest is not proof of current visibility after compaction.
      // Real sessions use the projected surface; retain the legacy guard only
      // for hosts that do not expose it.
      if (payloadId !== '' && deliveryVisibleMessages === undefined) {
        const sessionKey = readPayloadSessionId(payload);
        const seen = deliveredPayloads.get(sessionKey) ?? new Set        ();
        if (seen.has(payloadId)) {
          report(false, 'this exact context was already delivered in this session: not delivered twice', {
            // `assembled: true`, like the delivery module's own refusals below: the walk ran, and this refusal is
            // about the repeat rather than about the step being unreadable.
            assembled: true,
            blocks: result.blocks,
            payloadId,
            order: observation.layout.order,
          });
          return decision;
        }
        seen.add(payloadId);
        deliveredPayloads.set(sessionKey, seen);
      }
      report(true, result.reason, {
        assembled: true,
        messagesAfter: result.messages.length,
        kept: result.kept,
        // `dropped` is reported as the harness's own number rather than a hard zero: if a future change ever
        // removed a message here, the record would have to change with it, and a record that cannot be wrong is
        // a record nobody reads.
        dropped: result.dropped,
        inserted: result.inserted,
        blocks: result.blocks,
        payloadId: result.payloadId,
        recallDelivery: result.recallDelivery,
        order: observation.layout.order,
      });
      return { ...(decision                           ), messages: result.messages };
    } catch (err) {
      // Worth a warning: it means the intervention silently did not happen for this step, which is the failure
      // this whole file exists to make impossible to miss.
      ctx.logger?.warn?.(`[s1cap] context delivery failed (decision passed through unchanged): ${String(err)}`);
      return decision;
    } finally {
      contextMs = performance.now() - contextStartedAt;
    }
    } finally {
      // The host emits step/start after this middleware. Record the otherwise
      // invisible gap separately; downstream middleware is not S1CAP overhead.
      try {
        const totalMs = performance.now() - timingStartedAt;
        observer?.probe({ schema: 0, kind: 'pre-step-timing', timestamp,
          sessionId: readPayloadSessionId(payload),
          step: isRecord(payload) && typeof payload['step'] === 'number' ? payload['step'] : 0,
          totalMs, downstreamMs,
          pluginMs: Math.max(0, totalMs - downstreamMs), observationMs, contextMs });
      } catch { /* Telemetry must never change the decision. */ }
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

  // The cell preset, loaded before the policy is resolved so that it is a **layer** of that policy rather than a
  // note beside it: `setup.mjs` copies `bench/cells/<cell>.json` in beside the profile, and a profile that names
  // none keeps the cell and the defaults, which is what every round before this change did.
  const cellPreset = readCellPresetFile();
  if (cellPreset.error !== undefined) ctx.logger?.error?.(`[s1cap] ${cellPreset.error}`);
  const resolved = resolvePluginConfig(raw, { file: cellPreset.file, value: cellPreset.value });
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
            // A refusal is cheap to repeat, and the alternative is handing the pair to the lexical fallback:
            // Laya answers `503 server busy` with `Retry-After: 1` at its admission limit and never queues
            // (docs/LAYA_RUNTIME.md §6b), which cost a measured round 39% of its calls. The wait is capped so a
            // burst cannot push a scoring round past the caller's patience, and `retryAttempts: 1` keeps this
            // exactly as it was before the option existed.
            ...(config.s1.retryAttempts > 1
              ? {
                  retry: {
                    maxAttempts: config.s1.retryAttempts,
                    respectRetryAfter: true,
                    fallbackDelayMs: 1000,
                    maxWaitMs: 2000 * config.s1.retryAttempts,
                  },
                }
              : {}),
          })
        : undefined;
    return { backend, client };
  };
  const initial = buildBackend();
  let backend                    = initial.backend;
  let client                       = initial.client;

  ctx.logger?.info(
    `[s1cap] cell=${config.cell} tas=${String(config.tas.on)} tier1=${config.recall.tier1} admissionLimit=${config.s1.admissionLimit} laya=${String(layaConfig.enabled)}`,
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
   * The System-1 scorer, hoisted for the same reason `observer` is: it is constructed inside the
   * enabled-branch and reported by `/s1` outside it. A `const` in the inner block is correct at the construction
   * site and invisible to the status command, which is how a declared-and-constructed component can look present
   * in the log while the counter that would prove it ran cannot be printed.
   */
  let relevance                                                  ;
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
  /**
   * The control log, hoisted out of the observation branch. `preStepMiddleware` is registered after that block
   * and has to write delivery records, and a block-scoped const would simply not be visible there — the same
   * "constructed where it cannot be reached" shape this project keeps meeting.
   */
  let controlLogRef                             ;
  /**
   * The System-1 admission gate, hoisted out of the observation branch for the same reason `controlLogRef` is, and
   * for a reason a test found: it is *created* inside that branch but *read* by the `/s1` status handler, which is
   * registered outside it. Declared in there, `observation: "off"` - a supported configuration - made the status
   * route throw `ReferenceError: backpressure is not defined` instead of answering, and every test that applies the
   * plugin without observation caught it. The object is created only when observation is on, which is the only case
   * that scores anything; a status route reading `undefined` answers `null` for it rather than failing.
   */
  let backpressure                          ;
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
          // Recorded on every record, not only on the interesting ones: a judgement that had to be retried is
          // weaker evidence than one that did not, and a record that cannot say which it was makes a degraded
          // backend indistinguishable from a healthy one.
          attempts: result.attempts ?? 1,
          waitedMs: result.waitedMs ?? 0,
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
      // The client attaches how many attempts it made before giving up, so a refusal that was retried and still
      // failed stays distinguishable from one that was never retried at all.
      const carried = (typeof err === 'object' && err !== null ? err : {})     
                          
                          
       ;
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
          attempts: carried.attempts ?? 1,
          waitedMs: carried.waitedMs ?? 0,
          error: String(err).slice(0, 300),
          ...(backend.baseUrl !== '' ? { endpoint: backend.baseUrl } : {}),
        });
        s1CallFailures += 1;
      } catch (nested) {
        ctx.logger?.warn?.(`[s1cap] s1_call failure record rejected: ${String(nested)}`);
      }
    };
    // One System-1 call per **demanded row**, since scoring became on demand (2026-10-05): the graph hands this
    // scorer one level's rows at a time (`step-observer.ts`'s `scoreDemandedRows`) and a row is `min(index, w)`
    // pairs, i.e. at most `w` = 16 questions against `s1.questionsPerCall` = 20 - one request. The eager reading of
    // this same object was "one call per new segment, scoring the whole window", and that caller is gone. Both are
    // built **unconditionally** and read the current `client` at call time, rather than being built when a client
    // happens to exist. The previous shape — `client === undefined ? undefined : createS1Relevance(...)`, handed to
    // the observer as a snapshot — is what a real three-turn run exposed: the interpreter arrives on the first step
    // and the backend is started by hand after that, so `client` was defined by the time `/s1` reported it and
    // `relevance` was `undefined` anyway. The session then reported a working System-1 backend, scored 66 and 78
    // pairs, and every one of those scores came from the lexical fallback, with `s1CallRecords: 0`. A delegate that
    // answers `undefined` when there is no client is the same thing the missing object meant, so behaviour is
    // unchanged when nothing is configured — `packages/core/src/assoc-graph.ts` treats an `undefined` batch as
    // "score these lexically" (and the demand walk does so locally).
    //
    // One gate per plugin activation, shared by everything that asks this backend (see `s1-backpressure.ts`). It is
    // built here rather than per scorer because the limit is a property of the *backend*: two scorers each holding
    // their own half of the budget would together still exceed it. The binding itself is declared outside this
    // branch, because `/s1` reads it from outside too.
    backpressure = createBackpressure({
      maxInFlight: config.s1.admissionLimit,
      onWarn: (message) => ctx.logger?.warn?.(message),
      // Every state change of the breaker, written the moment it happens.
      //
      // The wiring record alone cannot answer the question this exists for. It is written once, at activation, and
      // the breaker may open three times and close again before the run ends - at which point `stats().state` reads
      // `closed` and the run looks identical to one that never paused. "The run stopped asking because the backend
      // refused" and "because our own cap was full" are different diagnoses of the same zero, so the transitions go
      // on the tape as they happen rather than being reconstructed from a gauge at the end (F4).
      onTransition: (transition) => {
        try {
          probeSink?.write(`${JSON.stringify({ schema: 0, kind: 's1-gate', ...transition })}\n`);
        } catch {
          // A tape line that cannot be written costs a line, never a scoring loop: the same contract the control
          // log carries (`control-log.ts`). The gauges stay readable on `/s1` either way.
        }
      },
    });
    relevance = createS1Relevance({
      decide: async (state, questions, context) => {
        const sessionId = context?.sessionId ?? 'unassigned';
        // No client means no backend to ask, and that is a *state*, not a saturated backend: `undefined` keeps the
        // documented behaviour for it (score this window lexically, once, and move on) rather than deferring a
        // window that has nothing to wait for. Nothing is acquired on this path either - there is no endpoint whose
        // load the gate could be measuring.
        if (client === undefined) return undefined;
        const count = Object.keys(questions).length;
        try {
          const result = await client.decide(state, questions);
          recordS1Call('assoc', 'noul', count, result, sessionId);
          return result;
        } catch (err) {
          // Recorded, then **rethrown**. Returning `undefined` here looked like the same thing - the scorer below
          // turns either into "no weights, use the lexical fallback" - but it destroyed the reason: the scorer's
          // own catch received a `TypeError: cannot read properties of undefined (reading 'answers')` instead of
          // the `S1TimeoutError` that actually happened, so the one line a human reads named the wrong failure.
          // A cancelled caller is reported as a cancellation and is not a reason to re-score lexically; the
          // scorer treats it the same way only because a cancelled batch has no answer to keep.
          recordS1Failure('assoc', 'noul', count, err, sessionId);
          throw err;
        }
      },
      questionsPerCall: config.s1.questionsPerCall,
      // The admission gate. One cell saturated the shared backend by itself in round `20261002-2037` - 5 992
      // requests at 2.70/s over 2 220 s, 64.4 % of them refused, none of them backing off - because the upkeep
      // queue starts several scoring loops per tick and each of them asks for its whole window. The gate caps what
      // this cell may have in flight and stops asking when the backend says no; a window it does not send comes
      // back to the graph as deferred, so its pairs are held rather than bought from the lexical fallback. The gate
      // is consulted inside the scorer, immediately before each request, so a retry is rationed by it too.
      backpressure,
      onWarn: (message) => ctx.logger?.warn?.(message),
    });
    if (client !== undefined) {
      ctx.logger?.info?.(
        `[s1cap] relevance: S1 batch scoring active (${describeS1Backend(backend)}, up to ${config.s1.questionsPerCall} candidates per call, ${config.s1.admissionLimit} request(s) in flight, ${config.s1.retryAttempts} attempt(s) per request)`,
      );
    }
    // There was a plan gate here. It is gone from the policy, the presets, this wiring and the report; the reason
    // and the evidence are in `packages/core/src/types.ts` beside the missing `planGate` field. In short: round
    // `20261002-2037` records no `plan_gate` event in any artifact, because the gate can only read a numbered plan
    // from an assistant message or a `todo/write` session event and the model produced neither. A knob that is on
    // in the wiring and cannot fire makes C2 - the arm whose whole purpose is to be the full configuration - claim
    // an ordering step it never ran.
    observer = createStepObserver({
      policy: config,
      // Every session gets its own graph, and the graph is written to disk as it changes, so "start a new chat"
      // no longer inherits the previous conversation's recall candidates and a restart does not re-pay for
      // scoring the previous process had already bought.
      rgStore,
      scoreBatch: (state, candidates) => {
        // Session attribution travels with each request, including retries and concurrent rows.
        // `relevance` **is** the scorer: `createS1Relevance` returns the batch function itself and hangs `stats`
        // off it (`s1-relevance.ts`: `const relevance = scoreBatch as S1Relevance`). Calling `relevance.scoreBatch`
        // therefore threw `not a function` on every segment, the upkeep catch swallowed it, and the session
        // reported a healthy graph with zero edges, zero `scoredPairs` and zero System-1 calls. Nothing in the
        // toolchain could catch it: the build is type erasure (`stripTypeScriptTypes`) and `typescript` is not
        // installed, so a property that does not exist on the declared type ships silently.
        return relevance === undefined ? Promise.resolve(undefined) : relevance(state, candidates);
      },
      /**
       * The per-sweep pair budget is **gone**, and the measurement that justified it is why it is recorded here
       * rather than deleted silently.
       *
       * `maxPairsPerSweep: 2048` existed because `scoreNew` scored every segment that had arrived since the last
       * call against its whole window, so the first tick of a session with accumulated history offered
       * `segments x w` pairs in one burst - which the backend refused. The measured run, from its own artifacts
       * (`evidence/C2/control.jsonl` and the graph snapshot): **860 672 pairs offered for 4 152 judgements (0.48 %
       * coverage) over 277 steps**, with **3 859 refused calls** in between. The budget bounded a burst that
       * on-demand scoring cannot produce: a walk asks for one level of rows at a time, a row is `min(index, w)`
       * pairs, and the deadline (`recall.anchorWaitMs`) is what bounds how many levels it buys. So the knob is
       * removed rather than kept as a number nothing reads - the failure this repository keeps finding is a
       * parameter that composes, appears in every dump and decides nothing.
       */
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
            onTape: (step        , messages                    , systemPrompt                    , sessionId        ) => {
              tapeSink?.write(
                `${JSON.stringify({
                  schema: 1,
                  // The id of the session this step belongs to, handed in by the observer that just read it. It used
                  // to be the literal 'live', which made a tape from two conversations indistinguishable from one
                  // long one - and separating them after the fact is not possible from a constant.
                  //
                  // It was then read back from `observer?.stats().sessionId`, which is assigned *after* `emit` and
                  // therefore after this callback: every line carried the previous step's id and the first line of
                  // a session carried `unassigned`. Reading a value the caller already has is the fix; there is no
                  // ordering left to get wrong.
                  sessionId,
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
    //
    // Two additions after the audit (`s1cap-audit-lane.md`, F3/F4), both for the same reason: the fields a *later
    // round* needs to read a run it did not watch.
    //
    //   - `configuredProvider` and `conflicts`. A conflict demotes the session to `provider: "none"`
    //     (`buildBackend` above), so `s1` reads `"none"` - the exact string a deliberate no-System-1 control
    //     writes. `cell-report.mjs` reads that string to decide a cell had no lane, which means a C2 whose backend
    //     was demoted by a conflict and a C0 that was configured with no lane printed the same row. The two fields
    //     that tell them apart used to exist only on the live `/s1` route, and `logs/*.log` was found to contain
    //     zero `[s1cap]` lines, so the warning at `:823` was durable nowhere.
    //   - `governance`. `admissionLimit` and the breaker's thresholds are the knobs this pass added, and none of
    //     them appeared in any persisted record: "which knobs actually governed this run" was unanswerable from a
    //     future round's evidence. They are recorded resolved - the breaker's defaults included - so the record is
    //     the authority and not a copy of a default read from a source file that has since changed. **`scoring`
    //     joined them on 2026-10-05 and `maxPairsPerSweep` left**: a run's `scoredPairs` means something different
    //     under eager scoring (the session's arrival order) from under on-demand scoring (what a step's walk asked
    //     for), and nothing else in the artifacts would say which mechanism produced the number.
    const governance = {
      admissionLimit: config.s1.admissionLimit,
      scoring: SCORING_MODE,
      // The values actually in force, not the ones the caller happened to name: a gate built with no
      // `openAfterRefusals` still ran with one.
      breaker: {
        ...(backpressure?.policy() ?? {
          maxInFlight: config.s1.admissionLimit,
          ...BACKPRESSURE_DEFAULTS,
        }),
      },
      contextWindow: CONTEXT_WINDOW_DEFAULT,
      reserveOutputTokens: RESERVE_OUTPUT_DEFAULT,
      fixedOverheadTokens: FIXED_OVERHEAD_DEFAULT,
      // The recall knobs whose *effective* values decide when the recency fallback fires. `minRecalledShare` is
      // documented in three places as the in-force floor and defaults to 0 (off); `minRecalledSegments` is the
      // guard that actually runs and appeared in no document at all (F17). Recorded here so the two cannot be
      // confused again by a reader who only has the run.
      recall: {
        d: config.recall.depth,
        r: config.recall.threshold,
        w: config.recall.window,
        wait: config.recall.anchorWaitMs,
        minRecalledShare: config.recall.minRecalledShare,
        minRecalledSegments: config.recall.minRecalledSegments,
      },
    };
    probeSink?.write(
      JSON.stringify({
        schema: 0,
        kind: 'wiring',
        s1: backend.mode === 'none' ? 'none' : { provider: backend.provider, mode: backend.mode, baseUrl: backend.baseUrl },
        // What the configuration asked for, beside what the session resolved to. Equal means "this cell runs what
        // its recipe says"; different means a conflict demoted it, and `conflicts` carries the reason. A reader who
        // sees `s1: "none"` must be able to tell which of the two they are looking at without a live instance.
        configuredProvider: config.s1.provider,
        // **Which JSON this cell's policy came from, and which of its fields the run used.** Before this line a
        // round that read a preset and a round that read none wrote byte-identical wiring records, which is the
        // whole reason `recall.threshold: 0.6` could sit in `bench/cells/C2.json` through a round that ran 0.55:
        // the authority on "what did this cell run" could not see the file the cell was supposed to be configured
        // by. `fromPreset` is every dotted path the preset supplied; `overridden` is those the profile patch then
        // replaced, and a non-empty `overridden` is the case where the two layers disagreed on purpose.
        cellPreset: lastCellPreset(),
        conflicts: resolved.conflicts,
        relevance: client !== undefined,
        // No `planGate` key: the policy field is gone, and a wiring record that still announced one would be the
        // exact artifact this removal exists to stop producing - a run stating a component it does not have.
        //
        // **The paper's axis, under the paper's name, and the only layout axis (2026-10-05).** This key was
        // `xFirst: boolean`, read as "the paper's variable" while it actually moved the question; the recorded
        // layouts say what that cost - `pinned, stateProxy, anchor, recalled, tail` in every cell, a question in the
        // middle of the prompt that neither of the paper's arms has. `tracePlacement` is the same statement made
        // precisely: `'trace-as-state'` (`M([T, x, q])`, the method) or `'trace-append'` (`M([x, T, q])`, the
        // control). A round read through the old key is still readable - the boolean mapped one-to-one onto the
        // question's position - but what a round *records* has changed, so a reader comparing this tape with one
        // from before this date has to compare `tracePlacement`, not `xFirst`.
        //
        // **No `questionPlacement` beside it, and that is the deletion rather than a gap.** The question is the last
        // block of `layoutOrder` in every assembly this build produces (the paper: "place it at the end of every
        // input"), so a field recording where it sits would record one value forever; the axis itself could produce
        // `[T, q, x]`, a layout the paper does not have, and it has been removed from the policy rather than renamed.
        // A tape recorded before 2026-10-05 still carries either spelling, and `layoutOrder` is beside both - the
        // order is what a reader compares. A profile or a stored file that still spells the old key is read and
        // reported: `xFirst: true` / `questionPlacement: 'first'` are refused with the sentence that retired them
        // (`LEGACY_LAYOUT_KEYS`, packages/core/src/config.ts), and the question-last spellings are noted.
        tracePlacement: config.tracePlacement,
        // `deliver`, because "which cells actually deliver" has to be answerable from a round's own artifacts and
        // nothing else stated it. `verify-wiring.mjs` asserts `tas.on`/`xFirst` and stops there, so a run could not
        // prove its own arms: C0 leaves delivery off by choice (it is the baseline - the harness manages history),
        // and C1 leaves recall selection off and the System-1 lane absent, so its channel carries the state proxy
        // T alone - the paper's arm - while C2 delivers T ahead of the turns S1 selected. The
        // three are indistinguishable from every other field in this record. Beside `configuredProvider` and
        // `conflicts` for the reason those two are here: the record is the authority for a later reader who has the
        // cell's recipe and not the process that ran it. **Note, 2026-10-05: `verify-wiring.mjs` still reads the
        // renamed `xFirst` key and its replacement, so its layout assertion now finds neither — a `scripts/` file,
        // reported rather than edited from here.**
        deliver: config.deliver,
        // `assemblyTrigger`, for the reason `deliver` is here and one more: `deliver` says whose assembled view
        // reaches the model, and this says *which steps are assembled at all*. The two are the switch pair a
        // round that flips this value has to be able to read back, and neither is inferable from the other - a
        // `'claimed-only'` cell and an `'every-step'` cell deliver the same message when they deliver, and differ
        // in how many steps ever had the chance. It is also the field that makes the flip auditable: no cell sets
        // it, so a round that reads anything other than the default from here moved a variable on
        // purpose. `verify-wiring.mjs` asserts `tas.on`/`xFirst`/`deliver` and does not yet assert this one; the
        // tape is the record either way, and `packages/dsh-plugin/test/config.test.ts` pins the value this
        // process writes for all three cells.
        assemblyTrigger: config.assemblyTrigger,
        // `tier1` is in here because leaving it out made the one knob that decides *how* candidates are generated
        // unreadable from every persisted artifact: the startup log line was the only place it appeared, and a
        // round's reader had the cell's recipe and not the value an instance resolved (F6).
        recall: {
          d: config.recall.depth,
          r: config.recall.threshold,
          w: config.recall.window,
          wait: config.recall.anchorWaitMs,
          tier1: config.recall.tier1,
          deliveryMaxTokens: config.recall.deliveryMaxTokens,
          deliveryMaxSegments: config.recall.deliveryMaxSegments,
        },
        tas: config.tas,
        // **`tail` and the two `s1` knobs a preset supplies, added 2026-10-05 so the record covers every path the
        // presets write.** Each of the three presets carries `tail: {k: 3}` and `s1.questionsPerCall`, and C2 also
        // carries `s1.retryAttempts`; none of the three values appeared anywhere in this record. `cellPreset
        // .fromPreset` named the paths, so a reader could see that *something* supplied them — but not what, which is
        // the same half-statement this record exists to avoid. The check is mechanical: every leaf
        // `bench/cells/<cell>.json` writes has a field here, and `packages/dsh-plugin/test/config.test.ts` walks that
        // list against this object so a preset path added later without a line here fails the suite instead of
        // disappearing from the authority.
        tail: config.tail,
        s1Knobs: {
          questionsPerCall: config.s1.questionsPerCall,
          retryAttempts: config.s1.retryAttempts,
          // **The model the lane was configured with, which no record carried until 2026-10-05.** It became a preset
          // path the day C2 moved to the hosted lane (`bench/cells/C2.json` -> `s1.model: "jev-latest"`), and the test
          // that walks every preset leaf against this record failed on it: a value that reached the session and no
          // artifact, which is the gap that test exists to catch. The per-call records carry the model the deployment
          // *answered* with (`routedModel`, e.g. `jev-1.13.0`); this is the one that was asked for, and the two are
          // not the same statement.
          model: config.s1.model,
        },
        governance,
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
      const fromTuning = parseTuning(tuningRead.key);
      const fromFile = readTuningFile();
      // A stored file (or a stored credential string) that still carries the question's old slot says so here, at
      // activation, in the loudest channel this plugin has: a refusal is an error line, and a retirement note is a
      // warning. Silence is the failure mode both sentences exist to prevent — a layout setting that resolves to
      // nothing looks identical, from the panel, to one that was applied.
      //
      // The two readings are *replaced* on every read rather than merged in: they describe the file as it stands, so
      // a stale refusal must not outlive the file that earned it (that is what `refused: undefined` below does —
      // `JSON.stringify` drops the key, so `/s1` and the panel report nothing rather than an old sentence).
      const refusals = [...(fromTuning.refused ?? []), ...(fromFile.refused ?? [])];
      const notesRead = [...(fromTuning.notes ?? []), ...(fromFile.notes ?? [])];
      for (const refusal of refusals) ctx.logger?.error?.(`[s1cap] recalled tuning refused: ${refusal.message}`);
      for (const note of notesRead) ctx.logger?.warn?.(`[s1cap] ${note}`);
      appliedTuning = {
        ...fromTuning,
        refused: refusals.length > 0 ? refusals : undefined,
        notes: notesRead.length > 0 ? notesRead : undefined,
      };
      if (fromFile.depth !== undefined) appliedTuning.depth = fromFile.depth;
      if (fromFile.relevanceThreshold !== undefined) appliedTuning.relevanceThreshold = fromFile.relevanceThreshold;
      if (fromFile.window !== undefined) appliedTuning.window = fromFile.window;
      if (fromFile.anchorWaitMs !== undefined) appliedTuning.anchorWaitMs = fromFile.anchorWaitMs;
      if (fromFile.tracePlacement !== undefined) appliedTuning.tracePlacement = fromFile.tracePlacement;
      if (fromFile.layaPythonPath !== undefined) appliedTuning.layaPythonPath = fromFile.layaPythonPath;
      if (fromFile.layaWeightsCacheDir !== undefined) appliedTuning.layaWeightsCacheDir = fromFile.layaWeightsCacheDir;
      if (fromFile.layaWeightsEnvVar !== undefined) appliedTuning.layaWeightsEnvVar = fromFile.layaWeightsEnvVar;
      if (fromFile.provider !== undefined) appliedTuning.provider = fromFile.provider;
      // The cell preset values before the volatile layer touches them. A tuning file written during one live test
      // silently overrode the cell it was not part of: C2 ran with window=1200 for an entire verification session -
      // and nothing in any counter said so. The override itself is right (the panel owns these knobs), but a
      // *silent* one deforms an ablation run invisibly, which is this project's dominant failure mode. Say it out
      // loud at activation, and tell the reader how to get a cell-pure run.
      const cellBefore = {
        depth: config.recall.depth,
        relevanceThreshold: config.recall.threshold,
        window: config.recall.window,
        anchorWaitMs: config.recall.anchorWaitMs,
        tracePlacement: config.tracePlacement,
      };
      if (appliedTuning.depth !== undefined) config.recall.depth = appliedTuning.depth;
      if (appliedTuning.relevanceThreshold !== undefined) config.recall.threshold = appliedTuning.relevanceThreshold;
      if (appliedTuning.window !== undefined) config.recall.window = appliedTuning.window;
      if (appliedTuning.anchorWaitMs !== undefined) config.recall.anchorWaitMs = appliedTuning.anchorWaitMs;
      // The arm itself, and the only layout setting a stored file can carry. No cell preset carries a
      // `tracePlacement` (see `cellPolicy`), so this line is the only way a live session can be moved to the paper's
      // control arm without editing a profile - and it is logged as a deviation below, because that is exactly what
      // it is. The question's position is not settable here or anywhere: the paper fixes it last, `q` is the last
      // block by construction, and the spellings that used to write it are refused or noted above.
      if (appliedTuning.tracePlacement !== undefined) config.tracePlacement = appliedTuning.tracePlacement;
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
      for (const knob of ['depth', 'relevanceThreshold', 'window', 'anchorWaitMs', 'tracePlacement']         ) {
        const after =
          knob === 'depth'
            ? config.recall.depth
            : knob === 'relevanceThreshold'
              ? config.recall.threshold
              : knob === 'window'
                ? config.recall.window
                : knob === 'anchorWaitMs'
                  ? config.recall.anchorWaitMs
                  : config.tracePlacement;
        if (after !== cellBefore[knob]) {
          ctx.logger?.warn?.(
            `[s1cap] tuning overrides the running cell: ${knob} ${String(cellBefore[knob])} -> ${String(after)} ` +
              `(delete the tuning file for a cell-pure run)`,
          );
        }
      }
      probeSink?.write(JSON.stringify({ schema: 0, kind: 'tuning-file', read: fromFile, effective: { depth: config.recall.depth, relevanceThreshold: config.recall.threshold, window: config.recall.window, anchorWaitMs: config.recall.anchorWaitMs, tracePlacement: config.tracePlacement, provider: config.s1.provider } }) + '\n');
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
  // The delivery path, wired once. `config.deliver` is the cell's own switch, and **the baseline leaves it
  // off**: C0 by choice - it is the baseline, and letting the harness manage history is what makes it one.
  // C1 and C2 both deliver. What differs between them is what the one injected message carries: with
  // `recall.tier1: 'off'` C1 selects no turns, so its message is the state proxy `T` alone, which is the paper's
  // arm; C2 puts `T` ahead of the turns S1 selected. Note what is *not* claimed: the channel appends, so the
  // recorded order `T`-before-context is not what either cell delivers - placement is the write-back's job.
  // The three are
  // stated on the wiring record (`deliver: config.deliver`) precisely because this comment is not evidence: a round
  // has to prove its own arms from its own artifacts. When delivery is off, `deliverContext` answers "not
  // delivered" with the reason, so a cell that assembles a layout nobody receives says so in the control plane
  // instead of looking identical to one that delivers.
  //
  // `assemblyTrigger` is the second switch on this path and it comes before `deliver` in the order of effects:
  // it decides which steps are assembled, `deliver` decides whether what was assembled is inserted. Both are on
  // the wiring record for the same reason: `assemblyTrigger` defaults to the brief's `'every-step'`, and `deliver`
  // to `false` unless the cell says otherwise.
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
      // The other half of the N6 switch pair, and it reaches the delivery module as well: `'every-step'` is what
      // makes the end-insertion branch reachable for an empty decision (`context-delivery.ts`), so the flag that
      // decides whether the walk runs and the flag that decides whether the block may land must be one value.
      // Nothing in this repository sets it to `'every-step'`: no cell, no preset, no profile. A round flips it in
      // one profile patch, which is what makes the flip one variable.
      assemblyTrigger: config.assemblyTrigger,
      selectContext: (built, payload) => {
        if (!config.deliver || config.recall.tier1 !== 's1' || observer === undefined) return;
        const rejected = observer.rejectedChunks?.(built.event.sessionId, built.layout.anchor.id) ?? [];
        const result = selectToolContext(payload, built, rejected, config.tail.k);
        observer.probe({ schema: 0, kind: 'context-selection', sessionId: built.event.sessionId,
          anchor: built.layout.anchor.id, rejectedChunks: rejected.length, ...result });
      },
      deliver: (built, decision, payload, visibleMessages) =>
        deliverContext({
          visibleMessages,
          recallMaxTokens: config.recall.deliveryMaxTokens,
          recallMaxSegments: config.recall.deliveryMaxSegments,
          enabled: config.deliver,
          trigger: config.assemblyTrigger,
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
  const applyTuning = (parsed        )                                                                                                                                            => {
    // **A refusal is answered before anything is applied.** `parseTuningArgs` returns `refused` when a spelling asked
    // for the question in front of the long context — the deleted layout axis — and a save carrying one is refused
    // whole: coercing it would run a layout nobody asked for, and ignoring it would leave a command line that asks
    // for a deleted layout beside a session that silently ran another. The sentences are the parser's own
    // (`credentials.ts`), so the command line, the panel's PUT and the stored file report the same thing. An applied
    // save carries `notes` back instead: the legacy spellings that asked for the question *last*, which is what
    // every layout does now, and which are worth one sentence rather than a refusal.
    if (parsed.refused !== undefined && parsed.refused.length > 0) {
      const reason = parsed.refused.map((r) => r.message).join(' ');
      for (const refusal of parsed.refused) ctx.logger?.error?.(`[s1cap] tuning refused: ${refusal.message}`);
      return { ok: false, reason };
    }
    const layaOnly =
      parsed.layaPythonPath === undefined &&
      parsed.layaWeightsCacheDir === undefined &&
      parsed.layaWeightsEnvVar === undefined;
    if (
      parsed.depth === undefined &&
      parsed.relevanceThreshold === undefined &&
      parsed.window === undefined &&
      parsed.anchorWaitMs === undefined &&
      parsed.tracePlacement === undefined &&
      parsed.provider === undefined &&
      layaOnly
    ) {
      return {
        ok: false,
        reason:
          'nothing to set: depth d must be an integer 1..16, threshold r between 0 and 1, window w an integer >= 4, wait an integer 0..60000 (0 disables the anchor wait), trace=trace-as-state|trace-append (the paper\'s two arms, and the only layout axis), provider=jev|laya-serve|none (none makes no System-1 calls), or a Laya field (laya=, weights=, layaWeightsEnvVar=). The question\'s position is not settable: the paper places it last in every condition, so q=last / xFirst=off are read and noted, and q=first / xFirst=on are refused',
      };
    }
    // The readings (`refused`/`notes`) are replaced rather than merged: they describe the command line that was just
    // parsed, and a save that says nothing about the question must clear the sentence an earlier save earned.
    appliedTuning = { ...appliedTuning, ...parsed, refused: parsed.refused, notes: parsed.notes };
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
    // The arm, and the only layout setting this path can change. `questionPlacement` is deleted, not merely
    // unsettable here: the spellings that used to write it are refused at the parser (`refused`, above) or noted.
    if (parsed.tracePlacement !== undefined) config.tracePlacement = parsed.tracePlacement;
    const persist = writeTuningFile(appliedTuning);
    const persisted = persist.ok;
    ctx.logger?.info?.(
      `[s1cap] recall tuning: provider=${config.s1.provider} depth=${config.recall.depth} relevanceThreshold=${config.recall.threshold} window=${config.recall.window} anchorWaitMs=${config.recall.anchorWaitMs} tracePlacement=${config.tracePlacement}${persisted ? '' : ' (not persisted: file write failed)'}`,
    );
    for (const note of parsed.notes ?? []) ctx.logger?.warn?.(`[s1cap] ${note}`);
    return {
      ok: true,
      effective: {
        depth: config.recall.depth,
        relevanceThreshold: config.recall.threshold,
        window: config.recall.window,
        anchorWaitMs: config.recall.anchorWaitMs,
        tracePlacement: config.tracePlacement,
        provider: config.s1.provider,
      },
      persisted,
      ...(persist.ok ? {} : { persistError: persist.error }),
      ...((parsed.notes?.length ?? 0) > 0 ? { notes: parsed.notes } : {}),
    };
  };
  registerCommands(ctx, [
    {
      name: 's1-tune',
      description:
        'S1CAP: set the recall/layout knobs — BFS depth d (1..16), relevance threshold r (0..1), S1 window w (>= 4), anchor wait in ms (0 disables), trace=state|append (the paper\'s Trace as State / Trace Append arm, and the only layout axis — the question is last in every layout, so q=/xFirst= are read only to be refused or noted) — the backend (provider=jev|laya-serve|none, where none turns System-1 off) and the Laya fields (laya=, weights=, layaWeightsEnvVar=)',
      input: {
        hint: 'd r w   (e.g. "3 0.7 512", or "d=3", "r=0.7", "w=512", "wait=10000", "trace=append", "provider=laya-serve", "provider=none", or laya="D:/conda/envs/ml/python.exe")',
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
              `window=${String(eff?.window)} wait=${String(eff?.anchorWaitMs)} ` +
              `trace=${String(eff?.tracePlacement)}`;
        return commandSuccess(
          backendPart +
            ' ' +
            layaPart +
            (outcome.persisted === true ? ' (persisted)' : ` (in effect, NOT persisted: ${outcome.persistError ?? 'unknown'})`) +
            // The retirement notes ride on the answer rather than only in the log: they are about the token the user
            // just typed (`q=last`, `xFirst=off`), and a note in a log the command line cannot show would be the
            // silent reinterpretation it exists to prevent.
            ((outcome.notes?.length ?? 0) > 0 ? ` — ${outcome.notes.join(' ')}` : ''),
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
          /**
           * The knobs this build accepts, composes, prints - and does not enforce, with what each one claims and
           * what it would take to make the claim true.
           *
           * Reported on the live route because this is where a reader asks "is this thing running what it says":
           * `assemblyDeadlineMs` (nothing enforces a deadline), `cache.reselectPolicy` / `cache.blockTokens` (no
           * caller for `decideReselect` / `alignToCacheBlocks`), `rgMaintenance.maxLagTurns` (compared against a
           * count of pending *events* and acted on by nothing) and `recall.tier1` (no embedder exists, so `'embed'`
           * and `'s1'` select identically). The registry lives in `@s1cap/core` `config.ts` and a core test fails
           * if it drifts from the declarations, so this block cannot silently go stale - which is the defect it
           * exists to remove: the plan gate was carried by the full-configuration cell and read by nothing, and
           * three of these five survived the pass that deleted it.
           */
          unenforcedKnobs: UNENFORCED_KNOBS,
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
              tracePlacement: config.tracePlacement,
              // The provider the radio selected, reported beside the knobs for the same reason they are: it is a
              // value this panel owns now, and "what did the save actually set" must be answerable from `/s1`.
              provider: config.s1.provider,
            },
            keySource: credentialSource,
          },
          tail: config.tail,
          // The arm, top-level because it is policy rather than panel state: a reader asking "which of the paper's
          // two conditions is this session running" gets the answer from one place, and `layout.order` on each
          // assembly says the same thing in the layout's own words. It is the **only** layout field here — the
          // question's position is not reported because it is not a setting: `q` is the last block of every layout
          // by construction, and a reader who wants that fact reads it from `layoutOrder`/`layout.order`, which ends
          // in `anchor` in every assembly this build produces.
          tracePlacement: config.tracePlacement,
          // The switch that decides whether the model view reaches the model, and beside it the switch that
          // decides which steps are assembled at all (`packages/core/src/types.ts`). `/s1` is where a live reader
          // asks which of the two is in force, and both are on the wiring record as well.
          deliver: config.deliver,
          assemblyTrigger: config.assemblyTrigger,
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
            // How many requests this cell may have in flight, and what the gate has actually done with that
            // budget. `relevance.stats().blocked` says how many windows were held back; this says whether the
            // reason was the in-flight cap or an open breaker, and whether the backend has since answered again.
            // Without it, the blocked count alone cannot distinguish "this cell is at its own limit" from "the
            // backend is refusing everything" - the two situations the measured run could not tell apart either.
            admissionLimit: config.s1.admissionLimit,
            // `null` when observation is off: nothing scores, so there is no gate to report. A status route that
            // threw here instead would take `/s1` down for a configuration the plugin supports.
            backpressure: backpressure?.stats() ?? null,
          },
          // The interpreter is reported here and not only on the panel's route: "which python will this run
          // use" is a question an operator asks at the command line, and `runtime.summary()` answers everything
          // about the *server* and nothing about the environment it would be launched from. A run that fell
          // back to a different interpreter, or to none, was invisible from `/s1` entirely.
          laya: { ...runtime.summary(), pythonPath: layaConfig.pythonPath ?? null },
          // Each component reports its own counters, because "constructed" and "called" are different states and
          // only the counters can tell them apart. `relevance.calls` is the number that says whether the System-1
          // path ran at all in this process; `relevance.blocked` is the one that says whether the run stopped
          // asking, and `backpressure` under `s1` says why. There is no `planGate` entry: the component is gone.
          relevance: relevance?.stats() ?? null,
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
   * make (docs/STATUS-ARCHIVE.md rounds 33-41) - while the route needs nothing beyond the service the UI already
   * runs on.
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
    // The stored file is the surface a stale layout setting survives longest on, because it outlives the process
    // that wrote it: a `tuning.json` from before 2026-10-05 can still carry `questionPlacement` or `xFirst`. Both are
    // read (`readTuningFile`), and both are said here — a refusal at `error`, a retirement note at `warn` — so a
    // session that inherits a deleted layout setting says so at activation instead of looking cell-pure. As in
    // `primeOnce`, the two readings are replaced rather than merged: they describe the file, not the session.
    appliedTuning = { ...appliedTuning, ...storedNow, refused: storedNow.refused, notes: storedNow.notes };
    for (const refusal of storedNow.refused ?? []) {
      ctx.logger?.error?.(`[s1cap] recalled tuning refused: ${refusal.message}`);
    }
    for (const note of storedNow.notes ?? []) ctx.logger?.warn?.(`[s1cap] ${note}`);
    if (storedNow.depth !== undefined) config.recall.depth = storedNow.depth;
    if (storedNow.relevanceThreshold !== undefined) config.recall.threshold = storedNow.relevanceThreshold;
    if (storedNow.window !== undefined) config.recall.window = storedNow.window;
    if (storedNow.anchorWaitMs !== undefined) config.recall.anchorWaitMs = storedNow.anchorWaitMs;
    if (storedNow.tracePlacement !== undefined) config.tracePlacement = storedNow.tracePlacement;
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
              // here first, and both failed silently or loudly in instructive ways: reading a top-level
              // `config.<field>` reported nothing at all for a cell-pure run (the override slot is empty exactly
              // when the cell is in charge), and reading `config.policy` 500s, because that field belongs to the
              // validation result and not to the config.
              const effective = resolved.policy.policy;
              sendJson(res, 200, {
                ok: true,
                // `stored` carries the readings as well as the settings — `refused` and `notes` are what a legacy
                // question-axis spelling in the file earned (`credentials.ts`), so the panel can show that the file
                // it just read asked for something this build does not have. They are not settings and are never
                // written back (`writeTuningFile` projects the value fields only).
                stored: { ...readTuningFile(), ...appliedTuning },
                effective: {
                  depth: config.recall.depth,
                  relevanceThreshold: config.recall.threshold,
                  window: config.recall.window,
                  anchorWaitMs: config.recall.anchorWaitMs,
                  tracePlacement: effective.tracePlacement,
                  // The provider the radio selected, so the GET answers the same shape the PUT echoes back and the
                  // panel can fill the radio from the same place it fills the knobs.
                  provider: config.s1.provider,
                },
                status: {
                  cell: config.cell,
                  tas: effective.tas.on,
                  tier1: config.recall.tier1,
                  deliver: effective.deliver,
                  assemblyTrigger: effective.assemblyTrigger,
                  // The arm, and the only layout field: the question's position is not a setting any more, so a
                  // reader who needs it reads `layoutOrder` from an assembly record — where it ends in `anchor` in
                  // every record this build writes.
                  tracePlacement: effective.tracePlacement,
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
