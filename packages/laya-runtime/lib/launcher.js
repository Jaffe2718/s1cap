/**
 * Laya server launcher: resolve the launch command, spawn it, wait for
 * `GET /v1/models`, and shut it down again.
 */
                                             
import { layaBaseUrl } from './types.js';

                                                                     

                                 
               
                                                                 
                                 
                                                                            
                                                                            
 

                             
                                                                                                                 
                          
                                   
                
                                             
                    
     
                                                                                                             
                                                                                                                
                                                                 
     
                                                   
 

                             
                  
                 
                              
               
 

/**
 * Path of the `laya-serve` console script for a given interpreter.
 * Windows environments keep the interpreter at `<env>/python.exe` and scripts in
 * `<env>/Scripts`; POSIX environments keep both in `<env>/bin`.
 */
export function consoleScriptPath(pythonPath        , platform        )         {
  const dir = pythonPath.replace(/[\\/][^\\/]+$/, '') || pythonPath;
  return platform === 'win32' ? `${dir}\\Scripts\\laya-serve.exe` : `${dir}/laya-serve`;
}

/**
 * Build the launch plan.
 *
 * Verified against `laya 0.3.21` (`laya/serve.py`): `laya-serve` takes **no CLI
 * arguments** — host, port, device, preload list and thread caps are read from the
 * environment (`LAYA_HOST`, `LAYA_PORT`, `LAYA_DEVICE`, `LAYA_MODELS`, `LAYA_THREADS`,
 * `LAYA_PRELOAD`, `LAYA_AUTO_TASK`, `LAYA_MAX_LOADED`, `LAYA_MAX_CONCURRENT`,
 * `LAYA_MAX_TOKEN_BUDGET`, `LAYA_API_KEY`, `LAYA_LOG_LEVEL`). Host and port are
 * therefore injected as environment variables only; `serveArgs` stays available for
 * releases that do accept flags.
 */
/** The variable name used when the config does not name one. A convention, and configurable for that reason. */
export const DEFAULT_WEIGHTS_ENV_VAR = 'HF_HOME';

/** The cache S1CAP owns when the config does not choose one: under its own data directory, never the user's home. */
export const DEFAULT_WEIGHTS_CACHE_DIR = './.s1cap/laya-cache';

export function weightsCacheDir(cfg            )         {
  return cfg.weightsCacheDir !== undefined && cfg.weightsCacheDir !== '' ? cfg.weightsCacheDir : DEFAULT_WEIGHTS_CACHE_DIR;
}

export function weightsEnvVar(cfg            )         {
  return cfg.weightsEnvVar !== undefined && cfg.weightsEnvVar !== '' ? cfg.weightsEnvVar : DEFAULT_WEIGHTS_ENV_VAR;
}

export function buildLaunchPlan(
  cfg            ,
  pythonPath        ,
  platform        ,
  hasConsoleScript         ,
)             {
  const env                         = {
    ...(cfg.env ?? {}),
    LAYA_HOST: cfg.host,
    LAYA_PORT: String(cfg.port),
  };
  // Where the checkpoints go, so the user is not asked to place or download them: the environment fetches them
  // on first start and writes them here. A value the user put in `env` under this same name wins, because an
  // explicit value must never be overwritten by a default - the same precedence every other override here has.
  const cacheVar = weightsEnvVar(cfg);
  if (env[cacheVar] === undefined) env[cacheVar] = weightsCacheDir(cfg);
  const extraArgs = cfg.serveArgs ?? [];
  const plan             = { command: pythonPath, args: extraArgs, env };
  if (cfg.cwd) plan.cwd = cfg.cwd;

  if (cfg.serveCommand) {
    return { ...plan, command: cfg.serveCommand };
  }
  if (cfg.preferConsoleScript && hasConsoleScript) {
    return { ...plan, command: consoleScriptPath(pythonPath, platform) };
  }
  return { ...plan, args: ['-m', 'laya', 'serve', ...extraArgs] };
}

                              
              
                  
                 
 

/**
 * How long one readiness poll may stay silent before its socket is treated as dead.
 *
 * ## The defect this bound exists for
 *
 * `waitForReady` called `this.#deps.fetchImpl(url)` with no signal and swallowed each poll's error. A backend that
 * *refuses* the connection fails in microseconds, so every poll returned, the loop always got back to
 * `while (this.#deps.now() < deadline)`, and `startupTimeoutMs` looked like a budget. A backend that *accepts* and
 * then never answers is the other case: the poll stays open for ever, the loop is parked on an `await` that never
 * returns, and the deadline it exists to compare against can never be read again. The startup timeout therefore did
 * not exist for that backend and `start()` never returned.
 *
 * The guard has to cover the whole exchange rather than the `fetch` call, which is why `#poll` takes a callback:
 * `fetch` resolves as soon as the *headers* arrive, so a hook around the call alone is disarmed at the headers and
 * a socket that stalls mid-body still hangs whatever reads the body. Nothing here reads a body today - the poll
 * asks `res.ok` and stops - and the callback is what keeps that from mattering the first time something does.
 *
 * ## Why this is a per-poll cap and not the loop's budget
 *
 * The loop already has `startupTimeoutMs` - 120 s by default, 600 s from `packages/laya-runtime/scripts/smoke.ts` -
 * and the caller clamps this cap by what is left of it (`Math.min(remaining, LAYA_POLL_TIMEOUT_MS)`), so the
 * constant decides only *how often the loop re-asks*, never how long the loop may take. The asymmetry is the whole
 * argument for a small number: a cap that is too small costs one more retry of a loop that was going to retry
 * anyway, while a cap that is too large *is* the hang.
 *
 * ## The number
 *
 * 5 000 ms, the same bound `@s1cap/s1-client` puts on `health()`/`models()` (`S1_PROBE_TIMEOUT_MS`) - the same
 * endpoint and the same question, so the two must not disagree about what silence means. It is not imported from
 * there: this package declares no dependencies at all (`packages/laya-runtime/package.json`) and that helper is
 * private, so a five-line guard with its twin named is cheaper than an undeclared cross-package import.
 *
 * The measured round trip of `/health` against the local server is 18 ms, so 5 s is 278x a legitimate answer. The
 * case that legitimately takes minutes is not silent either: with `LAYA_PRELOAD=1` the checkpoints are built
 * *before* uvicorn binds the port, so those polls are refused instantly rather than left hanging
 * (docs/LAYA_RUNTIME.md §6). A socket silent for five seconds is a wedged socket - and at 5 s per path, eleven
 * rounds still fit inside the default 120 s budget, so a backend that answers on the second ask is still found. If
 * `/health` ever moves behind the inference path, the soaked one-question figure quoted on the s1-client probe
 * (about 13 s) is what falsifies this number, and the fix is this number.
 */
export const LAYA_POLL_TIMEOUT_MS = 5_000;

/**
 * A poll that was cut off at its bound: `LAYA_POLL_TIMEOUT_MS`, or whatever was left of `startupTimeoutMs`.
 *
 * The classification mirrors `S1TimeoutError` in `@s1cap/s1-client`: the signal that fired is this file's own, so
 * an abort *is* the deadline and not a caller cancelling. `waitForReady` deliberately treats it as one more "not up
 * yet" and asks again, so nothing branches on the type today; it exists so that a silent socket stays
 * distinguishable from a refused one in a stack trace or for a caller that later needs to tell them apart.
 */
export class LayaPollTimeoutError extends Error {
           timeoutMs        ;
  constructor(timeoutMs        ) {
    super(`no answer within ${timeoutMs}ms`);
    this.name = 'LayaPollTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export class LayaServer {
  #cfg            ;
  #deps            ;
  #child                 ;
  #state             = 'stopped';
  #error         ;
  #logs           = [];

  constructor(cfg            , deps            ) {
    this.#cfg = cfg;
    this.#deps = deps;
  }

  get status()             {
    return this.#state;
  }

  get error()                     {
    return this.#error;
  }

  get logs()                    {
    return this.#logs;
  }

  get baseUrl()         {
    return layaBaseUrl(this.#cfg);
  }

  get pid()                     {
    return this.#child?.pid;
  }

  #record(chunk         )       {
    const text = typeof chunk === 'string' ? chunk : String(chunk);
    for (const line of text.split(/\r?\n/)) {
      if (line.trim().length === 0) continue;
      this.#logs.push(line.trim());
    }
    if (this.#logs.length > 50) this.#logs.splice(0, this.#logs.length - 50);
  }

  /** Spawn the server and wait until it answers on /v1/models. */
  async start(pythonPath        )                       {
    const baseUrl = this.baseUrl;
    if (!this.#cfg.enabled) {
      this.#state = 'stopped';
      return { ok: false, baseUrl, error: 'laya backend is disabled in the plugin config' };
    }
    if (this.#child) return { ok: true, baseUrl };

    const platform = this.#deps.platform ?? process.platform;
    const hasConsole = await this.#deps.fileExists(consoleScriptPath(pythonPath, platform));
    const plan = buildLaunchPlan(this.#cfg, pythonPath, platform, hasConsole);
    this.#state = 'starting';
    this.#error = undefined;
    this.#logs = [];

    try {
      this.#child = this.#deps.spawn(plan.command, plan.args, {
        // The parent environment, with the plan's values laid over it. Passing `plan.env` alone is what the first
        // version did, and the backend started and then could not reach the Hugging Face Hub:
        // `LocalEntryNotFoundError` after fifty lines of progress bars, while the same command with the same
        // interpreter downloaded the checkpoint when a person ran it. The difference was the whole environment -
        // no PATH, no proxy, no certificate variables, no SystemRoot, none of which the plan mentions and all of
        // which a TLS connection needs. The plan stays a pure description of *overrides*; inheritance happens
        // here, at the one place that knows there is a parent.
        env: { ...(this.#deps.parentEnv?.() ?? {}), ...plan.env },
        ...(plan.cwd ? { cwd: plan.cwd } : {}),
      });
    } catch (err) {
      this.#state = 'failed';
      this.#error = `spawn failed: ${(err         ).message}`;
      return { ok: false, baseUrl, error: this.#error };
    }

    this.#child.stdout?.on('data', (chunk) => this.#record(chunk));
    this.#child.stderr?.on('data', (chunk) => this.#record(chunk));
    this.#child.on('exit', (code) => {
      if (this.#state === 'ready' || this.#state === 'starting') {
        this.#state = 'failed';
        this.#error = `laya-serve exited (code ${String(code ?? 'unknown')})`;
      }
      this.#child = undefined;
    });
    this.#child.on('error', (err) => {
      this.#state = 'failed';
      this.#error = `laya-serve error: ${String(err)}`;
    });

    const ready = await this.waitForReady();
    if (ready) {
      this.#state = 'ready';
      return { ok: true, baseUrl };
    }
    this.#state = 'failed';
    this.#error = this.#error ?? `timed out after ${this.#cfg.startupTimeoutMs}ms waiting for ${baseUrl}${this.#cfg.healthPath}`;
    return { ok: false, baseUrl, error: this.#error };
  }

  /**
   * Run one readiness poll under a bound. The twin of `S1Client.#probe` in `@s1cap/s1-client`, which cannot be
   * imported for the reasons on `LAYA_POLL_TIMEOUT_MS`: one controller, one timer, the **body read** inside the
   * guard as well as the request, `AbortError` classified as a timeout, and the timer cleared on every path.
   */
  async #poll(run                                            , budgetMs        )                    {
    const guard = new AbortController();
    const timer = setTimeout(() => guard.abort(), budgetMs);
    try {
      return await run(guard.signal);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw new LayaPollTimeoutError(budgetMs);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Poll the readiness endpoint until it answers or the startup timeout expires. */
  async waitForReady()                   {
    const deadline = this.#deps.now() + this.#cfg.startupTimeoutMs;
    // Laya exposes GET /health; Jev-style deployments expose GET /v1/models.
    const paths = [this.#cfg.healthPath, '/v1/models'];
    while (this.#deps.now() < deadline) {
      if (this.#state === 'failed') return false;
      for (const path of paths) {
        // Both bounds are needed and they do different jobs. `remaining` is what makes `startupTimeoutMs` true
        // end-to-end: without it a single silent poll could outlive the deadline, and a `while` that is parked on
        // that poll cannot notice. `LAYA_POLL_TIMEOUT_MS` is what keeps the loop a loop: left to `remaining` alone,
        // the first poll of a 600 s run would sit silent for ten minutes on a socket that will never answer.
        const remaining = deadline - this.#deps.now();
        if (remaining <= 0) return false;
        try {
          const res = await this.#poll(
            (signal) => this.#deps.fetchImpl(`${this.baseUrl}${path}`, { signal }),
            Math.min(remaining, LAYA_POLL_TIMEOUT_MS),
          );
          if (res.ok) return true;
        } catch {
          // Refused, answered "no", or went silent - all three mean "ask again", and the budget - not this one
          // answer - is what decides that the backend is not coming. A poll that timed out is therefore *retried*
          // rather than reported: `startupTimeoutMs` exists for exactly the slow case (a first run loading a
          // checkpoint), and a process that really died is reported by the `exit` hook above, which this loop sees
          // at the top of the next round - now within one poll bound instead of never.
        }
      }
      // Waking exactly on the deadline rather than up to one interval past it is what makes the budget a budget
      // instead of an approximation.
      if (this.#deps.now() >= deadline) return false;
      await this.#deps.sleep(Math.min(this.#cfg.pollIntervalMs, deadline - this.#deps.now()));
    }
    return false;
  }

  /** Terminate the server process. */
  async stop()                {
    const child = this.#child;
    this.#child = undefined;
    this.#state = 'stopped';
    if (child) child.kill('SIGTERM');
  }
}
