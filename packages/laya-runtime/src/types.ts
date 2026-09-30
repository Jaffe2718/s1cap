/**
 * Laya runtime configuration — the machine-specific half lives in the DSH profile
 * (`~/.dsh/profiles/<name>/cordis.patch.yml`), never in this repository.
 */

export interface LayaConfig {
  /** opt-in: nothing is spawned unless this is true */
  enabled: boolean;
  /** explicit interpreter path; when set it wins over discovery */
  pythonPath?: string;
  /** conda environment name to resolve through `conda env list --json` */
  condaEnv?: string;
  /** conda executable; defaults to `conda` on PATH */
  condaPath?: string;
  /** additional interpreter paths to probe, in order */
  extraCandidates?: string[];
  /** run `laya-serve` from the chosen environment when the console script exists */
  preferConsoleScript: boolean;
  /**
   * Where downloaded checkpoints live. Defaults to a directory S1CAP owns under its own data directory
   * (`./.s1cap/laya-cache`), because a user should not have to download or place weights by hand — the
   * environment fetches them on first start. Overridable for a machine that keeps models elsewhere.
   */
  weightsCacheDir?: string;
  /**
   * The environment variable the user's Laya reads to find that cache.
   *
   * Defaults to `HF_HOME`, which is the convention for this ecosystem. **That default is a convention, not a
   * measured fact about the user's build**: if their Laya does not read it, the variable is simply unused,
   * their own default cache applies, and nothing breaks. It is configurable precisely so that no assumption
   * about the variable name is ever load-bearing, and `/s1 laya status` prints whichever name was used so a
   * mismatch is visible instead of silent.
   */
  weightsEnvVar?: string;
  /** launch command override (e.g. a wrapper script) */
  serveCommand?: string;
  /** arguments appended to the launch command */
  serveArgs?: string[];
  host: string;
  port: number;
  /** readiness endpoint polled after spawn (default `/health`, Laya 0.3.21) */
  healthPath: string;
  /** model id handed to /v1/systemone calls */
  model?: string;
  /** start the server when the plugin loads */
  autoStart: boolean;
  /** ms to wait for GET /v1/models to answer after spawn */
  startupTimeoutMs: number;
  /** polling interval while waiting for readiness */
  pollIntervalMs: number;
  /** extra environment variables for the server process (LAYA_THREADS, HF_ENDPOINT, ...) */
  env?: Record<string, string>;
  /** working directory for the server process */
  cwd?: string;
}

export function defaultLayaConfig(): LayaConfig {
  return {
    enabled: false,
    preferConsoleScript: true,
    host: '127.0.0.1',
    port: 8008,
    healthPath: '/health',
    autoStart: true,
    startupTimeoutMs: 120_000,
    pollIntervalMs: 500,
  };
}

/** Base URL the System-1 client should talk to for this configuration. */
export function layaBaseUrl(cfg: Pick<LayaConfig, 'host' | 'port'>): string {
  return `http://${cfg.host}:${cfg.port}`;
}
