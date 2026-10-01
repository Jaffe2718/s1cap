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
