# Running the three cells

The ablation the project is judged on: **what the run measures, why the arms are these three, and how to read the
result.** The procedure itself — profiles, ports, launch order, pre-flight, per-cell steps, troubleshooting — is
`.s1cap-ablation/RUNBOOK.md`; this document states the registration and the reading rules that the procedure
implements, and it points at the code, the presets and the round's own records for every value.

**Where material that used to sit in this document now lives** (2026-10-02, cut back to what running a round
needs): the round's *setup and prerequisites* and the *machine-specific launch findings* → `.s1cap-ablation/RUNBOOK.md`
(which the pointers below name where a document still refers to "Setup"); the *back-pressure analysis*, the
*S1-call-volume / pair-count* findings and the *stimulus-setting levers* (`recall.window`,
`s1.questionsPerCall`) → the measured back-pressure in round `20261001-1300`'s own record
(`.s1cap-ablation/round-20261001-1300/ROUND-REPORT.md`) and the retry/admission levers in `bench/README.md`, with the
window's own algorithm and its pair-count result in `docs/FORMULAS.md` §"Recall window w" (the unrouted part of that
block is still in `.s1cap-ablation/MOVED-OUT-DOCS-MATERIAL.md` §A); the *report generator's row list and
invocation* → `scripts/cell-report.mjs` (`METRICS` and its usage block) with the specification in
`docs/FORMULAS.md` §5.1; the *retired three-turn fixture's description* → the last short-task round's record,
`.s1cap-ablation/round-20261001-1414/ROUND-REPORT.md`; and round `20261001-1300`'s *label table and measured
tables* → that round's own record, `.s1cap-ablation/round-20261001-1300/ROUND-REPORT.md`.

## The question this run answers

The **registered rule** — the pre-registered comparison of `docs/FORMULAS.md` §8 — needs the full configuration
(`C2`) to beat the baseline (`C0`) on one of completion / cost / time. The question started from a measurement: the
baseline arm of round `20261001-1300` (the cell that round called `C1`, today's `C0`) measured an 86.7%
prompt-cache hit rate, and the owner asked whether S1CAP's context management is what lowers it.

Mechanically, the answer is not "yes, by construction". `AssemblyResult.cacheStability` defines the cache-stable
head as `pinned + T` (plus `x` when `xFirst` is on), and `cutAfterBlock` names the first block behind that cut: a
re-selection re-prefills everything after it. So recalled content sitting *behind* the cut changes nothing about
the stable head, while a re-selection happening *inside* a task pays for the whole tail. The knob that decides
between those is `cache.reselectPolicy` — `perTask` freezes the selection inside a task (cache-aligned, the
default), `perTurn` does not.

Which means the suspect is identifiable from the comparison rather than from the absolute number: three turns are
three tasks, so three re-selections are *expected* and 86.7% may be unremarkable. **The hit rate rides along as a
mechanism diagnostic, not as the finding**: it is a ratio, and a cell can win on it while moving more tokens on all
three quantities — which is what the full configuration did in round `20261001-1300` (the arm that round called
`C4`, today's `C2`). An absolute number proves nothing here.

## The arms, and what the contrast is

**A round runs three cells: C0, C1, C2.** The names are the code's — `cellPolicy()`, the presets in `bench/cells/`,
the settings panel, the `cell` field on every telemetry record and this document all bind to C0–C2. **Two of the
three are controls** (C0 and C1) and one is the arm under test (C2); the set is three cells wide, not a 2×2, and
the placebo is the third.

What each arm **is**:

| Cell | What it is |
| --- | --- |
| `C0` | baseline: the harness manages history natively, and nothing is delivered |
| `C1` | **second control arm**: the TAS switches are recorded configuration and nothing is delivered, so the model reads what C0's model reads |
| `C2` | the project's own configuration; the only cell that delivers |

What each arm is **set to** is not restated here: the presets (`bench/cells/*.json`) and `cellPolicy()`
(`packages/core/src/types.ts`, which supplies the switches a preset deliberately leaves out and the fields fixed in
every cell) own the values, and a run's own `kind:"wiring"` tape record is what a cell actually ran.

**The design contrast — the comparison that decides whether the System-1 half earns its place — is `C0` against
`C2`.** That is the pair the registered rule tests (`docs/FORMULAS.md` §8: paired McNemar on completion, paired
bootstrap on cost and time). It is also the only contrast this run set can support: `C1` delivers nothing, so its
model-visible input is C0's, and `C0` vs `C1` must show no difference — a difference there is the instrument rather
than the method.

**What that contrast measures today, stated plainly: the recall lane, not TAS.** `C2`'s delivery channel inserts
recalled turns and nothing else (`deliverContext` renders `recalled`; the state proxy `T` is deliberately never
sent), and `C0` and `C1` deliver nothing at all — so what separates the arms on the model's side is recall
selection and its insertion, while the TAS ordering half (`tas.on`, `xFirst`) is recorded in every arm and reaches
the model in none. TAS's ordering becomes measurable when the assembled view is written back into the model view,
which `docs/ARCHITECTURE.md` carries as a 🔜 row (`packages/proxy`, not written). **That write-back is a separate
project**, and until it exists no arm can attribute anything to `tas.on` or `xFirst`. What a TAS arm would need, so
that it is not re-invented as another rename: (i) a channel that delivers the *layout* — the order of the blocks the
model reads — rather than one inserted `recalled` block; (ii) an arm that differs from `C0` in that ordering alone;
and (iii) a way to see from the artifacts that the model read that order.

**A figure from an older round is not a contrast.** Round `20261001-1300` measured the TAS-configured arm (then
`C2`, today's `C1`) below the baseline on all three quantities — about 0.69× per step — and that round's own
control plane shows both arms delivering nothing (`delivered: false` on all 13 of the TAS arm's deliveries, 0 of 13
assemblies with a non-empty recalled block, 19 of 19 refused by policy in the baseline). **Two arms whose
model-visible input differed by nothing cannot support a difference of 0.69× per step**, so those figures are not
evidence about TAS. **Neither round's contrast measured TAS.** Where the mappings and figures of that round are
kept is in its own record (`.s1cap-ablation/round-20261001-1300/ROUND-REPORT.md`): its labels are per-round and are
never re-labelled into today's scheme, and every quotation of a round's numbers carries the round and the label the
cell ran under.

**Repeats are still what a claim needs.** One run per cell cannot separate an effect from noise, and round
`20261001-1300` shows how much noise there is: the full-configuration arm's per-turn hit rates were 90.3 / 83.5 /
94.3% — a ±10 pp spread *within one cell*, with no stable ordering. So run C0, C1 and C2 several times each and
report the repeats as a distribution per cell (min / median / max, and the count), not as one mean over runs that
disagreed. Each repeat keeps its own workspace and its own telemetry paths. The current phase spends its budget on
single draws for **optimization**; the grid is what a **claim** waits for.

## What a round measures: one drawn long-horizon task

**One task, drawn at random, run under all three cells before the next draw.** Short-turn token accounting was
retired as a measurement on 2026-10-01 — the decisions and the loop that replaces it are recorded in
`docs/STATUS.md` §8 and are not repeated here. The stimulus comes from its pool (the pools are named in `docs/AGENT_BRIEF.md` §5), the round runs the instance as the
pool ships it, and it records the instance's id and its pool beside
the evidence. **The round does not restate the task in its own words.**

**The three-turn fixture in `scripts/round-tasks.json` is not part of a round at all.** It is the last short-task
round's stimulus; nothing in this procedure runs it, and the file is kept for that round's readability. What
validates the environment before a round is the **`PROBE` pre-flight instance** and its checks
(`.s1cap-ablation/RUNBOOK.md` step 6), never a three-cell round.

## Running it: the disciplines that change the result

These are the rules that decide whether a round measures the configuration or the operator. The steps that carry
them out are the run book's.

- **One fixed prompt, sent as recorded.** The stimulus is read from its source and pasted, never retyped at a
  keyboard: a stimulus that is retyped is a stimulus that has changed. The round records what it sent — the source
  path or pool + instance id, and the bytes — so a later reader can tell a changed prompt from a changed result.
  `scripts/prompt-hash.mjs` is the machinery for that: `hash` the source, `verify` the delivery, `cells` for the three.
- **No intervention after the prompt.** A cell is driven by an agent, so a question is a turn spent waiting for an
  answer nobody sends: the no-question rule is stated in the stimulus as well as enforced structurally. A cell that
  stalls, loops or asks something is recorded as a **failed cell** and the round moves on. Round `20261001-1300`
  needed two human interventions in one cell, which is why its numbers describe the operator's work rather than the
  configuration's.
- **Serial, and isolated.** Cells run one after another, and **no two cells share a workspace or a telemetry
  path**: a benchmark instance is a repository, so each cell gets its own copy under `<run>/ws/<cell>`, or one
  cell's edits become the next cell's starting state. How the instance is materialized belongs in the round's own
  record.
- **The lane must be absent, not merely unscoped, in the controls.** `recall.tier1: 'off'` disables recall
  *selection* and leaves association-graph upkeep running, so a control arm with a live provider still scores pairs
  and still reports System-1 calls. A no-System-1 control has to have the lane absent, so that its System-1 calls,
  tokens and time are zero *by construction* rather than by failure.
- **A live profile must pair `s1.provider: "none"` with `laya.enabled: false`.** `laya.enabled: true` beside
  `provider: none` is a reported conflict (`singleBackendIssues`, `packages/s1-client/src/resolve.ts`), and a
  conflict drops the session to `provider=none` — the cell then makes **no System-1 calls at all** while the panel
  merely says the server is "stopped". **Confirm the lane and the provider the instance actually reports before
  driving it**, and read them from the wiring record, not from the profile you wrote.
- **The measured gotcha that cost a round the most time: a task that must edit an existing file.** Overwriting an
  existing file failed in every sandbox mode (`SetFileSecurityW EACCES` on the sibling temp directory the editor
  creates), and what decides it is the launch parent — an instance launched from a **sandboxed parent shell**
  inherits the restricted token into everything it spawns. A stimulus that only creates *new* files never sees it;
  one that asks for an existing file to be corrected does, and the cell stops and asks a human instead of
  finishing. A drawn benchmark task is a repository, so this is the common case, not the corner.
- **The model and the sampling claim.** The cell model is `deepseek-flash` (DeepSeek-V4.1-Flash) with
  `reasoningEffort` pinned, through `agent-default-model` in the copied profile. **No sampling parameters are claimed:** DSH exposes none, so
  temperature and the like are not part of this run's setup and must not appear in a report of it.
- **The DSH release is resolved per round, frozen for the whole round, and quoted with every number.** Take the
  latest release available when the round starts and write it into the round's record. A version change between
  cells invalidates the round: it is restarted, not continued. The value lives in the round's record, not here, so
  that no number in this document goes stale.
- **Read JSONL with `node`, not PowerShell** (which mangles UTF-8). Counts, timings and paths belong in a report;
  session content does not.

## The measurement, and what must be in the round's record

**The primary measurement is a triple of raw token counts, not a rate and not a scalar.** Per cell, per turn and
per step, the report states `(n_miss, n_hit, n_out)` — uncached input tokens, cached input tokens, output tokens —
as counts. The triple's definition is `docs/FORMULAS.md`'s; where each count is read from in the run's own
artifacts is:

| quantity | source |
| --- | --- |
| uncached input tokens | `data.usage.inputTokens` on `assistant/message` events — on this usage shape it counts the prompt tokens that *missed* the cache, not all prompt tokens |
| cached input tokens | `data.usage.cacheReadTokens` |
| output tokens | `data.usage.outputTokens` |
| steps, turns (the denominators) | `step/start` and `turn/start` counts in the harness session store, with the assembly-record count beside them as a cross-check |

The shape was verified on every session of round `20261001-1300`: `totalTokens = inputTokens + cacheReadTokens +
cacheWriteTokens + outputTokens`, and `cacheWriteTokens` was 0 in all four arms — which is what licenses reading
`inputTokens` as the miss side.

The report generator is `scripts/cell-report.mjs`: it is the single implementation of the metrics, its `METRICS`
table is the list of quantities, and its header carries the usage line. `docs/FORMULAS.md` §5.1 owns the metric
specification and the coverage floor a cell must clear to count as System-1-governed. Four rules about reading its
output, which the numbers cannot tell you by themselves:

- **A lane-absent zero is not a refused zero.** A cell with no lane prints `0 (no S1 lane)` and its coverage is
  **undefined**, not `0/N`: the backend was never asked, while the local lexical fallback still built edges. A
  refused lane prints its `ok / refused / total` split and a measured coverage. The two must never print the same
  way — a zero by construction and a zero by failure are different claims about the cell.
- **System-1 calls do not align to steps.** They carry a timestamp but no turn or step, so they are attributed by
  containment, and the remainder is printed as its own rows (between steps, between turns, after the last turn).
  The rows must add up to the cell total.
- **System-1 time is concurrent, not additive.** It must never be added to LLM time; lane time can exceed the
  wall-clock width of the turn it sits in.
- **A snapshot can be read mid-round.** Check the report's snapshot instant and the artifact mtimes before quoting
  a run as finished.

**What the round must leave behind, beside its evidence:** the round id; the drawn instance (pool, id) and the
stimulus as sent; the DSH release; the model and `reasoningEffort`; the three cells with their profiles, ports and
telemetry paths; the per-cell `kind:"wiring"` record, which is what the cell actually ran; and the report with its
own snapshot instant. Evidence lives under the round directory (`.s1cap-ablation/round-<id>/`), per cell, with each
cell's own `control.jsonl`, session store and association-graph snapshot — the three sources the report reads, and
`Step 8 — the report` in `.s1cap-ablation/RUNBOOK.md` says how it is generated and what its header must show.
