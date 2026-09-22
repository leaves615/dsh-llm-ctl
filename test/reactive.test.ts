import assert from 'node:assert/strict';
import test from 'node:test';
import { RetryBudget, WAITABLE_CODES, cancellableDelay, decideReactive } from '../src/reactive.ts';
import { resolveDelay } from '../src/delay.ts';

const backoff = { initialDelayMs: 500, maxDelayMs: 10_000, jitterRatio: 0 };
const delay = resolveDelay({ attempt: 1, backoff, maxWaitMs: 120_000, honorRetryAfter: true, random: () => 0.5 });

test('waitable codes mirror the default retryable set', () => {
  assert.deepEqual([...WAITABLE_CODES], ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE']);
});

test('a downstream retry decision always wins', () => {
  const decision = decideReactive({ code: 'RATE_LIMIT', delegated: true, attempts: 0, limit: 3, delay });
  assert.equal(decision.retry, false);
  assert.equal(decision.reason, 'downstream-owns');
});

test('terminal codes are never retried locally', () => {
  for (const code of ['AUTH', 'QUOTA', 'INVALID_REQUEST', 'CONTEXT_WINDOW_EXCEEDED', 'NO_ADAPTER']) {
    const decision = decideReactive({ code, delegated: false, attempts: 0, limit: 3, delay });
    assert.equal(decision.retry, false, code);
    assert.equal(decision.reason, 'code-not-waitable', code);
  }
});

test('standalone budget is honored and reported', () => {
  assert.equal(decideReactive({ code: 'RATE_LIMIT', delegated: false, attempts: 0, limit: 3, delay }).retry, true);
  assert.equal(decideReactive({ code: 'RATE_LIMIT', delegated: false, attempts: 2, limit: 3, delay }).retry, true);
  const exhausted = decideReactive({ code: 'RATE_LIMIT', delegated: false, attempts: 3, limit: 3, delay });
  assert.equal(exhausted.retry, false);
  assert.equal(exhausted.reason, 'budget-exhausted');
  assert.equal(decideReactive({ code: 'RATE_LIMIT', delegated: false, attempts: 0, limit: 0, delay }).reason, 'disabled');
});

test('an over-budget provider hint fails fast instead of waiting', () => {
  const overBudget = resolveDelay({
    providerRetryAfterMs: 300_000,
    attempt: 1,
    backoff,
    maxWaitMs: 120_000,
    honorRetryAfter: true,
    random: () => 0.5,
  });
  const decision = decideReactive({ code: 'RATE_LIMIT', delegated: false, attempts: 0, limit: 3, delay: overBudget });
  assert.equal(decision.retry, false);
  assert.equal(decision.reason, 'over-budget');
});

test('retry budget counts per key and stays bounded', () => {
  const budget = new RetryBudget(2);
  assert.equal(budget.attempts('a'), 0);
  assert.equal(budget.record('a'), 1);
  assert.equal(budget.record('a'), 2);
  assert.equal(budget.attempts('a'), 2);
  budget.record('b');
  budget.record('c');
  assert.equal(budget.size, 2, 'oldest key is evicted');
  assert.equal(budget.attempts('a'), 0);
  budget.forget('b');
  assert.equal(budget.attempts('b'), 0);
});

test('cancellableDelay resolves false when aborted', async () => {
  const controller = new AbortController();
  const pending = cancellableDelay(5_000, controller.signal);
  controller.abort();
  assert.equal(await pending, false);
  assert.equal(await cancellableDelay(0, new AbortController().signal), true);
  const preAborted = new AbortController();
  preAborted.abort();
  assert.equal(await cancellableDelay(5_000, preAborted.signal), false);
});
