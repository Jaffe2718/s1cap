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
 *   1. the backend choice: one radio over **Jev (cloud)** and **Laya (local)**, because the host enforces one
 *      System-1 backend at a time (`singleBackendIssues`). Only the selected backend's fields are live; the other
 *      set stays on screen but dimmed, so switching back does not lose what was typed. The choice is written as
 *      `provider=` on the same command line as everything else, and the panel re-reads it from the host after a
 *      save instead of trusting the form;
 *   2. the Jev key, which belongs to the Jev half. It never passes through a command's raw input — that would put
 *      it in the session transcript — and the panel only ever shows whether a key exists, never its value;
 *   3. the recall tuning — **BFS depth d** (integer, d > 0), **relevance threshold r** (0 <= r <= 1), the
 *      **scoring window w** (integer >= 64) and the **anchor wait** in milliseconds (integer 0..60000, 0 disables
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
    const DEFAULT_DEPTH = 2;
    const DEFAULT_TAU = 0.55;
    const DEFAULT_WINDOW = 1024;
    /**
     * Matches `defaultPolicy().recall.anchorWaitMs`: how long a step may wait for the anchor's own scoring row.
     *
     * The measured System-1 relevance call has a median of 15.3 s, so the default wait covers the typical case while
     * staying well under it; the fail-open rule in the assembler is the backstop when it does not. 0 disables it.
     */
    const DEFAULT_WAIT = 10000;
    /** the same bound core's NUMBER_RULES carries for `recall.anchorWaitMs`, so the panel refuses what the host would drop */
    const MAX_WAIT = 60000;
    /** matches `defaultPolicy().xFirst`, so an unreachable host shows the layout that is actually in effect */
    const DEFAULT_XFIRST = true;
    /** matches `resolvePluginConfig()`'s default `s1.provider`, so an unreachable host still shows a real backend */
    const DEFAULT_PROVIDER = 'jev';
    /**
     * The two backends the radio offers, in the host's own spelling (`S1ProviderName` in `@s1cap/core`).
     *
     * Only these two: the policy allows more names (`edgejev`, `kev`, `none`), but a radio is a choice between
     * the two backends this panel can configure — the cloud one and the local one — and offering a third entry
     * whose fields live nowhere would be a button that cannot be made to work. The host accepts any name from its
     * own list, so nothing here narrows what the command line can do.
     */
    const PROVIDER_CHOICES = [
      { value: 'jev', label: 'Jev (cloud)' },
      { value: 'laya-serve', label: 'Laya (local)' },
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

    /** The panel: the backend radio with its two field sets, the recall knobs, and the layout switch. */
    function makeSection(ctx) {
      return function S1CapSection() {
        const [state, setState] = React.useState({ phase: 'loading', configured: false, message: '' });
        const [draft, setDraft] = React.useState('');
        const [depth, setDepth] = React.useState('');
        const [tau, setTau] = React.useState('');
        const [win, setWin] = React.useState('');
        const [wait, setWait] = React.useState('');
        const [xFirst, setXFirst] = React.useState(DEFAULT_XFIRST);
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
            let nextXFirst = DEFAULT_XFIRST;
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
              if (Number.isInteger(eff.depth) && eff.depth > 0) nextDepth = String(eff.depth);
              if (Number.isFinite(eff.relevanceThreshold) && eff.relevanceThreshold >= 0 && eff.relevanceThreshold <= 1) {
                nextTau = String(eff.relevanceThreshold);
              }
              if (Number.isInteger(eff.window) && eff.window >= 64) nextWin = String(eff.window);
              // 0 is a real value here - it disables the anchor wait - so this tests the type and the bound rather
              // than truthiness. The `>= 0` half is what keeps a disabled wait from reading back as "not stored".
              if (Number.isInteger(eff.anchorWaitMs) && eff.anchorWaitMs >= 0 && eff.anchorWaitMs <= MAX_WAIT) {
                nextWait = String(eff.anchorWaitMs);
              }
              if (typeof eff.xFirst === 'boolean') nextXFirst = eff.xFirst;
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
                if (Number.isInteger(d) && d > 0) nextDepth = String(d);
                if (Number.isFinite(r) && r >= 0 && r <= 1) nextTau = String(r);
                if (Number.isInteger(w) && w >= 64) nextWin = String(w);
                const legacySwitch = String(parts[3] ?? '').toLowerCase();
                if (['1', 'on', 'true', 'yes'].includes(legacySwitch)) nextXFirst = true;
                else if (['0', 'off', 'false', 'no'].includes(legacySwitch)) nextXFirst = false;
                note = 'read from the legacy credential entry; the tuning route is unreachable';
              }
            }
            setDepth(nextDepth);
            setTau(nextTau);
            setWin(nextWin);
            setWait(nextWait);
            setXFirst(nextXFirst);
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
         * Validate against the two rules the panel states — d an integer greater than 0, r between 0 and 1 — and
         * refuse anything else instead of sending a value the host would silently drop.
         */
          /**
           * Validate against the stated rules and report **every** offending field, each with its own name. A single
           * first-failure message reads as if it were about the field just edited, which is how this misled us once
           * when depth was still empty and the window was the field being typed into.
           */
          const saveTuning = React.useCallback(async () => {
            const d = Number(depth);
            const r = Number(tau);
            const w = Number(win);
            const waitMs = Number(wait);
            const problems = [];
            if (depth.trim() === '' || !Number.isInteger(d) || d <= 0) {
              problems.push('depth d must be an integer greater than 0');
            }
            if (tau.trim() === '' || !Number.isFinite(r) || r < 0 || r > 1) {
              problems.push('threshold r must be a number between 0 and 1');
            }
            if (win.trim() === '' || !Number.isInteger(w) || w < 64) {
              problems.push('window w must be an integer of at least 64');
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
          // tokens are the legacy order (`d r w xFirst`) that older writes and the credential string use, and adding
          // a fifth would put a duration where `xFirst` is read from.
          //
          // The radio rides along too, and on *both* buttons: the provider is part of the form, so a save that
          // touched only the knobs must not quietly leave a radio the user just moved pointing at the old backend.
          const body = [
            d + ' ' + r + ' ' + w + ' xFirst=' + (xFirst ? 'on' : 'off'),
            'wait=' + waitMs,
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
            // Trust the host, not the form: whatever it stored becomes what the panel shows.
            if (Number.isInteger(eff.depth) && eff.depth > 0) setDepth(String(eff.depth));
            if (Number.isFinite(eff.relevanceThreshold)) setTau(String(eff.relevanceThreshold));
            if (Number.isInteger(eff.window) && eff.window >= 64) setWin(String(eff.window));
            if (Number.isInteger(eff.anchorWaitMs) && eff.anchorWaitMs >= 0 && eff.anchorWaitMs <= MAX_WAIT) {
              setWait(String(eff.anchorWaitMs));
            }
            if (typeof eff.xFirst === 'boolean') setXFirst(eff.xFirst);
            if (PROVIDER_CHOICES.some((choice) => choice.value === eff.provider)) setProvider(eff.provider);
            const summary =
              'saved: provider=' + eff.provider + ' d=' + eff.depth + ' r=' + eff.relevanceThreshold + ' w=' + eff.window +
                ' wait=' + eff.anchorWaitMs + ' xFirst=' + (eff.xFirst ? 'on' : 'off') +
                (layaFields.length > 0 ? ' + ' + layaFields.length + ' Laya field(s)' : '') +
                (answer.persisted ? '' : ' (in effect, not persisted: ' + (answer.persistError ?? 'unknown') + ')');
            // Re-read the host so the backend status and the conflict line reflect what was just written. The
            // host's PUT answer echoes the recall knobs only, so without this second read the panel would show a
            // stale conflict next to the path that just resolved it. `load()` resets the message, so the summary
            // is applied after it.
            await load();
            setState((s) => ({ ...s, message: summary }));
          } catch (err) {
            setState((s) => ({ ...s, message: 'tuning save failed: ' + String(err) }));
          }
        }, [depth, tau, win, wait, xFirst, provider, layaPath, layaWeights, layaEnvVar, load]);

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
         * Kept mounted while Laya is selected — dimmed, not deleted — so a key half-typed before switching away is
         * still there on the way back. The status dot belongs to this half and not to the panel: "no key stored"
         * says nothing about a run that is using the local backend.
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

        return e(
          'div',
          { style: S.wrap },
          e('h2', { style: S.title }, 'S1CAP'),
          e(
            'p',
            { style: S.intro },
            'S1CAP puts a cheap System-1 decision model in charge of which context the agent sees and in which ' +
              'order its own plans run. This panel holds the choice of System-1 backend, the credential the cloud ' +
              'one needs, the recall knobs the ablation varies, and the layout switch.',
          ),
          // Backend first: it is the choice everything below it is answered by, and the host allows exactly one of
          // the two. The fields of the selected backend sit directly under its radio; the other set stays on
          // screen, dimmed, so switching back does not lose what was typed.
          e('h3', { style: S.subtitle }, 'System-1 backend'),
          e(
            'p',
            { style: S.note },
            'Exactly one backend is active at a time: the host refuses a session that names two and demotes it to ' +
              'no System-1 calls at all, so this is one choice and not two switches. Saving writes the selection as ' +
              'provider= on the same command line the knobs use, and the radio is then re-read from the host rather ' +
              'than from this form.',
          ),
          ...PROVIDER_CHOICES.map(providerRadio),
          jevGroup,
          layaGroup,
          // A conflict is shown here rather than only logged, because it is the difference between "this field is
          // empty" and "this field is empty and that is why the session is making no System-1 calls". It sits
          // outside the two dimmed field sets on purpose: it is about the session, not about one backend's fields.
          ...(layaStatus.conflicts.length > 0
            ? [e('p', { style: S.note }, 'Conflict: ' + layaStatus.conflicts.join('; '))]
            : []),
          e('h3', { style: S.subtitle }, 'Recall tuning'),
          e(
            'p',
            { style: S.note },
            'BFS depth d bounds how many hops recall may walk the association graph (integer, d > 0). The relevance ' +
              'threshold r is the edge weight a segment must reach to be recalled (0 ≤ r ≤ 1). The window w is how many ' +
              'recent segments each new segment is scored against, and it is what bounds the System-1 cost of scoring. ' +
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
              min: '1',
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
              min: '64',
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
          // width pushed it past the edge of the panel - cut off in the user's screenshot, on a row that had no room
          // to give. The row above also wraps now, so a narrower panel degrades to two lines instead of losing a
          // control.
          e(
            'div',
            { style: S.row },
            e('button', { style: S.button, type: 'button', onClick: () => void saveTuning() }, 'Save tuning'),
          ),
          e('h3', { style: S.subtitle }, 'Layout'),
          e(
            'div',
            { style: S.row },
            e('input', {
              id: 's1cap-xfirst',
              type: 'checkbox',
              checked: xFirst,
              onChange: (event) => setXFirst(event.target.checked),
            }),
            e(
              'label',
              { style: S.label, htmlFor: 's1cap-xfirst' },
              'x-first: put the current task before recalled history',
            ),
          ),
          e(
            'p',
            { style: S.note },
            xFirst
              ? 'On — [pinned | T | x | recalled | tail]. The task is read first and the evidence follows it, the ' +
                  '"state then information" order; x also joins the byte-stable head, which holds while the task does ' +
                  'not change.'
              : 'Off — [pinned | T | recalled | tail | x]. History sits immediately before the task and x stays last, ' +
                  'so everything above x is history and only the pinned prefix is stable.',
          ),
          e(
            'p',
            { style: S.note },
            'Cache: the stable head is the pinned prefix plus T' +
              (xFirst ? ' plus the task; ' : '; ') +
              'and a re-selection re-prefills everything after it. The per-assembly numbers are in each ' +
              'control-plane record as layoutStableTokens and tokensAfterCut.',
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
