import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import * as discoverUi from '../src/discover-ui.ts';
import type { VisibilitySettings } from '../src/visibility.ts';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

const defaultSettings: VisibilitySettings = { providers: {}, models: {} };

function makeInput(overrides: Partial<discoverUi.DiscoveredRowsInput> = {}): discoverUi.DiscoveredRowsInput {
  return {
    provider: 'zen-free',
    discovered: [
      { id: 'glm-4.6', name: 'GLM 4.6' },
      { id: 'glm-4.6-test' },
    ],
    advertisedIds: ['glm-4.6'],
    settings: defaultSettings,
    patterns: [],
    ...overrides,
  };
}

function makeRows(): discoverUi.DiscoveredRow[] {
  return [
    { id: 'glm-4.6', name: 'GLM 4.6', isNew: false, visible: true },
    { id: 'glm-4.6-test', name: 'glm-4.6-test', isNew: true, visible: false },
  ];
}

type ListProps = Parameters<typeof discoverUi.DiscoveredModelsList>[0];

/** Render one list to static markup through React (hooks-safe). */
function renderList(props: ListProps): string {
  return renderToStaticMarkup(React.createElement(discoverUi.DiscoveredModelsList, props));
}

/** Mount one list into a fresh jsdom document for event simulation. */
function mountList(props: ListProps): { document: Document; unmount: () => void } {
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
    root.render(React.createElement(discoverUi.DiscoveredModelsList, props));
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

test('buildDiscoveredRows marks ids missing from advertisedIds as new', () => {
  const rows = discoverUi.buildDiscoveredRows(makeInput());
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.isNew, false);
  assert.equal(rows[1]!.isNew, true);
});

test('buildDiscoveredRows falls back to id when name is missing', () => {
  const rows = discoverUi.buildDiscoveredRows(makeInput());
  assert.equal(rows[0]!.name, 'GLM 4.6');
  assert.equal(rows[1]!.name, 'glm-4.6-test');
});

test('buildDiscoveredRows resolves visible from explicit model settings', () => {
  const rows = discoverUi.buildDiscoveredRows(makeInput({
    settings: { providers: {}, models: { 'zen-free:glm-4.6': false } },
  }));
  assert.equal(rows[0]!.visible, false);
  assert.equal(rows[1]!.visible, true);
});

test('buildDiscoveredRows resolves visible from hidden patterns', () => {
  const rows = discoverUi.buildDiscoveredRows(makeInput({ patterns: ['zen-free:*test*'] }));
  assert.equal(rows[0]!.visible, true);
  assert.equal(rows[1]!.visible, false);
});

test('buildDiscoveredRows drops empty ids and keeps upstream order', () => {
  const rows = discoverUi.buildDiscoveredRows(makeInput({
    discovered: [{ id: 'b' }, { id: '' }, { id: 'a' }, { id: '' }, { id: 'c' }],
    advertisedIds: [],
  }));
  assert.deepEqual(rows.map((row) => row.id), ['b', 'a', 'c']);
  assert.ok(rows.every((row) => row.isNew));
});

test('RefreshModelsButton shows 刷新清单 and stays enabled when idle', () => {
  let calls = 0;
  const element = discoverUi.RefreshModelsButton({ pending: false, onRefresh: () => { calls += 1; } });
  const html = renderToStaticMarkup(element);
  assert.ok(html.includes('刷新清单'), 'shows idle label');
  assert.ok(!html.includes('disabled'), 'no disabled attribute');
  assert.equal(element.props.disabled, false);
  element.props.onClick();
  assert.equal(calls, 1);
});

test('RefreshModelsButton shows 刷新中… and disables when pending', () => {
  const element = discoverUi.RefreshModelsButton({ pending: true, onRefresh: () => {} });
  const html = renderToStaticMarkup(element);
  assert.ok(html.includes('刷新中…'), 'shows pending label');
  assert.ok(html.includes('disabled'), 'renders disabled attribute');
  assert.equal(element.props.disabled, true);
});

test('RefreshModelsButton honors the disabled prop when idle', () => {
  const enabled = discoverUi.RefreshModelsButton({ pending: false, onRefresh: () => {} });
  assert.equal(enabled.props.disabled, false);
  const disabled = discoverUi.RefreshModelsButton({ pending: false, disabled: true, onRefresh: () => {} });
  assert.equal(disabled.props.disabled, true);
  assert.ok(renderToStaticMarkup(disabled).includes('disabled'));
});

test('DiscoveredModelsList returns null when empty, idle, and no failure', () => {
  const idle = renderList({ provider: 'zen-free', rows: [], pending: false, onToggle: () => {}, onRefresh: () => {} });
  assert.equal(idle, '');
  const blankFailed = renderList({ provider: 'zen-free', rows: [], pending: false, failed: '', onToggle: () => {}, onRefresh: () => {} });
  assert.equal(blankFailed, '');
});

test('DiscoveredModelsList renders the section with title while pending', () => {
  const html = renderList({ provider: 'zen-free', rows: [], pending: true, onToggle: () => {}, onRefresh: () => {} });
  assert.ok(html.includes('上游发现（0）'), 'shows zero-count title');
  assert.ok(html.includes('刷新中…'), 'embeds the pending refresh button');
});

test('DiscoveredModelsList renders the failure line in the error color', () => {
  const html = renderList({ provider: 'zen-free', rows: [], pending: false, failed: '上游拉取失败', onToggle: () => {}, onRefresh: () => {} });
  assert.ok(html.includes('上游拉取失败'), 'shows failure text');
  assert.ok(html.includes('#f31260'), 'uses the error color');
});

test('DiscoveredModelsList visible toggle calls onToggle with flipped false', () => {
  const calls: Array<[string, string, boolean]> = [];
  const { document, unmount } = mountList({
    provider: 'zen-free',
    rows: makeRows(),
    pending: false,
    onToggle: (provider, model, visible) => { calls.push([provider, model, visible]); },
    onRefresh: () => {},
  });
  try {
    const buttons = [...document.querySelectorAll('button')].filter((button) =>
      ['👁', '🚫'].includes((button.textContent ?? '').trim()),
    );
    assert.equal(buttons[0]?.getAttribute('aria-pressed'), 'false');
    assert.equal((buttons[0]?.textContent ?? '').trim(), '👁');
    clickEye(document, 0);
    assert.deepEqual(calls, [['zen-free', 'glm-4.6', false]]);
  } finally {
    unmount();
  }
});

test('DiscoveredModelsList hidden toggle calls onToggle with flipped true', () => {
  const calls: Array<[string, string, boolean]> = [];
  const { document, unmount } = mountList({
    provider: 'zen-free',
    rows: makeRows(),
    pending: false,
    onToggle: (provider, model, visible) => { calls.push([provider, model, visible]); },
    onRefresh: () => {},
  });
  try {
    const buttons = [...document.querySelectorAll('button')].filter((button) =>
      ['👁', '🚫'].includes((button.textContent ?? '').trim()),
    );
    assert.equal(buttons[1]?.getAttribute('aria-pressed'), 'true');
    assert.equal((buttons[1]?.textContent ?? '').trim(), '🚫');
    const markup = document.body.innerHTML;
    assert.ok(markup.includes('opacity:0.5') || markup.includes('opacity: 0.5'), 'dims the hidden row');
    clickEye(document, 1);
    assert.deepEqual(calls, [['zen-free', 'glm-4.6-test', true]]);
  } finally {
    unmount();
  }
});

test('DiscoveredModelsList shows 新 badge only for new rows', () => {
  const html = renderList({
    provider: 'zen-free',
    rows: makeRows(),
    pending: false,
    onToggle: () => {},
    onRefresh: () => {},
  });
  const dom = new JSDOM(html);
  const badges = Array.from(dom.window.document.querySelectorAll('span')).filter((span) => span.textContent === '新');
  assert.equal(badges.length, 1);
  assert.ok(html.includes('上游发现（2）'), 'shows the row count in the title');
});

test('long discovered lists start collapsed', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ id: 'm' + i, name: 'Model ' + i, isNew: true, visible: true }));
  const html = renderList({
    provider: 'zen-free',
    rows,
    pending: false,
    onToggle: () => {},
    onRefresh: () => {},
  });
  assert.ok(html.includes('▸'), 'closed chevron');
  assert.ok(html.includes('上游发现（10）'), 'count in header');
  assert.ok(!html.includes('Model 0'), 'rows hidden until expanded');
});

test('short discovered lists start expanded', () => {
  const html = renderList({
    provider: 'zen-free',
    rows: [{ id: 'm1', name: 'Model 1', isNew: true, visible: true }],
    pending: false,
    onToggle: () => {},
    onRefresh: () => {},
  });
  assert.ok(html.includes('▾'), 'open chevron');
  assert.ok(html.includes('Model 1'), 'row visible');
});
