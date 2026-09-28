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
