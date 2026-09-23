import assert from 'node:assert/strict';
import test from 'node:test';
import type { StreamChunk } from '@deepseek-ai/dsh-llm';
import { apply } from '../src/index.ts';
import type { ConfigInput } from '../src/config.ts';
import { collect, eventKinds, fromChunks, installWebServer, makeMockContext, makeResponse, runWaterfall, type MockContext } from './mock-context.ts';

const instantBackoff: ConfigInput = {
  queue: {
    perProviderConcurrency: { default: 1 },
    maxQueueDepth: 2,
    maxWaitMs: 10_000,
    honorRetryAfter: true,
    backoff: { initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
  },
};

function setup(config: ConfigInput = instantBackoff): MockContext {
  const ctx = makeMockContext();
  apply(ctx as never, config, { random: () => 0.5 });
  return ctx;
}

function snapshot(ctx: MockContext) {
  const controller = ctx.services.get('llmCtlController') as
    | { snapshot(): { queue: { lanes: Array<{ provider: string; active: number; cooldownRemainingMs: number; queued: number }>; waiters: Array<{ queueId: string; origin: string; position: number }> }; events: Array<{ kind: string; delayMs?: number }> } }
    | undefined;
  assert.ok(controller !== undefined, 'controller service must be registered');
  return controller.snapshot();
}

function streamFor(ctx: MockContext, provider: string, purpose?: 'compaction' | 'session-title', onDispatch?: () => void) {
  const options: Record<string, unknown> = { provider, model: 'm', messages: [] };
  if (purpose !== undefined) options.purpose = purpose;
  return runWaterfall(ctx, 'llm/stream', options, () => {
    onDispatch?.();
    return fromChunks([{ type: 'finish', reason: { kind: 'stop' } } as StreamChunk]);
  });
}

test('registers both listeners and the remote controller', () => {
  const ctx = setup();
  assert.equal(ctx.listeners.get('llm/stream')?.length, 1);
  assert.equal(ctx.listeners.get('agent/request-error')?.length, 1);
  assert.ok(ctx.services.has('llmCtlController'));
  assert.ok(ctx.disposers.length >= 1, 'plugin registers at least one disposer');
});

test('admission happens before dispatch and serializes per provider', async () => {
  const ctx = setup();
  let dispatched = 0;
  const first = runWaterfall(
    ctx,
    'llm/stream',
    { provider: 'p', model: 'm', messages: [] },
    () => {
      dispatched += 1;
      return fromChunks([
        { type: 'text-delta', index: 0, text: 'a' } as StreamChunk,
        { type: 'finish', reason: { kind: 'stop' } } as StreamChunk,
      ]);
    },
  );
  const iterator = first[Symbol.asyncIterator]();
  const firstChunk = await iterator.next();
  assert.equal(firstChunk.done, false);
  assert.equal(dispatched, 1, 'first request dispatches after admission');

  const second = streamFor(ctx, 'p', undefined, () => {
    dispatched += 1;
  });
  const secondIterator = second[Symbol.asyncIterator]();
  const pendingSecond = secondIterator.next();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(dispatched, 1, 'second request waits for the slot');
  assert.deepEqual(
    snapshot(ctx).queue.waiters.map((waiter) => waiter.origin),
    ['loop'],
  );

  await collect(iterator);
  const secondChunk = await pendingSecond;
  assert.equal(secondChunk.done, false);
  assert.equal(dispatched, 2, 'slot release lets the queued request dispatch');
  await collect(secondIterator);
});

test('background tasks queue through the same lane with their own origin', async () => {
  const ctx = setup();
  const blocker = runWaterfall(
    ctx,
    'llm/stream',
    { provider: 'p', model: 'm', messages: [] },
    () => fromChunks([{ type: 'text-delta', index: 0, text: 'x' } as StreamChunk, { type: 'finish', reason: { kind: 'stop' } } as StreamChunk]),
  );
  const blockerIterator = blocker[Symbol.asyncIterator]();
  await blockerIterator.next();

  const background = streamFor(ctx, 'p', 'session-title');
  const backgroundIterator = background[Symbol.asyncIterator]();
  const pending = backgroundIterator.next();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(
    snapshot(ctx).queue.waiters.map((waiter) => waiter.origin),
    ['background'],
  );

  await collect(blockerIterator);
  await pending;
  await collect(backgroundIterator);
});

test('queue depth refusal yields one terminal error chunk without dispatching', async () => {
  const ctx = setup({ ...instantBackoff, queue: { ...instantBackoff.queue, maxQueueDepth: 1 } });
  let dispatched = 0;
  const blocker = runWaterfall(
    ctx,
    'llm/stream',
    { provider: 'p', model: 'm', messages: [] },
    () => {
      dispatched += 1;
      return fromChunks([{ type: 'text-delta', index: 0, text: 'x' } as StreamChunk, { type: 'finish', reason: { kind: 'stop' } } as StreamChunk]);
    },
  );
  const blockerIterator = blocker[Symbol.asyncIterator]();
  await blockerIterator.next();

  const queued = streamFor(ctx, 'p');
  const queuedIterator = queued[Symbol.asyncIterator]();
  const pending = queuedIterator.next();

  const refused = await collect(streamFor(ctx, 'p'));
  assert.equal(refused.length, 1);
  const reason = (refused[0] as Extract<StreamChunk, { type: 'finish' }>).reason;
  assert.equal(reason.kind, 'error');
  assert.equal(reason.kind === 'error' && reason.failure.code, 'QUEUE_FULL');
  assert.equal(dispatched, 1, 'the refused request never reaches the adapter');

  await collect(blockerIterator);
  await pending;
  await collect(queuedIterator);
});

test('a terminal rate-limit chunk registers the provider cooldown', async () => {
  const ctx = setup();
  const stream = runWaterfall(
    ctx,
    'llm/stream',
    { provider: 'p', model: 'm', messages: [] },
    () =>
      fromChunks([
        {
          type: 'finish',
          reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'slow down', providerRetryAfterMs: 3_000 } },
        } as StreamChunk,
      ]),
  );
  await collect(stream);
  const lane = snapshot(ctx).queue.lanes.find((candidate) => candidate.provider === 'p');
  assert.ok(lane !== undefined);
  assert.ok(lane.cooldownRemainingMs > 2_000, `expected cooldown, got ${lane.cooldownRemainingMs}`);
  assert.ok(eventKinds(ctx).includes('cooldown'));
});

test('a terminal quota chunk never cools the lane down', async () => {
  const ctx = setup();
  const stream = runWaterfall(
    ctx,
    'llm/stream',
    { provider: 'p', model: 'm', messages: [] },
    () => fromChunks([{ type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA', message: 'no balance' } } } as StreamChunk]),
  );
  await collect(stream);
  const lane = snapshot(ctx).queue.lanes.find((candidate) => candidate.provider === 'p');
  assert.equal(lane?.cooldownRemainingMs, 0);
});

test('standalone recovery retries a rate-limit failure when nothing downstream claims it', async () => {
  const ctx = setup();
  const signal = new AbortController().signal;
  const action = await runWaterfall(
    ctx,
    'agent/request-error',
    { agent: { session: { id: 's1' } }, turn: 1, step: 1, provider: 'p', failure: { code: 'RATE_LIMIT', message: 'x' }, signal },
    () => Promise.resolve(undefined),
  );
  assert.deepEqual(action, { kind: 'retry' });
  assert.ok(eventKinds(ctx).includes('retry-scheduled'));
  const scheduled = snapshot(ctx).events.find((event) => event.kind === 'retry-scheduled');
  assert.ok(scheduled !== undefined);
});

test('a downstream retry decision is passed through without spending the local budget', async () => {
  const ctx = setup();
  const downstream = () => Promise.resolve({ kind: 'retry' as const });
  ctx.on('agent/request-error', downstream);
  const signal = new AbortController().signal;
  const payload = { agent: { session: { id: 's2' } }, turn: 1, step: 1, provider: 'p', failure: { code: 'RATE_LIMIT', message: 'x' }, signal };
  const action = await runWaterfall(ctx, 'agent/request-error', payload, () => Promise.resolve(undefined));
  assert.deepEqual(action, { kind: 'retry' });
  assert.ok(eventKinds(ctx).includes('retry-delegated'));
  assert.equal(eventKinds(ctx).includes('retry-scheduled'), false);
});

test('terminal codes are never recovered locally', async () => {
  const ctx = setup();
  const signal = new AbortController().signal;
  const action = await runWaterfall(
    ctx,
    'agent/request-error',
    { agent: { session: { id: 's3' } }, turn: 1, step: 1, provider: 'p', failure: { code: 'AUTH', message: 'bad key' }, signal },
    () => Promise.resolve(undefined),
  );
  assert.equal(action, undefined);
  assert.ok(eventKinds(ctx).includes('retry-skipped'));
});

test('standalone budget stops after the configured cap', async () => {
  const ctx = setup({ ...instantBackoff, reactiveRetry: 1 });
  const signal = new AbortController().signal;
  const payload = { agent: { session: { id: 's4' } }, turn: 1, step: 1, provider: 'p', failure: { code: 'RATE_LIMIT', message: 'x' }, signal };
  const first = await runWaterfall(ctx, 'agent/request-error', payload, () => Promise.resolve(undefined));
  const second = await runWaterfall(ctx, 'agent/request-error', payload, () => Promise.resolve(undefined));
  assert.deepEqual(first, { kind: 'retry' });
  assert.equal(second, undefined);
});

test('reactiveRetry off disables standalone recovery', async () => {
  const ctx = setup({ ...instantBackoff, reactiveRetry: 'off' });
  const signal = new AbortController().signal;
  const action = await runWaterfall(
    ctx,
    'agent/request-error',
    { agent: { session: { id: 's5' } }, turn: 1, step: 1, provider: 'p', failure: { code: 'RATE_LIMIT', message: 'x' }, signal },
    () => Promise.resolve(undefined),
  );
  assert.equal(action, undefined);
});

test('dispose drains waiters and stops accepting requests', async () => {
  const ctx = setup();
  const blocker = runWaterfall(
    ctx,
    'llm/stream',
    { provider: 'p', model: 'm', messages: [] },
    () => fromChunks([{ type: 'text-delta', index: 0, text: 'x' } as StreamChunk, { type: 'finish', reason: { kind: 'stop' } } as StreamChunk]),
  );
  const blockerIterator = blocker[Symbol.asyncIterator]();
  await blockerIterator.next();
  const queued = streamFor(ctx, 'p');
  const queuedIterator = queued[Symbol.asyncIterator]();
  const pending = queuedIterator.next();
  await new Promise((resolve) => setTimeout(resolve, 5));

  for (const disposer of ctx.disposers) await disposer();

  const outcome = await pending;
  assert.equal(outcome.done, false);
  const reason = (outcome.value as Extract<StreamChunk, { type: 'finish' }>).reason;
  assert.equal(reason.kind === 'error' && reason.failure.code, 'ABORTED');
  await collect(blockerIterator).catch(() => []);
});
test('the browser channel registers the state and cancel routes', async () => {
  const ctx = setup();
  const routes = installWebServer(ctx);
  // Re-apply against a context that already has the web server mounted.
  const ctx2 = makeMockContext();
  installWebServer(ctx2);
  apply(ctx2 as never, instantBackoff, { random: () => 0.5 });
  assert.deepEqual(
    ctx2.routes.map((route) => route.path),
    ['/api/llm-ctl/state', '/api/llm-ctl/cancel', '/api/llm-ctl/visibility', '/api/llm-ctl/visibility/reset', '/api/llm-ctl/queue', '/api/llm-ctl/queue/reset', '/api/llm-ctl/discover'],
  );

  const stateRoute = ctx2.routes.find((route) => route.path === '/api/llm-ctl/state');
  assert.ok(stateRoute !== undefined);
  const res = makeResponse();
  await stateRoute.handler({ method: 'GET' }, res);
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  const body = JSON.parse(res.body) as { queue: { lanes: unknown[] }; reactive: { limit: number }; queueConfig: { maxWaitMs: number; maxQueueDepth: number; defaultConcurrency: number; perProviderConcurrency: Record<string, number>; defaults: { maxWaitMs: number; maxQueueDepth: number; defaultConcurrency: number }; overridden: boolean; revision: number }; visibility: { settings: unknown; patterns: unknown[] } };
  assert.deepEqual(body.queue.lanes, []);
  assert.equal(body.reactive.limit, 3); assert.deepEqual(body.queueConfig, { maxWaitMs: 10_000, maxQueueDepth: 2, defaultConcurrency: 1, perProviderConcurrency: {}, defaults: { maxWaitMs: 10_000, maxQueueDepth: 2, defaultConcurrency: 1 }, overridden: false, revision: 0 });
  assert.deepEqual(body.visibility.settings, { providers: {}, models: {} });
  assert.deepEqual(body.visibility.patterns, []);
  void ctx;
});

test('the cancel route rejects a malformed body and reports unknown queue ids', async () => {
  const ctx = makeMockContext();
  installWebServer(ctx);
  apply(ctx as never, instantBackoff, { random: () => 0.5 });
  const cancelRoute = ctx.routes.find((route) => route.path === '/api/llm-ctl/cancel');
  assert.ok(cancelRoute !== undefined);

  const getRes = makeResponse();
  await cancelRoute.handler({ method: 'GET' }, getRes);
  assert.equal(getRes.status, 405);

  const badRes = makeResponse();
  await cancelRoute.handler({ method: 'POST', [Symbol.asyncIterator]: async function* () { yield '{}'; } }, badRes);
  assert.equal(badRes.status, 400);

  const unknownRes = makeResponse();
  await cancelRoute.handler({ method: 'POST', [Symbol.asyncIterator]: async function* () { yield '{"queueId":"nope"}'; } }, unknownRes);
  assert.equal(unknownRes.status, 200);
  assert.deepEqual(JSON.parse(unknownRes.body), { cancelled: false });
});

test('no web server mounted leaves the plugin loadable without routes', () => {
  const ctx = setup();
  assert.deepEqual(ctx.routes, []);
  assert.ok(ctx.services.has('llmCtlController'));
});
test('the discover route validates input and delegates to upstream discovery', async () => {
  const ctx = makeMockContext();
  installWebServer(ctx);
  ctx.services.set('llm', {
    listProviders: () => [{ id: 'zen-free', name: 'Zen' }],
    listModels: async () => [{ id: 'old-model', name: 'Old' }],
    listConfigurableProviders: () => [{ provider: 'zen-free', displayName: 'Zen', settingsNs: 'zen-ns' }],
    discoverModels: async () => [{ id: 'new-model', name: 'New' }],
  });
  apply(ctx as never, instantBackoff, { random: () => 0.5 });
  const route = ctx.routes.find((entry) => entry.path === '/api/llm-ctl/discover');
  assert.ok(route !== undefined);

  const missing = makeResponse();
  await route.handler({ method: 'POST', [Symbol.asyncIterator]: async function* () { yield '{}'; } }, missing);
  assert.equal(missing.status, 400);

  const okRes = makeResponse();
  await route.handler(
    { method: 'POST', [Symbol.asyncIterator]: async function* () { yield '{"provider":"zen-free"}'; } },
    okRes,
  );
  assert.equal(okRes.status, 200);
  const body = JSON.parse(okRes.body) as { source: string; discovered: unknown[]; fresh: string[] };
  assert.equal(body.source, 'adapter');
  assert.deepEqual(body.fresh, ['new-model']);

  const getRes = makeResponse();
  await route.handler({ method: 'GET' }, getRes);
  assert.equal(getRes.status, 405);
});

test('the discover route rejects an apiKey in the body', async () => {
  const ctx = makeMockContext();
  installWebServer(ctx);
  ctx.services.set('llm', {
    listProviders: () => [{ id: 'zen-free', name: 'Zen' }],
    listModels: async () => [{ id: 'old-model', name: 'Old' }],
    listConfigurableProviders: () => [{ provider: 'zen-free', displayName: 'Zen', settingsNs: 'zen-ns' }],
    discoverModels: async () => [{ id: 'new-model', name: 'New' }],
  });
  apply(ctx as never, instantBackoff, { random: () => 0.5 });
  const route = ctx.routes.find((entry) => entry.path === '/api/llm-ctl/discover');
  assert.ok(route !== undefined);

  const secretRes = makeResponse();
  await route.handler(
    { method: 'POST', [Symbol.asyncIterator]: async function* () { yield '{"provider":"zen-free","apiKey":"k"}'; } },
    secretRes,
  );
  assert.equal(secretRes.status, 400);
  assert.match(JSON.parse(secretRes.body as string).error as string, /stored credential/);
});
