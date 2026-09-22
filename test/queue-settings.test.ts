import assert from 'node:assert/strict';
import test from 'node:test';
import type { StreamChunk } from '@deepseek-ai/dsh-llm';
import { apply } from '../src/index.ts';
import type { ConfigInput } from '../src/config.ts';
import type { SettingsPathOp } from '../src/visibility-settings.ts';
import { collect, eventKinds, fromChunks, installWebServer, makeMockContext, makeResponse, runWaterfall, type MockContext } from './mock-context.ts';

const base: ConfigInput = {
  queue: {
    perProviderConcurrency: { default: 1 },
    maxQueueDepth: 2,
    maxWaitMs: 10_000,
    honorRetryAfter: true,
    backoff: { initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
  },
};

/** Settings provider fake that only carries the queue override slice. */
function makeQueueSettings(seed: { maxWaitMs?: number; maxQueueDepth?: number; defaultConcurrency?: number; perProviderConcurrency?: Record<string, number> } = {}) {
  const value: { queue?: { maxWaitMs?: number; maxQueueDepth?: number; defaultConcurrency?: number; perProviderConcurrency?: Record<string, number> } } = {};
  if (seed.maxWaitMs !== undefined || seed.maxQueueDepth !== undefined || seed.defaultConcurrency !== undefined || seed.perProviderConcurrency !== undefined) value.queue = { ...seed };
  let revision = 1;
  let hooks: { setSource(current: unknown): void; onChange(): void } | undefined;
  const mutates: Array<{ ns: string; ops: readonly SettingsPathOp[] }> = [];
  const provider = {
    installSection(_owner: unknown, _ns: string, _schema: unknown, _entry: unknown, sectionHooks: typeof hooks) {
      hooks = sectionHooks;
      hooks?.setSource(() => value);
      hooks?.onChange();
    },
    describe() {
      return [{ ns: 'llm-ctl', revision, value, applies: 'live' }];
    },
    async mutate(ns: string, ops: readonly SettingsPathOp[]) {
      mutates.push({ ns, ops });
      for (const op of ops) {
        const key = op.path[1] as 'maxWaitMs' | 'maxQueueDepth' | 'defaultConcurrency' | 'perProviderConcurrency' | undefined;
        if (op.path[0] !== 'queue') continue;
        if (op.op === 'unset' && key === undefined) {
          delete value.queue;
          continue;
        }
        if (key === undefined || op.op !== 'set') continue;
        if (key === 'perProviderConcurrency') {
          if (typeof op.value === 'object' && op.value !== null) (value.queue ??= {}).perProviderConcurrency = { ...(op.value as Record<string, number>) };
          continue;
        }
        if (typeof op.value !== 'number') continue;
        (value.queue ??= {})[key] = op.value;
      }
      revision += 1;
      hooks?.onChange();
    },
  };
  return { provider, mutates };
}

function post(ctx: MockContext, path: string, body: string) {
  const route = ctx.routes.find((entry) => entry.path === path);
  assert.ok(route !== undefined, path + ' is registered');
  const res = makeResponse();
  return (async () => {
    await route.handler(
      { method: 'POST', [Symbol.asyncIterator]: async function* () { yield body; } },
      res,
    );
    return res;
  })();
}

function stateBody(ctx: MockContext) {
  const route = ctx.routes.find((entry) => entry.path === '/api/llm-ctl/state');
  assert.ok(route !== undefined);
  const res = makeResponse();
  return (async () => {
    await route.handler({ method: 'GET' }, res);
    assert.equal(res.status, 200);
    return JSON.parse(res.body) as {
      queueConfig: { maxWaitMs: number; maxQueueDepth: number; defaultConcurrency: number; perProviderConcurrency: Record<string, number>; defaults: { maxWaitMs: number; maxQueueDepth: number; defaultConcurrency: number }; overridden: boolean; revision: number };
    };
  })();
}

test('a stored queue override applies at startup', async () => {
  const ctx = makeMockContext();
  installWebServer(ctx);
  ctx.reflect.provide('settings', makeQueueSettings({ maxWaitMs: 30_000 }).provider);
  apply(ctx as never, base, { random: () => 0.5 });
  const body = await stateBody(ctx);
  assert.deepEqual(body.queueConfig, {
    maxWaitMs: 30_000,
    maxQueueDepth: 2,
    defaultConcurrency: 1,
    perProviderConcurrency: {},
    defaults: { maxWaitMs: 10_000, maxQueueDepth: 2, defaultConcurrency: 1 },
    overridden: true,
    revision: 1,
  });
  assert.ok(eventKinds(ctx).includes('queue-config-changed'));
});

test('posting a queue override takes effect without a restart', async () => {
  const ctx = makeMockContext();
  installWebServer(ctx);
  const settings = makeQueueSettings();
  ctx.reflect.provide('settings', settings.provider);
  apply(ctx as never, base, { random: () => 0.5 });

  const res = await post(ctx, '/api/llm-ctl/queue', '{"maxWaitMs":45000}');
  assert.equal(res.status, 200);
  assert.deepEqual(settings.mutates[0]?.ops, [{ op: 'set', path: ['queue', 'maxWaitMs'], value: 45000 }]);
  const body = await stateBody(ctx);
  assert.equal(body.queueConfig.maxWaitMs, 45000);
  assert.equal(body.queueConfig.overridden, true);
  assert.ok(eventKinds(ctx).includes('queue-config-changed'));
});

test('a depth override narrows admission immediately', async () => {
  const ctx = makeMockContext();
  installWebServer(ctx);
  ctx.reflect.provide('settings', makeQueueSettings().provider);
  apply(ctx as never, base, { random: () => 0.5 });

  const res = await post(ctx, '/api/llm-ctl/queue', '{"maxQueueDepth":1}');
  assert.equal(res.status, 200);

  const chunks = [
    { type: 'text-delta', index: 0, text: 'x' } as StreamChunk,
    { type: 'finish', reason: { kind: 'stop' } } as StreamChunk,
  ];
  const blocker = runWaterfall(ctx, 'llm/stream', { provider: 'p', model: 'm', messages: [] }, () => fromChunks(chunks));
  const blockerIterator = blocker[Symbol.asyncIterator]();
  await blockerIterator.next();

  const queued = runWaterfall(ctx, 'llm/stream', { provider: 'p', model: 'm', messages: [] }, () => fromChunks(chunks));
  const queuedIterator = queued[Symbol.asyncIterator]();
  const pending = queuedIterator.next();

  const refused = await collect(runWaterfall(ctx, 'llm/stream', { provider: 'p', model: 'm', messages: [] }, () => fromChunks(chunks)));
  const reason = (refused[0] as Extract<StreamChunk, { type: 'finish' }>).reason;
  assert.equal(reason.kind === 'error' && reason.failure.code, 'QUEUE_FULL');

  await collect(blockerIterator);
  await pending;
  await collect(queuedIterator);
});

test('resetting the queue override restores the cordis base', async () => {
  const ctx = makeMockContext();
  installWebServer(ctx);
  ctx.reflect.provide('settings', makeQueueSettings({ maxWaitMs: 30_000 }).provider);
  apply(ctx as never, base, { random: () => 0.5 });

  const res = await post(ctx, '/api/llm-ctl/queue/reset', '{}');
  assert.equal(res.status, 200);
  const body = await stateBody(ctx);
  assert.deepEqual(body.queueConfig, {
    maxWaitMs: 10_000,
    maxQueueDepth: 2,
    defaultConcurrency: 1,
    perProviderConcurrency: {},
    defaults: { maxWaitMs: 10_000, maxQueueDepth: 2, defaultConcurrency: 1 },
    overridden: false,
    revision: 2,
  });
});

test('the queue route validates its body', async () => {
  const ctx = makeMockContext();
  installWebServer(ctx);
  ctx.reflect.provide('settings', makeQueueSettings().provider);
  apply(ctx as never, base, { random: () => 0.5 });
  const route = ctx.routes.find((entry) => entry.path === '/api/llm-ctl/queue');
  assert.ok(route !== undefined);

  const getRes = makeResponse();
  await route.handler({ method: 'GET' }, getRes);
  assert.equal(getRes.status, 405);

  for (const body of ['{}', '{"maxWaitMs":-1}', '{"maxQueueDepth":0}', '{"maxWaitMs":"soon"}', '{"defaultConcurrency":-1}', '{"defaultConcurrency":"many"}', '{"perProviderConcurrency":[]}', '{"perProviderConcurrency":{"p":-1}}', '{"perProviderConcurrency":{"p":"many"}}', '{"perProviderConcurrency":{"":1}}']) {
    const res = await post(ctx, '/api/llm-ctl/queue', body);
    assert.equal(res.status, 400, body);
  }
});

/** Read the full control state to inspect live gate lanes and waiters. */
function fullState(ctx: MockContext) {
  const route = ctx.routes.find((entry) => entry.path === '/api/llm-ctl/state');
  assert.ok(route !== undefined);
  const res = makeResponse();
  return (async () => {
    await route.handler({ method: 'GET' }, res);
    assert.equal(res.status, 200);
    return JSON.parse(res.body) as {
      queue: { lanes: Array<{ provider: string; active: number; concurrency: number; queued: number }>; waiters: Array<{ provider: string }> };
      queueConfig: { defaultConcurrency: number; perProviderConcurrency: Record<string, number>; overridden: boolean };
    };
  })();
}

test('a stored concurrency override applies at startup', async () => {
  const ctx = makeMockContext();
  installWebServer(ctx);
  ctx.reflect.provide('settings', makeQueueSettings({ defaultConcurrency: 3, perProviderConcurrency: { p: 5 } }).provider);
  apply(ctx as never, base, { random: () => 0.5 });
  const body = await stateBody(ctx);
  assert.equal(body.queueConfig.defaultConcurrency, 3);
  assert.deepEqual(body.queueConfig.perProviderConcurrency, { p: 5 });
  assert.equal(body.queueConfig.overridden, true);
});

test('a default-concurrency override narrows admission without a restart', async () => {
  const ctx = makeMockContext();
  installWebServer(ctx);
  ctx.reflect.provide('settings', makeQueueSettings().provider);
  apply(ctx as never, { ...base, queue: { ...base.queue, perProviderConcurrency: { default: 2 } } }, { random: () => 0.5 });

  const res = await post(ctx, '/api/llm-ctl/queue', '{"defaultConcurrency":1}');
  assert.equal(res.status, 200);
  const body = await stateBody(ctx);
  assert.equal(body.queueConfig.defaultConcurrency, 1);
  assert.equal(body.queueConfig.overridden, true);

  const chunks = [
    { type: 'text-delta', index: 0, text: 'x' } as StreamChunk,
    { type: 'finish', reason: { kind: 'stop' } } as StreamChunk,
  ];
  const blocker = runWaterfall(ctx, 'llm/stream', { provider: 'p', model: 'm', messages: [] }, () => fromChunks(chunks));
  const blockerIterator = blocker[Symbol.asyncIterator]();
  await blockerIterator.next();

  const queued = runWaterfall(ctx, 'llm/stream', { provider: 'p', model: 'm', messages: [] }, () => fromChunks(chunks));
  const queuedIterator = queued[Symbol.asyncIterator]();
  const pending = queuedIterator.next();

  const snapshot = await fullState(ctx);
  assert.equal(snapshot.queue.lanes.find((lane) => lane.provider === 'p')?.concurrency, 1);
  assert.deepEqual(snapshot.queue.waiters.map((waiter) => waiter.provider), ['p']);

  await collect(blockerIterator);
  await pending;
  await collect(queuedIterator);
});

test('without a configured default every provider runs uncapped', async () => {
  const ctx = makeMockContext();
  installWebServer(ctx);
  ctx.reflect.provide('settings', makeQueueSettings().provider);
  apply(ctx as never, { ...base, queue: { ...base.queue, perProviderConcurrency: {} } }, { random: () => 0.5 });

  const body = await stateBody(ctx);
  assert.equal(body.queueConfig.defaultConcurrency, 0);
  assert.deepEqual(body.queueConfig.perProviderConcurrency, {});
  assert.equal(body.queueConfig.overridden, false);

  const chunks = [
    { type: 'text-delta', index: 0, text: 'x' } as StreamChunk,
    { type: 'finish', reason: { kind: 'stop' } } as StreamChunk,
  ];
  const run = (provider: string) => {
    const stream = runWaterfall(ctx, 'llm/stream', { provider, model: 'm', messages: [] }, () => fromChunks(chunks));
    const iterator = stream[Symbol.asyncIterator]();
    return { iterator, done: iterator.next() };
  };
  // Three concurrent requests on an ordinary provider: none of them queues.
  const a = run('p');
  const b = run('p');
  const c = run('p');
  await a.done;
  await b.done;
  await c.done;
  let snapshot = await fullState(ctx);
  assert.deepEqual(snapshot.queue.waiters, []);
  await collect(a.iterator);
  await collect(b.iterator);
  await collect(c.iterator);

  // Free routes are uncapped too: two concurrent requests both run.
  const first = run('zen-free');
  await first.done;
  const second = run('zen-free');
  await second.done;
  snapshot = await fullState(ctx);
  assert.equal(snapshot.queue.lanes.find((lane) => lane.provider === 'zen-free')?.concurrency, 0);
  assert.deepEqual(snapshot.queue.waiters, []);
  await collect(first.iterator);
  await collect(second.iterator);
});

test('a per-provider concurrency override narrows only that provider', async () => {
  const ctx = makeMockContext();
  installWebServer(ctx);
  ctx.reflect.provide('settings', makeQueueSettings().provider);
  apply(ctx as never, { ...base, queue: { ...base.queue, perProviderConcurrency: { default: 2 } } }, { random: () => 0.5 });

  const res = await post(ctx, '/api/llm-ctl/queue', '{"perProviderConcurrency":{"p":1}}');
  assert.equal(res.status, 200);
  const body = await stateBody(ctx);
  assert.deepEqual(body.queueConfig.perProviderConcurrency, { p: 1 });
  assert.equal(body.queueConfig.defaultConcurrency, 2);

  const chunks = [
    { type: 'text-delta', index: 0, text: 'x' } as StreamChunk,
    { type: 'finish', reason: { kind: 'stop' } } as StreamChunk,
  ];
  const blocker = runWaterfall(ctx, 'llm/stream', { provider: 'p', model: 'm', messages: [] }, () => fromChunks(chunks));
  const blockerIterator = blocker[Symbol.asyncIterator]();
  await blockerIterator.next();

  const queued = runWaterfall(ctx, 'llm/stream', { provider: 'p', model: 'm', messages: [] }, () => fromChunks(chunks));
  const queuedIterator = queued[Symbol.asyncIterator]();
  const pending = queuedIterator.next();

  // Another provider still enjoys the default of 2: two concurrent requests run free.
  const otherA = await collect(runWaterfall(ctx, 'llm/stream', { provider: 'q', model: 'm', messages: [] }, () => fromChunks(chunks)));
  const otherB = await collect(runWaterfall(ctx, 'llm/stream', { provider: 'q', model: 'm', messages: [] }, () => fromChunks(chunks)));
  assert.equal((otherA[0] as { type: string }).type, 'text-delta');
  assert.equal((otherB[0] as { type: string }).type, 'text-delta');

  const snapshot = await fullState(ctx);
  assert.deepEqual(snapshot.queue.waiters.map((waiter) => waiter.provider), ['p']);

  await collect(blockerIterator);
  await pending;
  await collect(queuedIterator);
});
