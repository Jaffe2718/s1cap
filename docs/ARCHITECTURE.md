# S1CAP Architecture — Modules and Connections

Reference for the connections drawn in the route diagram
([`figures/s1cap-technical-route.html`](./figures/s1cap-technical-route.html) — hand-authored, and the single
geometry source). The committed SVGs
([`light`](./figures/s1cap-technical-route.light.svg) · [`dark`](./figures/s1cap-technical-route.dark.svg)) are
generated from it by `scripts/build-route-svg.mjs` and embedded in the README and in §1 below.

**Diagram maintenance — do not regress.** The flow is a loop with a hook: `Run + Verify` carries a self-loop
(`next LLM step · model continues`) and association-graph upkeep sits in its own asynchronous lane. Never
regenerate this figure with an automatic pipeline layout: an auto-laid-out serial chain misstates the design by
hiding both the inner loop and the async decoupling. `docs/figures/s1cap-technical-route.html` is the single
authoritative picture; the SVGs are generated from it and no second hand-drawn copy may be introduced.

Status legend: **✅ implemented** · **🟡 partially implemented** · **🔜 planned** · **◻ external**.
Milestone position: M0 complete; **M1 observation mode live and verified in real sessions** (per-call
SEGMENTER → RECALL → ASSEMBLER with the prompt untouched, the system prompt sourced so the pinned block and the
cache-stable prefix are non-zero, asynchronous upkeep fed by real `session/event` traffic, replay parity over a
recorded tape). Writing the assembled view back into the model context — and with it the settings panel that
holds the Jev key — is what remains. Evidence per item: [`STATUS.md`](./STATUS.md).

---

## 1. Diagram

Five layers, one row per layer, top to bottom. The picture above is the generated SVG; the arrow-level
topology — the inner loop's self-edge, the asynchronous tap and the advisory edge back into the loop — is in §2
below and in [`figures/s1cap-technical-route.html`](./figures/s1cap-technical-route.html).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./figures/s1cap-technical-route.dark.svg">
  <img alt="S1CAP technical route - five lanes: harness session (Run + Verify with an inner-loop self-edge, Stop - the model's own call), System-2 LLM step, S1CAP control (ASSEMBLER and PLAN GATE), asynchronous RG upkeep (Association Graph, RG Upkeep), System-1 backends" src="./figures/s1cap-technical-route.light.svg">
</picture>

## 2. Connections (edge semantics)

| # | From → To | Payload | Mechanism |
|---|---|---|---|
| e1 | Event intake → Segment / Recall | new session event | every append to the session log is segmented (message level) |
| e2 | Segment / Recall → S1 association backend | new segment × history segments | tier-1 candidate generation: batched `noul` questions, at most `s1.questionsPerCall` per call (the field's own bound is `packages/core/src/config.ts`) |
| e9 | S1 association backend → Association graph | edge weights + decay metadata | tier-2 verified edges are written into the RG |
| e3 | Association graph → ASSEMBLER | bounded recall set | `recall(seeds, {threshold, depth})`, then the greedy selection with its correctness filters — no token cap (`packages/core/src/assembler.ts`). **The signature lost its fifth option on 2026-10-05:** it read `recall(seeds, {threshold, depth, fanout})` and the per-node expansion cap `fanout` (`k`) is retired — never in the originating brief, in no wiring record and in no panel, and falsified by measurement (63.2 % of anchors reach the same set with and without it). The wording is quoted and the full correction is at the foot of `docs/FORMULAS.md` |
| e4 | ASSEMBLER → System-2 LLM | assembled prompt | Trace-as-State layout `[pinned \| T \| tail \| recalled \| x]`; model view only |
| e5 | System-2 LLM → S1 decision backend | candidate plans (m ≤ 3) | plans go **directly** to the decision backend for choice scoring |
| e10 | S1 decision backend → PLAN GATE *(design; **no run has carried it** since the policy field was removed on 2026-10-02)* | probabilities + confidence | gate consumes scores; it does not call System-1 itself |
| e7 | PLAN GATE → Run + verify *(design; see e10)* | ordered plan list | attempt controller: probability order, cap **M = 2** |
| e8 | Run + verify → Event intake | tool results | results re-enter as new session events (turn loop) |

## 3. Modules

| Module | Responsibility | Inputs | Outputs | Key parameters | Degradation | Status · code |
|---|---|---|---|---|---|---|
| **Event intake** | Harness adapter: turn session events into `RawEvent`; write the assembled context back to the **model view only** (user transcript stays chronological) | harness event stream (append-only log) | `RawEvent` → Segment / Recall; surface rewrite ops | — | plugin load failure → native harness behaviour | 🟡 adapter + observation live (M1) · `packages/core/src/harness-adapter.ts`, `packages/core/src/observer.ts`, `packages/dsh-plugin/src/control-log.ts` · 🔜 model-view write-back, `packages/proxy` |
| **Segment / Recall** | Split each event into **message-level** segments (never token-level); generate relevance candidates | `RawEvent` | `Segment[]`, candidate edge list | `chunkTokens=512`, `overlapTokens=64`; tier-1 = `s1` (one batched `noul` call — the implemented mode) or `off`; the per-call question ceiling is `s1.questionsPerCall`, whose **bound and default are the code's and are not restated here** (`packages/core/src/config.ts`; the server's own cap is `MAX_QUESTIONS` in the S1 backend) — see the 2026-10-05 update at the end | tier-1 unavailable → tier-0 metadata only | ✅ segmenter · `packages/core/src/segmenter.ts`; 🔜 tier-1 orchestration · 🔜 **embed mode — designed and NOT implemented** (no embedder, `source: 'embed'` never written; the literal is rejected by `validatePolicy`, `packages/core/src/config.ts`) |
| **S1 association backend** | Score relevance of new segment × history segments; produce the weights that expand the RG | segment pair batches | relevance probabilities | `noul` questions, batched; `timeoutMs=2500` | timeout → skip tier-2 for that turn; hard down → tier-0 + recency window | ✅ client · `packages/s1-client`; 🔜 orchestration |
| **Association graph (RG)** | Store segment nodes and weighted edges; answer bounded recalls | verified edges | nodes, edges, recall hits | `recall.threshold=0.55`, `recall.depth=16` (2 until 2026-10-05), decay `λ=30 min` — and **no per-node expansion cap**, since `fanout=8` in this cell was retired on 2026-10-05 (the values are `defaultPolicy()`'s and are not restated here) | thin recall → recency-window fallback | ✅ M0 · `packages/core/src/assoc-graph.ts` + asynchronous upkeep queue (`upkeep-queue.ts`, fed by real `session/event` traffic; in-memory, SQLite 🔜 M1) |
| **ASSEMBLER** | Decide what the model sees and in what order, under a token budget | RG recall hits, pinned prefix, tail, `x`, state proxy `T` | `AssemblyResult` (layout + budget accounting) | `B = contextWindow − reserveOutput − fixedOverhead` — an **accounting** budget, not a cap on the selection (no token ceiling bounds the recalled block; see the 2026-10-05 note at the end); `μ_seg=1` (segment-count floor — `μ=0` = off by default); `tail K=3`; `tMaxChars` (value owned by `packages/core/src/types.ts`, **not** restated here — see the 2026-10-04 update at the end); `updatePolicy=perTask` | fewer than `μ_seg` segments recalled, or recalled mass < `μ·remaining` when `μ>0` → `fallback: recency-window` | ✅ M0 · `packages/core/src/assembler.ts` · 🔜 **the assembled *order* reaching the model** — delivery inserts the `recalled` block only, so what the model sees today is decided by selection; the ordering is recorded until the model-view write-back exists (§5) |
| **System-2 LLM** | Governed host model: consumes the assembled context, emits reasoning and candidate plans, issues tool calls | assembled prompt | plans, tool calls | `deepseek-flash`, `reasoningEffort` pinned; no sampling parameter is set (DSH exposes none); swap check with GLM-5.3 | provider error → harness retry/compaction path | ◻ external |
| **S1 decision backend** | Score candidate plans once as a `choice` question; return probabilities + confidence | plan summaries (≤ 8 options) | `{choice, probabilities, confidence}` | one call per plan set; abstain confidence `0.5` | low confidence → gate abstains and keeps the model order | ✅ client + normalization · `packages/s1-client`; 🔜 wiring M2 |
| **PLAN GATE** *(kept, not wired)* | Consume scores; normalize, abstain, cap attempts, order execution | probabilities + confidence | `{order, probs, abstained}` — **produced by no cell, and by no run so far** | normalize `p̂ = p / Σp`; cap `M=2`; plans `m ≤ 3` | no scores or conf < 0.5 → keep model order | **not wired into any cell (2026-10-02)**, in the same style as §5's row: its only two triggers are a numbered plan in an assistant message and a `todo/write` session event, and round `20261002-2037` produced neither, so the gate wrote zero `plan_gate` records while C2 carried it `on`. The policy field, the presets and the report no longer offer it, and the plugin's wiring record no longer announces one; the mechanism is kept and unit-tested for whichever arm next has a real plan source. See `packages/core/src/types.ts` for the decision and `packages/dsh-plugin/test/plan-gate.test.ts` for the coverage |
| **Run + verify** | Execute plans in the gate's order; verify each with the benchmark-native oracle; drop the rest on success | ordered plan list | tool calls, verification verdicts, tool results | attempt cap from the gate; approval waits excluded from timing | verification fails and cap not reached → next plan | 🔜 M2 · harness tools + `bench/runners` |
| **Telemetry** | **Two separate append-only streams**: the session log (harness events — the only source of segments) and the control-plane log (LLM/S1/tool calls, assembly, gate decisions) | session events; call/assembly/gate records | `session.jsonl`, `control.jsonl`, task summaries | schema v1 (fields are add-only); prices per provider; control-plane isolation is enforced, not conventional (docs/CONTROL_PLANE_LOGGING.md) | S1 outage recorded as `degraded` flag per call; control records can never become segments | ✅ M0 · `packages/core/src/telemetry.ts`, `packages/core/src/provenance.ts`, live JSONL sink `packages/dsh-plugin/src/control-log.ts` (rotation, `DSH_HOME`-relative paths, never throws) · replay tape opt-in via `observation: tape` |
| **Laya runtime** | Finds the Python environment that can `import laya`, launches `laya-serve` (env-configured), health-checks `GET /health`, stops it again | interpreter candidates (config → conda envs → PATH → `py -0p`) | running local server + status/logs | `pythonPath`, `condaEnv`, `host/port`, `healthPath`, `startupTimeoutMs`, `env` (`LAYA_THREADS`, `LAYA_MODELS`, `HF_ENDPOINT`, `HF_HUB_DISABLE_XET`) | not ready → System-1 calls degrade to tier-0 + recency window | ✅ M0 · `packages/laya-runtime` |

## 4. The two System-1 intervention points

The acronym reads **S**ystem-**1** **C**ontext-**A**ware **P**lanning: a System-1 decision model makes the
agent's planning context-aware. It does that at exactly two points.

1. **Context Awareness** *(what the model sees)* — the association graph plus budgeted recall decides which segments make it in; `tracePlacement` decides **in what order**, and it is the only layout axis. It names which of the paper's two arms the recorded order is — Trace as State, the trace in front of the long context (`[pinned | T | tail | recalled | x]`), against its Trace Append control, the same trace behind the context (`packages/core/src/assembler.ts` carries the block order each value produces, and neither value is restated here). The question is not a second axis and not a setting: the paper holds it last in every condition, so `x` is the last block of every layout by construction. The user-facing transcript is never rewritten. **Which of those two the model actually receives today is a separate fact, and §5 states it**: the one live delivery channel inserts the selected turns and nothing else, so the *selection* is model-visible and the *ordering* is recorded-only until the model-view write-back exists.
2. **Plan Ordering** *(which order the model's own plans run in)* — the decision backend scores the candidate plans the model proposed; the gate orders them and caps attempts. Unexecuted alternatives are discarded on first verified success.

## 5. Ablation mapping (cells ↔ modules)

| Module | C0 baseline | C1 +TAS | C2 full |
|---|---|---|---|
| Event intake / Segment | on | on | on |
| S1 association + RG + recall | off | off | **on** |
| ASSEMBLER layout (`tas.on` + `tracePlacement`; per-cell values are owned by `bench/cells/*.json` and `cellPolicy()` and are not repeated here) | off (chronological) | **on, recorded** | **on, recorded** |
| Delivery (`deliver`: does the assembled view reach the model?) | off | off (its one channel is empty — see below) | **on** (the only delivering cell) |
| S1 decision + PLAN GATE | off | off | **not wired**: the plan gate is designed (§3) and unit-tested, but no cell runs it — round `20261002-2037` recorded no `plan_gate` event, so it was removed from the policy and the presets rather than left `on` and inert |
| System-1 lane (`s1.provider`) | `"none"` (no lane) | `"none"` (no lane) | live provider, `retryAttempts: 2`, `admissionLimit: 8` |
| Telemetry | on | on | on |

**Delivery is one inserted block, and the ordering is not in it.** `deliverContext`
(`packages/dsh-plugin/src/context-delivery.ts`) adds one message carrying the `recalled` turns; the state proxy `T`
is deliberately never sent, and nothing in the assembled layout is reordered for the model. So `tas.on` and the
placement axis (`tracePlacement`, the only layout field) decide what S1CAP *records* and what it would write into the
model view — they do not, today, decide what the model reads. `C1`'s row above is the sharpest case: its switches are on in the wiring and its `deliver` is off because
the only block delivery can insert is empty by construction when `recall.tier1: 'off'` (the whole recall path sits
behind one guard, `packages/core/src/assembler.ts`), so its model-visible input is `C0`'s. The registered contrast
is therefore `C0` vs `C2` (the round evidence is each round's own record under `.s1cap-ablation/round-<id>/`, and
`docs/CELLS-RUN.md` "The arms, and what the contrast is" carries the wording that reads it; `FORMULAS.md`
§6.1 says what it does and does not isolate).

### The model-view write-back — a separate project, and the prerequisite of any TAS measurement

The 🔜 in §3's Event-intake row (`model-view write-back, packages/proxy`) is not a detail of this ablation: it is
what makes the ordering half measurable at all. `packages/proxy` **does not exist** in this repository. Until it
does, every arm's model input is the harness's own message list plus, in `C2` only, one inserted `recalled` block.

A TAS arm becomes measurable when three things exist, and they are one project rather than three fixes:

1. **A channel that delivers a layout, not a block.** The write-back has to put the assembled order in front of the
   model — the pinned prefix, `T`, the tail, the recalled block and the question, in the order the policy chose
   (`packages/core/src/assembler.ts`'s header carries the table) — which is also the point at which the
   open question "may an authored state proxy `T` be delivered at all" has to be answered (`docs/STATUS.md` §N6
   settled the narrower version: the delivered block is quoted session content and `T` stays internal).
2. **An arm that differs from `C0` in that ordering alone** — otherwise the contrast carries selection and delivery
   with it, which is exactly the conflation the re-registration of `C1` removed.
3. **A way to see from the artifacts that the model read that order** — the payload identity and the per-step
   delivery record already exist (`context_delivery` with `payloadId`/`blocks`); a layout write-back needs the same
   kind of recorded proof, or the arm is a claim about code rather than about a run.

None of that is part of the `C1`/`C2` registration change of 2026-10-02, and none of it should be inferred from it.

Round `20261001-1300` ran four cells under an earlier labelling: `C1` (baseline) is today's **`C0`**, `C2` (read as
TAS alone then; a second control arm today, see §5) is today's **`C1`**, `C3` (recall selection with `tas.on: false`)
was **dropped, no successor**, and `C4` (the full configuration) is today's **`C2`**. The round-label mapping is the
table in `docs/AGENT_BRIEF.md` §5; the measured reason the fourth arm was dropped is in `bench/README.md`, over that
round's own tables (`.s1cap-ablation/round-20261001-1300/ROUND-REPORT.md`).

## 6. Loop, authority and asynchrony

The diagram is a **loop with a hook**, not a serial pipeline. Three properties are part of the design and
are enforced in code, not left to convention:

1. **One user turn is many LLM steps.** The model thinks, acts, calls tools and continues as long as it
   decides to. Consequently the ASSEMBLER runs **before every LLM call** (a per-call hook), not once per
   turn, and the `Run + verify → ASSEMBLER` edge is the live loop edge (`next LLM step · model continues`).
2. **Stopping belongs to the model.** The harness ends the turn when the model says so; `Stop · the model's
   own call` is a harness node that no S1CAP output can veto or delay. The two guarantees in code:
   `AssemblyPolicy.termination` is the literal type `'model-owned'` (there is no configuration that flips it),
   and `AttemptController` walks only the plans the model produced — it cannot invent a plan, cannot exceed
   the attempt cap, and `stop()` exists so the harness can register the model's decision without asking S1CAP.
   An empty plan list yields an empty order.
3. **Graph upkeep is asynchronous, and scoring is on demand (2026-10-05).** New session events are folded into the
   RG **off the critical path** (dashed edges `new events · async tap`); the System-1 pairs they need are bought
   when a step's recall asks for the row that holds them (`AssociationGraph.recallDemand`, wired at
   `packages/dsh-plugin/src/step-observer.ts`), one level of the walk at a time and backwards from the step's
   anchor, so a node with no neighbour above `tau` is never expanded and its neighbours' rows are never scored.
   Upkeep therefore still lags the session by up to `maxLagTurns` turns, but it no longer spends the lane:
   `rgMaintenance = { mode: 'async', maxLagTurns }`. The synchronous part is only the assembly read
   (`bounded recall`) plus the walk's first row, bounded by `recall.anchorWaitMs`.

Degradation is therefore total: if Laya/Jev is slow, absent or wrong, the turn continues on the native path
(tier-0 metadata + recency window), which is exactly the `C0` (baseline) behaviour the ablation compares against.

Cell presets: `bench/cells/C{0..2}.json`.

## Parameter: `recall.window` = w

| key | symbol | default | rule | what it does |
| --- | --- | --- | --- | --- |
| `recall.window` | w | `defaultPolicy().recall.window` (16) | integer 4..1048576 | how many predecessors one **row** is scored against — the row being one segment against its window, which is the unit a step's walk buys since scoring became on demand (2026-10-05). **It bounds the System-1 cost only once it is below the session's segment count** — while the session is shorter than `w`, `min(i, w) = i` and a row is the whole history |

The bounds are `NUMBER_RULES` entries in `packages/core/src/config.ts` (they read `integer >= 1` and `min 64` until
2026-10-05); the default and the cost it rests on are `packages/core/src/types.ts` and
`docs/FORMULAS.md` §"Recall window w", which is where the measurement lives rather than here.

Editable through `/s1-tune d r w` (e.g. `/s1-tune 3 0.7 512`) and through the S1CAP settings panel, which carries
the three knobs in one row: BFS depth d, relevance threshold r, scoring window w. Values persist in
`~/.dsh/.s1cap/tuning.json` and are applied to the live policy at session start; `/s1` reports
`tuning: { stored, effective }` with all three fields.

**Rejected alternative — scoring against the full history.** It looks more thorough and is worse on every axis
that matters: the per-segment System-1 cost grows without bound as a session ages, the marginal value collapses
because a segment from hundreds of turns ago is rarely related to what just arrived, and it makes the cost of a
long session unpredictable, which is exactly what the benchmark comparison (completion / cost / latency) must hold
constant. Scoring the whole history is therefore not an option that was overlooked; it is the baseline the window
is defined against.

**Also rejected, deliberately: "revival" scoring.** A segment outside the window is never re-scored later, even
when BFS happens to reach it. Reachability is unaffected (it keeps its edges and its place in the graph) — reached,
that is, from the newer endpoint of a pair, because the walk expands only into a segment earlier in the session's
append order (`packages/core/src/assoc-graph.ts`; the rule is `docs/FORMULAS.md` §3.2) — and w
exists solely to save System-1 calls — so re-scoring on a BFS hit would reintroduce exactly the unbounded cost the
window removes.

---

## Update 2026-10-04 — four rows of this document, corrected by dated append

Appended under `docs/DOC-CONTRACT.md` §4. **Nothing above this line is edited.** The decision these corrections
follow is `STATUS.md` §10; this section is the architecture-side statement of it, and it points at that section
rather than repeating it.

### 1. `tMaxChars=8000` in §3's ASSEMBLER row is a code-owned value and this table must not carry it

`tas.tMaxChars` is the owner's field — `AssemblyPolicy.tas` in `packages/core/src/types.ts`, resolved per cell
through `cellPolicy()` and the presets in `bench/cells/*.json`. **Its effective default is the paper's 50,000
characters**, not the 8,000 this table printed until 2026-10-04: arXiv:2609.02702's *Setup* bounds the serialized trace by
truncating "to the first 50,000 characters to keep the second-pass prompt within the model's context capacity", and
the port takes the paper's figure. The **direction** matters as much as the size — *first* — and that is what
`updatePolicy` means on the state-proxy side.

Read the number from the policy resolution, never from this row. The serializer itself, and what counts as the
trace, are `packages/core/src/state-proxy.ts`; neither is restated here.

### 2. §5's open question is re-worded: "may a state proxy `T` **reach the model** at all"

The question §5 carries — and `STATUS.md` §N6 cross-references — reads "may an **authored** state proxy `T` be
delivered at all". *Authored* was already the wrong word and is now flatly wrong: nothing in `T` is authored
prose any more. It is the model's own reasoning text, verbatim, in source order, inside fixed delimiters (§1 above
for the framing, `STATUS.md` §10 for the decision). A block of the model's own earlier output is a different
object from a block S1CAP wrote, and the objection that *authored* was carrying does not apply to it.

The question is therefore settled in the affirmative by `STATUS.md` §10: `T` **is** delivered. What is still open
is the mechanism — the model-view write-back this document calls a separate project — not the permission.

### 3. §5's "`T` is deliberately never sent" is still true, and it now costs the whole intervention

The sentence in §5's delivery paragraph is **not falsified and has not been rewritten**. What has changed is what
it costs. It was written when `T` was an extractive summary, so it withheld a summary; it is written in a codebase
whose `T` is the paper's serialized trace, so it withholds **the variable the paper's result is about**. The
paper's contrast is over the placement of `T` (26 of 27 reported combinations), so with `T` absent the registered
`C0`-vs-`C2` contrast cannot measure the mechanism at all. `STATUS.md` §10 carries that consequence; this
paragraph points at it.

The same applies to `§2`'s e4 row and to `§4`'s "the *ordering* is recorded-only": both remain accurate about what
reaches the model today, and neither becomes accurate about the paper until `T`'s position is an independent
variable. **`xFirst` is not that variable** — it moves the anchor `x`, and `stateProxy` sits at index 1 of the
layout in **every** branch (`packages/core/src/assembler.ts`). So today no configuration places `T` after the
context, i.e. **the paper's Trace-Append control is not expressible**, and the branch that coincides with
Trace-as-State ordering is the *non*-`xFirst` one. *(Both field names in this paragraph are retired: the layout axis
is `tracePlacement` and the second axis was **deleted**, not renamed — the 2026-10-05 (third) note at the foot of this
file names what moved, and `tracePlacement: 'trace-append'` is the paper's control.)*

### 4. The model-view row now carries a harness fact it did not have

§3's Event-intake row and `STATUS.md` §4's rule 3 both rest on DSH's reconstructability contract: the loop appends
to the session log and builds the request **from that log**, which is why a plugin can add context and cannot
remove any. That contract is now known to be **checked, opt-inly, by the harness itself**.
`@deepseek-ai/dsh-agent-loop` publishes an `invariant` companion that, when mounted, **fails** a loop-built
request whose messages do not equal the dispatch-time derivation from the log, naming it a
`"log-reconstruction desync"`; it is a separate companion export beside `@deepseek-ai/dsh-invariants`, not part of
the loop's default activation, and it does not appear in the bundle's row list.

**This document does not claim it is or is not mounted in a cell profile** — that has not been established, and a
dump is the wrong instrument for it. What it changes is the reading: if a round ever surfaces a desync failure, the
first question is whether that guard was mounted in the profile, not whether S1CAP violated the contract. Read the
shipped source with `scripts/scan-dsh-asar.cjs`; a round's own answer about its profile is its `kind:"wiring"` tape
record and the composed-config dump in step 2 of `.s1cap-ablation/RUNBOOK.md`.

---

## Update 2026-10-05 — one layout field was renamed and the second was **deleted**; §4/§5 corrected in place

Recorded per `docs/DOC-CONTRACT.md` §4. Three live statements in this document were corrected in place — the first
item of "The two System-1 intervention points", the layout row of "Ablation mapping (cells ↔ modules)" and that
section's delivery paragraph — and the superseded wording is carried here verbatim. **Nothing in the 2026-10-04 update above is rewritten** — what
that update says about the layout is corrected below, as a dated note on a dated note. **The axis this update calls
`questionPlacement` was deleted later the same day**; the correction at the foot of this file records that, and quotes
this paragraph's field mapping as superseded. What stands here is the rename of the state proxy's own field and the
reason both changes were made.

**What moved.** `AssemblyPolicy.xFirst: boolean` is gone from the tree: it was renamed to
`questionPlacement: 'first' | 'last'` and then **deleted** the same day (see the third note at the foot of this file;
the field mapping this paragraph used to carry is quoted there as superseded). `AssemblyPolicy.stateProxyPosition:
'before-context' | 'after-context'` is now `tracePlacement: 'trace-as-state' | 'trace-append'` (default
`'trace-as-state'`), the **only** layout axis. A profile that still spells an old key is read and reported
(`LEGACY_LAYOUT_KEYS`, `packages/core/src/config.ts`); which spellings are warned about and which are refused is that
table's, not this section's. Field names,
values and defaults are owned by `packages/core/src/types.ts`, `packages/core/src/config.ts` and the presets; this
section restates none of them beyond the mapping that makes the correction readable.

**Why.** The paper (arXiv:2609.02702, section 4.1) places the question **last in every condition** — "the question appears at
the end of the prompt … place it at the end of every input" — and its two arms are `[T, x, q]` (Trace as State) and
`[x, T, q]` (Trace Append), **order the only difference**. `xFirst` moved the *question*, the one element the paper
fixes, and its name presented that as the paper's variable; `stateProxyPosition` was already the paper's axis, so it
took the paper's names.

**What it cost, measured — round `20261004-0233`'s own `layoutOrder` records.** The two TAS cells (`C1`, `C2`) recorded
`pinned, stateProxy, anchor, recalled, tail`: the question second, a layout that is neither paper arm, because both
set `xFirst: true`. `C0` (`xFirst: false`, TAS off) recorded `pinned, recalled, tail, anchor`, the paper's baseline
`M([x, q])`. With the question where the paper holds it, the first of those strings is no longer producible by any
setting and `tracePlacement` alone selects between the paper's two arms.

**Superseded wording, verbatim.**

1. §4, item 1 — *"Trace-as-State ordering decides **in what order** (`[pinned | T | recalled | tail | x]`; `xFirst`
   puts `x` first, `[pinned | T | x | recalled | tail]`)"* — the trace's position is now a named field with the
   paper's two values, and the question's position is not the axis.
2. §5's ablation table — *"ASSEMBLER layout (`tas.on` + `xFirst`) | off / off (chronological) | **on / on, recorded**
   | **on / on, recorded**"* — the pair of booleans is one field now, so the row names `tas.on` + `tracePlacement` and
   points at the presets and `cellPolicy()` for the per-cell values, which are code-owned.
3. §5's delivery paragraph — "So `tas.on`/`xFirst` decide what S1CAP *records* and what it would write into the model
   view" — now "`tas.on` and the two layout fields", because the question's position is recorded as well.
   *(Superseded the same day: the question's position is not a field and is not recorded as one — the axis was
   deleted, so only `tracePlacement` can be varied and the delivery paragraph reads "`tas.on` and the placement
   axis".)*

**Two claims in the 2026-10-04 update above are superseded, and this note is where that is recorded.**

- Item 3's *"**`xFirst` is not that variable** — it moves the anchor `x` … So today no configuration places `T` after
  the context, i.e. **the paper's Trace-Append control is not expressible**, and the branch that coincides with
  Trace-as-State ordering is the *non*-`xFirst` one."* The first half was right about `xFirst` and the second half is
  no longer true of the build: `tracePlacement: 'trace-append'` **is** the paper's Trace-Append control, it is
  enforced (`assemble()` branches on it), its value is recorded on every assembly, and a profile can set it. What
  remains true is the narrower fact item 3 was really about: no cell preset carries it, so no *arm* has
  delivered a layout, and the delivered text still appends (`packages/dsh-plugin/src/context-delivery.ts`).
- Item 3's *"§5's '`T` is deliberately never sent' is still true"* — superseded later the same day by the delivery
  change: `tas.on` now implies `T` is delivered (`packages/dsh-plugin/src/context-delivery.ts`, and the comment above
  `cellPolicy()` in `packages/core/src/types.ts`), so the delivered text is `T` followed by the recalled turns in
  every delivering cell. The sentence itself is **not edited here**; it and §5's delivery table row are called out
  under "outstanding" below.

**Outstanding, and not part of this rename.** §5's delivery row (*"off (its one channel is empty — see below)"* for
`C1`, *"on (the only delivering cell)"* for `C2`) and the same paragraph's `C1` sentences (*"its `deliver` is off
because the only block delivery can insert is empty by construction when `recall.tier1: 'off'` … so its model-visible
input is `C0`'s"*, and the registered contrast being `C0` vs `C2`) state the registration that was superseded on
2026-10-04: `cellPolicy('C1')` sets `deliver: true`, the registered contrasts are `C0 → C1` and `C1 → C2`, and
`docs/CELLS-RUN.md` "The arms, and what the contrast is" carries the current wording. That is a separate correction
with its own evidence, and it is reported rather than folded into this one.

---

## Update 2026-10-05 (second) — the recall token cap was retired, and §3's ASSEMBLER row carried its value

Recorded per `docs/DOC-CONTRACT.md` §4, beside the update above and not in place of it. §3's ASSEMBLER row is a live
table entry, so its two stale clauses were corrected in place; the superseded wording is carried here verbatim.

**What moved.** The `recall` block's `budgetRatio` (ρ, default 0.35) is **gone from the policy**, and with it the only
token ceiling that bounded the recalled block. `recall.depth` (d), `recall.threshold` (r) and `recall.window` (w) are
the tunable recall parameters; what the selector drops beyond r and d is a set of **correctness filters** (structural
exclusions, the anchor's sibling chunks, passage chunk de-duplication) rather than a budget. The full statement — the
brief's three parameters, the T/recall coupling the cap created, the harness's own compaction as where overflow
belongs, and the measurement — is the 2026-10-05 correction in `docs/FORMULAS.md`, which this note points at rather
than repeats. The decision itself is `AssemblyPolicy.recall` in `packages/core/src/types.ts`.

**Why this row had to move with it.** It printed `ρ=0.35`, which is a value the code owned (§2 of the contract: a
synchronised copy, not a pointer) and which the policy no longer has at all. Its fallback cell also described the
token-share floor as a share of `μ·budget`; the share is taken of `remaining` — the room the window has left after the
fixed blocks — because the allowance it used to be a share *of* went with the cap
(`used < policy.recall.minRecalledShare * remaining`, `packages/core/src/assembler.ts`). Both are now stated without a
number.

**Measured, so the row's loss is not a claim about a run.** Round `20261004-0233`, cell C2: the cap never bound —
`budgetUsed` peaked at 6 399 against a `budgetTotal` of 118 800 (5.4 % of the budget, 9.2 % of the 41 580 the ratio
allowed). No recorded step changes.

**The superseded wording, verbatim.** *"`B = contextWindow − reserveOutput − fixedOverhead`; `ρ=0.35`; `μ_seg=1`
(segment-count floor — `μ=0` = off by default) …"* and, in the degradation cell, *"recalled mass < `μ·budget` when
`μ>0`"*. The row now says `B` is an accounting budget, names no ratio, and writes the floor's share as `μ·remaining`.

**No file in the tree writes the key any more.** The three presets were swept in the same change, and
`packages/dsh-plugin/cordis.patch.yml` deleted the line on the same day — what stands where it was is a comment saying
why, so a reader of that profile patch cannot mistake the absence for an oversight. The reason the line was *deleted*
rather than left is the silent-ignore path: `validatePolicy` reports unknown keys only at the **top level**, so a
stale profile outside this tree that still writes `budgetRatio` inside `recall` is accepted and ignored with no
warning on `/s1` and nothing on the assembly record.

---

## Update 2026-10-05 (third) — the question axis was **deleted**, so `tracePlacement` is the only layout field

Recorded per `docs/DOC-CONTRACT.md` §4, at the foot of the two updates above and in place of neither. The two live
statements that still counted the layout surface as a **pair** were corrected in place — the first item of the
2026-10-05 update and that update's delivery paragraph in the ablation mapping — and the superseded wording is carried
below. Everything in an update above is a dated record and is quoted rather than rewritten.

**What moved — a deletion, not a rename.** `AssemblyPolicy.questionPlacement: 'first' | 'last'` is **gone from the
tree**. **`AssemblyPolicy.tracePlacement: 'trace-as-state' | 'trace-append'` is the only layout axis**, and the
question `q` is **last by construction in every layout**: `assemble()` appends the anchor unconditionally,
`layoutStableTokens` no longer adds the question's tokens, and `cutAfterBlock` has no `'anchor'` branch. What the two
arms are, and the block order each `tracePlacement` value produces, are the table in
`packages/core/src/assembler.ts`'s header and are not restated here.

**Why the axis was deleted rather than renamed.** The paper's section 4.1 (arXiv:2609.02702) places the question last in *every*
condition — "Models may not behave as intended unless the question appears at the end of the prompt. We therefore
separate the question from the long context and place it at the end of every input" — and its two arms are `[T, x, q]`
(Trace as State) and `[x, T, q]` (Trace Append), "order as the only difference". This project's older `xFirst` boolean
moved the *question*, the one element the paper fixes, and its name presented that as the paper's variable. Renaming
it to `questionPlacement` kept the mistake alive: it left "the question's position is a variable" expressible, and
`'first'` produced `[T, q, x]`, which is **neither paper arm**. So the field was removed rather than labelled.

**What happens to a profile that still spells an old key.** `LEGACY_LAYOUT_KEYS`
(`packages/core/src/config.ts`) reads `xFirst` and `questionPlacement` and reports them: the spellings that ask for
what every layout now does are a **warning** ("retired: … nothing was applied because nothing needed to be"), and the
spellings that ask for the question first are refused with an **error** that quotes the paper sentence and names
`tracePlacement`. The same split is enforced on the wire and in the panel, and the panel no longer offers a question
control. Which keys and which outcomes are the code's and are not copied here.

**The evidence, from round `20261004-0233`'s own `layoutOrder` records.** `C0`
`["pinned","recalled","tail","anchor"]`; `C1` and `C2` `["pinned","stateProxy","anchor","recalled","tail"]` — the
question second in the two TAS cells, which is neither paper arm.

**Superseded wording, verbatim.**

1. The 2026-10-05 update's *"What moved"*, quoted here because this note is what deletes its middle clause:
   *"`AssemblyPolicy.xFirst: boolean` is now `questionPlacement: 'first' | 'last'` (default `'last'`), and
   `AssemblyPolicy.stateProxyPosition: 'before-context' | 'after-context'` is now
   `tracePlacement: 'trace-as-state' | 'trace-append'` (default `'trace-as-state'`). The mapping is exact — `true` →
   `'first'`, `false` → `'last'`; `'before-context'` → `'trace-as-state'`, `'after-context'` → `'trace-append'` — and a
   profile that still sets an old spelling is translated rather than silently run as the default"*. Only the
   `stateProxyPosition` half is a live mapping; `xFirst` was not renamed *to* a surviving field but deleted after a
   day under the name `questionPlacement`, and a question-first spelling is refused rather than translated.
2. §4, item 1, as this document carried it after that update: *"the layout fields decide **in what order**. …
   and `questionPlacement` is **not** the arm: the paper holds the question last in every condition, so no cell moves
   it"*. The conclusion was right and the field was not: the question is last because nothing can move it, not because
   every cell declined to.
3. §5's delivery paragraph, as that update rewrote it: *"`tas.on` and the two layout fields decide what S1CAP
   *records*"*. There is one layout field.

**What this document does not carry, and is not corrected here.** §5's delivery row and the same paragraph's `C1`
sentences (*"its `deliver` is off because the only block delivery can insert is empty by construction"*, *"so its
model-visible input is `C0`'s"*, and the registered contrast being `C0` vs `C2`) state the pre-2026-10-04
registration; that is a separate correction with its own evidence and is reported by the updates above rather than
folded into this one. §5's *"the state proxy `T` is deliberately never sent"* is the same kind of item: the delivery
change made `tas.on` imply `T` is delivered, and the sentence is left as written.

---

## Update 2026-10-05 (fourth) — the per-call question cap: two rows said **20**, which is the default and not the bound

Recorded per `docs/DOC-CONTRACT.md` §4, at the foot of the three updates above and in place of none of them. The two
live table rows that stated the cap were corrected in place, and the superseded wording is carried below verbatim.
**No number replaced them.** §2 of the contract is the reason: the bound and the default of `s1.questionsPerCall` are
values the code owns, so the row points at the source of truth and states none of them — a correction that swapped
`20` for `64` would be the same defect with a newer number in it, and would be stale again the next time the rule
moves.

**What moved.** The per-call question ceiling is `s1.questionsPerCall`, whose range is a `NUMBER_RULES` entry in
`packages/core/src/config.ts`; the S1 backend's own ceiling is `MAX_QUESTIONS` in the server. **The two agree**, and
that agreement is the fact a reader wants from this row. The `20` both rows printed is the *default*
(`defaultPolicy()`), not the bound — so a cell, a tuning file or a settings panel that raised the field above 20 was
being described by a row that said it could not exist.

**Why this is worth a dated note rather than a silent edit.** The two numbers are one keystroke apart and both appear
in the tree, so the row read as correct to anyone who had seen the default. The failure mode it produced is the one
§2 names: a document stating a value the code owns, believed over the code. It also had a measurement consequence —
the per-call size distribution of round `20261004-0233` (371 of its 634 `noul` calls at exactly 20 questions) cannot
be read against the row as it stood, because the row implied 20 was forced rather than chosen.

**The superseded wording, verbatim.**

1. §2's edge table, row `e2` — *"tier-1 candidate generation: batched `noul` questions, ≤ 20 per call"*. It now names
   the field and points at `packages/core/src/config.ts` for the bound.
2. §3's **Segment / Recall** row — *"… or `off`; `questionsPerCall ≤ 20`"*. It now names `s1.questionsPerCall` as the
   ceiling, says in the row that its bound and default are the code's, and points at `packages/core/src/config.ts`
   and at the server's `MAX_QUESTIONS`.

**What this note does not touch.** The round `20261001-1300` figures the neighbouring prose quotes (the 1 155 calls
that 22 791 pairs at a cap of 20 imply) are that round's record and are left as written; what a pair count does and
does not predict about a run's call count is `docs/FORMULAS.md`'s 2026-10-05 correction, which is pointed at rather
than repeated here.

---

## Update 2026-10-05 (fifth) — the BFS walks backwards only, and "Parameter: `recall.window` = w" said "reached" without saying from where

Recorded per `docs/DOC-CONTRACT.md` §4, at the foot of the four updates above and in place of none of them. The
sentence is a live statement about the current walk, so the direction clause was **added in place** and the sentence
as it stood is quoted verbatim below. Nothing else in this document changes: §2's `e3` row states the recall
signature and the direction is not an option, a field or a knob — and every sentence about the *stored* relation is
still right, because `neighbors()` is still symmetric and `upsertEdge` still indexes an edge in both directions.

**One clause of the paragraph below was overtaken later the same day (2026-10-05).** It read: *"§2's `e3` row still
states `recall(seeds, {threshold, depth, fanout})` and that signature is unchanged"*. The direction clause did not
change the signature — that much held — but the per-node expansion cap in it was **retired** hours later, so the row
now states `recall(seeds, {threshold, depth})`. The correction, its measurement and its cost are at the foot of
`docs/FORMULAS.md`; the `e3` row above carries the same pointer.

**What moved.** `AssociationGraph.recall()` expands only into segments **earlier in the session's append order**
(`packages/core/src/assoc-graph.ts`: `isBackwardStep`, and the position index `#at` that `unjudgedWithin` reads too).
A neighbour the append order does not place is not expanded into.

**Why this section's sentence needed the clause.** "Reachability is unaffected" is a claim about `w` — `w` removes
no edge — and it stays true. What it did not say is the direction of the walk that uses the edge, and a reader who
supplies the missing half from the stored relation (one score per pair, indexed in both directions) gets the
opposite of the rule: an older segment recalling a newer one. The rule, its measurement and its own correction are
`docs/FORMULAS.md` §3.2 and the 2026-10-05 correction at the foot of that document; the same clause was added to the
matching sentence in `docs/FORMULAS.md`'s "Recall window w" section and in `docs/AGENT_BRIEF.md` §3.2, each quoted
where it lives.

**The superseded wording, verbatim.**

> Reachability is unaffected (it keeps its edges and its place in the graph), and w exists solely to save System-1
> calls — so re-scoring on a BFS hit would reintroduce exactly the unbounded cost the window removes.

---

## Update 2026-10-05 (sixth) — the recall defaults are `w = 16`, `d = 16`, and this document's own parameter row carried the old pair

Recorded per `docs/DOC-CONTRACT.md` §4, at the foot of the five updates above and in place of none of them. The
parameter row and §3's RG row are live table entries, so both were corrected in place; the superseded wording is
carried here verbatim, and the reasoning and the measurement are `docs/FORMULAS.md`'s
2026-10-05 correction (eighth), which this update points at rather than repeating.

**What moved.** `defaultPolicy().recall.window` is **16** (was 1024) and `defaultPolicy().recall.depth` is **16**
(was 2) since 2026-10-05 (`packages/core/src/types.ts`). The two validator bounds moved with them: `recall.window`
`min 64` → **`min 4`**, and `recall.depth` 1..6 → 1..**16** (`packages/core/src/config.ts`, `NUMBER_RULES`). The
reason in one sentence: **the window bounds System-1 scoring only once it is below the session's segment count**, and
at 1024 it was above every session this project has run — so on round `20261004-1239` (228 segments, 16.1
questions/s) it offered the full 25,878-pair triangle and needed 26.7 min of lane to serve a 6.2 min session, 4.3×
its budget, which is why that round's walk returned `candidates = 0` from invocation 9 onward. The depth is where the
reach `w × d` is bought back (256 now against 2,048 before), and raising it cost the scoring axis nothing **while
scoring was eager**, because `sum min(i, w)` contains no `d`. **That last clause stopped being true the same day**:
scoring is on demand, so a walk that reaches more nodes demands more rows, and `d` is billed on the scoring axis like
every other reach parameter — the rows and pairs per depth on round `20261004-1458`'s frozen graph are in
`AssemblyPolicy.recall.depth` (`packages/core/src/types.ts`) and in the correction at the foot of
`docs/FORMULAS.md`.

**The superseded wording, verbatim.**

> | `recall.window` | w | 1024 | integer >= 1 | how many of the most recent segments a newly arrived segment is scored against |

The row now writes the default as a pointer at `defaultPolicy()` with the current value in parentheses, states the
rule as `integer 4..1048576`, and says in the "what it does" cell that the window bounds the cost only below the
session's segment count. The same pass corrected §3's **Association graph (RG)** row, which read *"`recall.threshold=0.55`, `depth=2`, decay `λ=30 min` — and **no per-node expansion cap**, since `fanout=8` in this cell was retired on 2026-10-05 (the value is `cellPolicy()`'s and is not restated here)"*: it now reads `recall.depth=16` with `(2 until 2026-10-05)` beside it and says the values are `defaultPolicy()`'s. **Neither correction changes what any recorded round ran** — a round's own `kind:"wiring"` record remains the authority (`docs/DOC-CONTRACT.md` §3), rounds `20261004-0233`, `1211`, `1239` and earlier recorded `w = 1024, d = 2` and stay readable and unedited, and no round directory is written by this change.

---

## Update 2026-10-05 (seventh) — the recalled block moved behind the tail: a cache fix **inside `x`**, and the paper's arm is unchanged

Recorded per `docs/DOC-CONTRACT.md` §4, at the foot of the six updates above and in place of none of them.
Three live sentences carried the old order — §2's `e4` row, §4's item 1 and §5's write-back item — so all three were
corrected in place and the superseded wording is carried below verbatim. Nothing else changes: what a round recorded is
that round's own record and is left as written.

**What moved.** The recalled block now sits **immediately before the anchor**, behind the tail. It used to be third of
five, with `tail` and `anchor` behind it. The block order each `tracePlacement` value produces is the table in
`packages/core/src/assembler.ts`'s header, and `AssemblyLayout.order` (`packages/core/src/types.ts`) is the statement
of record; neither is restated as a rule here.

**This is inside the paper's `x`, not the paper's variable.** The variable is where the trace `T` sits relative to the
long context `x` — the two arms are `[T, x, q]` and `[x, T, q]`, order the only difference — and the recalled block is
part of that long context, which is the reading `AssemblyLayout.order` states: `anchor` **is** `q`, and the blocks
between the pinned prefix and it — `tail` and `recalled` — are the long context the trace is placed around
(`packages/dsh-plugin/src/context-delivery.ts`: "the long context here is the `recalled` block"). So a block that moves
*inside* `x` leaves `T`'s side of `x` untouched: `T` is still ahead of every block of `x` under `'trace-as-state'` and
behind all of them under `'trace-append'`, and **no arm moved**.

**Why the block moved — prefix caching.** A prompt cache is a prefix cache: a change at any token breaks the match
from that token to the end of the prompt, so anything placed behind a block that changes every step is invalidated with
it. The recalled block is the block a re-selection moves; ending `x` with it means a re-selection costs the question
and nothing else. **Measured on round `20261004-1458` C2**: the whole-prompt invalidation span per delivered pair fell
from **2,539 to 2,111 tokens** with this move, on top of the ordering change that had already cut it from **6,179 to
2,539**. The arithmetic the assembler computes from the laid-out order is `cacheStability`, which did not change.

**The superseded wording, verbatim.**

1. §2's `e4` row — *"Trace-as-State layout `[pinned | T | recalled | tail | x]`; model view only"*. It now reads
   `[pinned | T | tail | recalled | x]`.
2. §4, item 1 — *"Trace as State, the trace in front of the long context (`[pinned | T | recalled | tail | x]`), against
   its Trace Append control"*. The literal now reads `[pinned | T | tail | recalled | x]`.
3. §5's write-back item — *"pinned / `T` / `x` / recalled / tail in the order the policy chose"*. It now names the
   blocks and points at the assembler's header table, because the enumeration was the old order and a second copy of a
   code-owned order is the defect `docs/DOC-CONTRACT.md` §2 names.


