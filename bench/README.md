# bench — 2×2 ablation harness

The design is the 2×2 ablation — `tas.on`/`xFirst` against S1 governance — and **the next round runs three of its
four cells: C1, C2 and C4.** Cell presets live in `cells/`; runners land with M2 (`docs/AGENT_BRIEF.md` §9).

| Cell | `tas.on` + `xFirst` | S1 governance (selection + plan gate) |
|---|---|---|
| C1 baseline | off / off | off (native compaction only) |
| C2 TAS alone | **on / on** | off |
| C4 full | **on / on** | **on** |

`tas.on` and `xFirst` are independent switches that this table's presets happen to move together — `tas.on` decides
whether the state proxy T exists at all (the trace-as-state mechanism from paper T), while `xFirst` decides whether
the current task x sits before or after the recalled block — so one column records both here, and neither name alone
tells you where x goes. Neither `xFirst` nor `deliver` is repeated in the preset files: `cellPolicy(cell)`
(`packages/core/src/types.ts`) supplies them, and a value written into a preset would silently override the cell.
Each preset also carries one non-config key, `_meta`, recording that cell's role and its status in the run set (in
`cells/C3.json` it keeps the retired arm's measurements); a loader reads the config keys and ignores `_meta`, which
`validatePolicy` reports as an unknown key while still returning `ok: true`.

**The fourth arm, C3 — recall selection with `tas.on: false` — is not run.** Per step it moves more new tokens than
the baseline and reuses less of what it sends: **3 625** uncached input tokens against 2 595, **2 574** output tokens
against 1 523, and a **79.2%** cache hit rate against 86.7%; its backend coverage was 22.5%, below the 0.5 floor, so
the cell was not a measurement of System-1 governance however it is labelled. Those are per-step comparisons, and
they are the only comparisons available here: C3's absolute totals are *lower* than the baseline's — 219 737 tokens
against 400 034 — but that is a step-count difference rather than an effect, because C3 ran 11 steps against C1's 19,
and absolute totals are not comparable across these cells.

It is also not the contrast the project's claim rests on. That contrast is **C2 (TAS alone) against C4 (the full
configuration)** — C2 measured **14 441** tokens per step against the baseline's 21 054 (about 0.69×), **1 783**
uncached input tokens per step against 2 595 (also about 0.69×) and **1 493** output tokens against 1 523, so if C4
cannot beat C2, the System-1 half has not earned its place in the configuration, and nothing about that argument
needs a fourth arm. The cell names are unchanged and no `C0` is introduced: `cellPolicy()`, the presets here, the
settings panel and the `cell` field on every telemetry record all bind to C1–C4. C3 is retired **in place**, in
`cells/C3.json`, with its status and these measurements recorded in that file; the pairing is also one that
`validatePolicy` warns about (`recall.tier1 !== 'off'` with `tas.on: false`), so it has to be chosen on purpose
rather than by accident. The full four-cell ablation stays the goal once the C2-vs-C4 contrast is established, and
the budget that dropping the arm frees goes to repeats of C1, C2 and C4 (`docs/CELLS-RUN.md`), because one run per
cell cannot separate an effect from noise.

Benchmarks (all automated scoring): SWE-bench Verified (100/cell), Terminal-Bench 4.0 (66/cell),
τ²-bench (full base split). Model `deepseek-v4.1-flash`, with its `reasoningEffort` pinned; DSH's model config
exposes no sampling parameters — no temperature and no seed — so none is claimed here.

**Metrics: three token quantities, not a scalar.** Per cell, per turn and per step, a report states **uncached input
tokens, cached input tokens and output tokens** as counts. They are reported separately and **never collapsed into a
weighted total**: the three types carry three prices, prices differ per model and per provider, and a weighted scalar
is therefore a property of a price list rather than of the system under test — the same rows would rank differently
against another provider's rates. `cacheHitRate` is kept as a *mechanism* diagnostic: it answers whether the prefix
stayed stable across steps, not what the run cost, and it is read beside the counts, never instead of them.

**Success rule:** solve-rate non-inferiority vs C1 (paired McNemar, one-sided α=0.05, margin −2 pp)
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
- **ablation cells**: `cellPolicy(cell)` (`packages/core/src/types.ts`) derives C1–C4 from toggles, with the
  invariants fixed in *every* cell (`termination: model-owned`, `rgMaintenance.mode: async`) and asserted in
  `packages/core/test/authority.test.ts`.

Still open, and cheap to close later: recall scoring is lexical today (BM25/entity overlap); adding an
embedding backend touches the assembler's candidate generation only.
