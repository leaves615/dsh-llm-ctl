import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import {
  applyMenuFilter,
  ensureEmptyState,
  findModelMenu,
  hasForeignSearchWidget,
  listModelRows,
  parseMenuQuery,
  removeEmptyState,
  resetMenuFilter,
} from '../src/menu-filter.ts';
import type { ModelMenuRoots } from '../src/menu-filter.ts';

/** Read one element of an array-like, failing loudly when it is missing. */
function at<T>(list: ArrayLike<T>, index: number): T {
  const value = list[index];
  assert.ok(value !== undefined, 'missing index ' + index);
  return value;
}

/** Two provider groups shaped like the real popup. */
const GROUPS =
  '<section role="group" aria-labelledby="group-zen">' +
  '<div id="group-zen">zen-free</div>' +
  '<div role="presentation">' +
  '<button role="menuitemradio" title="glm-4.6-test"><span class="_modelName_9x">glm-4.6-test</span><span class="_badge">beta</span></button>' +
  '<button role="menuitemradio"><span class="_modelName_9x">glm-4.6</span></button>' +
  '<button role="menuitemradio"><span>glm-4.5</span><span class="_hint">legacy</span></button>' +
  '</div>' +
  '</section>' +
  '<section role="group" aria-labelledby="group-openai">' +
  '<div id="group-openai">OpenAI</div>' +
  '<div role="presentation">' +
  '<button role="menuitemradio" title="gpt-5"><span class="_modelName_9x">gpt-5</span></button>' +
  '<button role="menuitemradio"><span class="_modelName_9x">gpt-4.1</span></button>' +
  '</div>' +
  '</section>';

/** Expected model names: title attribute, modelName class, then full text. */
const NAMES = ['glm-4.6-test', 'glm-4.6', 'glm-4.5legacy', 'gpt-5', 'gpt-4.1'];

interface Fixture {
  dom: JSDOM;
  doc: Document;
  roots: ModelMenuRoots;
}

interface FixtureOptions {
  label?: string | null;
  leading?: string;
  groupsHtml?: string;
  wrapper?: boolean;
}

/** Build a popup shaped like the real one: menu > plain div > sections. */
function buildMenu(options: FixtureOptions = {}): Fixture {
  const label = options.label === undefined ? '模型与推理等级' : options.label;
  const labelAttr = label === null ? '' : ' aria-label="' + label + '"';
  const leading = options.leading ?? '';
  const groupsHtml = options.groupsHtml ?? GROUPS;
  const open = options.wrapper === false ? '' : '<div class="_inner_x">';
  const close = options.wrapper === false ? '' : '</div>';
  const html =
    '<!doctype html><html><body><div class="dsh-app"><div class="popover">' +
    open +
    '<div role="menu"' +
    labelAttr +
    '>' +
    leading +
    '<div class="_groups_abc">' +
    groupsHtml +
    '</div>' +
    '</div>' +
    close +
    '</div></div></body></html>';
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const roots = findModelMenu(doc);
  assert.ok(roots !== undefined, 'fixture must contain a model menu');
  return { dom, doc, roots };
}

test('detects the Chinese model menu aria-label', () => {
  const { roots } = buildMenu();
  assert.equal(roots.menu.getAttribute('aria-label'), '模型与推理等级');
  assert.equal(roots.menu.getAttribute('role'), 'menu');
  assert.equal(roots.groups.getAttribute('role'), null);
  assert.equal(roots.groups.className, '_groups_abc');
  assert.equal(roots.groups.querySelectorAll('section[role="group"]').length, 2);
});

test('detects the English model menu aria-label and any matching label', () => {
  const english = buildMenu({ label: 'Model and reasoning effort' });
  assert.equal(listModelRows(english.roots).length, 5);
  for (const label of ['models', '推理等级', 'Reasoning Effort', 'pick a MODEL']) {
    assert.equal(listModelRows(buildMenu({ label }).roots).length, 5, label);
  }
});

test('finds the menu inside a nested container and takes the first match', () => {
  const { doc, roots } = buildMenu();
  const decoy = doc.createElement('div');
  decoy.setAttribute('role', 'menu');
  decoy.setAttribute('aria-label', 'Sort order');
  decoy.innerHTML = '<div><section role="group"></section></div>';
  doc.body.insertBefore(decoy, doc.body.firstChild);
  assert.equal(findModelMenu(doc)?.menu.getAttribute('aria-label'), '模型与推理等级');
  const popover = doc.querySelector('.popover');
  assert.ok(popover !== null);
  assert.equal(findModelMenu(popover)?.menu.getAttribute('aria-label'), '模型与推理等级');
  assert.equal(findModelMenu(roots.menu)?.menu, roots.menu);
  assert.equal(findModelMenu(decoy), undefined);
});

test('falls back to an unlabelled menu that already contains groups', () => {
  const { roots } = buildMenu({ label: null });
  assert.equal(roots.menu.getAttribute('aria-label'), null);
  assert.equal(listModelRows(roots).length, 5);
});

test('ignores a menu labelled for something else', () => {
  const dom = new JSDOM(
    '<!doctype html><body><div role="menu" aria-label="Sort order"><div><section role="group"></section></div></div></body>',
  );
  assert.equal(findModelMenu(dom.window.document), undefined);
});

test('returns undefined when no model menu is present', () => {
  const plain = new JSDOM('<!doctype html><body><p>hello</p></body>');
  assert.equal(findModelMenu(plain.window.document), undefined);
  assert.equal(findModelMenu(plain.window.document.createElement('div')), undefined);
  assert.equal(findModelMenu(undefined as unknown as ParentNode), undefined);
});

test('resolves the group container past role-bearing wrappers', () => {
  const { roots } = buildMenu({ leading: '<div role="presentation" class="_searchRow"></div>' });
  assert.equal(roots.groups.className, '_groups_abc');
  assert.equal(roots.groups.parentElement, roots.menu);
  assert.equal(roots.groups.previousElementSibling?.getAttribute('role'), 'presentation');
  assert.equal(buildMenu({ wrapper: false }).roots.groups.className, '_groups_abc');
});

test('lists every row in DOM order with three-level name resolution', () => {
  const { roots } = buildMenu();
  const rows = listModelRows(roots);
  assert.deepEqual(
    rows.map((row) => row.modelName),
    NAMES,
  );
  assert.deepEqual(
    rows.map((row) => row.providerName),
    ['zen-free', 'zen-free', 'zen-free', 'OpenAI', 'OpenAI'],
  );
  assert.equal(at(rows, 0).row.getAttribute('title'), 'glm-4.6-test');
  assert.equal(at(rows, 2).row.getAttribute('title'), null);
});

test('query filtering is case-insensitive and trims whitespace', () => {
  const { roots } = buildMenu();
  assert.deepEqual(applyMenuFilter(roots, { query: '  GLM  ' }), { shown: 3, hidden: 2, groupsHidden: 1 });
  const rows = listModelRows(roots);
  for (let index = 0; index < 3; index += 1) assert.equal(at(rows, index).row.style.display, '');
  assert.equal(at(rows, 3).row.style.display, 'none');
  assert.equal(at(rows, 4).row.style.display, 'none');
});

test('query matches the provider name as well as the model name', () => {
  const { roots } = buildMenu();
  assert.deepEqual(applyMenuFilter(roots, { query: 'OPENAI' }), { shown: 2, hidden: 3, groupsHidden: 1 });
});

test('an empty or whitespace-only query filters nothing', () => {
  const { roots } = buildMenu();
  assert.deepEqual(applyMenuFilter(roots), { shown: 5, hidden: 0, groupsHidden: 0 });
  assert.deepEqual(applyMenuFilter(roots, { query: '   ' }), { shown: 5, hidden: 0, groupsHidden: 0 });
});

test('isRowVisible hides rows the predicate rejects', () => {
  const { roots } = buildMenu();
  assert.deepEqual(applyMenuFilter(roots, { isRowVisible: (row) => row.modelName !== 'gpt-5' }), {
    shown: 4,
    hidden: 1,
    groupsHidden: 0,
  });
  const gpt5 = listModelRows(roots).find((row) => row.modelName === 'gpt-5');
  assert.ok(gpt5 !== undefined);
  assert.equal(gpt5.row.style.display, 'none');
});

test('query and isRowVisible combine with AND semantics', () => {
  const { roots } = buildMenu();
  const visited: string[] = [];
  const result = applyMenuFilter(roots, {
    query: 'glm',
    isRowVisible: (row) => {
      visited.push(row.modelName);
      return !row.modelName.includes('test');
    },
  });
  assert.deepEqual(result, { shown: 2, hidden: 3, groupsHidden: 1 });
  assert.deepEqual(visited, NAMES);
  assert.equal(applyMenuFilter(roots, { query: 'test' }).shown, 1);
});

test('a fully filtered group collapses and resetMenuFilter restores every display', () => {
  const { roots } = buildMenu();
  const sections = Array.from(roots.groups.querySelectorAll<HTMLElement>('section[role="group"]'));
  assert.equal(sections.length, 2);
  assert.deepEqual(applyMenuFilter(roots, { query: 'gpt' }), { shown: 2, hidden: 3, groupsHidden: 1 });
  assert.equal(at(sections, 0).style.display, 'none');
  assert.equal(at(sections, 1).style.display, '');
  resetMenuFilter(roots);
  for (const section of sections) assert.equal(section.style.display, '');
  for (const row of listModelRows(roots)) assert.equal(row.row.style.display, '');
  assert.equal(roots.groups.querySelectorAll('section[role="group"]').length, 2, 'nothing is removed');
});

test('hideUnmatched=false ignores the query but keeps isRowVisible', () => {
  const { roots } = buildMenu();
  assert.deepEqual(
    applyMenuFilter(roots, {
      query: 'nothing-matches',
      hideUnmatched: false,
      isRowVisible: (row) => row.providerName === 'OpenAI',
    }),
    { shown: 2, hidden: 3, groupsHidden: 1 },
  );
  assert.deepEqual(applyMenuFilter(roots, { query: 'nothing-matches', hideUnmatched: false }), {
    shown: 5,
    hidden: 0,
    groupsHidden: 0,
  });
});

test('detects a foreign model-search widget above the groups', () => {
  const container = buildMenu({ leading: '<div class="dsh-model-search-container _x"><input class="_i"></div>' });
  assert.equal(hasForeignSearchWidget(container.roots), true);
  const input = buildMenu({ leading: '<div class="_row"><input class="dsh-model-search-input _y"></div>' });
  assert.equal(hasForeignSearchWidget(input.roots), true);
  const { doc, roots } = buildMenu();
  const widget = doc.createElement('div');
  widget.className = 'dsh-model-search-container';
  const inner = roots.menu.parentElement;
  assert.ok(inner !== null);
  inner.insertBefore(widget, roots.menu);
  assert.equal(hasForeignSearchWidget(roots), true, 'a widget inside the menu parent counts');
});

test('reports no foreign widget for a plain menu or an unrelated search box', () => {
  assert.equal(hasForeignSearchWidget(buildMenu().roots), false);
  const unrelated = buildMenu({ leading: '<div class="_row"><input class="dsh-llm-ctl-search"></div>' });
  assert.equal(hasForeignSearchWidget(unrelated.roots), false);
  const after = buildMenu({ groupsHtml: GROUPS + '<div class="dsh-model-search-container"></div>' });
  assert.equal(hasForeignSearchWidget(after.roots), false, 'a widget after the groups is not the search slot');
});

test('ensureEmptyState inserts, updates, and removes the empty state', () => {
  const { roots } = buildMenu();
  let restored = 0;
  const empty = ensureEmptyState(roots, '无可见模型', '显示 3 个隐藏项', () => {
    restored += 1;
  });
  assert.equal(empty.id, 'dsh-llm-ctl-empty');
  assert.equal(empty.parentElement, roots.groups.parentElement);
  assert.equal(empty.previousElementSibling, null);
  assert.equal(roots.groups.previousElementSibling, empty);
  assert.equal(empty.querySelector('.dsh-llm-ctl-empty-text')?.textContent, '无可见模型');
  const button = empty.querySelector('button');
  assert.ok(button !== null);
  assert.equal(button.textContent, '显示 3 个隐藏项');
  button.click();
  assert.equal(restored, 1);

  let second = 0;
  const updated = ensureEmptyState(roots, '换一个文案', '恢复', () => {
    second += 1;
  });
  assert.equal(updated, empty, 'the same element is reused');
  assert.equal(empty.querySelectorAll('button').length, 1);
  assert.equal(empty.textContent, '换一个文案恢复');
  at(empty.querySelectorAll('button'), 0).click();
  assert.equal(restored, 1);
  assert.equal(second, 1);

  removeEmptyState(roots);
  assert.equal(roots.menu.querySelector('#dsh-llm-ctl-empty'), null);
  assert.doesNotThrow(() => removeEmptyState(roots));
});

test('malformed DOM never throws and degrades to empty results', () => {
  const dom = new JSDOM('<!doctype html><body></body>');
  const doc = dom.window.document;
  const loose: ModelMenuRoots = { menu: doc.createElement('div'), groups: doc.createElement('div') };
  assert.deepEqual(listModelRows(loose), []);
  assert.deepEqual(applyMenuFilter(loose), { shown: 0, hidden: 0, groupsHidden: 0 });
  assert.equal(hasForeignSearchWidget(loose), false);
  assert.doesNotThrow(() => resetMenuFilter(loose));
  assert.doesNotThrow(() => removeEmptyState(loose));
  assert.doesNotThrow(() => applyMenuFilter(loose, { query: 'x', isRowVisible: () => true }));

  const broken = doc.createElement('div');
  broken.innerHTML =
    '<section role="group"><button role="menuitemradio"></button></section>' +
    '<section role="group"><div></div></section>';
  const roots: ModelMenuRoots = { menu: broken, groups: broken };
  const rows = listModelRows(roots);
  assert.equal(rows.length, 1);
  assert.equal(at(rows, 0).providerName, '');
  assert.equal(at(rows, 0).modelName, '');
  assert.deepEqual(applyMenuFilter(roots, { query: 'x' }), { shown: 0, hidden: 1, groupsHidden: 1 });
  resetMenuFilter(roots);
  assert.equal(at(rows, 0).row.style.display, '');

  const emptyState = ensureEmptyState(loose, 'none', 'restore', () => undefined);
  assert.equal(emptyState.id, 'dsh-llm-ctl-empty');
  assert.doesNotThrow(() => removeEmptyState(loose));

  const throwing = applyMenuFilter(roots, {
    isRowVisible: () => {
      throw new Error('boom');
    },
  });
  assert.deepEqual(throwing, { shown: 0, hidden: 1, groupsHidden: 1 });
});

test('parseMenuQuery splits plain and provider-scoped terms', () => {
  assert.deepEqual(parseMenuQuery('deepseek flash'), { providerTerms: [], modelTerms: ['deepseek', 'flash'] });
  assert.deepEqual(parseMenuQuery('p:zen glm'), { providerTerms: ['zen'], modelTerms: ['glm'] });
  assert.deepEqual(parseMenuQuery('provider:OpenAI GPT'), { providerTerms: ['openai'], modelTerms: ['gpt'] });
  assert.deepEqual(parseMenuQuery('p:'), { providerTerms: [], modelTerms: [] });
  assert.deepEqual(parseMenuQuery('   '), { providerTerms: [], modelTerms: [] });
});

test('a p: term restricts its token to the provider name', () => {
  const { roots } = buildMenu();
  assert.deepEqual(applyMenuFilter(roots, { query: 'p:zen' }), { shown: 3, hidden: 2, groupsHidden: 1 });
  assert.deepEqual(applyMenuFilter(roots, { query: 'p:OPENAI' }), { shown: 2, hidden: 3, groupsHidden: 1 });
  assert.deepEqual(applyMenuFilter(roots, { query: 'p:nomatch' }), { shown: 0, hidden: 5, groupsHidden: 2 });
});

test('provider and model terms combine with AND semantics', () => {
  const { roots } = buildMenu();
  assert.deepEqual(applyMenuFilter(roots, { query: 'p:zen glm-4.6' }), { shown: 2, hidden: 3, groupsHidden: 1 });
  assert.deepEqual(applyMenuFilter(roots, { query: 'p:zen gpt' }), { shown: 0, hidden: 5, groupsHidden: 2 });
});

test('a bare p: prefix is ignored instead of hiding everything', () => {
  const { roots } = buildMenu();
  assert.deepEqual(applyMenuFilter(roots, { query: 'p:' }), { shown: 5, hidden: 0, groupsHidden: 0 });
  assert.deepEqual(applyMenuFilter(roots, { query: 'glm p:' }), { shown: 3, hidden: 2, groupsHidden: 1 });
});
