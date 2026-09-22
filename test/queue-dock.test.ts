import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  CoolingDetails,
  DOCK_CANCEL_CLASS,
  DOCK_PILL_CLASS,
  QueueDetails,
  QueueDockPanel,
  buildQueueDockView,
  formatMs,
  type QueueDockInput,
} from '../src/queue-dock.ts';

function input(overrides: Partial<QueueDockInput> = {}): QueueDockInput {
  return { lanes: [], waiters: [], ...overrides };
}

/** One waiter fixture. */
function waiter(position: number, overrides: Partial<QueueDockInput['waiters'][number]> = {}) {
  return {
    queueId: 'q' + position,
    provider: 'zen-free',
    origin: 'loop' as const,
    position,
    etaMs: 12_000,
    ...overrides,
  };
}

test('idle control plane shapes to nothing so the dock collapses', () => {
  assert.equal(buildQueueDockView(input()), undefined);
  assert.equal(
    buildQueueDockView(input({ lanes: [{ provider: 'p', cooldownRemainingMs: 0 }] })),
    undefined,
    'spent cooldowns do not keep the seat alive',
  );
});

test('every waiter passes through and only live cooldowns survive', () => {
  const view = buildQueueDockView(
    input({
      waiters: [1, 2, 3, 4, 5].map((n) => waiter(n, { origin: n % 2 === 0 ? 'background' : 'loop' })),
      lanes: [
        { provider: 'zen-free', cooldownRemainingMs: 5_000 },
        { provider: 'other', cooldownRemainingMs: 0 },
      ],
    }),
  );
  assert.ok(view !== undefined);
  assert.equal(view.waiters.length, 5, 'the dialog lists the whole queue');
  assert.deepEqual(
    view.cooling.map((lane) => lane.provider),
    ['zen-free'],
  );
});

test('formatMs compacts delays like the old banner did', () => {
  assert.equal(formatMs(850), '850ms');
  assert.equal(formatMs(8_500), '8.5s');
  assert.equal(formatMs(12_000), '12s');
  assert.equal(formatMs(125_000), '2m5s');
});

test('the panel renders stats-style pills for the queue and cooling', () => {
  const html = renderToStaticMarkup(
    QueueDockPanel({
      view: {
        waiters: [waiter(3)],
        cooling: [{ provider: 'glm', cooldownRemainingMs: 5_000 }],
      },
      onCancel: () => {},
    }),
  );
  assert.ok(html.includes('排队 1'), 'queue count pill');
  assert.ok(html.includes('~12s'), 'front waiter ETA');
  assert.ok(html.includes('冷却 1'), 'cooling count pill');
  assert.ok(html.includes('最长 5.0s'), 'longest cooldown');
  assert.ok(html.includes(DOCK_PILL_CLASS), 'stats-pill trigger class');
  assert.ok(html.includes('aria-haspopup="dialog"'), 'pills open a dialog');
  assert.ok(html.includes('role="status"'), 'live region survives the move');
  // Same geometry as the stats row: centered, wrapping, same content width.
  assert.ok(html.includes('justify-content:center'), 'centered like the stats row');
  assert.ok(html.includes('flex-wrap:wrap'), 'pills wrap instead of stacking as a column');
  assert.ok(html.includes('var(--dsh-chat-content-width)'), 'same content width token');
  assert.ok(!html.includes('flex-direction:column'), 'no column layout');
});

test('the queue dialog body lists every waiter with its own cancel', () => {
  const cancelled: string[] = [];
  const html = renderToStaticMarkup(
    React.createElement(QueueDetails, {
      waiters: [waiter(3), waiter(4, { provider: 'glm', origin: 'background' })],
      onCancel: (queueId: string) => cancelled.push(queueId),
    }),
  );
  assert.ok(html.includes('#3'), 'position badge');
  assert.ok(html.includes('#4'), 'second position badge');
  assert.ok(html.includes('zen-free'), 'first provider');
  assert.ok(html.includes('glm'), 'second provider');
  assert.ok(html.includes('对话'), 'loop origin label');
  assert.ok(html.includes('后台'), 'background origin label');
  assert.ok(html.includes('取消'), 'cancel affordance');
  assert.ok(html.includes(DOCK_CANCEL_CLASS), 'cancel styling hook');
});

test('the cooling dialog body lists each lane with its remaining time', () => {
  const html = renderToStaticMarkup(
    React.createElement(CoolingDetails, {
      lanes: [
        { provider: 'zen-free', cooldownRemainingMs: 5_000 },
        { provider: 'glm', cooldownRemainingMs: 12_000 },
      ],
    }),
  );
  assert.ok(html.includes('zen-free'), 'first cooling provider');
  assert.ok(html.includes('glm'), 'second cooling provider');
  assert.ok(html.includes('5.0s'), 'first remaining time');
  assert.ok(html.includes('12s'), 'second remaining time');
});
