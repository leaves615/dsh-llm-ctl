/**
 * DOM filtering for the model-selection popup (PRD FR3.2 / FR3.3).
 *
 * The module owns no state and no event listeners of its own: callers hand it
 * the popup roots (or a container to search) and it reports what it hid. The
 * selectors are deliberately fuzzy — the popup's hashed class prefixes change
 * on every harness build, so only `[class*=...]` matching and the stable
 * ARIA/role contract may be relied upon.
 *
 * @module dsh-llm-ctl/menu-filter
 */

/** Stable id of the injected empty-state element. */
const EMPTY_STATE_ID = 'dsh-llm-ctl-empty';

/** `Node.DOCUMENT_POSITION_FOLLOWING`, inlined to avoid depending on a DOM global. */
const DOCUMENT_POSITION_FOLLOWING = 4;

/** The popup nodes this module operates on. */
export interface ModelMenuRoots {
  /** The `div[role="menu"]` element of the model-selection popup. */
  menu: HTMLElement;
  /** The container holding the `section[role="group"]` provider groups. */
  groups: HTMLElement;
}

/** One selectable model row and the display names read from the DOM. */
export interface ModelMenuRow {
  /** The `[role="menuitemradio"]` button element. */
  row: HTMLElement;
  /** Provider name, i.e. the owning group's title text. */
  providerName: string;
  /** Model display name resolved from the row. */
  modelName: string;
}

/** Filter inputs for {@link applyMenuFilter}. */
export interface MenuFilterOptions {
  /** Free-text query; empty or whitespace-only means "no query". */
  query?: string;
  /** Extra predicate; a row must also pass it to stay visible. */
  isRowVisible?: (row: ModelMenuRow) => boolean;
  /** When false, `query` is ignored and only `isRowVisible` applies. Defaults to true. */
  hideUnmatched?: boolean;
}

/** Outcome of one {@link applyMenuFilter} pass. */
export interface MenuFilterResult {
  /** Rows left visible. */
  shown: number;
  /** Rows set to `display: none`. */
  hidden: number;
  /** Groups set to `display: none` because none of their rows stayed visible. */
  groupsHidden: number;
}

/** True when an aria-label names the model-selection menu. */
function isModelMenuLabel(label: string): boolean {
  const value = label.toLowerCase();
  return value.includes('model') || label.includes('推理等级') || value.includes('effort');
}

/** True when the node exposes `Element.matches` (avoids `instanceof` on globals). */
function isElement(node: unknown): node is Element {
  return typeof node === 'object' && node !== null && typeof (node as Element).matches === 'function';
}

/** The groups container of `roots`, or undefined when the roots are malformed. */
function groupsOf(roots: ModelMenuRoots | undefined): HTMLElement | undefined {
  const groups = roots?.groups;
  return groups ?? undefined;
}

/** The menu element of `roots`, or undefined when the roots are malformed. */
function menuOf(roots: ModelMenuRoots | undefined): HTMLElement | undefined {
  const menu = roots?.menu;
  return menu ?? undefined;
}

/** The first reachable document among the candidates. */
function documentOf(...candidates: Array<Element | null | undefined>): Document | undefined {
  for (const candidate of candidates) {
    const owner = candidate?.ownerDocument;
    if (owner !== undefined && owner !== null) return owner;
  }
  return typeof document === 'undefined' ? undefined : document;
}

/** The raw class attribute of an element, never its `className` object form. */
function classAttributeOf(element: Element): string {
  return element.getAttribute('class') ?? '';
}

/**
 * Resolve the container that holds the `section[role="group"]` children.
 *
 * The popup wraps the groups in a plain div (no `role`), optionally preceded by
 * presentation wrappers such as a search-box row.
 */
function findGroupsContainer(menu: HTMLElement): HTMLElement {
  for (const candidate of menu.querySelectorAll<HTMLElement>('div')) {
    if (candidate.getAttribute('role') !== null) continue;
    if (candidate.querySelector('[role="group"]') !== null) return candidate;
  }
  for (const child of Array.from(menu.children)) {
    if (child.querySelector('[role="group"]') !== null) return child as HTMLElement;
  }
  return menu;
}

/**
 * Find the model-selection popup inside a container.
 *
 * Matches `div[role="menu"]` whose aria-label mentions the model menu in either
 * locale ("模型与推理等级", "Model and reasoning effort", or any label containing
 * `model`/`推理等级`/`effort`). When no labelled candidate exists, an unlabelled
 * menu that already contains `[role="group"]` is accepted. The first match wins.
 *
 * @param root Document, fragment, or element to search within.
 * @returns The popup roots, or undefined when no model menu is present.
 */
export function findModelMenu(root: ParentNode): ModelMenuRoots | undefined {
  try {
    if (root === undefined || root === null) return undefined;
    let menu: HTMLElement | undefined;
    if (isElement(root) && root.matches('div[role="menu"]') && isModelMenuLabel(root.getAttribute('aria-label') ?? '')) {
      menu = root as HTMLElement;
    }
    const candidates = root.querySelectorAll<HTMLElement>('div[role="menu"]');
    if (menu === undefined) {
      for (const candidate of candidates) {
        if (isModelMenuLabel(candidate.getAttribute('aria-label') ?? '')) {
          menu = candidate;
          break;
        }
      }
    }
    if (menu === undefined) {
      for (const candidate of candidates) {
        if ((candidate.getAttribute('aria-label') ?? '').trim() !== '') continue;
        if (candidate.querySelector('[role="group"]') === null) continue;
        menu = candidate;
        break;
      }
    }
    if (menu === undefined) return undefined;
    return { menu, groups: findGroupsContainer(menu) };
  } catch {
    return undefined;
  }
}

/** Read the provider title of one group: its labelled div, then aria-labelledby. */
function readGroupTitle(group: HTMLElement): string {
  try {
    const titled = group.querySelector<HTMLElement>('div[id]');
    const fromTitle = titled?.textContent?.trim() ?? '';
    if (fromTitle !== '') return fromTitle;
    const labelledBy = (group.getAttribute('aria-labelledby') ?? '').trim();
    if (labelledBy !== '') {
      const owner = group.ownerDocument;
      for (const id of labelledBy.split(/\s+/)) {
        const target = owner?.getElementById(id);
        const text = target?.textContent?.trim() ?? '';
        if (text !== '') return text;
      }
    }
    return (group.getAttribute('aria-label') ?? '').trim();
  } catch {
    return '';
  }
}

/** Read the model display name: title attribute, then `[class*="modelName"]`, then all text. */
function readRowName(row: HTMLElement): string {
  try {
    const title = (row.getAttribute('title') ?? '').trim();
    if (title !== '') return title;
    const named = row.querySelector<HTMLElement>('[class*="modelName"]');
    const fromClass = named?.textContent?.trim() ?? '';
    if (fromClass !== '') return fromClass;
    return (row.textContent ?? '').trim();
  } catch {
    return '';
  }
}

/**
 * List every model row of the popup in DOM order, including rows currently hidden.
 *
 * @param roots Popup roots from {@link findModelMenu}.
 * @returns One entry per `[role="menuitemradio"]` inside a `section[role="group"]`.
 */
export function listModelRows(roots: ModelMenuRoots): ModelMenuRow[] {
  const rows: ModelMenuRow[] = [];
  const groups = groupsOf(roots);
  if (groups === undefined) return rows;
  try {
    for (const group of groups.querySelectorAll<HTMLElement>('section[role="group"]')) {
      const providerName = readGroupTitle(group);
      for (const row of group.querySelectorAll<HTMLElement>('[role="menuitemradio"]')) {
        rows.push({ row, providerName, modelName: readRowName(row) });
      }
    }
  } catch {
    // Malformed DOM: keep whatever was collected so far.
  }
  return rows;
}

/**
 * Parsed search query: plain tokens match the model or provider name, while a
 * `p:` or `provider:` prefix restricts that token to the provider name only.
 * A bare prefix with no term (`p:`) is ignored so a half-typed token never
 * hides the whole menu.
 */
export interface ParsedMenuQuery {
  providerTerms: string[];
  modelTerms: string[];
}

/**
 * Split one query line into provider-scoped and plain terms.
 *
 * @param raw Raw query text as typed by the user.
 * @returns Lowercased provider terms and model terms.
 */
export function parseMenuQuery(raw: string): ParsedMenuQuery {
  const providerTerms: string[] = [];
  const modelTerms: string[] = [];
  for (const token of raw.trim().toLowerCase().split(/\s+/).filter((part) => part.length > 0)) {
    const providerTerm = token.startsWith('p:') ? token.slice(2) : token.startsWith('provider:') ? token.slice(9) : undefined;
    if (providerTerm !== undefined) {
      if (providerTerm.length > 0) providerTerms.push(providerTerm);
    } else {
      modelTerms.push(token);
    }
  }
  return { providerTerms, modelTerms };
}

/** True when the row matches the (already lowercased, trimmed) query. */
function matchesQuery(row: ModelMenuRow, query: string): boolean {
  const { providerTerms, modelTerms } = parseMenuQuery(query);
  const provider = row.providerName.toLowerCase();
  const model = row.modelName.toLowerCase();
  return providerTerms.every((term) => provider.includes(term)) && modelTerms.every((term) => model.includes(term) || provider.includes(term));
}

/**
 * Apply the query and visibility predicate to every row and collapse empty groups.
 *
 * A row is shown only when it passes `isRowVisible` (when supplied) and matches
 * `query` (when `hideUnmatched` is true). Query tokens match the model or provider
 * name; a `p:` or `provider:` prefix restricts that token to the provider name.
 * A group whose rows are all hidden is itself hidden; groups without rows are
 * left untouched.
 *
 * @param roots Popup roots from {@link findModelMenu}.
 * @param options Filter inputs; omit for "show everything".
 * @returns Counts of shown rows, hidden rows, and hidden groups.
 */
export function applyMenuFilter(roots: ModelMenuRoots, options: MenuFilterOptions = {}): MenuFilterResult {
  const result: MenuFilterResult = { shown: 0, hidden: 0, groupsHidden: 0 };
  const groups = groupsOf(roots);
  if (groups === undefined) return result;
  try {
    const hideUnmatched = options?.hideUnmatched !== false;
    const query = hideUnmatched ? (options?.query ?? '').trim().toLowerCase() : '';
    const isRowVisible = options?.isRowVisible;
    for (const group of groups.querySelectorAll<HTMLElement>('section[role="group"]')) {
      const providerName = readGroupTitle(group);
      const rows = group.querySelectorAll<HTMLElement>('[role="menuitemradio"]');
      let visibleRows = 0;
      for (const row of rows) {
        const model: ModelMenuRow = { row, providerName, modelName: readRowName(row) };
        let visible = true;
        if (typeof isRowVisible === 'function') {
          try {
            visible = isRowVisible(model) !== false;
          } catch {
            visible = false;
          }
        }
        if (visible && hideUnmatched && !matchesQuery(model, query)) visible = false;
        row.style.display = visible ? '' : 'none';
        if (visible) visibleRows += 1;
        else result.hidden += 1;
      }
      result.shown += visibleRows;
      if (rows.length > 0 && visibleRows === 0) {
        group.style.display = 'none';
        result.groupsHidden += 1;
      } else {
        group.style.display = '';
      }
    }
  } catch {
    // Malformed DOM: return the counts accumulated so far.
  }
  return result;
}

/**
 * Clear every inline `display` this module may have written.
 *
 * Elements are never removed; rows and groups return to their natural layout.
 *
 * @param roots Popup roots from {@link findModelMenu}.
 */
export function resetMenuFilter(roots: ModelMenuRoots): void {
  const groups = groupsOf(roots);
  if (groups === undefined) return;
  try {
    for (const group of groups.querySelectorAll<HTMLElement>('section[role="group"]')) {
      group.style.display = '';
      for (const row of group.querySelectorAll<HTMLElement>('[role="menuitemradio"]')) {
        row.style.display = '';
        delete row.dataset['llmCtlHidden'];
      }
    }
  } catch {
    // Malformed DOM: nothing to reset.
  }
}

/** True when the element itself is, or contains, a `dsh-model-search-plugin` widget. */
function containsForeignSearch(element: Element): boolean {
  if (element.matches('[class*="dsh-model-search-container"]')) return true;
  if (element.querySelector('[class*="dsh-model-search-container"]') !== null) return true;
  if (element.matches('input') && classAttributeOf(element).includes('dsh-model-search')) return true;
  for (const input of element.querySelectorAll<HTMLElement>('input')) {
    if (classAttributeOf(input).includes('dsh-model-search')) return true;
  }
  return false;
}

/** True when `element` precedes `other` in document order. */
function isBefore(element: Element, other: Element): boolean {
  if (element === other) return false;
  if (typeof element.compareDocumentPosition !== 'function') return true;
  return (element.compareDocumentPosition(other) & DOCUMENT_POSITION_FOLLOWING) !== 0;
}

/**
 * Detect a search widget injected by `dsh-model-search-plugin`.
 *
 * A foreign widget sits before the groups container, either as its previous
 * sibling or anywhere inside the menu (or the menu's parent). When one is found
 * the caller must not inject a second search box (PRD FR3.2).
 *
 * @param roots Popup roots from {@link findModelMenu}.
 * @returns True when a foreign search widget occupies the slot above the groups.
 */
export function hasForeignSearchWidget(roots: ModelMenuRoots): boolean {
  const groups = groupsOf(roots);
  const menu = menuOf(roots);
  if (groups === undefined || menu === undefined) return false;
  try {
    const previous = groups.previousElementSibling;
    if (previous !== null && containsForeignSearch(previous)) return true;
    const scopes: Element[] = [menu];
    const parent = menu.parentElement;
    if (parent !== null) scopes.push(parent);
    const anchor = groups.querySelector('section[role="group"]') ?? groups;
    for (const scope of scopes) {
      const widgets = scope.querySelectorAll<HTMLElement>(
        '[class*="dsh-model-search-container"], input[class*="dsh-model-search-input"]',
      );
      for (const widget of widgets) {
        if (widget === anchor || widget.contains(anchor)) continue;
        if (!isBefore(widget, anchor)) continue;
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/** Find an already-injected empty state near the popup. */
function findEmptyState(groups: HTMLElement | undefined, menu: HTMLElement | undefined): HTMLElement | undefined {
  const parent = groups?.parentElement ?? menu?.parentElement ?? null;
  const local = parent?.querySelector<HTMLElement>(`#${EMPTY_STATE_ID}`);
  if (local !== undefined && local !== null) return local;
  const global = documentOf(groups, menu)?.getElementById(EMPTY_STATE_ID);
  return global ?? undefined;
}

/**
 * Insert (or update) the "everything is filtered out" empty state above the groups.
 *
 * The element carries the message text plus one button that invokes `onAction`,
 * so a caller can restore the hidden entries in one click (PRD FR3.3). Repeated
 * calls reuse the same element and replace its text, button label, and handler.
 *
 * @param roots Popup roots from {@link findModelMenu}.
 * @param text Message shown before the action button.
 * @param actionLabel Button label, e.g. "显示 3 个隐藏项".
 * @param onAction Click handler for that button.
 * @returns The inserted `#dsh-llm-ctl-empty` element.
 */
export function ensureEmptyState(
  roots: ModelMenuRoots,
  text: string,
  actionLabel: string,
  onAction: () => void,
): HTMLElement {
  const groups = groupsOf(roots);
  const menu = menuOf(roots);
  const existing = findEmptyState(groups, menu);
  const owner = documentOf(existing, groups, menu);
  if (owner === undefined) return (roots?.menu ?? roots?.groups) as HTMLElement;
  let element = existing;
  try {
    element = element ?? owner.createElement('div');
    element.id = EMPTY_STATE_ID;
    element.className = 'dsh-llm-ctl-empty';
    const message = owner.createElement('span');
    message.className = 'dsh-llm-ctl-empty-text';
    message.textContent = text;
    const action = owner.createElement('button');
    action.type = 'button';
    action.className = 'dsh-llm-ctl-empty-action';
    action.textContent = actionLabel;
    action.addEventListener('click', (event) => {
      event.preventDefault();
      try {
        onAction();
      } catch {
        // A caller-supplied handler must never break the popup.
      }
    });
    element.replaceChildren(message, action);
    const parent = groups?.parentElement ?? menu?.parentElement ?? null;
    if (parent !== null) {
      if (groups !== undefined && groups.parentElement === parent) parent.insertBefore(element, groups);
      else if (element.parentElement !== parent) parent.appendChild(element);
    }
  } catch {
    // Malformed DOM: return whatever element could be built.
  }
  return element ?? ((roots?.menu ?? roots?.groups) as HTMLElement);
}

/**
 * Remove the empty state injected by {@link ensureEmptyState}, if present.
 *
 * @param roots Popup roots from {@link findModelMenu}.
 */
export function removeEmptyState(roots: ModelMenuRoots): void {
  try {
    const groups = groupsOf(roots);
    const menu = menuOf(roots);
    findEmptyState(groups, menu)?.remove();
  } catch {
    // Malformed DOM: nothing to remove.
  }
}
