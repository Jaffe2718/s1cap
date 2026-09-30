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

| Cell | TAS ordering | S1 governance | Role |
| --- | --- | --- | --- |
| C1 | off | off | baseline: the harness manages history natively |
| C2 | on | off | the TAS half alone |
| C3 | off | on | the S1 half alone |
| C4 | on | on | the project's own configuration |

## Setup

Four profiles, `C1test` … `C4test`, each a copy of the working `s1captest` profile with two changes:

- `cell: C1` … `cell: C4`;
- **separate telemetry paths per cell** — `telemetry.controlJsonl`, `sessionJsonl` and `tapeJsonl` must not
  collide across cells (the plugin rejects identical session and control paths, and a shared file would make the
  per-cell numbers meaningless).

Ports: **19491, 19492, 19493, 19494**. Each instance is a managed background job, never `Start-Process`; the UI
token comes from the job's own stdout.

Round directories: four, one per cell, **different salts** — `node scripts/new-test-run.mjs --create` prints the
salt and the messages with it substituted. The salt must differ per cell, or one cell's answers land in another
cell's directory.

## Messages

The three-turn LeetCode stimuli live in `scripts/round-tasks.json` (ASCII-escaped, because no repository file may
contain Chinese). **Known drift:** the owner revised turns 2 and 3 to create a new `.py` file and keep the
previous one; the fixture still holds the older wording. Update the fixture before the next run rather than
paraphrasing at the keyboard — a stimulus that is retyped is a stimulus that has changed.

## Back-pressure

All four cells share one local Laya on `127.0.0.1:8008`. A measured round with whole-window scoring produced 281
`s1_call` records of which **191 failed** — 97 `TypeError: fetch failed`, 57 `S1TimeoutError` after 30 s, and 37
`503 server busy` returned by Laya itself — ending with **zero** `s1-noul` edges in the graph. Four cells at once
will be worse. Either stagger C3/C4 or report the 503s, because they change what the numbers mean: a cell that
received no System-1 judgements is not a cell that measured S1 governance.

## Measurements, and where each comes from

| Metric | Source |
| --- | --- |
| cache-hit / cache-miss / output tokens | `data.usage` on `assistant/message` events (`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `totalTokens`) |
| steps | assembly records in the cell's control JSONL, or `observation.steps` on the status route |
| LLM duration | derived from session-event timestamps around each assistant message — state the derivation |
| tool count / duration | `tool/call` → `tool/result` pairs and their timestamps |
| S1 calls / duration | `s1_call` records in the control JSONL (`ms` summed, plus the ok/failed split and distinct error strings) |
| cache hit rate | hit ÷ (hit + miss), reported **against C1** |

C1 and C2 have no S1: their S1 columns are **0**, not blank — a blank reads as "not measured".

Read JSONL with `node`, not PowerShell (which mangles UTF-8). Counts, timings and paths belong in a report;
session content does not.

## Two features whose first live check is this run

- `recallTree` — the graph structure each step's recall produced, keyed by segment id only, in the control plane;
- `judgedPairs` against `scoredPairs`, and `fallback` per assembly.

If `recallTree` is absent from the control JSONL, the feature is unwired no matter what the tests say — that is
the failure mode this repository has hit most often, and the reason each of these was committed with a grep
proving it reaches the file.
