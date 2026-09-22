import assert from 'node:assert/strict';
import test from 'node:test';
import {
  filterCatalog,
  hiddenCount,
  isModelVisible,
  isProviderVisible,
  matchesPattern,
  modelKey,
  normalizePattern,
  pickFallback,
  setAllVisible,
  setModelVisible,
  setProviderVisible,
} from '../src/visibility.ts';
import type { CatalogEntry, VisibilityConfig, VisibilitySettings } from '../src/visibility.ts';

const EMPTY: VisibilitySettings = { providers: {}, models: {} };

/** Catalog row carrying an extra field, to prove filtering preserves the row type. */
interface Row extends CatalogEntry {
  rank: number;
}

const CATALOG: readonly Row[] = [
  { provider: 'zen-free', model: 'gpt-nightly-1', displayName: 'Nightly', rank: 0 },
  { provider: 'zen-free', model: 'gpt-4o', displayName: 'GPT-4o', rank: 1 },
  { provider: 'openrouter', model: 'claude-sonnet', displayName: 'Sonnet', rank: 2 },
  { provider: 'openrouter', model: 'gpt-4o-test-preview', displayName: 'Test preview', rank: 3 },
  { provider: 'deepseek', model: 'deepseek-chat', rank: 4 },
];

function settings(providers: Record<string, boolean>, models: Record<string, boolean>): VisibilitySettings {
  return { providers, models };
}

test('normalizePattern trims and lower-cases', () => {
  assert.equal(normalizePattern('  ZEN-FREE:*Nightly*  '), 'zen-free:*nightly*');
  assert.equal(normalizePattern('gpt-4o'), 'gpt-4o');
  assert.equal(normalizePattern(''), '');
});

test('modelKey joins provider and model with a colon', () => {
  assert.equal(modelKey('zen-free', 'gpt-4o'), 'zen-free:gpt-4o');
  assert.equal(modelKey('openrouter', 'a:b'), 'openrouter:a:b');
});

test('a star matches any run of characters, colons included', () => {
  assert.equal(matchesPattern('zen-free:*', 'zen-free', 'gpt-4o'), true);
  assert.equal(matchesPattern('zen-free:*', 'zen-free', ''), true);
  assert.equal(matchesPattern('*', 'anything', 'anything'), true);
  assert.equal(matchesPattern('zen-free:openrouter:gpt*', 'zen-free', 'openrouter:gpt-4'), true);
  assert.equal(matchesPattern('zen-free:openrouter:gpt*', 'zen-free', 'openrouter:claude'), false);
});

test('matching is case-insensitive on both the pattern and the candidate', () => {
  assert.equal(matchesPattern('ZEN-FREE:*NIGHTLY*', 'zen-free', 'gpt-nightly-1'), true);
  assert.equal(matchesPattern('zen-free:nightly*', 'ZEN-FREE', 'Nightly-1'), true);
  assert.equal(matchesPattern('  Zen-Free:GPT-4O  ', 'zen-free', 'gpt-4o'), true);
});

test('a model-only pattern applies to every provider', () => {
  assert.equal(matchesPattern('*-test-*', 'zen-free', 'gpt-4o-test-preview'), true);
  assert.equal(matchesPattern('*-test-*', 'openrouter', 'gpt-4o-test-preview'), true);
  assert.equal(matchesPattern('*-test-*', 'deepseek', 'deepseek-chat'), false);
  assert.equal(matchesPattern('gpt-4o', 'deepseek', 'gpt-4o'), true);
});

test('a provider:model pattern only hits its own provider', () => {
  assert.equal(matchesPattern('zen-free:gpt-4o', 'zen-free', 'gpt-4o'), true);
  assert.equal(matchesPattern('zen-free:gpt-4o', 'openrouter', 'gpt-4o'), false);
  assert.equal(matchesPattern('zen-free:gpt-4o', 'zen-free', 'gpt-4o-mini'), false);
});

test('unsupported metacharacters are literal characters', () => {
  assert.equal(matchesPattern('gpt-4?', 'p', 'gpt-4'), false);
  assert.equal(matchesPattern('gpt-4?', 'p', 'gpt-4?'), true);
  assert.equal(matchesPattern('a[bc]d', 'p', 'abd'), false);
  assert.equal(matchesPattern('a[bc]d', 'p', 'a[bc]d'), true);
  assert.equal(matchesPattern('gpt.4', 'p', 'gpt-4'), false);
  assert.equal(matchesPattern('gpt+4', 'p', 'gpt4'), false);
  assert.equal(matchesPattern('gpt+4', 'p', 'gpt+4'), true);
});

test('without a model only a whole-provider pattern matches', () => {
  assert.equal(matchesPattern('zen-free:*', 'zen-free'), true);
  assert.equal(matchesPattern('zen-free:', 'zen-free'), true);
  assert.equal(matchesPattern('zen-free:gpt*', 'zen-free'), false);
  assert.equal(matchesPattern('*-test-*', 'zen-free'), false);
  assert.equal(matchesPattern('zen-free', 'zen-free'), false);
});

test('empty settings leave every provider and model visible', () => {
  assert.equal(isProviderVisible('zen-free', EMPTY), true);
  assert.equal(isModelVisible('zen-free', 'gpt-4o', EMPTY), true);
  assert.deepEqual(filterCatalog(CATALOG, EMPTY).hidden, []);
  assert.equal(hiddenCount(CATALOG, EMPTY), 0);
  assert.equal(pickFallback(CATALOG[0]!, CATALOG, EMPTY), undefined);
});

test('an explicit model entry outranks an explicit provider entry', () => {
  const on = settings({ 'zen-free': true }, { 'zen-free:gpt-4o': false });
  assert.equal(isModelVisible('zen-free', 'gpt-4o', on), false);
  assert.equal(isModelVisible('zen-free', 'gpt-nightly-1', on), true);
  const off = settings({ 'zen-free': false }, { 'zen-free:gpt-4o': true });
  assert.equal(isModelVisible('zen-free', 'gpt-4o', off), false, 'provider=false short-circuits');
  assert.equal(isModelVisible('zen-free', 'gpt-nightly-1', off), false);
});

test('preset patterns hide below the explicit switches and above the default', () => {
  const config: VisibilityConfig = { hiddenPatterns: ['*-test-*', 'zen-free:*nightly*'] };
  assert.equal(isModelVisible('openrouter', 'gpt-4o-test-preview', EMPTY, config), false);
  assert.equal(isModelVisible('zen-free', 'gpt-nightly-1', EMPTY, config), false);
  assert.equal(isModelVisible('zen-free', 'gpt-4o', EMPTY, config), true);
  assert.equal(isModelVisible('zen-free', 'gpt-nightly-1', settings({ 'zen-free': true }, {}), config), true);
  assert.equal(isModelVisible('openrouter', 'gpt-4o-test-preview', EMPTY, { hiddenPatterns: [] }), true);
  assert.equal(isModelVisible('openrouter', 'gpt-4o-test-preview', EMPTY, undefined), true);
});

test('isProviderVisible resolves switch, whole-provider pattern, then default', () => {
  assert.equal(isProviderVisible('zen-free', settings({ 'zen-free': false }, {}), undefined), false);
  assert.equal(isProviderVisible('zen-free', settings({ 'zen-free': true }, {}), undefined), true);
  assert.equal(isProviderVisible('zen-free', EMPTY, { hiddenPatterns: ['zen-free:*'] }), false);
  assert.equal(isProviderVisible('zen-free', EMPTY, { hiddenPatterns: ['*-test-*'] }), true);
  assert.equal(isProviderVisible('zen-free', settings({ 'zen-free': true }, {}), { hiddenPatterns: ['zen-free:*'] }), true);
  assert.equal(isProviderVisible('deepseek', EMPTY, undefined), true);
});

test('setProviderVisible is immutable and always returns a fresh object', () => {
  const before = settings({ 'zen-free': true }, { 'zen-free:gpt-4o': false });
  const next = setProviderVisible(before, 'openrouter', false);
  assert.notEqual(next, before);
  assert.notEqual(next.providers, before.providers);
  assert.notEqual(next.models, before.models);
  assert.deepEqual(next.providers, { 'zen-free': true, openrouter: false });
  assert.deepEqual(next.models, { 'zen-free:gpt-4o': false }, 'model table copied untouched');
  assert.deepEqual(before.providers, { 'zen-free': true }, 'input not mutated');
  const repeat = setProviderVisible(next, 'openrouter', false);
  assert.notEqual(repeat, next);
  assert.notEqual(repeat.providers, next.providers);
  assert.deepEqual(repeat, next);
});

test('setModelVisible is immutable and keyed by provider:model', () => {
  const before = settings({ 'zen-free': true }, { 'zen-free:gpt-4o': false });
  const next = setModelVisible(before, 'openrouter', 'claude-sonnet', false);
  assert.notEqual(next, before);
  assert.notEqual(next.models, before.models);
  assert.notEqual(next.providers, before.providers);
  assert.deepEqual(next.models, { 'zen-free:gpt-4o': false, 'openrouter:claude-sonnet': false });
  assert.deepEqual(before.models, { 'zen-free:gpt-4o': false }, 'input not mutated');
  const repeat = setModelVisible(next, 'openrouter', 'claude-sonnet', false);
  assert.notEqual(repeat, next);
  assert.deepEqual(repeat, next);
});

test('setAllVisible clears both tables', () => {
  const before = settings({ 'zen-free': false, deepseek: true }, { 'zen-free:gpt-4o': false });
  const cleared = setAllVisible(before);
  assert.notEqual(cleared, before);
  assert.deepEqual(cleared, { providers: {}, models: {} });
  assert.deepEqual(before.providers, { 'zen-free': false, deepseek: true }, 'input not mutated');
  assert.equal(isModelVisible('zen-free', 'gpt-4o', cleared), true);
  assert.equal(isProviderVisible('zen-free', cleared), true);
});

test('filterCatalog preserves order, grouping, and row identity', () => {
  const config: VisibilityConfig = { hiddenPatterns: ['*-test-*'] };
  const hidden = setProviderVisible(setModelVisible(EMPTY, 'zen-free', 'gpt-nightly-1', false), 'deepseek', false);
  const { visible, hidden: hiddenRows } = filterCatalog(CATALOG, hidden, config);
  assert.deepEqual(
    visible.map((row) => row.model),
    ['gpt-4o', 'claude-sonnet'],
  );
  assert.deepEqual(
    hiddenRows.map((row) => row.model),
    ['gpt-nightly-1', 'gpt-4o-test-preview', 'deepseek-chat'],
  );
  assert.equal(visible[0], CATALOG[1], 'rows are passed through, not copied');
  assert.equal(hiddenRows[0], CATALOG[0]);
  assert.equal(visible[0]!.rank, 1, 'extra fields survive the generic filter');
  assert.equal(visible.length + hiddenRows.length, CATALOG.length);
  assert.deepEqual(CATALOG.map((row) => row.rank), [0, 1, 2, 3, 4], 'input rows untouched');
});

test('hiddenCount equals the hidden slice length', () => {
  const config: VisibilityConfig = { hiddenPatterns: ['zen-free:*nightly*'] };
  const hidden = setProviderVisible(EMPTY, 'deepseek', false);
  assert.equal(hiddenCount(CATALOG, hidden, config), filterCatalog(CATALOG, hidden, config).hidden.length);
  assert.equal(hiddenCount(CATALOG, hidden, config), 2);
  assert.equal(hiddenCount(CATALOG, EMPTY), 0);
});

test('pickFallback returns undefined when the current selection is visible', () => {
  const current: CatalogEntry = { provider: 'openrouter', model: 'claude-sonnet' };
  assert.equal(pickFallback(current, CATALOG, EMPTY), undefined);
  const hidden = setModelVisible(EMPTY, 'zen-free', 'gpt-nightly-1', false);
  assert.equal(pickFallback({ provider: 'zen-free', model: 'gpt-4o' }, CATALOG, hidden), undefined);
});

test('pickFallback returns the first visible entry when the selection is hidden', () => {
  const hidden = setModelVisible(setProviderVisible(EMPTY, 'zen-free', false), 'openrouter', 'claude-sonnet', false);
  const fallback = pickFallback({ provider: 'zen-free', model: 'gpt-4o' }, CATALOG, hidden);
  assert.equal(fallback, CATALOG[3]);
  assert.equal(fallback?.model, 'gpt-4o-test-preview');
  const config: VisibilityConfig = { hiddenPatterns: ['*-test-*'] };
  assert.equal(
    pickFallback({ provider: 'zen-free', model: 'gpt-4o' }, CATALOG, hidden, config)?.model,
    'deepseek-chat',
    'presets only remove more rows',
  );
});

test('pickFallback returns undefined when nothing is visible', () => {
  const allHidden = setProviderVisible(EMPTY, 'zen-free', false);
  const nothing = settings({ 'zen-free': false, openrouter: false, deepseek: false }, {});
  assert.equal(pickFallback({ provider: 'zen-free', model: 'gpt-4o' }, CATALOG, nothing), undefined);
  assert.equal(pickFallback({ provider: 'zen-free', model: 'gone' }, [], nothing), undefined);
  assert.equal(pickFallback({ provider: 'zen-free', model: 'gone' }, CATALOG, allHidden)?.provider, 'openrouter');
});

test('a hidden selection not present in the catalog still falls back', () => {
  const hidden = setModelVisible(EMPTY, 'zen-free', 'gpt-4o', false);
  assert.equal(pickFallback({ provider: 'zen-free', model: 'gpt-4o' }, CATALOG, hidden), CATALOG[0]);
  assert.equal(pickFallback({ provider: 'zen-free', model: 'gpt-4o' }, [], hidden), undefined);
});
