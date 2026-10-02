# bench — three-cell ablation harness

The scheme runs **three cells — `C0`, `C1` and `C2` — and it is not a 2×2: two of the three are controls (`C0` the
baseline, `C1` a second control arm that delivers nothing) and one is the arm under test (`C2`), so the registered
contrast is `C0` against `C2`.** The design space behind them is the `tas.on`/`xFirst` crossing against S1
governance, and the full crossing is what a later phase would run. Cell presets live in `cells/`; runners land with
M2 (the milestone plan is `docs/AGENT_BRIEF.md`'s).

The per-cell values are **not tabulated here**, because they are not this file's to own: `cells/*.json` are the arm
definitions (each preset's `_meta` carries the measured reason for its own recipe, and a loader reads its config keys
while ignoring `_meta`), and `cellPolicy(cell)` in `packages/core/src/types.ts` supplies the switches a preset must
not repeat — a value written into a preset would silently override the cell. The harness that runs a round keeps its
own table of the same cells (`.s1cap-ablation/cells.mjs`: the profile, port and cell each instance boots), so read
those three when the question is "what is C1's `tier1`" rather than a copy of the answer here.

**The plan gate is no longer part of that governance (recall selection), in any cell.** It was, until 2026-10-02: C2
carried `planGate: { on: true, ... }` and the wiring record announced `planGate: true`. Round `20261002-2037` — the
round C2 was written for — contains **zero** `plan_gate` records in any of its artifacts across 277 steps, because the
gate can only read a plan from a numbered list in an assistant message or a `todo/write` session event, and that run
produced neither. The knob is removed from the presets, the policy, the config schema, the status route and the report
rather than given a new plan source: adding one would change what C2 *is* mid-study, and the `C0`-vs-`C2` contrast is
a comparison between cells that were actually run. `packages/core/src/types.ts` carries the full reasoning, and
`bench/cells/C2.json`'s `_meta.planGateRemoved` the evidence. The mechanism is kept and still unit-tested
(`packages/core/src/plan-gate.ts`, `packages/dsh-plugin/src/plan-gate-runtime.ts`, whose only importer is its own
test) for whichever arm next has a plan source the model writes to. Nothing takes over its role.

`tas.on` and `xFirst` are independent switches that the presets happen to move together — `tas.on` decides
whether the state proxy T exists at all (the trace-as-state mechanism from paper T), while `xFirst` decides whether
the current task x sits before or after the recalled block — so neither name alone tells you where x goes. `xFirst`
and `deliver` are supplied by `cellPolicy(cell)` (`packages/core/src/types.ts`) and are deliberately **not** repeated
in the preset files, because a value written into a preset would silently override the cell. Each preset also carries
one non-config key, `_meta`, recording that cell's role and its status in the run set; a loader reads the config keys
and ignores `_meta`, which `validatePolicy` reports as an unknown key while still returning `ok: true`.

**The two control arms carry no System-1 lane at all.** C0 and C1 pin `s1.provider: none`: `recall.tier1: 'off'`
disables recall *selection*, but association-graph upkeep is not gated on it, so a scorer would still run and both
arms would report System-1 calls (the counts that rule rests on are in each preset's `_meta.providerNone` and in round
`20261001-1300`'s record). `provider: none` makes the lane absent rather than merely unscoped, which is what a
no-System-1 control has to be: zero System-1 calls, tokens and time. C2 keeps a live local lane (the preset in
`bench/cells/C2.json` owns its provider, retry and admission values), and the two knobs there answer two different
failures: a retry is the answer to *one* refusal, while the admission cap is the answer to a backend refusing
everything. A refused call falls back to the local lexical scorer, so `judgedPairs / scoredPairs` is reported either
way. `bench/cells/C2.json`'s `_meta.retry` and `_meta.admissionLimit` carry the measured run behind both. A live
profile pairs `provider: none` with `laya.enabled: false`,
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

It is also not the contrast the project's claim rests on. That contrast is **C0 (the baseline) against C2 (the full
configuration)** — the pair the registered rule tests (`docs/FORMULAS.md` §8), and the only one this run set can
support, because `C2` is the only cell whose assembled view reaches the model. The figures the old `C1`-vs-`C2`
reading rested on are history and not a contrast: in round `20261001-1300` the arm then read as TAS alone (round
`C2`, today's `C1`) measured **14 441** tokens per step against the baseline's 21 054 (about 0.69×), **1 783**
uncached input tokens per step against 2 595 (also about 0.69×) and **1 493** output tokens against 1 523 — but that
round's own control plane shows **both arms delivering nothing** (13 of 13 deliveries `delivered: false`, 0 with a
non-empty recalled block, against 19 of 19 refused by policy in the baseline), and two arms whose model-visible input
differed by nothing cannot support a difference of 0.69× per step. So those figures are not a stabiliser effect, and
**what `C0` vs `C2` measures today is the recall lane, not TAS**: the ordering reaches the model only through the
model-view write-back, which does not exist yet (`docs/ARCHITECTURE.md`; a separate project). The pairing that
dropped arm named is still one `validatePolicy` warns about
(`recall.tier1 !== 'off'` with `tas.on: false`), so a profile can still select it, on purpose rather than by
accident — no preset does. The budget that dropping the arm frees goes to repeats of C0, C1 and C2
(`docs/CELLS-RUN.md`), because one run per cell cannot separate an effect from noise.

Which suites, how many instances per cell, which model and what budget are **not restated here**: `docs/AGENT_BRIEF.md`
owns the task pools, the grid, the budget and the success rule (its experiment-design and metrics sections), and the
model a run actually used is its profile's `agent-default-model` row recorded in that run's own manifest. DSH's model
config exposes no sampling parameters — no temperature and no seed — so none is claimed anywhere.

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

Which suites to run and how many instances per cell are **evaluation-stage questions**; they are deliberately
unanswered until M3. One question that used to sit here is closed: `recall.tier1` accepts only `s1` (one batched
`noul` call, the mode every selecting cell runs) and `off`, and the `embed` mode is designed, **not implemented**,
and **rejected** by `validatePolicy` (`docs/FORMULAS.md` §2). Nothing in M1/M2 depends on them,
because the two pieces that would have been expensive to retrofit are already in place:

- **token / cache telemetry**: `packages/core/src/telemetry.ts` v1 already records the three quantities per step —
  `cacheHitTokens`, `cacheMissTokens` and `outputTokens` — and `summarizeTask` aggregates them per task as
  `tokens.hit` / `tokens.miss` / `tokens.out`, so no run has to be repeated to obtain the counts. It derives
  `cacheHitRate = hit / (hit + miss)`, the mechanism diagnostic above, and it can also price a run
  (`llmCallCost`, `s1CallCost`, the `PRICES` table) — but a price list is an *input* to that call, which is why the
  counts are the measurement and any USD figure is stated with the price list it used.
- **ablation cells**: `cellPolicy(cell)` (`packages/core/src/types.ts`) derives C0–C2 from toggles, with the
  invariants every cell shares fixed in the policy itself and asserted in `packages/core/test/authority.test.ts` —
  the policy is the list, so it is not copied here.

Still open, and cheap to close later: the tier-1 *axis* of the design is **unmeasured**. `recall.tier1` accepts only
`s1` and `off`; the implemented `s1` mode is one batched `noul` call whose refusals fall back to the local lexical
scorer, so "recall scoring is lexical today" describes the fallback rather than the selector; and the `embed` mode is
designed and **not implemented** — no embedder, `source: 'embed'` never assigned to an edge, `recall.embedModel` read
by nothing — so no arm can run or deliver an embedding-based recall, and a rename cannot measure it. Implementing it
touches the assembler's candidate generation only.
