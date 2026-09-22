/**
 * Browser half of dsh-llm-ctl.
 *
 * Three jobs, all over the host's plain HTTP routes plus the official slots:
 *
 * 1. a composer-dock queue seat (queue depth, cooldown, cancel);
 * 2. model-picker filtering: hidden models are removed from the menu, a search
 *    box appears only when \`dsh-model-search-plugin\` has not injected one, and a
 *    fully filtered menu offers a one-click restore;
 * 3. the two \`settings.models\` seats: per-provider switches and a footer with the
 *    hidden totals and restore-all.
 *
 * @module dsh-llm-ctl/client
 */
import React from 'react';
import { isModelVisible, isProviderVisible, type VisibilitySettings } from './visibility.ts';
import {
  PluginConfigCard,
  ProviderVisibilityCard,
  VisibilityFooter,
  buildProviderViews,
  summarize,
  type ProviderVisibilityView,
} from './settings-ui.ts';
import {
  applyMenuFilter,
  ensureEmptyState,
  findModelMenu,
  hasForeignSearchWidget,
  listModelRows,
  removeEmptyState,
  resetMenuFilter,
  type ModelMenuRoots,
  type ModelMenuRow,
} from './menu-filter.ts';
import { applyVisibilityOnly } from './menu-visibility.ts';
import { DiscoveredModelsList, RefreshModelsButton, buildDiscoveredRows, type DiscoveredRow } from './discover-ui.ts';
import { buildQueueDockView, QueueDockPanel } from './queue-dock.ts';

/** Cordis service names the browser half needs. */
export const inject = ['slots', 'remote', 'remote.session'];

interface CtlEvent {
  seq: number;
  at: number;
  kind: string;
  provider: string;
  origin?: 'loop' | 'background';
  queueId?: string;
  position?: number;
  waitMs?: number;
  delayMs?: number;
  code?: string;
  reason?: string;
}

interface ControlState {
  at: number;
  queue: {
    lanes: Array<{ provider: string; active: number; concurrency: number; queued: number; cooldownRemainingMs: number }>;
    waiters: Array<{ queueId: string; provider: string; origin: 'loop' | 'background'; position: number; waitedMs: number; etaMs: number }>;
  };
  events: CtlEvent[];
  reactive: { mode: 'auto' | 'off' | number; limit: number };
  queueConfig: {
    maxWaitMs: number;
    maxQueueDepth: number;
    defaultConcurrency: number;
    perProviderConcurrency: Record<string, number>;
    defaults: { maxWaitMs: number; maxQueueDepth: number; defaultConcurrency: number };
    overridden: boolean;
    revision: number;
  };
  visibility: {
    settings: VisibilitySettings;
    patterns: readonly string[];
    configurableProviders: Array<{ provider: string; displayName: string; settingsNs: string }>;
  };
}

interface CatalogModel {
  id: string;
  name: string;
}

interface CatalogGroup {
  id: string;
  name: string;
  models: readonly CatalogModel[];
}

interface ModelCatalog {
  groups: readonly CatalogGroup[];
  failures?: readonly { id: string; name: string; message: string }[];
}

interface RemoteResult<T> {
  ok: boolean;
  value?: T;
  error?: { code: string; message: string };
}

interface ClientContext {
  remote: {
    session: { modelCatalog(): Promise<RemoteResult<ModelCatalog>> };
    llm?: { listConfigurableProviders(): Promise<RemoteResult<Array<{ provider: string; displayName: string; settingsNs: string }>>> };
  };
  slots?: {
    inject(key: string, callback: () => (() => void) | Iterable<() => void> | void): () => void;
    register(options: Record<string, unknown>, component: unknown): () => void;
  };
  logger?: { warn(...args: unknown[]): void };
  effect?(callback: () => (() => void) | void, label?: string): void;
}

const STATE_URL = '/api/llm-ctl/state';
const CANCEL_URL = '/api/llm-ctl/cancel';
const DISCOVER_URL = '/api/llm-ctl/discover';
const VISIBILITY_URL = '/api/llm-ctl/visibility';
const VISIBILITY_RESET_URL = '/api/llm-ctl/visibility/reset';
const QUEUE_URL = '/api/llm-ctl/queue';
const QUEUE_RESET_URL = '/api/llm-ctl/queue/reset';
const POLL_MS = 1_000;
/** Poll interval while the tab is hidden: stay fresh without burning frames. */
const HIDDEN_POLL_MS = 5_000;
/** Upper bound for the failure backoff ladder. */
const MAX_POLL_MS = 30_000;
const CATALOG_TTL_MS = 30_000;
const SEARCH_ID = 'dsh-llm-ctl-search';

let ctxRef: ClientContext | undefined;
let latestState: ControlState | undefined;
let catalog: ModelCatalog | undefined;
let catalogAt = 0;
let catalogRequest: Promise<void> | undefined;
let attached: ModelMenuRoots | undefined;
let searchInput: HTMLInputElement | undefined;
let query = '';
let timer: ReturnType<typeof setTimeout> | undefined;
/** Consecutive `state` fetch failures; drives the backoff ladder. */
let fetchFailures = 0;
/** Signature of the last notified state; idle polls skip re-render. */
let lastNotifiedSignature: string | undefined;
let observer: MutationObserver | undefined;
let syncScheduled = false;
const subscribers = new Set<() => void>();

/** Notify every mounted view that host state changed. */
function notify(): void {
  for (const listener of [...subscribers]) listener();
}

/** Subscribe a React view to host state; returns the unsubscribe callback. */
function useCtlState(): { state: ControlState | undefined; catalog: ModelCatalog | undefined } {
  const [, force] = React.useState(0);
  React.useEffect(() => {
    const listener = (): void => force((value) => value + 1);
    subscribers.add(listener);
    return () => {
      subscribers.delete(listener);
    };
  }, []);
  return { state: latestState, catalog };
}

/** Inject the menu stylesheet once (search box + empty state). */
function ensureMenuStyles(): void {
  if (document.getElementById(`${SEARCH_ID}-style`) !== null) return;
  const style = document.createElement('style');
  style.id = `${SEARCH_ID}-style`;
  style.textContent = `
    #${SEARCH_ID} {
      width: calc(100% - 8px);
      margin: 4px;
      height: 28px;
      padding: 0 8px;
      border: 1px solid var(--dsw-alias-border-inverted, rgba(127, 127, 127, 0.35));
      border-radius: 6px;
      background: transparent;
      color: inherit;
      font-size: 13px;
      outline: none;
    }
    .dsh-llm-ctl-empty {
      padding: 12px 8px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      align-items: flex-start;
      font-size: 12px;
      color: var(--dsw-alias-label-secondary, #93a1c0);
    }
    .dsh-llm-ctl-empty-action {
      border: 1px solid var(--dsw-alias-border-inverted, rgba(127, 127, 127, 0.35));
      background: transparent;
      color: inherit;
      border-radius: 6px;
      padding: 2px 8px;
      font-size: 12px;
      cursor: pointer;
    }
  `;
  document.head.appendChild(style);
}

/** Inject the dock stylesheet once (pill hover/expanded + cancel hover). */
function ensureDockStyles(): void {
  if (document.getElementById('dsh-llm-ctl-dock-style') !== null) return;
  const style = document.createElement('style');
  style.id = 'dsh-llm-ctl-dock-style';
  style.textContent = [
    '.dsh-llm-ctl-dock-pill { background: transparent; border: none; cursor: pointer; }',
    '.dsh-llm-ctl-dock-pill:hover, .dsh-llm-ctl-dock-pill[aria-expanded="true"] { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); }',
    '.dsh-llm-ctl-dock-pill:focus-visible { outline: 2px solid var(--dsw-alias-label-tertiary); outline-offset: -2px; }',
    '.dsh-llm-ctl-dock-cancel:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); }',
    '.dsh-llm-ctl-queue-dialog { cursor: default; }',
  ].join('\n');
  document.head.appendChild(style);
}

/** POST one JSON body to a control route. */
async function postJson(url: string, body: unknown): Promise<{ ok: boolean; status: number; body: unknown }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  });
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    parsed = undefined;
  }
  return { ok: response.ok, status: response.status, body: parsed };
}

/** Read the control state document. */
async function fetchState(): Promise<ControlState> {
  const response = await fetch(STATE_URL, { headers: { accept: 'application/json' }, credentials: 'same-origin' });
  if (!response.ok) throw new Error(`state ${response.status}`);
  return (await response.json()) as ControlState;
}

/** Refresh the model catalog, coalescing concurrent callers. */
function refreshCatalog(): Promise<void> {
  if (catalogRequest !== undefined) return catalogRequest;
  const client = ctxRef;
  if (client === undefined) return Promise.resolve();
  catalogRequest = (async () => {
    try {
      const result = await client.remote.session.modelCatalog();
      if (result.ok && result.value !== undefined) {
        const fresh = result.value;
        catalogAt = Date.now();
        // The catalog rarely changes; re-render seats only when it does so a
        // background refresh never janks a scroll.
        if (catalog === undefined || JSON.stringify(fresh) !== JSON.stringify(catalog)) {
          catalog = fresh;
          notify();
        }
      }
    } catch (error) {
      client.logger?.warn('llm-ctl: model catalog failed', error);
    } finally {
      catalogRequest = undefined;
    }
  })();
  return catalogRequest;
}

/** Current visibility switches (empty tables before the first poll). */
function visibilitySettings(): VisibilitySettings {
  return latestState?.visibility.settings ?? { providers: {}, models: {} };
}

/** Composition preset patterns, read-only. */
function hiddenPatterns(): readonly string[] {
  return latestState?.visibility.patterns ?? [];
}

/** Index catalog display names back to exact provider/model ids. */
function nameIndex(): Map<string, Map<string, { provider: string; model: string }>> {
  const index = new Map<string, Map<string, { provider: string; model: string }>>();
  for (const group of catalog?.groups ?? []) {
    const models = new Map<string, { provider: string; model: string }>();
    for (const model of group.models) models.set(model.name, { provider: group.id, model: model.id });
    index.set(group.name, models);
  }
  return index;
}

/** Views for the settings page: catalog groups plus declared providers missing from it. */
function providerViews(): ProviderVisibilityView[] {
  const settings = visibilitySettings();
  const patterns = hiddenPatterns();
  const entries = (catalog?.groups ?? []).map((group) => ({
    provider: group.id,
    displayName: group.name,
    models: group.models.map((model) => ({ model: model.id, name: model.name })),
  }));
  const seen = new Set(entries.map((entry) => entry.provider));
  for (const declared of latestState?.visibility.configurableProviders ?? []) {
    if (seen.has(declared.provider)) continue;
    seen.add(declared.provider);
    entries.push({ provider: declared.provider, displayName: declared.displayName, models: [] });
  }
  return buildProviderViews({ providers: entries, settings, patterns });
}

/** Upstream discovery state per provider, fed by the refresh buttons. */
const discoveries = new Map<string, { rows: DiscoveredRow[]; pending: boolean; failed?: string }>();

/** Refresh one provider's upstream model list. */
async function refreshDiscovery(provider: string): Promise<void> {
  const current = discoveries.get(provider);
  if (current !== undefined && current.pending) return;
  discoveries.set(provider, { rows: current?.rows ?? [], pending: true, failed: undefined });
  notify();
  try {
    const response = await postJson(DISCOVER_URL, { provider });
    const body = response.body as
      | { discovered?: Array<{ id: string; name?: string }>; error?: string }
      | undefined;
    if (!response.ok) throw new Error('discover ' + response.status);
    if (body !== undefined && typeof body.error === 'string' && body.error.length > 0) {
      discoveries.set(provider, { rows: current?.rows ?? [], pending: false, failed: body.error });
    } else {
      const rows = buildDiscoveredRows({
        provider,
        discovered: body?.discovered ?? [],
        advertisedIds: (catalog?.groups ?? []).find((group) => group.id === provider)?.models.map((model) => model.id) ?? [],
        settings: visibilitySettings(),
        patterns: hiddenPatterns(),
      });
      discoveries.set(provider, { rows, pending: false });
    }
  } catch (error) {
    discoveries.set(provider, {
      rows: current?.rows ?? [],
      pending: false,
      failed: error instanceof Error ? error.message : String(error),
    });
  }
  notify();
}

/** Apply visibility and the current query to the open model menu. */
function applyToMenu(): void {
  const roots = findModelMenu(document);
  if (roots === undefined) return;
  attached = roots;
  // The popup opens on a root pane (model / effort cells) with no rows yet.
  // Filtering or showing the empty state there would be wrong, and the pane
  // swap replaces the groups container, so resolve everything fresh each time.
  if (listModelRows(roots).length === 0) {
    searchInput?.remove();
    searchInput = undefined;
    removeEmptyState(roots);
    return;
  }
  const index = nameIndex();
  const settings = visibilitySettings();
  const config = { hiddenPatterns: hiddenPatterns() };
  const isRowVisible = (row: ModelMenuRow): boolean => {
    const ids = index.get(row.providerName)?.get(row.modelName);
    if (ids === undefined) return true;
    return isModelVisible(ids.provider, ids.model, settings, config);
  };
  // A foreign search widget owns query filtering, groups, and empty states in
  // its menu. Full filtering here would rewrite every passing row and wipe its
  // work on every tick, so only hide our own rejected rows and return.
  if (hasForeignSearchWidget(roots)) {
    applyVisibilityOnly(roots, isRowVisible);
    return;
  }
  const result = applyMenuFilter(roots, { query, isRowVisible });
  // Only touch the empty state on a transition: ensureEmptyState rewrites its
  // children, and an unconditional call would feed the MutationObserver forever.
  const sibling = roots.groups.previousElementSibling;
  const hasEmptyState = sibling !== null && sibling.nodeType === 1 && (sibling as HTMLElement).id === 'dsh-llm-ctl-empty';
  if (result.shown === 0) {
    if (!hasEmptyState) {
      ensureEmptyState(roots, '无可见模型', '显示全部隐藏项', () => {
        void resetAllVisibility();
      });
    }
  } else if (hasEmptyState) {
    removeEmptyState(roots);
  }
}

/** Inject our search box unless dsh-model-search-plugin already owns one. */
function ensureSearchBox(roots: ModelMenuRoots): void {
  if (listModelRows(roots).length === 0) return;
  if (hasForeignSearchWidget(roots)) {
    searchInput?.remove();
    searchInput = undefined;
    return;
  }
  // A correctly anchored box stays untouched: moving it would feed the
  // MutationObserver on every poll. Walk the siblings before the groups so the
  // empty-state element (inserted between box and groups) does not matter.
  if (searchInput !== undefined) {
    let sibling: Element | null = roots.groups.previousElementSibling;
    while (sibling !== null) {
      if (sibling === searchInput) {
        if (!document.body.contains(searchInput)) break;
        return;
      }
      sibling = sibling.previousElementSibling;
    }
    searchInput.remove();
    searchInput = undefined;
  }
  const input = document.createElement('input');
  input.id = SEARCH_ID;
  input.type = 'search';
  input.name = 'dsh-llm-ctl-model-search';
  input.setAttribute('aria-label', '搜索模型');
  input.placeholder = '搜索模型… (Ctrl+F) · p: 限定提供方';
  input.value = query;
  // Isolate from other menu plugins: our keystrokes and focus shortcuts must
  // not bubble into the popup or the page behind it.
  input.addEventListener('input', (event) => {
    event.stopPropagation();
    query = input.value;
    applyToMenu();
  });
  input.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      input.value = '';
      query = '';
      applyToMenu();
    }
  });
  roots.groups.parentNode?.insertBefore(input, roots.groups);
  searchInput = input;
}

/** Detach from a menu that closed. */
function detachMenu(): void {
  if (attached !== undefined) resetMenuFilter(attached);
  if (attached !== undefined) removeEmptyState(attached);
  attached = undefined;
  searchInput?.remove();
  searchInput = undefined;
}

/** Coalesce DOM mutations into one reconciliation per frame-ish window. */
function scheduleSync(): void {
  if (syncScheduled) return;
  syncScheduled = true;
  setTimeout(() => {
    syncScheduled = false;
    syncMenu();
  }, 50);
}

/** Reconcile the attached menu with the current DOM. */
function syncMenu(): void {
  const roots = findModelMenu(document);
  if (roots === undefined) {
    if (attached !== undefined) detachMenu();
    return;
  }
  if (attached !== undefined && attached.menu === roots.menu) {
    ensureSearchBox(roots);
    applyToMenu();
    return;
  }
  detachMenu();
  attached = roots;
  ensureSearchBox(roots);
  applyToMenu();
}

/** Write one visibility switch and refresh. */
async function writeVisibility(input: { provider: string; model?: string; visible: boolean }): Promise<void> {
  try {
    await postJson(VISIBILITY_URL, input);
  } catch (error) {
    ctxRef?.logger?.warn('llm-ctl: visibility write failed', error);
  }
  await tick();
  applyToMenu();
}

/** Restore every hidden provider and model. */
async function resetAllVisibility(): Promise<void> {
  try {
    await postJson(VISIBILITY_RESET_URL, {});
  } catch (error) {
    ctxRef?.logger?.warn('llm-ctl: visibility reset failed', error);
  }
  await tick();
  applyToMenu();
}

/** Persist one global queue-budget override and refresh. */
async function writeQueue(input: { maxWaitMs?: number; maxQueueDepth?: number; defaultConcurrency?: number; perProviderConcurrency?: Record<string, number>; expectedRevision?: number }): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await postJson(QUEUE_URL, input);
    const body = response.body as { error?: unknown } | undefined;
    const error = typeof body?.error === 'string' && body.error.length > 0 ? body.error : undefined;
    if (!response.ok) return { ok: false, ...(error === undefined ? {} : { error }) };
    return { ok: true };
  } catch (error) {
    ctxRef?.logger?.warn('llm-ctl: queue write failed', error);
    return { ok: false };
  } finally {
    await tick();
    applyToMenu();
  }
}

/** Drop the queue override, re-inheriting the cordis base, and refresh. */
async function resetQueue(expectedRevision?: number): Promise<boolean> {
  let ok = true;
  try {
    ok = (await postJson(QUEUE_RESET_URL, { ...(expectedRevision === undefined ? {} : { expectedRevision }) })).ok;
  } catch (error) {
    ctxRef?.logger?.warn('llm-ctl: queue reset failed', error);
    ok = false;
  }
  await tick();
  applyToMenu();
  return ok;
}

/** Settings-page footer seat. */
function FooterSeat(): React.ReactElement | null {
  const { state } = useCtlState();
  if (state === undefined) return null;
  const views = providerViews();
  const cooling = state.queue.lanes.filter((lane) => lane.cooldownRemainingMs > 0).length;
  const element = VisibilityFooter({
    summary: summarize(views),
    queue: { queued: state.queue.waiters.length, cooling },
    actions: {
      setProvider: (provider, visible) => void writeVisibility({ provider, visible }),
      setModel: (provider, model, visible) => void writeVisibility({ provider, model, visible }),
      resetAll: () => void resetAllVisibility(),
    },
  });
  return element;
}

/**
 * Plugin-config tab seat (settings.plugin.item, keyed by the llm-ctl settings
 * namespace).
 *
 * The tab pairs the settings namespaces the Host serves with the cards
 * registered under those keys, so registering here is what makes the plugin's
 * global queue budget editable from 设置 → 插件 → 插件配置.
 */
function PluginConfigSeat(): React.ReactElement | null {
  const { state } = useCtlState();
  if (state === undefined) return null;
  const views = providerViews();
  const element = PluginConfigCard({
    config: state.queueConfig,
    providers: views.map((view) => ({ provider: view.provider, displayName: view.displayName })),
    actions: {
      setQueue: (input) => writeQueue(input),
      resetQueue: (revision) => resetQueue(revision),
    },
  });
  return element;
}

/** Owner props dispatched by the settings-models provider-card seat. */
interface ProviderCardOwnerProps {
  provider?: { provider?: string; displayName?: string };
  configured?: boolean;
  keyConfigured?: boolean;
}

/**
 * Resolve the provider a seat instance controls.
 *
 * Exported for tests: shared-namespace rows must resolve from owner props.
 *
 * @param owner Owner props dispatched by the slot; may be absent in tests.
 * @param fallbackProviderId Registration-time provider id, last resort only.
 * @returns The provider id every switch in this seat writes.
 */
export function resolveSeatProvider(owner: ProviderCardOwnerProps | undefined, fallbackProviderId: string): string {
  const dispatched = owner?.provider?.provider;
  return typeof dispatched === 'string' && dispatched.length > 0 ? dispatched : fallbackProviderId;
}

/** Provider-card extras seat for one provider row, plus its upstream discovery list. */
function makeProviderCardSeat(fallbackProviderId: string): (props: ProviderCardOwnerProps) => React.ReactElement | null {
  return function ProviderCardSeat(props: ProviderCardOwnerProps): React.ReactElement | null {
    const { state } = useCtlState();
    if (state === undefined) return null;
    // Rows that share one settings namespace (every dormant pi-ai route shares
    // 'llm-pi-ai') all receive this same seat: the row's own provider id comes
    // from the owner props, never from the registration closure. Using the
    // closure id here would toggle the wrong provider on every shared row.
    const rowProvider = resolveSeatProvider(props, fallbackProviderId);
    const settings = visibilitySettings();
    const patterns = hiddenPatterns();
    const view =
      providerViews().find((candidate) => candidate.provider === rowProvider) ?? {
        provider: rowProvider,
        displayName:
          typeof props.provider?.displayName === 'string' && props.provider.displayName.length > 0
            ? props.provider.displayName
            : rowProvider,
        visible: isProviderVisible(rowProvider, settings, { hiddenPatterns: patterns }),
        models: [],
      };
    const discovery = discoveries.get(rowProvider) ?? { rows: [], pending: false };
    const actions = {
      setProvider: (provider: string, visible: boolean) => void writeVisibility({ provider, visible }),
      setModel: (provider: string, model: string, visible: boolean) => void writeVisibility({ provider, model, visible }),
      resetAll: () => void resetAllVisibility(),
    };
    // The results list renders nothing before the first refresh, so the entry
    // button lives outside it: exactly one refresh affordance in every state.
    const showEntryRefresh = discovery.rows.length === 0 && !discovery.pending && discovery.failed === undefined;
    const element = React.createElement(
      React.Fragment,
      null,
      ProviderVisibilityCard({ view, actions }),
      showEntryRefresh
        ? RefreshModelsButton({ pending: false, onRefresh: () => void refreshDiscovery(rowProvider) })
        : null,
      DiscoveredModelsList({
        provider: rowProvider,
        rows: discovery.rows,
        pending: discovery.pending,
        failed: discovery.failed,
        onToggle: (provider, model, visible) => void writeVisibility({ provider, model, visible }),
        onRefresh: () => void refreshDiscovery(rowProvider),
      }),
    );
    return element;
  };
}

/**
 * Composer-dock seat: queue depth, cooldown, cancel. Returns null while the
 * control plane is idle so the dock collapses to nothing.
 */
function QueueDockSeat(): React.ReactElement | null {
  const { state } = useCtlState();
  if (state === undefined) return null;
  const view = buildQueueDockView(state.queue);
  if (view === undefined) return null;
  return QueueDockPanel({ view, onCancel: (queueId) => void postJson(CANCEL_URL, { queueId }) });
}

/** Register the plugin-config, footer, and composer-dock seats immediately; provider cards follow the directory. */
function registerSeats(client: ClientContext): void {
  const slots = client.slots;
  if (slots === undefined) return;
  // 设置 → 插件 → 插件配置 renders one card per settings namespace the Host
  // serves; keying on `llm-ctl` is what pairs it with the section we persist.
  slots.inject('settings.plugin.item', () =>
    slots.register({ name: 'settings.plugin.item', key: 'llm-ctl', order: 100 }, PluginConfigSeat),
  );
  slots.inject('settings.models.footer', () =>
    slots.register({ name: 'settings.models.footer', id: 'llm-ctl-visibility', order: 100 }, FooterSeat),
  );
  // The dock is a session list slot below the composer card. Seats render
  // as siblings inside one display:contents anchor: the official stats pills
  // (chat StatsPills seat, order 0, its own `.bOPqQW_root` pill row) come
  // first; our queue pills go last. QueueDockPanel mirrors the stats
  // pill-row language so the two stacked rows read as one dock.
  // Register with locale 'llm-ctl' so the slot system injects the `t` function.
  slots.inject('conversation.composer.dock', () =>
    slots.register({ name: 'conversation.composer.dock', id: 'llm-ctl-queue', order: 1000 }, QueueDockSeat),
  );
}

/** Register one provider-card seat per declared settings namespace, once. */
let providerSeatsRegistered = false;
function ensureProviderSeats(client: ClientContext): void {
  if (providerSeatsRegistered) return;
  const providers = latestState?.visibility.configurableProviders;
  if (providers === undefined || providers.length === 0) return;
  const slots = client.slots;
  if (slots === undefined) return;
  providerSeatsRegistered = true;
  const seen = new Set<string>();
  for (const entry of providers) {
    if (typeof entry.settingsNs !== 'string' || entry.settingsNs.length === 0) continue;
    if (seen.has(entry.settingsNs)) continue;
    seen.add(entry.settingsNs);
    slots.inject('settings.models.provider-card', () =>
      slots.register({ name: 'settings.models.provider-card', key: entry.settingsNs }, makeProviderCardSeat(entry.provider)),
    );
  }
}

/**
 * Backoff ladder for failed polls: 1s, 2s, 4s … capped at 30s, so a
 * struggling host is not hammered every second (each failed fetch also logs
 * a console "Failed to load resource" line, which is the 503 spam).
 *
 * Exported for tests: the ladder is the contract that bounds poll pressure.
 *
 * @param failures Consecutive fetch failures.
 * @returns Delay in ms before the next poll.
 */
export function pollDelayForFailures(failures: number): number {
  if (failures <= 0) return POLL_MS;
  return Math.min(POLL_MS * 2 ** failures, MAX_POLL_MS);
}

/**
 * Stable identity of everything seats render. `at` is excluded on purpose:
 * it changes on every poll while nothing visible changed.
 */
function stateSignature(state: ControlState): string {
  return JSON.stringify([state.queue, state.visibility, state.reactive, state.queueConfig]);
}

/** Schedule the next poll on the backoff ladder. */
function scheduleNext(): void {
  timer = setTimeout(() => void loop(), pollDelayForFailures(fetchFailures));
}

/** One scheduled poll; skipped (not failed) while the tab is hidden. */
async function loop(): Promise<void> {
  timer = undefined;
  if (typeof document !== 'undefined' && document.hidden) {
    timer = setTimeout(() => void loop(), HIDDEN_POLL_MS);
    return;
  }
  await tick();
  // A standalone tick (write paths below) never schedules; only the loop
  // chains. Guard against disposal while the fetch was in flight.
  if (ctxRef === undefined) return;
  scheduleNext();
}

/**
 * One poll: state, menu, seats.
 *
 * Seats re-render only when the visible state actually changed: `at` ticks
 * every second, so an unconditional notify would re-render every provider
 * card on the models page every second — jank under the user's scroll.
 */
async function tick(): Promise<void> {
  try {
    latestState = await fetchState();
    fetchFailures = 0;
    const signature = stateSignature(latestState);
    if (signature !== lastNotifiedSignature) {
      lastNotifiedSignature = signature;
      notify();
    }
    if (ctxRef !== undefined) ensureProviderSeats(ctxRef);
    if (catalog === undefined || Date.now() - catalogAt > CATALOG_TTL_MS) void refreshCatalog();
    syncMenu();
  } catch (error) {
    fetchFailures += 1;
    ctxRef?.logger?.warn('llm-ctl: state fetch failed', error);
  }
}

/** Start the browser half. */
export function apply(ctx: ClientContext): void {
  ctxRef = ctx;
  fetchFailures = 0;
  lastNotifiedSignature = undefined;
  ensureMenuStyles();
  ensureDockStyles();
  registerSeats(ctx);
  void refreshCatalog();
  void tick();
  scheduleNext();

  observer = new MutationObserver(() => {
    scheduleSync();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  ctx.effect?.(() => () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    observer?.disconnect();
    observer = undefined;
    detachMenu();
    subscribers.clear();
    ctxRef = undefined;
  }, 'llm-ctl: stop polling and menu observation');
}