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
 * Two things live here:
 *   1. the Jev key. It never passes through a command's raw input — that would put it in the session transcript —
 *      and the panel only ever shows whether a key exists, never its value;
 *   2. the recall tuning: **BFS depth d** (integer, d > 0) and **relevance threshold r** (0 <= r <= 1), stored as
 *      the plain string `"<d> <r>"` under `s1cap/tuning` and applied by the host at session start.
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

    const name = 'dsh-s1cap';
    const inject = ['slots', 'remote', 'remote.credentials', 'remote.settings'];

    const S = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '12px', maxWidth: '640px' },
      title: { margin: 0, fontSize: '16px', fontWeight: 500 },
      subtitle: { margin: '6px 0 0', fontSize: '14px', fontWeight: 500 },
      intro: { margin: 0, fontSize: '13px', opacity: 0.75, lineHeight: 1.5 },
      row: { display: 'flex', gap: '8px', alignItems: 'center' },
      dot: (ok) => ({
        width: '8px',
        height: '8px',
        borderRadius: '50%',
        background: ok ? 'var(--dsw-alias-state-success-primary, #2f9e6b)' : 'var(--dsw-alias-state-error-primary, #d05a4a)',
      }),
      input: { flex: 1, height: '32px', padding: '0 10px', font: 'inherit', borderRadius: '6px', border: '0.5px solid var(--dsw-alias-border-l4, #c8d1dd)' },
      number: { width: '96px', height: '32px', padding: '0 8px', font: 'inherit', borderRadius: '6px', border: '0.5px solid var(--dsw-alias-border-l4, #c8d1dd)' },
      label: { fontSize: '12px', opacity: 0.75, minWidth: '14px' },
      button: { height: '32px', padding: '0 14px', font: 'inherit', borderRadius: '6px', border: 'none', cursor: 'pointer' },
      note: { margin: 0, fontSize: '12px', opacity: 0.75 },
    };

    /** The panel: the Jev key plus the two recall knobs the ablation actually varies. */
    function makeSection(ctx) {
      return function S1CapSection() {
        const [state, setState] = React.useState({ phase: 'loading', configured: false, message: '' });
        const [draft, setDraft] = React.useState('');
        const [depth, setDepth] = React.useState('');
        const [tau, setTau] = React.useState('');
        const [win, setWin] = React.useState('');

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
                note = 'read from the legacy credential entry; the tuning route is unreachable';
              }
            }
            setDepth(nextDepth);
            setTau(nextTau);
            setWin(nextWin);
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
           * Validate against the three stated rules and report **every** offending field, each with its own
           * letter. A single first-failure message reads as if it were about the field just edited, which is how
           * this misled us once when depth was still empty and the window was the field being typed into.
           */
          const saveTuning = React.useCallback(async () => {
            const d = Number(depth);
            const r = Number(tau);
            const w = Number(win);
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
            if (problems.length > 0) {
              setState((s) => ({ ...s, message: problems.join('; ') }));
              return;
            }
          // One fetch, the way dsh-pet's panel does it: PUT the same text the command line takes, and let the
          // response body decide whether the save happened. There is no probe here any more - the host answers
          // with the effective triple, so a save is proven by that answer rather than by the absence of an error.
          setState((s) => ({ ...s, message: 'saving...' }));
          try {
            const response = await fetch('/s1cap-7340/tuning', {
              method: 'PUT',
              headers: { 'content-type': 'text/plain' },
              body: d + ' ' + r + ' ' + w,
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
            setState((s) => ({
              ...s,
              message:
                'saved: d=' + eff.depth + ' r=' + eff.relevanceThreshold + ' w=' + eff.window +
                  (answer.persisted ? '' : ' (in effect, not persisted: ' + (answer.persistError ?? 'unknown') + ')'),
            }));
          } catch (err) {
            setState((s) => ({ ...s, message: 'tuning save failed: ' + String(err) }));
          }
        }, [depth, tau, win]);

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

        return e(
          'div',
          { style: S.wrap },
          e('h2', { style: S.title }, 'S1CAP — System-1 backend'),
          e(
            'p',
            { style: S.intro },
            'S1CAP puts a cheap System-1 decision model in charge of which context the agent sees and in which ' +
              'order its own plans run. This panel holds the credential for the cloud System-1 backend (Jev) and the ' +
              'two recall knobs the ablation varies.',
          ),
          e(
            'div',
            { style: S.row },
            e('span', { style: S.dot(state.configured) }),
            e('span', { style: S.note }, state.phase === 'loading' ? 'checking…' : state.configured ? 'a Jev key is stored' : 'no Jev key stored'),
          ),
          e(
            'div',
            { style: S.row },
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
          e('h3', { style: S.subtitle }, 'Recall tuning'),
          e(
            'p',
            { style: S.note },
            'BFS depth d bounds how many hops recall may walk the association graph (integer, d > 0). The relevance ' +
              'threshold r is the edge weight a segment must reach to be recalled (0 ≤ r ≤ 1). The host reads both at ' +
              'session start and /s1 reports the effective values.',
          ),
          e(
            'div',
            { style: S.row },
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
            e('button', { style: S.button, type: 'button', onClick: () => void saveTuning() }, 'Save tuning'),
          ),
          e('p', { style: S.note }, state.message),
          e(
            'p',
            { style: S.note },
            'Refs: ' + REF + ' · ' + TUNING_REF + '. The local Laya backend needs no key; status, counters and the ' +
              'control-plane log are visible through the /s1 command.',
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
