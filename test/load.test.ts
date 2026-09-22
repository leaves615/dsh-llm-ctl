import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { Config, apply, inject, name } from '../lib/index.js';

/** Minimal logger service the plugin expects from the host composition. */
function loggerStub() {
  const logs: string[] = [];
  const record =
    (level: string) =>
    (...args: unknown[]): void => {
      logs.push(`${level} ${args.map((value) => String(value)).join(' ')}`);
    };
  return { debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error'), logs };
}

test('built host half exports the plugin contract', () => {
  assert.equal(name, 'llm-ctl');
  assert.deepEqual(inject, []);
  assert.equal(typeof apply, 'function');
  assert.equal(typeof Config, 'function');
});

test('config schema applies documented defaults and validates', () => {
  const resolved = Config({
    queue: { perProviderConcurrency: { default: 2, 'zen-free': 1 }, maxQueueDepth: 10 },
    reactiveRetry: 'auto',
  });
  assert.equal(resolved.queue.maxWaitMs, 120_000);
  assert.equal(resolved.queue.honorRetryAfter, true);
  assert.deepEqual(resolved.queue.backoff, { initialDelayMs: 500, maxDelayMs: 10_000, jitterRatio: 0.1 });
  assert.equal(resolved.reactiveRetry, 'auto');
  assert.throws(() => Config({ queue: { maxWaitMs: 'soon' } } as never));
});

test('the plugin mounts on a real cordis context and disposes cleanly', async () => {
  const ctx = new Context();
  ctx.provide('logger', loggerStub());
  const fiber = ctx.plugin(apply, {
    queue: { perProviderConcurrency: { default: 1 }, maxQueueDepth: 4, maxWaitMs: 5_000 },
  });
  await fiber;
  const controller = (ctx as unknown as Record<string, unknown>)['llmCtlController'];
  assert.ok(controller !== undefined, 'remote controller service is registered');
  const snapshot = (controller as { snapshot(): { queue: { lanes: unknown[] }; reactive: { limit: number } } }).snapshot();
  assert.deepEqual(snapshot.queue.lanes, []);
  assert.equal(snapshot.reactive.limit, 3);
  await fiber.dispose();
  assert.equal((ctx as unknown as Record<string, unknown>)['llmCtlController'], undefined, 'service unregisters on dispose');
});