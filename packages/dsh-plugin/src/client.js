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

        /** Load both refs and mirror the stored tuning into the inputs. */
        const load = React.useCallback(async () => {
          try {
            const key = await readValue(REF);
            const tuning = await readValue(TUNING_REF);
            let nextDepth = '';
            let nextTau = '';
            let nextWin = '';
            if (typeof tuning === 'string') {
              const parts = tuning.trim().split(/\s+/);
              const d = Number(parts[0]);
              const r = Number(parts[1]);
              const w = Number(parts[2]);
              if (Number.isInteger(d) && d > 0) nextDepth = String(d);
              if (Number.isFinite(r) && r >= 0 && r <= 1) nextTau = String(r);
              if (Number.isInteger(w) && w >= 1) nextWin = String(w);
            }
            setDepth(nextDepth);
            setTau(nextTau);
            setWin(nextWin);
            setState({ phase: 'ready', configured: key !== undefined, message: '' });
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
        const saveTuning = React.useCallback(async () => {
          const d = Number(depth);
          const r = Number(tau);
          const w = Number(win);
          if (depth.trim() === '' || !Number.isInteger(d) || d <= 0) {
            setState((s) => ({ ...s, message: 'depth d must be an integer greater than 0' }));
            return;
          }
          if (win.trim() === '' || !Number.isInteger(w) || w < 1) {
            setState((s) => ({ ...s, message: 'window w must be an integer of at least 1' }));
            return;
          }
          if (tau.trim() === '' || !Number.isFinite(r) || r < 0 || r > 1) {
            setState((s) => ({ ...s, message: 'threshold r must be a number between 0 and 1' }));
            return;
          }
          try {
            const response = await write(TUNING_REF, { depth: d, tau: r });
            const refused = refusal(response);
            if (refused !== undefined) {
              // Probe the settings channel as well: the plugin's own config may be exposed as a settings namespace
              // (its patch row id is "s1cap"), which is the designed home for non-secret values. The response is
              // reported verbatim so the accepted shape is learned rather than guessed at.
              const settings = ctx.remote.settings;
              let probe = 'no remote.settings';
              if (settings && typeof settings.mutate === 'function') {
                const shapes = [
                  ['set-path', [{ op: 'set', path: 'recall.depth', value: d }, { op: 'set', path: 'recall.tau', value: r }]],
                  ['set-op', [{ set: { 'recall.depth': d, 'recall.tau': r } }]],
                  ['merge', [{ merge: { recall: { depth: d, tau: r } } }]],
                ];
                const results = [];
                for (const [label, ops] of shapes) {
                  try {
                    const answer = await settings.mutate('s1cap', ops, undefined);
                    results.push(label + ':' + JSON.stringify(answer));
                    if (answer && answer.ok !== false) break;
                  } catch (err) {
                    results.push(label + ':threw ' + String(err));
                  }
                }
                probe = results.join(' | ');
              }
              setState((s) => ({ ...s, message: 'credentials refused (' + refused + '); settings probe → ' + probe }));
              return;
            }
            const stored = await readValue(TUNING_REF);
            setState((s) => ({
              ...s,
              message:
                stored === undefined
                  ? 'tuning save was accepted but the store reports no value yet'
                  : 'recall tuning saved (' + stored + ') — it takes effect at the next session start',
            }));
          } catch (err) {
            setState((s) => ({ ...s, message: 'tuning save failed: ' + String(err) }));
          }
        }, [depth, tau, write]);

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
              min: '1',
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
