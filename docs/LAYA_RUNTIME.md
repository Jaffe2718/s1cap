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
| `host` / `port` | `127.0.0.1` / `8008` | bind address of the local server |
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

## 6. Open verification items

- **`laya-serve` flags** — `--host` / `--port` are passed by default and mirrored into
  `LAYA_HOST` / `LAYA_PORT`; if the released CLI uses different switches, set `serveArgs` or
  `serveCommand`. (`[VERIFY]` on first real launch.)
- **Python 3.13 support** — the serving extra must resolve for the interpreter in use.
- **Warm-up latency** — the first `/v1/systemone` call after `ready` may be slower while weights load.

## 7. Tests

`packages/laya-runtime/test` covers, offline and with injected fakes: conda JSON parsing
(including a redirected `envs_dirs`), the `py -0p` / `which` parsers, candidate ordering and
de-duplication, probe parsing, environment selection, launch-plan resolution (console script →
module fallback → override), readiness polling, startup timeout, early process exit, and shutdown.
