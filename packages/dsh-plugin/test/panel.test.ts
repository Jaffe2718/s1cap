/**
 * The S1CAP settings panel — the browser half, driven here without a browser.
 *
 * Why this file exists: the panel is the only place the System-1 backend can be chosen, it is plain JS in a file
 * nothing else in this repository loads, and `react` is not a dependency here (the host supplies it through the
 * module loader at runtime). So the file is loaded through the same two seams the host provides —
 * `window.__ModuleLoader__.load({ id, factory })` and the `require` handed to the factory — with a stub React whose
 * only job is to run the hooks the panel actually uses (`useState`, `useCallback`, `useEffect`) and hand back a
 * plain element tree. That is enough to assert what the user gets: which radios exist, which backend block is live,
 * and what a Save button puts on the wire.
 *
 * No browser, no network, no React: `fetch` is a stub that records request bodies. What this cannot cover is
 * anything the host's real React does and the stub does not — re-render timing under batching, and whether the
 * element tree the host mounts looks like this one. The values sent, and the values offered, are covered.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseProvider } from '../src/credentials.ts';

/** The element shape the stub `createElement` returns: enough of a tree to walk and to read text from. */
interface StubElement {
  type: string;
  props: Record<string, unknown>;
  children: unknown[];
}

type StubComponent = () => StubElement;

/**
 * A React stub with exactly the four members `client.js` uses.
 *
 * Hook slots are indexed by call order and never reset, which is what makes state survive a re-render; render
 * order is stable in this component, so an index always belongs to the same hook. Effects are *collected*, not
 * run: the panel's effect calls `load()`, which fetches, and a test wants to choose when that happens.
 */
function createHarness() {
  const slots: unknown[] = [];
  const effects: (() => unknown)[] = [];
  let component: StubComponent | undefined;
  let index = 0;
  const React = {
    createElement(type: string, props: Record<string, unknown> | null, ...children: unknown[]): StubElement {
      return { type, props: props ?? {}, children: children.flat() };
    },
    useState(initial: unknown): [unknown, (next: unknown) => void] {
      const slot = index;
      index += 1;
      if (!(slot in slots)) slots[slot] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
      return [
        slots[slot],
        (next: unknown) => {
          slots[slot] = typeof next === 'function' ? (next as (prev: unknown) => unknown)(slots[slot]) : next;
        },
      ];
    },
    useCallback(fn: unknown): unknown {
      index += 1;
      return fn;
    },
    useEffect(fn: () => unknown): void {
      index += 1;
      effects.push(fn);
    },
  };
  return {
    React,
    mount(Section: StubComponent): void {
      component = Section;
    },
    render(): StubElement {
      index = 0;
      assert.ok(component !== undefined, 'the panel component must be mounted before it is rendered');
      return component();
    },
    takeEffects(): (() => unknown)[] {
      return effects.splice(0);
    },
  };
}

interface PanelModule {
  apply(ctx: unknown): void;
  name: string;
}

/**
 * Load `src/client.js` the way the module loader does, and return its exports.
 *
 * The file registers itself with `window.__ModuleLoader__.load`, so `window` has to exist before the import runs —
 * hence the dynamic import rather than a static one. `window` is removed again afterwards, because a stray global
 * in a test process is the same class of leak as a stray global in the panel.
 *
 * The import is memoized: a module executes once per process, so a second `import()` of the same specifier is
 * served from the ESM cache and never calls the loader again. The *factory* is re-invoked per mount instead, which
 * is exactly what the loader does for each host instance — a fresh module body, a fresh component.
 */
let specPromise: Promise<{ id: string; factory: (require: (name: string) => unknown) => PanelModule }> | undefined;

async function panelSpec(): Promise<{ id: string; factory: (require: (name: string) => unknown) => PanelModule }> {
  if (specPromise !== undefined) return await specPromise;
  specPromise = (async () => {
    let spec: { id: string; factory: (require: (name: string) => unknown) => PanelModule } | undefined;
    (globalThis as { window?: unknown }).window = {
      __ModuleLoader__: {
        load(value: { id: string; factory: (require: (name: string) => unknown) => PanelModule }) {
          spec = value;
        },
      },
    };
    try {
      await import('../src/client.js');
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }
    const loaded = spec;
    assert.ok(loaded !== undefined, 'client.js must register itself through window.__ModuleLoader__.load');
    assert.equal(loaded.id, 'dsh-s1cap');
    return loaded;
  })();
  return await specPromise;
}

async function loadPanel(react: unknown): Promise<PanelModule> {
  const loaded = await panelSpec();
  return loaded.factory((name: string) => {
    if (name === 'react') return react;
    throw new Error(`unexpected require(${name})`);
  });
}

/** Mount the registered section and return it, through the same `slots.inject` generator the host drains. */
function captureSection(module: PanelModule): StubComponent {
  let Section: StubComponent | undefined;
  const ctx = {
    slots: {
      inject(_name: string, generator: () => Generator<unknown>): void {
        generator().next();
      },
      register(_meta: unknown, Component: StubComponent): unknown {
        Section = Component;
        return {};
      },
    },
    remote: {
      credentials: {
        resolve: async () => undefined,
        set: async () => ({ ok: true }),
      },
    },
  };
  module.apply(ctx);
  assert.ok(Section !== undefined, 'apply() must register the settings section');
  return Section;
}

function walk(node: unknown, visit: (element: StubElement) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  const element = node as StubElement;
  visit(element);
  walk(element.children, visit);
}

function findAll(root: unknown, predicate: (element: StubElement) => boolean): StubElement[] {
  const out: StubElement[] = [];
  walk(root, (element) => {
    if (predicate(element)) out.push(element);
  });
  return out;
}

/** All the text under a node, so an assertion can be about what the user reads rather than about a string literal. */
function textOf(node: unknown): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node !== null && typeof node === 'object') return textOf((node as StubElement).children);
  return '';
}

/** The three backend blocks, identified by the `S.group` style they are rendered with. */
function backendBlocks(root: unknown): StubElement[] {
  return findAll(root, (element) => {
    const style = element.props['style'] as { marginLeft?: string } | undefined;
    return style !== undefined && style.marginLeft === '15px';
  });
}

function opacityOf(element: StubElement): unknown {
  return (element.props['style'] as { opacity?: unknown }).opacity;
}

/** Let the promises `load()` awaits settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 1));
}

/** The tuning route's two shapes, answered from a provider the PUT body sets — as the host does. */
function stubFetch(state: { calls: { method: string; body: string }[]; provider: string }) {
  return async (_url: unknown, init?: { method?: string; body?: unknown }) => {
    const method = String(init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? init.body : '';
    state.calls.push({ method, body });
    if (method !== 'GET') {
      const match = /provider=([^\s]+)/.exec(body);
      if (match !== null) state.provider = match[1] as string;
    }
    const effective = {
      depth: 3,
      relevanceThreshold: 0.6,
      window: 512,
      anchorWaitMs: 0,
      xFirst: true,
      provider: state.provider,
    };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        persisted: true,
        stored: {},
        effective,
        status: {
          cell: 'C2',
          s1: {
            provider: state.provider,
            configuredProvider: state.provider,
            mode: state.provider === 'none' ? 'none' : 'cloud',
          },
          laya: { state: { status: 'stopped' }, conflicts: [], supplied: {} },
        },
      }),
    };
  };
}

/** Mount the panel with a stubbed route, run its load effect, and hand back everything a test needs to drive it. */
async function mountPanel() {
  const state = { calls: [] as { method: string; body: string }[], provider: 'jev' };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = stubFetch(state) as unknown as typeof fetch;
  try {
    const harness = createHarness();
    const module = await loadPanel(harness.React);
    harness.mount(captureSection(module));
    harness.render();
    for (const effect of harness.takeEffects()) effect();
    await settle();
    return {
      state,
      /** Render again, after state has moved. */
      view: () => harness.render(),
      /** Choose a radio by value, the way a click does. */
      choose: (value: string) => {
        const radio = findAll(harness.render(), (element) => element.props['value'] === value).find(
          (element) => element.type === 'input' && element.props['type'] === 'radio',
        );
        assert.ok(radio !== undefined, `the panel must offer a ${value} radio`);
        (radio.props['onChange'] as () => void)();
      },
      /** Press a button by its label. The handler is fire-and-forget (`onClick: () => void saveTuning()`). */
      press: async (label: string) => {
        const button = findAll(harness.render(), (element) => element.type === 'button' && textOf(element) === label)[0];
        assert.ok(button !== undefined, `the panel must render a "${label}" button`);
        (button.props['onClick'] as () => void)();
        await settle();
        await settle();
      },
      restore: () => {
        globalThis.fetch = previousFetch;
      },
    };
  } catch (err) {
    globalThis.fetch = previousFetch;
    throw err;
  }
}

test('the backend radio offers Off, and every value it offers is a name the host accepts', async () => {
  const panel = await mountPanel();
  try {
    const radios = findAll(panel.view(), (element) => element.type === 'input' && element.props['type'] === 'radio');
    const values = radios.map((radio) => radio.props['value']);
    assert.deepEqual(values, ['jev', 'laya-serve', 'none'], 'three choices, in the order the panel states them');
    assert.equal(radios.length, 3, 'and no fourth radio: one backend per session is the host rule');
    for (const radio of radios) {
      // The contract that keeps a radio from being a dead button: the host's own parser accepts every name the
      // radio can send. `parseProvider` is the same function the PUT route and the stored-file reader use.
      assert.equal(parseProvider(String(radio.props['value'])), radio.props['value']);
    }
    const labels = radios.map((radio) => {
      const id = String(radio.props['id']);
      const label = findAll(panel.view(), (element) => element.type === 'label' && element.props['htmlFor'] === id)[0];
      return label === undefined ? '' : textOf(label);
    });
    assert.deepEqual(labels, ['Jev (cloud)', 'Laya (local)', 'Off']);
  } finally {
    panel.restore();
  }
});

test('Off is a selectable block: the other two stay mounted and dim, and the knobs stay below', async () => {
  const panel = await mountPanel();
  try {
    // The stored provider came back as `jev`, so the cloud block is the live one and the other two are dimmed.
    let blocks = backendBlocks(panel.view());
    assert.equal(blocks.length, 3, 'all three blocks are mounted at once');
    assert.deepEqual(blocks.map(opacityOf), [1, 0.45, 0.45]);

    panel.choose('none');
    const view = panel.view();
    blocks = backendBlocks(view);
    assert.equal(blocks.length, 3, 'choosing Off must not unmount the backend fields it is not using');
    assert.deepEqual(blocks.map(opacityOf), [0.45, 0.45, 1], 'only the selected choice is live');

    // The Off block is the one carrying the explanation, and it sits above the recall knobs rather than replacing
    // them: Off means "no System-1", so every recall knob is still in effect and still editable.
    assert.match(textOf(blocks[2]), /Off writes provider=none/);
    const order: string[] = [];
    walk(view, (element) => order.push(textOf(element)));
    const offAt = order.findIndex((text) => text.includes('Off writes provider=none'));
    const knobsAt = order.findIndex((text) => text === 'Recall tuning');
    assert.ok(offAt >= 0 && knobsAt > offAt, 'the backend group sits above the recall knobs');
  } finally {
    panel.restore();
  }
});

test('the Off text says what Off does and does not do, because "Off" reads as "no S1CAP at all"', async () => {
  const panel = await mountPanel();
  try {
    panel.choose('none');
    const text = textOf(backendBlocks(panel.view())[2]);
    // Each of these is a way a researcher could be misled by the word "Off" alone, measured against the code:
    // with no client the relevance scorer answers `undefined` (`s1-relevance.ts`) and the graph keeps the lexical
    // edges `lexicalScore` wrote; recall selection is `recall.tier1`, which the cell preset decides — C0/C1 set it
    // to 'off' (`cellPolicy`, `assembler.ts`: an empty recalled block), so Off inside C2 is not a cell.
    assert.match(text, /lexical/, 'it says the fallback scorer takes over');
    assert.match(text, /association graph keeps growing/, 'and that the graph keeps being built');
    assert.match(text, /recall selection/, 'it names recall selection as the thing Off does not decide');
    assert.match(text, /cellPolicy/, 'and names the place that does decide it');
    assert.match(text, /not C0/, 'and states the conclusion a reader must not have to infer');
  } finally {
    panel.restore();
  }
});

test('both save buttons send provider=none, so the switch does not depend on which one is pressed', async () => {
  const panel = await mountPanel();
  try {
    panel.choose('none');
    await panel.press('Save backend');
    await panel.press('Save tuning');
    const puts = panel.state.calls.filter((call) => call.method === 'PUT');
    assert.equal(puts.length, 2, 'both buttons saved');
    for (const put of puts) {
      assert.match(put.body, /(^|\s)provider=none(\s|$)/, `every save carries the selection, got: ${put.body}`);
    }
    // The host answered, and the radio is re-read from it rather than from the form: an Off that saved and then
    // displayed something else would be the same class of defect as a radio that never reached the config.
    assert.equal(panel.state.provider, 'none', 'the host was told, so the GET that follows reports Off');
    assert.equal(
      findAll(panel.view(), (element) => element.props['value'] === 'none' && element.props['checked'] === true).length,
      1,
      'and exactly the Off radio reads back as checked',
    );
  } finally {
    panel.restore();
  }
});
