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

- [x] **N1** System prompt sourced: the pinned block and the cache-stable prefix are non-zero (evidence below)
- [x] **N2** Association-graph upkeep on the asynchronous lane (createUpkeepQueue, session/event subscription, lag bound, /s1 stats)
- [x] **N3** Replay-parity harness (packages/core/src/replay.ts, synthetic fixture, scripts/replay-tape.mjs, observation: tape recorder)
  - **Round 2 evidence (real session, tape mode):** the tape recorder was verified end to end. A real round
    wrote exactly one step line:
    `{"schema":1,"sessionId":"live","step":1,"messages":[{"content":[{"type":"text","text":"Reply with exactly: ok"}],"source":{"kind":"user"},"role":"user","id":"7845ba95-…"}]}`
    which independently confirms two things: the recorder captures the offered messages in the verified DSH
    vocabulary (`role` + parts tagged `type` + `source.kind`), and **step 1's message list carries no system
    prompt at all** — so N1's source really is the `systemPrompt` service and nothing else.
  - **Round 2 bug to fix first:** the runtime probe that was meant to introspect that service never wrote a
    line, because the probe block sits *before* `observer` is assigned and its own failure path also throws.
    Move the probe inside the `if (resolved.observation !== 'off')` branch (or write straight to `probeSink`
    instead of through the observer), then re-run one tape round and read the
    `{"schema":0,"kind":"service-probe"}` line to get the service's real method names.
  - **Round 3 (runtime introspection, real round):** the service is reachable **without touching `inject`** —
    `ctx.get('systemPrompt')` returns it (verified: `service: "object"`). Its own methods are
    `section`, `getSectionOrder`, `getContextOrder`, `context`, `suppressRuntimeContext`, `tools`, `variable`
    and **`assemble`** — no `render`. Calling `assemble()` with no arguments returns an object with **no
    enumerable own keys** and no `text`/`prompt` field, so either it needs arguments/scoping or the text sits
    behind getters. **Next action (precise):** dump the `assemble(` definition out of the packaged source
    (`& $app --expose-internals scripts/scan-dsh-asar.cjs --dump dsh-system-prompt\lib\index.js 366` and read
    around it) to learn its arguments; then either call it with those arguments, or add
    `@deepseek-ai/dsh-system-prompt` as a plugin dependency and render with the package's exported
    `renderPrompt(assembly)`. Acceptance stays: a real round shows `blocks.pinned > 0` and
    `prefixTokensStable === blocks.pinned`.
  - **Probe artefact:** the two probes (`service-probe`, `session-event-probe`) are written only in
    `observation: tape` mode and are bounded (service probe once, event probe for the first three events).
    They are what produced the facts above; remove them once N1 and N2's event mapping no longer need them.
  - **Round 4 notes (both are process findings, recorded so the next attempt is cheaper):**
    1. Filtering the dump in the pipeline (`... --dump … | Select-String 'assemble\s*\(' -Context`) returned
       nothing even though `assemble` is demonstrably a method at runtime. Read the dump **unfiltered** in
       page-sized chunks (`--dump dsh-system-prompt\lib\index.js 366` with a line window), or add a `--grep`
       mode to `scripts/scan-dsh-asar.cjs` first — do not conclude "the symbol is absent" from a filtered read.
    2. **N2 risk found:** the plugin subscribes `session/event` on the **root** context, and no
       `session-event-probe` line was ever written, which suggests session events are emitted in a
       *session/agent scope* rather than at the root. Verify before trusting the asynchronous lane: subscribe
       the way `dsh-agent-instructions` does (it registers on an agent-scoped context) or move the
       subscription into a scope that actually receives the events. Acceptance for N2 therefore becomes: a
       real round shows `upkeep.enqueued > 0` in `/s1` (today it stays 0), with the lag bound respected.
  - **Round 4 signature (read from the packaged source with the scanner's new `--grep`):**

    ```js
    /** @param context - the optional scope and plugin-defined assembly fields.
     *  @returns the post-waterfall assembly with any complete prompt enforced. */
    async assemble(context = {}) { … }
    ```

    So `assemble` is **async** and takes `{ scope, … }`; it returns the *assembly*, not text — the package's
    exported `renderPrompt(assembly)` turns it into the prompt string. This also explains the round-3 probe:
    it called `assemble()` synchronously and inspected a **Promise** (`Object.keys(promise)` is `[]`), which is
    why the assembly looked empty. **Next action:** `const assembly = await ctx.get('systemPrompt').assemble({});`
    then render it (add `@deepseek-ai/dsh-system-prompt` as a plugin dependency and call its `renderPrompt`, or
    reproduce the join from the assembly's section list — never guess the string shape). Feed the result into
    `observer.setSystemPrompt(text)` **before** the first observation (or refresh it when its hash changes).
    Acceptance: `blocks.pinned > 0` and `prefixTokensStable === blocks.pinned` in a real round.
  - **Round 5 status of N1:** the source is wired and no longer breaks a session
    (`packages/dsh-plugin/src/system-prompt.ts` + `observer.setSystemPrompt()` + one call in `applyInner`; a real
    round returned its answer normally). The `system-prompt` probe did **not** fire, and the reason is a race,
    not a missing API: the call is `void primeSystemPrompt(...)`, so a short headless round can exit before
    `assemble()`'s promise resolves. **Next action:** await the prime before the first observation — either
    make `applyInner` await it once, or have the pre-step middleware await a shared `priming` promise on its
    first call (bounded: one `assemble()` per session). Then read the tape again: a
    `{"schema":0,"kind":"system-prompt","result":"captured",…}` line, followed by `blocks.pinned > 0` and
    `prefixTokensStable === blocks.pinned` in the control record, closes N1.
  - **Round 5 evidence that the read is safe:** with the wiring in place the round still answered `ok`, and the
    only probe lines written were the service probe plus the step line — i.e. a failed or late prompt read
    cannot damage a session.
  - **Round 6 — the last edit of N1, stated so it cannot be missed:** the priming promise is now
    module-level (`let pendingPriming: Promise<void> | undefined;` in `packages/dsh-plugin/src/index.ts`) and
    `applyInner` assigns it (`pendingPriming = primeSystemPrompt({ … })`). What is still missing is the single
    statement in `preStepMiddleware` that awaits it once before the first observation:

    ```ts
    if (pendingPriming !== undefined) {
      const pending = pendingPriming;
      pendingPriming = undefined;
      try { await pending; } catch { /* reported by the primer */ }
    }
    const decision = await next();
    ```

    **Tooling trap that cost two rounds:** the working copy has CRLF line endings, so a .NET multiline regex
    anchored with `^…$` does **not** match a line that ends in `\r`; and a PowerShell **double-quoted** string
    silently eats template backticks, which produces invalid TypeScript. When editing code from the shell:
    use single-quoted strings, `\r?\n` in patterns, and run `node scripts/build-packages.mjs` before every
    round. Editing the file with the editor tool instead of the shell avoids both traps entirely.
  - **Round 7 — N1 narrowed to one link.** Done this round (with the editor tool, not the shell): the priming
    thunk is now lazy (`primeOnce`, run by the first pre-step call, because at activation time other plugins may
    not have provided the `systemPrompt` service yet) and `onProbe` is wired to the tape sink. Verified: build
    clean, the real round answers, the control record is written — but `blocks.pinned` is still 0 and **no**
    `system-prompt` probe appears, so the primer's own report never reaches the tape.
    **The one link left to test:** give `primeSystemPrompt` a direct `write(line)` callback instead of routing
    its report through the observer (`opts.observer.probe`). If the direct write appears, the observer path was
    the problem and the prompt text is in hand; if it still does not appear, the thunk is not being invoked at
    all and the check moves into `preStepMiddleware` itself. Either way the answer arrives in one round, and
    the acceptance test is unchanged: `blocks.pinned > 0` with `prefixTokensStable === blocks.pinned`.
  - **N1 CLOSED (round 8) — evidence from a real round:**
    `{"schema":0,"kind":"system-prompt","result":"captured","source":"rendered sections","chars":2734,"interpolated":0,"unresolvedVariables":["model","cwd"]}`
    followed by the control record
    `{"type":"assembly",…,"budgetUsed":690,"blocks":{"pinned":684,"stateProxy":0,"recalled":0,"tail":0,"anchor":6},"prefixTokensStable":684,…}`
    — `blocks.pinned` is 684 and `prefixTokensStable === blocks.pinned`, i.e. both acceptance conditions hold, and
    `budgetUsed` grew from 6 to 690 because the fixed prefix is finally accounted for.
  - **How it was closed, in case it regresses:** the service is read lazily on the first pre-step (activation was
    too early — other plugins had not provided `systemPrompt` yet); `assemble({})` is **async** and returns
    `{ sections, contexts, tools, variables }` with no rendered text, so `renderSections()` in
    `packages/dsh-plugin/src/system-prompt.ts` renders it exactly the way the harness's `renderPrompt` does
    (join non-empty `sections[].text` with `\n\n`, honouring `interpolate === false`), with one deliberate
    deviation: an unknown `{{…}}` reference is left literal and reported instead of throwing, because a
    governor must not be able to break a round. Two variables were unresolved in this profile (`model`, `cwd`)
    — they are listed in the probe line rather than silently replaced.
  - **Round 9 — N2 diagnosis (evidence, not theory).** Two facts from real rounds:
    1. The subscription *form* is right: `dsh-agent-instructions` registers exactly
       `ctx.on("session/event", (session, event) => …)` on its own (root) plugin context, read from its packaged
       source. So the hook name and the registration style are not the problem.
    2. A `session-subscribed` marker probe placed immediately **after** the subscription never appears in the
       tape, while `service-probe` and `system-prompt` — written from the same `if (resolved.observation !== 'off')`
       branch — do. So the listener line is either not reached or throws before the marker, and the plugin
       survives because `apply()` swallows activation errors by design.
    **Concrete next step:** move the `session/event` subscription **out of the observation branch** to the top of
    `applyInner` (right after the `enabled` gate) and register it *before* anything that can throw, then re-run a
    round and read the tape: a `session-subscribed` line plus at least one `session-event-probe` line closes the
    delivery question. If the marker appears but no event probe does, the profile genuinely emits none during a
    short headless run — in that case verify in the interactive web profile (port 19487) where sessions last
    longer. N2's acceptance is unchanged and still open: `/s1` shows `upkeep.enqueued > 0`.
  - **N2 CLOSED (round 10).** Root cause of the silent lane: the `session/event` subscription sat deep inside the
    observation branch and was never reached (the `apply()` error boundary hid it). Registering it as the
    **first** statement of `applyInner` — before anything that can throw — fixed delivery outright. Evidence from
    one real headless round: **21 `session-event` lines** in the tape (previously zero), with the harness's real
    event vocabulary showing up: `permission/preset`, `sandbox/mode`, `approval/policy`, `agent/inbox/spliced`, …
    Each event now enters `noteSessionEvent()` → `createUpkeepQueue()` (bounded per tick, drop-oldest with one
    warning, handler throws counted, lag bound reported), and events that arrive before the observer exists are
    buffered (limit 16) and drained on wiring — the `session-subscribed` probe reports how many were replayed.
    Follow-up (not blocking): map the now-known event vocabulary onto segment kinds, and confirm `step/end`
    arrives in longer interactive sessions (the web profile) rather than in a single-task headless run.
  - **N4 plan (round 11) — two APIs still to read, then the implementation is mechanical.** The settings shell is
    plugin-extensible, so the panel is contributed by the plugin's own browser half:

    | Step | What | Verified so far |
    |---|---|---|
    | 1 | read the **credentials** service surface | the service is registered as `credentials` (`super(ctx, "credentials")` in `dsh-credentials`); its public methods are not yet read |
    | 2 | read the **slot** mount API | `dsh-client-ui-slots` exports `SlotCore`, `SlotOwnershipError`, `StaleAuthorizationError`, `resolveSlotLabel`, `standardHookPropName`, and its source speaks of slots, contributions, axes and a shared-handle scope ledger |
    | 3 | declare the browser half | `dsh-pet` is the working precedent: `exports["./client"] → lib/client.js` plus `dsh.client = { inject: ["@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-connection"], platform: "web" }` |
    | 4 | write the panel | plain JavaScript with `React.createElement` — JSX is not erasable syntax and this repository ships no bundler |
    | 5 | persist the key | through the credentials service; the value must never reach a log, a control-plane record, the repository or the transcript, and only ever leaves through `redactKey()` |

    **Read them with a wider pattern than last attempt** (this round's greps were too narrow and printed nothing):
    `& $app --expose-internals scripts/scan-dsh-asar.cjs --dump dsh-credentials\lib\index.js 200` and read the
    class body, then `--dump dsh-client-ui-slots\lib\index.js 60` for the exported entry points. Do **not** ship a
    stub browser half before the mount API is known: a client half that fails to load is exactly the class of
    change that once took a real round down.
    **Acceptance for N4:** in the sandbox web profile (port 19487) a S1CAP section appears in Settings, a key
    typed there survives a restart, and `grep` over the control log, the session log and the plugin output finds
    no plaintext key.
  - **Round 12 — the credential API is in hand.** After three failed pattern reads, `--members` (a new scanner
    mode: every declared method name, indentation-agnostic) produced it in one shot:
    - `dsh-credentials` (the Service) is the **dispatch** layer: `fanOut`, `notifyUpdated`, `notifyRecordUpdated`,
      `warnListenerFailure` — plus the free helpers `credentialKey(scope, id)`, `parseCredentialKey`,
      `credentialRef`, and keys are `"<scope>/<id>"` strings;
    - `dsh-credentials-local` (the provider/store) is the **read-write** layer: `readRecord`, `write`, `resolve`,
      `set`, `unset`, `deleteRecord`, `describe`, `describeRecord`, `listRecords`, `modifyRecord`,
      `migrateFlatDocument`, `reconcileFromDisk`, `refresh`, `changedRecords`, `changedRefs`, `dotenvFallback`.
    **Next read before writing code:** how a stored ref is resolved through the service (the provider registry
    that layers the process environment, the provider-managed store and a file), i.e.
    `--members dsh-credentials\lib\index.js` is already done and the missing piece is the registry type the
    service exposes. Then: `packages/dsh-plugin/src/credentials.ts` reads `s1.apiKey` from that store when the
    config leaves it empty (env vars stay the fallback), and the browser half writes it.
  - **Round 13 — the credential service is reachable, and its write API is known.** A real round reported:

    ```json
    {"schema":0,"kind":"credential","result":"not found","ref":"s1cap/jev",
     "tried":["resolve","readRecord","describeRecord"],
     "available":["constructor","isClosed","inherited","dotenvFallback","resolve","describe","set","unset",
      "readRecord","describeRecord","listRecords","modifyRecord","deleteRecord","enqueue","queueRefresh",
      "write","assertUnshadowed","loadInitial","migrateFlatDocument","refresh","reconcileFromDisk",
      "changedRefs","changedRecords"]}
    ```

    So `ctx.get('credentials')` **does** hand the plugin the store, the read entry points are reachable (they
    answered "not found" because no key has been entered yet — the correct answer, not a failure), and the write
    path is `set` / `write` on the same object. `packages/dsh-plugin/src/credentials.ts` implements the read with
    entry-point probing and never leaks the secret into a report (three tests); the host half is therefore done.
    **What remains for N4 is only the browser half** (the panel): declare `exports["./client"]` → `lib/client.js`
    plus `dsh.client` (inject client-runtime + client-connection, platform web, copied from the `dsh-pet`
    precedent), write the panel in plain JavaScript with `React.createElement`, and on save call
    `set`/`write` with the ref `s1cap/jev`. Acceptance: the section appears in the sandbox web profile's Settings,
    a key typed there survives a restart, and no plaintext key appears in the control log, the session log or the
    plugin output.
  - **Regression check after the credential wiring:** a real round still reports `blocks.pinned = 684`, so N1
    holds.
  - **Round 14 — the client-half contract, read verbatim out of a working third-party plugin (`dsh-pet`).** This
    is the piece that made the panel look hard; it is now mechanical:

    ```js
    // the client half exports apply/inject/name and registers into named slots
    const inject = [ /* … */ 'slots' /* … */ ];

    ctx.slots.inject('settings.section', function* () {
      yield ctx.slots.register(
        {
          name: 'settings.section',
          id: 's1cap-config',        // unique within the slot
          order: 30,                 // position among the sections
          label: () => 'S1CAP',      // thunk = locale-aware
          inject: () => ({ /* props handed to the component */ }),
        },
        S1CapConfigSection,          // the React component
      );
    });

    module.exports = { apply, inject, name };

    // and the file is a module the client loader picks up:
    window.__ModuleLoader__.load({ id: 'dsh-s1cap', factory: makeFactory() });
    ```

    So: slot name **`settings.section`** (the overlay slot is `shell.overlay`), registration is
    `ctx.slots.register(meta, Component)` inside `ctx.slots.inject(name, generator)`, and the client half loads
    through `window.__ModuleLoader__`.
    **One unknown left, and it is the only thing between here and a shipped panel:** how a component obtains
    React when the half is authored as plain JavaScript (a bundler would have inlined it). Candidates to check
    in this order: (1) an injectable client service (`inject: ['react']`-style), (2) a module the
    `@deepseek-ai/dsh-client-runtime` injection exposes, (3) the loader's own registry. Answer it with
    `--members`/`--grep` on `dsh-client-runtime` and `dsh-client-ui-slots`, then write
    `packages/dsh-plugin/src/client.js` (built to `lib/client.js`), declare it in `package.json`
    (`exports["./client"]` + `dsh.client = { inject: ['@deepseek-ai/dsh-client-runtime',
    '@deepseek-ai/dsh-client-connection'], platform: 'web' }`) and call the credential store's `set`/`write`
    with ref `s1cap/jev` on save.
  - **Round 15 — the last unknown is answered: React comes from the loader's `require`.** Reading `dsh-pet`'s
    client half to the end shows the factory receives a CommonJS-style `require` in its scope:

    ```js
    function makeFactory() {
      return function () {
        const react = require('react');                    // the client loader provides it
        const { jsx: h } = require('react/jsx-runtime');
        const inject = [ /* … */ 'remote', 'remote.commands', 'commandUi' ];
        function apply(ctx) { /* … */ }
        module.exports = { apply, inject, name };
        return module.exports;
      };
    }
    window.__ModuleLoader__.load({ id: 'dsh-pet', factory: makeFactory() });
    ```

    So a plain-JavaScript half needs no bundler: `require('react')` plus `React.createElement`, exactly the
    shape this repository can ship. **N4 now has no unknowns left.** Implementation checklist:
    1. `packages/dsh-plugin/src/client.js` — plain JS, `window.__ModuleLoader__.load({ id: 'dsh-s1cap', factory })`,
       factory returns `{ apply, inject, name }`, `inject` includes `'slots'`;
    2. register `ctx.slots.inject('settings.section', function* () { yield ctx.slots.register({ name:
       'settings.section', id: 's1cap-config', order: 30, label: () => 'S1CAP', inject: () => ({}) }, Section); })`;
    3. extend `scripts/build-packages.mjs` to **copy** `src/**/*.js` into `lib/` (it currently strips only `.ts`);
    4. `package.json`: `exports['./client'] = './lib/client.js'` and
       `dsh.client = { inject: ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-connection'], platform: 'web' }`;
    5. the panel reads live state through the client's `remote.commands` channel and writes the key through the
       credential store (`set`/`write`, ref `s1cap/jev`) — **never** through a command's raw input, because that
       would put the secret into the transcript;
    6. verify in the sandbox **web** profile: the section appears, a key survives a restart, and no plaintext key
       turns up in the control log, the session log or the plugin output.
- [ ] **N4** Settings panel + Jev key through the credential service *(user decision: the key is typed by the user in a panel)*
  - **N1 detail (verified 2026-09-28, round 1):** `dsh-system-prompt` registers a Cordis **Service named
    `systemPrompt`** (`super(ctx, "systemPrompt")`), so the host half can read `ctx.systemPrompt` once
    `'systemPrompt'` is added to `inject` (Cordis throws on uninjected access — that is how the earlier
    `command` bug surfaced). Verified public API: `section()`, `context()`, `getSectionOrder()`,
    `getContextOrder()`, `suppressRuntimeContext()`; the package also exports `renderPrompt`,
    `renderContextSections`, `joinContextSections`, `renderContextSnapshot`. A real round proved the prompt is
    **not** delivered as a `session/event` payload. Next: print the rest of the class
    (`--dump dsh-system-prompt\lib\index.js 366`), take the render method, feed
    `observer.setSystemPrompt(text)`. Acceptance: `blocks.pinned > 0` and
    `prefixTokensStable === blocks.pinned` in a real round.
  - **N4 detail (verified 2026-09-28, round 1):** DSH does **not** auto-render a config form for arbitrary
    plugins — the settings "plugin inventory" section only reports configuration *status* — so the panel must
    come from the plugin's own browser half: `exports["./client"]` → `lib/client.js`, `dsh.client =
    { inject: ["@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-connection"], platform: "web" }`
    (the `dsh-pet` precedent, verbatim), slots from `@deepseek-ai/dsh-client-ui-slots`, and the credential
    service is registered as **`credentials`** (`super(ctx, "credentials")` in `dsh-credentials`). The client
    half must be plain JavaScript built with `React.createElement` — JSX is not erasable syntax, so Node's
    type stripper cannot process it and this repository ships no bundler.
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
