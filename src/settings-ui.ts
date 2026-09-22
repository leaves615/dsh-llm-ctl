/**
 * React views for the two `settings.models` slots.
 *
 * The client bundle runs inside the DSH ModuleLoader, so React arrives through
 * `require('react')`; the build script rewrites these imports. Everything here
 * is a pure view over a small state object plus callbacks, so the data shaping is
 * testable without a browser.
 *
 * @module dsh-llm-ctl/settings-ui
 */
import React from 'react';
import type { VisibilitySettings } from './visibility.ts';
import { isModelVisible, isProviderVisible } from './visibility.ts';
import { concurrencyFor } from './concurrency.ts';

/** One provider row of the settings page view model. */
export interface ProviderVisibilityView {
  provider: string;
  displayName: string;
  visible: boolean;
  models: Array<{ model: string; name: string; visible: boolean }>;
}

/** Inputs for the settings page view model. */
export interface VisibilityViewInput {
  providers: ReadonlyArray<{ provider: string; displayName: string; models: ReadonlyArray<{ model: string; name: string }> }>;
  settings: VisibilitySettings;
  patterns: readonly string[];
}

/** Actions the settings views call back into. */
export interface VisibilityActions {
  setProvider(provider: string, visible: boolean): void;
  setModel(provider: string, model: string, visible: boolean): void;
  resetAll(): void;
  openQueue?(): void;
}

/** Effective global queue budget as the plugin-config card renders it. */
export interface QueueConfigView {
  /** Effective wait budget in ms (settings override wins over the cordis base). */
  maxWaitMs: number;
  /** Effective queue depth cap. */
  maxQueueDepth: number;
  /** Effective default per-provider concurrency; `0` means unlimited. */
  defaultConcurrency: number;
  /** Effective provider-specific entries, excluding `default`; `0` means unlimited. */
  perProviderConcurrency: Record<string, number>;
  /** Cordis composition base, before the user-layer override. */
  defaults: { maxWaitMs: number; maxQueueDepth: number; defaultConcurrency: number };
  /** True when at least one field carries a user-layer override. */
  overridden: boolean;
  /** Section revision the snapshot was read at, for write fencing. */
  revision: number;
}

/** Outcome of one queue-override write; `error` carries the server message when present. */
export interface QueueWriteResult {
  ok: boolean;
  error?: string;
}

/** Actions the plugin-config card calls back into. */
export interface QueueConfigActions {
  /** Persist a partial override; each defined field replaces the current one. */
  setQueue(input: { maxWaitMs?: number; maxQueueDepth?: number; defaultConcurrency?: number; perProviderConcurrency?: Record<string, number>; expectedRevision?: number }): Promise<QueueWriteResult>;
  /** Drop the override, re-inheriting the cordis composition base. */
  resetQueue(expectedRevision?: number): Promise<boolean>;
}

/** Provider directory entry the concurrency editor offers per-provider rows for. */
export interface QueueProviderOption {
  provider: string;
  displayName: string;
}

/**
 * Build the per-provider view model the settings cards render.
 *
 * @param input - Provider entries, visibility settings, and preset patterns.
 * @returns Array of provider views with computed visibility.
 */
export function buildProviderViews(input: VisibilityViewInput): ProviderVisibilityView[] {
  const config = { hiddenPatterns: input.patterns };
  return input.providers.map((entry) => ({
    provider: entry.provider,
    displayName: entry.displayName,
    visible: isProviderVisible(entry.provider, input.settings, config),
    models: entry.models.map((model) => ({
      model: model.model,
      name: model.name,
      visible: isModelVisible(entry.provider, model.model, input.settings, config),
    })),
  }));
}

/**
 * Count hidden providers and models across the view model.
 *
 * @param views - Provider views to summarize.
 * @returns Counts of hidden providers, hidden models, and their sum.
 */
export function summarize(views: readonly ProviderVisibilityView[]): { providers: number; models: number; total: number } {
  let providers = 0;
  let models = 0;
  for (const view of views) {
    if (!view.visible) providers += 1;
    for (const model of view.models) if (!model.visible) models += 1;
  }
  return { providers, models, total: providers + models };
}

const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0' };
const nameStyle: React.CSSProperties = { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const buttonStyle: React.CSSProperties = {
  border: '1px solid var(--dsw-alias-border-inverted, rgba(127,127,127,.35))',
  background: 'transparent',
  color: 'inherit',
  borderRadius: 6,
  padding: '1px 8px',
  fontSize: 11,
  cursor: 'pointer',
};

/** Lists longer than this start collapsed so a 70-model provider never floods the page. */
export const COLLAPSE_THRESHOLD = 8;

/**
 * Whether a list of the given length starts expanded.
 *
 * @param count Row count of the list.
 * @returns True for short lists; long lists start collapsed.
 */
export function defaultExpanded(count: number): boolean {
  return count <= COLLAPSE_THRESHOLD;
}

/**
 * Collapsed flag that follows list growth until the user toggles manually.
 * Must be called unconditionally (hooks rule), even by components that may
 * return null below.
 *
 * @param count Current row count of the list.
 * @returns The effective collapsed flag plus its toggle.
 */
export function useAutoCollapse(count: number): [boolean, () => void] {
  const [manual, setManual] = React.useState<boolean | undefined>(undefined);
  const collapsed = manual ?? !defaultExpanded(count);
  const toggle = (): void => {
    setManual(!collapsed);
  };
  return [collapsed, toggle];
}

/**
 * Chevron toggle shared by collapsible model lists.
 *
 * @param props Collapsed flag, row count, section label, and toggle callback.
 * @returns The rendered button element.
 */
export function CollapseToggle(props: { collapsed: boolean; count: number; label: string; onToggle: () => void }): React.ReactElement {
  return React.createElement(
    'button',
    {
      type: 'button',
      style: buttonStyle,
      title: props.collapsed ? '展开' : '收起',
      'aria-expanded': !props.collapsed,
      onClick: () => props.onToggle(),
    },
    (props.collapsed ? '▸ ' : '▾ ') + props.label + '（' + props.count + '）',
  );
}

/** Eye toggle shared by provider and model rows. */
function toggle(label: string, visible: boolean, onToggle: () => void): React.ReactElement {
  return React.createElement(
    'button',
    {
      type: 'button',
      style: buttonStyle,
      title: visible ? '隐藏' : '显示',
      'aria-pressed': !visible,
      onClick: onToggle,
    },
    visible ? '👁' : '🚫',
    label.length > 0 ? React.createElement('span', { style: { marginLeft: 4 } }, label) : null,
  );
}

/**
 * Provider-card extras: one switch for the provider and one per model.
 * When the provider has no models in the catalog, renders the provider switch
 * plus a fallback message indicating per-model control is unavailable.
 *
 * @param props - View model for this provider plus the write actions.
 * @returns The rendered element.
 */
export function ProviderVisibilityCard(props: { view: ProviderVisibilityView; actions: VisibilityActions }): React.ReactElement {
  const { view, actions } = props;
  const [modelsCollapsed, toggleModels] = useAutoCollapse(view.models.length);
  return React.createElement(
    'div',
    { style: { marginTop: 8, fontSize: 12 } },
    React.createElement(
      'div',
      { style: rowStyle },
      React.createElement('span', { style: nameStyle }, view.visible ? '提供方可见' : '提供方已隐藏'),
      toggle('', view.visible, () => actions.setProvider(view.provider, !view.visible)),
    ),
    view.models.length > 0
      ? React.createElement(
          React.Fragment,
          null,
          React.createElement(
            'div',
            { style: { ...rowStyle, paddingLeft: 12 } },
            CollapseToggle({ collapsed: modelsCollapsed, count: view.models.length, label: '模型', onToggle: toggleModels }),
          ),
          modelsCollapsed
            ? null
            : view.models.map((model) =>
                React.createElement(
                  'div',
                  { key: model.model, style: { ...rowStyle, paddingLeft: 12, opacity: model.visible ? 1 : 0.5 } },
                  React.createElement('span', { style: nameStyle }, model.name),
                  toggle('', model.visible, () => actions.setModel(view.provider, model.model, !model.visible)),
                ),
              ),
        )
      : React.createElement(
          'div',
          { style: { ...rowStyle, paddingLeft: 12, opacity: 0.6, fontSize: 11 } },
          '该提供方暂无模型列表，无法逐模型控制',
        ),
  );
}

/**
 * Models-page footer: hidden totals, restore-all, and queue pressure.
 *
 * @param props - Summarized counts, queue state, and actions.
 * @returns The rendered element.
 */
export function VisibilityFooter(props: {
  summary: { providers: number; models: number; total: number };
  queue: { queued: number; cooling: number };
  actions: VisibilityActions;
}): React.ReactElement {
  const { summary, queue, actions } = props;
  const parts: string[] = [];
  if (summary.total === 0) parts.push('没有隐藏的模型');
  else parts.push(`已隐藏 ${summary.providers} 个提供方 / ${summary.models} 个模型`);
  if (queue.queued > 0 || queue.cooling > 0) parts.push(`排队 ${queue.queued} · 冷却 ${queue.cooling}`);
  return React.createElement(
    'div',
    { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', fontSize: 12 } },
    React.createElement('span', { style: nameStyle }, parts.join(' · ')),
    summary.total > 0
      ? React.createElement('button', { type: 'button', style: buttonStyle, onClick: () => actions.resetAll() }, '全部恢复')
      : null,
  );
}

/** Card chrome mirroring the built-in `settings.plugin.item` cards. */
const pluginCardStyle: React.CSSProperties = {
  border: '0.5px solid var(--dsw-alias-border-l4, rgba(127,127,127,.28))',
  background: 'var(--dsw-alias-bg-layer-3, transparent)',
  borderRadius: 16,
  listStyle: 'none',
};
const pluginHeaderStyle: React.CSSProperties = {
  appearance: 'none',
  width: '100%',
  font: 'inherit',
  color: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
  background: 'none',
  border: 0,
  borderRadius: 12,
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '14px 16px',
};
const pluginHeadTextStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', flex: 1, gap: 4, minWidth: 0 };
const pluginNameStyle: React.CSSProperties = { color: 'var(--dsw-alias-label-primary, inherit)', fontSize: 15, fontWeight: 600, lineHeight: 1.4 };
const pluginDescriptionStyle: React.CSSProperties = { color: 'var(--dsw-alias-label-tertiary, inherit)', fontSize: 13, lineHeight: 1.5 };
const pluginBodyStyle: React.CSSProperties = { borderTop: '0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,.2))', margin: '0 16px', paddingBottom: 8 };
const pluginFieldStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, padding: '12px 0 0' };
const pluginLabelStyle: React.CSSProperties = { color: 'var(--dsw-alias-label-primary, inherit)', fontSize: 13, lineHeight: 1.5 };
const pluginHintStyle: React.CSSProperties = { color: 'var(--dsw-alias-label-tertiary, inherit)', margin: 0, fontSize: 12, lineHeight: 1.5 };
const pluginInputStyle: React.CSSProperties = {
  border: '0.5px solid var(--dsw-alias-border-l4, rgba(127,127,127,.28))',
  background: 'var(--dsw-alias-bg-layer-3, transparent)',
  height: 34,
  font: 'inherit',
  color: 'var(--dsw-alias-label-primary, inherit)',
  borderRadius: 8,
  padding: '0 12px',
  fontSize: 13,
};
const pluginFooterStyle: React.CSSProperties = { borderTop: '0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,.2))', display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, padding: '12px 0 4px' };
const pluginFailedStyle: React.CSSProperties = { flex: 1, minWidth: 0, margin: 0, color: 'var(--dsw-alias-label-error, #d33)', fontSize: 12, lineHeight: 1.5 };
const pluginActionStyle: React.CSSProperties = { appearance: 'none', font: 'inherit', cursor: 'pointer', border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28))', color: 'var(--dsw-alias-label-secondary, inherit)', background: 'none', borderRadius: 8, padding: '5px 14px', fontSize: 13, lineHeight: 1.5 };

/**
 * One plugin card inside the 插件配置 tab (`settings.plugin.item`, keyed by
 * the settings namespace `llm-ctl`).
 *
 * The tab renders every card inside its own `<ul>` and dispatches this seat
 * with empty owner props, so the card owns its whole surface and nests as an
 * `<li>`: a header naming the plugin, a body of staged fields, and the
 * save/discard that writes them. Edits are staged locally and only reach the
 * Host on save, fenced by the revision the card was rendered from.
 *
 * @param props - effective budget, cordis base, and the write actions.
 * @returns The rendered card.
 */
export function PluginConfigCard(props: { config: QueueConfigView; providers?: QueueProviderOption[]; actions: QueueConfigActions }): React.ReactElement {
  const { config, actions } = props;
  // Tolerate state documents from an older Host that predate the concurrency
  // fields: without these fallbacks the card throws on mount and vanishes.
  const effectiveDefault = config.defaultConcurrency ?? config.defaults?.defaultConcurrency ?? 2;
  const effectivePer: Record<string, number> = config.perProviderConcurrency ?? {};
  const [open, setOpen] = React.useState(false);
  const [waitSec, setWaitSec] = React.useState<string>(() => String(Math.round(config.maxWaitMs / 1000)));
  const [depth, setDepth] = React.useState<string>(() => String(config.maxQueueDepth));
  const [defaultConc, setDefaultConc] = React.useState<string>(() => String(effectiveDefault));
  const [perDrafts, setPerDrafts] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(effectivePer).map(([key, value]) => [key, String(value)])),
  );
  const [dirty, setDirty] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [failed, setFailed] = React.useState<string | false>(false);
  /** The state document predates the concurrency fields, so its Host cannot accept them. */
  const legacyHost = config.defaultConcurrency === undefined || config.perProviderConcurrency === undefined;

  const perTableJson = JSON.stringify(effectivePer);

  // Re-seed drafts when the Host moves underneath and no edit is pending.
  React.useEffect(() => {
    if (dirty || saving) return;
    setWaitSec(String(Math.round(config.maxWaitMs / 1000)));
    setDepth(String(config.maxQueueDepth));
    setDefaultConc(String(effectiveDefault));
    setPerDrafts(Object.fromEntries(Object.entries(effectivePer).map(([key, value]) => [key, String(value)])));
  }, [config.revision, config.maxWaitMs, config.maxQueueDepth, effectiveDefault, perTableJson, dirty, saving]);

  const seconds = Number(waitSec);
  const count = Number(depth);
  const defaultCount = Number(defaultConc);
  /** Normalize per-provider drafts: blank inherits the default; `0` means unlimited. */
  const perTable = (() => {
    const table: Record<string, number> = {};
    let bad = false;
    for (const [key, raw] of Object.entries(perDrafts)) {
      const trimmed = raw.trim();
      if (trimmed === '') continue;
      const value = Number(trimmed);
      if (!Number.isFinite(value) || value < 0) { bad = true; break; }
      if (key.length > 0) table[key] = Math.floor(value);
    }
    return { table, bad };
  })();
  const invalid = !Number.isFinite(seconds) || seconds < 0 || !Number.isFinite(count) || count < 1 || !Number.isFinite(defaultCount) || defaultCount < 0 || perTable.bad;

  const stage = (setter: (value: string) => void) => (event: { target: { value: string } }): void => {
    setter(event.target.value);
    setDirty(true);
    setFailed(false);
  };

  const onSave = async (): Promise<void> => {
    if (invalid || saving) return;
    setSaving(true);
    setFailed(false);
    const nextWaitMs = Math.round(seconds * 1000);
    const nextDepth = Math.floor(count);
    const nextDefault = Math.floor(defaultCount);
    const patch: { maxWaitMs?: number; maxQueueDepth?: number; defaultConcurrency?: number; perProviderConcurrency?: Record<string, number>; expectedRevision: number } = { expectedRevision: config.revision };
    if (nextWaitMs !== config.maxWaitMs) patch.maxWaitMs = nextWaitMs;
    if (nextDepth !== config.maxQueueDepth) patch.maxQueueDepth = nextDepth;
    if (nextDefault !== effectiveDefault) patch.defaultConcurrency = nextDefault;
    if (JSON.stringify(perTable.table) !== JSON.stringify(effectivePer)) patch.perProviderConcurrency = perTable.table;
    const result = await actions.setQueue(patch);
    setSaving(false);
    if (result.ok) setDirty(false);
    else setFailed(result.error ?? '保存失败，请重试。');
  };

  const onDiscard = (): void => {
    setWaitSec(String(Math.round(config.maxWaitMs / 1000)));
    setDepth(String(config.maxQueueDepth));
    setDefaultConc(String(effectiveDefault));
    setPerDrafts(Object.fromEntries(Object.entries(effectivePer).map(([key, value]) => [key, String(value)])));
    setDirty(false);
    setFailed(false);
  };

  const onResetDefaults = async (): Promise<void> => {
    if (saving) return;
    setSaving(true);
    setFailed(false);
    const ok = await actions.resetQueue(config.revision);
    setSaving(false);
    if (ok) { setDirty(false); setFailed(false); }
    else setFailed('保存失败，请重试。');
  };

  const field = (input: { id: string; label: string; hint: string; invalidHint: string; value: string; min: number; step?: number; onEdit: (event: { target: { value: string } }) => void }): React.ReactElement =>
    React.createElement(
      'div',
      { style: pluginFieldStyle },
      React.createElement('label', { htmlFor: input.id, style: pluginLabelStyle }, input.label),
      React.createElement('input', {
        id: input.id,
        type: 'number',
        style: pluginInputStyle,
        min: input.min,
        ...(input.step === undefined ? {} : { step: input.step }),
        disabled: saving,
        value: input.value,
        onChange: input.onEdit,
      }),
      React.createElement('p', { style: pluginHintStyle }, invalid ? input.invalidHint : input.hint),
    );

  const header = React.createElement(
    'button',
    {
      type: 'button',
      style: pluginHeaderStyle,
      'aria-expanded': open,
      'aria-label': (open ? '收起设置: ' : '展开设置: ') + 'LLM 排队控制',
      onClick: () => setOpen(!open),
    },
    React.createElement(
      'span',
      { style: pluginHeadTextStyle },
      React.createElement('span', { style: pluginNameStyle }, 'LLM 排队控制'),
      React.createElement('span', { style: pluginDescriptionStyle }, '按 provider 的并发上限、准入排队、冷却等待与重试预算。'),
    ),
    config.overridden && !dirty ? React.createElement('span', { style: pluginHintStyle }, '已自定义') : null,
    React.createElement(
      'svg',
      {
        width: 14,
        height: 14,
        viewBox: '0 0 14 14',
        fill: 'none',
        xmlns: 'http://www.w3.org/2000/svg',
        style: { color: 'var(--dsw-alias-label-tertiary, inherit)', flex: 'none', transition: 'transform .16s', transform: open ? 'rotate(180deg)' : 'none' },
      },
      React.createElement('path', { d: 'M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z', fill: 'currentColor' }),
    ),
  );

  const stagePer = (provider: string) => (event: { target: { value: string } }): void => {
    const value = event.target.value;
    setPerDrafts((prev) => ({ ...prev, [provider]: value }));
    setDirty(true);
    setFailed(false);
  };

  const directory = (props.providers ?? []).filter((entry) => entry.provider.length > 0);
  const rowIds: string[] = directory.map((entry) => entry.provider);
  for (const key of [...Object.keys(effectivePer), ...Object.keys(perDrafts)]) {
    if (key.length > 0 && !rowIds.includes(key)) rowIds.push(key);
  }
  const displayNameOf = (id: string): string => directory.find((entry) => entry.provider === id)?.displayName ?? id;

  // True effective cap per row (free-route heuristic included), so the
  // placeholder never lies about what a blank cell inherits.
  const lookupTable: Record<string, number> = { default: effectiveDefault, ...effectivePer };
  const inheritHint = (id: string): string => {
    const effective = concurrencyFor(lookupTable, id);
    return Number.isFinite(effective) ? `默认 ${effective}` : '不限制（默认）';
  };

  const concurrencySection = React.createElement(
    'div',
    { style: pluginFieldStyle },
    React.createElement('span', { style: pluginLabelStyle }, '各提供方并发上限'),
    React.createElement('p', { style: pluginHintStyle }, '留空继承默认；填 0 为该提供方不限制。'),
    rowIds.length === 0
      ? React.createElement('p', { style: pluginHintStyle }, '暂无已知提供方，先设置默认并发即可。')
      : rowIds.map((id) =>
          React.createElement(
            'div',
            { key: id, style: { ...rowStyle, paddingLeft: 12 } },
            React.createElement('span', { style: nameStyle }, displayNameOf(id)),
            React.createElement('input', {
              type: 'number',
              style: { ...pluginInputStyle, width: 88, height: 28, flex: 'none' },
              min: 0,
              step: 1,
              disabled: saving,
              value: perDrafts[id] ?? '',
              placeholder: inheritHint(id),
              'aria-label': `${displayNameOf(id)} 并发上限`,
              onChange: stagePer(id),
            }),
          ),
        ),
  );

  const body = React.createElement(
    'div',
    { style: pluginBodyStyle },
    legacyHost
      ? React.createElement('p', { style: pluginFailedStyle }, '检测到 Host 为旧版本：并发设置保存会失败，请重载插件后再试；排队超时与队列深度仍可保存。')
      : null,
    field({ id: 'llm-ctl-queue-max-wait', label: '排队超时（秒）', hint: '单请求排队耐心，与愿意采纳的 provider 冷却共用一个预算。', invalidHint: '请输入 ≥ 0 的秒数。', value: waitSec, min: 0, onEdit: stage(setWaitSec) }),
    field({ id: 'llm-ctl-queue-depth', label: '队列深度', hint: '同一时刻允许排队的最大请求数。', invalidHint: '请输入 ≥ 1 的整数。', value: depth, min: 1, step: 1, onEdit: stage(setDepth) }),
    field({ id: 'llm-ctl-queue-concurrency', label: '默认并发上限', hint: '每个提供方同时进行的请求数，超限的排队等待；0 表示不限制（默认）。', invalidHint: '请输入 ≥ 0 的整数（0 = 不限制）。', value: defaultConc, min: 0, step: 1, onEdit: stage(setDefaultConc) }),
    concurrencySection,
    React.createElement(
      'div',
      { style: pluginFooterStyle },
      failed !== false ? React.createElement('p', { style: pluginFailedStyle }, failed) : null,
      config.overridden
        ? React.createElement(
            'button',
            { type: 'button', style: pluginActionStyle, disabled: saving, onClick: () => void onResetDefaults() },
            '恢复默认',
          )
        : null,
      React.createElement(
        'button',
        { type: 'button', style: pluginActionStyle, disabled: !dirty || invalid || saving, onClick: onDiscard },
        '放弃修改',
      ),
      React.createElement(
        'button',
        { type: 'button', style: { ...pluginActionStyle, background: 'var(--dsw-alias-label-primary, currentColor)', color: 'var(--dsw-alias-bg-layer-3, inherit)' }, disabled: !dirty || invalid || saving, onClick: () => void onSave() },
        saving ? '保存中…' : '保存',
      ),
    ),
  );

  return React.createElement('li', { style: pluginCardStyle }, header, open ? body : null);
}
