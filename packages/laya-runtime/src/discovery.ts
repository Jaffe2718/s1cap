/**
 * Python environment discovery for the Laya backend.
 *
 * Why this exists: the conda `envs_dirs` setting can be redirected away from the
 * conda root (a real machine here keeps `ml` in `D:\conda_store\envs\ml` while
 * conda itself lives in `D:\ProgramData\miniforge3`), so `<root>/envs/<name>` is
 * never assumed — environments are resolved through `conda env list --json`.
 */
import type { LayaConfig } from './types.ts';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface DiscoveryDeps {
  run(command: string, args: string[]): Promise<RunResult>;
  platform?: string;
  env?: Record<string, string | undefined>;
}

export interface CondaEnvEntry {
  name: string;
  path: string;
}

export interface PythonCandidate {
  path: string;
  source: 'config' | 'extra' | 'env' | 'conda-env' | 'conda-base' | 'path' | 'py-launcher';
  label?: string;
}

export interface PythonProbe {
  path: string;
  ok: boolean;
  version?: string;
  /** the `laya` package is importable */
  laya: boolean;
  torch: boolean;
  /** fastapi + uvicorn present (the `laya[serve]` extra) */
  serve: boolean;
  error?: string;
}

export interface DiscoveryReport {
  candidates: PythonProbe[];
  /** best probe: the first one with laya, otherwise the first usable interpreter */
  chosen?: PythonProbe;
  /** every environment that can import laya */
  withLaya: PythonProbe[];
}

/** One-shot JSON probe executed by each candidate interpreter. */
export const PROBE_SCRIPT =
  "import importlib.util as u, sys, json; " +
  "print(json.dumps({'version': '.'.join(map(str, sys.version_info[:3])), " +
  "'laya': bool(u.find_spec('laya')), 'torch': bool(u.find_spec('torch')), " +
  "'serve': bool(u.find_spec('fastapi')) and bool(u.find_spec('uvicorn'))}))";

/** Parse `conda env list --json`. */
export function condaEnvsFromJson(stdout: string): CondaEnvEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  const envs = (parsed as { envs?: unknown }).envs;
  if (!Array.isArray(envs)) return [];
  const details = (parsed as { envs_details?: Record<string, { name?: string }> }).envs_details;
  const out: CondaEnvEntry[] = [];
  for (const raw of envs) {
    if (typeof raw !== 'string') continue;
    const name = details?.[raw]?.name ?? raw.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? raw;
    out.push({ name, path: raw });
  }
  return out;
}

/** Append the interpreter relative to a conda environment root. */
export function pythonExecutable(envRoot: string, platform: string = process.platform): string {
  const sep = platform === 'win32' ? '\\' : '/';
  return platform === 'win32' ? `${envRoot}${sep}python.exe` : `${envRoot}${sep}bin${sep}python`;
}

/** Parse `py -0p` (Windows launcher): lines like ` -V:3.13 *        C:\Python313\python.exe`. */
export function candidatesFromPyLauncher(stdout: string): PythonCandidate[] {
  const out: PythonCandidate[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /(-V:\S+)?\s*([A-Za-z]:\\[^\s].*?python\.exe)\s*$/i.exec(line.trim());
    if (m && m[2]) out.push({ path: m[2], source: 'py-launcher', ...(m[1] ? { label: m[1] } : {}) });
  }
  return out;
}

/** Parse `where python` / `which -a python`. */
export function candidatesFromWhich(stdout: string): PythonCandidate[] {
  return stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && /python/i.test(l))
    .map((path) => ({ path, source: 'path' as const }));
}

function dedupe(candidates: PythonCandidate[], platform: string): PythonCandidate[] {
  const seen = new Set<string>();
  const out: PythonCandidate[] = [];
  for (const c of candidates) {
    const key = platform === 'win32' ? c.path.toLowerCase() : c.path;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/** Build the ordered candidate list: explicit config, env vars, conda envs, PATH, launcher. */
export async function collectCandidates(cfg: LayaConfig, deps: DiscoveryDeps): Promise<PythonCandidate[]> {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const out: PythonCandidate[] = [];

  if (cfg.pythonPath) out.push({ path: cfg.pythonPath, source: 'config' });
  for (const extra of cfg.extraCandidates ?? []) out.push({ path: extra, source: 'extra' });
  const fromEnv = env.S1CAP_PYTHON ?? env.PYTHON;
  if (fromEnv) out.push({ path: fromEnv, source: 'env' });

  const condaPath = cfg.condaPath ?? 'conda';
  const condaResult = await deps.run(condaPath, ['env', 'list', '--json']);
  if (condaResult.code === 0) {
    const envs = condaEnvsFromJson(condaResult.stdout);
    if (cfg.condaEnv) {
      const match = envs.find((e) => e.name === cfg.condaEnv);
      if (match) out.push({ path: pythonExecutable(match.path, platform), source: 'conda-env', label: match.name });
    }
    const base = envs.find((e) => e.name === 'base');
    if (base) out.push({ path: pythonExecutable(base.path, platform), source: 'conda-base', label: 'base' });
  }

  const whichCmd = platform === 'win32' ? 'where' : 'which';
  const whichArgs = platform === 'win32' ? ['python'] : ['-a', 'python3'];
  const whichResult = await deps.run(whichCmd, whichArgs);
  if (whichResult.code === 0) out.push(...candidatesFromWhich(whichResult.stdout));

  if (platform === 'win32') {
    const py = await deps.run('py', ['-0p']);
    if (py.code === 0) out.push(...candidatesFromPyLauncher(py.stdout));
  }

  return dedupe(out, platform);
}

export function parseProbe(stdout: string): { version?: string; laya: boolean; torch: boolean; serve: boolean } | undefined {
  const line = stdout.split(/\r?\n/).reverse().find((l) => l.trim().startsWith('{'));
  if (!line) return undefined;
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    return {
      ...(typeof parsed.version === 'string' ? { version: parsed.version } : {}),
      laya: parsed.laya === true,
      torch: parsed.torch === true,
      serve: parsed.serve === true,
    };
  } catch {
    return undefined;
  }
}

export async function probePython(path: string, deps: DiscoveryDeps): Promise<PythonProbe> {
  const result = await deps.run(path, ['-c', PROBE_SCRIPT]);
  if (result.code !== 0) {
    return { path, ok: false, laya: false, torch: false, serve: false, error: (result.stderr || `exit ${result.code}`).trim().slice(0, 200) };
  }
  const parsed = parseProbe(result.stdout);
  if (!parsed) {
    return { path, ok: false, laya: false, torch: false, serve: false, error: 'unparsable probe output' };
  }
  return { path, ok: true, ...parsed };
}

/**
 * Probe every candidate and pick the best interpreter.
 * `chosen` is the first environment that can import laya; when none can, it is the
 * first working interpreter, so the caller can render an install hint.
 */
export async function discoverLayaPython(cfg: LayaConfig, deps: DiscoveryDeps): Promise<DiscoveryReport> {
  const candidates = await collectCandidates(cfg, deps);
  const probes: PythonProbe[] = [];
  for (const candidate of candidates) {
    probes.push(await probePython(candidate.path, deps));
  }
  const withLaya = probes.filter((p) => p.ok && p.laya);
  const chosen = withLaya[0] ?? probes.find((p) => p.ok);
  return { candidates: probes, ...(chosen ? { chosen } : {}), withLaya };
}

/** Human-readable install hint for an environment that lacks the package. */
export function installHint(pythonPath: string): string {
  return `${pythonPath} -m pip install "laya[serve]"`;
}
