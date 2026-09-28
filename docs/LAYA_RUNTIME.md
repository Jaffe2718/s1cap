# Laya Runtime (local System-1 backend)

How S1CAP finds a Python environment that can run [Laya](https://github.com/NandhaKishorM/laya),
launches `laya-serve`, and talks to it over the same `POST /v1/systemone` protocol the
cloud Jev backend uses. Code: [`packages/laya-runtime`](../packages/laya-runtime/src/index.ts).

Nothing in this document is machine-specific on purpose: the concrete paths for the
development machine are supplied through the DSH profile patch (which is never committed).

---

## 1. What the runtime does

| Stage | Behaviour |
|---|---|
| **Discover** | builds an ordered list of interpreter candidates (see §2) and probes each one |
| **Probe** | runs one `-c` JSON snippet per candidate → Python version, `laya` importable, `torch`, and the `laya[serve]` extra (`fastapi` + `uvicorn`) |
| **Choose** | the first candidate that can `import laya`; when none can, the first working interpreter plus an install hint |
| **Launch** | `laya-serve` console script when present, otherwise `python -m laya serve`; host/port from config |
| **Health-check** | polls `GET {baseUrl}/v1/models` until it answers or `startupTimeoutMs` expires |
| **Stop** | terminates the spawned process (`SIGTERM`) |

## 2. Discovery order

1. `laya.pythonPath` — explicit interpreter (wins over everything)
2. `laya.extraCandidates` — additional paths, in order
3. `S1CAP_PYTHON` then `PYTHON` from the environment
4. **conda environment named by `laya.condaEnv`** — resolved through `conda env list --json`
5. the conda **base** environment (same JSON)
6. `where python` (Windows) / `which -a python3` (POSIX)
7. `py -0p` (Windows launcher) — every registered system interpreter

> **Never guess `<conda root>/envs/<name>`.** conda's `envs_dirs` setting can point elsewhere, so
> environment paths are always taken from `conda env list --json`. The development machine is a
> live example: conda lives in one directory while the `ml` environment lives in another, and
> only the JSON (or `.condarc`) reveals it.

Candidates are de-duplicated case-insensitively on Windows.

## 3. Configuration keys

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | opt-in switch; nothing is spawned while false |
| `pythonPath` | — | explicit interpreter path |
| `condaEnv` | — | conda environment name to resolve and probe |
| `condaPath` | `conda` | conda executable (absolute path when conda is not on `PATH`) |
| `extraCandidates` | `[]` | extra interpreter paths to probe |
| `preferConsoleScript` | `true` | use `<env>/Scripts/laya-serve.exe` (Windows) or `<env>/bin/laya-serve` when present |
| `serveCommand` | — | full launch-command override (wrapper scripts) |
| `serveArgs` | `[]` | extra arguments appended to the launch command |
| `host` / `port` | `127.0.0.1` / `8008` | bind address of the local server (injected as `LAYA_HOST` / `LAYA_PORT`) |
| `healthPath` | `/health` | readiness endpoint polled after spawn (`/v1/models` is tried as a fallback) |
| `model` | — | model id sent to `/v1/systemone` (e.g. `laya-typed-decisions`) |
| `autoStart` | `true` | start the server when the plugin loads |
| `startupTimeoutMs` | `120000` | readiness budget (first run downloads weights) |
| `pollIntervalMs` | `500` | readiness poll interval |
| `env` | `{}` | extra environment variables (`LAYA_THREADS`, `LAYA_DEVICE`, `LAYA_MODELS`, `HF_ENDPOINT`, …) |
| `cwd` | — | working directory of the server process |

## 4. Install

Laya needs `torch` and `transformers`, which most ML environments already have; the serving
extra adds the HTTP layer:

```bash
<python> -m pip install "laya[serve]"
```

Installed and verified here with `laya 0.3.21` on Python 3.13: the package pulls
`fastapi`, `uvicorn`, `starlette`, `pydantic` and friends, and installs the console scripts
`laya`, `laya-serve`, `laya-mcp-server` and `laya-evals` into the environment's `Scripts`
(or `bin`) directory.

First launch downloads the Laya checkpoints from Hugging Face. When that endpoint is slow or
blocked, point the server at a mirror through the `env` map, e.g. `HF_ENDPOINT: https://hf-mirror.com`.

## 5. DSH profile patch

Machine-specific values belong in `~/.dsh/profiles/<profile>/cordis.patch.yml`, not in the bundle:

```yaml
- id: s1cap
  name: dsh-s1cap
  config:
    s1:
      provider: laya-serve
    laya:
      enabled: true
      condaEnv: <env-name>
      condaPath: <path-to-conda-executable>
      host: 127.0.0.1
      port: 8008
      model: laya-typed-decisions
      autoStart: true
      startupTimeoutMs: 120000
      env:
        LAYA_THREADS: "8"
```

## 6. Verified behaviour (laya 0.3.21)

Read from the installed `laya/serve.py`, not from documentation:

- **Configuration is environment-only.** `laya-serve` takes no host/port flags; it calls
  `uvicorn.run(host=os.environ["LAYA_HOST"], port=os.environ["LAYA_PORT"], …)`. The launcher
  therefore injects `LAYA_HOST` / `LAYA_PORT` and passes no arguments (`serveArgs` remains for
  releases that do accept flags).
- **Endpoints:** `GET /health` and `POST /v1/systemone` only — there is **no** `/v1/models`,
  which is why readiness polls `/health` first.
- **Environment variables** (defaults in parentheses): `LAYA_HOST` (0.0.0.0), `LAYA_PORT` (8000),
  `LAYA_DEVICE` (auto), `LAYA_PRELOAD` (1), `LAYA_MODELS` (all checkpoints; `english`,
  `multilingual`, `typed-decisions`), `LAYA_THREADS` (torch default — keep ≤ physical cores),
  `LAYA_AUTO_TASK` (0), `LAYA_MAX_LOADED` (2), `LAYA_API_KEY` (none), `LAYA_LOG_LEVEL` (info),
  `LAYA_MAX_CONCURRENT` (16), `LAYA_MAX_TOKEN_BUDGET` (8192).
- **Request contract:** the body must be an object containing `questions` (400 otherwise);
  optional `state`, `model`, `max_len`, `head_max_len`; oversized bodies get 413, and saturation
  past `LAYA_MAX_CONCURRENT` gets 503 with `Retry-After: 1` instead of queueing.
- **Startup cost:** with `LAYA_PRELOAD=1` the checkpoints are built *before* uvicorn binds, so a
  first run that has to download weights can exceed the default 120 s readiness budget — raise
  `startupTimeoutMs` (the CLI defaults to 600 s) or restrict `LAYA_MODELS` to one checkpoint.
- **Reproducibility:** `LAYA_REVISION` and `LAYA_SHA256_DIGESTS` pin checkpoint revisions and
  digests — worth setting for paper artifacts.

Still open: GPU/CPU device behaviour on the target machine (`LAYA_DEVICE`), and whether future
releases add CLI arguments.

## 7. Tests

`packages/laya-runtime/test` covers, offline and with injected fakes: conda JSON parsing
(including a redirected `envs_dirs`), the `py -0p` / `which` parsers, candidate ordering and
de-duplication, probe parsing, environment selection, launch-plan resolution (console script →
module fallback → override), readiness polling, startup timeout, early process exit, and shutdown.
