import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { applyVisibilityOnly } from '../src/menu-visibility.ts';
import { findModelMenu } from '../src/menu-filter.ts';
import type { ModelMenuRoots } from '../src/menu-filter.ts';

/** Popup with two groups; the second row arrives pre-hidden by a foreign filter. */
function buildMenu(): { document: Document; roots: ModelMenuRoots } {
  const dom = new JSDOM(
    '<!doctype html><html><body>' +
    '<div role="menu" aria-label="\u6a21\u578b\u4e0e\u63a8\u7406\u7b49\u7ea7">' +
    '<div class="groups">' +
    '<section role="group" aria-labelledby="g-a"><div id="g-a">Alpha</div>' +
    '<button role="menuitemradio" title="a-one">a-one</button>' +
    '<button role="menuitemradio" title="a-two">a-two</button>' +
    '</section>' +
    '<section role="group" aria-labelledby="g-b"><div id="g-b">Beta</div>' +
    '<button role="menuitemradio" title="b-one">b-one</button>' +
    '</section>' +
    '</div></div></body></html>',
  );
  const document = dom.window.document;
  const foreignHidden = document.querySelectorAll('[role="menuitemradio"]')[1] as HTMLElement;
  foreignHidden.style.display = 'none';
  const roots = findModelMenu(document);
  assert.ok(roots !== undefined, 'menu resolves');
  return { document, roots };
}

test('hides rejected rows and leaves passing rows untouched', () => {
  const { roots } = buildMenu();
  const result = applyVisibilityOnly(roots, (row) => row.modelName !== 'a-one');
  assert.deepEqual(result, { hidden: 1, restored: 0 });
  const rows = [...roots.groups.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
  assert.equal(rows[0]?.style.display, 'none');
  assert.equal(rows[0]?.dataset['llmCtlHidden'], '1');
  assert.equal(rows[2]?.style.display, '', 'passing rows are never rewritten');
});

test('a foreign-hidden row is neither counted nor restored', () => {
  const { roots } = buildMenu();
  const result = applyVisibilityOnly(roots, () => true);
  assert.deepEqual(result, { hidden: 0, restored: 0 });
  const rows = [...roots.groups.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
  assert.equal(rows[1]?.style.display, 'none', 'foreign display:none survives');
  assert.equal(rows[1]?.dataset['llmCtlHidden'], undefined);
});

test('restores only rows this pass hid when the predicate flips', () => {
  const { roots } = buildMenu();
  applyVisibilityOnly(roots, (row) => row.modelName !== 'a-one');
  const result = applyVisibilityOnly(roots, () => true);
  assert.deepEqual(result, { hidden: 0, restored: 1 });
  const rows = [...roots.groups.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
  assert.equal(rows[0]?.style.display, '');
  assert.equal(rows[0]?.dataset['llmCtlHidden'], undefined);
  assert.equal(rows[1]?.style.display, 'none', 'foreign row still untouched');
});

test('a throwing predicate hides the row instead of breaking the pass', () => {
  const { roots } = buildMenu();
  const result = applyVisibilityOnly(roots, () => {
    throw new Error('boom');
  });
  assert.equal(result.hidden, 3);
});

test('groups are never collapsed by the hide-only pass', () => {
  const { roots } = buildMenu();
  applyVisibilityOnly(roots, () => false);
  for (const group of roots.groups.querySelectorAll<HTMLElement>('section[role="group"]')) {
    assert.equal(group.style.display, '');
  }
});

test('repeated passes are idempotent', () => {
  const { roots } = buildMenu();
  const first = applyVisibilityOnly(roots, (row) => row.modelName !== 'a-one');
  const second = applyVisibilityOnly(roots, (row) => row.modelName !== 'a-one');
  assert.deepEqual(first, { hidden: 1, restored: 0 });
  assert.deepEqual(second, { hidden: 0, restored: 0 });
});