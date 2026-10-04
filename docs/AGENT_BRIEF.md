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
| Paper T (arXiv:2609.02702, "Trace as State"): a fresh pass ordered `[T, x, q]` — trace **before** the context, question **last** — beats the matched control in 26 of 27 model×task×metric combinations, and the paper places the question last in *both* conditions because models drift otherwise. **Transplant principle: task state discovered late (in reasoning traces) must be available *before* the history on the next pass, and the current instruction stays last.** **Notation, stated once because both this row and §3.3/§4 depend on it: in the paper `x` is the long context and `q` is the question; in this project `x` is the user's latest input and S1CAP's recalled history plays the paper's `x`.** | the layout rule and the reason `x` stays last (§3.3, §4 of this file); the TAS factor in §5 |
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
  the implemented mode exists; a cell must name the mechanism that actually runs. **Since 2026-10-05 the window it
  is batched over is a *row* and the row is bought on demand**: the call happens because a step's recall asked for
  that row (`AssociationGraph.recallDemand`, wired in `packages/dsh-plugin/src/step-observer.ts`), not because the
  segment arrived. At this build's defaults a row is `min(index, w) <= 16` questions against a cap of 20, so one
  row is one call — the *batched* half of the sentence is what makes a row a single request rather than up to
  sixteen. The cost that moves with that change is `recall.depth`'s: the pairs a step pays for are the rows its walk
  reached, so a deeper walk is a larger bill (`docs/FORMULAS.md`, correction 2026-10-05 (ninth)).
- **Tier 2** is lazy verification, only for edges that could enter assembly, with a defined abstention fallback.
- **The scoring window bounds pair scoring only — never what exists in the graph.** Segments outside it keep their edges
  and stay reachable by the BFS — reached from the newer endpoint of a pair, because the walk expands only into
  segments earlier in the session's append order (`docs/FORMULAS.md` §3.2, and the 2026-10-05 update at the end of
  this file). This distinction is the whole point of the window
  (`docs/ARCHITECTURE.md` "Parameter: recall.window", `docs/FORMULAS.md` "Recall window w").

### 3.3 Assembly
- Budget is the window minus the output reserve minus measured fixed overhead — never the raw window.
- Selection is a bounded BFS then a greedy knapsack, deduplicated against the verbatim tail by segment id, every block
  carrying a provenance header.
- **Never dropped, never reordered:** the pinned prefix, the current input `x` (the step's newest input event — the
  recall anchor, `packages/core/src/observer.ts`), and the verbatim tail.
- **`x` last is a requirement, not a preference** (§1, paper T), and it is the last block of every layout by
  construction. `T` existing at all (`tas.on`) and the arm that positions it (`tracePlacement`) are **two independent
  fields**, and only the second is the paper's variable: `tracePlacement` places `T` before the long context or behind
  it. The question is not one of them — the paper holds `q` last in every condition, so no field moves it, and the
  fields that do exist, their values and their defaults are `AssemblyPolicy`'s, not this file's.
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
- **And what the two registered contrasts measure today is the trace's *presence*, not its *position*.** As of
  2026-10-04 the arm under test is not the only cell that delivers: `C1` is the **TAS** arm — the paper's Trace as
  State arrangement, `[T, x, q]`, the state proxy `T` delivered alone with the System-1 lane absent — so `C0 → C1` is
  a clean single-variable contrast and `C1 → C2` is
  what recall selection adds (the registration is `docs/CELLS-RUN.md` "The arms, and what the contrast is", and the
  statement of record is the comment above `cellPolicy()` in `packages/core/src/types.ts`). What is still unmeasured
  is the paper's actual variable: delivery appends and renders `T` before the recalled block by construction, so no
  arm has presented **Trace Append** (`[x, T, q]`), and the field that names TAS against it
  (`policy.tracePlacement`) reaches the recorded `layout.order` and
  not the delivered text. **Until the model-view write-back exists, no arm can attribute anything to the ordering
  switches** (`docs/ARCHITECTURE.md`, `packages/proxy`), and neither recorded round measured TAS: in round
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
| DSH plugin mechanics (peer contracts, profile layout) | registry.npmjs.org/dsh-command-context-trim — **an external community package, and the local-install claim is unverified**: it is not present in the DSH 0.2.0-rc.2 distribution, so read the mechanics from the installed DSH source (`scripts/scan-dsh-asar.cjs`), not from that package |
| opencode · pi-system-one | opencode.ai/docs/providers · registry.npmjs.org/pi-system-one |
| Benchmarks | swebench.com/verified.html · tbench.ai · github.com/sierra-research/tau2-bench |
| Related work (full verified list) | docs/RELATED_WORK.md |

---

## Update 2026-10-04 — three rows of this document corrected, for the record

Recorded per `docs/DOC-CONTRACT.md` §4. **These three were edited in place** — each is a live statement of a
current fact in a live document, and leaving it standing would have left the document asserting something the code
no longer does. The superseded text is carried here so the change is auditable.

1. **§1, the Paper T row (line 72).** It read "a fresh pass ordered `[T, x, q]` — trace before the context,
   question last" and gave the transplant principle, then pointed at §3.3 and §4 of this file as what depends on it.
   It did not say which `x` it meant, while this project's `x` is the user's latest input and the paper's `x` is the
   long context — so the row this file's layout rule rests on could not be read without guessing. **Added one
   sentence stating the mapping**; the paper's facts are untouched, because they were right.
2. **§"Metrics, hypotheses, success rule" (was line 241).** It read "**And what `C0` vs `C2` measures today is the
   recall lane, not TAS.** … the state proxy is deliberately never sent; TAS's ordering reaches the model only
   through the model-view write-back". The state proxy **is** delivered since 2026-10-04, `C1` is the paper's arm,
   and the registered contrasts are `C0 → C1` and `C1 → C2`. **Corrected**, and the conclusion kept in its surviving
   form: what is still unmeasured is the trace's *position*, because the channel appends. The two recorded rounds'
   statements below it are history and are left as written.
3. **§10, the sources table (was line 341).** "registry.npmjs.org/dsh-command-context-trim **+ the local
   install** (~/.dsh/profiles)" asserted a local install of a package that is **not present in the DSH 0.2.0-rc.2
   distribution**. The same correction as `docs/PROPOSAL.md`'s 2026-10-04 append: the package name resolves to
   nothing in that release, and whether it was removed, renamed or never existed cannot be determined from an
   archive snapshot. **The local-install claim is marked unverified rather than deleted**, because this project has
   already shipped one defect closed on an unverified package-name hypothesis (`D4b`).

`docs/RELATED_WORK.md` and `README.md` cite the same repository; both are bare citations of an external project,
which is a different claim from an installed one, and neither needed this correction.

The registration this file now defers to is `docs/CELLS-RUN.md` "The arms, and what the contrast is"; the decision
is `docs/STATUS.md` §10; the code's own statement of record is the comment above `cellPolicy()` in
`packages/core/src/types.ts`.

---

## Update 2026-10-05 — one layout field was renamed and the second was **deleted**; §3.3 and §6 corrected in place

Recorded per `docs/DOC-CONTRACT.md` §4. Both were live statements of a current fact — one in this file's assembly
rules, one in its contrast paragraph — so they were corrected in place, for the reason the 2026-10-04 update gives: leaving
either standing would leave this file asserting something the code no longer has. The superseded text is carried here
verbatim.

**What moved.** `AssemblyPolicy.xFirst: boolean` is now `questionPlacement: 'first' | 'last'` (default `'last'`), and
`AssemblyPolicy.stateProxyPosition: 'before-context' | 'after-context'` is now
`tracePlacement: 'trace-as-state' | 'trace-append'` (default `'trace-as-state'`). The mapping is exact — `true` →
`'first'`, `false` → `'last'`; `'before-context'` → `'trace-as-state'`, `'after-context'` → `'trace-append'` — and a
profile that still sets an old spelling is translated rather than silently run as the default
(`LEGACY_LAYOUT_KEYS`, `packages/core/src/config.ts`, which reports the substitution as a warning). Names, values and
defaults are owned by `packages/core/src/types.ts`, `packages/core/src/config.ts` and the presets; §5's own rule —
"**This file states the design and never restates the values**" — is unchanged.

**Why.** The paper (arXiv:2609.02702, section 4.1) places the question **last in every condition** — "the question appears at
the end of the prompt … place it at the end of every input" — and its two arms are `[T, x, q]` (Trace as State) and
`[x, T, q]` (Trace Append), **order the only difference**. `xFirst` moved the *question*, the one element the paper
fixes, and its name presented that as the paper's variable; `stateProxyPosition` was already the paper's axis, so it
took the paper's names.

**What it cost, measured — round `20261004-0233`'s own `layoutOrder` records.** `C1` and `C2` recorded
`pinned, stateProxy, anchor, recalled, tail` (the question second, neither paper arm) because both set `xFirst: true`;
`C0` (`xFirst: false`, TAS off) recorded `pinned, recalled, tail, anchor`, the paper's baseline `M([x, q])`. The block
order each `tracePlacement` value produces is the table in `packages/core/src/assembler.ts`'s header.

**Superseded wording, verbatim.**

1. §3.3, assembly rules — *"**`x` last is a requirement, not a preference** (§1, paper T). `T` existing at all and the
   position of `x` are **two independent switches** — TAS is not x-first; a preset that moves them together is a
   preset's choice."* The independence is unchanged; the fields it names are `tas.on` and `questionPlacement`, and the
   paper's variable is `tracePlacement`, which is neither. *(Superseded the same day — the second update below records
   that `questionPlacement` was deleted rather than kept, so that clause names a field the build no longer has.)*
2. §6, the contrast paragraph — *"… and `policy.stateProxyPosition` reaches the recorded `layout.order` and not the
   delivered text."* The field is `policy.tracePlacement`.

---

## Update 2026-10-05 (second) — the question axis was **deleted**, not renamed; §3.3 corrected in place

Recorded per `docs/DOC-CONTRACT.md` §4, beside the update above and not in place of it. **Nothing in the update above
is rewritten**: its field mapping is a dated record and is superseded here, and the two clauses below that name
`questionPlacement` as a field are annotated and quoted rather than edited. §3.3's rule is live prose, so it was
corrected in place for the reason that update itself gives.

**What moved — and it is a deletion rather than a rename.** `AssemblyPolicy.questionPlacement: 'first' | 'last'` is
**gone from the tree**. `AssemblyPolicy.tracePlacement: 'trace-as-state' | 'trace-append'` is **the only layout axis**,
and the question `q` is **last by construction in every layout**: `assemble()` appends the anchor unconditionally, the
stable-head token count no longer adds the question's tokens, and `cutAfterBlock` has no `'anchor'` branch. The orders
the build produces are the table in `packages/core/src/assembler.ts`'s header and are not restated here.

**Why the axis was deleted, stated as the argument this file has to keep.** The paper's section 4.1
(arXiv:2609.02702) places
the question last in *every* condition — "Models may not behave as intended unless the question appears at the end of
the prompt. We therefore separate the question from the long context and place it at the end of every input" — and its
two arms are `[T, x, q]` (**TAS**, Trace as State) and `[x, T, q]` (Trace Append), "order as the only difference".
This project's older `xFirst` boolean moved the *question*, the one element the paper fixes, and its name presented
that as the paper's variable. **Renaming it to `questionPlacement: 'first' | 'last'` kept the mistake alive**: it left
"the question's position is a variable" expressible, and `'first'` produced `[T, q, x]`, which is **neither paper
arm**. A field whose other value lays out a condition the paper does not have is not a variable, so the axis was
deleted.

**What happens to an old profile — the split, pointed at rather than copied.** `LEGACY_LAYOUT_KEYS`
(`packages/core/src/config.ts`) reads `xFirst` and `questionPlacement` and reports: a spelling that asks for what
every layout now does is a **warning** ("retired: … nothing was applied because nothing needed to be"), and a spelling
that asks for the question *first* is an **error** that quotes the paper sentence that retired it and names
`tracePlacement`. The same split is enforced on the panel's command line and its PUT route, and the panel no longer
offers a question control. The keys, the values and the messages are the code's and are not restated here.

**The evidence, from round `20261004-0233`'s own `layoutOrder` records.** `C0`
`["pinned","recalled","tail","anchor"]`; `C1` and `C2` `["pinned","stateProxy","anchor","recalled","tail"]` — the
question second in the TAS cells, which is neither paper arm.

**Superseded wording, verbatim.**

- The closing clause of the bullet above (the update above's *"Superseded wording"* item 1): *"The independence is
  unchanged; the fields it names are `tas.on` and `questionPlacement`, and the paper's variable is `tracePlacement`,
  which is neither."* It named a field the build no longer has; the corrected bullet in §3.3 names `tas.on` and
  `tracePlacement` and says the question is not a field at all.
- §3.3, the rule corrected above: *"`T` existing at all (`tas.on`) and the question's position
  (`questionPlacement`) are **two independent fields**, and neither is the paper's variable"*. Both halves are now
  wrong in a second way: it counted a deleted axis as a field, and it was written beside a correction whose own
  heading called the change a *rename*.

**Outstanding in this file, and deliberately not corrected here.** §5 ("Experiment design …", lines 181–200) still
carries the pre-2026-10-04 registration — *"two of the three cells are controls … `C1`, a second control that delivers
nothing"*, *"only one cell turns the third one on"*, *"the two controls are the harness's own message list and nothing
else, so they differ by nothing"*, *"`C1` stays as a second control arm"* — which `docs/STATUS.md` §10's addendum and
`cellPolicy('C1')`'s `deliver: true` superseded on 2026-10-04. That is a different correction with its own evidence
and is left to its own pass. **The rename adds two phrases to that pass**, because they name the old composition
rather than the field: §5's *"The ordering pair"* and *"The ordering switches are a **recorded** difference in every
arm"* — under the rename the layout fields are the *same* in every cell on purpose (no preset carries either), and
what separates the recorded orders is `tas.on`. The arms themselves are named in `docs/CELLS-RUN.md` "The arms, and
what the contrast is": the baseline, **TAS** (the paper's Trace as State arrangement, `[T, x, q]`), and that plus the
System-1 lane — while the paper's other arm, **Trace Append** (`[x, T, q]`), is named by the placement axis rather
than run by a cell.

---

## Update 2026-10-05 (third) — the BFS expands only into **earlier** segments: §3.2's window invariant corrected in place

Recorded per `docs/DOC-CONTRACT.md` §4, beside the two updates above and not in place of either.
The §3.2 bullet is a live invariant, so the direction clause was **added in place**; the claim it makes about `w` is
unchanged, and the bullet as it stood is quoted verbatim below.

**What moved.** The recall walk expands only into segments **earlier in the session's append order** — a step never
goes to a segment that arrived later (`packages/core/src/assoc-graph.ts`, `isBackwardStep`). The rule and its
measurement are `docs/FORMULAS.md` §3.2 and the 2026-10-05 correction at the foot of that document.

**Why the bullet needed the clause rather than a rewrite.** "Stay reachable by the BFS" is true of every pair `w`
leaves in place, and a reader who knows the graph stores one score per pair — indexed in both directions, which
`neighbors()` still is — can read it as reachable from either end. That reading is the defect the fix removes:
round `20261004-0233`'s own trees have **255 forward edges of 540** (47.2 %, the widest idx 1 → 28) and the fixed
build takes **0 of 360** (`packages/core/test/forward-edge-audit.ts`).

**The superseded wording, verbatim.**

> - **The scoring window bounds pair scoring only — never what exists in the graph.** Segments outside it keep their
>   edges and stay reachable by the BFS. This distinction is the whole point of the window
>   (`docs/ARCHITECTURE.md` "Parameter: recall.window", `docs/FORMULAS.md` "Recall window w").

---

## Update 2026-10-05 (fourth) — the recalled block moved behind the tail, **inside `x`**: the paper's two arms are unchanged

Recorded per `docs/DOC-CONTRACT.md` §4, beside the three updates above and in place of none of them. The paragraph the
report names is the **Why the axis was deleted** paragraph of the update above, which states the paper's variable and
its two arms; that statement stands exactly as written, and this update is what a reader of it now needs beside it. No
live rule in this file printed the block order, so nothing here was corrected in place.

**What moved.** The recalled block now sits **immediately before the anchor**, behind the tail — it used to be third of
five, with `tail` and `anchor` behind it. The block order each `tracePlacement` value produces is the table in
`packages/core/src/assembler.ts`'s header and is not restated here.

**Why the arms are untouched.** The sentence above is right as it stands: the paper's two arms are `[T, x, q]` (Trace
as State) and `[x, T, q]` (Trace Append), "order as the only difference", and the variable is where `T` sits relative
to the long context `x`. The recalled block is part of `x` — the paper's long context, which §1's notation row says
S1CAP's recalled history plays — so a block that moves *inside* `x` leaves the variable where it was: `T` is still
ahead of every block of `x` under `'trace-as-state'` and behind all of them under `'trace-append'`. **The arm did not
move; the order inside it did.** `AssemblyLayout.order` (`packages/core/src/types.ts`) is the statement of record for
which blocks make up `x`.

**Why the block moved.** A prompt cache is a prefix cache: a change at any token breaks the match from that token to the
end of the prompt, so everything placed behind a block that changes every step is re-prefilled with it. The recalled
block is the block a re-selection moves; putting it last within `x` means a re-selection costs the question and nothing
else. **Measured on round `20261004-1458` C2**: the whole-prompt invalidation span per delivered pair fell from **2,539
to 2,111 tokens** with this move, on top of the ordering change that had already cut it from **6,179 to 2,539**.

**What this update does not touch.** §3.3's live rules are unaffected: `x` is still the last block of every layout by
construction, the pinned prefix / `x` / verbatim tail are still never dropped or reordered, and `T`'s position relative
to the long context is still the only layout axis. The dated evidence in this file (round `20261004-0233`'s own
`layoutOrder` records) is that round's record and is left as written, as is every quoted superseded sentence above.
