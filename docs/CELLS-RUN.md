# Running the three cells

The ablation the project is judged on, as an executable procedure. Written down because the run needs a session
with full access (a sandboxed agent cannot write `~/.dsh`, cannot start Laya, and — measured twice — cannot even
have the tested agent run a command), so it is performed by hand, and a procedure that lives only in a
conversation is a procedure that gets re-invented differently each time.

## The question this run answers

The **registered rule** — the pre-registered comparison of `docs/FORMULAS.md` §8 — needs the full configuration
(`C2`) to beat the baseline (`C0`) on one of completion / cost / time. The baseline arm of round `20261001-1300` —
the cell that round called `C1`, today's `C0` — measured an 86.7%
prompt-cache hit rate, and the owner asked whether S1CAP's context management is what lowers it. That round ran
four cells under labels that no longer exist; the mapping table is in "Cells" below, and every figure taken from
it in this document carries the round and the label it ran under.

Mechanically, the answer is not "yes, by construction". `AssemblyResult.cacheStability` defines the cache-stable
head as `pinned + T` (plus `x` when `xFirst` is on), and `cutAfterBlock` names the first block behind that cut: a
re-selection re-prefills everything after it. So recalled content sitting *behind* the cut changes nothing about
the stable head, while a re-selection happening *inside* a task pays for the whole tail. The knob that decides
between those is `cache.reselectPolicy` — `perTask` freezes the selection inside a task (cache-aligned, the
default), `perTurn` does not.

Which means the suspect is identifiable from the comparison rather than from the absolute number: three turns are
three tasks, so three re-selections are *expected* and 86.7% may be unremarkable. The baseline is `C0` — the one
cell that delivers nothing, so what it measures is the harness managing history by itself — and the finding is a
difference between the measured token quantities of `C0`, `C1` and `C2` (see "Measurements, and where each comes
from"). The hit rate rides along as a mechanism diagnostic rather than as the finding: it is a ratio, and a cell
can win on it while moving more tokens on all three quantities, which is what the full configuration did in round
`20261001-1300` (the arm that round called `C4`, today's `C2`). An absolute number proves nothing here.

## Cells

Presets live in `bench/cells/`; `cellPolicy(cell)` in `packages/core/src/types.ts` derives C0–C2 from toggles,
with `termination: model-owned` and `rgMaintenance.mode: async` fixed in every cell.

| Cell | `tas.on` / `xFirst` | `recall.tier1` | `planGate.on` | System-1 lane | Role |
| --- | --- | --- | --- | --- | --- |
| C0 | off / off | off | off | `provider: none`, no lane | baseline: the harness manages history natively, and nothing is delivered |
| C1 | on / on | off | off | `provider: none`, no lane | the TAS half alone |
| C2 | on / on | embed | on | live provider, `retryAttempts: 2` | the project's own configuration |

Two switches, not one: `tas.on` is whether the state proxy T exists at all, `xFirst` is whether the current task x
sits before or after the recalled block, and `cellPolicy()` moves them together here (both off for C0, both on for
C1/C2) — which is why one column carries both. `deliver` follows the role rather than getting a column of its own:
the baseline delivers nothing — its assembled layout is recorded, not injected — while C1 and C2 deliver it,
because "TAS alone" and "the full configuration" are statements about what the model is shown.

**The two control arms carry no System-1 lane.** C0 and C1 pin `s1.provider: "none"` and carry no
`retryAttempts`; C2 keeps its provider with `retryAttempts: 2`. The pin is not cosmetic: `recall.tier1: 'off'`
disables the recall *selection* and leaves association-graph upkeep running, so a control arm that keeps a
provider still scores pairs and still reports System-1 calls — 363 and 257 of them in round `20261001-1300`, in
the arms that round called `C1` and `C2`. A no-System-1 control has to have the lane *absent*, so that its
System-1 calls, tokens and time are zero by construction rather than by failure. A live profile must pair
`s1.provider: "none"` with `laya.enabled: false`: `laya.enabled: true` beside `provider: none` is a reported
conflict (`singleBackendIssues`, `packages/s1-client/src/resolve.ts`), and a conflict drops the session to
`provider=none` (see "Setup").

### The names changed after round `20261001-1300` ran

Round `20261001-1300` ran **four** cells under the old labels. Every figure in this document that comes from that
round is labelled with the round and with the name the cell ran under, and none is silently re-labelled:

| round `20261001-1300` label | what that cell ran | today |
| --- | --- | --- |
| `C1` | baseline: nothing delivered, the harness manages history natively | **`C0`** |
| `C2` | TAS alone: state proxy and x-first ordering, no System-1 selection | **`C1`** |
| `C3` | recall selection with `tas.on: false` | **dropped, no successor** |
| `C4` | the full configuration: TAS ordering + System-1 selection + plan gate | **`C2`** |

**Old `C3` has no successor, so a reader looking for "the recall-only cell" will not find one.** It was recall
selection with `tas.on: false`, and per step it was worse than the baseline on the quantities of round
`20261001-1300`: **3 625** uncached input tokens against 2 595, **2 574** output tokens against 1 523, and a hit
rate of **79.2%** against 86.7%; its backend coverage was **22.5%**, below the 0.5 floor, so the cell was not a
measurement of System-1 governance however it is labelled. It pays more per step on two of the three quantities
and reuses less of what it sends (13 777 cached input tokens per step against 16 936), and it delivers no benefit
the three-armed design needs. Its absolute totals are *lower* than the baseline's — 219 737 tokens against
400 034 — and that difference is not evidence either way: it ran 11 steps against the baseline's 19, so absolute
totals are not comparable across these cells, which is exactly why every quantity here is reported per step and
per turn. `validatePolicy` now emits a warning when `recall.tier1 !== 'off'` is configured with `tas.on: false`,
naming the hit-rate and per-step pairs above, so the pairing has to be chosen on purpose rather than by accident.
The full 2×2 crossing — three arms run today, the dropped arm included — stays the goal once the `C1`-vs-`C2`
contrast is established.

## Run set: three cells, and what a round of the current phase measures

**A round runs three cells: C0, C1 and C2.** The names are the code's — `cellPolicy()`, the presets in
`bench/cells/`, the settings panel, the `cell` field on every telemetry record and this document all bind to
C0–C2 — and the old C3 is not run again (see above).

**The design contrast — the comparison that decides whether the System-1 half earns its place — is TAS alone
against the full configuration: `C1` against `C2`.** In
round `20261001-1300` the TAS-alone arm (then `C2`) moved **14 441** tokens per step — 187 739 over 13 steps
against the baseline's (then `C1`) 400 034 over 19, i.e. **21 054** per step — about 0.69×. It sits below the
baseline on all three quantities (1 783 / 11 166 / 1 493 per step against 2 595 / 16 936 / 1 523, with the output
margin the thinnest of the three), and its uncached input per step, 1 783 against 2 595, is also about 0.69×. So
if `C2` cannot beat `C1` then the System-1 half has not earned its place in the configuration, and nothing about
that argument needs a fourth arm.

**What a round measures now: one long-horizon task, drawn at random.** Short-turn token accounting was retired as a
measurement on 2026-10-01 — the three decisions, the evidence behind them and the loop that replaces the short-task
round are recorded in `docs/STATUS.md` §8 and are not repeated here. What this document still owns is the
**procedure**, and the draw does not change any of it: the cells and their presets, the prerequisites below, the
pasting rules, the report generator and the metric specification all stay as written. What changes is the stimulus a
measurement round runs — one task drawn from the pools `docs/AGENT_BRIEF.md` §9.2 names, run under all three cells
before the next draw, instead of the three-turn fixture (see "Messages").

**Repeats are still what a claim needs.** One run per cell cannot separate an effect from noise, and round
`20261001-1300` shows how much noise there is: the full-configuration arm's per-turn hit rates were 90.3 / 83.5 /
94.3% — a ±10 pp spread *within one cell*, across three turns, with no stable ordering — and the four arms' overall
rates were not monotone in how much S1CAP each of them ran. So run C0, C1 and C2 several times each and report the
repeats as a distribution per cell (min / median / max, and the count), not as one mean over runs that disagreed.
Each repeat keeps its own workspace and its own telemetry paths, exactly as the cells do now. The current phase
spends its budget on single draws for **optimization** instead; the grid is what a **claim** waits for, and one draw
supports optimization and not a claim.

## Setup

One profile per cell in the run set — `C0test`, `C1test`, `C2test` — each a copy of the working `s1captest`
profile with three changes:

- `cell: C0` … `cell: C2`;
- **separate telemetry paths per cell** — `telemetry.controlJsonl`, `sessionJsonl` and `tapeJsonl` must not
  collide across cells (the plugin rejects identical session and control paths, and a shared file would make the
  per-cell numbers meaningless); a repeat of a cell needs its own paths as well as its own workspace;
- **a pinned `s1.baseUrl`** for the already-running local endpoint. This is not cosmetic. With Laya selected and
  neither a `baseUrl` nor a `laya.pythonPath`, `singleBackendIssues` reports a conflict, and a conflict drops the
  session to `provider=none` — the cell then makes **no System-1 calls at all** while the panel merely says the
  server is "stopped". Measured 2026-10-01: four freshly built cells came up with S1 entirely off, and `/s1cap-7340`
  showed `s1.provider: "none"` beside `configuredProvider: "laya-serve"`, until `baseUrl` was pinned. Pinning it
  changes nothing else: it is the address `laya.host`/`laya.port` derives anyway.

### Prerequisites, because a round without them repeats measured failures

- **Launch the cells with `DSH_PERMISSION_MODE=danger-full-access`.** Under the default `workspace-write` the
  Windows ACL sandbox cannot spawn a process for these instances, and the tested agent then hangs on an approval
  nobody answers. The measured detail is in the next subsection.
- **Set `s1.retryAttempts: 2` on the arm that has a lane (`C2`).** Laya refuses rather than queues at its
  admission limit; a measured round lost **732 of 2 016** System-1 calls to `503 server busy`, and a refused call
  falls back to the local lexical scorer. The two control arms carry no `retryAttempts`, because there is no lane
  for them to retry.
- **The two control arms carry `provider: "none"` *and* `laya.enabled: false`.** The pair is required:
  `laya.enabled: true` beside `provider: none` is a reported conflict, so the arms are only clean when both are
  set. With both, their System-1 calls, tokens and time are zero *by construction* rather than by failure — the
  distinction the report prints as `0 (no S1 lane)` with an *undefined* coverage, which must not be read as a
  refused lane's `ok / refused / total` split and measured coverage (see "Measurements").
- **The model is `deepseek-v4.1-flash`, with `reasoningEffort` pinned**, set through `agent-default-model` in the
  copied profile. **No sampling parameters are claimed:** DSH exposes none, so temperature and the like are not
  part of this run's setup and must not appear in a report of it.

Ports: **19491, 19492, 19493** (one per instance; a repeat uses the same port as its cell, since the instances do
not overlap in time). Each instance is a managed background job, never `Start-Process`; the UI token comes from
the job's own stdout.

The shared backend is started **by hand, once**, and the profile keeps `laya.autoStart: false` so the plugin
launches nothing and no session ever needs `/s1-laya start` — a slash command sent into a cell is an extra turn in
the thing being measured. Point its checkpoint cache at one shared directory (`HF_HOME`) so the cells do not each
download the weights. **Confirm the device before the run, not after:** `GET /health` answers `device` and
`checkpoint_devices`, and `cpu_fallbacks` should be zero. A CPU backend under concurrent cells is what turned
a previous round into 191 failed S1 calls out of 281.

### What this machine forces (measured 2026-10-01)

- **Launch the cells with `DSH_PERMISSION_MODE=danger-full-access`.** Under the default `workspace-write`, the
  Windows ACL sandbox cannot spawn a process for these instances at all: `pwsh` fails with `sandbox-local
  windows-acl temp grant materialization failed and its cleanup also failed`, `glob` fails with `ripgrep launch
  failed`, while `write` and `read` still work. The tested agent then asks to escalate, and with
  `approval: ask` and nobody watching — the cells are driven by an agent, not by a person — the turn hangs
  forever. Three of the four cells of the first round died exactly there, and the fourth only finished because a
  human clicked "allow once". The mode is read from `DSH_PERMISSION_MODE` by the `sandbox-policy` plugin, and
  `danger-full-access` is the preset whose approval policy is `never`.
  `dsh-sandbox-windows-acl`'s own diagnosis script classifies the workspace ACLs as **NOT_THIS_CLASS**
  (`writeDac` and `writeOwner` both available, no package ACEs, `fixed: 0`), so this is not a repairable ACL
  fault and repairing it is not the fix.
- **Overwriting an existing file failed** (`SetFileSecurityW EACCES` on the sibling temp directory the editor
  creates), in every sandbox mode. What that measurement did not separate, and round `20261001-1414`'s pre-flight
  did, is the launch parent: an instance launched from a **sandboxed parent shell** inherits the restricted token
  into everything it spawns and fails this overwrite, while the same checks pass from an unrestricted launch. A
  stimulus that only ever creates *new* files never sees it; one that asks for an existing file to be corrected
  does, and the cell stops and asks a human instead of finishing.
- **The smoke-test stimulus writes nothing at all**, which is the choice the three-turn fixture settled on. Files
  make the round depend on the sandbox rather than on S1CAP: permissions, temp directories and security descriptors
  all become confounders, and the cell that hit them needed two human interventions to finish. A conversation-only
  stimulus removes the round directories too, since nothing is written that a later round could read. **A drawn
  long-horizon task is the other case**: a benchmark instance is a repository in a workspace, so that round writes by
  design and the launch environment above is what decides whether writing works.
- **Pick the cell model deliberately.** `bailian/qwen3.8-flash` over-thinks, which changes what a cell spends its
  steps on; the owner's choice for the next round is `deepseek-v4.1-flash`, with `reasoningEffort` pinned, set
  through `agent-default-model` in the copied profile. No sampling parameter is claimed for the run: DSH exposes
  none.
- **Set `s1.retryAttempts` (2 is enough) on the arm that has a lane.** The shared backend refuses rather than
  queues at its admission limit, and a measured round lost 732 of its 2 016 calls to `503 server busy` — after
  which the S1 columns are partly lexical ones, because a refused call falls back to the local scorer. With the
  retry on, a refused call waits the server's own `Retry-After` and is answered, and `attempts`/`waitedMs` on the
  `s1_call` record say how often that happened. The two control arms carry no `retryAttempts`: they have no lane,
  so there is nothing to retry. Report `judgedPairs / scoredPairs` either way.
- `~/.dsh/profiles/node_modules` is a farm of unresolvable junctions: a recursive `grep` there fails with
  thousands of `os error 3`s. Read the profile patch files directly.

**Round directories and salts are not used by these stimuli.** Nothing is written, so there is no directory to open
and no `{salt}` placeholder to substitute. What isolates the cells instead is their **workspace**: each cell runs
with its own empty working directory (`<run>/ws/<cell>`), so there is nothing in a cell's working directory for a
later cell to inherit and no path for two cells to collide over. `node scripts/new-test-run.mjs --create` still
opens a round directory and still substitutes `{salt}` where a stimulus contains it, so the mechanism stays
available for a stimulus that does write; with the current fixture it prints the messages with nothing substituted.

**A drawn task isolates the same way, with a copy per cell.** The rule is unchanged — no two cells may share a
workspace — and the mechanism is not: a benchmark instance is a repository, so each cell needs its own copy of it
under `<run>/ws/<cell>` instead of the empty directory above. How the instance is materialized belongs in the
round's own record (SWE-bench Verified and Terminal-Bench 4.0 run theirs in docker containers, τ²-bench is pure
Python and needs neither — `docs/AGENT_BRIEF.md` §9.2), and the copy has to be per cell: one two cells shared would
let one cell's edits become the next cell's starting state.

## Messages — the three-turn stimulus, kept as the harness smoke test

**These three turns are the harness's smoke test, not the measurement.** A measurement round draws one long-horizon
task at random and runs that (`docs/STATUS.md` §8); this fixture is what a round runs when the question is whether
the environment works at all — pre-flight, the three gates, the paste discipline and the report path — and it is the
stimulus that proved it end to end in round `20261001-1414`, which is both the first clean three-cell run and the
last short-task round.

The three-turn LeetCode stimuli live in `scripts/round-tasks.json` (ASCII-escaped, because no repository file may
contain Chinese), and they ask for the answer **in the conversation**: the stimulus forbids creating, modifying or
deleting any file, and forbids making a directory. The reason is measured rather than stylistic. A round that
writes makes the measurement depend on the file sandbox rather than on S1CAP, and the overwrite failure
(`SetFileSecurityW EACCES`) cost the full-configuration cell **two human interventions** in round `20261001-1300`;
a round's own directory was also a way for a later round to read an earlier round's answer. The turns offer the
harness runtime's own Python for verification instead, fed through stdin (`@'...'@ | python -`) so that nothing
needs to land on disk — it is the interpreter the runtime already ships, not an escalation.

Three things are pinned so that an answer stays objectively checkable afterwards. The self-test data: three fixed
price arrays, given in the first turn (`[7,1,5,3,6,4]`, `[1,2,3,4,5]`, `[7,6,4,3,1]`) and carried over by the later
ones, plus `random.seed(0)` if the code uses randomness. The answer's length: code ≤ 40 lines and rationale ≤ 6
bullets — because output tokens were 55–80% of what a price-weighted total would have charged in every cell of the
last round, and an uncapped answer measures how much the model chose to say rather than how well it manages
context. And the no-question rule, stated in the stimulus as well as enforced structurally by the run: a cell is
driven by an agent, so a question is a turn spent waiting for an answer nobody sends.

Turns 2 and 3 carry the owner's revision in its no-file form: each **keeps the earlier answers untouched and adds a
new section** for the new problem — 121 → 122 → 123 (one transaction → any number of transactions → at most two),
which is what makes the round a test of accumulation rather than of replacement. The fixture is still the only copy
of the stimulus: the messages are read from it and sent as recorded, never retyped at the keyboard, because a
stimulus that is retyped is a stimulus that has changed.

**A drawn long-horizon task keeps the discipline without the fixture.** It does not come from
`scripts/round-tasks.json`; it comes from its pool, and the round runs the instance as the pool ships it, records its
id and its pool beside the evidence, and does not restate the task in its own words. A benchmark instance is also a
workspace with a repository in it — the case this fixture was written to avoid — so a drawn round writes files by
design and the launch prerequisites in "Setup" above stop being precautionary.

## Back-pressure

The cells share one local Laya on `127.0.0.1:8008`. A measured round with whole-window scoring produced 281
`s1_call` records of which **191 failed** — 97 `TypeError: fetch failed`, 57 `S1TimeoutError` after 30 s, and 37
`503 server busy` returned by Laya itself — ending with **zero** `s1-noul` edges in the graph. The next round's run
set removes two of the three consumers outright: C0 and C1 pin `provider: "none"`, so their System-1 calls, tokens
and time are zero by construction. That does not remove the pressure, it concentrates it: `C2` alone has a lane, and
it is the arm that made an order of magnitude more calls than today's two control arms made in round
`20261001-1300` (1 155 against 363 and 257) and the arm whose coverage decides whether the System-1 half earned its
place. `tier1: off` is not an S1-off switch — upkeep association scoring is not gated on it — while
`provider: none` is. Either stagger the cells into waves or report the 503s, because they change what the numbers
mean: a cell that received no System-1 judgements is not a cell that measured S1 governance.

### The S1 call volume is the pair count, not repeated work (measured 2026-10-01)

The upkeep lane asks one question per **new** pair — the arriving segment against each segment in its window — and
the volume that produces is `new pairs / s1.questionsPerCall`, which is quadratic in segments whenever `w` is
larger than the session. It is worth writing down because the suspicion that a new segment re-scores the whole
window, and therefore re-pays for pairs already judged, is natural and false, and because the full-configuration
arm's "35 System-1 calls per step" of round `20261001-1300` (round label `C4`, today's `C2`: 1 155 calls over 33
steps) reads as waste until the pair count is beside it.

| cell (round `20261001-1300` label) | segments T | pairs offered = T(T−1)/2 | distinct pairs recorded | `s1_call` | ok / 503 / timeout |
| --- | --- | --- | --- | --- | --- |
| C1 → today's C0 | 116 | 6 670 | 6 670 | 363 | 134 / 202 / 27 |
| C2 → today's C1 | 93 | 4 278 | 4 278 | 257 | 128 / 103 / 26 |
| C3 → dropped | 82 | 3 321 | 3 321 | 241 | 89 / 145 / 7 |
| C4 → today's C2 | 214 | 22 791 | 22 791 | 1 155 | 807 / 282 / 66 |

Source: each cell's own `<DSH_HOME>/.s1cap/rg/*.json` (`order`, `scoredPairs`, `scores[]`) and its control JSONL.
Rows carry the round's label with today's name after the arrow. The two middle columns are the test. A pair offered
twice costs nothing extra in `scoredPairs`, but `scores` is keyed by `${from}->${to}`, so a re-offer would leave
the offered count one larger than the number of distinct pairs; in all four arms of that round the difference is
**zero**, and the offered count equals `T(T-1)/2` exactly, which is the full-history row of `docs/FORMULAS.md`
§"Recall window w" — `w = 1024` never bound against a 214-segment session. `scoredPairs` is cumulative per session
and is read from the last assembly record, not summed over records.

The call count is that pair count over the cap (22 791 / 20 ≈ 1 140 full batches for the full-configuration arm,
round label `C4`, today's `C2`), and the measured count brackets it: refusals *shorten* it, because a window whose
call failed abandons its remaining candidates and is scored lexically in full, while the halving retry *lengthens*
it by asking the rest of that window in smaller batches. Pinned by `packages/core/test/pair-cost.test.ts` and, on
the scorer's own request stream, by `packages/dsh-plugin/test/s1-relevance.test.ts`. The lever is `recall.window`
or `s1.questionsPerCall`; there is no duplicate work to remove.

#### The lever, quantified: `recall.window`

Pairs for a session of `T` segments at window `w` are `Σ_{j<T} min(w, j)` — the first `w` arrivals are short
because there is less history than the window — which is `T(T-1)/2` while `T-1 ≤ w` and
`w(w-1)/2 + (T-1-w)·w` after that. Quoting the same four sessions at four windows, with the calls each implies in
full batches at `s1.questionsPerCall = 20` (`Σ_j ceil(min(w,j)/20)`; the measured count is at or below it when a
refused window is abandoned):

| cell (round `20261001-1300` label) | T | `w = 64` (the config floor) | `w = 128` | `w = 256` | `w = 1024` (what ran) |
| --- | --- | --- | --- | --- | --- |
| C1 → today's C0 | 116 | 5 344 pairs / 340 calls | 6 670 / 390 | 6 670 / 390 | 6 670 / 390 |
| C2 → today's C1 | 93 | 3 872 / 248 | 4 278 / 260 | 4 278 / 260 | 4 278 / 260 |
| C3 → dropped | 82 | 3 168 / 204 | 3 321 / 205 | 3 321 / 205 | 3 321 / 205 |
| C4 → today's C2 | 214 | 11 616 / 732 | 19 136 / 1 071 | 22 791 / 1 243 | 22 791 / 1 243 |

The three-turn sessions of the last round are short enough that only `w ≤ 64` changes anything for the three
lighter arms, and the full-configuration arm roughly halves at the floor. A longer session is where the window
bites: at `T = 1024` and `w = 64` the pairs are 63 456 against 523 776 unbounded, and at `T = 4096` they are
260 064 against 8 386 560 — the Θ(T·w) row of `docs/FORMULAS.md` §"Recall window w". The floor of 64 in
`NUMBER_RULES` is what makes `w = 64` the smallest setting available; a shorter window than that is not a config
this repository supports, and lowering the floor is a separate decision whose cost is the edge density described
next, which nothing in round `20261001-1300` measured.

**What `w` touches, and what it does not.** `w` is the **System-1 scoring window only**: a new segment is scored
against at most the most recent `w` segments, and that is its sole purpose — bounding the association cost at
`O(w)` per new segment and `O(turns × w)` per session instead of the quadratic pair count. The code says so in
three places: `packages/core/src/types.ts` ("S1 scoring window w (`recall.window`)"),
`packages/core/src/assoc-graph.ts` ("one pass of `w` comparisons per new segment", "the pair count
`recall.window` is meant to bound"), and `packages/core/src/observer.ts` ("Segments outside the window keep their
edges and stay reachable"). **Recall is never bounded by `w`.** The BFS is bounded by `recall.depth = d` and
`recall.threshold = r`; segments outside the window keep every edge they already have and are still traversed and
recalled. What a smaller `w` actually costs is the **density of edges between new and old segments**: fewer pairs
are offered, so the graph the BFS walks becomes sparser, and recall may reach fewer relevant segments *through those
edges*. That is a real cost, it is not measured by anything in round `20261001-1300` — whose `w = 1024` never bound
at all — and a run that lowers `w` must carry `fallback`, `unknownAdmitted` and `recallTree` beside it, or the loss
stays invisible.

#### The lever, quantified: `s1.questionsPerCall`, and the guard it must be argued against

The cap is bounded 1–64, and raising it cuts calls the other way: at the full-configuration arm's measured
`w = 1024`, `T = 214` (round label `C4`, today's `C2`), the full batches are 1 243 at 20, 819 at 32, 678 at 40 and
468 at 64. What stops that from being free is the transport guard, and the records bound it. Every successful
`noul` call in the round (1 141 of them) carried **235–363 input
tokens per question**, flat from 1 question (363) to 20 (361) — the two rendered segments per question, each
capped at 256 characters by `MAX_SEGMENT_CHARS`, so a call of `q` questions is about `323·q` input tokens
(6.5k at 20, 12.8k at 40, 20.5k at 64) in the backend's own tokenizer. Latency does **not** fall with batch size in
this data and does not rise much either: median per call is 9.2 s at 1 question and 21.3 s at 20, overall median
20 068 ms, p95 27 652 ms, and the maximum is 29 994 ms — 6 ms under `S1_TRANSPORT_TIMEOUT_MS = 30 000`. The round
lost 126 of 2 016 calls to that guard and 732 to `503 server busy`, at every batch size. So the honest reading is
not "bigger batches are cheaper on tokens and safe on time": it is that the backend was saturated, that the tail of
every batch size sits against the guard, and that a larger cap has to be argued from a *load* measurement
(`LAYA_MAX_CONCURRENT`, cells staggered in two waves) rather than from these latency numbers. What the records do
establish is the token side: `~323` input tokens per question, measured, not estimated.

One thing the records do **not** establish, and it should not be guessed at: how much edge density a smaller `w`
costs. The window never removes segments from recall (see "The lever, quantified: `recall.window`"); what it removes
is pairs, and therefore edges, that the BFS would otherwise have had to walk. `scoredPairs` and `judgedPairs` say
how much was judged, and nothing in this round measured how often the pairs a smaller window would have dropped were
the pairs recall went on to use. A run that lowers `w` has to carry `fallback`, `unknownAdmitted` and `recallTree`
read beside it, or it is trading a measurable cost for an unmeasured loss.

## Measurements, and where each comes from

**The primary measurement is a triple of raw token counts, not a rate and not a scalar.** For every cell, per turn
and per step, a report states the triple `(n_miss, n_hit, n_out)` — uncached input tokens, cached input tokens,
output tokens — as counts. **No scalar is formed from the three.** The three types carry three different prices,
and those prices differ per model and per provider, so any weighted total is a property of a price list rather than
of the system under test: the same columns would rank differently against another provider's rates, and the
ranking would say nothing about S1CAP. A cell that wins on one component and loses on another is a normal outcome,
not a tie to be broken by weights; the table is read component by component. What a rate cannot do is stand in for
the counts — round `20261001-1300` is the demonstration, because the cell with the best hit rate (the full
configuration, round label `C4`, today's `C2`, 92.6%) carried the **largest** count on all three components, while
the cell with a slightly *worse* hit rate than the baseline (TAS alone, round label `C2`, today's `C1`, 86.2%)
carried the smallest. So report, per cell and **per turn and per step**:

| quantity | source |
| --- | --- |
| uncached input tokens | `data.usage.inputTokens` on `assistant/message` events — on this usage shape it counts the prompt tokens that *missed* the cache, not all prompt tokens |
| cached input tokens | `data.usage.cacheReadTokens` |
| output tokens | `data.usage.outputTokens` |
| steps, turns (the denominators) | `step/start` and `turn/start` counts in the harness session store, with the assembly-record count beside them as a cross-check |

The shape was verified on every session of the last round: `totalTokens = inputTokens + cacheReadTokens +
cacheWriteTokens + outputTokens`, and `cacheWriteTokens` was 0 in all four arms of that round — which is what
licenses reading `inputTokens` as the miss side. Per-turn numbers come free with the same events (`data.turn`), and
they matter: the full-configuration arm's hit rate moved 90.3 / 83.5 / 94.3% across three turns, a ±10 pp spread
with no stable ordering, so a per-run average is a summary of three different regimes rather than a property of the
cell.

That table, filled in from round `20261001-1300`, is what a report of this shape looks like:

| cell (round `20261001-1300` label) | steps | turns | uncached in | cached in | output | per step (uncached / cached / output) | per turn |
| --- | --- | --- | --- | --- | --- | --- | --- |
| C1 → today's C0 | 19 | 3 | 49 306 | 321 792 | 28 936 | 2 595 / 16 936 / 1 523 | 16 435 / 107 264 / 9 645 |
| C2 → today's C1 | 13 | 3 | 23 177 | 145 152 | 19 410 | 1 783 / 11 166 / 1 493 | 7 726 / 48 384 / 6 470 |
| C3 → dropped | 11 | 3 | 39 871 | 151 552 | 28 314 | 3 625 / 13 777 / 2 574 | 13 290 / 50 517 / 9 438 |
| C4 → today's C2 | 33 | 3 | 110 990 | 1 398 272 | 76 501 | 3 363 / 42 372 / 2 318 | 36 997 / 466 091 / 25 500 |

Read component by component, that table says what a single number would have hidden: the full configuration
(round `C4`) is above the baseline (round `C1`) on all three counts (2.25× the uncached input, 4.35× the cached
input, 2.64× the output) and TAS alone (round `C2`) is below it on all three (0.47× / 0.45× / 0.67×). Those are
three separate results and not one weighted result: the ordering happens to agree here, and it need not in another
round — a cell that wins on one component and loses on another is a normal outcome, not a tie to be broken by
weights.

### The report generator, and the metric specification it implements

`scripts/cell-report.mjs` is committed and validated against round `20261001-1300`. It reads the run's own
evidence — `evidence/<cell>/control.jsonl` for the System-1 lane, `home/<cell>/sessions/**/session.v4.jsonl.zstd`
for turns, steps, per-step usage and tool durations, and `home/<cell>/.s1cap/rg/*.json` for
`judgedPairs / scoredPairs` — and prints, **per cell, per turn and per step**:

| group | quantities |
| --- | --- |
| time | turns, steps, LLM calls, System-1 calls, other tool calls; LLM time, System-1 time, other tool time — with the frames they sit in printed beside them (`step frame` = `step/end − step/start`, `turn frame` = `turn/end − turn/start`, `between-step idle` = the difference), so that LLM + tool + residual = step frame can be checked rather than assumed |
| cost | cached-hit input tokens, uncached input tokens, output tokens, plus the System-1 lane's own tokens |
| completion | benchmark-only: turns completed and time to completion. The three-turn smoke-test stimulus completes in every cell, so for that fixture the report prints completion as one constant column and says so instead of printing a per-turn table of the same value |
| mechanism diagnostics (not cost) | System-1 coverage beside every System-1 column, and the cache hit rate — it appears **once**, here, never in the cost table |

Usage:

```
node scripts/cell-report.mjs --run <dir> --cells C0,C1,C2 --out <dir> --format all
```

A run recorded under the old labels is reported the same way — `--cells C1,C2,C4` reads the cells the evidence
actually holds, and `--label C1=baseline,C2=TAS,C4=full` gives the columns the display labels that round used.
**Those arguments are the historical round's labels — round `20261001-1300` only. The current scheme is `C0`,
`C1` and `C2`, so a run of the three cells in this document is read with the `--cells C0,C1,C2` line above.** The
correspondence between those labels and today's scheme is the mapping table above, not the `--label` argument:
that is exactly why the mapping has to be written down rather than remembered. The script also carries
`--self-test`, which builds a synthetic run under the OS temp directory and asserts the arithmetic, the counting
traps, the lane rules and that missing evidence is a hard error rather than a row of zeros.

Three facts the generator had to handle. Each one is written down here so that the next reader does not re-derive
it from a table that looks wrong:

1. **System-1 calls do not align to steps.** `s1_call` records carry a timestamp but no turn or step, so they are
   attributed by containment in a step window and then in a turn window — and the association-graph upkeep tick is
   not aligned to the step clock. In the baseline arm of round `20261001-1300` (round label `C1`, today's `C0`) only
   **179 of 363** calls fell inside a step window: 48 fell between steps of a turn, 108 between turns, and 28
   arrived after the last `turn/end`. A per-step-only table would have dropped the other **184** — just over half of
   that arm's calls — while its own sum row still read 363, so the unattributed remainder is printed as its own
   rows ("between steps", "between turns", "after last turn") and the rows above the Σ row still add up to the cell
   total. Calls, milliseconds and tokens are each checked to reconcile that way.
2. **System-1 time is concurrent, not additive.** It is the plugin's own reported `ms` per call, and association
   judging runs alongside the request: in the full-configuration arm (round label `C4`, today's `C2`), turn 3 sums
   to **10 633 810 ms** of lane time inside a turn frame of **1 306 265 ms**. It must never be added to LLM time; a
   report prints it as its own column, and the SVG keeps it in a panel of its own, apart from the wall-clock
   decomposition.
3. **A lane-absent zero is not a refused zero.** The lane state is read from the plugin's own `kind:"wiring"`
   record on the cell's tape (`<DSH_HOME>/.s1cap/tape.jsonl`), whose `s1` field is literally `"none"` for the Off
   choice and `{provider, mode, baseUrl}` otherwise, with the tape's `tuning-file` record and the `provider` on the
   `s1_call` records as fallbacks. A lane-absent cell prints `0 (no S1 lane)` and its coverage is **undefined**,
   not `0/N`: `judgedPairs` is 0 because the backend was never asked, while the local lexical fallback still built
   edges. A refused lane prints its `ok / refused / total` split and a measured coverage. The two must never print
   the same way — a zero by construction and a zero by failure are different claims about the cell.

**The System-1 lane carries its own usage, on its own line.** The claim "a cheap System-1 saves an expensive LLM"
has to include what the System-1 lane spent: sum the lane's own usage over the cell's `s1_call` records and report
it with the call count, beside the LLM's own triple rather than folded into it. Measured last round: 436 406 /
584 331 / 263 808 / 3 722 310 System-1 tokens for 363 / 257 / 241 / 1 155 calls (round labels `C1` / `C2` / `C3` /
`C4`, i.e. today's `C0` / `C1` / dropped / `C2`). In the full configuration (round `C4`, today's `C2`) that is
**3 722 310 tokens over 1 155 calls**, 807 of them answered, against the same cell's LLM usage of `1 398 272` hit
+ `110 990` miss + `76 501` output = **1 585 763 tokens** — the System-1 lane moved **~2.35×** the tokens of the
model it is meant to make cheaper. It is stated in tokens on purpose: the two lanes are not interchangeable, and
this comparison is not a bill. One is a local GPU resource, where the usage is what this line measures and the cost
is the machine; the other is a billed API, where the price depends on the model and the provider. Converting either
into currency would put a price list back in the middle of a quantity comparison. A cell whose S1 line is missing
cannot support the claim in either direction — and the two control arms' S1 line is *absent* by construction, so it
is printed as `0 (no S1 lane)`, not as spend.

**Coverage goes beside every System-1 column**: `judgedPairs / scoredPairs`, with the failure split (`503 server
busy` / transport timeout / other) next to it. `scoredPairs` is the pairs the window *offered*; `judgedPairs` is the
ones the backend actually answered; a pair the backend did not answer was scored by the local lexical fallback, so
a cell that looks S1-governed from its edge count may be reporting the fallback's work. **Floor: a cell counts as
S1-governed only when `judgedPairs / scoredPairs` is at least 0.5.** Below half, the majority of the graph is the
fallback's, and a comparison against the baseline is measuring something other than System-1. The last round
measured 16.9 / 33.4 / 22.5 / 39.2% (round labels `C1` / `C2` / `C3` / `C4`) — **none of the four arms clears the
floor**, which is the honest summary of that run and the reason the next one should carry `s1.retryAttempts` and
staggered cells. Report the number even when it fails; especially then. For a cell with no lane the report prints
coverage as **undefined**, not 0: the backend was never asked.

**The hit rate is a mechanism diagnostic, not the headline.** It answers "did the prefix stay stable across steps",
which is worth knowing and is not a cost: `h = cacheReadTokens / (cacheReadTokens + inputTokens)` — the derivation
is kept here on purpose, and the report prints it once, under "Mechanism diagnostics", beside the baseline's own
`h` and never instead of the three quantities. A cell can win on `h` and still move more tokens on all three
components, which is exactly what the full configuration did in round `20261001-1300`.

**Output length is not a free variable in the comparison.** The full-configuration arm emitted 76 501 output tokens
(round label `C4`, today's `C2`) against TAS alone's 19 410 (round label `C2`, today's `C1`) — 4× the volume — and
in every cell of round `20261001-1300` output was 55–80% of what a
price-weighted total would have charged. That second figure is a statement about the quantities rather than about
the prices: output dominates any weighting, so at that share a comparison measures how much the model chose to say
unless the stimulus constrains it. Either bound the answer in the stimulus (a stated length or format the turn must
respect) or report output tokens as their own row, `n_out` beside `n_hit` and `n_miss` — but do not read a
difference between cells off a component whose volumes differ by 4×.

Derivations for the non-token columns, as the generator implements them: LLM duration is derived from session-event
timestamps around each assistant message (`assistant/message.time` minus its `step/start.time`); tool count and
duration come from `tool/call` → `tool/result` pairs matched by `callId`; System-1 duration and failures come from
the `s1_call` records (`ms` summed, plus the ok/refused split and the distinct error strings).

**Correction, updated for the three-cell scheme: `tier1: 'off'` does not make a cell S1-free.** Upkeep graph
scoring is not gated on `recall.tier1`, so `tier1: 'off'` disables the recall *selection* and leaves the association
scoring running. With a live provider, such an arm still emits `s1_call` records — measured 363 and 257 calls in the
two arms of round `20261001-1300` that today are `C0` and `C1`. Only `provider: "none"` gives a genuinely zero-S1
cell, which is why the panel gained an **Off** choice and why both control presets pin it (with
`laya.enabled: false` beside it; see "Cells" and "Setup"). So: measure the S1 columns for every cell from the data,
never fill them with 0 by assumption, and read a lane-absent zero as a zero *by construction* rather than as a
refusal. A reader who takes a `tier1: 'off'` arm for a no-S1 baseline will misread the entire table.

Read JSONL with `node`, not PowerShell (which mangles UTF-8). Counts, timings and paths belong in a report;
session content does not.

## Two features whose first live check is this run

- `recallTree` — the graph structure each step's recall produced, keyed by segment id only, in the control plane;
- `judgedPairs` against `scoredPairs`, and `fallback` per assembly.

If `recallTree` is absent from the control JSONL, the feature is unwired no matter what the tests say — that is
the failure mode this repository has hit most often, and the reason each of these was committed with a grep
proving it reaches the file.

**Measured 2026-10-01 (round `20261001-1300`):** `recallTree` is present on **every** assembly record of all four
arms of that round — 19/19, 13/13, 11/11, 33/33 — and non-empty exactly where `tier1` selects (7/11 in the
recall-only arm, round label `C3`, dropped; 13/33 in the full-configuration arm, round label `C4`, today's `C2`),
empty in the two arms where recall selection is off (round labels `C1`/`C2`, today's `C0`/`C1`). Both features are
wired. The same run also shows what these counters are for: 732 of its 2 016 System-1 calls came back `503 server
busy` and 126 hit the 30 s transport guard (the round report's denominator of 1 880 was read mid-run, before the
full-configuration arm had made its last 136 calls), so only 16.9 / 33.4 / 22.5 / 39.2% of association pairs were
judged by the backend and the rest fell back to the local lexical scorer — no cell clearing the 0.5 coverage floor.
A cell's `judgedPairs / scoredPairs` belongs in every report beside its S1 columns.
