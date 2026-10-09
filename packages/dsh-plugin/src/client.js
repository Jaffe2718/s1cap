/**
 * S1CAP settings panel — the plugin's **browser half** (N4).
 *
 * Plain JavaScript on purpose: JSX is not erasable syntax, this repository ships no bundler, and the loader
 * hands the factory a CommonJS `require` (read from a working third-party plugin, `dsh-pet`, whose client half
 * does exactly `const react = require('react')`).
 *
 * The contract, every part of it read from shipped code rather than guessed:
 *   - the file is picked up through `window.__ModuleLoader__.load({ id, factory })`, the factory **is** the module
 *     body: it receives `require`, declares its own `module`, and returns `module.exports` (`{ apply, inject, name }`);
 *   - the half injects the `slots` service and registers into the named slot `settings.section` with
 *     `ctx.slots.register(meta, Component)` inside `ctx.slots.inject(name, generator)`;
 *   - `meta` carries `name`, a unique `id`, an `order` and a locale-aware `label` thunk;
 *   - the host is reached through the client RPC namespaces `remote` / `remote.credentials` (declared in `inject`;
 *     Cordis throws on access to a namespace that was not injected).
 *
 * Three things live here:
 *   1. the backend choice: one radio over **Jev (cloud)**, **Laya (local)** and **Off** (`provider=none`), because
 *      the host enforces one System-1 backend at a time (`singleBackendIssues`). Only the selected backend's fields
 *      are live; the other sets stay on screen but dimmed, so switching back does not lose what was typed. The
 *      choice is written as `provider=` on the same command line as everything else, and the panel re-reads it from
 *      the host after a save instead of trusting the form;
 *   2. the Jev key, which belongs to the Jev half. It never passes through a command's raw input — that would put
 *      it in the session transcript — and the panel only ever shows whether a key exists, never its value;
 *   3. the recall tuning — **BFS depth d** (integer, 1..16), **relevance threshold r** (0 <= r <= 1), the
 *      **scoring window w** (integer >= 4) and the **anchor wait** in milliseconds (integer 0..60000, 0 disables
 *      it) — saved through the host's `/s1cap-7340/tuning` route as the same command line `/s1-tune` takes and
 *      applied by the host to the live policy at session start;
 *   4. the local Laya backend's own fields: the Python interpreter, the weights cache and the environment variable
 *      that points at it. These are the fields whose absence the host reports as a conflict, and a conflicted
 *      session makes no System-1 calls — so a panel that could not write them left the local backend unreachable
 *      through the UI, while the conflict message told the user to fill in a control that did not exist.
 */
window.__ModuleLoader__.load({
  id: 'dsh-s1cap',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const fail = (err) => {
      try {
        window.__S1CAP_CLIENT_ERROR__ = String((err && err.stack) || err);
      } catch {
        /* nothing left to do */
      }
    };
    try {
    const React = require('react');
    const e = React.createElement;

    /** `<scope>/<id>` refs; the host half reads the same two (packages/dsh-plugin/src/credentials.ts). */
    const REF = 's1cap/jev';
    const TUNING_REF = 's1cap/tuning';
    /**
     * The panel's own fallback copies of the three recall defaults, used to fill the boxes when the host route does
     * not answer. Every one of them mirrors `defaultPolicy().recall` (`packages/core/src/types.ts`), which is the
     * authority: `depth` 16, `threshold` 0.55, `window` 16 since 2026-10-05 — the window fell from 1024 because a
     * window at or above a session's segment count does nothing and cost 4.3x the session it had to serve, and the
     * depth rose from 2 to carry the reach the window gave up (`w x d`). The panel cannot import the policy (it is
     * the browser-side half), so these are the one copy, and `test/panel.test.ts` fails if they drift from it.
     */
    const DEFAULT_DEPTH = 16;
    const DEFAULT_TAU = 0.55;
    const DEFAULT_WINDOW = 16;
    /**
     * Matches `defaultPolicy().recall.anchorWaitMs`: how long a step may wait for the anchor's own scoring row.
     *
     * The measured System-1 relevance call has a median of 15.3 s, so the default wait covers the typical case while
     * staying well under it; the fail-open rule in the assembler is the backstop when it does not. 0 disables it.
     */
    const DEFAULT_WAIT = 10000;
    /** the same bound core's NUMBER_RULES carries for `recall.anchorWaitMs`, so the panel refuses what the host would drop */
    const MAX_WAIT = 60000;
    /** the same bounds core's NUMBER_RULES carries for `recall.depth` (1..16) and `recall.window` (>= 4) */
    const MIN_DEPTH = 1;
    const MAX_DEPTH = 16;
    const MIN_WINDOW = 4;
    /**
     * The two values the arm selector offers, in the host's own spelling (`TracePlacement` in `@s1cap/core`).
     *
     * `trace-as-state` is the paper's method — `M([T, x, q])`, the trace placed *before* the long context — and it
     * is the default because that is what the project is testing. `trace-append` is the paper's own control:
     * `M([x, T, q])`, the same two elements with order as the only difference. The panel labels them by those
     * names rather than by "before/after context", because the arm is what a round measures and the mechanism is
     * an implementation detail of it.
     */
    const TRACE_CHOICES = [
      { value: 'trace-as-state', label: 'Trace as State — [T, x, q] (the paper\'s method)' },
      { value: 'trace-append', label: 'Trace Append — [x, T, q] (the control)' },
    ];
    /** matches `defaultPolicy().tracePlacement`, so an unreachable host shows the arm actually in effect */
    const DEFAULT_TRACE = 'trace-as-state';
    /**
     * The question's position is **not** offered, and its absence is the point (2026-10-05).
     *
     * This panel used to render a `q` selector with `last` and `first`, on the reading that the question's position
     * was a setting that merely happened not to be the paper's variable. The paper fixes it: "We therefore separate
     * the question from the long context and place it at the end of every input" (arXiv:2609.02702 §4.1), with
     * `[T, x, q]` and `[x, T, q]` as its two arms — so `first` rendered `[T, q, x]`, which is neither arm, and a
     * control that offers a layout the build cannot justify is worse than no control. The axis is deleted from the
     * policy, and the two spellings a previous panel wrote are handled by the host: `xFirst=on`/`q=first` are refused
     * with the sentence that retired them and `xFirst=off`/`q=last` are noted, both of which this panel shows (see
     * the legacy read in `load()` and the note under the arm selector).
     */
    /** matches `resolvePluginConfig()`'s default `s1.provider`, so an unreachable host still shows a real backend */
    const DEFAULT_PROVIDER = 'jev';
    /**
     * The three choices the radio offers, in the host's own spelling (`S1ProviderName` in `@s1cap/core`).
     *
     * `none` is the third and it is not a backend: `resolveS1Backend` answers `{provider:'none', mode:'none'}`,
     * `buildBackend` then constructs no client at all, and every System-1 call site answers `undefined` — which is
     * the lexical fallback, not an error. It is offered here because an arm can need a session with System-1 off —
     * the two control arms carry `s1.provider: none` in `bench/cells/` — and until now the only way to get one was
     * to hand-edit a profile.
     *
     * The policy allows more names (`edgejev`, `kev`), and they stay out: a radio is a choice between the backends
     * this panel can configure, and an entry whose fields live nowhere would be a button that cannot be made to
     * work. The host accepts any name from its own list, so nothing here narrows what the command line can do.
     */
    const PROVIDER_CHOICES = [
      { value: 'jev', label: 'Jev (cloud)' },
      { value: 'laya-serve', label: 'Laya (local)' },
      { value: 'none', label: 'Off' },
    ];

    const name = 'dsh-s1cap';
    const inject = ['slots', 'remote', 'remote.credentials', 'remote.settings'];

    const S = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '12px', maxWidth: '640px' },
      title: { margin: 0, fontSize: '16px', fontWeight: 500 },
      subtitle: { margin: '6px 0 0', fontSize: '14px', fontWeight: 500 },
      intro: { margin: 0, fontSize: '13px', opacity: 0.75, lineHeight: 1.5 },
      row: { display: 'flex', gap: '8px', alignItems: 'center' },
      /**
       * A row that may wrap. The knobs and the Laya paths are rows of inputs of fixed width, and at this panel's
       * width the last control used to be pushed past the edge — the save button was cut off in the user's
       * screenshot. `flexWrap` is the structural half of that fix; the button also gets a row of its own.
       */
      rowWrap: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
      /**
       * One backend's field set. The unselected backend is dimmed rather than unmounted: its values stay in the
       * React state and on screen, so choosing the other radio and coming back does not lose what was typed.
       */
      group: (active) => ({
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        marginLeft: '15px',
        opacity: active ? 1 : 0.45,
      }),
      dot: (ok) => ({
        width: '8px',
        height: '8px',
        borderRadius: '50%',
        background: ok ? 'var(--dsw-alias-state-success-primary, #2f9e6b)' : 'var(--dsw-alias-state-error-primary, #d05a4a)',
      }),
      input: { flex: 1, minWidth: '180px', height: '32px', padding: '0 10px', font: 'inherit', borderRadius: '6px', border: '0.5px solid var(--dsw-alias-border-l4, #c8d1dd)' },
      number: { width: '96px', height: '32px', padding: '0 8px', font: 'inherit', borderRadius: '6px', border: '0.5px solid var(--dsw-alias-border-l4, #c8d1dd)' },
      /** the environment-variable name: short by nature, and 96px clipped the `HF_HOME` placeholder */
      envName: { width: '128px', height: '32px', padding: '0 8px', font: 'inherit', borderRadius: '6px', border: '0.5px solid var(--dsw-alias-border-l4, #c8d1dd)' },
      label: { fontSize: '12px', opacity: 0.75, minWidth: '14px' },
      radioLabel: { fontSize: '13px', fontWeight: 500 },
      radio: { margin: 0 },
      button: { height: '32px', padding: '0 14px', font: 'inherit', borderRadius: '6px', border: 'none', cursor: 'pointer' },
      note: { margin: 0, fontSize: '12px', opacity: 0.75 },
    };

    /** The panel: the backend radio with its three blocks, the recall knobs, and the paper's arm selector. */
    function makeSection(ctx) {
      return function S1CapSection() {
        const [state, setState] = React.useState({ phase: 'loading', configured: false, message: '' });
        const [draft, setDraft] = React.useState('');
        const [depth, setDepth] = React.useState('');
        const [tau, setTau] = React.useState('');
        const [win, setWin] = React.useState('');
        const [wait, setWait] = React.useState('');
        const [chunk, setChunk] = React.useState('512');
        const [omega, setOmega] = React.useState('64');
        const [shortContext, setShortContext] = React.useState('32768');
        /** the paper's variable: which of its two second-pass arms this session lays out — and the only axis */
        const [trace, setTrace] = React.useState(DEFAULT_TRACE);
        /**
         * Which backend the radio selects.
         *
         * There is exactly one of these because there is exactly one System-1 backend per session: the host's
         * `singleBackendIssues` refuses a profile that names two, and the refusal demotes the session to
         * `provider=none`, which makes no System-1 calls at all. Two independent sections (a Jev block and a Laya
         * block, as this panel used to render) said the opposite of what the host enforces.
         */
        const [provider, setProvider] = React.useState(DEFAULT_PROVIDER);
        /**
         * The local backend's three fields.
         *
         * The host half has accepted these since the beginning (`parseTuningArgs` reads `laya=` / `weights=` /
         * `weightsEnv=` and `readTuningFile` reads the same keys), and the panel had no control for any of them, so
         * the one field that decides whether System-1 calls happen at all could only be set by hand-editing a JSON
         * file in the harness home. The conflict message told the user to fill in a control that did not exist.
         *
         * They are held as strings, and an empty box is *omitted* from the command line rather than sent as empty:
         * the host merges what it receives into what is stored, so sending nothing leaves the stored value alone
         * while sending an empty value would erase it.
         */
        const [layaPath, setLayaPath] = React.useState('');
        const [layaWeights, setLayaWeights] = React.useState('');
        const [layaEnvVar, setLayaEnvVar] = React.useState('');
        /** what the host says the backend is doing, so the panel can report the effect of what it just wrote */
        const [layaStatus, setLayaStatus] = React.useState({ state: '', conflicts: [] });

        /**
         * Read one stored string. The store declares several read entry points and the host probes them the same
         * way (packages/dsh-plugin/src/credentials.ts), so an unknown surface degrades to "not stored" instead of
         * throwing into the panel.
         */
        const readValue = React.useCallback(async (ref) => {
          const store = ctx.remote.credentials;
          for (const method of ['resolve', 'readRecord', 'read', 'get']) {
            if (typeof store[method] !== 'function') continue;
            try {
              const raw = await store[method](ref);
              const value =
                typeof raw === 'string'
                  ? raw
                  : raw !== null && typeof raw === 'object' && typeof raw.value === 'string'
                    ? raw.value
                    : raw !== null && typeof raw === 'object' && typeof raw.apiKey === 'string'
                      ? raw.apiKey
                      : undefined;
              if (value !== undefined && value !== '') return value;
            } catch {
              /* try the next entry point */
            }
          }
          return undefined;
        }, []);

        /**
         * Fill the three inputs from the host, not from a hard-coded default.
         *
         * The route is the authoritative source because it is where Save actually writes: reading the credential
         * store instead left the panel showing d=2/r=0.55/w=1024 right next to values that were already in effect.
         * The credential string is still consulted as a fallback for a profile whose web server never answered, and
         * when both are silent the panel says so rather than looking merely unconfigured.
         */
        const load = React.useCallback(async () => {
          try {
            const key = await readValue(REF);
            let nextDepth = String(DEFAULT_DEPTH);
            let nextTau = String(DEFAULT_TAU);
            let nextWin = String(DEFAULT_WINDOW);
            let nextWait = String(DEFAULT_WAIT);
            let nextChunk = '512', nextOmega = '64', nextShort = '32768';
            let nextTrace = DEFAULT_TRACE;
            /** `null` means "the host did not name a backend I offer": leave the radio where the user left it. */
            let nextProvider = null;
            let nextLayaPath = '';
            let nextLayaWeights = '';
            let nextLayaEnvVar = '';
            let nextLayaStatus = { state: '', conflicts: [] };
            let note = '';
            let answered = false;
            try {
              const response = await fetch('/s1cap-7340/tuning');
              const answer = await response.json();
              const eff = answer?.effective ?? {};
              const pending = answer?.pending ?? {};
              if (Number.isInteger(pending.chunkTokens ?? eff.chunkTokens)) nextChunk = String(pending.chunkTokens ?? eff.chunkTokens);
              if (Number.isInteger(pending.overlapTokens ?? eff.overlapTokens)) nextOmega = String(pending.overlapTokens ?? eff.overlapTokens);
              if (Number.isInteger(eff.shortContextTokens)) nextShort = String(eff.shortContextTokens);
              if (answer.restartRequired) note = 'c / omega saved; restart DeepSeek Harness to apply';
              if (Number.isInteger(eff.depth) && eff.depth >= MIN_DEPTH && eff.depth <= MAX_DEPTH) nextDepth = String(eff.depth);
              if (Number.isFinite(eff.relevanceThreshold) && eff.relevanceThreshold >= 0 && eff.relevanceThreshold <= 1) {
                nextTau = String(eff.relevanceThreshold);
              }
              if (Number.isInteger(eff.window) && eff.window >= MIN_WINDOW) nextWin = String(eff.window);
              // 0 is a real value here - it disables the anchor wait - so this tests the type and the bound rather
              // than truthiness. The `>= 0` half is what keeps a disabled wait from reading back as "not stored".
              if (Number.isInteger(eff.anchorWaitMs) && eff.anchorWaitMs >= 0 && eff.anchorWaitMs <= MAX_WAIT) {
                nextWait = String(eff.anchorWaitMs);
              }
              if (TRACE_CHOICES.some((choice) => choice.value === eff.tracePlacement)) nextTrace = eff.tracePlacement;
              /**
               * The radio, filled from the host rather than from the form.
               *
               * `configuredProvider` is what the config asks for; `provider` is what the session resolved to, which
               * is `none` whenever a conflict demoted it. The configured one is preferred, because a backend whose
               * interpreter is still missing is *selected* and conflicted, not unselected — and a radio that jumped
               * to the other backend there would hide the field the conflict is about. `null` (neither name is one
               * this radio offers) leaves the radio alone rather than inventing a selection.
               */
              const s1Status = answer?.status?.s1 ?? {};
              const reportedProvider =
                typeof s1Status.configuredProvider === 'string' ? s1Status.configuredProvider : s1Status.provider;
              if (PROVIDER_CHOICES.some((choice) => choice.value === reportedProvider)) nextProvider = reportedProvider;
              /**
               * The Laya fields come from `stored` first, because that is the file the next launch reads: showing
               * the live `supplied` copy would show an empty box for a path that is stored and about to be used,
               * and the user would retype something already saved. `supplied` answers the different question
               * "what is the backend running with right now", which is what the status line below reports.
               */
              const stored = answer?.stored ?? {};
              /**
               * A stored file that still carries the question's old axis says so here, in the panel's own message
               * line: the host reads `refused`/`notes` out of `tuning.json` (`readTuningFile`, packages/dsh-plugin/
               * src/index.ts) and `stored` is where this route echoes them back. `refused` is the half that matters —
               * a stored `xFirst: true` / `questionPlacement: 'first'` asks for `[T, q, x]`, which no setting
               * produces, and the panel must not look as though it applied one. The notes are the harmless half (the
               * question-last spellings), and they are shown for the same reason: a file that asked for something
               * this build no longer has must not be read in silence.
               */
              const refusals = Array.isArray(stored.refused) ? stored.refused : [];
              if (refusals.length > 0) {
                note = refusals.map((refusal) => String(refusal && refusal.message ? refusal.message : refusal)).join(' ');
              } else if (Array.isArray(stored.notes) && stored.notes.length > 0) {
                note = stored.notes.map((entry) => String(entry)).join(' ');
              }
              const supplied = answer?.status?.laya?.supplied ?? {};
              const pick = (a, b) => (typeof a === 'string' && a !== '' ? a : typeof b === 'string' ? b : '');
              nextLayaPath = pick(stored.layaPythonPath, supplied.pythonPath);
              nextLayaWeights = pick(stored.layaWeightsCacheDir, supplied.weightsCacheDir);
              nextLayaEnvVar = pick(stored.layaWeightsEnvVar, supplied.weightsEnvVar);
              // The wait is read from both, and `stored` wins for the same reason the Laya fields prefer it: that is
              // the file the next launch reads, so showing the live copy would show a default for a value that is
              // saved and about to be used. It is a number, not a string, so `pick` above does not apply to it.
              if (Number.isInteger(stored.anchorWaitMs) && stored.anchorWaitMs >= 0 && stored.anchorWaitMs <= MAX_WAIT) {
                nextWait = String(stored.anchorWaitMs);
              }
              const conflicts = answer?.status?.laya?.conflicts;
              nextLayaStatus = {
                state: String(answer?.status?.laya?.state?.status ?? ''),
                // The conflict list is the difference between "the field is empty" and "the field is empty and that
                // is why this session makes no System-1 calls", so it is carried into the render rather than logged.
                conflicts: Array.isArray(conflicts) ? conflicts.map((c) => String(c)) : [],
              };
              answered = true;
            } catch {
              note = 'the tuning route did not answer; showing the built-in defaults';
            }
            if (!answered) {
              const legacy = await readValue(TUNING_REF);
              if (typeof legacy === 'string') {
                const parts = legacy.trim().split(/\s+/);
                const d = Number(parts[0]);
                const r = Number(parts[1]);
                const w = Number(parts[2]);
                if (Number.isInteger(d) && d >= MIN_DEPTH && d <= MAX_DEPTH) nextDepth = String(d);
                if (Number.isFinite(r) && r >= 0 && r <= 1) nextTau = String(r);
                if (Number.isInteger(w) && w >= MIN_WINDOW) nextWin = String(w);
                const legacySwitch = String(parts[3] ?? '').toLowerCase();
                // The fourth slot is the question's old setting, under every spelling it had. It is no longer a
                // setting at all — the paper places the question last in every condition, so `q` is the last block by
                // construction and the axis was deleted rather than renamed — and this panel offers no control for it.
                // What it *can* still do is tell the truth about what that stored string asks for: `on`/`first` wants
                // `[T, q, x]`, which no layout produces (the host refuses that spelling with the same sentence), and
                // `off`/`last` wants what every layout does now. Saying it here matters because this branch runs when
                // the host route is unreachable, which is exactly when nobody else will say it. The arm has no legacy
                // spelling — it did not exist before this panel did — so it stays at the default.
                const wantsFirst = ['first', 'qfirst', '1', 'on', 'true', 'yes'].includes(legacySwitch);
                const wantsLast = ['last', 'qlast', '0', 'off', 'false', 'no'].includes(legacySwitch);
                note = wantsFirst
                  ? 'the stored tuning string asks for the question first (`' + legacySwitch + '`), which is not a ' +
                    'layout this build has: the paper separates the question from the long context and places it at ' +
                    'the end of every input, and the setting that could move it was deleted, so that field was ' +
                    'ignored. The only layout axis is the trace placement. (Read from the legacy credential entry; ' +
                    'the tuning route is unreachable.)'
                  : wantsLast
                    ? 'the stored tuning string carries the retired question setting (`' + legacySwitch + '`): the ' +
                      'question is last in every layout now, so it asked for what already happens and nothing was ' +
                      'changed. (Read from the legacy credential entry; the tuning route is unreachable.)'
                    : 'read from the legacy credential entry; the tuning route is unreachable';
              }
            }
            setDepth(nextDepth);
            setTau(nextTau);
            setWin(nextWin);
            setWait(nextWait);
            setChunk(nextChunk); setOmega(nextOmega); setShortContext(nextShort);
            setTrace(nextTrace);
            if (nextProvider !== null) setProvider(nextProvider);
            setLayaPath(nextLayaPath);
            setLayaWeights(nextLayaWeights);
            setLayaEnvVar(nextLayaEnvVar);
            setLayaStatus(nextLayaStatus);
            setState({ phase: 'ready', configured: key !== undefined, message: note });
          } catch (err) {
            setState({ phase: 'ready', configured: false, message: 'could not read the credential store: ' + String(err) });
          }
        }, [readValue]);

        React.useEffect(() => {
          void load();
        }, [load]);

        /**
         * Write one value. The host's `set` does **not** throw on refusal — it returns `{ ok, error }` (the shipped
         * key UI checks exactly that) — so the response is returned and every caller must honour it.
         */
        const write = React.useCallback(async (ref, value) => {
          const store = ctx.remote.credentials;
          if (typeof store.set !== 'function') {
            return { ok: false, error: { message: 'the store exposes no set()' } };
          }
          // Two positional arguments, verified by probing: one argument answers "credentials/set expected 2
          // argument(s), got 1". The refusal a string value draws ("invalid payload") comes from the `:ref` half of
          // the boundary - it admits credentials a provider registered, not arbitrary plugin values - which is why
          // the tuning knobs need a settings namespace rather than this store. Recorded in docs/STATUS.md.
          return await store.set(ref, value);
        }, []);

        /** Turn a store response into an error message, or undefined when the write was accepted. */
        const refusal = (response) => {
          if (response === undefined || response === null) return undefined;
          if (response.ok === false) {
            const message = response.error && response.error.message ? response.error.message : 'refused';
            return String(message);
          }
          return undefined;
        };

        const save = React.useCallback(async () => {
          const value = draft.trim();
          if (value === '') return;
          try {
            const response = await write(REF, value);
            const refused = refusal(response);
            if (refused !== undefined) {
              setState((s) => ({ ...s, message: 'key save refused: ' + refused }));
              return;
            }
            setDraft('');
            await load();
            const stored = await readValue(REF);
            setState((s) => ({
              ...s,
              message: stored === undefined ? 'key save was accepted but the store reports no value yet' : 'key saved',
            }));
          } catch (err) {
            setState((s) => ({ ...s, message: 'key save failed: ' + String(err) }));
          }
        }, [draft, load, write]);

        /**
         * Validate against the rules the panel states — d an integer in 1..16, r between 0 and 1, w an integer at
         * least 4 — and report **every** offending field, each with its own name, instead of sending a value the host
         * would silently drop. A single first-failure message reads as if it were about the field just edited, which
         * is how this misled us once when depth was still empty and the window was the field being typed into.
         */
          const saveTuning = React.useCallback(async () => {
            const d = Number(depth);
            const r = Number(tau);
            const w = Number(win);
            const waitMs = Number(wait);
            const problems = [];
            const c = Number(chunk), om = Number(omega), s = Number(shortContext);
            if (chunk.trim() === '' || !Number.isInteger(c) || c < 64 || c > 8192) problems.push('c must be an integer 64..8192 tokens');
            if (omega.trim() === '' || !Number.isInteger(om) || om < 0 || om > 4096 || om >= c) problems.push('omega must be 0..4096 and smaller than c');
            if (shortContext.trim() === '' || !Number.isInteger(s) || s < 0 || s > 1048576) problems.push('s must be an integer 0..1048576 tokens');
            if (depth.trim() === '' || !Number.isInteger(d) || d < MIN_DEPTH || d > MAX_DEPTH) {
              problems.push('depth d must be an integer between ' + MIN_DEPTH + ' and ' + MAX_DEPTH);
            }
            if (tau.trim() === '' || !Number.isFinite(r) || r < 0 || r > 1) {
              problems.push('threshold r must be a number between 0 and 1');
            }
            if (win.trim() === '' || !Number.isInteger(w) || w < MIN_WINDOW) {
              problems.push('window w must be an integer of at least ' + MIN_WINDOW);
            }
            // 0 is accepted and means "do not wait": the host drops a value outside 0..60000 rather than clamping it,
            // so refusing it here is what keeps the form from looking saved next to a wait that never took effect.
            if (wait.trim() === '' || !Number.isInteger(waitMs) || waitMs < 0 || waitMs > MAX_WAIT) {
              problems.push('wait must be an integer between 0 and ' + MAX_WAIT + ' milliseconds (0 disables it)');
            }
            if (problems.length > 0) {
              setState((s) => ({ ...s, message: problems.join('; ') }));
              return;
            }
          // One fetch, the way dsh-pet's panel does it: PUT the same text the command line takes, and let the
          // response body decide whether the save happened. There is no probe here any more - the host answers
          // with the effective triple, so a save is proven by that answer rather than by the absence of an error.
          //
          // The provider and the Laya fields ride on that same command line, because the host already parses them
          // there (`parseTuningArgs`): one transport, one validator, and the panel and `/s1-tune` cannot drift
          // apart in what they accept. Paths are quoted, and quoting is load-bearing rather than cosmetic - the
          // tokenizer keeps a quoted run as one token, so an unquoted `D:/Program Files/python.exe` arrives as
          // `D:/Program`. A field left empty is omitted instead of sent empty: the host merges, so omitting keeps
          // the stored value while sending "" would try to store nothing.
          const stripQuotes = (value) => value.trim().replace(/"/g, '');
          const layaFields = [];
          const layaPathValue = stripQuotes(layaPath);
          const layaWeightsValue = stripQuotes(layaWeights);
          const layaEnvVarValue = stripQuotes(layaEnvVar);
          if (layaPathValue !== '') layaFields.push('laya="' + layaPathValue + '"');
          if (layaWeightsValue !== '') layaFields.push('weights="' + layaWeightsValue + '"');
          if (layaEnvVarValue !== '') layaFields.push('weightsEnv=' + layaEnvVarValue);
          // The wait rides on the same command line under its keyed name. It has no positional slot: the first four
          // tokens are the legacy `d r w <question>` order that older writes and the credential string use, and
          // adding a fifth would put a duration where a question token is still read from.
          //
          // The arm goes on under its own keyed name rather than into the positional slot, and **the question does
          // not go on at all**: `trace=` is the paper's variable and the only layout axis, while the question's
          // position stopped being a setting when the axis behind it was deleted (the paper places `q` last in every
          // condition, and the panel no longer renders a control for it). Writing `q=last` here would put a spelling
          // on every save that the host reads only to note as retired.
          //
          // The radio rides along too, and on *both* buttons: the provider is part of the form, so a save that
          // touched only the knobs must not quietly leave a radio the user just moved pointing at the old backend.
          const body = [
            d + ' ' + r + ' ' + w,
            'trace=' + trace,
            'wait=' + waitMs,
            'c=' + c, 'omega=' + om, 's=' + s,
            'provider=' + provider,
          ]
            .concat(layaFields)
            .join(' ');
          setState((s) => ({ ...s, message: 'saving...' }));
          try {
            const response = await fetch('/s1cap-7340/tuning', {
              method: 'PUT',
              headers: { 'content-type': 'text/plain' },
              body: body,
            });
            const answer = await response.json();
            if (!response.ok || answer.ok !== true) {
              setState((s) => ({ ...s, message: 'tuning save refused: ' + (answer.reason ?? answer.persistError ?? 'HTTP ' + response.status) }));
              return;
            }
            const eff = answer.effective ?? {};
            const pending = answer.pending ?? {};
            if (Number.isInteger(pending.chunkTokens ?? eff.chunkTokens)) setChunk(String(pending.chunkTokens ?? eff.chunkTokens));
            if (Number.isInteger(pending.overlapTokens ?? eff.overlapTokens)) setOmega(String(pending.overlapTokens ?? eff.overlapTokens));
            if (Number.isInteger(eff.shortContextTokens)) setShortContext(String(eff.shortContextTokens));
            // Trust the host, not the form: whatever it stored becomes what the panel shows.
            if (Number.isInteger(eff.depth) && eff.depth >= MIN_DEPTH && eff.depth <= MAX_DEPTH) setDepth(String(eff.depth));
            if (Number.isFinite(eff.relevanceThreshold)) setTau(String(eff.relevanceThreshold));
            if (Number.isInteger(eff.window) && eff.window >= MIN_WINDOW) setWin(String(eff.window));
            if (Number.isInteger(eff.anchorWaitMs) && eff.anchorWaitMs >= 0 && eff.anchorWaitMs <= MAX_WAIT) {
              setWait(String(eff.anchorWaitMs));
            }
            if (TRACE_CHOICES.some((choice) => choice.value === eff.tracePlacement)) setTrace(eff.tracePlacement);
            if (PROVIDER_CHOICES.some((choice) => choice.value === eff.provider)) setProvider(eff.provider);
            // The retirement notes the host answered with, if the command line carried one (`q=last`, `xFirst=off`):
            // the panel never writes such a token itself, so this is for a body assembled by something else — and it
            // is shown for the same reason the host prints it, so that nothing about the deleted axis is silent.
            const saveNotes = Array.isArray(answer.notes) ? answer.notes.map((entry) => String(entry)) : [];
            const summary =
              'saved: provider=' + eff.provider + ' d=' + eff.depth + ' r=' + eff.relevanceThreshold + ' w=' + eff.window +
                ' wait=' + eff.anchorWaitMs + ' trace=' + eff.tracePlacement +
                ' c=' + (pending.chunkTokens ?? eff.chunkTokens ?? c) + ' omega=' + (pending.overlapTokens ?? eff.overlapTokens ?? om) + ' s=' + (eff.shortContextTokens ?? s) +
                (answer.restartRequired ? ' — restart DeepSeek Harness to apply c / omega' : '') +
                (layaFields.length > 0 ? ' + ' + layaFields.length + ' Laya field(s)' : '') +
                (answer.persisted ? '' : ' (in effect, not persisted: ' + (answer.persistError ?? 'unknown') + ')') +
                (saveNotes.length > 0 ? ' — ' + saveNotes.join(' ') : '');
            // Re-read the host so the backend status and the conflict line reflect what was just written. The
            // host's PUT answer echoes the recall knobs only, so without this second read the panel would show a
            // stale conflict next to the path that just resolved it. `load()` resets the message, so the summary
            // is applied after it.
            await load();
            setState((s) => ({ ...s, message: summary }));
          } catch (err) {
            setState((s) => ({ ...s, message: 'tuning save failed: ' + String(err) }));
          }
        }, [depth, tau, win, wait, chunk, omega, shortContext, trace, provider, layaPath, layaWeights, layaEnvVar, load]);

        const clear = React.useCallback(async () => {
          try {
            const store = ctx.remote.credentials;
            if (typeof store.unset === 'function') await store.unset(REF);
            await load();
            setState((s) => ({ ...s, message: 'cleared' }));
          } catch (err) {
            setState((s) => ({ ...s, message: 'clear failed: ' + String(err) }));
          }
        }, [load]);

        /**
         * One radio row. Exactly one of these is checked, because the host allows exactly one backend: the choice
         * is a property of the session, not two independent switches that may both be on.
         */
        const providerRadio = (choice) =>
          e(
            'div',
            { key: 'provider-' + choice.value, style: S.row },
            e('input', {
              id: 's1cap-provider-' + choice.value,
              style: S.radio,
              type: 'radio',
              name: 's1cap-backend',
              value: choice.value,
              checked: provider === choice.value,
              onChange: () => setProvider(choice.value),
            }),
            e('label', { style: S.radioLabel, htmlFor: 's1cap-provider-' + choice.value }, choice.label),
          );

        /**
         * The Jev half: its key status, the key itself, and the two key buttons.
         *
         * Kept mounted while another choice is selected — dimmed, not deleted — so a key half-typed before switching
         * away is still there on the way back. The status dot belongs to this half and not to the panel: "no key
         * stored" says nothing about a run that is using the local backend or no backend at all.
         */
        const jevGroup = e(
          'div',
          { style: S.group(provider === 'jev') },
          e(
            'div',
            { style: S.row },
            e('span', { style: S.dot(state.configured) }),
            e('span', { style: S.note }, state.phase === 'loading' ? 'checking…' : state.configured ? 'a Jev key is stored' : 'no Jev key stored'),
          ),
          e(
            'div',
            { style: S.rowWrap },
            e('input', {
              style: S.input,
              type: 'password',
              value: draft,
              placeholder: 'paste the Jev API key',
              autoComplete: 'off',
              spellCheck: false,
              onChange: (event) => setDraft(event.target.value),
            }),
            e('button', { style: S.button, type: 'button', onClick: () => void save(), disabled: draft.trim() === '' }, 'Save key'),
            e('button', { style: S.button, type: 'button', onClick: () => void clear(), disabled: !state.configured }, 'Clear key'),
          ),
          e(
            'p',
            { style: S.note },
            'The key is stored by the harness credential store and never written to a log, a control-plane record or ' +
              'the conversation.',
          ),
        );

        /**
         * The Laya half: the interpreter, the weights cache, the variable that points at it, and the Save button
         * that writes all three (plus the selected backend) through the same route the knobs use.
         *
         * The cache note says where an empty box resolves to, because that is the one thing about this field a user
         * cannot see: an empty cache is `./.s1cap/laya-cache` under the *harness home*, not under whatever
         * directory the host was started from.
         */
        const layaGroup = e(
          'div',
          { style: S.group(provider === 'laya-serve') },
          e(
            'p',
            { style: S.note },
            'The local System-1 backend runs from a Python interpreter, and these three fields are what the host ' +
              'reads to launch it. A missing interpreter is not a cosmetic gap: it is a conflict, and a conflicted ' +
              'session is demoted to observation mode and makes no System-1 calls at all - so a path that no one ' +
              'can type is a backend that can never run. Empty boxes are left out of the save, so they keep ' +
              'whatever is already stored rather than clearing it. Empty *weights* means S1CAP\u2019s own cache, ' +
              './.s1cap/laya-cache resolved against the harness home (DSH_HOME) rather than the working directory.',
          ),
          e(
            'div',
            { style: S.rowWrap },
            e('label', { style: S.label, htmlFor: 's1cap-laya-path' }, 'python'),
            e('input', {
              id: 's1cap-laya-path',
              style: S.input,
              type: 'text',
              value: layaPath,
              placeholder: 'D:/conda/envs/laya_py/python.exe',
              spellCheck: false,
              autoComplete: 'off',
              onChange: (event) => setLayaPath(event.target.value),
            }),
          ),
          e(
            'div',
            { style: S.rowWrap },
            e('label', { style: S.label, htmlFor: 's1cap-laya-weights' }, 'weights'),
            e('input', {
              id: 's1cap-laya-weights',
              style: S.input,
              type: 'text',
              value: layaWeights,
              placeholder: 'empty = ./.s1cap/laya-cache under the harness home',
              spellCheck: false,
              autoComplete: 'off',
              onChange: (event) => setLayaWeights(event.target.value),
            }),
            e('label', { style: S.label, htmlFor: 's1cap-laya-env' }, 'var'),
            e('input', {
              id: 's1cap-laya-env',
              style: S.envName,
              type: 'text',
              value: layaEnvVar,
              placeholder: 'HF_HOME',
              spellCheck: false,
              autoComplete: 'off',
              onChange: (event) => setLayaEnvVar(event.target.value),
            }),
          ),
          e(
            'div',
            { style: S.rowWrap },
            e('button', { style: S.button, type: 'button', onClick: () => void saveTuning() }, 'Save backend'),
            e(
              'span',
              { style: S.note },
              layaStatus.state === '' ? 'the host did not report a backend state' : 'backend: ' + layaStatus.state,
            ),
          ),
        );

        /**
         * The Off choice's own block — the only one with no fields, and the only one whose meaning cannot be read
         * off its label.
         *
         * The text is load-bearing rather than decorative. A researcher who reads "Off" as "the C0 baseline" then
         * measures something other than what they think: recall selection is decided by the cell preset
         * (`cellPolicy`), not by this radio, and C0/C1 are the cells that switch it off (`recall.tier1 = 'off'`,
         * which leaves the recalled block empty). Off inside a C2 profile leaves recall selecting — from lexical
         * edges, because with no client there is no System-1 judgement to score them with.
         */
        const offGroup = e(
          'div',
          { style: S.group(provider === 'none') },
          e(
            'p',
            { style: S.note },
            'Off writes provider=none: no System-1 judgement happens at all, so relevance scoring falls back to the ' +
              'lexical scorer (shared tokens over the two segments) and the association graph keeps growing on ' +
              'lexical edges only. It does not turn recall selection off — which blocks recall may select is the ' +
              'cell preset\u2019s decision (`cellPolicy` in @s1cap/core), and C0/C1 are the cells that disable it ' +
              '(`recall.tier1 = \'off\'`, so their recalled block is empty). Off inside a C2 profile is therefore ' +
              '"no System-1, recall still selecting", which is not a cell: Off means no System-1, not C0. Both save ' +
              'buttons carry the selection.',
          ),
        );

        return e(
          'div',
          { style: S.wrap },
          e('h2', { style: S.title }, 'S1CAP'),
          e(
            'p',
            { style: S.intro },
            'S1CAP puts a cheap System-1 decision model in charge of which context the agent sees and in which ' +
              'order its own plans run. This panel holds the choice of System-1 backend (or Off, which makes no ' +
              'System-1 calls at all), the credential the cloud one needs, the recall knobs the ablation varies, ' +
              'and the layout switch.',
          ),
          // Backend first: it is the choice everything below it is answered by, and the host allows exactly one of
          // the three. The fields of the selected backend sit directly under its radio; the other sets stay on
          // screen, dimmed, so switching back does not lose what was typed. Off has no fields and carries the text
          // that says what it does and does not do.
          e('h3', { style: S.subtitle }, 'System-1 backend'),
          e(
            'p',
            { style: S.note },
            'Exactly one backend is active at a time: the host refuses a session that names two and demotes it to ' +
              'no System-1 calls at all, so this is one choice and not two switches. Off is the third choice and it ' +
              'writes provider=none rather than naming a backend. Saving writes the selection as provider= on the ' +
              'same command line the knobs use, and the radio is then re-read from the host rather than from this ' +
              'form.',
          ),
          ...PROVIDER_CHOICES.map(providerRadio),
          jevGroup,
          layaGroup,
          offGroup,
          // A conflict is shown here rather than only logged, because it is the difference between "this field is
          // empty" and "this field is empty and that is why the session is making no System-1 calls". It sits
          // outside the dimmed backend blocks on purpose: it is about the session, not about one backend's fields.
          ...(layaStatus.conflicts.length > 0
            ? [e('p', { style: S.note }, 'Conflict: ' + layaStatus.conflicts.join('; '))]
            : []),
          e('h3', { style: S.subtitle }, 'Recall tuning'),
          e(
            'p',
            { style: S.note },
            'BFS depth d bounds how many hops recall may walk the association graph (integer, ' + MIN_DEPTH + '..' +
              MAX_DEPTH + '; it is what carries the walk\'s reach, at `w x d` segments, and raising it costs the ' +
              'scoring lane nothing while scoring is eager). The relevance ' +
              'threshold r is the edge weight a segment must reach to be recalled (0 ≤ r ≤ 1). The window w is how many ' +
              'recent segments each new segment is scored against, and it is what bounds the System-1 cost of scoring ' +
              '— but only once it is smaller than the session\'s segment count: a window the session never reaches ' +
              'scores every pair and costs the full quadratic. ' +
              'The wait is how long a step may hold for the newest user segment\'s own scoring row to be judged by the ' +
              'System-1 backend before it assembles anyway, in milliseconds (a measured relevance call has a median of ' +
              '15.3 s; 0 turns the wait off, and the assembler then admits the pairs the backend never judged as unknown). ' +
              'The host reads all of them at session start and /s1 reports the effective values.',
          ),
          e(
            'div',
            { style: S.rowWrap },
            e('label', { style: S.label, htmlFor: 's1cap-depth' }, 'd'),
            e('input', {
              id: 's1cap-depth',
              style: S.number,
              type: 'number',
              min: String(MIN_DEPTH),
              max: String(MAX_DEPTH),
              step: '1',
              value: depth,
              placeholder: String(DEFAULT_DEPTH),
              onChange: (event) => setDepth(event.target.value),
            }),
            e('label', { style: S.label, htmlFor: 's1cap-tau' }, 'r'),
            e('input', {
              id: 's1cap-tau',
              style: S.number,
              type: 'number',
              min: '0',
              max: '1',
              step: '0.05',
              value: tau,
              placeholder: String(DEFAULT_TAU),
              onChange: (event) => setTau(event.target.value),
            }),
            e('label', { style: S.label, htmlFor: 's1cap-window' }, 'w'),
            e('input', {
              id: 's1cap-window',
              style: S.number,
              type: 'number',
              min: String(MIN_WINDOW),
              step: '1',
              value: win,
              placeholder: String(DEFAULT_WINDOW),
              onChange: (event) => setWin(event.target.value),
            }),
            // The anchor wait, in milliseconds. It sits beside the knobs because it is one: it decides how long a step
            // may hold for the newest user segment's own scoring row, which is the difference between recalling from
            // the current task and recalling from nothing. 0 is a legal value and turns it off.
            e('label', { style: S.label, htmlFor: 's1cap-wait' }, 'wait'),
            e('input', {
              id: 's1cap-wait',
              style: S.number,
              type: 'number',
              min: '0',
              max: String(MAX_WAIT),
              step: '1',
              value: wait,
              placeholder: String(DEFAULT_WAIT),
              onChange: (event) => setWait(event.target.value),
            }),
          ),
          // The save button gets a row of its own. It used to sit at the end of the knob row, which at this panel's
          e('h3', { style: S.subtitle }, 'Segmentation and context protection'),
          e('p', { style: S.note }, 'c: chunkTokens; omega (ω): overlapTokens; s: shortContextTokens. Natural paragraphs first, sentence boundaries next, length as a fallback. Below min(s, half the input budget), original tool evidence is preserved; s=0 disables short-context protection. Compression still requires at least 1024 tokens and 5% net savings. S1 scoring continues. Changes to c / omega require restarting DeepSeek Harness; s applies immediately.'),
          e('div', { style: S.rowWrap },
            ...[
              ['s1cap-chunk', 'c', chunk, setChunk, 64, 8192],
              ['s1cap-omega', 'ω', omega, setOmega, 0, 4096],
              ['s1cap-short-context', 's', shortContext, setShortContext, 0, 1048576],
            ].flatMap(([id, label, value, setter, min, max]) => [
              e('label', { style: S.label, htmlFor: id }, label),
              e('input', { id, style: S.number, type: 'number', min: String(min), max: String(max), step: '1', value,
                onChange: event => setter(event.target.value) }),
            ]),
          ),
          // width pushed it past the edge of the panel - cut off in the user's screenshot, on a row that had no room
          // to give. The row above also wraps now, so a narrower panel degrades to two lines instead of losing a
          // control.
          e(
            'div',
            { style: S.row },
            e('button', { style: S.button, type: 'button', onClick: () => void saveTuning() }, 'Save tuning'),
          ),
          e('h3', { style: S.subtitle }, 'Layout — the paper\'s arm'),
          e(
            'div',
            { style: S.row },
            e('label', { style: S.label, htmlFor: 's1cap-trace' }, 'trace'),
            e(
              'select',
              {
                id: 's1cap-trace',
                value: trace,
                onChange: (event) => setTrace(event.target.value),
                style: S.input,
              },
              ...TRACE_CHOICES.map((choice) =>
                e('option', { key: choice.value, value: choice.value }, choice.label),
              ),
            ),
          ),
          e(
            'p',
            { style: S.note },
            trace === 'trace-as-state'
              ? 'Trace as State — [pinned | T | recalled | tail | q]: the trace is placed before the long context, ' +
                  'which is the method this project is testing, and the question stays last.'
              : 'Trace Append — [pinned | recalled | tail | T | q]: the same trace after the long context, the paper\'s ' +
                  'own control arm. Nothing but the order of T and the context differs from Trace as State.',
          ),
          // No question selector, and the note says why rather than leaving its absence to be read as an oversight.
          // The panel used to offer `q` first/last; the paper fixes it last in every condition ("place it at the end
          // of every input"), so `first` laid out [T, q, x] — neither of the paper's two arms — and the axis was
          // deleted from the policy rather than renamed. A stored `xFirst`/`questionPlacement` from an older panel is
          // read by the host and reported here: the question-first spellings are refused with the sentence that
          // retired them, the question-last ones are noted, and neither is silent.
          e(
            'p',
            { style: S.note },
            'The question is last in every layout and is not a setting: the paper separates it from the long context ' +
              'and places it "at the end of every input", so `q` is the final block of every recorded order. The ' +
              'question-first spelling an older panel could write (`xFirst=on`, `q=first`) asks for a layout this ' +
              'build does not have and is refused by the host, not silently ignored.',
          ),
          e(
            'p',
            { style: S.note },
            'Cache: the stable head is the pinned prefix' +
              (trace === 'trace-as-state' ? ' plus T' : '') +
              '; the question is always behind it, because it is always last. A re-selection re-prefills everything ' +
              'after the head. The per-assembly numbers are in each control-plane record as layoutStableTokens and ' +
              'tokensAfterCut.',
          ),
          e('p', { style: S.note }, state.message),
          e(
            'p',
            { style: S.note },
            'Refs: ' + REF + ' · ' + TUNING_REF + '. The local Laya backend needs no credential; its interpreter, ' +
              'weights cache and environment variable are the fields above, saved through the same route the knobs ' +
              'use. Status, counters and the control-plane log are visible through the /s1 command.',
          ),
        );
      };
    }

    function apply(ctx) {
      const Section = makeSection(ctx);
      ctx.slots.inject('settings.section', function* () {
        yield ctx.slots.register(
          { name: 'settings.section', id: 's1cap-config', order: 30, label: () => 'S1CAP', inject: () => ({}) },
          Section,
        );
      });
    }

    const api = { apply, inject, name };
    module.exports = api;
    return module.exports;
    } catch (err) {
      fail(err);
      // Degrade to an inert but valid plugin rather than failing the entry.
      module.exports = { name: 'dsh-s1cap', inject: [], apply() {} };
      return module.exports;
    }
  },
});
