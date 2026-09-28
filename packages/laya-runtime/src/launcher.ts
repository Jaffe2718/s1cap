/**
 * Laya server launcher: resolve the launch command, spawn it, wait for
 * `GET /v1/models`, and shut it down again.
 */
import type { LayaConfig } from './types.ts';
import { layaBaseUrl } from './types.ts';

export type LayaStatus = 'stopped' | 'starting' | 'ready' | 'failed';

export interface SpawnedProcess {
  pid?: number;
  on(event: 'exit' | 'error', cb: (arg?: unknown) => void): void;
  kill(signal?: string): boolean;
  stdout?: { on(event: string, cb: (chunk: unknown) => void): void } | null;
  stderr?: { on(event: string, cb: (chunk: unknown) => void): void } | null;
}

export interface LaunchDeps {
  spawn(command: string, args: string[], options: { env: Record<string, string>; cwd?: string }): SpawnedProcess;
  fetchImpl: typeof fetch;
  sleep(ms: number): Promise<void>;
  now(): number;
  fileExists(path: string): Promise<boolean>;
  platform?: string;
}

export interface LaunchPlan {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
}

/**
 * Path of the `laya-serve` console script for a given interpreter.
 * Windows environments keep the interpreter at `<env>/python.exe` and scripts in
 * `<env>/Scripts`; POSIX environments keep both in `<env>/bin`.
 */
export function consoleScriptPath(pythonPath: string, platform: string): string {
  const dir = pythonPath.replace(/[\\/][^\\/]+$/, '') || pythonPath;
  return platform === 'win32' ? `${dir}\\Scripts\\laya-serve.exe` : `${dir}/laya-serve`;
}

/**
 * Build the launch plan.
 *
 * [VERIFY] the exact `laya-serve` flags on first run: host/port are passed as
 * `--host/--port` and mirrored into `LAYA_HOST`/`LAYA_PORT`; if the installed
 * release uses different switches, set `serveArgs` (or `serveCommand`) in config.
 */
export function buildLaunchPlan(
  cfg: LayaConfig,
  pythonPath: string,
  platform: string,
  hasConsoleScript: boolean,
): LaunchPlan {
  const serveArgs = ['--host', cfg.host, '--port', String(cfg.port), ...(cfg.serveArgs ?? [])];
  const env: Record<string, string> = {
    ...(cfg.env ?? {}),
    LAYA_HOST: cfg.host,
    LAYA_PORT: String(cfg.port),
  };
  const plan: LaunchPlan = { command: pythonPath, args: serveArgs, env };
  if (cfg.cwd) plan.cwd = cfg.cwd;

  if (cfg.serveCommand) {
    return { ...plan, command: cfg.serveCommand };
  }
  if (cfg.preferConsoleScript && hasConsoleScript) {
    return { ...plan, command: consoleScriptPath(pythonPath, platform) };
  }
  return { ...plan, args: ['-m', 'laya', 'serve', ...serveArgs] };
}

export interface StartResult {
  ok: boolean;
  baseUrl: string;
  error?: string;
}

export class LayaServer {
  #cfg: LayaConfig;
  #deps: LaunchDeps;
  #child?: SpawnedProcess;
  #state: LayaStatus = 'stopped';
  #error?: string;
  #logs: string[] = [];

  constructor(cfg: LayaConfig, deps: LaunchDeps) {
    this.#cfg = cfg;
    this.#deps = deps;
  }

  get status(): LayaStatus {
    return this.#state;
  }

  get error(): string | undefined {
    return this.#error;
  }

  get logs(): readonly string[] {
    return this.#logs;
  }

  get baseUrl(): string {
    return layaBaseUrl(this.#cfg);
  }

  get pid(): number | undefined {
    return this.#child?.pid;
  }

  #record(chunk: unknown): void {
    const text = typeof chunk === 'string' ? chunk : String(chunk);
    for (const line of text.split(/\r?\n/)) {
      if (line.trim().length === 0) continue;
      this.#logs.push(line.trim());
    }
    if (this.#logs.length > 50) this.#logs.splice(0, this.#logs.length - 50);
  }

  /** Spawn the server and wait until it answers on /v1/models. */
  async start(pythonPath: string): Promise<StartResult> {
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
        env: plan.env,
        ...(plan.cwd ? { cwd: plan.cwd } : {}),
      });
    } catch (err) {
      this.#state = 'failed';
      this.#error = `spawn failed: ${(err as Error).message}`;
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
    this.#error = this.#error ?? `timed out after ${this.#cfg.startupTimeoutMs}ms waiting for ${baseUrl}/v1/models`;
    return { ok: false, baseUrl, error: this.#error };
  }

  /** Poll the readiness endpoint until it answers or the startup timeout expires. */
  async waitForReady(): Promise<boolean> {
    const deadline = this.#deps.now() + this.#cfg.startupTimeoutMs;
    while (this.#deps.now() < deadline) {
      if (this.#state === 'failed') return false;
      try {
        const res = await this.#deps.fetchImpl(`${this.baseUrl}/v1/models`);
        if (res.ok) return true;
      } catch {
        // server not up yet
      }
      await this.#deps.sleep(this.#cfg.pollIntervalMs);
    }
    return false;
  }

  /** Terminate the server process. */
  async stop(): Promise<void> {
    const child = this.#child;
    this.#child = undefined;
    this.#state = 'stopped';
    if (child) child.kill('SIGTERM');
  }
}
