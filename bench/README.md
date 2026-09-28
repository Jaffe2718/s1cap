# bench — 2×2 ablation harness

Cell presets live in `cells/`; runners land with M2 (`docs/AGENT_BRIEF.md` §9).

| Cell | TAS ordering | S1 governance (selection + plan gate) |
|---|---|---|
| C1 baseline | off | off (native compaction only) |
| C2 | **on** | off |
| C3 | off | **on** |
| C4 full | **on** | **on** |

Benchmarks (all automated scoring): SWE-bench Verified (100/cell), Terminal-Bench 4.0 (66/cell),
τ²-bench (full base split). Model `deepseek-flash`, temperature 0.

**Success rule:** solve-rate non-inferiority vs C1 (paired McNemar, one-sided α=0.05, margin −2 pp)
**AND** ≥10% improvement in cost/task or time/task (paired bootstrap 95% CI excluding 0).

Planned layout:

```
bench/
  runners/    swe-verified/ | terminal-bench/ | tau2/
  stats/      McNemar + paired bootstrap + Holm; frozen before the first full run
  analysis/   Pareto and cache-waterfall figures
```

## Selection status — deferred to M3 (user decision 2026-09-28)

Which suites to run, how many instances per cell, and whether recall uses lexical scoring or embeddings are
**evaluation-stage questions**; they are deliberately unanswered until M3. Nothing in M1/M2 depends on them,
because the two pieces that would have been expensive to retrofit are already in place:

- **cost / cache telemetry**: `packages/core/src/telemetry.ts` v1 already records `cacheHitTokens`,
  `cacheMissTokens` and `outputTokens` per step, and derives cached-token cost and `cacheHitRate` from the
  hit/miss prices — so no run has to be repeated to obtain the cost claim.
- **ablation cells**: `cellPolicy(cell)` (`packages/core/src/types.ts`) derives C1–C4 from toggles, with the
  invariants fixed in *every* cell (`termination: model-owned`, `rgMaintenance.mode: async`) and asserted in
  `packages/core/test/authority.test.ts`.

Still open, and cheap to close later: recall scoring is lexical today (BM25/entity overlap); adding an
embedding backend touches the assembler's candidate generation only.