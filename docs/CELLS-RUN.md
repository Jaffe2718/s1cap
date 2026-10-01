# Running the four cells

The ablation the project is judged on, as an executable procedure. Written down because the run needs a session
with full access (a sandboxed agent cannot write `~/.dsh`, cannot start Laya, and — measured twice — cannot even
have the tested agent run a command), so it is performed by hand, and a procedure that lives only in a
conversation is a procedure that gets re-invented differently each time.

## The question this run answers

The project's claim needs C4 to beat C1 on one of completion / cost / time. A three-turn LeetCode session
measured an 86% prompt-cache hit rate, and the owner asked whether S1CAP's context management is what lowers it.

Mechanically, the answer is not "yes, by construction". `AssemblyResult.cacheStability` defines the cache-stable
head as `pinned + T` (plus `x` when `xFirst` is on), and `cutAfterBlock` names the first block behind that cut: a
re-selection re-prefills everything after it. So recalled content sitting *behind* the cut changes nothing about
the stable head, while a re-selection happening *inside* a task pays for the whole tail. The knob that decides
between those is `cache.reselectPolicy` — `perTask` freezes the selection inside a task (cache-aligned, the
default), `perTurn` does not.

Which means the suspect is identifiable from the comparison rather than from the absolute number: three turns are
three tasks, so three re-selections are *expected* and 86% may be unremarkable. The baseline is C1 — the one cell
that delivers nothing, so what it measures is the harness managing history by itself — and the finding is a
difference between the measured token quantities of C1, C2 and C4 (see "Measurements, and where each comes from").
The hit rate rides along as a mechanism diagnostic rather than as the finding: it is a ratio, and a cell can win on
it while moving more tokens on all three quantities, which is what C4 did. An absolute number proves nothing here.

## Cells

Presets live in `bench/cells/`; `cellPolicy(cell)` in `packages/core/src/types.ts` derives C1–C4 from toggles,
with `termination: model-owned` and `rgMaintenance.mode: async` fixed in every cell.

| Cell | `tas.on` / `xFirst` | S1 governance | Role | Next run |
| --- | --- | --- | --- | --- |
| C1 | off / off | off | baseline: the harness manages history natively | yes |
| C2 | on / on | off | the TAS half alone | yes |
| C3 | off / off | on | the S1 half alone | **no** (see below) |
| C4 | on / on | on | the project's own configuration | yes |

Two switches, not one: `tas.on` is whether the state proxy T exists at all, `xFirst` is whether the current task x
sits before or after the recalled block, and `cellPolicy()` moves them together here (both off for C1/C3, both on for
C2/C4) — which is why one column carries both.

## Run set for the next round: three cells, and repeats

**The next round runs three cells: C1, C2 and C4.** The names are unchanged and no `C0` is introduced —
`cellPolicy()`, the presets in `bench/cells/`, the settings panel, the `cell` field on every telemetry record and
this document all bind to C1–C4, and a renamed or invented cell is one more place for the same fact to be wrong.

**C3 is not run this time.** C3 is recall selection with `tas.on: false`, and per step it is worse than the baseline
on the quantities of round `20261001-1300`: **3 625** uncached input tokens against 2 595, **2 574** output tokens
against 1 523, and a hit rate of **79.2%** against 86.7%; its backend coverage was **22.5%**, below the 0.5 floor,
so the cell was not a measurement of System-1 governance however it is labelled. It pays more per step on two of the
three quantities and reuses less of what it sends (13 777 cached input tokens per step against 16 936), and it
delivers no benefit the three-armed design needs. Its absolute totals are *lower* than the baseline's — 219 737
tokens against 400 034 — and that difference is not evidence either way: C3 ran 11 steps against C1's 19, so
absolute totals are not comparable across these cells, which is exactly why every quantity here is reported per
step and per turn. C3 is also not the contrast the project's claim rests on. That contrast is **TAS alone against
the full configuration**: per step C2 moved **14 441** tokens — 187 739 over 13 steps against the baseline's 400 034
over 19, i.e. **21 054** per step — about 0.69×. It sits below the baseline on all three quantities (1 783 / 11 166
/ 1 493 per step against 2 595 / 16 936 / 1 523, with the output margin the thinnest of the three), and its uncached
input per step, 1 783 against 2 595, is also about 0.69×. So if C4 cannot beat C2 then the System-1 half has not
earned its place in the configuration, and nothing about that argument needs a fourth arm. The combination is not
lost by dropping the cell either — `validatePolicy` now emits a warning when `recall.tier1 !== 'off'` is configured
with `tas.on: false`, naming the hit-rate and per-step pairs above, so the pairing has to be chosen on purpose
rather than by accident. The full four-cell ablation stays the goal once the C2-vs-C4 contrast is established.

**The budget that freed up goes to repeats.** One run per cell cannot separate an effect from noise, and the last
round shows how much noise there is: C4's per-turn hit rates were 90.3 / 83.5 / 94.3% — a ±10 pp spread *within
one cell*, across three turns, with no stable ordering — and the four cells' overall rates were not monotone in how
much S1CAP each of them ran. So run C1, C2 and C4 several times each and report the repeats as a distribution per
cell (min / median / max, and the count), not as one mean over runs that disagreed. Each repeat keeps its own salt
directory and its own telemetry paths, exactly as the cells do now.

## Setup

One profile per cell in the run set — `C1test`, `C2test`, `C4test` for the next round (see "Run set for the next
round" below), `C3test` only when the four-cell ablation is run again — each a copy of the working `s1captest`
profile with three changes:

- `cell: C1` … `cell: C4`;
- **separate telemetry paths per cell** — `telemetry.controlJsonl`, `sessionJsonl` and `tapeJsonl` must not
  collide across cells (the plugin rejects identical session and control paths, and a shared file would make the
  per-cell numbers meaningless); a repeat of a cell needs its own paths as well as its own salt;
- **a pinned `s1.baseUrl`** for the already-running local endpoint. This is not cosmetic. With Laya selected and
  neither a `baseUrl` nor a `laya.pythonPath`, `singleBackendIssues` reports a conflict, and a conflict drops the
  session to `provider=none` — the cell then makes **no System-1 calls at all** while the panel merely says the
  server is "stopped". Measured 2026-10-01: four freshly built cells came up with S1 entirely off, and `/s1cap-7340`
  showed `s1.provider: "none"` beside `configuredProvider: "laya-serve"`, until `baseUrl` was pinned. Pinning it
  changes nothing else: it is the address `laya.host`/`laya.port` derives anyway.

Ports: **19491, 19492, 19493, 19494** (one per instance; a repeat uses the same port as its cell, since the
instances do not overlap in time). Each instance is a managed background job, never `Start-Process`; the UI
token comes from the job's own stdout.

The shared backend is started **by hand, once**, and the profile keeps `laya.autoStart: false` so the plugin
launches nothing and no session ever needs `/s1-laya start` — a slash command sent into a cell is an extra turn in
the thing being measured. Point its checkpoint cache at one shared directory (`HF_HOME`) so four cells do not each
download the weights. **Confirm the device before the run, not after:** `GET /health` answers `device` and
`checkpoint_devices`, and `cpu_fallbacks` should be zero. A CPU backend under four concurrent cells is what turned
a previous round into 191 failed S1 calls out of 281.

### What this machine forces (measured 2026-10-01)

- **Launch the cells with `DSH_PERMISSION_MODE=danger-full-access`.** Under the default `workspace-write`, the
  Windows ACL sandbox cannot spawn a process for these instances at all: `pwsh` fails with `sandbox-local
  windows-acl temp grant materialization failed and its cleanup also failed`, `glob` fails with `ripgrep launch
  failed`, while `write` and `read` still work. The tested agent then asks to escalate, and with
  `approval: ask` and nobody watching — the four cells are driven by an agent, not by a person — the turn hangs
  forever. Three of the four cells of the first round died exactly there, and the fourth only finished because a
  human clicked "allow once". The mode is read from `DSH_PERMISSION_MODE` by the `sandbox-policy` plugin, and
  `danger-full-access` is the preset whose approval policy is `never`.
  `dsh-sandbox-windows-acl`'s own diagnosis script classifies the workspace ACLs as **NOT_THIS_CLASS**
  (`writeDac` and `writeOwner` both available, no package ACEs, `fixed: 0`), so this is not a repairable ACL
  fault and repairing it is not the fix.
- **Overwriting an existing file fails as well** (`SetFileSecurityW EACCES` on the sibling temp directory the
  editor creates), in every mode. A stimulus that only ever creates *new* files never sees it; one that asks for
  an existing file to be corrected does, and the cell stops and asks a human instead of finishing.
- Prefer a stimulus that **writes nothing at all**. Files make the round depend on the sandbox rather than on
  S1CAP: permissions, temp directories and security descriptors all become confounders, and the cell that hit them
  needed two human interventions to finish. A conversation-only stimulus removes the salt directories too, since
  nothing is written that a later round could read.
- **Pick the cell model deliberately.** `bailian/qwen3.8-flash` over-thinks, which changes what a cell spends its
  steps on; the owner's choice for the next round is `deepseek-v4.1-flash`, set through `agent-default-model` in
  the copied profile.
- **Set `s1.retryAttempts` (2 is enough) for a four-cell run.** The shared backend refuses rather than queues at
  its admission limit, and a measured round lost 732 of its 2 016 calls to `503 server busy` — after which the S1
  columns are partly lexical ones, because a refused call falls back to the local scorer. With the retry on, a
  refused call waits the server's own `Retry-After` and is answered, and `attempts`/`waitedMs` on the `s1_call`
  record say how often that happened. Report `judgedPairs / scoredPairs` either way.
- `~/.dsh/profiles/node_modules` is a farm of unresolvable junctions: a recursive `grep` there fails with
  thousands of `os error 3`s. Read the profile patch files directly.

Round directories: one per (cell, repeat), **different salts** — `node scripts/new-test-run.mjs --create` prints the
salt and the messages with it substituted. The salt must differ per cell, or one cell's answers land in another
cell's directory.

## Messages

The three-turn LeetCode stimuli live in `scripts/round-tasks.json` (ASCII-escaped, because no repository file may
contain Chinese). Turns 2 and 3 carry the owner's revision: each asks for a **new `.py` file, keeping the
previous one**, which is what makes the round a test of accumulation rather than of replacement. The fixture is
the only copy of the stimulus — it is substituted, never retyped at the keyboard, because a stimulus that is
retyped is a stimulus that has changed.

## Back-pressure

All four cells share one local Laya on `127.0.0.1:8008`. A measured round with whole-window scoring produced 281
`s1_call` records of which **191 failed** — 97 `TypeError: fetch failed`, 57 `S1TimeoutError` after 30 s, and 37
`503 server busy` returned by Laya itself — ending with **zero** `s1-noul` edges in the graph. Running the cells at
once will be worse, and the next round's run set does not avoid it: `tier1: off` is not an S1-off switch (upkeep
association scoring is not gated on it), so C1, C2 and C4 all make System-1 calls and C4 makes an order of
magnitude more than the other two. Either stagger the cells into two waves or report the 503s, because they change
what the numbers mean: a cell that received no System-1 judgements is not a cell that measured S1 governance.

### The S1 call volume is the pair count, not repeated work (measured 2026-10-01)

The upkeep lane asks one question per **new** pair — the arriving segment against each segment in its window — and
the volume that produces is `new pairs / s1.questionsPerCall`, which is quadratic in segments whenever `w` is
larger than the session. It is worth writing down because the suspicion that a new segment re-scores the whole
window, and therefore re-pays for pairs already judged, is natural and false, and because C4's "35 System-1 calls
per step" (1 155 calls over 33 steps) reads as waste until the pair count is beside it.

| cell | segments T | pairs offered = T(T−1)/2 | distinct pairs recorded | `s1_call` | ok / 503 / timeout |
| --- | --- | --- | --- | --- | --- |
| C1 | 116 | 6 670 | 6 670 | 363 | 134 / 202 / 27 |
| C2 | 93 | 4 278 | 4 278 | 257 | 128 / 103 / 26 |
| C3 | 82 | 3 321 | 3 321 | 241 | 89 / 145 / 7 |
| C4 | 214 | 22 791 | 22 791 | 1 155 | 807 / 282 / 66 |

Source: each cell's own `<DSH_HOME>/.s1cap/rg/*.json` (`order`, `scoredPairs`, `scores[]`) and its control JSONL.
The two middle columns are the test. A pair offered twice costs nothing extra in `scoredPairs`, but `scores` is
keyed by `${from}->${to}`, so a re-offer would leave the offered count one larger than the number of distinct
pairs; in all four cells the difference is **zero**, and the offered count equals `T(T-1)/2` exactly, which is the
full-history row of `docs/FORMULAS.md` §"Recall window w" — `w = 1024` never bound against a 214-segment session.
`scoredPairs` is cumulative per session and is read from the last assembly record, not summed over records.

The call count is that pair count over the cap (22 791 / 20 ≈ 1 140 full batches for C4), and the measured count
brackets it: refusals *shorten* it, because a window whose call failed abandons its remaining candidates and is
scored lexically in full, while the halving retry *lengthens* it by asking the rest of that window in smaller
batches. Pinned by `packages/core/test/pair-cost.test.ts` and, on the scorer's own request stream, by
`packages/dsh-plugin/test/s1-relevance.test.ts`. The lever is `recall.window` or `s1.questionsPerCall`; there is no
duplicate work to remove.

#### The lever, quantified: `recall.window`

Pairs for a session of `T` segments at window `w` are `Σ_{j<T} min(w, j)` — the first `w` arrivals are short
because there is less history than the window — which is `T(T-1)/2` while `T-1 ≤ w` and
`w(w-1)/2 + (T-1-w)·w` after that. Quoting the same four sessions at four windows, with the calls each implies in
full batches at `s1.questionsPerCall = 20` (`Σ_j ceil(min(w,j)/20)`; the measured count is at or below it when a
refused window is abandoned):

| cell | T | `w = 64` (the config floor) | `w = 128` | `w = 256` | `w = 1024` (what ran) |
| --- | --- | --- | --- | --- | --- |
| C1 | 116 | 5 344 pairs / 340 calls | 6 670 / 390 | 6 670 / 390 | 6 670 / 390 |
| C2 | 93 | 3 872 / 248 | 4 278 / 260 | 4 278 / 260 | 4 278 / 260 |
| C3 | 82 | 3 168 / 204 | 3 321 / 205 | 3 321 / 205 | 3 321 / 205 |
| C4 | 214 | 11 616 / 732 | 19 136 / 1 071 | 22 791 / 1 243 | 22 791 / 1 243 |

The three-turn sessions of the last round are short enough that only `w ≤ 64` changes anything for C1–C3, and C4
roughly halves at the floor. A longer session is where the window bites: at `T = 1024` and `w = 64` the pairs are
63 456 against 523 776 unbounded, and at `T = 4096` they are 260 064 against 8 386 560 — the Θ(T·w) row of
`docs/FORMULAS.md` §"Recall window w". The floor of 64 in `NUMBER_RULES` is what makes `w = 64` the smallest
setting available; a shorter window than that is not a config this repository supports, and lowering the floor is a
separate decision whose cost is the edge density described next, which nothing in round `20261001-1300` measured.

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

The cap is bounded 1–64, and raising it cuts calls the other way: at C4's measured `w = 1024`, `T = 214`, the full
batches are 1 243 at 20, 819 at 32, 678 at 40 and 468 at 64. What stops that from being free is the transport
guard, and the records bound it. Every successful `noul` call in the round (1 141 of them) carried **235–363 input
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
of the system under test: the same four columns would rank differently against another provider's rates, and the
ranking would say nothing about S1CAP. A cell that wins on one component and loses on another is a normal outcome,
not a tie to be broken by weights; the table is read component by component. What a rate cannot do is stand in for
the counts — round `20261001-1300` is the demonstration, because the cell with the best hit rate (C4, 92.6%) carried
the **largest** count on all three components, while the cell with a slightly *worse* hit rate than the baseline
(C2, 86.2%) carried the smallest. So report, per cell and **per turn and per step**:

| quantity | source |
| --- | --- |
| uncached input tokens | `data.usage.inputTokens` on `assistant/message` events — on this usage shape it counts the prompt tokens that *missed* the cache, not all prompt tokens |
| cached input tokens | `data.usage.cacheReadTokens` |
| output tokens | `data.usage.outputTokens` |
| steps, turns (the denominators) | `step/start` and `turn/start` counts in the harness session store, with the assembly-record count beside them as a cross-check |

The shape was verified on every session of the last round: `totalTokens = inputTokens + cacheReadTokens +
cacheWriteTokens + outputTokens`, and `cacheWriteTokens` was 0 in all four cells — which is what licenses reading
`inputTokens` as the miss side. Per-turn numbers come free with the same events (`data.turn`), and they matter:
C4's hit rate moved 90.3 / 83.5 / 94.3% across three turns, a ±10 pp spread with no stable ordering, so a per-run
average is a summary of three different regimes rather than a property of the cell.

That table, filled in from round `20261001-1300`, is what a report of this shape looks like:

| cell | steps | turns | uncached in | cached in | output | per step (uncached / cached / output) | per turn |
| --- | --- | --- | --- | --- | --- | --- | --- |
| C1 | 19 | 3 | 49 306 | 321 792 | 28 936 | 2 595 / 16 936 / 1 523 | 16 435 / 107 264 / 9 645 |
| C2 | 13 | 3 | 23 177 | 145 152 | 19 410 | 1 783 / 11 166 / 1 493 | 7 726 / 48 384 / 6 470 |
| C3 | 11 | 3 | 39 871 | 151 552 | 28 314 | 3 625 / 13 777 / 2 574 | 13 290 / 50 517 / 9 438 |
| C4 | 33 | 3 | 110 990 | 1 398 272 | 76 501 | 3 363 / 42 372 / 2 318 | 36 997 / 466 091 / 25 500 |

Read component by component, that table says what a single number would have hidden: C4 is above the baseline on all
three counts (2.25× the uncached input, 4.35× the cached input, 2.64× the output) and C2 is below it on all three
(0.47× / 0.45× / 0.67×). Those are three separate results and not one weighted result: the ordering happens to agree
here, and it need not in another round — a cell that wins on one component and loses on another is a normal outcome,
not a tie to be broken by weights.

**The System-1 lane carries its own usage, on its own line.** The claim "a cheap System-1 saves an expensive LLM"
has to include what the System-1 lane spent: sum `inputTokens` over the cell's `s1_call` records and report it with
the call count, beside the LLM's own triple rather than folded into it. Measured last round: 436 406 / 584 331 /
263 808 / 3 722 310 System-1 input tokens for 363 / 257 / 241 / 1 155 calls. In C4 that is **3 722 310 tokens over
1 155 calls**, 807 of them answered, against the same cell's LLM usage of `1 398 272` hit + `110 990` miss +
`76 501` output = **1 585 763 tokens** — the System-1 lane moved **~2.35×** the tokens of the model it is meant to
make cheaper. It is stated in tokens on purpose: the two lanes are not interchangeable, and this comparison is not a
bill. One is a local GPU resource, where the usage is what this line measures and the cost is the machine; the other
is a billed API, where the price depends on the model and the provider. Converting either into currency would put a
price list back in the middle of a quantity comparison. A cell whose S1 line is missing cannot support the claim in
either direction.

**Coverage goes beside every System-1 column**: `judgedPairs / scoredPairs`, with the failure split (`503 server
busy` / transport timeout / other) next to it. `scoredPairs` is the pairs the window *offered*; `judgedPairs` is the
ones the backend actually answered; a pair the backend did not answer was scored by the local lexical fallback, so
a cell that looks S1-governed from its edge count may be reporting the fallback's work. **Floor: a cell counts as
S1-governed only when `judgedPairs / scoredPairs` is at least 0.5.** Below half, the majority of the graph is the
fallback's, and a comparison against the baseline is measuring something other than System-1. The last round
measured 16.9 / 33.4 / 22.5 / 39.2% — **none of the four cells clears the floor**, which is the honest summary of
that run and the reason the next one should carry `s1.retryAttempts` and staggered cells. Report the number even
when it fails; especially then.

**The hit rate is a mechanism diagnostic, not the headline.** It answers "did the prefix stay stable across steps",
which is worth knowing and is not a cost: `h = cacheReadTokens / (cacheReadTokens + inputTokens)` — the derivation
is kept here on purpose, and its label in the report is "mechanism", reported against C1's own `h` and never
instead of the three quantities. A cell can win on `h` and still move more tokens on all three components, which is
exactly what C4 did.

**Output length is not a free variable in the comparison.** C4 emitted 76 501 output tokens against C2's 19 410 —
4× the volume — and in every cell of round `20261001-1300` output was 55–80% of what a price-weighted total would
have charged. That second figure is a statement about the quantities rather than about the prices: output dominates
any weighting, so at that share a comparison measures how much the model chose to say unless the stimulus constrains
it. Either bound the answer in the stimulus (a stated length or format the turn must respect) or report output
tokens as their own row, `n_out` beside `n_hit` and `n_miss` — but do not read a difference between cells off a
component whose volumes differ by 4×.

Derivations for the non-token columns, which stay as they were: LLM duration is derived from session-event
timestamps around each assistant message (`assistant/message.time` minus its `step/start.time`) and the derivation
is stated in the report; tool count and duration come from `tool/call` → `tool/result` pairs matched by `callId`;
System-1 duration and failures come from the `s1_call` records (`ms` summed, plus the ok/failed split and the
distinct error strings).

**Correction, established after this document was first written: C1 and C2 are *not* S1-free.** Upkeep graph
scoring is not gated on `recall.tier1`, so `tier1: 'off'` disables the recall *selection* and leaves the
association scoring running. With a live provider, C1 and C2 still emit `s1_call` records. Only `provider=none`
gives a genuinely zero-S1 cell — which is why the panel gained an **Off** choice. So: measure the S1 columns for
all four cells from the data, never fill them with 0 by assumption, and put C1/C2's S1 counts on their own line
in any report. A reader who takes C1 for a no-S1 baseline will misread the entire table.

Read JSONL with `node`, not PowerShell (which mangles UTF-8). Counts, timings and paths belong in a report;
session content does not.

## Two features whose first live check is this run

- `recallTree` — the graph structure each step's recall produced, keyed by segment id only, in the control plane;
- `judgedPairs` against `scoredPairs`, and `fallback` per assembly.

If `recallTree` is absent from the control JSONL, the feature is unwired no matter what the tests say — that is
the failure mode this repository has hit most often, and the reason each of these was committed with a grep
proving it reaches the file.

**Measured 2026-10-01 (round `20261001-1300`):** `recallTree` is present on **every** assembly record of all four
cells — 19/19, 13/13, 11/11, 33/33 — and non-empty exactly where `tier1` selects (7/11 in C3, 13/33 in C4), empty
in C1/C2 where recall selection is off. Both features are wired. The same run also shows what these counters are
for: 732 of its 2 016 System-1 calls came back `503 server busy` and 126 hit the 30 s transport guard (the round
report's denominator of 1 880 was read mid-run, before C4 had made its last 136 calls), so only 16.9 / 33.4 /
22.5 / 39.2% of association pairs were judged by the backend and the rest fell back to the local lexical scorer —
no cell clearing the 0.5 coverage floor. A cell's `judgedPairs / scoredPairs` belongs in every report beside its S1
columns.
