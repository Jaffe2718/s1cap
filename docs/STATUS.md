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
  - **Round 16 — where the shipped key UI lives, and the read that was too broad.** DSH's own "enter an API key"
    screen is `dsh-client-ui-settings-models` (its client half contains an `apiKey` module with a
    `apiKeyFailure(draft)` normaliser, a credential dot per route showing configured/missing, and an editor that
    saves through the **host RPC** — the client half injects `remote`, `remote.commands` and `commandUi`).
    **The mistake to avoid repeating:** grepping that file for `credential|apiKey|secret` matched thousands of CSS
    class names and buried the code. **Next read (tight, no CSS):**
    `& $app --expose-internals scripts/scan-dsh-asar.cjs --members dsh-client-ui-settings-models\lib\client.js`
    to get its function list, then `--grep` that file for `remote\.[a-zA-Z]` with context 1 to see the exact host
    call the Save button makes. Copy that call shape for the S1CAP panel; the host side is already done
    (`readCredential` + `set`/`write` on the `credentials` store with ref `s1cap/jev`).
  - **Round 17 — the browser half is written and built, but DSH does not register it yet (evidence below).**
    Shipped this round: `packages/dsh-plugin/src/client.js` (plain JS; `window.__ModuleLoader__.load`, factory
    returning `{ apply, inject, name }`, `inject = ['slots', 'remote.credentials']`, a section registered into
    `settings.section` with `id: 's1cap-config'`, `order: 30`, `label: () => 'S1CAP'`; the panel reads the
    credential state through `ctx.remote.credentials.describe([ref])` — the call the shipped API-key screen makes —
    and saves through `set`/`write` with ref `s1cap/jev`, never echoing the value), `exports['./client']` and
    `dsh.client = { inject: ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-connection'], platform:
    'web' }` in `package.json`, and `scripts/build-packages.mjs` now **copies** `src/**/*.js` into `lib/`
    (`lib/client.js`, 7 KB).
    **The gap, measured rather than guessed:** `window.__DSH_BOOT__` is the ground truth for client modules — it
    lists `{ id, url, rev, inject }` per entry, with URLs shaped `plugins/??<package-name>/client.js&rev=…` — and
    in the running sandbox web profile it **does not mention `dsh-s1cap`** at all, while `window.__ModuleLoader__`
    exists. So the declaration is not being discovered. **Next: compare our `dsh` block with `dsh-pet`'s
    field-by-field** (`dsh.bundle.patch`, `dsh.client.inject`, `dsh.client.platform` look identical) and check how
    the boot table is produced — most likely the client entry is registered from the **profile's install metadata**,
    so the linked plugin may need a reinstall (`dsh plugin --profile s1captest remove` + `add link:…`) or an
    additional declaration field before the entry appears. Also note the shipped client ids are **package names**
    (`@deepseek-ai/dsh-client-ui-…`), which our `id: 'dsh-s1cap'` matches.
- [x] **N4** Settings panel shipped and verified in a real browser: **S1CAP** appears in Settings, the panel renders, and it reads credential state through the host RPC (evidence below)
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
      (`s1_call` side **done and live**: 15 records against 15 backend calls, questions tie out at 108;
      `usage` contract **measured**: `{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
      totalTokens}`. Left: the cache/input semantics, the call site, and `wallMs`/`approvalWaitMs`.)
- [ ] **N6** The actual context rewrite (`decision.messages`), feature-flagged per ablation cell

### N4 evidence (round 18)

The registration gap was an **install-metadata** problem, not a declaration problem: after
`dsh plugin --profile s1captest remove dsh-s1cap` and `add link:…`, `window.__DSH_BOOT__` lists our browser half
among its 66 client entries —

```json
{"id":"dsh-s1cap","url":"plugins/??dsh-s1cap/client.js&rev=dae1139fcd91",
 "inject":["@deepseek-ai/dsh-client-runtime","@deepseek-ai/dsh-client-connection"]}
```

— and fetching that URL returns `200`, 7174 bytes, containing `__ModuleLoader__`, `settings.section` and
`remote.credentials`. So the half loads, registers into the settings slot, and reaches the credential RPC.
The panel itself (plain JS, `React.createElement`, no bundler): shows whether a key is stored via
`ctx.remote.credentials.describe([ref])`, saves it through `set`/`write` with ref `s1cap/jev`, clears it, and
never echoes the value; the host half reads the same ref back (`packages/dsh-plugin/src/credentials.ts`).
**Lesson worth keeping:** a linked plugin needs a reinstall before DSH registers its client entry — the boot
table is built from install metadata, not from the package.json on disk.
### N4 evidence (round 20 — the panel is live in the browser)

Driven through a real browser against the sandbox web profile: opening **设置** shows a **S1CAP** section next to
通用设置 / 模型 / 内置插件 / Agent 预设, and the panel renders

```
S1CAP — System-1 backend
… This panel holds the credential for the cloud System-1 backend (Jev) …
no Jev key stored          ← the credential read succeeded
[ password field: "paste the Jev API key" ]  [Save] [Clear]
Credential reference: s1cap/jev. …
```

with no failure screen and no error from the half (`window.__S1CAP_CLIENT_ERROR__` is null; the boot table lists
`dsh-s1cap` among 66 entries).

**The two mistakes that took three rounds, both now understood:**
1. **The factory is the module body.** DSH's loader states it verbatim in its own client module:
   `factory: (require) => { var module = { exports: {} }; var exports = module.exports; … return module.exports; }`.
   An earlier revision returned a *nested function*, so the body never ran and DSH reported the entry as failed with
   no error surfacing from the file. `require` is the factory's **argument**; `module` is declared by the module
   itself.
2. **Client RPC namespaces must be injected.** Cordis throws on access to an uninjected service, which the panel
   itself reported: `cannot get property "remote" without inject`. The half now injects
   `['slots', 'remote', 'remote.credentials']` — the same namespaces the shipped key UI declares.
Also: a **linked** plugin must be reinstalled after any change to its client declaration, because the boot table is
built from install metadata rather than from the package.json on disk.
### Recall tuning in the settings panel (round 21)

**Done and verified in a real browser:** the S1CAP section now carries the two recall knobs next to the key —

- **BFS depth d** — number input, `min=1`, `step=1`, placeholder 2; the panel refuses `0`, negatives, and
  non-integers with the message *"depth d must be an integer greater than 0"* (verified by driving the UI);
- **relevance threshold r** — number input, `min=0`, `max=1`, `step=0.05`, placeholder 0.55, validated locally
  as 0 <= r <= 1;
- a **Save tuning** button, and the host half gained `parseTuning()` (`packages/dsh-plugin/src/credentials.ts`,
  four new unit tests, 106/106 green) plus the code that applies both values to the live policy at session
  start and reports `tuning: { stored, effective }` through `/s1`.

**Not finished — persistence.** The panel reports the truth instead of claiming success: writes to the
credential store come back refused,

```
tuning save refused: typert gateway: credentials/set: wire field "value" failed boundary validation
```

which is a *payload-shape* rejection from the typert boundary, not a permission problem. An earlier revision
silently discarded `set`'s `{ ok, error }` response and printed "saved" — that is fixed: every write now goes
through a `refusal()` check, and the shipped key UI's own pattern (`response.ok ? void 0 : response.error.message`)
is what it follows.
**Next step, precisely:** read the `credentials/set` boundary schema out of the typert registry
(`--members`/`--grep` on `dsh-typert-registry` and `dsh-credentials-local` for the wire shape) and send exactly
those field names for both the key (`{ apiKey }` is the shape the shipped LLM credential uses) and the tuning
value. Until that lands, the values are validated in the UI but a session still runs at the policy defaults.
### Recall tuning persistence — two transports eliminated with evidence (round 22)

The panel carries **BFS depth d** and **relevance threshold r**, validated locally (verified live: `d = 0` is
refused with *"depth d must be an integer greater than 0"*), and the host already parses and applies them
(`parseTuning`, applied to the live policy at session start, reported through `/s1`). What is still missing is the
*transport* that stores them, and two candidates are now ruled out by measurement rather than by guesswork:

1. **`remote.credentials.set(ref, value)`** — refused by the boundary declared in
   `dsh-api-settings-controller` (`credentials/set` carries `:ref` and `:value` type symbols):

   ```
   tuning save refused: typert gateway: credentials/set: wire field "value" failed boundary validation
   ```

   with a bare string it answered *"invalid payload for credentials.set"*. The store underneath
   (`dsh-credentials-local`) accepts a plain string — `async set(ref, value) { if (value.length === 0) throw … await
   this.write(ref, value); }` — so the RPC validates more than the store does, and an arbitrary ref such as
   `s1cap/tuning` is not what that boundary is for. The key belongs there; the tuning does not.
2. **`remote.settings.mutate(ns, ops, expectedRevision)`** — the right home for non-secret plugin settings, and its
   wire shape is confirmed (`:ns`, `:ops`, `:expectedRevision`, view type
   `@deepseek-ai/dsh-settings/types#SettingsNamespaceView`), **but the namespace has to be registered on the host
   first** through the `dsh-settings` service. That is the next concrete step: read `dsh-settings`' registration
   API (`--members`/`--grep`), declare an `s1cap` namespace with `depth` and `tau` fields, have the panel write
   through `settings.mutate`, and keep the host's `parseTuning` as the fail-safe gate.

Until that lands, the two knobs are visible and validated but a session still runs at the policy defaults — stated
plainly here so nobody reads the panel as proof that a run used a non-default depth.
### Decisive finding on the credential transport (round 23)

Probing the RPC at runtime settled it, and the answer is "wrong store", not "wrong shape":

```
tuning save refused: Error: client api: credentials/set expected 2 argument(s), got 1
```

So the call is positional `set(ref, value)` — one argument is rejected outright — and a string value passed that
way still draws *"invalid payload for credentials.set"*. The boundary declared in `dsh-api-settings-controller`
carries two type symbols, `credentials/set:ref` and `credentials/set:value`: the `value` half is satisfied by a
string, which leaves the **`ref` half** as the refuser, i.e. the boundary admits credentials a provider registered
rather than arbitrary plugin-owned keys. The store underneath is looser (`dsh-credentials-local`'s
`set(ref, value)` takes any string), which is exactly why the plugin's host-side `readCredential` probing worked
for reads while writes are refused.

**Consequence:** `s1cap/tuning` will never be writable through that RPC, so the recall knobs need their own home —
a settings namespace registered on the host through `dsh-settings`, written by the panel via
`remote.settings.mutate(ns, ops, expectedRevision)` (wire shape confirmed: `:ns`, `:ops`, `:expectedRevision`, view
type `@deepseek-ai/dsh-settings/types#SettingsNamespaceView`). The panel's `write()` is left as the verified
two-argument call plus the truthful `{ ok, error }` handling, so nothing fake ships in the meantime.
### The last API for tuning persistence: a credential *provider* (round 24)

Two reads narrowed it to one mechanism:

- `dsh-settings` exposes only `mutate`, `schema` and `write`; its namespace registration lives on the Service base
  (`SettingsNamespaceView` is the view type the RPC returns), so writing a namespace from a plugin needs a
  namespace declaration that is not part of that surface;
- `dsh-credentials` **exports a `CredentialProvider` base class** (`class extends Service`) — and that is the piece
  that explains the refusal. A credentials ref belongs to a **registered provider**; `set` admits the refs its
  providers own and rejects everything else with *"invalid payload"*, which is exactly what `s1cap/tuning` drew.

So the correct, designed path — and the one the shipped LLM key UI itself walks — is for the host half to register a
provider for the `s1cap` scope (extending `CredentialProvider`), declaring the fields it owns (`apiKey`, and the
tuning payload). With that provider registered, the panel's existing `set(ref, value)` calls start being accepted
without any change to the panel.

**Next concrete step:** read the `CredentialProvider` subclass contract (`--members`/`--dump` on
`dsh-credentials\lib\index.js` around the exported class, plus one shipped provider such as
`dsh-llm-deepseek-api-key` as the working precedent), register the `s1cap` provider in the host half, and keep
`parseTuning` as the fail-safe gate. Until then the two knobs are visible and validated in the panel while a
session runs at the policy defaults — stated here so the panel is not mistaken for evidence that a run used a
non-default depth.
### Tuning persistence: the settings endpoint is reachable, only the `ops` shape is missing (round 25)

Adding `'remote.settings'` to the client half's `inject` list cleared the last Cordis refusal
(*"cannot get property \"remote.settings\" without inject"* — the same rule that produced the earlier `remote`
error), and the panel now reaches `settings/mutate` on the gateway. Three candidate `ops` payloads were probed;
all three came back identically:

```json
{"ok":false,"error":{"code":"gateway/input-invalid",
                     "details":{"endpoint":"settings/mutate","field":"ops"},
                     "isDSHRemoteError":true,"name":"RemoteError"}}
```

So the namespace argument passes validation and **`ops` is the only wrong part**. **Next step, exactly:** read the
`ops` schema from the typert host declaration — `dsh-api-settings-controller` carries the type symbols
`…settings/mutate:ns`, `…settings/mutate:ops`, `…settings/mutate:expectedRevision`, so
`--grep "dsh-api-settings-controller\lib\typert.host.js" "mutate:ops"` with a wider context prints the op union
(names, likely a discriminated `{ op: … }` with `path`/`value` or a JSON-patch style list), after which the panel
sends that shape and the knobs persist.

State of the feature, plainly: the two knobs are **on the panel, validated, and the host reads/applies them at
session start** — but nothing writes them yet, so a session still runs at the policy defaults until the `ops` shape
lands. The panel says so in its own message rather than claiming success.
### Round 26: the `ops` shape is path-addressed, and the namespace must be declared

Two more facts, both read from the packaged source:

- the settings controller's own documentation says it takes **path-addressed operations** and that it "classifies
  every provider refusal" — so an op carries a *path* plus a value, and the `{ op: 'set', path, value }` list is
  the right family; the shape my three probes used was rejected on `field: "ops"`, so a detail of that family
  (array-valued `path`, or a different op name such as `set`/`remove` with a boolean flag — the schema code nearby
  builds `{ path: [...], set: … }`) is what differs;
- `dsh-storage-domain` is in the shipped inventory and is the layer that declares storage/settings domains, i.e.
  **a plugin gets a writable namespace by declaring one**, which is the missing prerequisite for
  `settings/mutate('s1cap', …)` to be anything other than an unknown namespace.

**Next step, in order:** (1) `--members` then `--grep` on `dsh-storage-domain` for the domain-declaration API
(`declare*`/`domain`/`schema`), (2) declare an `s1cap` domain whose schema carries `recall.depth` (integer, > 0) and
`recall.tau` (0..1) — the same two rules the panel enforces, so the boundary validates them for free, (3) send the
path-addressed op list from the panel, (4) confirm with a real session that `/s1` reports the chosen values under
`tuning.effective`.

**Where the feature stands:** the panel carries both knobs with the requested rules, the host reads and applies
whatever is stored, and the write path is the only thing missing — so a session still runs at the policy defaults.
The panel states this itself instead of implying success.
### Round 27: the recall knobs take effect — proven in a real session

Rather than keep chasing the settings RPC (whose `ops` shape is still unknown), the knobs got a channel that works
today and a store the plugin owns; the panel keeps its fields and validation, and `/s1-tune` drives the host:

- **`/s1-tune d r`** (also `d=3`, `r=0.7`, or either alone) validates with the same two rules — d an integer > 0,
  0 <= r <= 1, out-of-range dropped rather than clamped — applies them to the live policy **immediately**, and
  persists them to `~/.dsh/.s1cap/tuning.json` (the plugin's own directory, alongside the control log and tapes);
- at session start the host reads that file and applies it, which a real headless round now proves:

  ```json
  {"schema":0,"kind":"tuning-file","read":{"depth":3,"tau":0.7},"effective":{"depth":3,"tau":0.7}}
  ```

  `effective` equals `read`: the session ran at the chosen depth and threshold, not at the defaults. `/s1` reports
  the same pair under `tuning`.

**Still open, and only this:** the panel's *Save tuning* button cannot write yet — `settings/mutate` needs the
namespace declared (via `dsh-storage-domain`) and the path-addressed `ops` shape. Until that lands, the panel shows
the two fields and their validation while `/s1-tune` is the working path; the panel says so in its message instead
of implying a save. Panel-side tests and the host-side parser: 107/107 green.
### Round 28: both write channels share one missing prerequisite

`CredentialProvider` turned out to be the credentials **Service itself** (`super(ctx, "credentials")`), not a base
class for plugins — so the earlier "register a provider for the s1cap scope" plan is wrong. What actually admits a
ref is a **schema declaration**: the shipped LLM key plugin declares `apiKeyEnv: z.string().role("credential-ref")`
and registers that schema with its provider registration, which is why its key is writable and `s1cap/tuning` is
not.

That single prerequisite — a declared domain carrying the field roles — is what both remaining channels need:
`credentials.set` (admits refs some schema declared) and `settings.mutate` (admits declared namespaces). **Next
step:** read `dsh-storage-domain`'s declaration API (`--members`, then `--grep` for `domain`/`declare`/`schema`),
declare an `s1cap` domain whose schema carries `recall.depth` (integer > 0) and `recall.tau` (0..1) — the same two
rules the panel and `parseTuning` already enforce, so the boundary validates them for free — and then either write
path becomes available to the panel button.

**What works today, without that domain:** the panel's two fields with their validation, and `/s1-tune d r` which
applies the values immediately and persists them (proven: `read == effective` in a real round). The panel button is
the only thing still blocked, and it says so in its own message.
### Round 29: `recall.window = w` lands in core (tests green, wiring still to do)

What is in and green (107/107):

- **`AssociationGraph.scoreNew({ windowN, threshold, score? })`** — segments that arrived since the last call are
  each scored against only the most recent `windowN` segments. Cost per new segment is one pass of `w`
  comparisons, `O(w)`, independent of session length — the whole point of the parameter.
- **`stats()` now reports `scoredPairs`** (cumulative pair comparisons), so the saving is a number rather than a
  claim, and the counter is what the telemetry fields will carry.
- **Segments outside the window are untouched**: they keep every edge they already have and stay reachable by
  `recall()`. `w` decides *whether a pair is scored*, never what exists in the graph — exactly the semantics
  settled in `prompt.txt` (no revival scoring).
- **`recall.tau` is renamed to `recall.relevanceThreshold`** (validation rule moved with it) and **`recall.window`** is added
  as an integer >= 1 with default 1024; `lexicalScore` is the offline stand-in for the System-1 scorer so the
  window is testable without the model.

**Caught mid-round and worth recording:** the first two attempts at these edits used exact-string replacements
whose anchors contained non-ASCII characters and indentation copied by eye; three of them silently missed, one
inserted a block twice, and the duplicate `lexicalScore` declaration made six test files fail to load at all
(`SyntaxError: Identifier 'lexicalScore' has already been declared`). The suite went 107 -> 56 -> 58 -> 107. The
rule this reinforces: **edit these files line-based with ASCII-only anchors, and assert the post-condition**
(count of declarations, presence of the method) in the same command that writes them.

Still to do: wire `scoreNew` into the observation path and add the two add-only telemetry fields (`windowN`,
`scoredPairs`); panel third field plus `/s1-tune ... w=`; the four documents; the real-session evidence
(`/s1-tune d=3 r=0.7 w=512` -> `read == effective` with `windowN: 512`).
### Round 30: `w` reaches the host; the panel input is still missing

Green and committed (107/107):

- `Tuning` carries `window`, `parseTuning` reads it as the third field of `"<d> <r> <w>"` (integer >= 1, otherwise
  dropped like every other out-of-range field), and `parseTuningArgs` accepts `w=512` / `window=512` / a third
  positional value;
- `/s1-tune d r w` applies it to `config.recall.window`, persists it, and reports
  `effective: { depth, relevanceThreshold, window }` — so the host half of the parameter is complete;
- the panel half is **not**: its state and read-back learned about the window, but the input row, the local
  validation and the third value in the saved string are missing, because the patch anchor for the save path did
  not match and I did not re-check the post-condition for the UI row. The panel therefore still shows two fields.

Also missed (cosmetic): one log line in `index.ts` still prints only depth and relevanceThreshold.

**Next:** add the third input row to the panel (label `w`, `min=1`, `step=1`, placeholder 1024), its local
validation, and `String(w)` in the persisted payload; then the real-session evidence
(`/s1-tune d=3 r=0.7 w=512` -> `read == effective` with `windowN: 512`) and the four documents.

**Note on method:** this round I asserted post-conditions for the files I patched, which is how the two misses were
caught instead of shipping a half-wired parameter. The remaining gap is exactly what those assertions said.
### Round 31: `w` is applied from the tuning file, and the window has a regression test

Evidence from a real headless session (`~/.dsh/.s1cap/tuning.json` = depth 3, relevanceThreshold 0.7, window 512):

```json
{"kind":"tuning-file","read":{"depth":3,"relevanceThreshold":0.7,"window":512},"effective":{"depth":3,"relevanceThreshold":0.7,"window":512}}
```

`read` equals `effective`, window included, and the control-plane record for that session reports `windowN: 512`.
Two gaps surfaced while getting there, both the same shape - a value added to one parse path and forgotten in the
sibling: `readTuningFile()` did not carry `window` at all, and the merge from the file into `appliedTuning`
copied depth and relevanceThreshold but not window. The probe is what caught both, which is why it prints `read` and
`effective` side by side.

`packages/core/test/window.test.ts` now pins the parameter's contract offline: with w = 64 over 400 segments,
`scoredPairs` stays within `total * w` and below full pairwise scoring; the first segment is still a node with
its edges intact after falling out of the window; and doubling w roughly doubles the cost, so the cost tracks w
rather than the history length. 108/108 green.

Still open: a multi-step session to show `scoredPairs` per step in a longer run (the headless probe recorded a
single assembly step, where the counter is necessarily 0), the four documents, and the panel's direct write.
### Round 32: why the panel cannot write — the wrong slot, not a missing allowlist

The official cookbook ([Adding a settings page](https://deepseek-harness.github.io/deepseek-harness/en/reference/cookbook/adding-a-settings-card))
answers the open question, and the answer is architectural rather than a permission:

1. **Live configuration fields are declared in the plugin's `Config` schema with `.volatile()`** —
   `retries: z.number().step(1).min(0).default(3).volatile()` — read through `config.retries.get()`, with
   `ctx.on('loader/volatile-update', …)` for HMR. A snapshot taken at the start of an operation stays consistent.
2. **The write path belongs to the Plugins page**, whose owner hands a registered page `form.state` and
   **`form.mutate(operations, expectedRevision)`**; the Host validates the full `Config` and applies edits through
   ConfigEditor plus volatile HMR. Such a page registers under the Plugins surface (`plugins.item` /
   `plugins.detail.*`, `configForms.whileServed` for a companion package).
3. `role('secret')` keeps a value out of form responses, and credential-managed values use credential references —
   so the Jev key stays in the credentials domain, which is where our host half already reads it.

Our panel registers into `settings.section` (a general settings slot) with **no form binding and no volatile
Config fields**, so there is nothing for `set`/`mutate` to write into: the earlier `settings/mutate` refusals were
that slot mismatch showing through, not a `WEB_SETTINGS_NAMESPACES` allowlist problem.

**Concrete next step:** declare `depth`, `relevanceThreshold` and `window` as `Volatile<number>` fields in the
plugin `Config` schema (`.volatile()`, with the same bounds the parsers enforce), read them with `.get()` at session
start and on `loader/volatile-update`, and expose the card through the Plugins page's form so `form.mutate` performs
the write. `/s1-tune` stays as the headless path, and the tuning file as the fallback store.

**Also confirmed:** the browser half attaches to the Loader row whose specifier is the bare package name (ours is),
`dsh.client.inject` is the declared dependency list we already use, and the built `./client` must be the lazy-CJS
factory this repository already emits.
### Round 33: the config-form surface is shipped here; plugin-side resolvability is the open question

Two checks, one answer each:

- **The documented mechanism exists in this DSH build.** `configForms` appears in the shipped client packages
  (`dsh-client-ui-chat`, `dsh-client-ui-agent-preset`, `dsh-client-locale`) and `loader/volatile-update` in
  `cordis-plugin-loader` plus several plugins (`dsh-llm-deepseek`, `dsh-experimental-speech-to-text`). So the Plugins
  page form and volatile HMR are real surfaces in 0.1.7-rc.2, not documentation for a newer release.
- **Internal packages are not resolvable from the profile directory.** `require.resolve('@deepseek-ai/schemastery')`
  and `require.resolve('@deepseek-ai/dsh-credentials')` both answer `MODULE_NOT_FOUND` when run with the profile as
  the working directory. They live inside the application archive, so a plugin installed under the profile cannot
  reach them by plain Node resolution — and declaring volatile config fields needs `z.object(...)` from
  schemastery.

**Therefore the next experiment is one line, not an implementation:** add the schemastery import to the host half and
see whether the bundle still activates in a real profile. If the loader maps `@deepseek-ai/*` for plugin code (as it
already does for `react` in the browser half, which third-party client modules require successfully), the volatile
Config path is open and the panel can write; if it does not, the config-form route is closed to an out-of-tree
plugin and the honest answer is that Save stays on `/s1-tune` plus read-back, with this evidence as the reason.

Either way this replaces the earlier guess (a `WEB_SETTINGS_NAMESPACES` allowlist) with a measured question.
### Round 34: the volatile Config path **is** open to an out-of-tree plugin

The question left open last round is answered by precedent, not by a guess. Two third-party plugins installed in
these very profiles import the host packages directly:

```js
// dsh-browser/lib/index.js
import Schema from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
// another installed plugin
import z from '@deepseek-ai/schemastery';
```

and one of them says so in a comment: *"Cordis (4.x) and schemastery (3.x) are host packages, but are not on
[npm]"*. So `require.resolve` failing from the profile directory was a red herring: the Loader resolves host
packages **for plugin code**, plain Node resolution from a working directory does not. The earlier plan is therefore
viable, and no allowlist stands in the way.

**Implementation, next:** declare the three knobs as volatile fields in the plugin's exported `Config`
(`z.number().min(...).step(...).default(...).volatile()` with the same bounds the parsers enforce — d an integer > 0,
0 <= r <= 1, w an integer >= 64), read them with `.get()` when a session starts and again on
`ctx.on('loader/volatile-update', …)` so a change lands without a restart, keep our own `resolvePluginConfig` as the
fallback for a profile that passes a plain object, and let the Plugins page's `form.mutate` be the write path. Only
then does the panel's Save button write; `/s1-tune` and the tuning file stay as the headless and fallback paths.
### Round 35: volatile updates re-apply live, and the rule that got us there

Landed and green (109/109): the host half subscribes to `loader/volatile-update` and, when it fires, re-reads the
tuning store and re-applies `depth`, `relevanceThreshold` and `window` to the live policy, so an edit lands without a
restart. The handler is wrapped and logged - an event that never fires costs nothing, a throw would take the harness
down with it - and the subscription is registered **before** the pre-step middleware deliberately, because the plugin
test pins the recorded order:

    assert.deepEqual(h.events, ['session/event', 'loader/volatile-update', 'agent/pre-step'], ...);

A real round re-confirmed the store path end to end:
`{"kind":"tuning-file","read":{"depth":3,"relevanceThreshold":0.7,"window":512},"effective":{...same...}}`.

**Ground rule 11 - read the failure before editing the expectation.** This took two rounds for one line. The first
attempt assumed the new subscription would be appended to the event list and patched the expectation accordingly; the
suite stayed red, and the diagnostic round then printed the actual diff, which showed the subscription recorded
*between* the other two. Both attempts were gated - expectation first, subscription second, suite re-run, and a full
revert when it was not green - which is why the tree never sat red and the wasted round cost only time.

**Still open for the panel's Save button:** declaring `depth`, `relevanceThreshold` and `window` as volatile fields in
the exported `Config` (`z.number().min(...).step(...).default(...).volatile()`, bounds matching the parsers) and letting
the Plugins page's `form.mutate` perform the write - that is the part that turns Save from a validation demo into a
working control. The precedent is confirmed: installed third-party plugins import schemastery directly, so host
packages are resolvable for plugin code.

**Still open for the cost figure:** a long multi-step session, so `scoredPairs` per step is measured rather than
modelled. Headless probe rounds keep producing a single assembly (where the counter is necessarily 0), so this needs a
prompt that forces several steps.
### Round 36: our own bundle resolves host packages - the last unknown before the volatile Config

The experiment was one import line in the host half, run against the throwaway CLI profile and then reverted:

    import type z from '@deepseek-ai/schemastery';

Result: the round still answered `ok`, no module error appeared, and the plugin demonstrably activated - one
control-plane record and 32 tape lines were written. So host packages are resolvable **for our bundle**, not only for
the third-party plugins whose imports were the precedent. Restored immediately afterwards; 109/109 green, tree clean.

**Every prerequisite for the panel's Save button is therefore verified**: the mechanism ships in this build
(`configForms`, `loader/volatile-update`), the volatile-update subscription already re-applies the three knobs
without a restart, host packages resolve for our plugin, and no allowlist stands in the way. What remains is the
schema itself.

**The hard constraint to respect when writing it:** the exported `Config` must describe **every** field
`resolvePluginConfig` accepts today (`enabled`, `observation`, `s1`, `laya`, `recall`, `tas`, `tail`, `planGate`,
`telemetry`, `cache`, `rgMaintenance`, `cell`, ...). The loader validates the plugin's configuration against that
schema, so a schema that omits a field the patch sets makes the plugin fail to activate - which is worse than the
feature being unfinished. Read the current field set first, write the schema in one pass, then verify activation in a
real profile before touching the panel.

**Also learned about the live cost curve:** headless probe rounds cannot force multiple steps, because that
profile's sandbox refuses writes to the repository, so the model declines to issue the shell commands and only one
assembly is recorded (where `scoredPairs` is necessarily 0). The live per-step curve therefore has to come from the
web sandbox driven through a browser, where the tool calls can actually run.
### Round 37: why the headless profile cannot produce a multi-step session

Two dead ends, both measured rather than assumed, so the next attempt does not repeat them:

1. **It is not the working directory.** Running the round with the working directory outside the repository changed
   nothing: the model still declined to issue the shell commands, and one assembly was recorded (`scoredPairs` 0).
2. **It is not a key in the profile patch.** `~/.dsh/profiles/s1capobs/cordis.patch.yml` contains only the S1CAP row
   (`enabled`, `observation`, `cell`, `assemblyDeadlineMs`, `s1`, `laya`, `telemetry`, ...) and carries no sandbox,
   permission or approval key at all. The sandbox that refuses tool execution therefore comes from the profile's base
   composition, and relaxing it means adding the configuration row of whichever plugin owns it - whose id and schema
   are not yet known - rather than editing a value in place.

So the live per-step curve needs one of: that composition row identified and relaxed in the throwaway profile (never
the desktop profile), or the web sandbox driven through a browser where tool calls actually run. The offline curve in
`scripts/window-curve.mjs` remains the reproducible evidence for the parameter's bound - it shows the tail step
costing exactly w (64/256/1024) against 4095 for full-history scoring at T = 4096 - and it is labelled as the model
it is, not as a live measurement.
### Round 38: the `settings/mutate` ops shape is found - `[{ op: 'set', path: [...], value }]`

Probing the gateway from the panel with four candidate shapes and two namespace candidates produced one hit, and the
distinction it draws is the whole answer:

    s1cap/arr-op-set   -> {"ok":false,"error":{"code":"settings/rejected","details":{"ns":"s1cap"}}}
    s1cap/arr-set-flag -> {"ok":false,"error":{"code":"gateway/input-invalid","details":{"field":"ops"}}}
    s1cap/dot-op-set   -> gateway/input-invalid, field "ops"
    s1cap/patch        -> gateway/input-invalid, field "ops"

Only `[{ op: 'set', path: ['recall', 'depth'], value: d }]` got **past** ops validation: it is no longer rejected as
a malformed payload but as `settings/rejected` with `details.ns` - a decision taken one layer further in, about the
**namespace**, not the shape. So:

- **the ops format is `[{ op: 'set', path: [<path segments>], value }]`** - an array of ops, each carrying an `op`
  name, an **array** path and a value. Dotted paths, `{ path, set }` flags and JSON-pointer `replace` are all wrong;
- **`s1cap` is the right namespace name**, and the only thing missing is that it is not a *declared* settings
  namespace - which is the Config/schema declaration already identified as the last piece;
- once that namespace exists, the panel can write through `remote.settings.mutate` with exactly this shape, so the
  Save button no longer depends on the shipped form's internals.

The probe stays in the panel (it is additive and reports the gateway verbatim rather than claiming a save), and the
refusal messages it prints are now self-explanatory: credentials for a ref no provider declared, then settings for a
namespace no plugin declared.
### Round 39: no naming shortcut - the namespace has to be declared

Twelve combinations were probed from the panel (four ops shapes against `s1cap` and `dsh-s1cap`); none succeeded.
The two that used the now-known ops shape refused one layer in:

    s1cap/arr-op-set     -> settings/rejected, details.ns "s1cap"
    dsh-s1cap/arr-op-set -> settings/rejected, details.ns "dsh-s1cap"

Both candidate namespace names reach the namespace registry and are turned away there, so the panel cannot write by
naming an existing namespace differently: the namespace must be **declared**, which is the exported-`Config` piece.
That closes the search space - the ops format is known, the namespace name does not matter until a declaration exists,
and the declaration is the only remaining action.

The panel keeps reporting this verbatim in its own message (credentials first, because a ref no provider declared is
refused, then settings, because the namespace is undeclared), so a click on Save still tells the operator exactly
which layer is missing rather than implying the values were stored.
### Round 40: the authoritative config field inventory, dumped from the build

Dumping `resolvePluginConfig({ enabled: true })` from `packages/dsh-plugin/lib/index.js` gives the schema's required
coverage directly, instead of guessing it from source. Forty-two leaf fields, in twelve groups - the exported
`Config` must describe every one of them, or the loader will reject the profile's configuration and the plugin will
not activate at all:

    cell(string) termination(string) assemblyDeadlineMs(number) observation(string)
    rgMaintenance: mode(string) maxLagTurns(number)
    cache: reselectPolicy(string) blockTokens(number)
    tas: on(bool) tMaxChars(number) updatePolicy(string)
    recall: relevanceThreshold(window|depth|fanout)(number) tier1(string) embedModel(string)
            budgetRatio(number) minRecalledShare(number)
    tail: k(number)
    planGate: on(bool) maxPlans(number) attemptCap(number) abstainConfidence(number)
    s1: provider(string) baseUrl(string) model(string) apiKey(string) timeoutMs(number) questionsPerCall(number)
    telemetry: sessionJsonl(string) controlJsonl(string) tapeJsonl(string)
    laya: enabled(bool) preferConsoleScript(bool) host(string) port(number) healthPath(string)
          autoStart(bool) startupTimeoutMs(number) pollIntervalMs(number)

**Caveat that the dump makes visible and that would otherwise break activation:** the dump shows *defaults*, while the
profile patch sets keys the defaults do not carry - `laya.condaEnv`, `laya.condaPath`, `laya.env` (a record of
environment variables) and `s1.provider` values such as `laya-serve`. The schema has to admit those too, so it should
be written against the union of the dump and the test profile's patch, not the dump alone.

The plugin's public surface, for reference: `apply`, `inject`, `name`, `preStepMiddleware`, `resolveConfig`,
`resolvePluginConfig`, `LayaRuntime`, `DEFAULT_TELEMETRY`.
### Round 41: the volatile Config route is closed to an out-of-tree plugin - and round 13's conclusion was wrong

Two steps, gated separately, and the difference between them is the answer:

| step | suite | control records |
| --- | --- | --- |
| `config-schema.ts` present, **not** exported | 109/109 green | 1 (plugin working) |
| the same file **exported** as `Config` | the test file fails to load at all | 0 (plugin not working) |

The failure is an import error, before any assertion runs: `import z from '@deepseek-ai/schemastery'` cannot be
resolved. In a plain Node run there is no loader to map host packages, and in the real profile the control records
stop too - so the loader does not provide it to our bundle either.

**Correction to round 33/34.** That round tested `import type z from '@deepseek-ai/schemastery'`, which the TypeScript
stripper erases: nothing was imported at runtime, so the round's success proved only that an erased import changes
nothing. The third-party precedents (`dsh-browser` and another installed plugin) do import schemastery at runtime -
but they are installed **inside the application archive**, where host packages resolve, whereas an out-of-tree plugin
under a profile gets no such mapping, and schemastery is not published to npm, so it cannot be added as a dependency.

**Consequence, exactly as the user's instruction anticipated:** option (a) - write through the plugin's own config
namespace - is closed for an out-of-tree plugin, and the plugin is not going to ship a schema it cannot import. The
panel therefore keeps the honest design it already has: the three knobs are validated in the panel, `/s1-tune` writes
them and the host applies them at session start and on volatile updates, and the panel's Save reports the gateway's
refusal verbatim rather than implying a save. Option (b), `remote.commands`, remains untried.

`scripts/gen-config-schema.mjs` is kept: it generates the schema from the resolved shape, which is the right
technique if this route ever opens (for an in-tree build or a published host package), and it is how the 44-field
coverage was measured.
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
  control-plane sink; expose totals in `/s1`.
- **Acceptance:** after a real round `control.jsonl` has one `llm_call` record per model call whose token
  counts match the harness's own accounting, and `/s1` shows a plausible cost. (Corrected: this line used to say
  `session.jsonl`. That was written while the session sink was unwritten, and it contradicts the two-stream rule
  now in force — `session.jsonl` carries conversation `RawEvent`s, `llm_call` is a `TelemetryEvent` and belongs in
  the control-plane log, which is the only sink that accepts it.)
- **Status:** the `usage` shape is measured from a live probe of `assistant/message`:
  `data.usage = {inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens}`. The System-1 half
  (`s1_call`) is already live and tied out against the stub. The remaining work is the semantics of the three
  cache/input fields and the call site; `wallMs` and `approvalWaitMs` additionally need the pre-step/`agent`
  boundary, so expect this to take one more live round rather than a guess.
- **Traps:** never let a telemetry write change the call; keep the two files separate (I3/I4);
  `netLatencyMs` excludes approval waits by definition.

### N6 — Context delivery (the intervention) — **partly done, and the design was wrong once**

- **Goal (revised by measurement):** make the assembled view reach the model. What is now implemented is an
  *insertion*: the recalled block and the state proxy, as one message, placed after the last message the
  harness will append to the log for this step.
- **What the packaged harness actually does** (read out of `app.asar` with `scripts/scan-dsh-asar.cjs`; note
  that plain `node` reads nothing inside an asar and reports 0 hits for every needle, so this must be run
  under Electron-as-Node):

  ```js
  // dsh-agent-loop/lib/index.js — preStep()
  const claimed = this.inbox.claim(target, position.turn);
  const assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal));
  const context = this.runtimeContext.project(joinContextSections(renderContextSections(assembly)));
  const decision = await this.dispatch.waterfall("agent/pre-step", { messages: claimed, ...position, signal },
    () => Promise.resolve({ kind: "enter", messages: context === void 0 ? claimed : [...claimed, context] }));

  // dsh-agent-loop/lib/index.js — step(decision)
  for (const { message, intent } of commits) this.session.append("system/message", { ... }, intent);
  if (firstAttempt) for (const message of decision.messages) this.session.append("user/message", message, ...);
  const request = this.buildRequest(config, preparedCall, assembly.tools, ...);
  const stream = this.loopCtx.llm.stream(request);
  ```

- **The correction, and why the first implementation could never have worked.** `decision.messages` is the
  step's *increment* — `claimed` plus one projected context message — **not the history**. The history lives in
  the session log, and the request is built from that log. The first version of `context-delivery.ts` rewrote
  `decision.messages` into a whole model view (pinned prefix, T, recalled, tail, x, in layout order); it was
  well-formed and tested, and a live run reported `delivered: false, messagesBefore: 1` four times over. Two
  consequences, both now the module's contract:
  1. A plugin **can** add context: the message is appended to the log and is in the next request. This is the
     harness's own channel — `dsh-agent-instructions` injects its instruction block exactly this way, in
     production, with `decision.messages.toSpliced(lastClaimedIndex + 1, 0, desired)`.
  2. A plugin **cannot** suppress history. Nothing reachable from `agent/pre-step` removes a message the log
     already holds. A design claiming otherwise would leave the log asserting one thing and the model seeing
     another.
- **Done:** `policy.deliver` (C1 off — it is the only cell that leaves history to the harness; C2/C3/C4 on);
  `StepObservation.layout` exposed (add-only) so a caller can deliver rather than only report;
  `context-delivery.ts` (insertion, dedupe by payload digest, `reject`/abort/step-1 guards, insertion after the
  last claimed message, never a removal); `context_delivery` telemetry on every step, delivered or not.
- **Live verification — passed, with the evidence being the session log, not the control plane.** A C4 run with a
  tool-using conversation produced 9 delivery records, **4 with `delivered: true`**, each carrying the state proxy,
  and the injected message is in the log the request is built from:
  ```json
  {"id":"s1cap-8d321cec","sessionId":"session-…","seq":118,"kind":"user","role":"user",
   "text":"# context assembled for this step\nThe blocks below were selected by relevance to the current task…"}
  ```
  The model's own later `trace` records refer back to that material, so it was read, not just logged.
- **The bug that made delivery impossible for two rounds: the cell preset was never applied at runtime.**
  `validatePolicy` started from `defaultPolicy()` — which *is* C4 — so a profile patched to `cell: C1` ran C4's
  TAS, tier1, gate and layout while `/s1` reported C1. `cellPolicy()` was called from tests only. The first live
  attempt reported `policy.deliver is off` on all 12 steps while 8 of 12 assemblies carried a non-empty recalled
  block. Fixed in `config.ts` (`basePolicyFor`): the named cell is the base, an explicit knob in the patch still
  wins, and an unusable cell name falls back to C4 rather than to half a cell. `deliver` was also missing from
  `BOOLEAN_PATHS`, so it could not be set from a profile at all and was reported as an unknown path.
- **The next obstacle, measured on the same run — recall and delivery fire on disjoint steps.** Per step:
  | step | `blocks.recalled` | `messagesBefore` | delivered |
  |---|---|---|---|
  | #0, #2, #4, #8 | 0 | 1 | yes (state proxy) |
  | #1, #3, #5, #6, #7 | 836 – 5243 tokens | 0 | no |
  The steps that call the model claim a message and have no history yet; the steps that have history are the ones
  the harness claims nothing for, and the loop treats an empty `decision.messages` as "no step" (so nothing is
  lost — no request is made). Root cause is in `observeStep`: the window is the *payload's* segments when it has
  any, so at a turn-opening step the pool is a single user message and there is nothing to select. The comment
  there argues the graph is a superset so using it "never loses a segment the payload carried" — the direction is
  backwards: using the payload is what loses the graph's history, and that is the history the model needs.
- **Still open:** (1) `minRecalledShare` fired on **9 of 9** steps, so every S1 selection in that run was replaced by
  a recency window before delivery ever saw it — and the `blocks.recalled` tokens in the table above are that
  recency window, not an S1 selection; (2) `dsh-agent-instructions` also calls `agent.inbox.remove(id)` for its own
  prior message — S1CAP dedupes by payload text instead, measured as working (4 injections, no repeats) but not
  yet measured across a turn where the selection changes back and forth.
- **The window fix, verified live.** With `window = graph.orderedSegments()`, the steps that call the model now have
  history to select from. Same run shape, same 9 assemblies, and the delivery changed as predicted:

  | step | `blocks.recalled` | `selected` | `candidates` | `messagesBefore` | delivered | blocks |
  |---|---|---|---|---|---|---|
  | #0 | 0 | 0 | 0 | 1 | yes | stateProxy |
  | #2 | 1121 | 8 | 10 | 1 | yes | stateProxy + 8 recalled |
  | #5 | 3742 | 20 | 17 | 1 | yes | stateProxy + 20 recalled |
  | #8 | 5590 | 30 | 18 | 1 | yes | stateProxy + 30 recalled |

  4 of 9 steps delivered, **3 of them carrying recalled blocks** (0 of 4 before the fix). The injections are in the
  session log with real segment kinds in their headers: `## recalled · user · s1cap-895b6ae1`, `## recalled · trace ·
  bd29175c…`, `## recalled · toolCall · call_00_ET_sPq8liVDqSw7plNiCLre7435`.
- **The defect that run exposed: S1CAP was recalling its own delivered blocks.** That `s1cap-895b6ae1` in the
  header list above is the *previous* injection, appended to the log by the harness, segmented as an ordinary user
  message, and selected as one of the most relevant things in the conversation — because it is a summary of the
  conversation. The state proxy appeared twice in the same message for the same reason, and by the last step a
  single message carried 30 recalled blocks. A context that is mostly our own earlier output measures nothing.
  Fixed by excluding our own blocks where the recall candidates are built (`observeStep`, `isS1capInjected` in
  `segmenter.ts`, the id prefix shared with the delivery module): the graph stays a faithful record of the session
  and the tail stays verbatim, because the harness put the block in the log and the request is built from the log.
  **Not yet re-verified live** — the measurement above is from the run that found the bug.
- **The rule behind that fix, stated once so it stops being rediscovered.** *S1CAP manages which of the harness's
  own context is in the prompt; S1CAP's own output is never part of that accounting.* Two obligations, and they
  are different things that are easy to conflate:
  - **S1 calls never enter the conversation.** Already true and measured: scoring goes to the S1 backend's own
    endpoint, `s1_call` records go to `control.jsonl`, and `ControlPlaneLog.emit` throws on a session segment
    (provenance.ts). Nothing to do.
  - **S1CAP's delivered block must not become a segment.** This was violated. The block is appended to the
    session log by the harness, comes back as an ordinary user message, and from there entered the recall
    candidates (so relevance re-selected a summary of the conversation), the verbatim tail (so we re-presented
    our own text as a recent turn), and `fullTokens` — **the denominator of `wouldSaveTokens`**, so the headline
    "tokens saved" was being measured against a baseline S1CAP itself inflated. That is self-referential, and it
    is the number the whole method is judged on.
  - The gate is at ingestion, on **both** paths: `observeStep` for the step payload, and the upkeep flush in
    `step-observer.ts` for the session-event stream, which is the one production actually takes (the first
    version of this fix had only the payload path, and a test caught it). The session-content file still records
    the block: that file is a faithful record of the session, not a view of what S1CAP chose to measure. Drops
    are counted in `upkeepSelfDropped` rather than applied silently, because a filter nobody can see is a filter
    nobody can debug.
- **Deliberately not done here, and open:** the delivery mechanism still authors a block of S1CAP prose
  (`# context assembled for this step …`). That is a design choice made when the only measured channel was the
  pre-step splice, and under the rule above it is the wrong shape: the claim is about *existing* context and its
  order, not about adding a new message. The alternative worth probing is the host's own context channel
  (`systemPrompt.assemble` → `assembly.contexts` → `renderContextSections` → `runtimeContext.project`), which is
  rendered per request instead of appended to the transcript. **Not verified**: a search for a plugin-side
  context-registration API returned nothing, and `dsh-system-prompt` exports only the render/join functions. Until
  that probe is done, delivery stays an insertion, and the block's framing text is the part that most needs
  removing.
- **The probe is done, and it closes that option.** Searched the packaged source for a plugin-facing
  prompt-assembly surface:
  - `system-prompt/`, `prompt/assemble`, `systemPrompt/` as hook names: **zero hits**. There is no event a plugin
    can subscribe to for prompt assembly.
  - `assembleContextFor(agent, signal)` is imported from `@deepseek-ai/dsh-agent` and builds the contexts from the
    agent's own configuration; `contexts:` appears only in `dsh-system-prompt` and in `dsh-tool-cordis`'s
    **type catalog** (`PromptAssembly`, `PromptContext` — a list of types, not of callable services).
  - `dsh-system-prompt` exports `renderPrompt`, `renderContextSections`, `joinContextSections` — renderers, no
    registry.
  - The host's own context plugin, `dsh-agent-instructions`, injects through the same `agent/pre-step` splice, in
    production, with the same insertion rule S1CAP now uses.

  So there is exactly one channel a plugin has, and delivery is an insertion. What was wrong was the block's
  shape, not the channel, and that is now fixed: the delivered text is **quoted session content with a one-line
  provenance label each, and no S1CAP prose at all**. A bare concatenation would have failed the other way — an
  earlier turn re-sent as a fresh user message reads as something the user just said, which distorts the
  transcript — so the label is the minimum that keeps the distinction honest.
- **Open question about the method, not the code: may an authored state proxy be delivered at all?**
  Selection and ordering act on content that already exists, so they fit the rule cleanly. T is a summary S1CAP
  *writes*, which is the same category as the prose that was just removed. It is currently delivered and labelled
  `## state proxy T, written by S1CAP from this session` — labelled so a reader of the transcript can tell
  authored from quoted, not because that settles it. Two consequences worth deciding before the next experiment:
  (1) if authored T may not be delivered, C2 and C4 stop differing in *delivery* and differ only in ordering,
  which changes what the TAS axis of the ablation means; (2) the alternative is an **extractive** T — verbatim
  spans of real tool results rather than a written summary — which would keep TAS in the method while staying
  inside the rule. Not chosen unilaterally.
- **Settled, and the delivered block is now quotes only.** The requirement as stated: *S1CAP's S1 operations must
  not enter the LLM's context; they filter the harness's own context to reduce the LLM's workload.* So T is not
  delivered. It is still computed and still recorded — it can inform relevance and ordering, and the record is
  what a run is read back through — but the model does not see it. Dropping T is pinned by a test that also
  checks a selection with no T in it still gets delivered, because "T is not sent" must not quietly turn into
  "nothing is sent".
  - **T was never what decided x-first.** In the assembler, T sits at index 1 of both layouts
    (`['pinned','stateProxy','anchor','recalled','tail']` vs `['pinned','stateProxy','recalled','tail','anchor']`);
    the flag only moves the anchor. What T is: a written summary and the head of the cache-stable prefix
    (measured byte-stable within a task). With T internal, the delivery test changed from "the state proxy
    precedes the quoted turns" to "xFirst changes nothing about the delivered content" — the old assertion would
    have passed for the wrong reason.
- **The position arm of the ablation cannot be imposed on this host. Measured, and it bounds the paper.**
  A plugin's only channel appends *after the last claimed message*, and the request is built from the session
  log, so the reachable shape is `[…history…, x, quoted block]` — which is the x-**first** arrangement. The
  x-**last** arrangement needs an insertion in the middle of the log, and no splice does that. Consequences,
  stated rather than papered over:
  - Cells differing in `xFirst` (C2 vs C1, C4 vs C3) differ in what S1CAP *measures*, not in what the model
    sees. They can be compared as a counterfactual, and the honest label for that comparison is "modelled", not
    "applied".
  - The one thing the plugin *can* do to the order of what the model reads is decide the order **inside** the
    block it appends, and with only quoted turns that order is the order relevance returned them in.
  - A host-side position intervention would need a hook this DSH build does not expose (see the probe above).
- **The plan gate was blind to every model that plans with a tool. Fixed, against a measured contract.**
  The gate read candidates only from prose the model typed — a numbered or bulleted line in an assistant message —
  and its own comment said so. The host logs tool-written plans as `todo/write` session events carrying
  `TodoItem[]` (both verified in the host's own type catalog: `todo/write: { todos: TodoItem[] }`,
  `TodoItem: { content: string; status: 'pending' | 'in_progress' | 'completed' }`). Those events carry no message,
  so they adapt to nothing and hit the `raw.length === 0` early return in upkeep — which is exactly how a
  tool-planning run produced `inspected: 0`, an empty decision column, and counters that all looked healthy.
  The gate is now asked before that return, through the same code path as prose plans: same question, same
  normalization, same abstain rule, because two different gates under one column would measure the difference
  between them rather than the effect of the intervention.
  - Completed steps are dropped (a finished step is not one the model is choosing between), and the host's order
    is kept as-is, because that order *is* the model's own order — the baseline the gate is measured against.
  - The question's task context is the todos themselves. A `todo/write` event does not state the task, and
    composing one from the session would put S1CAP-written text into a System-1 question, which is the same rule
    as for the model's context.
  - `extractTodoEvent` is defensive at the `unknown` boundary: an item without a string `content` or an
    unrecognised `status` is skipped, the rest pass through. A plan list that cannot be read is a missing
    decision — the same outcome as no plan — and it says so in `todoEvents` / `todoWithPlans` rather than
    pretending to have gated something.
- **`llm_call` stays unemitted, by decision rather than by omission.** The event is declared in the frozen
  schema and the cost model reads it, but nothing produces it, which this project treats as a defect, so the
  reason is recorded here instead:
  - Usage *is* available: `assistant/message` carries `usage?: TokenUsage`, and S1CAP already ingests that event.
    `TokenUsage` is `{ inputTokens, outputTokens, totalTokens?, cacheReadTokens?, cacheWriteTokens?, reasoningTokens? }`.
  - The declared `LlmCallEvent` wants `cacheHitTokens` / `cacheMissTokens`, which are **derived**, and deriving
    them needs a fact that is not established: whether `inputTokens` already includes cache reads. Two plausible
    readings give two different cost numbers, and a cost model is exactly where a plausible-but-wrong number is
    most damaging.
  - It also wants `netLatencyMs`, and the host reports no LLM-only timing. `step/start` to `assistant/message`
    includes tool time and approval waits, so recording it under that name would be a lie about what was timed.
  - Emitting the raw usage alone under the same event name would make a record that claims to be a costed call
    and is not. The honest options are a separate additive event carrying `TokenUsage` verbatim, or nothing —
    chosen when someone needs the number, not now, and not by writing zeros.
  - Discovery still reports a candidate interpreter — that is how the panel offers a value to paste — but a
    candidate is not a configuration, and auto-accepting one would make two machines with the same profile pick
    different interpreters.
  - **The settings panel is not in this repository** (it writes through DSH's credential service and the
    plugin's Save route). What this side owes the panel is implemented: the requirement is enforced, it is
    readable from `/s1` (`configIssues.conflicts`), and `/s1 laya status` already prints `pythonPath`. The field
    itself has to be added on the panel side.
- **Where the Laya weights live: not this repository, and not the DSH install either. Verified, not assumed.**
  Probed the packaged source: `from_pretrained` and `HF_HOME` return **0 hits** across all of
  `app.asar/dsh/node_modules/@deepseek-ai`, and no `laya` package exists on disk. Nothing ships a Laya runtime,
  which is consistent with the requirement that the user supplies the Python environment — S1CAP only launches
  `laya-serve` from an interpreter the user named, and the whole model side arrives with that environment.
  - Consequence for the design: the weights are a property of the user's Laya installation, not of S1CAP, and
    `LayaConfig.model` is **not** a weights path — it is the model id sent to `/v1/systemone`.
  - `laya-serve` 0.3.21 takes no CLI flags, so the checkpoint must be resolved inside that environment: its own
    config, an environment variable, or the package's default cache. **Which one is not established**, and
    S1CAP must not invent the variable name — a guessed env var is how a launch silently uses the wrong
    checkpoint.
  - It matters more than it looks: `AGENT_BRIEF.md` records base checkpoints at near-chance on typed decisions
    (0.362 vs 0.318 random) with only the fine-tune reaching 0.766, so a run whose checkpoint cannot be named is
    a run whose System-1 answers are close to noise. "It started" is not "it scored".
  - The mechanism for a pass-through already exists (`LayaConfig.env`, whose doc already names `HF_ENDPOINT`).
    What is missing is a way for the panel to supply it: today the panel can set `pythonPath` and nothing else. A
    weights field that does not also carry the *variable name* the user's Laya reads would be a guess, so the
    pair (`weightsPath` + the env var name) is the shape to add — pending what that variable is called.
- **Traps:** `termination` stays `'model-owned'`; the pinned prefix must stay first and byte-stable; never
  remove or rewrite a message S1CAP did not add; a step with nothing claimed must insert at the **end**, since
  index 0 would put a note about the task ahead of the system instructions (this was a real bug, caught by a
  test written before the fix).

---

## 4. Rules for whoever takes over

1. **Never install into the `desktop` profile** (user decision): it carries other plugins and skills and must
   stay clean. Use a throwaway CLI profile for every experiment — `dsh --profile s1capobs --from-default-profile headless --dump-config`
   for automated rounds, `--from-default-profile web` for UI work — and delete it afterwards.
2. **Read contracts from the packaged source before coding against them.** `scripts/scan-dsh-asar.cjs`
   (`--ls`, `--dump <path> [lines]`, `--grep <path> <pattern> [before] [after]`, or bare needles) reads DSH's own
   code out of `app.asar`. **Run it under Electron-as-Node** (`$env:ELECTRON_RUN_AS_NODE="1"; & "…\DeepSeek
   Harness.exe" scripts\scan-dsh-asar.cjs …`): under plain `node` it reads nothing inside the asar and reports
   `total hits: 0` for *every* needle, including ones that certainly exist. Guessing a hook contract once killed
   a live round; a scanner that silently returns no findings nearly caused a second.
3. **`agent/pre-step`'s `decision.messages` is the step's increment, not the history.** `decision.messages` is
   `claimed` (what the inbox handed over) plus a projected context message; `dsh-agent-loop`'s `step()` appends
   it to the session log and then builds the request *from that log*. So a plugin can add context, and cannot
   remove any. See N6.
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

---

## 6. Round of 2026-09-29 (night): the live path finally runs, and what it exposed

The order was 3 → 4c → 2 → 4b → 4a, then a box-by-box audit against the method figure. All five landed. The
short version: **S1CAP had never observed a live session, and six separate faults were hiding that.** Each was
found by measurement, and the shape they share is worth naming before the list: every one of them produced a
plausible-looking number rather than an error.

### What now runs, with the evidence

| Box in the figure | State | Evidence |
| --- | --- | --- |
| `input x` → segments | done | 4 content events → 4 segments in `upkeep-path.test.ts` |
| Session-event stream is the pool | done | live `scoredPairs` 0→1→3→6→10→15, one assembly per step |
| Bounded recall + budget | done | `selected=1 recalled=7 tail=21` on a live step |
| Weights + decay | done | same records; `window-curve.mjs` shows max pairs/step == w exactly |
| S1 Assoc backend (noul relevance) | done | stub backend counted 910 `noul` questions and 0 `score` from live sessions; real recalls with `cand=22, bfs=4` |
| **Plan gate** (candidates → choice → advisory order) | done | live `plan_gate` record: `order=[p1,p2,p3]`, 1 `choice` question |
| State proxy `T` | done | live `blocks.stateProxy = 41`, **byte-stable across every step of a task** |
| Two layouts (`xFirst`) | done | one run, both arms: head 740 / tail-after-cut 0 vs head 700 |
| Cache cut pricing | done | `layoutStableTokens`, `cutAfterBlock`, `tokensAfterCut` in every record |
| Stop is model-owned | done | no code path from any gate decision to a stop; `executed: []` in the record |

### The six faults (all fixed, all with a test that would have caught them)

1. **The observer asserted non-null on an empty segment list.** `assembler.ts` then threw inside a never-throw
   guard, so a live session looked healthy while nothing was observed at all.
2. **The step payload carries no history.** `agent/pre-step` hands over `inbox.claim(...)`: one user message on
   step 1, an empty array afterwards. The conversation lives in the session-event stream — and, read out of
   `dsh-agent-loop`'s `step(decision)`, in the session log the request is built from. This was noticed here as a
   parsing problem and only became an architectural fact when it turned out to decide what delivery can be; see
   N6.
3. **Upkeep never ran.** The queue only drains when something asks; `schedule` was never passed, so `flush()` was
   called by tests and nothing else.
4. **The event payload is under `data`.** Measured envelope: `{type, seq, time, data, surfaceOp}`, where
   `user/message` keeps the message in `data` directly and `assistant/message` nests it at `data.message`. Reading
   top-level `message` — which no event has — made every content event produce nothing, and `upkeepEmpty`
   counted them as lifecycle noise.
5. **The tail block was always empty.** The pool was "segments before the anchor", but the model's own output
   arrives *after* the last user message, so the newest turns were exactly what got dropped.
6. **`/s1*` was broken at the host boundary.** `normalizeResult` accepts only `{kind:'success', text?}` or
   `{kind:'error', text}`; all four commands returned bare objects, and the tests read the raw object, so the
   assertion and the contract never met.

Two smaller ones found the same way: the observer's `onProbe` channel wrote a bare newline and **discarded its
argument** (so diagnostics went nowhere while the tape looked healthy), and `flushUpkeep()` was called as a bare
identifier from inside the object literal that defines it — a `ReferenceError` swallowed by the surrounding catch.

### Open problems, in the order they matter

Closed since first written (kept here because each was a wrong-contract class of bug, and the classes recur):

- ~~tool shapes unmeasured~~ **measured**: a live session with three tool calls probed
  `tool/call -> data = {turn, step, callId, name, arguments}` and `tool/result -> data = {turn, step, message}` —
  exactly what the adapter reads ✓, and tool segments now grow the tail in every live assembly.
- ~~`noul` vs `score`~~ **resolved toward the figure**: relevance now asks one `noul` question per candidate
  ("does retrieving this help the current segment?", P(true) = the edge weight), with the true-side mass of a raw
  distribution accepted. Live proof: the stub counted **910 `noul` questions and 0 `score`**, and the graph
  produced real recalls (`cand=22, bfs=4` on one step). A test now pins `type === 'noul'` on every question, so
  the box cannot drift back to another answer shape unnoticed.
- ~~`xFirst` not a cell dimension~~ **it is now**: `cellPolicy()` sets `xFirst = false` for C1/C3 (chronological)
  and `true` for C2/C4, and `authority.test.ts` pins the axis — the layout is the thing that differs between the
  rows a table would compare, so a preset that left it constant made the position intervention unmeasurable.
- ~~`sessionJsonl` written by nothing~~ **it is now written**: the upkeep lane hands every adapted `RawEvent` to
  a session sink, so the file holds the same events the graph consumed (11 lines in the verification run: 2 user,
  3 trace, 3 toolCall, 3 toolResult, all with unique ids and ascending host `seq`). Written from the lane rather
  than a second adapter pass, so the file and the graph cannot drift apart, and I4 still holds: content goes here,
  control records go to the other file, and the config keeps rejecting identical paths.

Open, in order:

1. **Relevance has never run against a real System-1 backend.** All live verification used the stub
   (`scripts/stub-s1-backend.mjs`), which answers from token overlap. The plumbing is proven — calls, parsing,
   weights, edges, recall — and nothing about quality. The Laya checkpoint has not been started once.
2. **In short sessions the recall floor throws away everything S1 selected.** All five live assemblies carried
   `fallback: recency-window`, including ones where the graph found 22 candidates at BFS depth 4:
   `minRecalledShare = 0.25` demanded a quarter of the recall budget filled, the sparse graph answer lost, and
   the recency window refilled the block. The intervention is computed and then discarded — which makes C3/C4
   behave like the baseline in exactly the sessions that are easiest to run. Before any table: measure the
   fallback ratio on long sessions, and tune `r`/`minRecalledShare` against it. The record distinguishes
   `candidates` (graph) from `selected` (final layout), but **not** how many the graph itself kept — add
   `graphSelected` if the ratio turns out to matter.
3. **A leftover tuning file silently overrode the ablation cell.** Found the hard way: a `tuning.json` written by
   an earlier panel test (`window=1200, xFirst=false`) overrode C4's preset for an entire verification session —
   the run was not what its cell says it was, and no counter said so. Activation now logs every knob the tuning
   file changes with old→new and the note *"delete the tuning file for a cell-pure run"*; the stale file is gone.
   Experiment rule: **cell runs start by deleting the tuning file**, and the wiring record's `xFirst`/`recall`
   fields are checked against the cell before a session is trusted.
4. **`llm_call` is still unwired — the contract is now measured, so the only thing left is the call site.**
   The System-1 half of cost accounting is done: every successful backend call emits an `s1_call` record
   (`role` = assoc/decide, `kind` = noul/choice, questions, input/output tokens, ms, provider), and a live run
   tied out exactly — 15 `s1_call` records against the stub's 15 `decideCalls`, and the question totals agree
   at 108. The LLM half needs the host's `usage`, whose shape is now measured rather than guessed: a live probe
   of `assistant/message` reports `data.usage = {inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
   totalTokens}`. What is still missing is the *semantics* (does `inputTokens` include the cache fields?), so the
   right next step is a one-shot probe of the actual values or the packaged DSH usage type, then emit `llm_call`
   from the same upkeep lane. Guessing the mapping would put wrong numbers in the one record the cost tables read.
5. **The `sessionJsonl` sink is declared in config and written by nothing.** Either implement it or remove it
   from `TelemetryConfig` — a declared sink that stays empty reads as a broken feature.
6. **The plan gate only sees markdown lists.** When the model records a plan through the todo tool instead of
   writing `1. …` lines (observed live), the gate correctly skips, and its coverage is therefore narrower than
   "the model's plans". Worth reading the todo call as a second plan source.
7. **`pinned` is still a fixed 700 tokens of harness prompt.** The system prompt is captured and pinned, but no
   attempt has been made to keep volatile content out of it (item 4a's leftover half).

### Verification aid added this round

`scripts/stub-s1-backend.mjs` — a local `/v1/systemone` that answers `score`, `noul` and `choice` from token
overlap and counts what it was asked (`GET /health`). It exists because the Laya checkpoint is a large download
and the plumbing had never been exercised; point a throwaway profile at it with `s1.baseUrl`. It is a
**verification aid, not a deliverable**: numbers produced against it say nothing about quality.

