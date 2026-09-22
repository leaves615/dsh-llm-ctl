import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot } from 'react-dom/client';
import { act, Simulate } from 'react-dom/test-utils';
import * as settingsUi from '../src/settings-ui.ts';
import type { VisibilitySettings } from '../src/visibility.ts';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

const defaultSettings: VisibilitySettings = { providers: {}, models: {} };
const defaultPatterns: readonly string[] = [];

function makeInput(overrides: Partial<settingsUi.VisibilityViewInput> = {}): settingsUi.VisibilityViewInput {
  return {
    providers: [
      { provider: 'openai', displayName: 'OpenAI', models: [{ model: 'gpt-4', name: 'GPT-4' }, { model: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo' }] },
      { provider: 'anthropic', displayName: 'Anthropic', models: [{ model: 'claude-3-opus', name: 'Claude 3 Opus' }] },
      { provider: 'zen-free', displayName: 'Zen Free', models: [] },
    ],
    settings: defaultSettings,
    patterns: defaultPatterns,
    ...overrides,
  };
}

function makeActions() {
  const calls: string[] = [];
  return {
    calls,
    setProvider(provider: string, visible: boolean) { calls.push(`setProvider:${provider}:${visible}`); },
    setModel(provider: string, model: string, visible: boolean) { calls.push(`setModel:${provider}:${model}:${visible}`); },
    resetAll() { calls.push('resetAll'); },
  };
}

function renderCard(view: settingsUi.ProviderVisibilityView, actions: ReturnType<typeof makeActions>): string {
  const element = React.createElement(settingsUi.ProviderVisibilityCard, { view, actions });
  return renderToStaticMarkup(element);
}

/** Mount one provider card into a fresh jsdom document for event simulation. */
function mountCard(view: settingsUi.ProviderVisibilityView, actions: ReturnType<typeof makeActions>): { document: Document; unmount: () => void } {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  const globals = globalThis as Record<string, unknown>;
  const saved = { window: globals['window'], document: globals['document'] };
  const define = (key: string, value: unknown): void => {
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  };
  define('window', dom.window);
  define('document', dom.window.document);
  define('navigator', dom.window.navigator);
  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(settingsUi.ProviderVisibilityCard, { view, actions }));
  });
  return {
    document: dom.window.document,
    unmount: () => {
      act(() => root.unmount());
      define('window', saved.window);
      define('document', saved.document);
      dom.window.close();
    },
  };
}

/** Click the nth eye toggle in the mounted document. */
function clickEye(document: Document, index: number): void {
  const buttons = [...document.querySelectorAll('button')].filter((button) =>
    ['👁', '🚫'].includes((button.textContent ?? '').trim()),
  );
  const button = buttons[index];
  assert.ok(button !== undefined, 'eye toggle exists');
  act(() => {
    button.dispatchEvent(new document.defaultView!.MouseEvent('click', { bubbles: true }));
  });
}

function renderFooter(summary: { providers: number; models: number; total: number }, queue: { queued: number; cooling: number }, actions: ReturnType<typeof makeActions>): string {
  const element = settingsUi.VisibilityFooter({ summary, queue, actions });
  return renderToStaticMarkup(element);
}

test('buildProviderViews computes visibility for providers and models', () => {
  const input = makeInput({
    settings: { providers: { 'openai': false }, models: { 'anthropic:claude-3-opus': false } },
  });
  const views = settingsUi.buildProviderViews(input);
  
  assert.equal(views.length, 3);
  
  const openai = views.find(v => v.provider === 'openai')!;
  assert.equal(openai.visible, false);
  assert.equal(openai.models.length, 2);
  assert.equal((openai.models[0]!).visible, false); // provider hidden hides all models
  assert.equal((openai.models[1]!).visible, false);
  
  const anthropic = views.find(v => v.provider === 'anthropic')!;
  assert.equal(anthropic.visible, true);
  assert.equal((anthropic.models[0]!).visible, false); // explicit model hidden
  
  const zenFree = views.find(v => v.provider === 'zen-free')!;
  assert.equal(zenFree.visible, true);
  assert.equal(zenFree.models.length, 0);
});

test('buildProviderViews applies hidden patterns', () => {
  const input = makeInput({ patterns: ['openai:*'] });
  const views = settingsUi.buildProviderViews(input);
  
  const openai = views.find(v => v.provider === 'openai')!;
  assert.equal(openai.visible, false);
  assert.equal(openai.models[0]?.visible, false);
  
  const anthropic = views.find(v => v.provider === 'anthropic')!;
  assert.equal(anthropic.visible, true);
});

test('summarize counts hidden providers and models', () => {
  const views: settingsUi.ProviderVisibilityView[] = [
    { provider: 'p1', displayName: 'P1', visible: false, models: [{ model: 'm1', name: 'M1', visible: true }, { model: 'm2', name: 'M2', visible: false }] },
    { provider: 'p2', displayName: 'P2', visible: true, models: [{ model: 'm3', name: 'M3', visible: false }] },
    { provider: 'p3', displayName: 'P3', visible: true, models: [] },
  ];
  const summary = settingsUi.summarize(views);
  assert.deepEqual(summary, { providers: 1, models: 2, total: 3 });
});

test('summarize returns zero when nothing hidden', () => {
  const views: settingsUi.ProviderVisibilityView[] = [
    { provider: 'p1', displayName: 'P1', visible: true, models: [{ model: 'm1', name: 'M1', visible: true }] },
  ];
  const summary = settingsUi.summarize(views);
  assert.deepEqual(summary, { providers: 0, models: 0, total: 0 });
});

test('ProviderVisibilityCard renders provider toggle', () => {
  const actions = makeActions();
  const view: settingsUi.ProviderVisibilityView = {
    provider: 'openai',
    displayName: 'OpenAI',
    visible: true,
    models: [],
  };
  const html = renderCard(view, actions);
  
  assert.ok(html.includes('提供方可见'), 'shows visible label');
  assert.ok(html.includes('👁'), 'shows eye icon for visible');
  assert.ok(html.includes('type="button"'), 'renders button');
});

test('ProviderVisibilityCard shows fallback when provider has no models', () => {
  const actions = makeActions();
  const view: settingsUi.ProviderVisibilityView = {
    provider: 'zen-free',
    displayName: 'Zen Free',
    visible: true,
    models: [],
  };
  const html = renderCard(view, actions);
  
  assert.ok(html.includes('该提供方暂无模型列表，无法逐模型控制'), 'shows fallback message');
  assert.ok(!html.includes('GPT-4'), 'no model rows rendered');
});

test('ProviderVisibilityCard renders model toggles when models exist', () => {
  const actions = makeActions();
  const view: settingsUi.ProviderVisibilityView = {
    provider: 'openai',
    displayName: 'OpenAI',
    visible: true,
    models: [
      { model: 'gpt-4', name: 'GPT-4', visible: true },
      { model: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo', visible: false },
    ],
  };
  const html = renderCard(view, actions);
  
  assert.ok(html.includes('GPT-4'), 'renders model name');
  assert.ok(html.includes('GPT-3.5 Turbo'), 'renders second model name');
  assert.ok(html.includes('👁'), 'shows eye for visible model');
  assert.ok(html.includes('🚫'), 'shows ban for hidden model');
});

test('ProviderVisibilityCard provider toggle triggers setProvider', () => {
  const actions = makeActions();
  const view: settingsUi.ProviderVisibilityView = {
    provider: 'openai',
    displayName: 'OpenAI',
    visible: true,
    models: [],
  };
  const { document, unmount } = mountCard(view, actions);
  try {
    clickEye(document, 0);
    assert.deepEqual(actions.calls, ['setProvider:openai:false']);
  } finally {
    unmount();
  }
});

test('ProviderVisibilityCard model toggle triggers setModel', () => {
  const actions = makeActions();
  const view: settingsUi.ProviderVisibilityView = {
    provider: 'openai',
    displayName: 'OpenAI',
    visible: true,
    models: [{ model: 'gpt-4', name: 'GPT-4', visible: true }],
  };
  const { document, unmount } = mountCard(view, actions);
  try {
    clickEye(document, 1);
    assert.deepEqual(actions.calls, ['setModel:openai:gpt-4:false']);
  } finally {
    unmount();
  }
});

test('VisibilityFooter shows no hidden message when summary total is zero', () => {
  const actions = makeActions();
  const html = renderFooter({ providers: 0, models: 0, total: 0 }, { queued: 0, cooling: 0 }, actions);
  
  assert.ok(html.includes('没有隐藏的模型'), 'shows no hidden message');
  assert.ok(!html.includes('全部恢复'), 'no restore button when nothing hidden');
});

test('VisibilityFooter shows hidden counts and restore button', () => {
  const actions = makeActions();
  const html = renderFooter({ providers: 2, models: 5, total: 7 }, { queued: 0, cooling: 0 }, actions);
  
  assert.ok(html.includes('已隐藏 2 个提供方 / 5 个模型'), 'shows hidden counts');
  assert.ok(html.includes('全部恢复'), 'shows restore button');
});

test('VisibilityFooter shows queue pressure', () => {
  const actions = makeActions();
  const html = renderFooter({ providers: 1, models: 2, total: 3 }, { queued: 3, cooling: 1 }, actions);
  
  assert.ok(html.includes('排队 3 · 冷却 1'), 'shows queue pressure');
});

test('VisibilityFooter restore button triggers resetAll', () => {
  const actions = makeActions();
  const element = settingsUi.VisibilityFooter({
    summary: { providers: 1, models: 2, total: 3 },
    queue: { queued: 0, cooling: 0 },
    actions,
  });
  
  const restoreButton = element.props.children[1] as React.ReactElement; // the button
  restoreButton.props.onClick();
  
  assert.deepEqual(actions.calls, ['resetAll']);
});

test('ProviderVisibilityCard hidden provider shows correct label and icon', () => {
  const actions = makeActions();
  const view: settingsUi.ProviderVisibilityView = {
    provider: 'openai',
    displayName: 'OpenAI',
    visible: false,
    models: [{ model: 'gpt-4', name: 'GPT-4', visible: false }],
  };
  const html = renderCard(view, actions);
  
  assert.ok(html.includes('提供方已隐藏'), 'shows hidden label');
  assert.ok(html.includes('🚫'), 'shows ban icon for hidden provider');
  assert.ok(html.includes('GPT-4'), 'still renders model rows');
});

test('buildProviderViews respects explicit provider true overriding pattern', () => {
  const input = makeInput({
    settings: { providers: { 'openai': true }, models: {} },
    patterns: ['openai:*'],
  });
  const views = settingsUi.buildProviderViews(input);
  
  const openai = views.find(v => v.provider === 'openai')!;
  assert.equal(openai.visible, true, 'explicit true overrides pattern');
  assert.equal(openai.models[0]?.visible, true);
});

test('buildProviderViews respects explicit model true overriding provider false', () => {
  const input = makeInput({
    settings: { providers: { 'openai': false }, models: { 'openai:gpt-4': true } },
  });
  const views = settingsUi.buildProviderViews(input);
  
  const openai = views.find(v => v.provider === 'openai')!;
  assert.equal(openai.visible, false);
  // Provider false hides all models regardless of explicit model setting
  assert.equal(openai.models[0]?.visible, false);
});

test('defaultExpanded collapses only long lists', () => {
  assert.equal(settingsUi.defaultExpanded(0), true);
  assert.equal(settingsUi.defaultExpanded(8), true);
  assert.equal(settingsUi.defaultExpanded(9), false);
  assert.equal(settingsUi.COLLAPSE_THRESHOLD, 8);
});

test('short model lists render expanded with an open chevron', () => {
  const views = settingsUi.buildProviderViews(makeInput());
  const openai = views.find((v) => v.provider === 'openai')!;
  const html = renderCard(openai, makeActions());
  assert.ok(html.includes('▾'), 'open chevron');
  assert.ok(html.includes('模型（2）'), 'section header with count');
  assert.ok(html.includes('GPT-4'), 'models visible');
});

test('long model lists render collapsed with a closed chevron', () => {
  const models = Array.from({ length: 10 }, (_, i) => ({ model: 'm' + i, name: 'Model ' + i }));
  const views = settingsUi.buildProviderViews(makeInput({
    providers: [{ provider: 'big', displayName: 'Big', models }],
  }));
  const big = views.find((v) => v.provider === 'big')!;
  const html = renderCard(big, makeActions());
  assert.ok(html.includes('▸'), 'closed chevron');
  assert.ok(html.includes('模型（10）'), 'section header with count');
  assert.ok(!html.includes('Model 0'), 'models hidden until expanded');});

function makeQueueActions() {
  const calls: string[] = [];
  let ok = true;
  let error: string | undefined;
  return {
    calls,
    setOk(value: boolean) { ok = value; },
    setError(value: string | undefined) { error = value; },
    setQueue(input: { maxWaitMs?: number; maxQueueDepth?: number; defaultConcurrency?: number; perProviderConcurrency?: Record<string, number>; expectedRevision?: number }) {
      const parts: string[] = [];
      if (input.maxWaitMs !== undefined) parts.push('maxWaitMs:' + input.maxWaitMs);
      if (input.maxQueueDepth !== undefined) parts.push('maxQueueDepth:' + input.maxQueueDepth);
      if (input.defaultConcurrency !== undefined) parts.push('defaultConcurrency:' + input.defaultConcurrency);
      if (input.perProviderConcurrency !== undefined) parts.push('perProvider:' + JSON.stringify(input.perProviderConcurrency));
      if (input.expectedRevision !== undefined) parts.push('revision:' + input.expectedRevision);
      calls.push('setQueue:' + parts.join(','));
      return Promise.resolve(ok ? { ok: true } : { ok: false, error: error ?? '保存失败：写入被拒绝' });
    },
    resetQueue(expectedRevision?: number) {
      calls.push('resetQueue:' + (expectedRevision === undefined ? '-' : expectedRevision));
      return Promise.resolve(ok);
    },
  };
}

function baseQueueConfig(overrides: Partial<settingsUi.QueueConfigView> = {}): settingsUi.QueueConfigView {
  return {
    maxWaitMs: 120000,
    maxQueueDepth: 50,
    defaultConcurrency: 2,
    perProviderConcurrency: {},
    defaults: { maxWaitMs: 120000, maxQueueDepth: 50, defaultConcurrency: 2 },
    overridden: false,
    revision: 1,
    ...overrides,
  };
}

function renderPluginConfig(config: settingsUi.QueueConfigView): string {
  return renderToStaticMarkup(React.createElement(settingsUi.PluginConfigCard, { config, actions: makeQueueActions() }));
}

function findButton(document: Document, text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find((node) => (node.textContent ?? '').includes(text)) as HTMLButtonElement | undefined;
}

/** Mount the plugin card into jsdom and expand it. */
function mountPluginCard(config: settingsUi.QueueConfigView, actions: ReturnType<typeof makeQueueActions>, providers: settingsUi.QueueProviderOption[] = []): { document: Document; unmount: () => void } {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  const define = (key: string, value: unknown): void => {
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  };
  define('window', dom.window);
  define('document', dom.window.document);
  define('navigator', dom.window.navigator);
  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(settingsUi.PluginConfigCard, { config, providers, actions }));
  });
  const header = dom.window.document.querySelector('button[aria-label="展开设置: LLM 排队控制"]') as HTMLButtonElement | null;
  if (header !== null) act(() => { Simulate.click(header); });
  return {
    document: dom.window.document,
    unmount: () => { act(() => { root.unmount(); }); },
  };
}

test('PluginConfigCard nests as a list item with a collapsed header', () => {
  const html = renderPluginConfig(baseQueueConfig());
  assert.ok(html.includes('<li'), 'nests as a list item inside the tab list');
  assert.ok(html.includes('LLM 排队控制'), 'names the plugin');
  assert.ok(html.includes('aria-expanded="false"'), 'starts collapsed');
  assert.ok(!html.includes('保存'), 'no controls before expansion');
});

test('PluginConfigCard expands to staged fields showing the effective budget', () => {
  const actions = makeQueueActions();
  const { document, unmount } = mountPluginCard(baseQueueConfig(), actions);
  try {
    const wait = document.querySelector('#llm-ctl-queue-max-wait') as HTMLInputElement | null;
    const depth = document.querySelector('#llm-ctl-queue-depth') as HTMLInputElement | null;
    assert.ok(wait !== null && depth !== null, 'both fields render');
    assert.equal(wait.value, '120', 'budget shows seconds, not milliseconds');
    assert.equal(depth.value, '50', 'depth shows the count');
    assert.ok(findButton(document, '保存') !== undefined, 'save affordance');
    assert.deepEqual(actions.calls, [], 'expanding writes nothing');
  } finally {
    unmount();
  }
});

test('PluginConfigCard stages an edit and writes only on save', async () => {
  const actions = makeQueueActions();
  const { document, unmount } = mountPluginCard(baseQueueConfig(), actions);
  try {
    const wait = document.querySelector('#llm-ctl-queue-max-wait') as HTMLInputElement;
    act(() => { Simulate.change(wait, { target: { value: '30' } as unknown as EventTarget }); });
    assert.deepEqual(actions.calls, [], 'editing alone does not write');
    const save = findButton(document, '保存');
    assert.ok(save !== undefined);
    await act(async () => { Simulate.click(save); });
    assert.deepEqual(actions.calls, ['setQueue:maxWaitMs:30000,revision:1']);
  } finally {
    unmount();
  }
});

test('PluginConfigCard blocks save on an invalid draft', async () => {
  const actions = makeQueueActions();
  const { document, unmount } = mountPluginCard(baseQueueConfig(), actions);
  try {
    const depth = document.querySelector('#llm-ctl-queue-depth') as HTMLInputElement;
    act(() => { Simulate.change(depth, { target: { value: '0' } as unknown as EventTarget }); });
    const save = findButton(document, '保存');
    assert.ok(save !== undefined && save.disabled, 'invalid draft blocks the save');
    await act(async () => { if (save !== undefined) Simulate.click(save); });
    assert.deepEqual(actions.calls, []);
  } finally {
    unmount();
  }
});

test('PluginConfigCard discards staged edits', async () => {
  const actions = makeQueueActions();
  const { document, unmount } = mountPluginCard(baseQueueConfig(), actions);
  try {
    const wait = document.querySelector('#llm-ctl-queue-max-wait') as HTMLInputElement;
    act(() => { Simulate.change(wait, { target: { value: '30' } as unknown as EventTarget }); });
    const discard = findButton(document, '放弃修改');
    assert.ok(discard !== undefined);
    await act(async () => { Simulate.click(discard); });
    assert.equal((document.querySelector('#llm-ctl-queue-max-wait') as HTMLInputElement).value, '120');
    assert.deepEqual(actions.calls, []);
  } finally {
    unmount();
  }
});

test('PluginConfigCard reports a failed save', async () => {
  const actions = makeQueueActions();
  actions.setOk(false);
  const { document, unmount } = mountPluginCard(baseQueueConfig(), actions);
  try {
    const wait = document.querySelector('#llm-ctl-queue-max-wait') as HTMLInputElement;
    act(() => { Simulate.change(wait, { target: { value: '30' } as unknown as EventTarget }); });
    const save = findButton(document, '保存');
    await act(async () => { if (save !== undefined) Simulate.click(save); });
    assert.ok((document.body.textContent ?? '').includes('保存失败'), 'surfaces the failure');
  } finally {
    unmount();
  }
});

test('PluginConfigCard renders the default concurrency field', () => {
  const actions = makeQueueActions();
  const { document, unmount } = mountPluginCard(baseQueueConfig(), actions);
  try {
    const conc = document.querySelector('#llm-ctl-queue-concurrency') as HTMLInputElement | null;
    assert.ok(conc !== null, 'default concurrency field renders');
    assert.equal(conc.value, '2', 'shows the effective default');
    assert.ok((document.body.textContent ?? '').includes('各提供方并发上限'), 'per-provider section renders');
  } finally {
    unmount();
  }
});

test('PluginConfigCard stages a default concurrency edit and saves it', async () => {
  const actions = makeQueueActions();
  const { document, unmount } = mountPluginCard(baseQueueConfig(), actions);
  try {
    const conc = document.querySelector('#llm-ctl-queue-concurrency') as HTMLInputElement;
    act(() => { Simulate.change(conc, { target: { value: '4' } as unknown as EventTarget }); });
    const save = findButton(document, '保存');
    assert.ok(save !== undefined && !save.disabled);
    await act(async () => { Simulate.click(save); });
    assert.deepEqual(actions.calls, ['setQueue:defaultConcurrency:4,revision:1']);
  } finally {
    unmount();
  }
});

test('PluginConfigCard stages a per-provider concurrency override', async () => {
  const actions = makeQueueActions();
  const providers = [{ provider: 'zen-free', displayName: 'Zen Free' }];
  const { document, unmount } = mountPluginCard(baseQueueConfig(), actions, providers);
  try {
    const input = document.querySelector('[aria-label="Zen Free 并发上限"]') as HTMLInputElement | null;
    assert.ok(input !== null, 'per-provider row renders');
    assert.equal(input.placeholder, '默认 2', 'blank inherits the default');
    act(() => { Simulate.change(input, { target: { value: '1' } as unknown as EventTarget }); });
    const save = findButton(document, '保存');
    await act(async () => { if (save !== undefined) Simulate.click(save); });
    assert.deepEqual(actions.calls, ['setQueue:perProvider:{"zen-free":1},revision:1']);
  } finally {
    unmount();
  }
});

test('PluginConfigCard clearing a per-provider cell drops the override', async () => {
  const actions = makeQueueActions();
  const providers = [{ provider: 'zen-free', displayName: 'Zen Free' }];
  const config = baseQueueConfig({ perProviderConcurrency: { 'zen-free': 1 }, overridden: true });
  const { document, unmount } = mountPluginCard(config, actions, providers);
  try {
    const input = document.querySelector('[aria-label="Zen Free 并发上限"]') as HTMLInputElement | null;
    assert.ok(input !== null);
    assert.equal(input.value, '1', 'override seeds the draft');
    act(() => { Simulate.change(input, { target: { value: '' } as unknown as EventTarget }); });
    const save = findButton(document, '保存');
    await act(async () => { if (save !== undefined) Simulate.click(save); });
    assert.deepEqual(actions.calls, ['setQueue:perProvider:{},revision:1']);
  } finally {
    unmount();
  }
});

test('PluginConfigCard blocks save on an invalid concurrency draft', async () => {
  const actions = makeQueueActions();
  const { document, unmount } = mountPluginCard(baseQueueConfig(), actions);
  try {
    const conc = document.querySelector('#llm-ctl-queue-concurrency') as HTMLInputElement;
    act(() => { Simulate.change(conc, { target: { value: '-1' } as unknown as EventTarget }); });
    const save = findButton(document, '保存');
    assert.ok(save !== undefined && save.disabled, 'negative concurrency blocks the save');
    await act(async () => { if (save !== undefined) Simulate.click(save); });
    assert.deepEqual(actions.calls, []);
  } finally {
    unmount();
  }
});

test('PluginConfigCard saves zero as unlimited and hints it in placeholders', async () => {
  const actions = makeQueueActions();
  const providers = [
    { provider: 'openai', displayName: 'OpenAI' },
    { provider: 'zen-free', displayName: 'Zen Free' },
  ];
  const { document, unmount } = mountPluginCard(baseQueueConfig({ defaultConcurrency: 0 }), actions, providers);
  try {
    const conc = document.querySelector('#llm-ctl-queue-concurrency') as HTMLInputElement;
    assert.equal(conc.value, '0');
    const plain = document.querySelector('[aria-label="OpenAI 并发上限"]') as HTMLInputElement | null;
    assert.ok(plain !== null);
    assert.equal(plain.placeholder, '不限制（默认）', 'unlimited default shows honestly');
    const free = document.querySelector('[aria-label="Zen Free 并发上限"]') as HTMLInputElement | null;
    assert.ok(free !== null);
    assert.equal(free.placeholder, '不限制（默认）', 'free routes inherit the unlimited default');
    const save = findButton(document, '保存');
    assert.ok(save !== undefined && save.disabled, 'unchanged drafts keep save off');
    act(() => { Simulate.change(conc, { target: { value: '2' } as unknown as EventTarget }); });
    await act(async () => { if (save !== undefined) Simulate.click(save); });
    assert.deepEqual(actions.calls, ['setQueue:defaultConcurrency:2,revision:1']);
  } finally {
    unmount();
  }
});

test('PluginConfigCard survives a state document without concurrency fields', () => {
  const legacy = {
    maxWaitMs: 120000,
    maxQueueDepth: 50,
    defaults: { maxWaitMs: 120000, maxQueueDepth: 50 },
    overridden: false,
    revision: 1,
  } as unknown as settingsUi.QueueConfigView;
  const actions = makeQueueActions();
  const { document, unmount } = mountPluginCard(legacy, actions);
  try {
    const conc = document.querySelector('#llm-ctl-queue-concurrency') as HTMLInputElement | null;
    assert.ok(conc !== null, 'card renders with fallback defaults');
    assert.equal(conc.value, '2', 'falls back to the built-in default');
  } finally {
    unmount();
  }
});

test('PluginConfigCard warns on a legacy host without concurrency fields', () => {
  const legacy = {
    maxWaitMs: 120000,
    maxQueueDepth: 50,
    defaults: { maxWaitMs: 120000, maxQueueDepth: 50 },
    overridden: false,
    revision: 1,
  } as unknown as settingsUi.QueueConfigView;
  const actions = makeQueueActions();
  const { document, unmount } = mountPluginCard(legacy, actions);
  try {
    assert.ok((document.body.textContent ?? '').includes('检测到 Host 为旧版本'), 'upgrade hint renders');
  } finally {
    unmount();
  }
});

test('PluginConfigCard surfaces the server error message', async () => {
  const actions = makeQueueActions();
  actions.setOk(false);
  actions.setError('maxWaitMs or maxQueueDepth is required');
  const { document, unmount } = mountPluginCard(baseQueueConfig(), actions);
  try {
    const wait = document.querySelector('#llm-ctl-queue-max-wait') as HTMLInputElement;
    act(() => { Simulate.change(wait, { target: { value: '30' } as unknown as EventTarget }); });
    const save = findButton(document, '保存');
    await act(async () => { if (save !== undefined) Simulate.click(save); });
    assert.ok((document.body.textContent ?? '').includes('maxWaitMs or maxQueueDepth is required'), 'server message surfaces');
  } finally {
    unmount();
  }
});

test('PluginConfigCard resets an override against the current revision', async () => {
  const actions = makeQueueActions();
  const { document, unmount } = mountPluginCard(baseQueueConfig({ maxWaitMs: 30000, overridden: true, revision: 7 }), actions);
  try {
    const reset = findButton(document, '恢复默认');
    assert.ok(reset !== undefined, 'override exposes the reset');
    await act(async () => { Simulate.click(reset); });
    assert.deepEqual(actions.calls, ['resetQueue:7']);
  } finally {
    unmount();
  }
});
