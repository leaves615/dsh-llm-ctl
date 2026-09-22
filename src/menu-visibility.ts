/**
 * Hide-only reconciliation for menus owned by a foreign search widget.
 *
 * A foreign plugin (for example dsh-model-search-plugin) owns query filtering,
 * group collapsing, and empty states in its menu. Rewriting every passing row's
 * display would wipe its filtering on every poll tick, which is exactly the
 * type-then-revert symptom. This pass only ever hides rows our own switches
 * reject, and it only ever restores rows it hid itself (tracked with a data
 * marker), so the two plugins compose instead of fighting.
 *
 * @module dsh-llm-ctl/menu-visibility
 */
import type { ModelMenuRoots, ModelMenuRow } from './menu-filter.ts';

/** Marker set on rows hidden by this pass, so only they are ever restored. */
const HIDDEN_MARKER = 'llmCtlHidden';

/** Outcome of one hide-only reconciliation pass. */
export interface VisibilityOnlyResult {
  hidden: number;
  restored: number;
}

/** Group title with the same fallbacks as the menu parser. */
function groupTitleOf(group: Element): string {
  try {
    const titled = group.querySelector('div[id]');
    if (titled !== null) return (titled.textContent ?? '').trim();
    const labelledBy = group.getAttribute('aria-labelledby');
    if (labelledBy !== null && labelledBy.length > 0) {
      const target = group.ownerDocument?.getElementById(labelledBy);
      if (target !== null && target !== undefined) return (target.textContent ?? '').trim();
    }
    return (group.getAttribute('aria-label') ?? '').trim();
  } catch {
    return '';
  }
}

/** Row display name with the same fallbacks as the menu parser. */
function rowNameOf(row: Element): string {
  try {
    const title = row.getAttribute('title');
    if (title !== null && title.trim().length > 0) return title.trim();
    const named = row.querySelector('[class*="modelName"]');
    if (named !== null && (named.textContent ?? '').trim().length > 0) return (named.textContent ?? '').trim();
    return (row.textContent ?? '').trim();
  } catch {
    return '';
  }
}

/**
 * Hide rows rejected by our own switches without touching anything else.
 *
 * @param roots Popup roots from findModelMenu.
 * @param isRowVisible Visibility predicate; rows without a decision stay visible.
 * @returns Counts of newly hidden and restored rows.
 */
export function applyVisibilityOnly(roots: ModelMenuRoots, isRowVisible: (row: ModelMenuRow) => boolean): VisibilityOnlyResult {
  const result: VisibilityOnlyResult = { hidden: 0, restored: 0 };
  try {
    for (const group of roots.groups.querySelectorAll('section[role="group"]')) {
      const providerName = groupTitleOf(group);
      for (const row of group.querySelectorAll<HTMLElement>('[role="menuitemradio"]')) {
        const model: ModelMenuRow = { row, providerName, modelName: rowNameOf(row) };
        let visible = true;
        try {
          visible = isRowVisible(model) !== false;
        } catch {
          visible = false;
        }
        if (!visible) {
          if (row.style.display !== 'none') row.style.display = 'none';
          if (row.dataset[HIDDEN_MARKER] !== '1') {
            row.dataset[HIDDEN_MARKER] = '1';
            result.hidden += 1;
          }
        } else if (row.dataset[HIDDEN_MARKER] === '1') {
          row.style.display = '';
          delete row.dataset[HIDDEN_MARKER];
          result.restored += 1;
        }
      }
    }
  } catch {
    // Malformed DOM: return the counts accumulated so far.
  }
  return result;
}