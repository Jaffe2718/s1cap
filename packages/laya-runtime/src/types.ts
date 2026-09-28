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
