/**
 * React views for the upstream-discovered model list slot.
 *
 * The client bundle runs inside the DSH ModuleLoader, so React arrives through
 * `require('react')`; the build script rewrites these imports. Everything here
 * is a pure view over discovered rows plus callbacks, so the data shaping is
 * testable without a browser.
 *
 * @module dsh-llm-ctl/discover-ui
 */
import React from 'react';
import { CollapseToggle, useAutoCollapse } from './settings-ui.ts';
import type { VisibilitySettings } from './visibility.ts';
import { isModelVisible } from './visibility.ts';

/** One upstream-discovered model row of the provider card slot. */
export interface DiscoveredRow {
  /** Upstream model id. */
  id: string;
  /** Display name; falls back to {@link DiscoveredRow.id} when upstream gives none. */
  name: string;
  /** True when the id is absent from the advertised catalog. */
  isNew: boolean;
  /** Resolved through the visibility switches and preset patterns. */
  visible: boolean;
}

/** Inputs for building the discovered-model rows. */
export interface DiscoveredRowsInput {
  /** Provider id the discovery result belongs to. */
  provider: string;
  /** Raw upstream entries, in upstream order. */
  discovered: ReadonlyArray<{ id: string; name?: string }>;
  /** Model ids already present in the advertised catalog. */
  advertisedIds: ReadonlyArray<string>;
  /** Two-level visibility switches. */
  settings: VisibilitySettings;
  /** Preset wildcard patterns hiding models by default. */
  patterns: readonly string[];
}

/** Actions the discover views call back into. */
export interface DiscoverActions {
  /**
   * Write one model switch.
   *
   * @param provider - Provider id.
   * @param model - Model id.
   * @param visible - Whether the model is visible.
   * @returns Nothing.
   */
  toggleModel(provider: string, model: string, visible: boolean): void;
  /**
   * Re-run upstream discovery.
   *
   * @returns Nothing.
   */
  refresh(): void;
}

/**
 * Build discovered-model rows in upstream order, dropping blank ids.
 *
 * @param input - Provider id, discovered entries, advertised ids, settings, and patterns.
 * @returns Discovered rows with newness and visibility resolved.
 */
export function buildDiscoveredRows(input: DiscoveredRowsInput): DiscoveredRow[] {
  const config = { hiddenPatterns: input.patterns };
  const rows: DiscoveredRow[] = [];
  for (const entry of input.discovered) {
    if (entry.id === '') continue;
    rows.push({
      id: entry.id,
      name: entry.name ?? entry.id,
      isNew: !input.advertisedIds.includes(entry.id),
      visible: isModelVisible(input.provider, entry.id, input.settings, config),
    });
  }
  return rows;
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
const badgeStyle: React.CSSProperties = {
  border: '1px solid var(--dsw-alias-border-inverted, rgba(127,127,127,.35))',
  borderRadius: 4,
  padding: '0 4px',
  fontSize: 10,
};
const errorStyle: React.CSSProperties = { color: '#f31260', padding: '2px 0' };

/**
 * Small refresh button for the discovered-model list.
 *
 * @param props - Pending flag, optional disabled flag, and refresh callback.
 * @returns The rendered button element.
 */
export function RefreshModelsButton(props: { pending: boolean; disabled?: boolean; onRefresh: () => void }): React.ReactElement {
  const disabled = props.pending || props.disabled === true;
  return React.createElement(
    'button',
    {
      type: 'button',
      style: buttonStyle,
      disabled: disabled,
      onClick: () => props.onRefresh(),
    },
    props.pending ? '刷新中…' : '刷新清单',
  );
}

/**
 * Upstream-discovered model list for one provider card slot.
 *
 * Returns null when there are no rows and the list is neither loading nor
 * failed, so the slot stays empty for providers without discovery data.
 *
 * @param props - Provider id, rows, pending/failed state, and callbacks.
 * @returns The rendered section, or null when there is nothing to show.
 */
export function DiscoveredModelsList(props: {
  provider: string;
  rows: DiscoveredRow[];
  pending: boolean;
  failed?: string;
  onToggle: (provider: string, model: string, visible: boolean) => void;
  onRefresh: () => void;
}): React.ReactElement | null {
  const [collapsed, toggleCollapsed] = useAutoCollapse(props.rows.length);
  if (props.rows.length === 0 && !props.pending && !props.failed) return null;
  const failed = props.failed ?? '';
  return React.createElement(
    'section',
    { style: { marginTop: 8, fontSize: 12 } },
    React.createElement(
      'div',
      { style: rowStyle },
      CollapseToggle({ collapsed, count: props.rows.length, label: '上游发现', onToggle: toggleCollapsed }),
      React.createElement(RefreshModelsButton, { pending: props.pending, onRefresh: props.onRefresh }),
    ),
    failed.length > 0 ? React.createElement('div', { style: errorStyle }, failed) : null,
    collapsed
      ? null
      : props.rows.map((row) =>
          React.createElement(
            'div',
            { key: row.id, style: { ...rowStyle, opacity: row.visible ? 1 : 0.5 } },
            React.createElement('span', { style: nameStyle }, row.name),
            row.isNew ? React.createElement('span', { style: badgeStyle }, '新') : null,
            React.createElement(
              'button',
              {
                type: 'button',
                style: buttonStyle,
                title: row.visible ? '隐藏' : '显示',
                'aria-pressed': !row.visible,
                onClick: () => props.onToggle(props.provider, row.id, !row.visible),
              },
              row.visible ? '👁' : '🚫',
            ),
          ),
        ),
  );
}

/** Re-exported so the provider-card slot can type its settings prop from this module. */
export type { VisibilitySettings } from './visibility.ts';
