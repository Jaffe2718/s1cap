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

Key names and meanings are listed here; **the defaults and the accepted ranges are the schema's**
(`packages/laya-runtime/src/types.ts`, `defaultLayaConfig()`, and the key rules in
`packages/laya-runtime/src/config.ts`), and a profile patch's value always wins over a default. Where a default is
quoted below it is a reading of that schema, not a second source.

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
| `autoStart` | see schema | start the server when the plugin loads. The default is `defaultLayaConfig()`'s; each profile pins the value it wants and the effective value is the profile's (the ablation's profiles start the backend by hand — `.s1cap-ablation/RUNBOOK.md` step 4) |
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
blocked, point the server at a mirror through the `env` map:

```yaml
env:
  HF_ENDPOINT: https://hf-mirror.com
  HF_HUB_DISABLE_XET: "1"
```

### Network findings

**Re-measured 2026-09-30, and the earlier table is wrong for this network.** The first plugin-launched start
failed in `snapshot_download` with `LocalEntryNotFoundError` on the profile's `HF_ENDPOINT: https://hf-mirror.com`,
while the *same command, same interpreter, no mirror* downloaded the checkpoint. The mirror no longer answers
here at all, so the plugin is started **without** `HF_ENDPOINT` and **without** `HF_HUB_DISABLE_XET`, and the
checkpoint comes from huggingface.co directly. The table below is kept as the history of the earlier measurement
(connection where huggingface.co was blocked), not as this machine's configuration:

| Check | Result (earlier connection, 2026-09) |
|---|---|
| `https://huggingface.co/api/models/convaiinnovations/laya` | unreachable (curl 000) |
| `https://hf-mirror.com/api/models/convaiinnovations/laya` | reachable (200) |
| download with the mirror only | **fails** after 4/5 files: `CAS Client Error: 401 Unauthorized` from `cas-server.xethub.hf.co` — the Xet content-addressed store is not proxied by the mirror |
| download with `HF_HUB_DISABLE_XET=1` + mirror | **succeeds**; plain HTTPS downloads go through the mirror |

Check before assuming either: run one start and read `~/.dsh/.s1cap/laya-launch.log`, which a failed start now
writes in full.

Working combination on this machine: `laya 0.3.21` · Python 3.13.15 · `torch 2.13.0+cu132` ·
`transformers 5.16.1` · `huggingface_hub 1.29.0`, `english` checkpoint on CPU. A `noul` question
over the CLI returned `noul: 0.0287, confidence: 0.9713` with `usage.input_tokens: 308`.

## 5. DSH profile patch

Machine-specific values belong in `~/.dsh/profiles/<profile>/cordis.patch.yml`, not in the bundle. The block below is
the *shape* of such a patch — the keys a profile decides — not a set of defaults:

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
      env:
        LAYA_THREADS: "8"
```

Keys left out of it are the schema's to default (`packages/laya-runtime/src/types.ts`; §3 lists the key set), and any
key written here is the profile's to own. `autoStart` is the one that is always a profile decision rather than a
default worth inheriting — whether the backend starts itself is a property of the round, not of the runtime, and the
ablation's profiles start it by hand (`.s1cap-ablation/RUNBOOK.md` step 4).

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
  first run that has to download weights can exceed the schema's default readiness budget — raise
  `startupTimeoutMs` (the CLI defaults to 600 s) or restrict `LAYA_MODELS` to one checkpoint.
- **Reproducibility:** `LAYA_REVISION` and `LAYA_SHA256_DIGESTS` pin checkpoint revisions and
  digests — worth setting for paper artifacts.

Still open: GPU/CPU device behaviour on the target machine (`LAYA_DEVICE`), and whether future
releases add CLI arguments.

## 6b. Admission control under load

`laya/serve.py` admits like this — this is the constraint the client-side backpressure design answers, so it is
stated from the installed source rather than from documentation:

```python
if admission.locked():                     # every one of LAYA_MAX_CONCURRENT slots taken
    raise HTTPException(503, "server busy, try again later", headers={"Retry-After": "1"})
await admission.acquire()
```

It is a *non-blocking* level check: excess load is **refused the moment the semaphore is full, never queued**, so any
burst above the cap loses its tail instantly. Two conclusions, and they point opposite ways from the obvious fix —
both measured against the running server with a payload shaped like real traffic (a ~3 k-token state and three `noul`
questions); the table is a dated measurement and lives with the round that took it
(`.s1cap-ablation/round-20261001-1300/`), not here:

- **Raising `LAYA_MAX_CONCURRENT` trades 503s for latency, and buys no throughput.** Throughput peaks at an
  in-flight count of roughly 16–32 and *falls* beyond it; at 64 the median is 22 s and the 95th percentile is
  49 s, which the client's transport guard turns straight back into `S1TimeoutError`. That guard was a fixed
  `30_000` ms when this was measured and is now `10_000 + 1_250 x questions` (`packages/s1-client`), so the loss at
  this in-flight count still happens - 35 s at twenty questions against a 49 s p95 - while the batch sizes the guard
  used to cut off outright (40 and 64 questions) are now covered.
  A bigger cap does not make more System-1 available; it moves the loss from the server to the client.
- **The shedding is a burst artifact, not a capacity shortage.** Round `20261001-1300` ran four cells against one
  shared backend at about 0.9 calls/s — against a server that sustains several times that — and still lost more than
  a third of its calls to 503s. The average was far under capacity; the *instantaneous* bursts were far over it, and
  this server refuses rather than smooths.

So the fix belongs on the client side of the deadline, not in the cap — and that is where it now lives, in code
rather than in a note:

- **the in-flight cap and the circuit breaker** — `packages/dsh-plugin/src/s1-backpressure.ts`; the knob is
  `s1.admissionLimit`, whose default and the measurement behind it are `packages/core/src/types.ts` and
  `bench/cells/C2.json`'s `_meta.admissionLimit`. Raising `LAYA_MAX_CONCURRENT` is deliberately not among them.
- **a window the gate did not send is deferred, not judged** — `S1_DEFERRED` in
  `packages/core/src/assoc-graph.ts`: the graph holds its cursor over it and the pairs are counted in
  `deferredPairs`, so the omission is a number with a reason rather than a lower coverage nobody can see.
- **`s1.retryAttempts` repeats a *refusal* only** — never a timeout (which costs another timeout) and never a
  cancellation (which is the caller's decision); the wait is the server's own `Retry-After`, bounded, and every call
  records `attempts` and `waitedMs` beside its cost, because a judgement that had to be retried is weaker evidence
  than one that did not.

None of that substitutes for reporting coverage: a cell whose calls are mostly refused is not a cell that received
its configured System-1 governance, and the number that says so is the share of the **pairs the session's arrival
order offered** that the graph actually settled — the floor row, with `judgedPairs / scoredPairs` the secondary
reading and the settled pairs' split by scorer beside it (a settled pair may have been settled by the local lexical
fallback; the `scores` entry's `source` says which). `docs/FORMULAS.md` §5.1 owns both, and
`scripts/cell-report.mjs` is what computes them; the pair count the denominator needs is neither `scoredPairs` nor
`scoredPairs + deferredPairs` (corrected 2026-10-05 in two rounds, one whose walk recovered and one whose walk
stopped, and the sentences that stood here are quoted verbatim in that document's corrections of the same date —
the ratio they printed is the one §5.1 no longer states).

## 7. Tests

`packages/laya-runtime/test` covers, offline and with injected fakes: conda JSON parsing
(including a redirected `envs_dirs`), the `py -0p` / `which` parsers, candidate ordering and
de-duplication, probe parsing, environment selection, launch-plan resolution (console script →
module fallback → override), readiness polling, startup timeout, early process exit, and shutdown.
