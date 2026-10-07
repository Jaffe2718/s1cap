# S1CAP status — what is true now, what is open, and where the record lives

**Updated:** 2026-10-02 · **Audience:** a human skimming the checklist, and a coding agent that has to pick
the work up cold.

Read [`AGENT_BRIEF.md`](./AGENT_BRIEF.md) first: it carries the verified-facts base (§1) and the ground
rules this file assumes. Every claim below is either backed by a test in `packages/*/test/`, by a real DSH
round, or by the packaged DSH source read with `scripts/scan-dsh-asar.cjs`. Where something is *not*
verified, it says so instead of guessing.

**This file is the current state, and only the current state.** Every dated round entry it used to carry — rounds 1
to 41, under their original headings — moved **verbatim**, in its original order, to
[`STATUS-ARCHIVE.md`](./STATUS-ARCHIVE.md) on 2026-10-02, together with the detail sections that were true only of
the work as it stood then. That file is a frozen record: it is never edited, and a correction is appended there as a
dated note, per `docs/DOC-CONTRACT.md` §4. A sentence here that is only true of a past round is a defect in this
file. **Sections 6 and 7 do not exist here any more** — they were the rounds of 2026-09-29 and 2026-09-30 — while §8
does, because `docs/CELLS-RUN.md`, `docs/AGENT_BRIEF.md` and `docs/PROPOSAL.md` cite it. §8 is a **pointer**, not a
restatement: the loop's rules, its draw procedure and its metrics belong to `HANDOVER-DSH-TEST.txt`,
`.s1cap-ablation/TASK-SELECTION.md` and `docs/FORMULAS.md` §8, and a round's own directory carries what that round
drew and ran. The cell-name banner below is current; the dated entries it describes are in the archive, and nothing
here should send a reader there for a current fact.

> **Cell names.** The ablation is now three cells: `C0` (baseline), `C1` (**a second control arm** — its TAS
> switches are recorded configuration and nothing is delivered, so its model-visible input is `C0`'s; it is not a
> "TAS alone" arm, because delivery has one channel and `tier1: off` leaves it empty by construction) and `C2` (the
> full configuration, the arm under test and the only cell that delivers). The registered contrast is **`C0` vs
> `C2`**, and what it measures today is the recall lane rather than TAS: the ordering reaches the model only through
> the model-view write-back, which does not exist yet (`docs/ARCHITECTURE.md` carries it as 🔜). The entries below
> were written while it was a four-cell scheme, so they name cells with the old
> labels: old `C1` = today's `C0`, old `C2` = today's `C1`, old `C3` (recall selection with `tas.on: false`) =
> dropped, no successor, old `C4` = today's `C2`. They are the record of what was run and verified at the time, so
> they are left as written — read their cell names through that mapping. `docs/CELLS-RUN.md` carries the mapping
> table, the reason the fourth arm was dropped, and the run prerequisites.

---

## 1. Checklist

### Foundation (M0) — complete

- [x] Repository, naming, metadata, authors
- [x] `@s1cap/core` — segmenter, association graph, assembler, plan gate, telemetry v1, control-plane isolation, cache policy, config validation
- [x] `@s1cap/s1-client` — `/v1/systemone` client, provider matrix, single-backend resolution, key redaction
- [x] `@s1cap/laya-runtime` — Python discovery, `laya-serve` launcher, health check, CLI (verified with a real end-to-end call)
- [x] `dsh-s1cap` plugin shell — loads and activates in a real DSH profile, inert by default
- [x] Route diagram — hand-authored HTML plus generated light/dark SVGs, with two guards
- [x] Documentation set (proposal, architecture, formulas, agent brief, runtime, control plane, related work, metadata)

### Observation mode (M1, blocks 1–2) — complete

- [x] Verified DSH plugin-loading and lifecycle facts (import shape, `inject`, command rules, middleware contract)
- [x] Safety envelope: inert unless enabled, activation cannot throw, verified hook contracts only
- [x] Harness adapter with a reported-unknown-shape policy
- [x] Per-call observation: real SEGMENTER → RECALL → ASSEMBLER, control-plane record, prompt untouched
- [x] Control-plane JSONL sink (rotation, `DSH_HOME`-relative paths, never throws)
- [x] Determinism tests: replay-identical records, non-mutating observation
- [x] End-to-end proof in a real headless DSH round

### Next (M1 blocks 3+)

- [x] **N1** System prompt sourced — closed by a real round (round 8): the pinned block is non-zero and the
      cache-stable prefix equals it
- [x] **N2** Association-graph upkeep on the asynchronous lane — closed by a real round (round 10)
- [x] **N3** Replay-parity harness (`packages/core/src/replay.ts`, a synthetic fixture, `scripts/replay-tape.mjs`,
      tape recording) — rounds 2–4
- [x] **N4** Settings panel and the Jev key — shipped and verified in a real browser (rounds 11–20)
- [ ] **N5** `llm_call` telemetry so cost and cache-hit rate become real numbers — the System-1 half is live; what is
      left is the LLM half, whose record shape is owned by `packages/core/src/telemetry.ts` (see §3)
- [ ] **N6** The actual context rewrite — what reaches the model today is an insertion of the recalled block and
      nothing more; what is closed, what is open and the rule behind it are in §3

### Later

- [ ] **M2** harness-agnostic proxy (`packages/proxy`, not written)
- [ ] **M3** the registered three-cell run set — `C0`, `C1` and `C2`, two controls and one arm under test, **not** a
      2×2 crossing ([`CELLS-RUN.md`](./CELLS-RUN.md) carries the registration) *(selection deliberately deferred —
      see `bench/README.md`)*

---

## 2. What the project is now

S1CAP is a **control layer around a coding agent**: it reads the harness's own event stream, builds an association
graph over the session, and decides which of the harness's *existing* context is in the model's prompt and in what
order. It never authors a prompt, never rewrites the transcript, and never owns termination (see [`ARCHITECTURE.md`](./ARCHITECTURE.md)).

- **The name** means **System-1 Context-Aware Planning**; the interventions are *Context Awareness* and *Plan
  Ordering*, and the retired expansion and the public strings are owned by `AGENT_BRIEF.md` §8 and
  [`REPO_METADATA.md`](./REPO_METADATA.md).
- **The code** is `packages/core` (segmenter, association graph, assembler, plan gate, telemetry, provenance, cache
  policy, config validation), `packages/s1-client` (one HTTP surface, one active backend, key redaction),
  `packages/laya-runtime` (Python discovery and launch) and `packages/dsh-plugin` (shell, commands, browser half).
- **The plugin** is inert unless enabled, cannot throw on activation, and registers only contracts read out of the
  packaged DSH source; `packages/dsh-plugin/package.json` → `dsh.compatibility.dshReleases` owns the release it
  declares as supported, and `AGENT_BRIEF.md` §1.8 states per fact which release it is evidence about.
- **Observation** (`observation: log`, the default when the plugin is enabled) runs SEGMENTER → RECALL → ASSEMBLER
  on every LLM call and appends one `assembly` record, and **the prompt the model receives is returned untouched**;
  the fields a record carries are owned by `packages/core/src/telemetry.ts` and `CONTROL_PLANE_LOGGING.md` §6, and
  how each of those was established is in [`STATUS-ARCHIVE.md`](./STATUS-ARCHIVE.md).

---

## 3. What is open now

**The TAS / model-view write-back project.** The assembled *order* does not reach the model: a plugin's only
delivery channel is the `agent/pre-step` splice, which appends after the last claimed message, so what separates the
cells on the model's side is recall *selection* — the layout axis (`tracePlacement`, and it is the only one: the
question is last in every layout by construction, so no field moves it) is
recorded in every cell and the assembled *order* reaches the model in none. Writing the layout back is **a separate
project** (🔜 in `ARCHITECTURE.md`).

**The ablation's registered contrast is `C0` vs `C2`, and what it measures today is the recall lane, not TAS.**
`C1` is a **second control arm**: its TAS switches are recorded configuration, nothing is delivered, and its
model-visible input is `C0`'s — a `C1`-vs-`C2` difference would be the instrument, not the method. The registration
and the reading rules are [`CELLS-RUN.md`](./CELLS-RUN.md); the rule it feeds is `docs/FORMULAS.md` §8.

**The defect gate is closed to measurement rounds, and one power note is unresolved.**
`.s1cap-ablation/DEFECT-GATE.md` is the verdict file and the gate: **no measurement round may start while any item
there is open or under review**, and its own "State of the build" block is where the last recorded build result and
suite count live — values that belong to the run, not to this file. Separately, `AGENT_BRIEF.md` §9.3's power note is
not reachable at the per-arm *n* it is quoted against: a sign test runs on *discordant* pairs and would need more of
them than an arm has tasks, so `FORMULAS.md` §8.1 marks it unresolved and the note says **do not plan against it**.

### N6 — the context rewrite, quotes only (archive: §3 `N6`; correction dated 2026-10-02)

The `recalled` block reaches the model with a one-line provenance label each and no S1CAP prose; the state proxy `T`
is recorded but never sent. A step whose decision is **empty** gets no insertion — that decision is also the
harness's turn-termination signal, which a plugin cannot observe — so the lane declines and records the refusal
(`assembled: false`) so "read and declined" is distinguishable from "never read". The derivation is in the archive.

**2026-10-03 — the paragraph above is the *default* of a switch now, not the only value the hook has, and N6 is still
open.** What the lane declines on is `AssemblyPolicy.assemblyTrigger` (`packages/core/src/types.ts`): `'claimed-only'`
— the default, the value all three cells run, and exactly the behaviour described above — or `'every-step'`, which
assembles on every step that will issue a request and is the only value under which `context-delivery.ts`'s
end-insertion branch is reachable for an empty decision. It landed defaulted off, so no cell's model-visible input
changed; the model-view write-back is still missing, so the assembled *layout* still reaches the model in no cell and
TAS's ordering is still recorded rather than delivered. §9 carries the decision and the order it forces (the eviction
regime first, per-step assembly second) and what a round would have to show before the permissive value could be more
than opt-in; `DEFECT-GATE.md`'s carried question 1 carries the round itself.

### N5 — the LLM call record, deliberately unemitted (archive: §3 `N5`, round of 2026-09-29)

`llm_call` is declared in the frozen schema and read by the cost model, and nothing produces it; the reason there
are no zeros in its place is in the archive. What is established: the host carries per-call usage on
`assistant/message`, and the declared event wants derived cache fields and an LLM-only latency the host does not
report.

---

## 3b. The knobs this build accepts and does not enforce (2026-10-02)

Some policy fields compose, validate, print and are read by **no code path that changes behaviour**. They are a
registry now — `UNENFORCED_KNOBS` in `packages/core/src/config.ts` — rather than a set of comments, because a comment
is not a thing a test can check and the failure this closes is exactly a knob that looks configured. **The registry is
the list: each entry carries what the knob `claims` and what it `wouldNeed`, and `/s1` publishes both. Neither is
copied here**, because a copy is what let the plan gate look configured for a whole round.

Three consequences worth knowing, because each one is a place a reader could be misled:

- **The registry is checked.** `packages/core/test/config.test.ts` fails if the registry and the declarations drift
  apart in either direction, and it pins the closed set: adding a knob and enforcing one are both deliberate
  edits there. `/s1` publishes the registry with each entry's `claims` and `wouldNeed`, so a live reader asks the
  question where it is answerable. One pair is worth knowing before reading it: `assemblyDeadlineMs` and
  `recall.anchorWaitMs` are two bounds in the same policy object, and the registry's own entry says which one runs.
- **`recall.tier1` left the registry by being *fixed*, not by being documented.** It was `embed | s1 | off` with
  `embed` inert, and the honest version of the value was to remove it: the union is `off | s1` now, `embed` is
  rejected with its own sentence (`LEGACY_TIER1`), and the wiring record prints the resolved value. This is the
  worked example for the rest — documenting an unenforced knob is the fallback, not the goal.
- **The plan gate is the precedent, and it is why this is a registry.** It was carried by the full-configuration
  cell, read by nothing, and its removal was swept for in the presets, the schema and the report — and nothing swept
  for the rest, which is how some of these survived the pass that deleted it.

The historical milestone sections below (**N1–N6**) state some of the registry's knobs as live guarantees. They are
records of what was designed at the time and are deliberately not rewritten; this section and the registry are the
current answer.

The milestone sections that sentence points at — the `D1`–`D6` and `N1`–`N6` detail the previous revision kept in
its §2 and §3 — are in [`STATUS-ARCHIVE.md`](./STATUS-ARCHIVE.md); §1, §2 and §3 above are the current answer.

---

## 4. Rules for whoever takes over

1. **Never install into the `desktop` profile** (user decision): it carries other plugins and skills and must
   stay clean. Use a throwaway CLI profile for every experiment — `dsh --profile s1capobs --from-default-profile headless --dump-config`
   for automated rounds, `--from-default-profile web` for UI work — and delete it afterwards.
2. **Read contracts from the packaged source before coding against them.** `scripts/scan-dsh-asar.cjs` reads DSH's own
   code out of `app.asar`, and **its own header documents its modes** — they are not listed here, because that list was
   already wrong once: a mode was added and the copy was not.
   **Run it under Electron-as-Node** (`$env:ELECTRON_RUN_AS_NODE="1"; & "…\DeepSeek
   Harness.exe" scripts\scan-dsh-asar.cjs …`): under plain `node` it reads nothing inside the asar and reports
   `total hits: 0` for *every* needle, including ones that certainly exist. Guessing a hook contract once killed
   a live round; a scanner that silently returns no findings nearly caused a second.
3. **`agent/pre-step`'s `decision.messages` is the step's increment, not the history.** `decision.messages` is
   `claimed` (what the inbox handed over) plus a projected context message; `dsh-agent-loop`'s `step()` appends
   it to the session log and then builds the request *from that log*. So a plugin can add context, and cannot
   remove any. See N6.
4. **After any profile install, re-run `pnpm install` in the repository** — it can drop the workspace
   junctions the tests resolve `@s1cap/*` through.
5. **Ship JavaScript.** Profile installs live under `node_modules`, where Node refuses to strip TypeScript, so
   `main`/`exports` point at `lib/`; run `node scripts/build-packages.mjs` after touching any `src/`.
6. **Everything is English.** No Chinese in any repository file, including comments and fixtures.
7. **One System-1 backend at a time**, and S1CAP never owns termination.
8. **A half-built governor must never break the harness:** inert by default, `apply()` wrapped, only verified
   hook contracts registered, every optional surface failing soft with a warning.
9. **Measurement honesty:** a telemetry record is metadata only (ids, counts, timings). Session content never
   enters the control plane, and control-plane records never become segments.
10. **A round's isolation is its workspace; the salt-named directory is for a stimulus that writes.** A round used
   to write its answer to the workspace root under a name the task text itself supplied (`pelican-bicycle.html`),
   which meant a later round could read the previous round's answer instead of solving the task, and two rounds
   writing the same name replaced one another. The current stimuli write nothing — the answer goes into the
   conversation, and no file or directory may be created, modified or deleted — so there is no salt to substitute
   and no round directory to open: what isolates a cell is its **own empty workspace**, `<run>/ws/<cell>`, so there
   is nothing for a later cell to inherit and no path for two cells to collide over. The directory mechanism stays
   available for a stimulus that does write: `node scripts/new-test-run.mjs --create` opens
   `<workspace>/<salt>/<answer>.html`, where the salt is 48 bits of urandom substituted wherever a fixture contains
   `{salt}` — a name that cannot be derived from the previous round's prompt, and therefore cannot be aimed at.
   Where a stimulus names such a directory, the salt appears exactly once, in the first message, and a mistyped salt
   would send the answer somewhere the round is not watching; hence the messages are read from
   `scripts/round-tasks.json` and sent as recorded, never retyped. The stimuli are LeetCode 121 → 122 → 123 (best
   time to buy and sell stock, one transaction → unlimited → at most two), chosen for the *continuity*: all three
   share one DP skeleton, so the third turn genuinely benefits from the first two and the relevance path has
   something real to score - and each turn keeps the earlier answers untouched and adds a new section, under a
   length cap (code ≤ 40 lines, rationale ≤ 6 bullets), because a round that spends fifteen minutes rendering a
   27 KB HTML animation measures the model's stamina rather than the mechanism. That fixture is ASCII-escaped
   (`\uXXXX`): the stimuli are Chinese and no repository file may contain Chinese, so the escapes are how the exact
   recorded code points stay exact. The **workspace itself is not reconfigured** — the session's workspace is part
   of what the experiment observes, so narrowing it per round would change the thing under study. For a writing
   round, the salt does *not* hide the other rounds: they are still inside the workspace, so move a finished
   round's directory out once its evidence is collected. The artifacts from before this rule live in
   `260930164900/` (a timestamp, from when the rule was a timestamp).

---

## 5. Verify everything right now

```console
node scripts/build-packages.mjs                       # refresh lib/ (must match src/)
node --test --experimental-strip-types "packages/*/test/*.test.ts"
node scripts/check-diagram.mjs                        # diagram geometry
node scripts/check-doc-pointers.mjs                   # dead file/section pointers and stale value claims
node scripts/build-route-svg.mjs --check              # committed SVGs match the HTML source
```

A real round, in a throwaway profile, with the observation log afterwards — **the commands are the run book's, not
this file's**. `.s1cap-ablation/RUNBOOK.md` (one level above this repository) is the procedure: shell variables, the
round directory, the composed-config check, the launch, the three inputs per cell and the evidence layout. A round that
skips it repeats failures that are already measured there. The probe profile's own patch is
`packages/dsh-plugin/examples/profile.s1captest.cordis.patch.yml`.

---

## 8. The phase that runs now — a pointer, not a restatement

Short-turn token accounting was retired as a measurement on 2026-10-01 (owner decision; the dated entry is in the
archive), and the phase that replaced it is a **test/optimize loop**: draw one long-horizon task from the pools
`AGENT_BRIEF.md` §5 names, run it under all three cells, optimize what the run exposes, draw again.

- **One draw supports optimization, not a claim** — an iteration is complete only when the same task has run under
  all three cells, and a *claim* still needs the registered grid (`AGENT_BRIEF.md` §5–§6, `docs/FORMULAS.md` §8).
- **The draw must be auditable, and the rule is declared before the draw**: `.s1cap-ablation/TASK-SELECTION.md` owns
  the admissibility and scale gates; each round's own directory carries which task passed which gate, with the values
  read from the bank's record.
- **The loop, its draw rule and its metric set are the Collaborator's**, supervised with `GPT-6-Astra`.
- **The DSH version is resolved per round and recorded with the round**; the release this project supports is owned
  by `packages/dsh-plugin/package.json` → `dsh.compatibility.dshReleases`.
- **The two token accounts stay separate** — the System-1 lane's are Laya's, the LLM's are the LLM's — and the
  procedure is [`CELLS-RUN.md`](./CELLS-RUN.md) + `.s1cap-ablation/RUNBOOK.md`; the brief is `HANDOVER-DSH-TEST.txt`.

---

## 9. Dated decision (2026-10-03) — per-step assembly, and the eviction regime it depends on

Appended after round `20261003-2104`, whose report is the dated record (`round-20261003-2104's round report (directory pruned 2026-10-07)`).
Figures are quoted from it only to make the decision legible; none of them is a second copy of anything the code owns.

### What the round measured

1. **The lane acted on 2 of 33 model calls.** One assembly carried a real recall walk; the other had no walk tree at all.
   The gate is a single predicate — whether the pre-step decision carries claimed messages — and `agent/pre-step` carries
   one user message on step 1 and an empty array afterwards (the six-faults list in `STATUS-ARCHIVE.md`, fault 2). The
   design record's own acceptance line reads "one assembly per step" (the session-event-stream row of the same file's
   figure table), and N6 — the assembled layout reaching the model on every call — is still open, in § N6 above.
2. **Nothing was ever evicted.** Compaction never fired in any cell, and the peak per-request total sat far below the
   trigger the routed context window implies. Because the request is rebuilt from the session log, every delivered
   `recalled` block was a verbatim re-quote of turns the model already held in full.
3. **The completion column separated nothing** — all three cells solved the task, so it carries no variance across the arms.

### The coupling, which is why the order below is not a preference

(1) and (2) are not independent defects. With no eviction, anything recall selects is something the model already has, so
assembling on more steps adds duplicated transcript rather than recovered history; the per-session dedup rule suppresses an
identical payload, not a differently-selected one. **Assembling every step is a benefit only in a regime where history is
actually lost, and a pure cost in this one.**

The order is therefore forced: **restore the eviction regime first; per-step assembly second.** Read before that regime
exists, the arm's cost figures measure the regime rather than the mechanism, and a negative result cannot be attributed.

### The three paths

- **C — restore the eviction regime. First.** The standing item is `DEFECT-GATE.md` `D4b`: the profile's context window
  and completion reserve compose but do not reach the routed provider, so the trigger is the adapter default's and is out
  of the intended reach. With that corrected and a task long enough to cross it, recall has work to do. Until then, the
  arm's cost and time columns describe the configuration, not the feature.
- **B — make per-step assembly reachable. Second, and landed defaulted off.** The insertion branch that would place a
  block when no message is claimed already exists and is unreachable behind a refusal in `context-delivery.ts`, whose own
  header records the contradiction; the predicate that gates the assembly sits in the pre-step hook. Both are the same
  change and must land together so a round can flip exactly one variable, with the measured behaviour as the default.
- **A — the model-view write-back. Not now.** It is the designed end state and it is absent from the tree. It also collides
  with the contract `context-delivery.ts` states in its header: a plugin can insert into what the log holds, it cannot
  suppress it, and a design that claimed otherwise would leave the log asserting one thing and the model seeing another.
  Open it only after C and B have shown what the assembled layout would actually have to carry.

### What this decision does not settle

The D1 correction stands: an empty decision is also the harness's turn-termination signal. The round is evidence that on
*its* steps an empty decision did not mean "no request" — every step issued exactly one call — but that is one round, so B
is a switch with a conservative default rather than a change of contract.

Pointers: verdicts and the standing question this ordering answers, `.s1cap-ablation/DEFECT-GATE.md` (update dated
2026-10-03); that round's numbers, its `ROUND-REPORT.md` and its `report/` directory; knob names and defaults,
`packages/core/src/types.ts`; metric definitions, `FORMULAS.md`; procedure, `.s1cap-ablation/RUNBOOK.md`.

---

## 10. Dated decision (2026-10-04) — the paper's variable is the *placement of `T`*, and S1CAP was not varying it

Appended after §9, beside it and **not** in place of it. §9's ordering — restore the eviction regime first,
per-step assembly second — is untouched by this section and still binds; what follows adds a fourth item to that
list and says where in it this one sits. Everything above this line is left as written.

### The authority, stated once

The source is **arXiv:2609.02702** (Zou & Tang, 2026-09-02), *Trace as State: Reasoning Traces as Conditional
States for Long-Context Transformers*. Four facts about it are load-bearing here, and none of them is S1CAP's to
re-derive:

1. **The result is a placement contrast, and placement is the only independent variable.** Two second passes over
   the *same* long context `x` and the *same* serialized trace `T`, with the question `q` last in both:
   *Trace as State* `M([T, x, q])` against its matched control *Trace Append* `M([x, T, q])`. (Notation from
   the paper: `x` is the **long context** and `q` the **question** — the reverse of S1CAP's `x`, which is the user's
   latest input. `docs/FORMULAS.md`'s symbol table carries S1CAP's convention and is corrected where it borrowed
   the paper's.)
2. **`T` is the model's own reasoning trace, serialized.** `T = π(r_1,…,r_ntr)`, where the serializer `π` is held
   **fixed across the placement conditions**, preserves the reasoning text **in source order**, and adds only
   fixed labels and delimiters (`<trace_start>` / `<trace_end>` and a brief introductory line). Over-long traces
   are truncated to the **first 50,000 characters**.
3. **The effect is large and general.** Across three models and three long-context datasets, Trace as State beats
   Trace Append in **26 of 27** reported model×task×metric combinations. On GraphWalks Parents, DeepSeek V4 Pro
   Preview exact match goes **29.2 %** (single pass) → **43.0 %** (Trace Append) → **81.8 %** (Trace as State).

Read together: the paper's claim is *the same `T`, moved*. Anything that changes `T` between the arms, or omits it,
is not the experiment the paper ran.

### What S1CAP presents today: one value of that variable, in all three cells

The two existing statements that already say this are **§N6 above** ("the state proxy `T` is recorded but never
sent") and **`ARCHITECTURE.md` §5's delivery paragraph** ("the state proxy `T` is deliberately never sent, and
nothing in the assembled layout is reordered for the model"). Neither is restated here; both are correct, and
both are cross-referenced from this section.

**What has changed is their weight, and this is the consequence worth writing down.** Those sentences were written
against an extractive summary — a compact statement of where the task stood — so refusing to deliver `T` lost a
summary. The paper's premise has now replaced that summary (§ "The decision", below), so refusing to deliver `T`
loses **the intervention under test**. Concretely: with `T` absent from every cell's model view, the registered
**`C0` vs `C2`** contrast cannot measure paper-T's mechanism **at all** — not "cannot isolate ordering", not
"cannot separate selection from delivery": it cannot touch the variable the paper's 26/27 is about. The
`T`-never-sent statements in `STATUS.md` §N6 and `ARCHITECTURE.md` §5 are therefore **not falsified by this
section and have not been rewritten**; they are cross-referenced from here and from `ARCHITECTURE.md` §5, and
this line is what their weight now includes.

The same applies to the arm description. `C1` is a second control arm whose model-visible input is `C0`'s (`C1.json`
records this, and it is why the registered contrast is `C0` vs `C2`); the three arms today present **one** value of
the paper's variable, so no document may describe them as testing paper-T ordering. §3 above, `ARCHITECTURE.md` §5,
`.s1cap-ablation/RUNBOOK.md`'s "The cells" and `docs/CELLS-RUN.md` all already say the registered contrast is
`C0` vs `C2` and that what it measures today is the recall lane.

### The second mismatch: `xFirst` moves the anchor, not `T`

`xFirst` is the project's own idea-1 knob — "prioritise the user's latest input `x`" — and it does exactly that.
It does **not** move `T`. In the recorded assembly layout the `stateProxy` block sits at index 1 in **every**
branch; `xFirst` only decides whether the anchor `x` precedes or follows the recalled block
(`packages/core/src/assembler.ts` owns the layout; `packages/dsh-plugin/src/context-delivery.ts` says in its own
header that `xFirst` never depended on `T`).

Two consequences follow, and both are semantic, not cosmetic:

- **The Trace-Append arm is not expressible today.** There is no configuration in which `T` sits after the
  context, because no configuration moves `T` at all.
- **The order that does match the paper's Trace-as-State side is the *non*-`xFirst` branch** — which is also, per
  `packages/core/test/authority.test.ts`, the branch `C0` is defined to take. So the one arm that currently looks
  like the paper's intervention is pinned to a branch whose distinguishing property is *not* the paper's.

**Being corrected by making `T`'s position an independent variable**, separate from `xFirst`. Its name, its type,
its default and the cells that carry it are owned by `AssemblyPolicy` in `packages/core/src/types.ts` and are
printed on each run's own `kind:"wiring"` tape record; **this section deliberately does not restate them**
(`docs/DOC-CONTRACT.md` §2 — the implementation is in flight, so a copy written today would be wrong tomorrow).

### The third mismatch: the state's *content* was not the paper's

Until 2026-10-04 the proxy was an extractive summary — `task:` / `ran:` / `called:` / `next:` lines — and its own
module header stated the premise it was built on: a long reasoning trace is **"a bad thing to carry verbatim"**, so
the trace was replaced by a compact statement of where the task stands. The paper takes the opposite position: it
uses **the traces themselves** as the textual proxy, and the whole of its result is about where that text sits. A
port that replaces the artefact under test with a summary of it measures the summary.

**That premise is replaced with the paper's**, and the module rewrite is in the tree: `T` is now the model's own
reasoning text, in source order, inside a fixed frame of constants — no S1CAP-authored prose, no per-turn
re-interpretation — bounded by the ceiling the paper uses. What exactly is serialized, which segment kinds count as
the trace, and what the ceiling resolves to are all owned by `packages/core/src/state-proxy.ts` and by
`tas.tMaxChars` in the policy; they are **not** copied here.

### The decision

1. **`T`'s content is the paper's serialized trace.** Landed. The premise that a verbatim trace is a bad thing to
   carry has been withdrawn, not softened.
2. **`T` is delivered to the model.** This settles the question `ARCHITECTURE.md` §5 carries and §N6 above
   cross-references — "may an **authored** state proxy `T` be delivered at all?" — **in the affirmative**, and the
   word *authored* is what made it sound otherwise: a block nothing authored is not a prompt injection and not a
   claim S1CAP makes on the model's behalf. The premise it was carrying is the one item 1 withdrew, so the
   objection falls with it. The delivery mechanism itself is **not** thereby undecided: the assembled view has to
   reach the model as a layout rather than as one inserted block, which is the model-view write-back `ARCHITECTURE.md`
   §5 describes.
3. **Both arms are specified, and neither is tested.** Trace-as-State and Trace-Append are two settings of one
   variable, so a round can flip exactly one. **No round has exercised either**, and nothing in this section is
   evidence about a model. **Status of the code at the time of this append, so a reader does not take this
   paragraph for a delivery record:** item 1's content change is in the tree; items 2 and 3's *placement* half —
   `T`'s new position as an independent variable, and its delivery — are **decided and in flight, and are not in
   `packages/core/src/assembler.ts` or `packages/dsh-plugin/src/context-delivery.ts` as this line was written.**
   Read those two files for what exists; read this section for what was decided.
4. **`xFirst`'s meaning is separated from the paper's variable.** `xFirst` keeps the originating prompt's idea 1 —
   prioritise the user's latest input — and stops being read as a Trace-as-State control. Any document that
   glosses `xFirst` as "the TAS knob" is describing the pre-2026-10-04 conflation.

### What this does to the arms — stated plainly

- **`C0` is unaffected.** Its `tas.on` is `false`, so it has no `T` to deliver and its layout stays chronological.
- **`C1` is unaffected.** Its `deliver` is `false` by policy (`cellPolicy('C1')`), so nothing it records reaches the
  model and it remains the second control arm whose model-visible input is `C0`'s.
- **`C2` changes, and this is the one to be careful about.** `tas.on` is `true` there and `deliver` is `true`, so
  **the next round's `C2` will present a model-visible input it has never presented in any recorded round.** Not
  a larger `recalled` block — a block that was previously never sent at all, at a position that is new. Any
  comparison against a recorded `C2` is therefore not a like-for-like continuation, and the round report has to say
  so on its own evidence rather than inherit this line as an excuse.
- **Consequence, and it is not this section's to take:** the originating prompt's three arms are *plain DSH* /
  *paper-T's promise* (x First on, Laya off) / *this project's full configuration* (x First on, Laya on). The
  middle arm is precisely the one this decision unblocks and precisely the one `C1` cannot carry, because `C1`'s
  lane is off and its delivery is off by policy. **Whether the registration has to change is an open decision for
  the owner**, recorded here so it is not discovered mid-round. This section does not change `C1`'s role; §3's
  registration stands until its owner says otherwise.

### Two things that do not move

- **User-facing presentation stays strictly chronological.** That is the originating prompt's standing constraint
  and it is unchanged: everything below is model-view only, and the human record is never rewritten
  (`ARCHITECTURE.md` §3's Event-intake row).
- **§9's ordering stands.** Restoring the eviction regime is still first and per-step assembly still second. This
  section is **third in sequence, after both**, and for a reason §9 already gives its own way: an arm that cannot
  present `T` cannot be measured, and a cost figure read in a regime where nothing is evicted describes the regime
  rather than the mechanism. Adding `T` to a prompt in a run where compaction never fires would spend real tokens to
  measure nothing.

### One harness fact that bears on every claim above about "what the model sees"

DSH's own docs state the reconstructability contract this project relies on — the request is a pure function of
the session log — and **`dsh-agent-loop` ships an opt-in invariant companion** that enforces it by *failing* a
request whose messages do not equal the log's reconstruction (`lib/invariant.js`, a `"log-reconstruction desync"`).
It is a separate companion export and is **not** in the bundle's row list, so it is not mounted by default; whether
a cell profile mounts it has not been established either way, and this section does not assume it. **What it means
for the reader:** §4's rule 3 and `ARCHITECTURE.md`'s model-view row describe the contract as S1CAP reads it, and
if a future round ever surfaces a desync failure, the first question is whether that guard was mounted — not
whether S1CAP broke the contract. `scripts/scan-dsh-asar.cjs` is how the shipped source is read.

### Addendum, later the same day (2026-10-04) — the arm registration changed while this section was being written

Appended per `docs/DOC-CONTRACT.md` §4.1; **nothing above this line is edited.** The code owner changed
`cellPolicy()` (`packages/core/src/types.ts`) and the delivery channel
(`packages/dsh-plugin/src/context-delivery.ts`) on 2026-10-04, after the section above was written. **Read those two
files for what is in the tree; this addendum says which sentences above have been overtaken.**

**Two claims above are now superseded.**

1. **"`C1` is unaffected"** (in "What this does to the arms") is **false as of this addendum**. `cellPolicy('C1')` now
   sets `deliver: true`, because `tas.on` now implies `T` is delivered — the delivery channel carries the trace,
   which is what the 2026-10-02 re-registration said was impossible. `C1`'s model-visible input is therefore no
   longer `C0`'s, and the sentence in `C1.json`'s `_meta.secondControl` that says it is has not been updated.
2. **"the registered contrast is `C0` vs `C2`"** — the contrast this section cites from §3, from the cell-name
   banner and from `ARCHITECTURE.md` §5 — is superseded. The registered contrasts are now the paper's own two steps,
   **`C0 → C1`** (what the trace's presence buys, lane absent) and **`C1 → C2`** (what recall selection buys on top).
   The statement of record is the comment above `cellPolicy()` in `packages/core/src/types.ts`. §3 above, the banner
   above it, and `ARCHITECTURE.md` §5 are **left as written** and are now history; the same applies to
   `C1.json`'s and `C2.json`'s `_meta` notes and to `docs/CELLS-RUN.md`.

**What is *not* superseded, and is the reason this section still stands.** The arms now differ in **whether `T` is
delivered**; they still do not differ in **where `T` sits in what is delivered**. The placement axis exists in the
policy — `AssemblyPolicy.stateProxyPosition`, its two values being the paper's Trace-as-State and Trace-Append
orders, its name and default read from `packages/core/src/types.ts` — and it is deliberately absent from every
preset, because putting a value in one would redefine which arm a cell *is*. But the one insertion channel still
**appends**, so the injected message is `T` followed by the recalled turns whatever the recorded order was: the
placement axis is measured in the recorded `layout.order`, **not in the text the model receives**. That sentence is
the code's own, in the comment above `cellPolicy()`.

So the paper's 26-of-27 contrast is still not what a round measures, and for the same reason as when this section
was written — `xFirst` moves the anchor rather than `T`, and no arm's *delivered text* puts `T` after the context.
A round that wants the control needs the write-back that delivers a layout, not a block; that remains the
model-view project `ARCHITECTURE.md` §5 describes. Item 4 of "The decision" above is likewise unaffected: `xFirst`
is still the originating prompt's knob and still is not the paper's variable.

### Pointers

Paper: arXiv:2609.02702. The state's owner, the knob and its default: `packages/core/src/types.ts`
(`AssemblyPolicy.tas`, `AssemblyPolicy.xFirst`) and `packages/core/src/state-proxy.ts`; the assembled layout:
`packages/core/src/assembler.ts`; the one live delivery channel: `packages/dsh-plugin/src/context-delivery.ts`.
The existing statements this section cross-references rather than restates: `STATUS.md` §N6 above and
`ARCHITECTURE.md` §5. The arms and the registered contrast: `docs/CELLS-RUN.md` and `bench/cells/*.json`. §9's
ordering: above, and the gate it depends on in `.s1cap-ablation/DEFECT-GATE.md`.

---

## 11. Dated correction (2026-10-05) — one layout field was renamed and the second was **deleted**

Appended beside §10 under `docs/DOC-CONTRACT.md` §4. **Nothing in §10 is rewritten**; this section names what moved,
why, and which of §10's sentences the build no longer supports. The rename is in the tree — and the field this section
first described as its second half was deleted later the same day, which §12 records, quoting this section's mapping as
superseded. Its statement of record is the comment above
`cellPolicy()` in `packages/core/src/types.ts`.

### What moved

`AssemblyPolicy.xFirst: boolean` is gone from the tree: it was renamed to `questionPlacement: 'first' | 'last'` and
then **deleted** the same day (see §12, which quotes the field mapping this section used to carry as superseded).
`AssemblyPolicy.stateProxyPosition: 'before-context' | 'after-context'` is now
`tracePlacement: 'trace-as-state' | 'trace-append'` (default `'trace-as-state'`), the **only** layout axis, because the
question is last in every layout by construction. A profile
that still sets an old spelling is read and reported rather than dropped (`LEGACY_LAYOUT_KEYS`,
`packages/core/src/config.ts`); which spellings are warned about and which are refused is the code's, not this
section's, because a silently ignored layout key is
how a configured arm ends up running the default one. Names, values and defaults are owned by
`packages/core/src/types.ts`, `packages/core/src/config.ts` and the presets; §10's own rule — that this file does not
restate them — still holds.

### Why

The paper (arXiv:2609.02702, §4.1) places the question **last in every condition** — "the question appears at the end
of the prompt … place it at the end of every input" — and its two arms are `[T, x, q]` (Trace as State) and
`[x, T, q]` (Trace Append), **order the only difference**. `xFirst` moved the *question*, the one element the paper
fixes, and its name presented that as the paper's variable. `stateProxyPosition` was already the paper's axis, so it
took the paper's name. **The question's own axis was then deleted rather than renamed** — §12 records it: renaming it
to `questionPlacement` kept the mistake alive, because it left "the question's position is a variable" expressible and
its `'first'` value produced `[T, q, x]`, which is neither paper arm.

### The evidence, from round `20261004-0233`'s own `layoutOrder` records

- **`C1` and `C2` recorded `pinned, stateProxy, anchor, recalled, tail`** — the question second, a layout that is
  neither paper arm — because both set `xFirst: true`.
- **`C0` recorded `pinned, recalled, tail, anchor`** (`xFirst: false`, TAS off): the paper's baseline `M([x, q])`, and
  not one of the paper's two second-pass arms either.

So no cell reproduced either paper arm, and the first of those two strings is not producible by any setting now
(`packages/core/src/assembler.ts` carries the block order each `tracePlacement` value produces; a sibling-derived
table of those orders is in its header). What the rename buys is that the axis is a *named* field whose two values are
the paper's two arms, enforced by the assembler and recorded on every assembly.

### §10's sentences this supersedes

1. **"The second mismatch: `xFirst` moves the anchor, not `T`"** (the whole subsection, lines 376–392 before this
   note). The field it is named after no longer exists, and the mismatch is repaired rather than described:
   `T`'s position is an independent, enforced field, and the paper's Trace-Append control is expressible
   (`tracePlacement: 'trace-append'`). What survives is the narrower reading — **no preset carries it**, so no *arm*
   has ever presented the control, and the delivered text still appends (`packages/dsh-plugin/src/context-delivery.ts`).
   Its two consequences are superseded on their second half: *"The Trace-Append arm is not expressible today. There is
   no configuration in which `T` sits after the context"* is false of the policy now (it is true of what any cell has
   run), and "the order that does match the paper's Trace-as-State side is the *non*-`xFirst` branch" names a branch
   that no longer exists — **TAS** is the **default** now.
2. **"The decision", item 4** (line 429). *"`xFirst`'s meaning is separated from the paper's variable. `xFirst` keeps
   the originating prompt's idea 1 — prioritise the user's latest input — and stops being read as a Trace-as-State
   control."* The separation happened, and the rename finished it: **the arm is TAS** — the paper's `[T, x, q]`,
   named by `tracePlacement`, whose other value is the paper's Trace Append control `[x, T, q]` — while the idea-1
   knob is `questionPlacement`, `'last'` in every cell because that is the paper's fixed point, and **not** an arm.
   Any document that glosses the question's position as the TAS knob would be repeating the pre-2026-10-04
   conflation under a new name.
3. **"What this does to the arms", last bullet** (line 444). The sentence "the originating prompt's three arms are
   *plain DSH* / *paper-T's promise* (x First on, Laya off) / *this project's full configuration* (x First on, Laya
   on)." Defining an arm by the question's position is the defect the rename removes: **the three arms are the
   baseline, TAS (the paper's Trace as State arrangement, `[T, x, q]`), and that plus the System-1 lane**
   (`docs/CELLS-RUN.md` "The arms, and what the contrast is" owns the wording; `cellPolicy()` owns the values), and
   the paper's other arm, Trace Append (`[x, T, q]`), is the control the placement axis names rather than a cell.
4. **The addendum's "What is *not* superseded"** (lines 492–505). Its field name is stale —
   `AssemblyPolicy.stateProxyPosition` is `AssemblyPolicy.tracePlacement` — and its *"`xFirst` moves the anchor rather
   than `T`"* is now two facts rather than one: the field that moved the anchor was deleted (it had been renamed
   `questionPlacement`, and §12 records the deletion), and the field
   that moves `T` is `tracePlacement`. Its conclusion **stands unchanged and is the point**: the placement axis is
   measured in the recorded `layout.order`, not in the text the model receives, and the paper's 26-of-27 contrast is
   still not what a round measures until the model-view write-back exists.
5. **"Pointers"** (lines 509–511). *"`AssemblyPolicy.tas`, `AssemblyPolicy.xFirst`"* — the layout field is
   `AssemblyPolicy.tracePlacement` alone since §12; `AssemblyPolicy.tas` still owns whether
   `T` exists, how long it may be and when it is rebuilt.

### The live sentence corrected in place (§3, the third paragraph, line 107 before this note)

It read: *"the TAS ordering half (`tas.on`, `xFirst`) is recorded in every cell and reaches the model in none."* It now
names the layout axis — `tracePlacement`, again alone since §12 — and says the *assembled order* reaches the model in
none — the same fact, with the field the build actually has. The rest of that paragraph (the splice appends, so the
layout write-back is a separate project) is unchanged and still true.

### Outstanding, and not part of this correction

§10's item 4 above is corrected here because the rename renamed it. Its neighbours that state the pre-2026-10-04
registration — the cell-name banner at the head of this file, §3's "registered contrast is `C0` vs `C2`" paragraph,
and §10's "What this does to the arms" bullets about `C1`'s delivery — are superseded by §10's own addendum and by
`cellPolicy('C1')`'s `deliver: true`, not by this rename, and they are left as written.

---

## 12. Dated correction (2026-10-05) — the question axis was **deleted**, so `tracePlacement` is the only layout field

Appended beside §10 and §11 under `docs/DOC-CONTRACT.md` §4. **Nothing in §10 or §11 is rewritten**: this section
records what was deleted and quotes the claims it supersedes. §11 is the *first* correction of the day and its
`questionPlacement` half did not survive the day, so §11's field mapping is quoted below rather than edited. §3's third
paragraph is a live statement and was corrected in place, which is why §11's account of it is superseded here.

### What moved — a deletion, not a rename

`AssemblyPolicy.questionPlacement: 'first' | 'last'` is **gone from the tree**. **`AssemblyPolicy.tracePlacement:
'trace-as-state' | 'trace-append'` is the only layout axis**, and `AssembleInput`'s doc comment says what the anchor is:
"the last block of every layout this build produces". Concretely, in `packages/core/src/assembler.ts`: `assemble()`
appends `anchor` unconditionally; `layoutStableTokens` no longer adds the question's tokens; `cutAfterBlock` has no
`'anchor'` branch. What each `tracePlacement` value lays out is that file's header table and is not restated here.

### Why it was deleted, and why renaming was not enough

The paper (arXiv:2609.02702 §4.1) places the question last in *every* condition — "Models may not behave as intended
unless the question appears at the end of the prompt. We therefore separate the question from the long context and
place it at the end of every input" — and its two arms are `[T, x, q]` (Trace as State) and `[x, T, q]` (Trace
Append), "order as the only difference". The project's older `xFirst` boolean moved the *question*, the one element
the paper fixes, and its name presented that as the paper's variable. **Renaming it to `questionPlacement: 'first' |
'last'` kept the mistake alive**: it left "the question's position is a variable" expressible, and `'first'` produced
`[T, q, x]`, which is **neither paper arm**. The axis was therefore deleted, and the argument is the same one §10
already makes about the paper's variable — the paper's variable is the placement of `T`, and a field whose other value
lays out a condition the paper does not have is not a variable.

### What happens to a profile that still spells an old key

`LEGACY_LAYOUT_KEYS` (`packages/core/src/config.ts`) reads and reports both retired spellings, and the split is the
code's rather than this file's: a spelling that asks for what every layout now does is a **warning** ("retired: … this
key is not a setting any more, and nothing was applied because nothing needed to be"), and a spelling that asks for
the question *first* is an **error**, because it asks for a layout the build cannot produce — the message quotes the
paper sentence above and names `tracePlacement` as what exists instead. The same split is enforced on the wire
(`/s1-tune` and its PUT route refuse the question-first spellings and note the question-last ones) and the settings
panel no longer offers a question control. Which keys, which values and which messages are the code's; nothing of that
is copied here.

### The evidence, from round `20261004-0233`'s own `layoutOrder` records

- **`C1` and `C2` recorded `["pinned","stateProxy","anchor","recalled","tail"]`** — the question second, a layout that
  is neither paper arm.
- **`C0` recorded `["pinned","recalled","tail","anchor"]`** — TAS off, the paper's baseline `M([x, q])`.

Those are data from that round, not configuration. The first string is not producible by any setting now, and the
orders the build does produce are the assembler header table's.

### The sentences this supersedes

1. §11's **What moved**, quoted here because this note is what deletes its middle clause: *"`AssemblyPolicy.xFirst:
   boolean` is now `questionPlacement: 'first' | 'last'` (default `'last'`), and
   `AssemblyPolicy.stateProxyPosition: 'before-context' | 'after-context'` is now `tracePlacement: 'trace-as-state' |
   'trace-append'` (default `'trace-as-state'`). The mapping is exact — `true` → `'first'`, `false` → `'last'`; …"* Only
   the `stateProxyPosition` half is a live mapping; `xFirst`'s successor lived a day and was deleted, and a
   question-first spelling is refused rather than translated.
2. §11's **"What moved"** said a profile that still sets an old spelling is "**translated rather than dropped or
   refused**". That holds for `stateProxyPosition` and for the question-last spellings of the deleted axis, which are
   applied or noted; it does **not** hold for the question-first spellings, which are refused with the sentence above.
   The authoritative split is `LEGACY_LAYOUT_KEYS`, not this section.
3. §11's item 2 (line 572 as it stood): *"the idea-1 knob is `questionPlacement`, `'last'` in every cell because that
   is the paper's fixed point, and **not** an arm."* It named a deleted field as a knob. The corrected reading is
   §11's own next sentence, which is unaffected: the question's position is not a knob and not an arm, and any
   document that glosses it as one is repeating the pre-2026-10-04 conflation.
4. §11's item 4 (line 588 as it stood): *"the field that moved the anchor is `questionPlacement`"*. The field that
   moved the anchor is deleted; `tracePlacement` moves `T`, and the anchor is last by construction.
5. §11's item 5 (line 593 as it stood): *"the layout fields are `AssemblyPolicy.questionPlacement` and
   `AssemblyPolicy.tracePlacement`"*. There is one layout field, `AssemblyPolicy.tracePlacement`.
6. §11's **"The live sentence corrected in place"**: *"It now names the layout fields (`tracePlacement`,
   `questionPlacement`)"*. The live sentence names one field, and §11's account of what it says is superseded by this
   one — the fact it records (the assembled order reaches the model in none) is unchanged.

**The superseded wording, verbatim — the live sentence's own wording as §11 left it:**

> names the layout fields (`tracePlacement`, `questionPlacement`) and says the *assembled order* reaches the model in
> none — the same fact, with the fields the build actually has.

### What this section does not correct, and why

- **§10 is a dated record and is left as written.** Its *"The second mismatch: `xFirst` moves the anchor, not `T`"*,
  its item 4 and its "What this does to the arms" bullet that reads *"x First on, Laya off"* all name the retired
  readers, and §10's own addendum plus §11 already supersede them on the registration. They are named here so a reader
  arriving at §10 is not left with the field names: **the axis does not exist, so no sentence in §10 can be read as
  describing a setting.**
- **The addendum's *"`xFirst` moves the anchor rather than `T`"*** (line 503) is the same kind of sentence inside a
  dated note. §11's item 4 quoted it and §12 supersedes the field name it was given there.

---

## 13. Dated correction (2026-10-05) — the recalled block moved behind the tail: a cache fix **inside `x`**, and no arm moved

Appended beside §10, §11 and §12 under `docs/DOC-CONTRACT.md` §4. **Nothing in §10, §11 or §12 is rewritten**: they are
dated records, and this section records what moved, why, and which of their sentences a reader should now read beside
it. §11's **Why** paragraph is the sentence the report names; it states the paper's variable and its two arms, that
statement stands, and what follows is what a reader of it needs beside it now.

### What moved

The recalled block now sits **immediately before the anchor**, behind the tail. It used to be third of five, with
`tail` and `anchor` behind it. The block order each `tracePlacement` value produces is the table in
`packages/core/src/assembler.ts`'s header, and `AssemblyLayout.order` (`packages/core/src/types.ts`) is the statement
of record for it; neither is restated as a rule here.

### Why the paper's two arms did not move with it

The variable is where the trace `T` sits relative to the long context `x` — the paper's two arms are `[T, x, q]`
(Trace as State) and `[x, T, q]` (Trace Append), order the only difference — and the recalled block is **part of that
long context**: `AssemblyLayout.order` reads the layout as `anchor` = `q`, the pinned prefix = not context, and the
blocks between them = the long context the trace is placed around
(`packages/dsh-plugin/src/context-delivery.ts`: "the long context here is the `recalled` block"). A block that moves
*inside* `x` therefore leaves `T`'s side of it untouched: `T` is still ahead of every block of `x` under
`'trace-as-state'` and behind all of them under `'trace-append'`. **No arm moved, and §11's two-arm sentence is not
superseded by this section.**

### Why the block moved — prefix caching, measured

A prompt cache is a prefix cache: a change at any token breaks the match from that token to the end of the prompt, so
everything placed behind a block that changes every step is invalidated with it. The recalled block is the block a
re-selection moves; ending `x` with it means a re-selection costs the question and nothing else. **Measured on round
`20261004-1458` C2**: the whole-prompt invalidation span per delivered pair fell from **2,539 to 2,111 tokens** with
this move, on top of the ordering change that had already cut it from **6,179 to 2,539**. `AssemblyResult.cacheStability`
computes the stable head from the laid-out order rather than assuming it, so it reads the new order with no change of
its own.

### The sentence this section leaves standing, and what it now needs beside it

§11's **Why** paragraph, as written: *"The paper (arXiv:2609.02702, §4.1) places the question **last in every
condition** … and its two arms are `[T, x, q]` (Trace as State) and `[x, T, q]` (Trace Append), **order the only
difference**."* It is right, and the section above says why the move did not disturb it. What it did not say is where
the recalled block sits inside `x`; the block order it leaves unstated is the assembler header table's.

### What is left as written

- **§10's dated record** — its layout sentences, including the line that reads `xFirst` as deciding *"whether the anchor
  `x` precedes or follows the recalled block"*, are that section's record of a field that no longer exists and are not
  edited here (§11 and §12 already supersede the field names).
- **§11's evidence bullets and §12's evidence block** — round `20261004-0233`'s own `layoutOrder` records. They are that
  round's data, they keep their wording, and the order they name is not producible by any setting now — which is the
  same statement `AssemblyLayout.order` makes about it.
- **§N6's checkbox** — what reaches the model today is still an insertion of the delivered block and nothing more; this
  move changes the order the assembler records and the cache arithmetic that follows from it, not what delivery sends.
