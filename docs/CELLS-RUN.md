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
three tasks, so three re-selections are *expected* and 86% may be unremarkable. **C1 has no S1CAP in it at all,
so C1's hit rate is the baseline, and the C1-vs-C4 delta is the finding.** An absolute number proves nothing
here.

## Cells

Presets live in `bench/cells/`; `cellPolicy(cell)` in `packages/core/src/types.ts` derives C1–C4 from toggles,
with `termination: model-owned` and `rgMaintenance.mode: async` fixed in every cell.

| Cell | `tas.on` / `xFirst` | S1 governance | Role |
| --- | --- | --- | --- |
| C1 | off / off | off | baseline: the harness manages history natively |
| C2 | on / on | off | the TAS half alone |
| C3 | off / off | on | the S1 half alone |
| C4 | on / on | on | the project's own configuration |

Two switches, not one: `tas.on` is whether the state proxy T exists at all, `xFirst` is whether the current task x
sits before or after the recalled block, and `cellPolicy()` moves them together here (both off for C1/C3, both on for
C2/C4) — which is why one column carries both.

## Setup

Four profiles, `C1test` … `C4test`, each a copy of the working `s1captest` profile with three changes:

- `cell: C1` … `cell: C4`;
- **separate telemetry paths per cell** — `telemetry.controlJsonl`, `sessionJsonl` and `tapeJsonl` must not
  collide across cells (the plugin rejects identical session and control paths, and a shared file would make the
  per-cell numbers meaningless);
- **a pinned `s1.baseUrl`** for the already-running local endpoint. This is not cosmetic. With Laya selected and
  neither a `baseUrl` nor a `laya.pythonPath`, `singleBackendIssues` reports a conflict, and a conflict drops the
  session to `provider=none` — the cell then makes **no System-1 calls at all** while the panel merely says the
  server is "stopped". Measured 2026-10-01: four freshly built cells came up with S1 entirely off, and `/s1cap-7340`
  showed `s1.provider: "none"` beside `configuredProvider: "laya-serve"`, until `baseUrl` was pinned. Pinning it
  changes nothing else: it is the address `laya.host`/`laya.port` derives anyway.

Ports: **19491, 19492, 19493, 19494**. Each instance is a managed background job, never `Start-Process`; the UI
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
  its admission limit, and a measured round lost 732 of 1 880 calls to `503 server busy` — after which the S1
  columns are partly lexical ones, because a refused call falls back to the local scorer. With the retry on, a
  refused call waits the server's own `Retry-After` and is answered, and `attempts`/`waitedMs` on the `s1_call`
  record say how often that happened. Report `judgedPairs / scoredPairs` either way.
- `~/.dsh/profiles/node_modules` is a farm of unresolvable junctions: a recursive `grep` there fails with
  thousands of `os error 3`s. Read the profile patch files directly.

Round directories: four, one per cell, **different salts** — `node scripts/new-test-run.mjs --create` prints the
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
`503 server busy` returned by Laya itself — ending with **zero** `s1-noul` edges in the graph. Four cells at once
will be worse. Either stagger C3/C4 or report the 503s, because they change what the numbers mean: a cell that
received no System-1 judgements is not a cell that measured S1 governance.

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
setting available; a shorter window than that is not a config this repository supports, and lowering the floor is
a separate decision with a recall-quality cost that nothing here has measured.

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

One thing the records do **not** establish, and it should not be guessed at: whether a smaller `w` costs recall
quality. `scoredPairs` and `judgedPairs` say how much was judged, and nothing in this round measured how often the
pairs a smaller window would have dropped were the pairs recall went on to use. A run that lowers `w` has to carry
`fallback`, `unknownAdmitted` and `recallTree` read beside it, or it is trading a measurable cost for an
unmeasurable benefit.

## Measurements, and where each comes from

| Metric | Source |
| --- | --- |
| cache-hit / cache-miss / output tokens | `data.usage` on `assistant/message` events (`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `totalTokens`) |
| steps | assembly records in the cell's control JSONL, or `observation.steps` on the status route |
| LLM duration | derived from session-event timestamps around each assistant message — state the derivation |
| tool count / duration | `tool/call` → `tool/result` pairs and their timestamps |
| S1 calls / duration | `s1_call` records in the control JSONL (`ms` summed, plus the ok/failed split and distinct error strings) |
| cache hit rate | hit ÷ (hit + miss), reported **against C1** |

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
for: 732 of 1 880 System-1 calls came back `503 server busy` and 126 hit the 30 s transport guard, so only 17–33%
of association pairs were judged by the backend and the rest fell back to the local lexical scorer. A cell's
`judgedPairs / scoredPairs` belongs in every report beside its S1 columns.
