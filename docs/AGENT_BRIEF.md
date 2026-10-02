# S1CAP — Agent Implementation Brief

**Version** 0.2 · 2026-10-02 · protocol and hypotheses
**What this file is:** the project's **protocol** — the rules an implementing agent may not break, and the claims the
experiment will make. It is deliberately short: everything else is owned by a file or by the code, and is named below.
**Deliverable in one line:** a cheap System-1 *decision model* (Jev / Laya / Kev class, `/v1/systemone`) as the
**governance layer** over a System-2 agent's context lifecycle — association graph over session segments,
Trace-as-State assembly, plan pre-ranking — measured on solve rate, cache hit/miss tokens and wall time.

| If you need | Read |
|---|---|
| the ablation scheme: the three cells, why one is the arm under test | `bench/README.md`, `docs/CELLS-RUN.md` §"The arms, and what the contrast is" |
|---|---|
| what is done, what is next, how to take over | `docs/STATUS.md` (§2–§3 done/next, §3b unenforced knobs, §5 commands, §8 the current phase) |
| modules, lanes, code paths, status per module | `docs/ARCHITECTURE.md` (§3 module table, §5 arm ↔ module mapping, §6 loop/authority) |
| formulas, metric definitions, layout algebra, statistical test | `docs/FORMULAS.md` |
| arms, switches, knob names and defaults | `bench/cells/*.json` + `cellPolicy()` / `defaultPolicy()` (`packages/core/src/types.ts`) |
| the running procedure and prerequisites | `docs/CELLS-RUN.md` · `.s1cap-ablation/RUNBOOK.md` |
| a given run's own configuration | that run's `kind:"wiring"` tape record |
| verdicts on defects | `.s1cap-ablation/DEFECT-GATE.md` |
| document rules (what a document may own) | `docs/DOC-CONTRACT.md` |

---

## 0. Ground rules for the implementing agent

1. Verified facts are dated and sourced (§1, §2 of this file and `docs/RELATED_WORK.md`). Do not contradict them
   without new evidence; if a live API behaves differently, **stop and report** rather than silently adapt. One
   exception: the DSH loading facts were re-checked on the release in use and now state per fact which release they are
   evidence about and which check settled it (`docs/STATUS.md` §8).
2. Items marked `[VERIFY]` are deliberately unverified: verifying one is the first task of the milestone that names it.
3. Never invent a benchmark number, an API field or a library name. If you need one that is not recorded, ask the human.
4. The human owns the research decisions in §9. Every other implementation decision inside this protocol is yours.
5. **Telemetry field names are versioned contracts: add fields, never rename.**
6. **Control-plane isolation is a hard architectural rule:** System-1 calls, their telemetry and the backend's logs live
   in a stream independent of the session event log. No control-plane record may become a segment, enter the association
   graph, or appear in any LLM context or System-1 `state` — otherwise System-1 scores its own output and the call count
   compounds per turn. Full statement and the four enforced invariants: `docs/CONTROL_PLANE_LOGGING.md`
   (`packages/core/src/provenance.ts`). Do not relax it for convenience.
7. **The agent loop is model-owned; S1CAP is only a hook.** One user turn is many LLM steps, so S1CAP assembles before
   **every** LLM call and maintains the graph **asynchronously, off the critical path**. Nothing in S1CAP may keep the
   loop alive: the harness stops when the model stops, the assembly path is bounded and on expiry the call proceeds
   unmodified, and any S1CAP failure or timeout degrades to passthrough. Termination and RG-upkeep mode are literal types
   in `AssemblyPolicy` — not toggles. *(The bound that actually fires per call is the anchor wait, not the declared
   deadline; `docs/STATUS.md` §3b registers the declared knobs no code path enforces.)*
8. **The route diagram has exactly one geometry source: the hand-authored HTML** (`docs/figures/s1cap-technical-route.html`);
   the committed SVGs are generated from it by `scripts/build-route-svg.mjs`, are embedded by the README and
   `ARCHITECTURE.md`, and are never hand-edited. Mermaid is retired for this figure. A serial chain picture of this
   design is **wrong**, not stylised: the loop and the async lane are the design.
9. **Exactly one System-1 backend is active at a time.** `s1.provider` selects it; a local runtime enabled beside a
   cloud provider is a *configuration error*, never a silent priority decision — a session that quietly switches
   governors makes its own measurements meaningless. On conflict the conflict is logged and the session runs
   observation-only (`packages/s1-client/src/resolve.ts`).
10. **Config is validated fail-safe, and credentials never reach a log or the transcript.** A bad profile patch warns
    and keeps the default; a profile patch must never break a live session. The API key comes from config or the
    provider's environment variable, goes straight to the client, and is only ever printed redacted. Session and control
    sinks must differ — merging them would let control-plane records become segments (rule 6).
11. **The measurement is not a single number.** Report the token triple separately and the cache-hit rate as a
    mechanism diagnostic, never as a cost column, and never form a scalar from the triple (`docs/FORMULAS.md` §5.1).
12. **A versioned claim is never a copy.** Do not restate a value the code or a run owns; name the owner (`docs/DOC-CONTRACT.md`).

---

## 1. Facts the protocol depends on

Everything below was verified against live sources on 2026-09-27/28 unless stated; the sources are in §10. This section
keeps **only** the facts a reader needs in order to trust the protocol. Full detail — API shapes, limits, per-model
benchmarks, variant sizes, pricing tables — is in the sources themselves and in `docs/RELATED_WORK.md`.

| Fact | Why the protocol depends on it |
|---|---|
| Paper T (arXiv:2609.02702, "Trace as State"): a fresh pass ordered `[T, x, q]` — trace **before** the context, question **last** — beats the matched control in 26 of 27 model×task×metric combinations, and the paper places the question last in *both* conditions because models drift otherwise. **Transplant principle: task state discovered late (in reasoning traces) must be available *before* the history on the next pass, and the current instruction stays last.** | the layout rule and the reason `x` stays last (§3.3, §4 of this file); the TAS factor in §5 |
| Jev: cloud `/v1/systemone`, three answer types (`noul` yes/no, `choice` probabilities + confidence, `score` ordered levels), input-priced with free output | the two System-1 roles (association, decision) and the batching shape (§3.2, §3.4) |
| Jev's documented weaknesses: literal reading, unusable math/dates, **context rot on large state**, **steerable by adversarial content**, and **no guarantee that probabilities sum to 1** | the pre-filter before any segment becomes `state`, and normalization server-side (§3.5, §3.4) |
| Laya: open weights, honest limits — the base checkpoint is **near-chance zero-shot** on typed decisions and fails above ~20 options at defaults | the rule that zero-shot local Laya is never the relevance scorer: use cloud Jev or a fine-tune (§5) |
| Local runtimes: EdgeJev (INT8 ONNX, offline, small CPU footprint), laya-mlx (Apple Silicon), Kev; no llama.cpp/Ollama/vLLM path | the local lane is a real option with a documented cost, not a fallback of last resort |
| Harness portability: opencode (`baseURL` override, OpenAI-compatible providers), Claude Code (gateway base URL), pi (`system_one` as a *tool* — agent-in-the-loop, orthogonal to our infrastructure-in-the-loop), DSH (`--dump-config`, isolated `DSH_HOME`) | the transfer claim (H4) and the fact that the adapter — not the design — is what changes |
| Price anchors: `deepseek-flash` cache-hit vs cache-miss, Jev input-only | the economic claim: cache-hit tokens are ~50× cheaper than miss at peak, so **cache-hit rate is the biggest cost lever** and reordering has a *measurable cache penalty* (H3) |
| The user's model id is `deepseek-flash` (there is no `deepseek-v4.1-flash` id) | the model row of every cell |

**DSH plugin facts are pointers, not prose here.** The release in use, the profile layout, the session/surface model,
the hook contracts, the command grammar and what was re-checked when live are in `docs/STATUS.md` §8; the round-by-round
dated records of that work are in `docs/STATUS-ARCHIVE.md` (frozen), and this file's own fact rows are §"Facts the
protocol depends on". The two rules a reader needs before coding against DSH are rule 7 above and **never register a
lifecycle hook whose contract has not been read from the packaged source** (read it with `scripts/scan-dsh-asar.cjs`).

---

## 2. Core interfaces

One line, one owner: **the types are `packages/core/src/types.ts`** — `AssemblyPolicy` with `defaultPolicy()` and
`cellPolicy()`, `Segment`/`SegmentKind`, `EdgeSource`, `AssemblyLayout.order`, `AssemblyResult`, and the cell union. The
telemetry records are `packages/core/src/telemetry.ts`. The S1 client is `packages/s1-client/src/index.ts`.

This file does not sketch them. What the protocol fixes about them: **field names are versioned contracts** (rule 5),
and **an edge's source must record whether a System-1 model or the local lexical fallback produced it** — an edge whose
provenance is not recorded cannot be told apart from one no model ever saw, and the paper's central comparison would be
unmeasurable.

---

## 3. Algorithms

The mechanisms are specified where they live (`docs/ARCHITECTURE.md` §3, `docs/FORMULAS.md` §1–§4; knobs in
`AssemblyPolicy`, `bench/cells/*.json`). This section keeps only **invariants** — the lines that must stay true whatever
the values become.

### 3.1 Segmentation
- **Message-level, never token-level.** Long events are chunked with a head/tail preference and a chunk map for
  reconstitution; the system node and tool schemas are **PINNED** and never enter the graph.
- A shape with no rule is **reported, not dropped**.

### 3.2 Association graph (three tiers)
- **Tier 0 (metadata, free)** must work with **no** System-1 backend answering — that is what makes degradation total.
- **Tier 1** is one batched call per scoring window, with the questions-per-call cap as the **context-rot guard**. Only
  the implemented mode exists; a cell must name the mechanism that actually runs.
- **Tier 2** is lazy verification, only for edges that could enter assembly, with a defined abstention fallback.
- **The scoring window bounds pair scoring only — never what exists in the graph.** Segments outside it keep their edges
  and stay reachable by the BFS. This distinction is the whole point of the window
  (`docs/ARCHITECTURE.md` "Parameter: recall.window", `docs/FORMULAS.md` "Recall window w").

### 3.3 Assembly
- Budget is the window minus the output reserve minus measured fixed overhead — never the raw window.
- Selection is a bounded BFS then a greedy knapsack, deduplicated against the verbatim tail by segment id, every block
  carrying a provenance header.
- **Never dropped, never reordered:** the pinned prefix, the current input `x`, and the verbatim tail.
- **`x` last is a requirement, not a preference** (§1, paper T). `T` existing at all and the position of `x` are **two
  independent switches** — TAS is not x-first; a preset that moves them together is a preset's choice.
- **Fallback:** the rule that fires is the *segment-count* floor — fewer than one selected segment is not a selection, so
  the block degrades to the chronological window and the event is logged. The token-share floor is **off**, and the
  measurement that turned it off is `docs/FORMULAS.md` §3.5. Either floor writes `fallback`; both are recorded on the
  wiring record.
- The pinned prefix is never reordered and `T` grows append-only, so invalidation lands at task boundaries. **The
  residual cache penalty is measured, not assumed** (H3).
- **The model-view write-back does not exist** (`packages/proxy`, 🔜 in `ARCHITECTURE.md` §3). Until it does, the
  assembled *order* reaches the model through no cell, and no arm can attribute anything to the ordering switches (§5).

### 3.4 Plan gate
- **No cell runs it, and the knob is gone from the policy** (measured 2026-10-02: its only two inputs never occurred in a
  live round). The mechanism is kept and unit-tested for whichever arm next has a plan source the model actually writes
  to; its formulas are `docs/FORMULAS.md` §4.
- The rule that survives it: **ordering-only intervention — the gate may never invent, alter or veto a plan, and it
  never calls System-1 itself.**

### 3.5 Degradation and safety
- **No S1CAP failure may fail the session**: S1 slow or absent → the turn proceeds on the native path, mode logged per
  call. The transport-level guard is a **non-tunable constant** in the client (`packages/s1-client/src/index.ts`).
- Segments passed as S1 `state` are **pre-filtered** (structure stripped, role and a bounded prefix kept), so System-1
  never sees raw untrusted tool output in full.
- The **tool-call/result pairing invariant** holds across any context surgery, in the DSH path and the proxy path alike.

**Rule 13 — a new value must land in every sibling parse path** (a tuning value is parsed in four places: the
credential payload, the command line, the tuning-file reader, and the merge that applies file over payload — adding one
to half of them produced a knob the panel accepted and a session ignored). Grep for every sibling parser, patch all in
one pass, and make the probe print *stored* and *effective* side by side.
**Rule 14 — edit these files line-based, never by eyeballed indentation.** Derive the indentation from the file, assert
post-conditions in the same command that writes, and re-run the suite before committing. *(A missed exact-string anchor
once left the suite red with an undefined symbol.)*

---

## 4. Telemetry and cost accounting

- **The schema is `packages/core/src/telemetry.ts`** — one interface per record, under a version constant, with the
  price table and the cost functions beside it. Field names, optionality and the current set are read there. Rule 5
  applies (add, never rename). **A field that is required and never populated is a defect** — delete it or derive it
  from what the run records; a value set from the policy rather than from the outcome repeats the defect it was meant to
  catch.
- **Two sinks, never one:** the control-plane log (System-1/LLM/tool calls, assembly, delivery, gate) and the session
  log (harness events — the only source of segments). Never merged, never cross-read (rule 6).
- **Cost and time formulas are `docs/FORMULAS.md` §5–§7**; the reporting rule is rule 11. Approval waits are excluded
  from net latency (benchmarks zero them with an auto-approve sandbox); no scalar is formed from the token triple.

---

## 5. Experiment design (three arms: two controls, one arm under test)

- **The arms are defined by the code**: `bench/cells/*.json` + `cellPolicy()`; a run's own configuration is its
  `kind:"wiring"` tape record; the arm ↔ module mapping is `docs/ARCHITECTURE.md` §5. **This file states the design and
  never restates the values.**
- **The scheme is not a 2×2 and never was one in force.** `bench/README.md` states it and this file agrees: **two of the
  three cells are controls** — the baseline `C0`, and `C1`, a second control that delivers nothing — and **`C2` is the
  arm under test**. The registered contrast is **`C0` vs `C2`**. An earlier round ran four cells under different labels;
  its mapping is the table below, kept because the comparison is quoted in other documents and a reader has to be able to
  translate it (`docs/CELLS-RUN.md` §"The arms, and what the contrast is" owns the current scheme; the retired labels'
  own text survives verbatim in `.s1cap-ablation/MOVED-OUT-DOCS-MATERIAL.md` §D.1).
- **Three axes, one registered contrast.** The ordering pair, System-1 governance in the recall lane, and **delivery** —
  which decides whether anything S1CAP assembled reaches the model — are separate switches, and only one cell turns the
  third one on. The registered rule tests that cell against the baseline, and the selection claim rides the same
  contrast.
- **The ordering switches are a *recorded* difference in every arm.** Delivery inserts one `recalled` block and never the
  assembled order, so those switches decide what S1CAP writes into its own record and reach the model through no cell.
- **`C1` stays as a second control arm, and the claim that makes it worth running is that `C0` vs `C1` shows no
  difference.** Its one delivery channel is empty by construction, so its model input is the baseline's; a difference
  there would be the instrument rather than the method.
- **Governance in the executed set is recall selection alone.** The plan gate is designed and unit-tested but no cell
  runs it (§3.4), so a factor listing it would claim a difference the runs did not have.
- **The two model-visible inputs, exactly:** the two controls are the harness's own message list and nothing else, so
  they differ by nothing; the arm under test is that same list plus one inserted `recalled` block. **So today's contrast
  measures the recall lane, not TAS** (§6).
- **Round `20261001-1300` ran four cells under labels that no longer exist.** The mapping, for reading every figure
  quoted from that round:

  | round label | what it ran | today |
  |---|---|---|
  | `C1` | baseline | **`C0`** |
  | `C2` | TAS configured; nothing delivered | **`C1`** (second control arm) |
  | `C3` | the recall-only arm | **dropped, no successor** |
  | `C4` | the full configuration | **`C2`** |

  Wherever a figure is quoted it keeps the round it came from and the label it ran under. Two labels keep the
  comparisons apart: the **registered rule** is the pre-registered comparison against the baseline (`C2` vs `C0`); the
  **design contrast** is `C0` vs `C2`, the comparison that decides whether the System-1 half earns its place. `C1` vs
  `C2` is neither.
- **Controlled:** same tasks, same model with `reasoningEffort` pinned, same harness version, same tool allowlist,
  randomized run order. **No sampling parameter is claimed** — not a temperature, not a seed — because the harness
  exposes none. Paired n per cell per benchmark: SWE-bench Verified 100 (stratified subset of 500), Terminal-Bench 4.0
  all 66, tau2-bench full `base` split (`[VERIFY]` exact count at M0; ~280 expected).
- **Benchmark pools:** SWE-bench Verified (automated FAIL_TO_PASS/PASS_TO_PASS, per-instance docker);
  Terminal-Bench 4.0 (66 tasks, per-task suites, docker, long timeout); tau2-bench (DB end-state reward, LLM
  user-simulator, adds the multi-turn tool-use axis). Excluded with reasons: GAIA, TheAgentCompany, Aider polyglot
  (edit-format confound), LiveCodeBench, OSWorld/WebArena.

---

## 6. Metrics, hypotheses, success rule

**Metric definitions and their one implementation: `docs/FORMULAS.md` §5.1/§6 and `scripts/cell-report.mjs`.** What
follows is the protocol.

- **Primary:** solve rate per benchmark. **Secondary family:** cost/task, time/task, the token triple (uncached input /
  cached input / output), cache-hit rate as a diagnostic, System-1 calls and time, tool errors, overflow events.
- **H2 — the plan gate saves wasted-attempt tokens.** **No arm can test this today**: the gate is designed,
  implemented and unit-tested, but no cell runs it (its two inputs never occurred in a live round). An arm with a plan
  source the model actually writes to is what would test it.
- **H3 — selection, stabiliser and cache, one contrast, and it cuts both ways.** The layout changes the hit rate and the
  net cost effect is measured per update policy; the selection claim rides the same contrast, which is why **H1 is
  retired and folded here, not renumbered** — two hypotheses on one contrast cannot be separated afterwards.
- **H4 — transfer.** The `C0`→`C2` deltas persist on a second harness (opencode) at a 10 % subsample.
- **And what `C0` vs `C2` measures today is the recall lane, not TAS.** The arm under test has one delivery channel,
  which inserts the recalled block and nothing else; the state proxy is deliberately never sent; TAS's ordering reaches
  the model only through the model-view write-back, which does not exist and is a separate project. **Until it does, no
  arm can attribute anything to the ordering switches**, and neither recorded round's contrast measured TAS: in round
  `20261001-1300` *both* arms delivered nothing, so their per-step difference compares two recordings of a layout, not
  two model inputs. The round's selection figures are the recall lane's — the best hit rate beside the largest counts on
  all three components, which is exactly why the counts are the measurement and the hit rate is not.
- **Success rule (the registered rule; it replaces "win any of three"):** solve-rate **non-inferiority** vs the baseline
  (paired McNemar, one-sided α = 0.05, margin −2 pp absolute) **AND** ≥10 % improvement in cost/task **OR** time/task
  with a 95 % CI excluding 0 (paired bootstrap, 10k resamples; Holm across the secondary family). **A cell that wins
  cost but loses >2 pp solve rate is not a win.** Report every cell plus a quality-vs-cost Pareto figure. The test, the
  margin, the seed handling and what the tool refuses are `docs/FORMULAS.md` §8 and `scripts/paired-stats.mjs` — the
  frozen, committed implementation.
- **Validity controls:** pin model versions and log call dates; repeat a 10 % subsample three times (no seed is
  available to vary, so run-to-run variance is the variance there is); automated scorers only, no LLM judges; state the
  contamination caveats and keep a contamination-free spot-check fallback; **the analysis script is frozen and committed
  before the first full run.**
- `[VERIFY]` **Power.** The power analysis is still owed, and the current note is **unresolved — do not plan against
  it**: the start figures (~14–15 pp at n = 100, ~18 pp at n = 66) are not reconcilable with a sign test that runs on
  *discordant* pairs, which would need more discordant pairs than the arm has tasks (`docs/FORMULAS.md` §8.1). Report
  the minimal detectable effect honestly once the analysis module records the discordance it assumed.
- **Cost budget:** ~446 episodes per arm for the three-arm run set (the grid's pools at one draw per task per cell), with
  Terminal-Bench as the **lean assumption** and a 10-task pilot to pin tokens/task before committing. Prices are the
  §1 anchor row; the budget **cap** is the owner's decision (§9).
- **The phase that runs now is a test/optimize loop** — one drawn task under all three cells, optimize, draw again — and
  its record, its evidence and what remains open for the owner are `docs/STATUS.md` §8. What this protocol keeps:
  **one draw supports optimization, not a claim**; an iteration is complete only when the same task has run under all
  three cells; a claim still needs the grid, its metrics and its success rule (§5–§6); and the system under test does not
  change for the loop.

---

## 7. Milestones

Deliverables and their acceptance, outcomes only — the commands are `docs/STATUS.md` §5, the procedure is
`docs/CELLS-RUN.md` / `.s1cap-ablation/RUNBOOK.md`.

| M | Week | Deliverable | Acceptance |
|---|---|---|---|
| M0 | 1 | `[VERIFY]` items closed; monorepo scaffold; S1 client against live Jev + local serve; telemetry v1; plugin skeleton | a composed-config dump shows the bundle; a smoke session delivers assembled context |
| M1 | 2–3 | SEGMENTER + RG + ASSEMBLER; proxy MVP; replay-correctness tests | core coverage ≥90 %; replay invariance green |
| M2 | 3–4 | Plan gate; degradation paths; settings UI; **TB 10-task pilot**; runner set up | pilot report; a baseline-vs-full smoke on 10 SWE-V tasks |
| M3 | 5–6 | Full three-arm run on SWE-V + tau2 (+TB if pilot green); optional local fine-tune + calibration refit | 3 arms × n complete; the frozen stats module emits the report |
| M4 | 7–8 | TB cells; opencode transfer check (10 %); model-swap check (10 %) | H4 evaluated |
| M5 | 9–10 | Paper artifacts: Pareto + cache-waterfall figures, case studies, draft | full draft |

*The plan gate is still built and tested here, but no cell carries it (§3.4); case studies draw on provenance
readbacks, not on a `/s1 why` command — that command was a design note and does not exist.*

---

## 8. Paper: naming and decisions

- **Title:** *S1CAP: Context-Aware Planning via System-1 Models for Efficient LLM Agents*. **Expansion, use everywhere
  the acronym is spelled out: System-1 Context-Aware Planning** — never the retired "Selective Context and Adaptive
  Planning". The two interventions are **Context Awareness** (which segments the model sees) and **Plan Ordering** (the
  order the model's own plans run in) — not "selective context" and "adaptive planning".
- **Naming decided 2026-09-28:** repo `s1cap`, npm proxy `s1cap`, DSH plugin `dsh-s1cap`; paper, repo and plugin names
  aligned. Collision-checked at that date.
- **Outline:** intro (context economics, TAS principle, decision models) · related work (memory, in-loop folding, order
  sensitivity, compression, caching, routing, harness prior art, decision models — full list in
  `docs/RELATED_WORK.md`) · method (control layer, graph, TAS assembly, cost model; the gate stays described as design)
  · setup (the three arms, benchmarks, telemetry) · results (quality/cost/time + Pareto, cache-hit waterfall,
  degradation, case studies) · analysis (when TAS pays for its cache penalty, decision quality vs outcome, failure
  modes) · discussion (limits, ethics, generality).
- **Contributions:** first infrastructure-in-the-loop use of decision models for the agent context lifecycle;
  Trace-as-State transplanted into live agent loops with cache-aware accounting; an open ablation run as three arms with
  a versioned telemetry schema; a DSH plugin plus a portable proxy.
- **Owner decisions that outlive this file — the `desktop` profile is off limits** (it carries other plugins and skills;
  S1CAP runs only in its own clean profile, and no check, junction or patch row ever touches `desktop`); **the System-1
  key is entered by the user in a settings panel**, never read from a file we author and never baked into a profile
  patch, with environment variables as headless fallbacks only.

---

## 9. Open questions for the human (do not decide alone)

1. Primary model: `deepseek-flash` (recommended — cheap, long context) vs GLM-5.3; affects budget and cache fields.
2. Headline System-1 backend for the paper: cloud Jev (quality, trivial integration) vs a local fine-tune (offline
   story, more work, M3 risk).
3. Hard budget cap for the full three-arm run: recommended ≥ $500, to survive a frontier-scale long-benchmark surprise.
   A recommendation, not a settled setting.
4. Target venue and deadline (scopes M5).
5. Publish the local fine-tune weights? (The base licence permits it.)

---

## 10. Sources

| Subject | Source |
|---|---|
| Paper T | arxiv.org/abs/2609.02702 |
| Jev (API, models, pricing, jaggedness, parallel questions) | docs.typesafe.ai |
| Laya · EdgeJev · Kev · laya-mlx | github.com/NandhaKishorM/laya · github.com/yzfly/edgejev · github.com/jaredpalmer/kev · github.com/mizoreww/laya-mlx |
| JevBench leaderboard | benchmarkheaven.com/jev-models |
| DeepSeek pricing · GLM pricing | api-docs.deepseek.com/quick_start/pricing · docs.z.ai/guides/overview/pricing |
| DSH plugin mechanics (peer contracts, profile layout) | registry.npmjs.org/dsh-command-context-trim + the local install (~/.dsh/profiles) |
| opencode · pi-system-one | opencode.ai/docs/providers · registry.npmjs.org/pi-system-one |
| Benchmarks | swebench.com/verified.html · tbench.ai · github.com/sierra-research/tau2-bench |
| Related work (full verified list) | docs/RELATED_WORK.md |
