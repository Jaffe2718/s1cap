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
does, restated in current terms, because `docs/CELLS-RUN.md`, `docs/AGENT_BRIEF.md` and `docs/PROPOSAL.md` cite it.
The cell-name banner below is current; the dated entries it describes are in the archive.

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
cells on the model's side is recall *selection* — the TAS ordering half (`tas.on`, `xFirst`) is recorded in every
cell and reaches the model in none. Writing the layout back is **a separate project** (🔜 in `ARCHITECTURE.md`).

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

## 8. The phase that runs now, restated in current terms

Short-turn token accounting was retired as a measurement on 2026-10-01 (owner decision), and the phase that replaced
it is a **test/optimize loop**: draw one long-horizon task at random from the pools `AGENT_BRIEF.md` §9.2 names, run
it under all three cells, optimize what the run exposes, draw again. The full record is in the archive.

- **One draw supports optimization, not a claim** — an iteration is complete only when the same task has run under
  all three cells, and a *claim* still needs the registered grid (`AGENT_BRIEF.md` §5–§6, `docs/FORMULAS.md` §8).
- **The draw must be auditable**: the round's record carries which task, from which pool and by what rule.
- **The loop, its draw rule and its metric set are the Collaborator's**, supervised with `GPT-6-Astra`.
- **The DSH version is resolved per round and recorded with the round**; the release this project supports is owned
  by `packages/dsh-plugin/package.json` → `dsh.compatibility.dshReleases`.
- **The two token accounts stay separate** — the System-1 lane's are Laya's, the LLM's are the LLM's — and the
  procedure is [`CELLS-RUN.md`](./CELLS-RUN.md) + `.s1cap-ablation/RUNBOOK.md`; the brief is `HANDOVER-DSH-TEST.txt`.
