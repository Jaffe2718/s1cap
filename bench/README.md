# bench — three-cell ablation harness

The design space is the 2×2 ablation — `tas.on`/`xFirst` against S1 governance — and **the scheme runs three cells:
C0, C1 and C2.** Cell presets live in `cells/`; runners land with M2 (`docs/AGENT_BRIEF.md` §9).

| Cell | `tas.on` + `xFirst` | S1 governance (selection + plan gate) |
|---|---|---|
| C0 baseline | off / off | off (native compaction only) |
| C1 TAS alone | **on / on** | off |
| C2 full | **on / on** | **on** |

`tas.on` and `xFirst` are independent switches that this table's presets happen to move together — `tas.on` decides
whether the state proxy T exists at all (the trace-as-state mechanism from paper T), while `xFirst` decides whether
the current task x sits before or after the recalled block — so one column records both here, and neither name alone
tells you where x goes. Neither `xFirst` nor `deliver` is repeated in the preset files: `cellPolicy(cell)`
(`packages/core/src/types.ts`) supplies them, and a value written into a preset would silently override the cell.
Each preset also carries one non-config key, `_meta`, recording that cell's role and its status in the run set; a
loader reads the config keys and ignores `_meta`, which `validatePolicy` reports as an unknown key while still
returning `ok: true`.

**The two control arms carry no System-1 lane at all.** C0 and C1 pin `s1.provider: none`: `recall.tier1: 'off'`
disables recall *selection*, but association-graph upkeep is not gated on it, so a scorer would still run and both
arms would report System-1 calls — 363 and 257 of them in round `20261001-1300`. `provider: none` makes the lane
absent rather than merely unscoped, which is what a no-System-1 control has to be: zero System-1 calls, tokens and
time. C2 keeps `provider: jev` and its retries. A live profile pairs `provider: none` with `laya.enabled: false`,
because `laya.enabled: true` beside `provider: none` is a reported conflict (`singleBackendIssues`,
`packages/s1-client/src/resolve.ts`); `laya` is a profile key, so that recipe sits in each preset's `_meta` rather
than in the preset itself.

**The scheme is three cells.** A fourth arm — recall selection with `tas.on: false`, the governance half without the
state proxy — was run once, under the old cell names, and dropped. Per step it moved more new tokens than the
baseline and reused less of what it sent: **3 625** uncached input tokens against 2 595, **2 574** output tokens
against 1 523, and a **79.2%** cache hit rate against 86.7%; its backend coverage was 22.5%, below the 0.5 floor, so
the arm was not a measurement of System-1 governance however it is labelled. Those are per-step comparisons, and they
are the only comparisons available here: the dropped arm's absolute totals are *lower* than the baseline's — 219 737
tokens against 400 034 — but that is a step-count difference rather than an effect, because it ran 11 steps against
the baseline's 19, and absolute totals are not comparable across these cells.

It is also not the contrast the project's claim rests on. That contrast is **C1 (TAS alone) against C2 (the full
configuration)** — C1 measured **14 441** tokens per step against the baseline's 21 054 (about 0.69×), **1 783**
uncached input tokens per step against 2 595 (also about 0.69×) and **1 493** output tokens against 1 523, so if C2
cannot beat C1, the System-1 half has not earned its place in the configuration, and nothing about that argument
needs a fourth arm. The pairing that dropped arm named is still one `validatePolicy` warns about
(`recall.tier1 !== 'off'` with `tas.on: false`), so a profile can still select it, on purpose rather than by
accident — no preset does. The budget that dropping the arm frees goes to repeats of C0, C1 and C2
(`docs/CELLS-RUN.md`), because one run per cell cannot separate an effect from noise.

Benchmarks (all automated scoring): SWE-bench Verified (100/cell), Terminal-Bench 4.0 (66/cell),
τ²-bench (full base split). Model `deepseek-v4.1-flash`, with its `reasoningEffort` pinned; DSH's model config
exposes no sampling parameters — no temperature and no seed — so none is claimed here.

**Metrics: three token quantities, not a scalar.** Per cell, per turn and per step, a report states **uncached input
tokens, cached input tokens and output tokens** as counts. They are reported separately and **never collapsed into a
weighted total**: the three types carry three prices, prices differ per model and per provider, and a weighted scalar
is therefore a property of a price list rather than of the system under test — the same rows would rank differently
against another provider's rates. `cacheHitRate` is kept as a *mechanism* diagnostic: it answers whether the prefix
stayed stable across steps, not what the run cost, and it is read beside the counts, never instead of them.

**Success rule:** solve-rate non-inferiority vs C0 (paired McNemar, one-sided α=0.05, margin −2 pp)
**AND** ≥10% improvement in cost/task or time/task (paired bootstrap 95% CI excluding 0) — its cost component read as
the three per-task token quantities above, not as a weighted total.

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

- **token / cache telemetry**: `packages/core/src/telemetry.ts` v1 already records the three quantities per step —
  `cacheHitTokens`, `cacheMissTokens` and `outputTokens` — and `summarizeTask` aggregates them per task as
  `tokens.hit` / `tokens.miss` / `tokens.out`, so no run has to be repeated to obtain the counts. It derives
  `cacheHitRate = hit / (hit + miss)`, the mechanism diagnostic above, and it can also price a run
  (`llmCallCost`, `s1CallCost`, the `PRICES` table) — but a price list is an *input* to that call, which is why the
  counts are the measurement and any USD figure is stated with the price list it used.
- **ablation cells**: `cellPolicy(cell)` (`packages/core/src/types.ts`) derives C0–C2 from toggles, with the
  invariants fixed in *every* cell (`termination: model-owned`, `rgMaintenance.mode: async`) and asserted in
  `packages/core/test/authority.test.ts`.

Still open, and cheap to close later: recall scoring is lexical today (BM25/entity overlap); adding an
embedding backend touches the assembler's candidate generation only.
