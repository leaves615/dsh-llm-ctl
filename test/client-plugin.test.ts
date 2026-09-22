import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

/**
 * Client-half wiring tests against a jsdom document.
 *
 * They pin the two behaviors that are invisible to pure DOM unit tests: the
 * plugin must reconcile the menu without feeding its own MutationObserver, and
 * it must defer to an existing model-search widget.
 */

interface ClientContext {
  remote: {
    session: { modelCatalog(): Promise<{ ok: boolean; value: { groups: unknown[] } }> };
    llm: { listConfigurableProviders(): Promise<{ ok: boolean; value: unknown[] }> };
  };
  slots?: undefined;
  logger: { warn(...args: unknown[]): void };
  effect(callback: () => (() => void) | void, label?: string): void;
}

/** A client context plus the disposer the plugin registered. */
interface ClientHarness {
  ctx: ClientContext;
  stop: () => void;
}

/** Menu markup matching the real model-selection popup. */
function menuMarkup(options: { foreignWidget: boolean; models?: readonly string[] }): string {
  const widget = options.foreignWidget
    ? '<div class="dsh-model-search-container"><input class="dsh-model-search-input" /></div>'
    : '';
  const rows = (options.models ?? ['Model One', 'Model Two'])
    .map((name) => `<button type="button" role="menuitemradio" title="${name}"><span class="x_modelName">${name}</span></button>`)
    .join('');
  return `<div id="root">
    ${widget}
    <div role="menu" aria-label="模型与推理等级">
      <div class="groups">
        <section role="group" aria-labelledby="g-p">
          <div id="g-p">Provider P</div>
          ${rows}
        </section>
      </div>
    </div>
  </div>`;
}

/** Install jsdom globals and return a teardown. */
function installDom(html: string): { document: Document; dispose: () => void } {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { pretendToBeVisual: true });
  const globals = globalThis as unknown as Record<string, unknown>;
  const saved = {
    document: globals['document'],
    window: globals['window'],
    MutationObserver: globals['MutationObserver'],
    fetch: globals['fetch'],
  };
  globals['document'] = dom.window.document;
  globals['window'] = dom.window;
  globals['MutationObserver'] = dom.window.MutationObserver;
  return {
    document: dom.window.document,
    dispose: () => {
      for (const [key, value] of Object.entries(saved)) globals[key] = value;
      dom.window.close();
    },
  };
}

/** State document the fake host route returns. */
function stateBody(hiddenModel: string | undefined): unknown {
  return {
    at: Date.now(),
    queue: { lanes: [], waiters: [] },
    events: [],
    reactive: { mode: 'auto', limit: 3 },
    visibility: {
      settings: hiddenModel === undefined ? { providers: {}, models: {} } : { providers: {}, models: { [`p:${hiddenModel}`]: false } },
      patterns: [],
    },
  };
}

/** Minimal client context whose host routes are served from memory. */
function makeClient(hiddenModel: string | undefined, catalogNames: string[]): ClientHarness & { warnings: string[] } {
  let dispose: (() => void) | undefined;
  const warnings: string[] = [];
  const ctx: ClientContext = {
    remote: {
      session: {
        modelCatalog: async () => ({
          ok: true,
          value: { groups: [{ id: 'p', name: 'Provider P', models: catalogNames.map((name) => ({ id: name.replace(/\s+/g, '-').toLowerCase(), name })) }] },
        }),
      },
      llm: { listConfigurableProviders: async () => ({ ok: true, value: [] }) },
    },
    logger: { warn: (...args) => warnings.push(args.map(String).join(' ')) },
    effect: (callback) => {
      const result = callback();
      if (typeof result === 'function') dispose = result;
    },
  };
  return {
    ctx,
    warnings,
    stop: () => {
      dispose?.();
      dispose = undefined;
    },
  };
}

/** Wait until the predicate holds or the deadline passes. */
async function until(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not reached in time');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test('hidden models are removed from the live menu and the search box defers to model-search', async () => {
  const { document, dispose } = installDom(menuMarkup({ foreignWidget: true }));
  (globalThis as unknown as Record<string, unknown>)['fetch'] = async () => ({
    ok: true,
    json: async () => stateBody('model-two'),
  });
  const clientModule = await import('../src/client-plugin.ts');
  const harness = makeClient('model-two', ['Model One', 'Model Two']);
  clientModule.apply(harness.ctx as never);
  try {
    await until(() => {
      const rows = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
      return rows.length === 2 && rows.some((row) => row.style.display === 'none');
    });
    const rows = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    assert.equal(rows[0]?.style.display, '', 'the visible model stays');
    assert.equal(rows[1]?.style.display, 'none', 'the hidden model is removed from view');
    assert.equal(document.getElementById('dsh-llm-ctl-search'), null, 'no second search box when model-search owns one');
    assert.equal(document.getElementById('dsh-llm-ctl-empty'), null, 'no empty state while a row remains');
  } finally {
    harness.stop();
    dispose();
  }
});

test('injects its own search box when no foreign widget exists and filters on input', async () => {
  const { document, dispose } = installDom(menuMarkup({ foreignWidget: false }));
  (globalThis as unknown as Record<string, unknown>)['fetch'] = async () => ({ ok: true, json: async () => stateBody(undefined) });
  const clientModule = await import('../src/client-plugin.ts');
  const harness = makeClient(undefined, ['Model One', 'Model Two']);
  clientModule.apply(harness.ctx as never);
  try {
    await until(() => document.getElementById('dsh-llm-ctl-search') !== null);
    const input = document.getElementById('dsh-llm-ctl-search') as HTMLInputElement;
    input.value = 'two';
    input.dispatchEvent(new document.defaultView!.Event('input', { bubbles: true }));
    await until(() => {
      const rows = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
      return rows.length === 2 && rows[0]?.style.display === 'none' && rows[1]?.style.display === '';
    });
  } finally {
    harness.stop();
    dispose();
  }
});

test('a fully hidden menu shows the empty state exactly once and does not feed the observer', async () => {
  const { document, dispose } = installDom(menuMarkup({ foreignWidget: false, models: ['Model One'] }));
  (globalThis as unknown as Record<string, unknown>)['fetch'] = async () => ({
    ok: true,
    json: async () => stateBody('model-one'),
  });
  const clientModule = await import('../src/client-plugin.ts');
  const harness = makeClient('model-one', ['Model One']);
  clientModule.apply(harness.ctx as never);
  try {
    await until(() => document.getElementById('dsh-llm-ctl-empty') !== null).catch((error) => {
      const rows = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
      throw new Error(`${String(error)}; rows=${rows.map((row) => row.style.display || 'shown').join(',')}; warnings=${harness.warnings.join('|')}`);
    });
    const empty = document.getElementById('dsh-llm-ctl-empty') as HTMLElement;
    const container = empty.parentElement as HTMLElement;
    let rewrites = 0;
    const observer = new MutationObserver((records) => {
      for (const record of records) if (record.type === 'childList') rewrites += 1;
    });
    observer.observe(container, { childList: true, subtree: true });
    await new Promise((resolve) => setTimeout(resolve, 700));
    observer.disconnect();
    // The empty state is rewritten at most on transitions; a self-feeding
    // observer would rewrite it dozens of times inside this window.
    assert.ok(rewrites <= 2, `empty state rewritten ${rewrites} times`);
    assert.ok(empty.querySelector('button') !== null, 'restore action is rendered');
  } finally {
    harness.stop();
    dispose();
  }
});
test('failed polls back off instead of hammering the host every second', async () => {
  const clientModule = await import('../src/client-plugin.ts');
  assert.equal(clientModule.pollDelayForFailures(0), 1_000, 'healthy steady state stays at 1s');
  assert.equal(clientModule.pollDelayForFailures(-1), 1_000, 'non-positive failures stay at 1s');
  assert.equal(clientModule.pollDelayForFailures(1), 2_000, 'first failure doubles');
  assert.equal(clientModule.pollDelayForFailures(2), 4_000, 'ladder keeps doubling');
  assert.equal(clientModule.pollDelayForFailures(4), 16_000, 'ladder keeps doubling');
  assert.equal(clientModule.pollDelayForFailures(5), 30_000, 'ladder caps at 30s');
  assert.equal(clientModule.pollDelayForFailures(10), 30_000, 'ladder stays capped');
});
test('a foreign-owned menu keeps foreign filtering while our switches still hide', async () => {
  const { document, dispose } = installDom(menuMarkup({ foreignWidget: true }));
  (globalThis as unknown as Record<string, unknown>)['fetch'] = async () => ({ ok: true, json: async () => stateBody('model-two') });
  const clientModule = await import('../src/client-plugin.ts');
  const harness = makeClient('model-two', ['Model One', 'Model Two']);
  clientModule.apply(harness.ctx as never);
  try {
    await until(() => {
      const rows = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
      return rows.length === 2 && rows[1]?.dataset['llmCtlHidden'] === '1';
    });
    const rows = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    assert.equal(rows[1]?.style.display, 'none', 'our rejected row is hidden');
    assert.equal(rows[0]?.style.display, '', 'passing rows are never rewritten');
    assert.equal(rows[0]?.dataset['llmCtlHidden'], undefined);
    assert.equal(document.getElementById('dsh-llm-ctl-search'), null, 'no second search box');
    assert.equal(document.getElementById('dsh-llm-ctl-empty'), null, 'no empty state in foreign mode');
    // Simulate the foreign plugin filtering the first row: our next sync must not restore it.
    rows[0]!.style.display = 'none';
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(rows[0]?.style.display, 'none', 'foreign filtering survives our sync');
    assert.equal(rows[1]?.style.display, 'none', 'our hidden row stays hidden');
  } finally {
    harness.stop();
    dispose();
  }
});