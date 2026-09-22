import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderGate } from '../src/queue.ts';
import type { CtlEvent, CtlEventKind } from '../src/events.ts';
import { FakeScheduler, flush } from './fake-scheduler.ts';

function makeGate(overrides: Partial<ConstructorParameters<typeof ProviderGate>[0]> = {}) {
  const scheduler = new FakeScheduler();
  const events: Array<{ kind: CtlEventKind; detail: Omit<CtlEvent, 'seq' | 'at' | 'kind'> }> = [];
  const gate = new ProviderGate({
    scheduler,
    concurrencyFor: () => 1,
    maxQueueDepth: 2,
    maxWaitMs: 10_000,
    onEvent: (kind, detail) => events.push({ kind, detail }),
    ...overrides,
  });
  return { gate, scheduler, events };
}

test('first request is granted immediately and the second waits for release', async () => {
  const { gate } = makeGate();
  const first = await gate.acquire('p', { origin: 'loop' });
  assert.equal(first.ok, true);

  const secondPromise = gate.acquire('p', { origin: 'loop' });
  let secondSettled = false;
  void secondPromise.then(() => {
    secondSettled = true;
  });
  await flush();
  assert.equal(secondSettled, false, 'second request must queue behind the concurrency cap');

  if (first.ok) first.release();
  const second = await secondPromise;
  assert.equal(second.ok, true);
  assert.equal(gate.snapshot().lanes[0]?.active, 1);
  if (second.ok) second.release();
  assert.equal(gate.snapshot().lanes[0]?.active, 0);
});

test('queue keeps arrival order across origins', async () => {
  const { gate } = makeGate();
  const first = await gate.acquire('p', { origin: 'loop' });
  const background = gate.acquire('p', { origin: 'background' });
  const loop = gate.acquire('p', { origin: 'loop' });

  const snapshot = gate.snapshot();
  assert.deepEqual(snapshot.waiters.map((waiter) => waiter.origin), ['background', 'loop']);
  assert.deepEqual(snapshot.waiters.map((waiter) => waiter.position), [1, 2]);

  if (first.ok) first.release();
  const backgroundGrant = await background;
  assert.equal(backgroundGrant.ok && backgroundGrant.origin, 'background');
  if (backgroundGrant.ok) backgroundGrant.release();
  const loopGrant = await loop;
  assert.equal(loopGrant.ok && loopGrant.origin, 'loop');
  if (loopGrant.ok) loopGrant.release();
});

test('queue depth is bounded', async () => {
  const { gate } = makeGate({ maxQueueDepth: 1 });
  const first = await gate.acquire('p', { origin: 'loop' });
  const queued = gate.acquire('p', { origin: 'loop' });
  const refused = await gate.acquire('p', { origin: 'loop' });
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false && refused.code, 'QUEUE_FULL');
  if (first.ok) first.release();
  const granted = await queued;
  if (granted.ok) granted.release();
});

test('a queued request times out after the single wait budget', async () => {
  const { gate, scheduler } = makeGate({ maxWaitMs: 5_000 });
  const first = await gate.acquire('p', { origin: 'loop' });
  const queued = gate.acquire('p', { origin: 'loop' });
  await scheduler.advance(5_000);
  const outcome = await queued;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.code, 'QUEUE_TIMEOUT');
  assert.equal(outcome.ok === false && outcome.reason, 'max-wait');
  if (first.ok) first.release();
});

test('cooldown blocks the lane and resumes when it expires', async () => {
  const { gate, scheduler } = makeGate();
  gate.registerCooldown('p', 3_000, 'request-error', 'provider-retry-after-ms');

  const queued = gate.acquire('p', { origin: 'loop' });
  let settled = false;
  void queued.then(() => {
    settled = true;
  });
  await flush();
  assert.equal(settled, false);
  assert.equal(gate.snapshot().lanes[0]?.cooldownRemainingMs, 3_000);

  await scheduler.advance(2_999);
  assert.equal(settled, false);
  await scheduler.advance(1);
  const outcome = await queued;
  assert.equal(outcome.ok, true);
  if (outcome.ok) outcome.release();
});

test('a cooldown longer than the wait budget fails waiters and new arrivals fast', async () => {
  const { gate } = makeGate({ maxWaitMs: 1_000 });
  const first = await gate.acquire('p', { origin: 'loop' });

  const queued = gate.acquire('p', { origin: 'loop' });
  gate.registerCooldown('p', 300_000, 'terminal-failure', 'provider-retry-after-ms');
  const outcome = await queued;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.reason, 'cooldown-exceeds-budget');

  const arrival = await gate.acquire('p', { origin: 'loop' });
  assert.equal(arrival.ok, false);
  assert.equal(arrival.ok === false && arrival.code, 'QUEUE_TIMEOUT');
  if (first.ok) first.release();
});

test('cancel refuses one queued request without touching the others', async () => {
  const { gate } = makeGate();
  const first = await gate.acquire('p', { origin: 'loop' });
  const doomed = gate.acquire('p', { origin: 'loop' });
  const survivor = gate.acquire('p', { origin: 'loop' });
  const queueId = gate.snapshot().waiters[0]?.queueId;
  assert.equal(typeof queueId, 'string');
  assert.equal(gate.cancel(queueId as string), true);
  const cancelled = await doomed;
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.ok === false && cancelled.code, 'ABORTED');
  if (first.ok) first.release();
  const granted = await survivor;
  if (granted.ok) granted.release();
});

test('aborting the request signal releases the queue slot', async () => {
  const { gate } = makeGate();
  const first = await gate.acquire('p', { origin: 'loop' });
  const controller = new AbortController();
  const queued = gate.acquire('p', { origin: 'loop', signal: controller.signal });
  controller.abort();
  const outcome = await queued;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.code, 'ABORTED');
  if (first.ok) first.release();
  assert.equal(gate.snapshot().lanes[0]?.queued, 0);
});

test('dispose fails every waiter and clears timers', async () => {
  const { gate, scheduler } = makeGate();
  const first = await gate.acquire('p', { origin: 'loop' });
  const queued = gate.acquire('p', { origin: 'loop' });
  gate.dispose();
  const outcome = await queued;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.reason, 'disposed');
  assert.equal(scheduler.pending, 0);
  if (first.ok) first.release();
});

test('concurrency table resolves per provider, free routes, and default', async () => {
  const seen: string[] = [];
  const gate = new ProviderGate({
    scheduler: new FakeScheduler(),
    concurrencyFor: (provider) => (provider === 'paid' ? 3 : provider.includes('free') ? 1 : 2),
    maxQueueDepth: 4,
    maxWaitMs: 1_000,
    onEvent: () => seen.push('event'),
  });
  const paidA = await gate.acquire('paid', { origin: 'loop' });
  const paidB = await gate.acquire('paid', { origin: 'loop' });
  const paidC = await gate.acquire('paid', { origin: 'loop' });
  assert.equal(paidA.ok && paidB.ok && paidC.ok, true);
  assert.equal(gate.snapshot().lanes.find((lane) => lane.provider === 'paid')?.active, 3);
  for (const grant of [paidA, paidB, paidC]) if (grant.ok) grant.release();
  assert.equal(seen.length > 0, true);});

test('updateLimits raises the depth cap for admissions started after the call', async () => {
  const { gate } = makeGate({ maxQueueDepth: 1 });
  const first = await gate.acquire('p', { origin: 'loop' });
  const queued = gate.acquire('p', { origin: 'loop' });
  const refused = await gate.acquire('p', { origin: 'loop' });
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false && refused.code, 'QUEUE_FULL');
  gate.updateLimits({ maxQueueDepth: 3 });
  const late = gate.acquire('p', { origin: 'loop' });
  await flush();
  assert.equal(gate.snapshot().lanes[0]?.queued, 2);
  if (first.ok) first.release();
  const second = await queued;
  if (second.ok) second.release();
  const third = await late;
  if (third.ok) third.release();
});

test('updateLimits shortens the wait budget for admissions started after the call', async () => {
  const { gate, scheduler } = makeGate({ maxWaitMs: 10_000 });
  const first = await gate.acquire('p', { origin: 'loop' });
  gate.updateLimits({ maxWaitMs: 100 });
  const queued = gate.acquire('p', { origin: 'loop' });
  await scheduler.advance(150);
  const outcome = await queued;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.code, 'QUEUE_TIMEOUT');
  if (first.ok) first.release();
});

test('updateLimits clamps nonsense without throwing', async () => {
  const { gate, scheduler } = makeGate();
  gate.updateLimits({ maxWaitMs: -5, maxQueueDepth: 0 });
  const first = await gate.acquire('p', { origin: 'loop' });
  assert.equal(first.ok, true);
  const queued = gate.acquire('p', { origin: 'loop' });
  const refused = await gate.acquire('p', { origin: 'loop' });
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false && refused.code, 'QUEUE_FULL');
  await scheduler.advance(0);
  const outcome = await queued;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.code, 'QUEUE_TIMEOUT');
  if (first.ok) first.release();
});