# S1CAP Project Proposal (Human-Readable Edition)

**Version** 0.1 · 2026-09-28 · For Supervisor / Cooperator
**Companion documents:** [AGENT_BRIEF.md](./AGENT_BRIEF.md) (the complete implementation specification to feed to the coding agent, in English) · [RELATED_WORK.md](./RELATED_WORK.md) (the full related-work archive, every entry verified via URL)

---

## 0. One-Page Summary

**In one sentence**: a System-1 decision model (decision model, Jev/Laya/Kev class, speaking the `/v1/systemone` protocol) that is roughly 50–100 times cheaper than an LLM acts as the **context lifecycle control layer** of an LLM agent harness — maintaining an association graph over session segments, assembling each turn's context in Trace-as-State order, and pre-ranking candidate plans before execution — reducing token cost and latency without sacrificing task solve rate, with complete cache hit / cache miss telemetry as the evidence.

**Why now**: three elements have only just come together in September 2026 —
1. **Trace as State** (arXiv:2609.02702, Z.ai & Tsinghua University, 2026-09-02): it shows that "placing the reasoning trace as a state proxy **before** the long context" (`[T, x, q]`) beats placing it after on 26/27 configurations, **and needs no training** — a purely inference-time technique that a harness plugin can port;
2. **A new decision model category is born**: TypeSafe AI's Jev (2026-09-15, $0.042/M input, free output, parallel query evaluation) and the open-source Laya (2026-09-18, Apache-2.0, 322M/421M, 15.6ms/decision locally) — the cost of a "System-1 call" drops from "one LLM call" to "noise level";
3. **Cache economics becomes a hard constraint**: DeepSeek `deepseek-flash` cache hit price $0.006/M vs. miss $0.30/M (**50x**) — how context is assembled, what may be reordered and what may not, directly determines cost.

**Core hypotheses**: H2, plan pre-ranking can eliminate wasted execution attempts; H3 (selection, stabiliser and cache — one contrast, two-sided risk), Trace-as-State reordering will change the cache hit rate and the net effect must be measured rather than assumed, and association-graph selection plus the plan gate reduce context tokens at a non-inferior solve rate; H4, the gains transfer across harnesses. **H1 is retired, folded into H3**: with the recall-only arm dropped, `C2` is the only arm that runs System-1 governance, so the selection claim can only be observed as `C1` vs `C2` — the contrast the cache effect is already measured on — and two hypotheses riding one contrast cannot be separated afterwards (`docs/AGENT_BRIEF.md` §9.3, which keeps the round's numbers).

**Success rule (revised, see §5.3)**: the solve rate is **non-inferior** to the baseline (paired McNemar, one-sided α=0.05, tolerance −2pp) **and** cost or time improves by ≥10% (paired bootstrap 95% CI excluding 0). The earlier "any one of the three counts as success" rule is no longer used.

**Verdict preview**: the review returned **Accept with Revisions** (worth doing, pending the validation experiment; every revision point has been absorbed into this proposal and AGENT_BRIEF).

---

## 1. Research Questions

- **RQ1**: Can a System-1 decision model perform context segment relevance judgments and plan pre-ranking inside the agent loop at negligible cost?
- **RQ2**: When the "state-first" principle of Trace-as-State is ported from single-document long-context question answering to an agent harness, does it still bring quality/cost/time gains (net of the cache penalty)?
- **RQ3**: Do the gains hold across harnesses (DSH / opencode / Claude Code / pi) and across models (DeepSeek / GLM)?

## 2. Terminology Normalization Table (original prompt wording → canonical wording)

| Original prompt wording | Canonical wording | Notes |
|---|---|---|
| Paper T | Trace as State (arXiv:2609.02702) | Cited by full name; the mechanism is "state proxy T placed before the long context", with **question q always last** |
| x inversion | TAS ordering (Trace-as-State layout) | Note: paper T does not mean "put x first"; it means putting the **state T distilled from the trace before the history** and the current instruction last; this project adopts `[pinned \| T \| recall blocks \| near-tail raw text \| x]` |
| laya / **Jav** | **Laya** / **Jev** | Jev (TypeSafe AI); Laya (Convai Innovations, open source). "Jav" is a typo |
| System 1 model | decision model (System One) | TypeSafe officially calls them System One models; the community (Maggie Appleton) suggests decision models — the paper uses the dual name "decision models (System One)" |
| Relevant Graph (RG) | association graph | Aligned with the terminology in the GAAMA/HippoRAG literature |
| Relevant Context (RC) | assembled context / context assembly | Aligned with the standard terminology of the context engineering survey (arXiv:2507.13334) |
| bsf algorithm | **BFS** (breadth-first search) | |
| utterance/segment | segment (message-level segment) | Granularity = message/tool call/reasoning block, **never token level** |
| deepseek-v41-flash | **`deepseek-flash`** | The actual API model id; the version name is DeepSeek-V4.1-Flash; there is no id "deepseek-v4.1-flash" |
| answering multiple-choice questions | choice question (noul/score/choice) | The terminology for Jev's three query types |
| cache hit/miss | prompt cache hit / miss | DeepSeek fields: `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` |
| unauthorized operations | permission-gated tool calls | Their waiting time is deducted from the latency statistics |
| question bank | benchmark suite / task set | |
| task completion | solve rate | |

## 3. Methodology (Post-Optimization)

### 3.1 Overall Architecture: System-1 Control Plane / System-2 Compute Plane

The cheap decision model runs as the **control layer** (the S1CAP control plane) between the harness and the LLM, with no modification to the LLM itself. Components: SEGMENTER (segmentation) → S1 association backend (scores new segment × historical segments and expands the RG) → RG STORE (association graph) → ASSEMBLER (within-budget BFS selection + TAS layout) → System-2 LLM → S1 decision backend (choice scoring of candidate plans) → PLAN GATE (normalization, abstention, attempt cap, ordering) → TELEMETRY (versioned JSONL telemetry). Adapters: a first-class DSH plugin (`dsh-s1cap`) + an OpenAI-compatible proxy (portable to opencode / Claude Code / pi).

### 3.2 Four Key Revisions to the Initial Design

1. **Two-level recall replaces "Laya pairwise scoring directly"**. Verification finding: the Laya base model is **near random zero-shot** (0.362 vs. random 0.318; 0.766 after fine-tuning), and it fails with >20 options. Hence: tier-0 metadata edges (free) → tier-1 candidate generation (local embedding ANN, or batched S1 noul queries) → tier-2 lazy verification (score reranking only for edges that may enter assembly). With cloud Jev as the default, the S1 cost is at noise level (about $0.04 per session); the local path uses EdgeJev (322M INT8, 324MB, 15.6ms/decision on a 4-core vCPU) or laya-typed-decisions after M3 fine-tuning.
2. **"x inversion" corrected to a faithful TAS port**. The transferable principle of paper T is that "state information discovered late should be available before the context in the next pass, with **the question always last**". Assembly layout: `[pinned (system + tool schema, cache-stable prefix) | T (state proxy: serialized reasoning trace + task brief, ≤8k characters, append-only, updated per task) | recall blocks (descending w_eff, strongest first — the Lost in the Middle U-shape) | near-tail K turns of raw text | x + current state snapshot]`.
3. **Cache economics as a first-class citizen**. The hit price is 1/50 of the miss price (DeepSeek peak hours), so: (a) the pinned prefix is never reordered; (b) T is updated at task boundaries (`perTask` by default, `perTurn` optional); (c) **making H3 explicit** — the net effect of TAS reordering on the hit rate must be measured call by call (citing the conclusion of arXiv:2601.06007: cache-aware assembly beats naive caching).
4. **Safety rails on the plan gate**. Jev's probabilities are **not guaranteed to be normalized** (documented example P+¬P=1.19) → server-side normalization; the decision model can be steered by adversarial content → the state passed into S1 is pre-filtered (stripping over-long code blocks/URLs); attempt cap M=2 (candidate plans m ≤ 3); below 0.5 confidence it abstains and falls back to the LLM's own order.

### 3.3 Native DSH Advantages (verified from the local installation and community plugins)

**Release scope:** the observations in this subsection are from the DSH **0.1.7-rc.2** line (`docs/AGENT_BRIEF.md`
§1.8): the session model, the `surfaceOp` rewrite and the interception points listed below are evidence about that
release, and they have **not** been re-confirmed on the release the machine runs now (`docs/STATUS.md` §8). The
plugin's *activation* on that newer release — bundle load, commands, composed config, the surfaces the plugin
itself serves — has since been re-checked on **0.2.0-rc.2** and is recorded per fact in §1.8.

DSH's session model separates a **persistent append-only event log (the human record, never rewritten) from the surface (the model's view)**, and `surfaceOp {op:'replace'}` allows changing only the context the model sees — **natively satisfying "present strictly in chronological order to the user, reorganize internally for the model"**. Interception points: `agent/pre-step` (assembly before the LLM call), `agent/request-error` (waterfall + prepend), `ctx.tokenMeter` (shadow-price accounting), `@deepseek-ai/dsh-compaction` (tool pairing integrity). The existing plugin `dsh-command-context-trim` (model-free oldest-first trimming) is precisely the spiritual prototype of the C0 baseline and the engineering template for the plugin mechanism.

## 4. Experimental Design

### 4.1 2×2 Factorial, three arms run (within-task pairing)

| Cell | A: TAS ordering | B: S1 governance (recall selection + plan gate) |
|---|---|---|
| C0 baseline | off (chronological appending) | off (harness-native compaction only) |
| C1 | **on** | off |
| C2 full | **on** | **on** |

Same tasks, same model, same harness version, same tool allowlist, randomized order. The runs pin
`reasoningEffort` on `deepseek-v4.1-flash` and claim no sampling parameter, because DSH exposes none
(`docs/CELLS-RUN.md` §Setup carries the run prerequisites).

The fourth quadrant of the 2×2 — recall selection with TAS off — is **dropped from the run set and has no
successor**: per step it moved more uncached input and more output than the baseline at a lower cache hit rate, and
its System-1 coverage was below the 0.5 floor that makes a cell a measurement of System-1 at all (`docs/CELLS-RUN.md`
carries the numbers and the mapping table). Round `20261001-1300` ran under an earlier labelling: `C1` (baseline) is
today's **`C0`**, `C2` (TAS alone) is today's **`C1`**, `C3` (recall selection with `tas.on: false`) is **dropped,
no successor**, and `C4` (the full configuration) is today's **`C2`**.

### 4.2 Benchmark Suite (all automatically scored, no GUI, no LLM judging)

| Benchmark | Scale/cell | Role | Status |
|---|---|---|---|
| SWE-bench Verified | 100 (stratified sample) | the classic issue→patch coding signal | MIT, verified |
| Terminal-Bench 4.0 | all 66 | long-horizon terminal tasks — DSH's home turf | Apache-2.0, Harbor framework |
| τ²-bench (tau2) | full base set (about 280, M0 verification) | the multi-turn tool + user interaction axis | MIT, pure Python |

**Run a 10-task TB pilot first to calibrate cost** (TB is the main cost driver and the largest uncertainty: the lean assumption is 5M in/task vs. 20–65M/task at frontier scale). Excluded: GAIA (browsing + multimodal noise), TheAgentCompany (30GB+ infrastructure + LLM-judging confound), OSWorld/WebArena (GUI).

### 4.3 Statistical Protocol and Success Rule

- Primary metric, solve rate: paired **McNemar**, non-inferiority (one-sided α=0.05, tolerance −2pp absolute);
- Secondary metrics, $/task, tokens/task (split into hit/miss/out), wall-clock/task (net LLM + S1 + tools, **excluding permission-approval waiting**): paired **bootstrap** (10k resamples) 95% CI, Holm correction;
- Success = non-inferior **and** (cost or time improvement ≥10% with a CI excluding 0). Winning on cost while the solve rate drops by >2pp does not count as a win;
- Report all cells + a quality-cost **Pareto plot** + a cache hit rate waterfall chart (H3);
- The analysis scripts are **frozen and committed before** the first full run (pre-registration style); three repeats of a 10% subsample estimate the variance — no sampling seed exists to vary, because DSH exposes no sampling parameters (only the model and its `reasoningEffort` are pinned).

### 4.4 Telemetry (versioned JSONL, fields in AGENT_BRIEF §8)

Each LLM call records prompt/cacheHit/cacheMiss/output tokens, net latency, and S1 auxiliary statistics; each S1 call records type/cost/latency; each assembly records the number of candidates, the number selected, BFS depth, budget usage, layout blocks, and the length of the cache-stable prefix; the plan gate records each plan's probability/confidence/execution/verification/estimated tokens saved.

### 4.5 Generalization (defusing the "result engineering for DSH" concern)

- **Cross-harness**: C0 vs C2 retested through the proxy on opencode with a 10% subsample of the same benchmarks (Claude Code/pi are stretch goals); the same core package, the same telemetry schema, with only the adapter layer differing;
- **Cross-model**: the 10% subsample retested with GLM-5.3;
- All model versions and call dates are logged; the contamination risk of SWE-bench Verified is declared in the paper, with a 20-task SWE-bench-Live spot check as a control.

### 4.6 Budget (`deepseek-flash`, peak-hour prices)

**Three arms run** (~446 episodes per arm, so ~1,340 where the 2×2 grid budgeted ~1,780) ≈ **$360 (peak) / $180 (off-peak)** — the same per-arm density as the four-arm $480/$240, scaled by three quarters and shown so it can be checked: SWE-V ≈ $16 + τ² ≈ $17 + TB ≈ $330, so ≈ $363 (lean assumption, **revised after the pilot**). Off-peak = 50% off everywhere outside UTC weekdays 01:00–04:00 and 06:00–10:00 — schedule accordingly. Optional: a `deepseek-v4-pro` control arm on SWE-V, +$57 (was $76); GLM model-swap check, +$30 (was $40). S1 (cloud Jev) is about $0.04 per session, negligible. This is an estimate at the same density, not a ceiling: the cap is open question 3 below.

## 5. Milestones (10 Weeks) and Suggested Division of Labor

| Week | Milestone | Acceptance |
|---|---|---|
| 1 | M0: close all `[VERIFY]` items; monorepo scaffolding; s1-client connected to real Jev/laya-serve; telemetry v1; DSH plugin skeleton | `dsh --dump-config` shows the bundle; a hard-coded assembly in a smoke session rewrites the surface |
| 2–3 | M1: SEGMENTER+RG+ASSEMBLER; proxy MVP; replay consistency tests | core coverage ≥90%; replay invariants pass |
| 3–4 | M2: plan gate; degradation paths; settings UI; **TB 10-task pilot** | the pilot report fixes the cost model; 10-task C0/C2 smoke |
| 5–6 | M3: the 2×2 crossing on SWE-V + τ², three arms; (optional) Laya fine-tuning + calibration | the frozen statistics module produces the report |
| 7–8 | M4: TB cells; opencode migration check; GLM model-swap check | H4 reaches a conclusion |
| 9–10 | M5: paper figures (Pareto, cache waterfall, `/s1 why` case study) + LaTeX first draft | full first draft |

Suggested division of labor: one person leads core + the DSH plugin, one leads bench runners + stats; the two write the paper together and run it through pre-submission-reviewer before submission.

## 6. Risks and Mitigations

| Risk | Level | Mitigation |
|---|---|---|
| The field window is moving extremely fast (Jev 09-15, Laya 09-18, pi-system-one 09-22, hermes-jev-skills already exists) | High | Publish a preprint quickly; anchor the contribution to "reproducible 2×2 measurement + versioned telemetry + cross-harness transfer" — the integration repositories have none of these |
| Laya is weak zero-shot (quality risk on the local path) | Medium | Cloud Jev by default; the local path is tied to the M3 fine-tuning milestone; two-level recall reduces the dependence on S1 accuracy |
| H3 backfires: TAS reordering lowers the hit rate and net cost worsens | Medium | This is a **publishable negative-result axis**; comparing the two `updatePolicy` settings yields a conditional conclusion; cite 2601.06007 when designing the cache-aware layout |
| TB cost runs out of control | Medium | The 10-task pilot comes first; calibrate against the Artificial Analysis per-model cost page for TB 4.0; TB can be degraded to a 33-task subset |
| Jev jaggedness (math/dates/adversarial content) | Medium | Arithmetic and dates always stay in code; state pre-filtering; server-side probability normalization |
| Fast DSH release cadence (0.1.2→0.1.7-rc) | Low | Pin peerDeps + declare a compatibility matrix; probe the surfaceOp shape (what context-trim does) |

## 7. Review Verdict (idea-evaluator, appendix)

- **Type**: Technique paper (Novel Method) — porting the Trace-as-State principle and decision models into agent harness infrastructure, with measurements.
- **Fatal-flaw audit**: no CRITICAL. F1 novelty was verified on the ground (three parallel verification passes + repository-level search): **nobody combines (a) association graph + (b) within-budget turn-by-turn assembly + (c) same-model plan pre-ranking + (d) cache/latency telemetry**; the nearest neighbors are hermes-jev-skills (integration with no evaluation), GAAMA (graph but embeddings + PPR, conversational memory), AgentFold (model self-folding, no external decision model), and Don't Break the Cache (measurement without a method). The risk is MAJOR (window movement), not fatal.
- **Five-dimension scores** (5 is the default, mechanism arguments may raise it, all labeled "mechanism-based, not yet confirmed by data", validation experiment = the C2 vs C0 paired grid): Higher **6** (paper T's 26/27 win rate suggests the ordering gain transfers, but agent task shapes differ, so the claim is non-inferiority); Faster **8** (S1 at millisecond scale vs. LLM at second scale; parallel noul batching is 12.2× cheaper; the plan gate avoids wasted attempts); Stronger **6** (degradation paths + cross-harness checks, but the main grid uses a single provider); Cheaper **8** (the 50× price gap on hit rate is the biggest lever; TB dominates cost, calibrated by the pilot); Broader **7** (one proxy covers four harnesses; the protocol standard `/v1/systemone`; the decision model is swappable).
- **Paradigm probes**: First principles ✓ (challenges "context must be appended chronologically"; paper T has both theory and empirics); Elephant in the room ✓ (everyone complains about agent cost and context rot); Technology cycle ✓ (the decision model category only appeared in 2026-09, suddenly making S1 governance nearly free); Hamming ✓ (if it holds, agent economics change). 4/4.
- **Feasibility**: compute low (API + CPU); data low (all benchmarks open source); engineering medium (plugin + proxy + runner, all with templates); time medium (10 weeks is tight but staged, with the TB pilot up front to control risk).
- **Verdict**: **Accept with Revisions** (worth pursuing, pending the validation experiment). The revision items have been absorbed: (1) the success rule changed to non-inferiority + superiority; (2) two-level recall replaces naive Laya scoring; (3) the H3 cache penalty is made explicit; (4) terminology corrections (§2); (5) the 2×2 factors are formalized.
- **Three first actions**: (1) execute M0 per AGENT_BRIEF (scaffolding + s1-client + telemetry + plugin skeleton); (2) pin down the cost model with the TB 10-task pilot; (3) freeze the statistics scripts and the telemetry schema before the full run.

## 8. Naming and Release

- **Paper title (revised 2026-09-28 after the naming erratum)**: *S1CAP: Context-Aware Planning via System-1 Models for Efficient LLM Agents*. The acronym expands to **S**ystem-**1** **C**ontext-**A**ware **P**lanning, and the two interventions are Context Awareness (which segments the model sees) and Plan Ordering (the order its own plans run in). Duplicate check: no "S1CAP" conflict in the AI/agent field (all search hits are false positives from the medical literature on "severe CAP"). Related work to cite in §2 — no longer a name collision, but still the closest neighbouring idea: [Xiao et al., EMNLP 2023](https://github.com/liyucheng09/Selective_Context) prunes tokens for input compression, while S1CAP selects whole segments through an association graph across the agent context lifecycle; the paper must distinguish the two explicitly.
- **Repository (finalized, 2026-09-28)**: `s1cap` — the repository has been created at [github.com/Jaffe2718/s1cap](https://github.com/Jaffe2718/s1cap); the npm names `s1cap` (proxy) and `dsh-s1cap` (DSH plugin) are both unregistered (verified 404), keeping paper/repo/plugin aligned. Namespace note: the bare `system-one`/`s1` prefixes are already crowded in the decision model ecosystem (s1-rs, pi-system-one, system-one-core), while the CAP suffix is exclusive.
- **Description**: *A System-1 decision model (Jev/Laya/Kev-class) governs the context lifecycle of LLM agent harnesses: an association graph over session segments, relevance-gated context assembly with Trace-as-State ordering, and pre-execution plan ranking — with full cache-hit/miss, cost, and latency telemetry. DSH plugin + harness-agnostic proxy.*
- **Topics**: `llm-agents` `context-engineering` `agent-memory` `context-window` `prompt-caching` `kv-cache` `system-one` `decision-models` `jev` `laya` `small-language-models` `coding-agent` `deepseek-harness` `dsh-plugin` `agent-harness` `opencode` `claude-code` `benchmark` `ablation-study`
- **Release channels**: dshmarket / DSH Plugin Hub / GitHub topic `dsh-plugin`; the paper's target venue is TBD (Open Questions #4).

## 9. Open Questions (requiring the Supervisor's decision)

1. Primary model: `deepseek-flash` (recommended: cheap, 1M ctx, has vision) vs GLM-5.3;
2. The S1 backend the paper leads with: cloud Jev (quality, simple integration) vs. locally fine-tuned Laya/EdgeJev (offline story, with the work in M3);
3. Budget ceiling for the **future full crossing** — all four quadrants, the four-arm basis of §4.6 (≈ $480/$240), not the ≈ $360/$180 three-arm run set that runs today: recommended ≥$500. A recommendation for the supervisor's decision, not a settled setting.
4. Target venue and submission deadline (determines the scope of M5);
5. Whether to release the Laya fine-tuned weights (the Apache-2.0 base permits it).

## 10. References (all verified via URL; the complete archive is in RELATED_WORK.md)

Trace as State: arXiv:2609.02702 · Jev: docs.typesafe.ai · Laya: github.com/NandhaKishorM/laya · EdgeJev: github.com/yzfly/edgejev · Kev: github.com/jaredpalmer/kev · JevBench: benchmarkheaven.com/jev-models · DeepSeek pricing: api-docs.deepseek.com/quick_start/pricing · GLM pricing: docs.z.ai/guides/overview/pricing · Don't Break the Cache: arXiv:2601.06007 · GAAMA: arXiv:2603.27910 · AgentFold: arXiv:2510.24699 · Lost in the Middle: arXiv:2307.03172 · Context Engineering Survey: arXiv:2507.13334 · dsh-command-context-trim: github.com/snailium/dsh-command-context-trim · pi-system-one: npmjs.com/package/pi-system-one · SWE-bench Verified: swebench.com/verified.html · Terminal-Bench: tbench.ai · τ²-bench: github.com/sierra-research/tau2-bench
