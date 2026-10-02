# S1CAP

**S**ystem-**1** **C**ontext-**A**ware **P**lanning

![status](https://img.shields.io/badge/status-M1%20observation-blue) ![node](https://img.shields.io/badge/node-%3E%3D22.19-green) ![license](https://img.shields.io/badge/license-TBD-lightgrey)

**S1CAP: Context-Aware Planning via System-1 Models for Efficient LLM Agents**

**Authors:** Yuanming Chen · LI Changzhe

**Progress:** M0 complete (packages, Laya runtime verified on this machine, the plugin activates in a real DSH
profile). **M1 observation mode is live and verified in real sessions**: the per-call pipeline runs
(SEGMENTER → RECALL → ASSEMBLER) with the prompt returned untouched, the system prompt is sourced from the
harness registry so the pinned block and the cache-stable prefix are non-zero (`blocks.pinned = 684` in a real
round), association-graph upkeep is fed by real `session/event` traffic, and a replay harness reproduces the
control-plane records byte for byte. The settings panel that will hold the Jev key is next. Details, evidence
and per-item acceptance tests: [`docs/STATUS.md`](docs/STATUS.md).

S1CAP puts a cheap **System-1 decision model** (Jev / Laya / Kev class, speaking the [`/v1/systemone`](https://docs.typesafe.ai/api) protocol) in charge of an LLM agent harness's **context lifecycle** — instead of the expensive System-2 LLM. The S1CAP control layer intervenes at exactly **two points**. One bound on both, stated here because it decides how every measurement below is read: no cell delivers an assembled *layout* yet — the model-view write-back is a 🔜 row in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (`packages/proxy`, not written) — so the ordering is **recorded** and what reaches the model today is recall selection plus one inserted block:

1. **Context Awareness** *(what the model sees, per LLM call)* — every session segment (user turn, assistant message, reasoning trace, tool call/result) is a node in a growing **association graph** scored by the System-1 model. Each turn, bounded BFS + relevance threshold + token budget decide which segments make it in, assembled in Trace-as-State order: `[pinned prefix | state proxy T | recalled blocks | recent tail | current input]`. Which half of that reaches the model today is stated in **Evaluation design** below: the *selection* does, the *assembled order* does not yet.
2. **Plan Ordering** *(the context-aware part of planning)* — the LLM's candidate plans go directly to a second System-1 backend that scores them as a **choice question**; **PLAN GATE** normalizes those scores, orders the plans and caps attempts, and execution follows that order under a verification oracle, with unexecuted alternatives discarded on first success. *Designed and implemented, but not wired into any ablation cell as of 2026-10-02:* round `20261002-2037` recorded no `plan_gate` event at all, because the model wrote no numbered plan and emitted no `todo/write`, so the knob was removed from the policy, the presets and the report rather than left `on` and inert (`packages/core/src/types.ts`).

Everything is **measured, not assumed**: solve rate, token cost split by prompt-cache **hit/miss** (the dominant cost lever — cache-hit tokens are ~50× cheaper than misses on DeepSeek), and wall time excluding approval waits. The definitions are [`docs/FORMULAS.md`](docs/FORMULAS.md), and [`scripts/cell-report.mjs`](scripts/cell-report.mjs) is their one implementation.

## Why now (September 2026)

| enabler | fact |
|---|---|
| Trace as State ([arXiv:2609.02702](https://arxiv.org/abs/2609.02702)) | placing the reasoning-trace state proxy **before** the long context beats trace-append in 26/27 model×task×metric combos — training-free, inference-time only |
| Decision models arrive | [Jev](https://docs.typesafe.ai/api) (TypeSafe AI): $0.042/M input, output free, parallel question batches 12× cheaper than serial · open [Laya](https://github.com/NandhaKishorM/laya) (Apache-2.0) · [EdgeJev](https://github.com/yzfly/edgejev) local runtime: 322M INT8, 324 MB, 15.6 ms/decision on 4 vCPU |
| Cache economics | DeepSeek `deepseek-flash`: $0.006/M cache-hit vs $0.30/M cache-miss — context assembly is a cost decision, not just a quality decision |

## Architecture

![S1CAP method overview: a chronological session log feeds task-conditioned context assembly over a semantic association graph; System-2 generates candidate plans, System-1 reorders them, and the model owns the stop decision.](./docs/figures/s1cap-method-overview.png)

For exact control flow and asynchronous boundaries, see the [detailed technical route](docs/figures/s1cap-technical-route.light.svg) ([dark version](docs/figures/s1cap-technical-route.dark.svg)).

The user-facing transcript stays **strictly chronological**; only the model view is reassembled — and that write-back is a 🔜 row in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (`packages/proxy`, not written), so what the *ordering* half records is not yet what the model reads. The one live delivery channel inserts the `recalled` turns and nothing else, which is why the registered contrast measures the recall lane rather than TAS (`docs/CELLS-RUN.md`).

## Evaluation design (three cells)

Three cells are run: two controls and one arm under test (the 2×2 crossing's fourth combination — governance without
ordering — measured worse than the baseline per step and has been dropped; `bench/README.md` records the quantities).
**Which switches an arm carries is owned by the presets and the policy, not by this page:** the arm definitions are
[`bench/cells/C0.json`](bench/cells/C0.json)–[`C2.json`](bench/cells/C2.json) plus `cellPolicy()`
(`packages/core/src/types.ts`), and a disagreement with this page is a reason to read those. What the three arms mean
is the rule this page keeps:

- **`C0`** is the baseline and **`C2`** the full configuration; **`C1`** is a **second control arm** — delivery has one
  channel and its `tier1: off` leaves that channel empty by construction, so its model-visible input is `C0`'s.
- `tas.on`/`xFirst` are *recorded* in every arm and reach the model in none: delivery inserts one `recalled` block and
  never the assembled order, so the ordering becomes measurable only with the model-view write-back, which does not
  exist ([`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §5; `packages/proxy` is not written).
- The registered contrast is therefore **`C0` vs `C2`**, and what it measures today is recall selection and its
  insertion — the recall lane, not TAS.
- Factor B is recall selection alone: the plan gate is designed and unit-tested but **wired into no cell**, so it is no
  part of any factor here.

Benchmarks (all automated scoring, no GUI, no LLM judges): **SWE-bench Verified** · **Terminal-Bench 4.0** ·
**τ²-bench**. The pools and their sizes are
[`docs/AGENT_BRIEF.md`](docs/AGENT_BRIEF.md) §"Experiment design (three arms: two controls, one arm under test)",
and the per-round run set is [`docs/CELLS-RUN.md`](docs/CELLS-RUN.md). Model: `deepseek-flash`
(DeepSeek-V4.1-Flash) with `reasoningEffort` pinned; **no sampling parameter is claimed** — not a temperature and not a seed — because DSH exposes none.

**Success rule:** solve-rate **non-inferiority** vs C0 (paired McNemar, one-sided α=0.05, margin −2 pp) **AND** ≥10% improvement in cost/task or time/task (paired bootstrap 95% CI excluding 0, Holm-corrected). Winning cost while losing >2 pp solve rate is not a win. The frozen rule is
[`docs/AGENT_BRIEF.md`](docs/AGENT_BRIEF.md) §"Metrics, hypotheses, success rule"; its pools, grid and budget are
[`docs/AGENT_BRIEF.md`](docs/AGENT_BRIEF.md) §"Experiment design (three arms: two controls, one arm under test)".

## Status & roadmap

Pre-alpha — **M0 scaffolding landed**: monorepo, `@s1cap/core` (segmenter · association graph · assembler · plan gate · telemetry v1), `@s1cap/s1-client`, `@s1cap/laya-runtime` (Python discovery + `laya-serve` launcher), `dsh-s1cap` skeleton, three-cell presets (C0–C2); the offline suite is green (`node --test`, below), and a real `laya-serve` round trip verified (`/health` readiness + a `noul` decision over `/v1/systemone`). Remaining M0: live-backend smoke against Jev. Full spec: [docs/AGENT_BRIEF.md](docs/AGENT_BRIEF.md).

| M | Scope |
|---|---|
| M0 | monorepo scaffold, core + `s1-client`, telemetry v1, DSH plugin skeleton — **scaffold done**, live-backend smoke pending |
| M1 | assembler/recall replay-correctness tests, proxy MVP, DSH hook wiring (`agent/pre-step`, surface ops) |
| M2 | plan gate wiring (a cell can only fire the gate once its model writes a plan the gate can read — none does today), degradation paths, settings UI, Terminal-Bench 10-task cost pilot |
| M3 | three-cell ablation on SWE-bench Verified + τ²-bench (+ TB), optional Laya fine-tune |
| M4 | Terminal-Bench cells, opencode transfer check, GLM model-swap check |
| M5 | paper: Pareto + cache-waterfall figures, case studies, LaTeX draft |

## Development

```bash
node --test --experimental-strip-types "packages/*/test/*.test.ts"   # zero dependencies, offline
node scripts/check-diagram.mjs   # every node box inside its lane band, no overlapping nodes
node scripts/check-doc-pointers.mjs   # dead file/section pointers and stale value claims
```

The second command guards the hand-authored route diagram: it is drawn by hand, so nothing but this
check stops a node from drifting out of its lane.

Local Laya backend: `@s1cap/laya-runtime` discovers the Python environment that can `import laya`
(conda environments are resolved through `conda env list --json`, never by guessing paths), launches
`laya-serve` and health-checks `/v1/models`. Install the serving extra once per environment with
`<python> -m pip install "laya[serve]"`; configuration keys and the DSH profile patch are documented in
[docs/LAYA_RUNTIME.md](docs/LAYA_RUNTIME.md).

Type-checking needs TypeScript ≥ 5.8 (`erasableSyntaxOnly`): `npm i -D typescript@^5.8 && npm run typecheck`.
pnpm is the intended workspace manager; on Windows PowerShell call `pnpm.cmd` (the `.ps1` shim is blocked by
the default execution policy).

## Repository layout

```
s1cap/
  packages/core        # segmenter, association graph, assembler, plan gate, telemetry v1
  packages/s1-client   # /v1/systemone client + provider matrix
  packages/proxy       # OpenAI-compatible middleware (M1)
  packages/dsh-plugin  # dsh-s1cap: first-class DeepSeek Harness plugin (skeleton)
  bench/               # cells/ presets; runners + stats land with M2
  docs/                # proposal, implementation brief, related-work dossier, formulas
  paper/               # LaTeX (M5)
```

## Documentation

| doc | audience |
|---|---|
| [docs/STATUS.md](docs/STATUS.md) | **start here** — done/next checklist plus agent-ready detail for every open item |
| [docs/PROPOSAL.md](docs/PROPOSAL.md) | research proposal — supervisor / cooperator |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | module reference: route SVG + connection semantics, parameters, implementation status |
| [docs/LAYA_RUNTIME.md](docs/LAYA_RUNTIME.md) | local Laya backend: Python environment discovery, launcher, configuration keys |
| [docs/CONTROL_PLANE_LOGGING.md](docs/CONTROL_PLANE_LOGGING.md) | control-plane isolation: two-log design and the invariants that keep System-1 from scoring its own output |
| [docs/AGENT_BRIEF.md](docs/AGENT_BRIEF.md) | implementation brief for coding agents — verified facts base, interfaces, algorithms, milestones |
| [docs/FORMULAS.md](docs/FORMULAS.md) | formal definitions and formula handbook (Markdown + LaTeX) |
| [docs/RELATED_WORK.md](docs/RELATED_WORK.md) | verified related-work dossier + novelty audit |
| [docs/REPO_METADATA.md](docs/REPO_METADATA.md) | canonical repo description, topics, keywords |

## Environment

Verified on the dev machine (2026-09-28): Node v22.23.1 · npm 12.0.2 · git 2.45.2 · Python 3.13.13 (miniforge) · i7-12700H (AVX2 — EdgeJev-compatible) · DSH runtime bundles Node 24.18.1.

Requirements: Node ≥ 22.19 (DSH plugin engines contract) · pnpm for the monorepo (on Windows PowerShell, invoke `pnpm.cmd` or relax the execution policy) · Python ≥ 3.10 for local S1 runtimes (`pip install "laya[serve]"`, `pip install edgejev`) · a System-1 backend: cloud Jev key, or local EdgeJev/Laya for weak CPUs (324 MB, offline).

## Name

**S1CAP = System-1 Context-Aware Planning** — `S1` is the System-1 decision model, `C-A-P` is the context-aware planning it performs for an LLM agent. The control layer intervenes at two points: **① Context Awareness** (which segments the model sees) and **② Plan Ordering** (the order its own plans run in).

## Acknowledgments

[TypeSafe AI](https://typesafe.ai/) (Jev) · [Convai Innovations](https://github.com/NandhaKishorM/laya) (Laya) · [yzfly](https://github.com/yzfly/edgejev) (EdgeJev) · [jaredpalmer](https://github.com/jaredpalmer/kev) (Kev) · [Benchmark Heaven](https://www.benchmarkheaven.com/jev-models) (JevBench) · Xu Zou & Jie Tang (Trace as State, arXiv:2609.02702) · [snailium](https://github.com/snailium/dsh-command-context-trim) (DSH plugin engineering template) · [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)

## Citation

Paper in preparation. Authors: **Yuanming Chen**, **LI Changzhe**. Title: *S1CAP: Context-Aware Planning via System-1 Models for Efficient LLM Agents* (revised 2026-09-28 after the naming erratum: the acronym expands to System-1 Context-Aware Planning).

```bibtex
@misc{s1cap2026,
  title  = {S1CAP: Context-Aware Planning via System-1 Models for Efficient LLM Agents},
  author = {Chen, Yuanming and LI, Changzhe},
  year   = {2026},
  url    = {https://github.com/Jaffe2718/s1cap},
  note   = {Paper in preparation}
}
```

## License

TBD (MIT proposed).
