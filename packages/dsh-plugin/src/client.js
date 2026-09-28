/**
 * S1CAP settings panel — the plugin's **browser half** (N4).
 *
 * Plain JavaScript on purpose: JSX is not erasable syntax, this repository ships no bundler, and the loader
 * hands the factory a CommonJS `require` (read from a working third-party plugin, `dsh-pet`, whose client half
 * does exactly `const react = require('react')`).
 *
 * The contract, every part of it read from shipped code rather than guessed:
 *   - the file is picked up through `window.__ModuleLoader__.load({ id, factory })`, the factory returns
 *     `{ apply, inject, name }`;
 *   - the half injects the `slots` service and registers into the named slot `settings.section` with
 *     `ctx.slots.register(meta, Component)` inside `ctx.slots.inject(name, generator)`;
 *   - `meta` carries `name`, a unique `id`, an `order` and a locale-aware `label` thunk;
 *   - the host is reached through the client RPC namespace `remote.credentials` (declared in `inject`), whose
 *     `describe([ref])` reports whether a credential exists — the same call the shipped API-key screen makes.
 *
 * The key itself never passes through a command's raw input: that would put it in the session transcript. It goes
 * to the credential store, and the panel only ever shows whether a key exists, never its value.
 */
window.__ModuleLoader__.load({
  id: 'dsh-s1cap',
  factory: () => (...args) => {
    // The loader reads `module.exports`; this scope does not provide `module` and does not provide `require`
    // (both verified from real page loads: the recorded errors were "ReferenceError: require is not defined"
    // and an entry that failed even though the factory returned its exports). A working third-party half gets
    // both from its own bundler runtime, which this repository does not have — so take them from the arguments
    // when the loader passes them and fall back to a local module object otherwise.
    const providedRequire = args.find((arg) => typeof arg === 'function');
    const providedModule = args.find((arg) => arg !== null && typeof arg === 'object' && 'exports' in arg);
    const module = providedModule ?? { exports: {} };
    const fail = (err) => {
      try {
        window.__S1CAP_CLIENT_ERROR__ = String((err && err.stack) || err);
      } catch {
        /* nothing left to do */
      }
    };
    try {
    const React = (() => {
      if (providedRequire !== undefined) {
        try {
          return providedRequire('react');
        } catch {
          return undefined;
        }
      }
      return typeof require === 'function' ? require('react') : undefined;
    })();
    const e = React === undefined ? undefined : React.createElement;

    /** `<scope>/<id>` — the same ref the host half reads (packages/dsh-plugin/src/credentials.ts). */
    const REF = 's1cap/jev';
    const name = 'dsh-s1cap';
    /**
     * Only `slots` is injected. `remote.credentials` is read at call time instead: a name in `inject` that the
     * client runtime does not provide leaves the whole entry pending and DSH reports the plugin as failed — the
     * exact symptom this file produced before. A runtime lookup that fails is caught and shown in the panel.
     */
    const inject = ['slots'];

    const S = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '12px', maxWidth: '640px' },
      title: { margin: 0, fontSize: '16px', fontWeight: 500 },
      intro: { margin: 0, fontSize: '13px', opacity: 0.75, lineHeight: 1.5 },
      row: { display: 'flex', gap: '8px', alignItems: 'center' },
      dot: (ok) => ({
        width: '8px',
        height: '8px',
        borderRadius: '50%',
        background: ok ? 'var(--dsw-alias-state-success-primary, #2f9e6b)' : 'var(--dsw-alias-state-error-primary, #d05a4a)',
      }),
      input: { flex: 1, height: '32px', padding: '0 10px', font: 'inherit', borderRadius: '6px', border: '0.5px solid var(--dsw-alias-border-l4, #c8d1dd)' },
      button: { height: '32px', padding: '0 14px', font: 'inherit', borderRadius: '6px', border: 'none', cursor: 'pointer' },
      note: { margin: 0, fontSize: '12px', opacity: 0.75 },
    };

    /** The panel: it reports whether a Jev key is stored and lets the user set or clear it. */
    function makeSection(ctx) {
      return function S1CapSection() {
        const [state, setState] = React.useState({ phase: 'loading', configured: false, message: '' });
        const [draft, setDraft] = React.useState('');

        const describe = React.useCallback(async () => {
          try {
            const response = await ctx.remote.credentials.describe([REF]);
            const entry = Array.isArray(response) ? response[0] : response;
            const configured =
              entry !== undefined && entry !== null &&
              (entry.configured === true || entry.present === true || entry.exists === true || typeof entry.value === 'string');
            setState({ phase: 'ready', configured, message: '' });
          } catch (err) {
            setState({ phase: 'ready', configured: false, message: 'could not read the credential store: ' + String(err) });
          }
        }, []);

        React.useEffect(() => {
          void describe();
        }, [describe]);

        const save = React.useCallback(async () => {
          const value = draft.trim();
          if (value === '') return;
          try {
            // The write path the host store declares (set/write); the value is never echoed back.
            const store = ctx.remote.credentials;
            if (typeof store.set === 'function') await store.set(REF, value);
            else await store.write(REF, value);
            setDraft('');
            await describe();
            setState((s) => ({ ...s, message: 'saved' }));
          } catch (err) {
            setState((s) => ({ ...s, message: 'save failed: ' + String(err) }));
          }
        }, [draft, describe]);

        const clear = React.useCallback(async () => {
          try {
            const store = ctx.remote.credentials;
            if (typeof store.unset === 'function') await store.unset(REF);
            await describe();
            setState((s) => ({ ...s, message: 'cleared' }));
          } catch (err) {
            setState((s) => ({ ...s, message: 'clear failed: ' + String(err) }));
          }
        }, [describe]);

        return e(
          'div',
          { style: S.wrap },
          e('h2', { style: S.title }, 'S1CAP — System-1 backend'),
          e(
            'p',
            { style: S.intro },
            'S1CAP puts a cheap System-1 decision model in charge of which context the agent sees and in which ' +
              'order its own plans run. This panel holds the credential for the cloud System-1 backend (Jev). The ' +
              'key is stored by the harness credential store and is never written to a log, a control-plane record ' +
              'or the conversation.',
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
            e('button', { style: S.button, type: 'button', onClick: () => void save(), disabled: draft.trim() === '' }, 'Save'),
            e('button', { style: S.button, type: 'button', onClick: () => void clear(), disabled: !state.configured }, 'Clear'),
          ),
          e('p', { style: S.note }, state.message),
          e(
            'p',
            { style: S.note },
            'Credential reference: ' + REF + '. The local Laya backend needs no key; select it in the profile patch ' +
              'or leave the provider at its default. Status, counters and the control-plane log are visible through ' +
              'the /s1 command.',
          ),
        );
      };
    }

    function apply(ctx) {
      if (React === undefined) {
        try {
          console.warn('[s1cap] settings panel inactive: no React available to the client half');
        } catch {
          /* ignore */
        }
        return;
      }
      const Section = makeSection(ctx);
      ctx.slots.inject('settings.section', function* () {
        yield ctx.slots.register(
          { name: 'settings.section', id: 's1cap-config', order: 30, label: () => 'S1CAP', inject: () => ({}) },
          Section,
        );
      });
    }

    const api = { apply, inject, name };
    // `module` is not guaranteed in the scope the loader evaluates this file in, so it is optional here; the
    // return value carries the same object for loaders that use it. A failure to publish must never throw.
    module.exports = api;
    return module.exports;
    } catch (err) {
      fail(err);
      // Degrade to an inert but valid plugin rather than failing the entry.
      return { name: 'dsh-s1cap', inject: [], apply() {} };
    }
  },
});
