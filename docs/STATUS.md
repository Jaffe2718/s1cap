# S1CAP status — done, next, and how to take over

**Updated:** 2026-09-28 · **Audience:** a human skimming the checklist, and a coding agent that has to pick
the work up cold.

Read [`AGENT_BRIEF.md`](./AGENT_BRIEF.md) first: it carries the verified-facts base (§1) and the ground
rules this file assumes. Every claim below is either backed by a test in `packages/*/test/`, by a real DSH
round, or by the packaged DSH source read with `scripts/scan-dsh-asar.cjs`. Where something is *not*
verified, it says so instead of guessing.

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

- [ ] **N1** Source the system prompt so the pinned block is not empty
- [ ] **N2** Move association-graph upkeep onto the asynchronous lane (session-event driven)
- [ ] **N3** Replay-parity harness over a recorded tape (the gate before any prompt rewrite)
- [ ] **N4** Settings panel + Jev key through the credential service *(user decision: the key is typed by the user in a panel)*
- [ ] **N5** `llm_call` telemetry so cost and cache-hit rate become real numbers
- [ ] **N6** The actual context rewrite (`decision.messages`), feature-flagged per ablation cell

### Later

- [ ] **M2** harness-agnostic proxy (`packages/proxy`)
- [ ] **M3** benchmarks and the 2×2 ablation runs *(selection deliberately deferred — see `bench/README.md`)*

---

## 2. Done — the detail worth knowing

### D1. Naming and metadata

The acronym means **S1CAP = System-1 Context-Aware Planning** (`S1` = System-1, `C-A-P` = Context-Aware
Planning). The earlier expansion ("Selective Context and Adaptive Planning") was wrong and is retired
everywhere; `docs/AGENT_BRIEF.md` pins the correct one and forbids the old one. The two interventions are
**Context Awareness** (which segments the model sees) and **Plan Ordering** (the order its own plans run in).
Paper title: *S1CAP: Context-Aware Planning via System-1 Models for Efficient LLM Agents*. Public-facing
strings live in [`REPO_METADATA.md`](./REPO_METADATA.md); keep them in sync there.

### D2. Core algorithms (`packages/core`, 44 tests)

| Module | What it does | Notes for a maintainer |
|---|---|---|
| `segmenter.ts` | message-level segments (never token-level), chunk + overlap for oversized blocks | `estimateTokens()` is a dependency-free heuristic; the token meter later replaces the *estimates*, not the segmentation |
| `assoc-graph.ts` | weighted edges, `w·exp(−Δt/λ)` decay, bounded BFS recall, `tau/depth/fanout` | `addSegments()` is the only write path; recall is deterministic |
| `assembler.ts` | budgeted recall + Trace-as-State layout `[pinned \| T \| recalled \| tail \| x]` | `x` is always last; `recall.tier1 === 'off'` (cells C1/C2) yields an empty recalled block *by design* |
| `plan-gate.ts` | normalises System-1 choice scores, orders plans, caps attempts | S1CAP never vetoes; the gate only orders |
| `telemetry.ts` | telemetry schema v1 (frozen: **add, never rename**) | `AssemblyEvent`, `LlmCallEvent`, `S1CallEvent`, `ToolCallEvent`, `PlanGateEvent`; `summarizeTask()` produces the paper's metrics |
| `provenance.ts` | the four control-plane isolation invariants (I1–I4) | `assertSessionEvent`, `assertSessionSegments`, `ControlPlaneLog` — read this file before touching any log path |
| `cache-policy.ts` | break-even for re-selection: `ρ*(h)`, positional + amortised rule | the numbers in `docs/FORMULAS.md` §6 come from here |
| `config.ts` | fail-safe validation of every policy path | a typo must warn and keep the default, never break a session |

### D3. System-1 client (`packages/s1-client`, 13 tests)

One HTTP surface (`GET /health`, `POST /v1/systemone`) over a provider matrix (`jev | laya-serve | edgejev |
kev | none`). `resolveS1Backend()` plus `singleBackendIssues()` enforce **exactly one active backend**:
enabling the local Laya runtime while a cloud provider is selected is a configuration error, and the session
degrades to `provider=none` (observation only) rather than silently picking a governor. `redactKey()` is the
only way a key may be printed.

### D4. Laya runtime (`packages/laya-runtime`, 16 tests)

Discovers a Python environment by asking `conda env list --json` (never by string-joining paths), checks the
`laya` import and the `laya-serve` console script, launches the server with injected environment variables,
polls `/health` until ready, and buffers its stdout/stderr as diagnostics that never enter the session.
Verified on this machine with a real call: `noul 0.8693 / 0.9251`, 90 input tokens, 13.9 s cold start.
Machine specifics live in `docs/LAYA_RUNTIME.md` §5 (conda path, `HF_ENDPOINT`, `HF_HUB_DISABLE_XET`,
`LAYA_THREADS`).

### D5. Plugin shell (`packages/dsh-plugin`)

Loads and activates in a real DSH 0.1.7-rc.2 profile. Three facts were learned the hard way and are now
enforced in code and tests — read `docs/AGENT_BRIEF.md` §1.8 for the full post-mortem:

1. a bundle installed into a profile's `node_modules` cannot be TypeScript → ship `lib/*.js`
   (`scripts/build-packages.mjs`, zero dependencies);
2. `export const inject = ['commands']` — the **array** form; command names must match
   `/^[a-z][a-z0-9_-]*$/u` (no spaces);
3. `agent/pre-step` is a **waterfall middleware**: a handler must `await next()` and return that decision.
   An earlier stub returned `undefined` and killed a real round with
   `Cannot read properties of undefined (reading 'kind')`.

Safety envelope, all tested: the plugin is inert unless `enabled: true`; `apply()` is wrapped so activation
can never throw; only contracts read from the packaged source are registered.

### D6. Observation mode (M1 block 2)

`observation: log` (the default whenever the plugin is enabled) runs SEGMENTER → RECALL → ASSEMBLER on every
LLM call and appends one `assembly` record to the control-plane log. **The prompt the model receives is
returned untouched** — this milestone changes no tokens, which is what makes it safe on a live session.

Proof from a real headless round (`dsh --profile s1capobs "Reply with exactly: ok"`):

```json
{"type":"assembly","schema":1,"ts":1790601921689,
 "sessionId":"session-3c764164-2a23-4c1e-877f-44e4337fee5a",
 "seq":0,"candidates":0,"selected":0,"bfsDepth":0,
 "budgetUsed":6,"budgetTotal":118800,
 "blocks":{"pinned":0,"stateProxy":0,"recalled":0,"tail":0,"anchor":6},
 "prefixTokensStable":0,"fallback":"recency-window"}
```

Three findings from that round, all reflected in code: an absent state proxy was charged one token (fixed —
`assemble()` now charges 0 for an empty `T`); `AssemblyEvent` gained an optional `sessionId` (without it,
records from several sessions in one file cannot be attributed); and `blocks.pinned` was 0, which is **N1**.

---

## 3. Next — agent-ready detail

Every item below is self-contained: goal, why, where, what is already verified, the steps, the acceptance
test, and the traps. Do them in order; N1–N3 are all gating for N6.

### N1 — Source the system prompt for the pinned block

- **Goal:** `blocks.pinned > 0` and `prefixTokensStable === blocks.pinned` in a real round.
- **Why:** the pinned block is the system prompt plus tool schemas, and it is the cache-stable prefix. With it
  empty the budget accounting under-counts the fixed prefix and every cache assertion in `docs/FORMULAS.md` §6
  loses its anchor.
- **Evidence (verified):** in a real round the `agent/pre-step` payload's `messages` array carried no
  `role: 'system'` message. `dsh-llm` builds system prompts with `createSystemMessage(text)` →
  `{ role: 'system', content: [{ type: 'text', text }], source: { kind: 'system-prompt' } }`. Candidate
  surfaces, both present in the packaged inventory: `dsh-system-prompt`, `dsh-agent-instructions`.
- **Where:** `packages/core/src/observer.ts` (how `pinned` is derived), `packages/dsh-plugin/src/step-observer.ts`
  (where the payload is read).
- **Steps:**
  1. Read the real contract first — never guess:
     `node -e` the scanner: `& $app --expose-internals scripts/scan-dsh-asar.cjs --ls dsh-system-prompt\lib`
     then `--dump dsh-system-prompt\lib\index.js` (see `docs/AGENT_BRIEF.md` §1.8 for the invocation).
  2. Add an optional `systemPrompt?: string` input to `observeStep()` and build the pinned block from it
     (keeping any `systemPinned` messages from the payload). Do **not** let it become a recall candidate.
  3. Wire it in the plugin: prefer reading the service defensively (`ctx.get?.('…')` style) over adding a
     required `inject` entry — a required service that is missing leaves the plugin `pending` and it never
     activates.
  4. Add a unit test with an injected prompt; update `docs/CONTROL_PLANE_LOGGING.md` §6.
- **Acceptance:** unit test green; a real headless round shows `pinned > 0`, `prefixTokensStable === pinned`,
  and `budgetUsed` grown by roughly the prompt's token count.
- **Traps:** keep the record schema unchanged (no new required fields); never reorder the pinned block
  (cache alignment depends on byte stability); if the harness renders the prompt per call, hash it and log a
  warning when it changes mid-task.

### N2 — Asynchronous association-graph upkeep

- **Goal:** upkeep leaves the critical path. The per-call observation must never wait for scoring, and the
  graph may lag the session by at most `rgMaintenance.maxLagTurns`.
- **Why:** the per-call hook has a hard deadline (`assemblyDeadlineMs`). Anything unbounded inside it is a
  latency bug that also makes the measurements meaningless.
- **Today:** `observeStep()` calls `graph.addSegments(...)` synchronously — a documented stand-in
  (`packages/core/src/observer.ts`).
- **Evidence (verified):** the harness emits session events and the hook exists:
  `ctx.on("session/event", (session, event) => { if (event.type !== "step/end") return; … })` — read directly
  from `dsh-agent-instructions`' packaged source. Event types include `step/end`.
- **Where:** `packages/dsh-plugin/src/step-observer.ts` (subscribe + queue), `packages/core/src/observer.ts`
  (split into `observe(messages)` and `upkeep(segments)`), probably a new
  `packages/core/src/upkeep-queue.ts`.
- **Steps:** subscribe to `session/event`; enqueue new events; segment and `addSegments` on a deferred tick;
  keep the queue bounded (drop-oldest with a counter); track `lagTurns` and expose it in `/s1`; make
  `observe()` prove it does not drain the queue.
- **Acceptance:** unit test that calling `observe()` twice drains nothing; a real multi-step round where
  `upkeep.lag` stays within the bound and `candidates` grows across steps; `/s1` reports the counters.
- **Traps:** the queue must never throw into the harness; no System-1 network calls yet (scoring is still the
  local heuristic path — the association backend is a later item); keep the fallback (recency window) intact
  when the graph lags.

### N3 — Replay-parity harness over a recorded tape

- **Goal:** replaying a recorded session reproduces the `assembly` records field for field.
- **Why:** this is the gate before N6. Once the plugin may rewrite `decision.messages`, a non-reproducible
  pipeline means no result can be attributed to S1CAP rather than to noise.
- **Where:** new `scripts/replay-tape.mjs` + `packages/core/test/replay.test.ts`, plus a config switch that
  records the per-step payloads to a tape (content-bearing — off by default, and never commit a real tape).
- **Steps:** record `{ step, messages }` per call when the switch is on; replay through `observeStep` with the
  same injected `now`; compare records and `selectedIds` deeply; add a synthetic tape fixture to the repo (no
  real session content); assert the C1/C2 cells produce zero-selection records.
- **Acceptance:** two runs over one tape give byte-identical records; a changed policy produces a different but
  explained record; the synthetic fixture is committed and green in CI-equivalent runs.
- **Traps:** timestamps must be injected (they already are); the tape is session content — document the privacy
  implication where the switch is declared; keep the fixture small and synthetic.

### N4 — Settings panel and the Jev key

- **Goal:** the user types the key into a settings panel; it is stored by DSH's credential service and never
  appears in a log, a control-plane record, the repository or the transcript.
- **Why:** user decision (2026-09-28). Also the cleanest way to let the user switch provider / enable the
  plugin without editing YAML.
- **Evidence (verified inventory):** `dsh-credentials`, `dsh-credentials-local`, the settings shell
  `dsh-client-ui-settings*` (with `-plugin-inventory`, `-models`, `-general`, …), and
  `dsh-llm-deepseek-api-key` as the shipped "fill an API key in settings" precedent. `dsh-pet` ships a
  `lib/client.js` alongside `lib/index.js` — read its `package.json` to see how a client half is declared.
- **Steps:** read the credential + settings APIs from the packaged source; declare `s1.apiKey` as a secret
  config field; contribute a settings section from the client half; persist through the credential service;
  keep `s1.apiKey` / `TYPESAFE_API_KEY` / `S1CAP_API_KEY` as headless fallbacks; add tests that assert the key
  never reaches `describeS1Backend()`/logs.
- **Acceptance:** the key entered in the UI survives a restart; `grep` over the control log, session log and
  plugin output finds no key material; `/s1` shows it only through `redactKey()`.
- **Traps:** never write the key into a profile patch or the repo; a settings panel must not be the *only* way
  to configure a headless run; the client half must not echo the key back into the conversation.

### N5 — `llm_call` telemetry (real cost and cache numbers)

- **Goal:** the session-side stream carries per-call token usage so `summarizeTask()` reports real USD and a
  real `cacheHitRate`.
- **Why:** the paper's claim is "same solve rate, lower cost/latency"; today only the assembly side is
  recorded.
- **Evidence to gather:** where the harness exposes usage per call — read `dsh-llm` and `dsh-token-meter` from
  the packaged source (`--ls` then `--dump`). The `LlmCallEvent` fields are already frozen in
  `packages/core/src/telemetry.ts`.
- **Steps:** subscribe to the call boundary that carries usage; map it onto `LlmCallEvent`
  (`cacheHitTokens` / `cacheMissTokens` / `outputTokens` / `wallMs` / `approvalWaitMs`); write through the
  session-side sink; expose totals in `/s1`.
- **Acceptance:** after a real round `session.jsonl` has one `llm_call` record per model call whose token
  counts match the harness's own accounting, and `/s1` shows a plausible cost.
- **Traps:** never let a telemetry write change the call; keep the two files separate (I3/I4);
  `netLatencyMs` excludes approval waits by definition.

### N6 — The context rewrite (the intervention)

- **Goal:** `agent/pre-step` returns a decision whose `messages` are the assembled view, bounded by
  `assemblyDeadlineMs`, with the user-facing transcript untouched.
- **Why:** this is the actual product of the research; everything before it exists to make it safe.
- **Prerequisites:** N1 (a real pinned block), N2 (upkeep off the critical path), N3 (replay parity), and a
  green `authority.test.ts` (model-owned termination in every cell).
- **Steps:** gate the rewrite behind a per-cell flag (`cellPolicy()` already derives C1–C4); honour the
  deadline (on expiry return the untouched decision); record the rewrite in the control plane; assert that
  C1/C2 cells produce byte-identical decisions to the baseline.
- **Acceptance:** a replay tape shows a diff **only** inside the assembled blocks; a deliberately slowed
  pipeline returns the untouched decision; the C1 baseline diff is empty; the transcript projection is
  unchanged.
- **Traps:** `termination` stays a literal `'model-owned'` — no configuration may flip it; never rewrite the
  user-facing transcript; keep the pinned block byte-stable to protect the prefix cache; a rewrite that is not
  reproducible is a bug, not a measurement.

---

## 4. Rules for whoever takes over

1. **Never install into the `desktop` profile** (user decision): it carries other plugins and skills and must
   stay clean. Use a throwaway CLI profile for every experiment — `dsh --profile s1capobs --from-default-profile headless --dump-config`
   for automated rounds, `--from-default-profile web` for UI work — and delete it afterwards.
2. **Read contracts from the packaged source before coding against them.** `scripts/scan-dsh-asar.cjs`
   (`--ls`, `--dump <path> [lines]`, or bare needles) reads DSH's own code out of `app.asar` through
   Electron-as-Node. Guessing a hook contract once killed a live round.
3. **After any profile install, re-run `pnpm install` in the repository** — it can drop the workspace
   junctions the tests resolve `@s1cap/*` through.
4. **Ship JavaScript.** Profile installs live under `node_modules`, where Node refuses to strip TypeScript, so
   `main`/`exports` point at `lib/`; run `node scripts/build-packages.mjs` after touching any `src/`.
5. **Everything is English.** No Chinese in any repository file, including comments and fixtures.
6. **One System-1 backend at a time**, and S1CAP never owns termination.
7. **A half-built governor must never break the harness:** inert by default, `apply()` wrapped, only verified
   hook contracts registered, every optional surface failing soft with a warning.
8. **Measurement honesty:** a telemetry record is metadata only (ids, counts, timings). Session content never
   enters the control plane, and control-plane records never become segments.

## 5. Verify everything right now

```console
node scripts/build-packages.mjs                       # refresh lib/ (must match src/)
node --test --experimental-strip-types "packages/*/test/*.test.ts"
node scripts/check-diagram.mjs                        # diagram geometry
node scripts/build-route-svg.mjs --check              # committed SVGs match the HTML source
```

A real round, in a throwaway profile, with the observation log afterwards:

```console
dsh --profile s1capobs --from-default-profile headless --dump-config
dsh plugin --profile s1capobs add link:E:/Coding/TypeScript/system_one/s1cap/packages/dsh-plugin
Copy-Item packages/dsh-plugin/examples/profile.s1captest.cordis.patch.yml $env:USERPROFILE\.dsh\profiles\s1capobs\cordis.patch.yml
dsh --profile s1capobs "Reply with exactly: ok"
Get-Content $env:USERPROFILE\.dsh\.s1cap\control.jsonl
```
