/**
 * React views for the `conversation.composer.dock` queue seat.
 *
 * The dock is the official list slot below the composer card
 * (`dsh-client-ui-conversation`, kind `list`, scope `session`, no owner
 * props). Seats render as siblings inside one `display: contents` slot
 * anchor: the official stats pills (`dsh-client-ui-chat` `StatsPills`,
 * order 0, `.bOPqQW_root` — a centered 13px tertiary pill row) come first,
 * our queue pills go last (order 1000). We cannot nest inside the stats
 * seat's own root (it is owned by another plugin's component), so this panel
 * mirrors its pill-row language so the two stacked rows read as one dock.
 *
 * Each pill is a compact trigger (glyph + count) that opens an anchored
 * dialog with the full queue or cooling detail — the same interaction the
 * official stats pills use. The seat returns null while the control plane is
 * idle so the dock collapses to nothing.
 *
 * Pure view over a small state object plus callbacks: shaping and the trigger
 * markup are testable without a browser. Hover/expanded styles live in the
 * client half (`client-plugin.ts` `ensureDockStyles`) because inline styles
 * cannot express `:hover`.
 *
 * @module dsh-llm-ctl/queue-dock
 */
import React from 'react';
import { createPortal } from 'react-dom';

/** One queued request visible in the dock. */
export interface QueueDockWaiter {
  queueId: string;
  provider: string;
  origin: 'loop' | 'background';
  position: number;
  etaMs: number;
}

/** One provider lane currently cooling down. */
export interface QueueDockLane {
  provider: string;
  cooldownRemainingMs: number;
}

/** Queue slice the dock renders. */
export interface QueueDockInput {
  lanes: readonly QueueDockLane[];
  waiters: readonly QueueDockWaiter[];
}

/** Shaped dock content: the queue and cooling detail behind the pills. */
export interface QueueDockView {
  waiters: QueueDockWaiter[];
  cooling: QueueDockLane[];
}

/**
 * Format milliseconds as a compact human delay.
 *
 * @param ms - Non-negative duration in milliseconds.
 * @returns Compact label such as `850ms`, `12.0s`, or `2m05s`.
 */
export function formatMs(ms: number): string {
  if (ms < 1000) return Math.max(0, Math.round(ms)) + 'ms';
  const seconds = ms / 1000;
  if (seconds < 60) return (seconds < 10 ? seconds.toFixed(1) : String(Math.round(seconds))) + 's';
  return Math.floor(seconds / 60) + 'm' + Math.round(seconds % 60) + 's';
}

/**
 * Shape the dock view, or undefined when the control plane is idle.
 *
 * @param queue - Live lanes and waiters from the state poll.
 * @returns The content to render, or undefined when there is nothing to show.
 */
export function buildQueueDockView(queue: QueueDockInput): QueueDockView | undefined {
  const cooling = queue.lanes.filter((lane) => lane.cooldownRemainingMs > 0);
  if (queue.waiters.length === 0 && cooling.length === 0) return undefined;
  return { waiters: [...queue.waiters], cooling };
}

/** Cancel-button class; hover is styled by the injected dock stylesheet. */
export const DOCK_CANCEL_CLASS = 'dsh-llm-ctl-dock-cancel';
/** Pill-trigger class; hover/expanded styling comes from the dock stylesheet. */
export const DOCK_PILL_CLASS = 'dsh-llm-ctl-dock-pill';

/**
 * Pill row: mirrors the stats seat's `.bOPqQW_root` (centered 13px tertiary
 * row, same content width and side clearance). Class hashes are
 * version-specific, so the values are repeated here instead of referencing
 * the stats classes.
 */
const panelStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexWrap: 'wrap',
  gap: '4px 12px',
  boxSizing: 'border-box',
  width: '100%',
  maxWidth: 'var(--dsh-chat-content-width)',
  margin: '0 auto',
  padding: '4px calc(var(--dsh-composer-side-clearance, 16px) + 16px) 0',
  fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
  lineHeight: 'calc(20px + var(--dsh-content-font-delta-secondary, 0px))',
  color: 'var(--dsw-alias-label-tertiary, #93a1c0)',
};

const anchorStyle: React.CSSProperties = { display: 'inline-flex', minWidth: 0 };

/** Same inline-flex rhythm as `.bOPqQW_pill`; hover comes from CSS. */
const triggerStyle: React.CSSProperties = {
  boxSizing: 'border-box',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  maxWidth: '100%',
  padding: '1px 8px',
  border: 'none',
  borderRadius: 24,
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  fontVariantNumeric: 'tabular-nums',
  lineHeight: 'inherit',
  whiteSpace: 'nowrap',
  cursor: 'pointer',
};

const labelStyle: React.CSSProperties = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' };
const glyphStyle: React.CSSProperties = { flex: 'none', width: 14, height: 14 };

const dialogPanelStyle: React.CSSProperties = {
  position: 'fixed',
  zIndex: 1100,
  boxSizing: 'border-box',
  transform: 'translateX(-50%)',
  width: 'max-content',
  minWidth: 'min(300px, 100vw - 24px)',
  maxWidth: 'min(440px, 100vw - 24px)',
  background: 'var(--dsw-specific-menu)',
  boxShadow: 'var(--dsw-elevation-prominent)',
  color: 'var(--dsw-alias-label-secondary)',
  border: 0,
  borderRadius: 12,
  padding: 16,
  fontSize: 12,
  lineHeight: '18px',
};
const dialogTitleStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  color: 'var(--dsw-alias-label-primary)',
  marginBottom: 8,
  fontWeight: 500,
};
const dialogRuleStyle: React.CSSProperties = { borderTop: '.5px solid var(--dsw-alias-border-l2)', marginBottom: 10 };
const listStyle: React.CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  maxHeight: 240,
  overflowY: 'auto',
};
const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 };
const rowBadgeStyle: React.CSSProperties = { flex: 'none', color: 'var(--dsw-alias-label-tertiary)', fontVariantNumeric: 'tabular-nums' };
const rowProviderStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: 'var(--dsw-alias-label-primary)',
};
const rowMetaStyle: React.CSSProperties = { flex: 'none', color: 'var(--dsw-alias-label-tertiary)', fontVariantNumeric: 'tabular-nums' };
const cancelButtonStyle: React.CSSProperties = {
  flex: 'none',
  border: 'none',
  background: 'transparent',
  color: 'var(--dsw-alias-label-tertiary)',
  borderRadius: 6,
  padding: '2px 8px',
  font: 'inherit',
  cursor: 'pointer',
};

/** Clock glyph for the queue pill (stroke-style, matches the stats pills). */
function QueueGlyph(): React.ReactElement {
  return React.createElement(
    'svg',
    { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, style: glyphStyle },
    React.createElement('circle', { cx: 8, cy: 8, r: 6, stroke: 'currentColor', strokeWidth: 1.25 }),
    React.createElement('path', {
      d: 'M8 4.6V8.4L10.6 10',
      stroke: 'currentColor',
      strokeWidth: 1.25,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }),
  );
}

/** Snowflake glyph for the cooling pill. */
function CoolingGlyph(): React.ReactElement {
  return React.createElement(
    'svg',
    { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, style: glyphStyle },
    React.createElement('path', {
      d: 'M8 1.5V14.5M2.4 4.75L13.6 11.25M13.6 4.75L2.4 11.25',
      stroke: 'currentColor',
      strokeWidth: 1.25,
      strokeLinecap: 'round',
    }),
  );
}

/** Props of one pill trigger plus its dialog body. */
interface DockPillProps {
  icon: React.ReactElement;
  label: string;
  title: string;
  /** Dialog body, supplied as the element's third child argument. */
  children?: React.ReactNode;
}

/**
 * One compact trigger that opens its dialog above itself.
 *
 * Mirrors the official stats-pill interaction (anchored panel, outside
 * pointer and Escape dismiss) with local state, so the browser half needs no
 * UI-primitives types.
 *
 * @param props - Glyph, pill label, dialog title, and dialog body.
 * @returns The trigger plus, while open, its portaled dialog.
 */
function DockPill(props: DockPillProps): React.ReactElement {
  const { icon, label, title, children } = props;
  const [open, setOpen] = React.useState(false);
  const [pos, setPos] = React.useState<React.CSSProperties | undefined>(undefined);
  const rootRef = React.useRef<HTMLSpanElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) {
      setPos(undefined);
      return;
    }
    const anchor = rootRef.current;
    if (anchor === null) return;
    const rect = anchor.getBoundingClientRect();
    setPos({ left: rect.left + rect.width / 2, bottom: window.innerHeight - rect.top + 8 });
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target !== null) {
        if (rootRef.current !== null && rootRef.current.contains(target)) return;
        if (panelRef.current !== null && panelRef.current.contains(target)) return;
      }
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const trigger = React.createElement(
    'span',
    { ref: rootRef, style: anchorStyle },
    React.createElement(
      'button',
      {
        type: 'button',
        className: DOCK_PILL_CLASS,
        style: triggerStyle,
        'aria-haspopup': 'dialog',
        'aria-expanded': open,
        'aria-label': label,
        title: label,
        onClick: () => setOpen(!open),
      },
      icon,
      React.createElement('span', { style: labelStyle }, label),
    ),
  );

  const dialog = open
    ? createPortal(
        React.createElement(
          'div',
          {
            ref: panelRef,
            className: 'dsh-llm-ctl-queue-dialog',
            role: 'dialog',
            'aria-label': title,
            style: pos === undefined ? { ...dialogPanelStyle, visibility: 'hidden' } : { ...dialogPanelStyle, ...pos },
          },
          React.createElement('div', { style: dialogTitleStyle }, icon, title),
          React.createElement('div', { style: dialogRuleStyle, 'aria-hidden': true }),
          children,
        ),
        document.body,
      )
    : null;

  return React.createElement(React.Fragment, null, trigger, dialog);
}

/** Queue pill: count plus the front waiter's ETA, details on click. */
function QueuePill(props: { waiters: QueueDockWaiter[]; onCancel: (queueId: string) => void }): React.ReactElement {
  const { waiters, onCancel } = props;
  const first = waiters[0];
  const label = first === undefined ? '排队 ' + waiters.length : '排队 ' + waiters.length + ' · ~' + formatMs(first.etaMs);
  return React.createElement(
    DockPill,
    { icon: QueueGlyph(), label, title: '队列状况' },
    React.createElement(QueueDetails, { waiters, onCancel }),
  );
}

/** Dialog body: one row per waiter, each with its own cancel button. */
export function QueueDetails(props: {
  waiters: QueueDockWaiter[];
  onCancel: (queueId: string) => void;
}): React.ReactElement {
  const { waiters, onCancel } = props;
  return React.createElement(
    'ul',
    { style: listStyle },
    waiters.map((waiter) =>
        React.createElement(
          'li',
          { key: waiter.queueId, style: rowStyle },
          React.createElement('span', { style: rowBadgeStyle }, '#' + waiter.position),
          React.createElement('span', { style: rowProviderStyle }, waiter.provider),
          React.createElement(
            'span',
            { style: rowMetaStyle },
            (waiter.origin === 'background' ? '后台' : '对话') + ' · ' + formatMs(waiter.etaMs),
          ),
          React.createElement(
            'button',
            {
              type: 'button',
              className: DOCK_CANCEL_CLASS,
              style: cancelButtonStyle,
              onClick: () => onCancel(waiter.queueId),
            },
            '取消',
          ),
        ),
      ),
  );
}

/** Cooling pill: lane count plus the longest remaining cooldown. */
function CoolingPill(props: { lanes: QueueDockLane[] }): React.ReactElement {
  const { lanes } = props;
  const longest = lanes.reduce((max, lane) => Math.max(max, lane.cooldownRemainingMs), 0);
  return React.createElement(
    DockPill,
    { icon: CoolingGlyph(), label: '冷却 ' + lanes.length + ' · 最长 ' + formatMs(longest), title: '冷却中的 provider' },
    React.createElement(CoolingDetails, { lanes }),
  );
}

/** Dialog body: one row per cooling lane. */
export function CoolingDetails(props: { lanes: QueueDockLane[] }): React.ReactElement {
  const { lanes } = props;
  return React.createElement(
    'ul',
    { style: listStyle },
    lanes.map((lane) =>
        React.createElement(
          'li',
          { key: lane.provider, style: rowStyle },
          React.createElement('span', { style: rowProviderStyle }, lane.provider),
          React.createElement('span', { style: rowMetaStyle }, formatMs(lane.cooldownRemainingMs)),
        ),
      ),
  );
}

/**
 * Queue/cooldown pills for the composer dock.
 *
 * @param props - Shaped dock view plus the cancel callback.
 * @returns The rendered pill row.
 */
export function QueueDockPanel(props: { view: QueueDockView; onCancel: (queueId: string) => void }): React.ReactElement {
  const { view, onCancel } = props;
  const children: React.ReactNode[] = [];
  if (view.waiters.length > 0) {
    children.push(React.createElement(QueuePill, { key: 'queue', waiters: view.waiters, onCancel }));
  }
  if (view.cooling.length > 0) {
    children.push(React.createElement(CoolingPill, { key: 'cooling', lanes: view.cooling }));
  }
  return React.createElement('div', { style: panelStyle, role: 'status', 'aria-live': 'polite' }, children);
}