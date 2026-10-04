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
window's own algorithm, its pair-count result and **the values that ran** in `docs/FORMULAS.md` §"Recall window w" —
**the window and the depth are `defaultPolicy()`'s since 2026-10-05 (`w = 16`, `d = 16`, with the cost they rest on in
that section's 2026-10-05 correction; the presets carry `d` explicitly and inherit `w`)**; the unrouted part of that
block is still in `.s1cap-ablation/MOVED-OUT-DOCS-MATERIAL.md` §A; the *report generator's row list and
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
head as `pinned + T`, and nothing else: the question is the last block of every layout, so it can never be in the head
and no field puts it there (the fields and their
definitions are owned by `packages/core/src/types.ts`), and `cutAfterBlock` names the first block behind that cut: a
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
the settings panel, the `cell` field on every telemetry record and this document all bind to C0–C2. **One is a
control** (`C0`, the baseline, which delivers nothing) **and the other two are the two steps of the intervention**:
`C1` is the paper's arm and `C2` adds S1CAP's recall selection on top. The set is three cells wide, not a 2×2.

What each arm **is**:

| Cell | What it is |
| --- | --- |
| `C0` | baseline: the harness manages history natively, and nothing is delivered |
| `C1` | **the paper's arm**: the trace `T` is delivered and nothing else — no recall selection (`recall.tier1: 'off'`) and no System-1 lane (`s1.provider: 'none'`) — so `C0 → C1` is the paper's own contrast with the lane **absent** rather than merely unscoped |
| `C2` | the project's own configuration: `T` plus recall selection and its insertion; `C1 → C2` is what recall selection buys on top |

What each arm is **set to** is not restated here: the presets (`bench/cells/*.json`) and `cellPolicy()`
(`packages/core/src/types.ts`, which supplies the switches a preset deliberately leaves out and the fields fixed in
every cell) own the values, and a run's own `kind:"wiring"` tape record is what a cell actually ran. **Since
2026-10-05 the recall pair is `recall.window = 16` and `recall.depth = 16`**: all three presets carry `"depth": 16`
explicitly (they carried `2`) and **none carries `window`**, so the window reaches every cell from `defaultPolicy()`
— see the correction at the foot of this document and `docs/FORMULAS.md` §"Recall window w" for the cost it rests on.

**The design contrast is two steps, and the endpoint is `C0` against `C2`.** The endpoint test is unchanged
(`docs/FORMULAS.md` §8: paired McNemar on completion, paired bootstrap on cost and time — nothing about the
pre-registered statistic moved). What changed on 2026-10-04 is that `C0` vs `C2` alone no longer isolates one thing,
because `C2` differs from `C0` in the recall selection **and** in `T`. So the registered contrasts are the paper's own
two steps — **`C0 → C1`**, what the trace's presence buys with the System-1 lane absent, and **`C1 → C2`**, what
recall selection buys on top of it — and a round that reports only the endpoint has run an arm that cannot say which
half did the work. `C0` vs `C1` is **no longer a placebo check**: `C1` delivers `T`, so a difference there is the
expected finding, not the instrument talking. The statement of record is the comment above `cellPolicy()` in
`packages/core/src/types.ts`.

**What each contrast measures today, stated plainly: the trace's *presence*, not its *position*.** Since 2026-10-04
`T` is delivered through the same channel that already inserted recalled turns, so `C1` reads `[…, x, T]` and `C2`
reads `[…, x, T, recalled, …]` (`packages/dsh-plugin/src/context-delivery.ts`). `C0` still delivers nothing, which
is what makes `C0 → C1` a clean single-variable contrast.

**What is still not measurable is the paper's actual variable, which is placement.** The paper contrasts
`M([T, x, q])` against `M([x, T, q])` — the *same* trace before the context, against the same trace after it.
Delivery here places `T` before the recalled block **by construction**: the module renders `T` first whatever the
layout order says, so no arm presents the trace *after* the context, and `policy.tracePlacement` — the enforced
knob naming the two orders, and deliberately absent from every preset because a value in one would put a cell on one
side of the paper's own control — is read into the recorded `layout.order`, **not into the delivered text**. **A round
can now answer "does the trace help?" and cannot yet answer "does putting it first help more than putting it last?"**
The latter needs the assembled view written back as a *layout* rather than appended as a block, which
`docs/ARCHITECTURE.md` carries as a 🔜 row (`packages/proxy`, not written). What such an arm would need, so that it
is not re-invented as another rename: (i) a channel that delivers the *layout* — the order of the blocks the model
reads — rather than one appended block; (ii) an arm that differs from its pair in ordering alone, with
`tracePlacement` flipped in one profile and nowhere else; and (iii) a way to see from the artifacts that the
model read that order.

**A figure from an older round is not a contrast.** Round `20261001-1300` measured the TAS-configured arm (then
`C2`, today's `C1`) below the baseline on all three quantities — about 0.69× per step — and that round's own
control plane shows both arms delivering nothing (`delivered: false` on all 13 of the TAS arm's deliveries, 0 of 13
assemblies with a non-empty recalled block, 19 of 19 refused by policy in the baseline). **Two arms whose
model-visible input differed by nothing cannot support a difference of 0.69× per step**, so those figures are not
evidence about TAS. **Neither recorded round's contrast measured TAS, because neither round predates the delivery of
`T`** — that is a statement about the two rounds on disk, not about the design above, which `C0 → C1` does now test
for the trace's *presence*. Where the mappings and figures of that round are
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
  *selection* — and since scoring became on demand (2026-10-05) that also means a control arm with a live provider
  makes **no System-1 calls at all**: the pairs are bought by a step's recall, the recall is off, so nothing is
  asked (the walk is not started; `packages/dsh-plugin/src/step-observer.ts`). Before that date `tier1: 'off'` left
  the *eager* upkeep sweep running and such an arm still scored pairs and reported System-1 calls, which is what the
  next sentence was written against. A no-System-1 control must still have the lane absent, so that its System-1
  calls, tokens and time are zero *by construction* rather than by the absence of a caller.
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

---

## Update 2026-10-04 — the registration was re-opened while this document was live; what changed and what did not

Recorded per `docs/DOC-CONTRACT.md` §4. **The prose above was edited in place rather than left standing**, because
this document is the one an operator reads *before* a round and a stale registration is not a historical fact, it is
a wrong instruction. What each replaced sentence said is carried here so the change is auditable rather than
silent.

**What changed in the code.** `cellPolicy('C1')` sets `deliver: true`, the delivery channel
(`packages/dsh-plugin/src/context-delivery.ts`) sends the state proxy `T`, and `AssemblyPolicy.stateProxyPosition`
exists as the enforced knob naming the paper's two orders. The registered contrasts are now `C0 → C1` and `C1 → C2`
— the comment above `cellPolicy()` in `packages/core/src/types.ts` is the statement of record.

**The sentences this replaces, verbatim.**

1. *"`C1` | **second control arm**: the TAS switches are recorded configuration and nothing is delivered, so the
   model reads what C0's model reads"* — no longer true. `C1` delivers `T`, and `T` alone is a delivery.
2. *"`C2` | the project's own configuration; the only cell that delivers"* — no longer true; `C1` delivers too.
3. *"**Two of the three are controls** (C0 and C1) and one is the arm under test (C2); … the placebo is the third."*
   — `C1` was the placebo only while its delivery channel was structurally empty.
4. *"**The design contrast … is `C0` against `C2`.** … It is also the only contrast this run set can support:
   `C1` delivers nothing, so its model-visible input is C0's, and `C0` vs `C1` must show no difference — a
   difference there is the instrument rather than the method."* — the reason for the rule was the reason `C1` was
   closed, and that reason is gone. **The endpoint test in `docs/FORMULAS.md` §8 did not move**; what moved is the
   decomposition into two steps.
5. *"**What that contrast measures today, stated plainly: the recall lane, not TAS.** … `deliverContext` renders
   `recalled`; the state proxy `T` is deliberately never sent … TAS's ordering reaches the model only through the
   model-view write-back, which does not exist …"* — falsified on its factual half (`T` is sent). Its *conclusion*
   survives in a sharper form and is kept above: **placement** is still unmeasured, because the channel appends and
   renders `T` before the recalled block whatever the layout order says.

**Why `C1` was re-opened, in one line:** it was closed on 2026-10-02 on a fact that stopped being true — delivery
inserted `recalled` and nothing else, so with `recall.tier1: 'off'` the arm's channel was empty by construction and
its model-visible input was `C0`'s. The reasoning and the two rounds' measurements behind it are in that arm's own
preset `_meta` and are not restated here; the full statement is `packages/core/src/types.ts`.

**What an operator must not conclude from this document.** `C0 → C1` being a real contrast does not make it the
paper's contrast. The paper varies the *position* of `T`; this round varies its *presence*. `stateProxyPosition` is
absent from every preset on purpose, so all three cells record the same `layout.order`, and the delivered text is
`[…, x, T, recalled, …]` in every cell that delivers at all. Anyone reading a result off these two arms as evidence
for or against Trace-as-State *ordering* is reading more than the design supports.

---

## Correction 2026-10-05 — one layout field was renamed and the second was **deleted**, and this document's live prose was corrected with them

Recorded per `docs/DOC-CONTRACT.md` §4. **The live prose above was edited in place rather than left standing**, for the
same reason the 2026-10-04 update gives: this is the document an operator reads *before* a round, and a field name the
build does not have is a wrong instruction rather than a historical fact. What each replaced sentence said is carried
here, verbatim, so the change is auditable. **The axis this correction first called `questionPlacement` was deleted
later the same day**; the note at the foot of this correction records that and quotes this section's field mapping as
superseded.

### What changed in the code

`AssemblyPolicy.xFirst: boolean` is gone from the tree: it was renamed to `questionPlacement: 'first' | 'last'` and
then **deleted** the same day (the field mapping this paragraph used to carry is quoted as superseded at the foot of
this correction). `AssemblyPolicy.stateProxyPosition: 'before-context' | 'after-context'` is now
`tracePlacement: 'trace-as-state' | 'trace-append'` (default `'trace-as-state'`), the **only** layout axis. A profile
that still spells an old key is read and reported (`LEGACY_LAYOUT_KEYS`, `packages/core/src/config.ts`); which
spellings are warned about and which are refused is the code's and is not restated here. Names, values and
defaults are owned by `packages/core/src/types.ts`, `packages/core/src/config.ts` and the presets and are not restated
here.

### Why

The paper (arXiv:2609.02702, §4.1) places the question **last in every condition** — "the question appears at the end
of the prompt … place it at the end of every input" — and its two arms are `[T, x, q]` (**TAS**, Trace as State) and
`[x, T, q]` (Trace Append), **order the only difference**. `xFirst` moved the *question*, the one element the paper
fixes, and its name presented that as the paper's variable; `stateProxyPosition` was already the paper's axis, so it
took the paper's name. **The question's own axis was then deleted rather than renamed**: `questionPlacement` left "the
question's position is a variable" expressible and its `'first'` value produced `[T, q, x]`, which is neither paper
arm, so `tracePlacement` alone is the axis and `q` is last by construction.

### The evidence, from round `20261004-0233`'s own `layoutOrder` records

`C1` and `C2` recorded `pinned, stateProxy, anchor, recalled, tail` — the question second, a layout that is neither
paper arm — because both set `xFirst: true`; `C0` (`xFirst: false`, TAS off) recorded `pinned, recalled, tail, anchor`,
the paper's baseline `M([x, q])`. So no cell reproduced either paper arm. The block order each `tracePlacement` value
produces is the table in `packages/core/src/assembler.ts`'s header.

### The sentences this replaces, verbatim

1. *"`AssemblyResult.cacheStability` defines the cache-stable head as `pinned + T` (plus `x` when `xFirst` is on) …"* —
   the head is `pinned + T` and nothing else: the question is last in every layout, so it is behind whatever cut a
   re-selection makes. *(Superseded the same day: the clause this replacement used — "the head gains the question when
   `questionPlacement` moves it there" — names a deleted field.)*
2. *"… and `policy.stateProxyPosition` — the enforced knob naming the two orders, and deliberately absent from every
   preset because a value in one would put a cell on one side of the paper's own control — is read into the recorded
   `layout.order`, **not into the delivered text**."* — the field is `policy.tracePlacement`; the rest of the sentence
   is unchanged and still true.
3. *"… an arm that differs from its pair in ordering alone, with `stateProxyPosition` flipped in one profile and
   nowhere else …"* — the field is `tracePlacement`.

### Two sentences in the 2026-10-04 update above are corrected by this note

- *"`AssemblyPolicy.stateProxyPosition` exists as the enforced knob naming the paper's two orders"* — the field is
  `AssemblyPolicy.tracePlacement`. "Enforced" remains accurate: `assemble()` branches on it, it is absent from
  `UNENFORCED_KNOBS`, and its value is recorded on every assembly.
- *"`stateProxyPosition` is absent from every preset on purpose, so all three cells record the same `layout.order`, and
  the delivered text is `[…, x, T, recalled, …]` in every cell that delivers at all."* — the field name is stale, and
  **"all three cells record the same `layout.order`" was wrong as written**: `C0`'s TAS is off, so its order carries no
  `stateProxy` block at all (round `20261004-0233`: `C0` recorded `pinned, recalled, tail, anchor` against `C1`/`C2`'s
  `pinned, stateProxy, anchor, recalled, tail`). What the sentence was reaching for survives and is the operator's
  rule: **no preset carries the placement axis, so no cell is defined by it**, and the delivered text
  still appends `T` ahead of the recalled turns in every cell that delivers. *(The "placement axis" is
  `tracePlacement` alone since the deletion recorded at the foot of this correction; the rule is unchanged.)*

**Correction, later the same day — the question axis was deleted, and this note's field mapping is superseded.**
Recorded per `docs/DOC-CONTRACT.md` §4, inside the correction above rather than in place of it, because the sentences
it supersedes are this note's own. The live prose it corrected stays as corrected; the superseded sentences are quoted
below with what replaced them.

- **What moved.** `AssemblyPolicy.questionPlacement: 'first' | 'last'` is **gone from the tree** — deleted, not
  renamed. **`AssemblyPolicy.tracePlacement: 'trace-as-state' | 'trace-append'` is the only layout axis**, and `q` is
  last by construction in every layout (the paper places the question "at the end of every input" in every condition,
  and its two arms `[T, x, q]` and `[x, T, q]` differ in nothing else; `'first'` produced `[T, q, x]`, which is
  neither). An old profile's spellings are read and reported by `LEGACY_LAYOUT_KEYS`
  (`packages/core/src/config.ts`): question-last ones as a warning, question-first ones as an error that quotes the
  sentence that retired the layout. So the mapping in **What changed in the code** above is superseded — there is no
  surviving `questionPlacement` for `true`/`'first'` to be translated into.
- *"the head gains the question when `questionPlacement` moves it there"* (replaced in **The sentences this
  replaces**) — nothing moves it, so the head is `pinned + T` and no re-selection can put `q` in front of the cut.
- *"no preset carries either layout field"* (in the note above) — there is one layout field now; the operator's rule
  it states is unchanged: **no preset carries `tracePlacement`, so no cell is defined by the arm**, and a round that
  wants the control writes it in one profile.

**The evidence, from round `20261004-0233`'s own `layoutOrder` records**, is the block above and still reads the same
way; what changed is only which orders a setting can produce now: `C0` `["pinned","recalled","tail","anchor"]` and
`C1`/`C2` `["pinned","stateProxy","anchor","recalled","tail"]` were the round's records, not a recipe.

### Outstanding, and not part of this correction

The arm table and the 2026-10-04 update's registration sentences now reflect the 2026-10-04 change (`C1` is the TAS
arm and delivers `T`; the registered contrasts are `C0 → C1` and `C1 → C2`). What this correction does **not**
touch is anything that states the pre-2026-10-04 registration; none was found above, and the one stale neighbour it
does report is `bench/cells/C0.json`–`C2.json`'s `_meta.note` text, corrected in place on the same day for the rename
and carrying its own record of what it replaced. **That text was corrected again for the deletion**, by the lane that
owns the presets; nothing in `bench/` is edited from this document, and this document's own statements about the
presets are the two rules above rather than a copy of what their notes say.

---

## Correction 2026-10-05 (second) — the recall defaults are `w = 16`, `d = 16`, and this document's own pointers named neither

Recorded per `docs/DOC-CONTRACT.md` §4, at the foot of the two corrections above and in place of neither. Two live
sentences were corrected in place — the pointer paragraph at the head of this document and the sentence under the
arm table that says what each arm is set to — and the wording as it stood is quoted verbatim below. The reasoning,
the cost table and the measurement are `docs/FORMULAS.md`'s 2026-10-05 correction (eighth), which this note points at
rather than repeats.

**What moved.** `defaultPolicy().recall.window` is **16** (was 1024) and `defaultPolicy().recall.depth` is **16**
(was 2); the validator bounds moved with them (`recall.window` `min 64` → **4**, `recall.depth` 1..6 → 1..**16**,
`packages/core/src/config.ts`). **What a round should read from this document about its own configuration is
unchanged**: the presets (`bench/cells/*.json`) and `cellPolicy()` own the values, and the run's own `kind:"wiring"`
tape record is what it actually ran — which is why the presets' `_meta` now record the change in their own words
rather than this document restating it.

**What each cell carries, since it differs and that is the thing a reader of a preset needs:**

| cell | `depth` in the preset | `window` in the preset |
| --- | --- | --- |
| `C0` | `16`, explicit (it read `2`) | **absent — inherits 16 from `defaultPolicy()`** |
| `C1` | `16`, explicit (it read `2`) | **absent — inherits 16** |
| `C2` | `16`, explicit (it read `2`) | **absent — inherits 16** |

`cellPolicy()` (`packages/core/src/types.ts`) starts from `defaultPolicy()` and moves neither field, so a cell's
window is the default with nothing anywhere in the preset chain to override it. Rounds recorded at `w = 1024, d = 2`
(`20261004-0233`, `1211`, `1239` and earlier) remain readable, are not edited, and are read through their own wiring
records as they always were.

**The superseded wording, verbatim.**

1. The head-of-document pointer — *"the *S1-call-volume / pair-count* findings and the *stimulus-setting levers* (`recall.window`, `s1.questionsPerCall`) → … with the window's own algorithm and its pair-count result in `docs/FORMULAS.md` §"Recall window w" (the unrouted part of that block is still in `.s1cap-ablation/MOVED-OUT-DOCS-MATERIAL.md` §A)"* → the same pointer now says the window's algorithm, its pair-count result **and the values that ran** live there, that the pair is `defaultPolicy()`'s since 2026-10-05, and which of the two fields each preset carries.
2. The sentence under the arm table — *"What each arm is **set to** is not restated here: the presets (`bench/cells/*.json`) and `cellPolicy()` (`packages/core/src/types.ts`, which supplies the switches a preset deliberately leaves out and the fields fixed in every cell) own the values, and a run's own `kind:"wiring"` tape record is what a cell actually ran."* → the rule is kept exactly as it stood, with the current pair named beside it (`w = 16`, `d = 16`), the `depth`/`window` split stated, and the cost pointer added. The sentence was not a *wrong* rule — it was a rule with no value beside it, and the value is what a reader coming to the run book needs.

---

## Correction 2026-10-05 (third) — the recalled block moved behind the tail: inside `x`, so no arm moved

Recorded per `docs/DOC-CONTRACT.md` §4, at the foot of the two corrections above and in place of neither. The **Why**
paragraph of the first correction above is the sentence the report names; it states the paper's variable and its two
arms, it stands as written, and this note is what a reader of it now needs beside it. **Nothing in this file printed the
old block order**, so nothing here was corrected in place, and the round records this file quotes are that round's own
data and keep their wording.

**What moved.** The recalled block now sits **immediately before the anchor**, behind the tail — it used to be third of
five, with `tail` and `anchor` behind it. The block order each `tracePlacement` value produces is the table in
`packages/core/src/assembler.ts`'s header, and `AssemblyLayout.order` (`packages/core/src/types.ts`) is the statement of
record; neither is restated as a rule here.

**Why no arm moved with it.** The paper's variable is where the trace `T` sits relative to the long context `x` — the
two arms are `[T, x, q]` (Trace as State) and `[x, T, q]` (Trace Append), order the only difference — and the recalled
block is **part of that long context**: `AssemblyLayout.order` reads the layout as `anchor` = `q`, pinned prefix = not
context, and the blocks between them = the long context the trace is placed around
(`packages/dsh-plugin/src/context-delivery.ts`: "the long context here is the `recalled` block"). A block that moves
*inside* `x` leaves `T`'s side of it where it was: `T` is still ahead of every block of `x` under `'trace-as-state'`
and behind all of them under `'trace-append'`. **The registration this file owns is unchanged: the arms are still the
baseline, TAS, and TAS plus the System-1 lane, and no cell is defined by where a block sits inside `x`.**

**Why the block moved.** A prompt cache is a prefix cache: a change at any token breaks the match from that token to the
end of the prompt, so everything placed behind a block that changes every step is invalidated with it. The recalled
block is the block a re-selection moves; ending `x` with it means a re-selection costs the question and nothing else.
**Measured on round `20261004-1458` C2**: the whole-prompt invalidation span per delivered pair fell from **2,539 to
2,111 tokens** with this move, on top of the ordering change that had already cut it from **6,179 to 2,539**.

**What this correction leaves alone.** The arm table, the registration sentences and the delivery paragraph
(*"Delivery here places `T` before the recalled block **by construction**"*) are unaffected: the delivered text is the
insertion channel's and did not change with this move — what changed is the order the assembler records, and the cache
arithmetic that order feeds (`AssemblyResult.cacheStability`). The round records quoted above (round `20261004-0233`'s
own `layoutOrder` records) stay as that round's evidence, including the orders no setting produces any more.

