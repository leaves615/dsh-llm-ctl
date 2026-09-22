import assert from 'node:assert/strict';
import test from 'node:test';
import {
  backoffDelay,
  parseGoDurationMs,
  parseNumericResetHeader,
  parseRetryAfterHeader,
  parseRetryAfterMsHeader,
  parseRfc3339ResetHeader,
  resolveDelay,
} from '../src/delay.ts';

const backoff = { initialDelayMs: 500, maxDelayMs: 10_000, jitterRatio: 0 };

test('parseRetryAfterHeader handles seconds and HTTP dates', () => {
  assert.equal(parseRetryAfterHeader('12'), 12_000);
  assert.equal(parseRetryAfterHeader(' 3 '), 3_000);
  const now = Date.UTC(2026, 0, 1, 0, 0, 0);
  assert.equal(parseRetryAfterHeader(new Date(now + 5_000).toUTCString(), now), 5_000);
  assert.equal(parseRetryAfterHeader('0'), undefined);
  assert.equal(parseRetryAfterHeader('not-a-date'), undefined);
  assert.equal(parseRetryAfterHeader(undefined), undefined);
});

test('parseRetryAfterMsHeader reads milliseconds', () => {
  assert.equal(parseRetryAfterMsHeader('2000'), 2_000);
  assert.equal(parseRetryAfterMsHeader('-5'), undefined);
  assert.equal(parseRetryAfterMsHeader('abc'), undefined);
});

test('parseNumericResetHeader distinguishes seconds from epoch seconds', () => {
  assert.equal(parseNumericResetHeader('30'), 30_000);
  const now = 1_700_000_000_000;
  assert.equal(parseNumericResetHeader(String(now / 1000 + 45), now), 45_000);
  assert.equal(parseNumericResetHeader('0'), undefined);
});

test('parseGoDurationMs reads OpenAI and Groq duration strings', () => {
  assert.equal(parseGoDurationMs('6m0s'), 360_000);
  assert.equal(parseGoDurationMs('2m59.56s'), 179_560);
  assert.equal(parseGoDurationMs('1h30m'), 5_400_000);
  assert.equal(parseGoDurationMs('500ms'), 500);
  assert.equal(parseGoDurationMs('6m0s junk'), undefined);
  assert.equal(parseGoDurationMs(''), undefined);
});

test('parseRfc3339ResetHeader converts an absolute instant', () => {
  const now = Date.UTC(2026, 0, 1, 0, 0, 0);
  assert.equal(parseRfc3339ResetHeader(new Date(now + 30_000).toISOString(), now), 30_000);
  assert.equal(parseRfc3339ResetHeader(new Date(now - 1).toISOString(), now), undefined);
});

test('backoffDelay is bounded and jittered', () => {
  assert.equal(backoffDelay(1, backoff, () => 0.5), 500);
  assert.equal(backoffDelay(2, backoff, () => 0.5), 1_000);
  assert.equal(backoffDelay(10, backoff, () => 0.5), 10_000);
  const jittered = backoffDelay(1, { initialDelayMs: 1_000, maxDelayMs: 10_000, jitterRatio: 0.5 }, () => 1);
  assert.equal(jittered, 1_500);
});

test('resolveDelay prefers the adapter hint and flags over-budget waits', () => {
  const base = { attempt: 1, backoff, maxWaitMs: 120_000, honorRetryAfter: true, random: () => 0.5 };
  assert.deepEqual(resolveDelay({ ...base, providerRetryAfterMs: 4_000 }), {
    delayMs: 4_000,
    source: 'provider-retry-after-ms',
    overBudget: false,
  });
  assert.deepEqual(resolveDelay({ ...base, providerRetryAfterMs: 300_000 }), {
    delayMs: 300_000,
    source: 'provider-retry-after-ms',
    overBudget: true,
  });
  assert.deepEqual(resolveDelay({ ...base, providerRetryAfterMs: 0 }), {
    delayMs: 500,
    source: 'backoff',
    overBudget: false,
  });
});

test('resolveDelay walks the header ladder in priority order', () => {
  const base = { attempt: 3, backoff, maxWaitMs: 120_000, honorRetryAfter: true, random: () => 0.5 };
  assert.equal(resolveDelay({ ...base, headers: { 'retry-after': '7' } }).source, 'retry-after');
  assert.equal(resolveDelay({ ...base, headers: { 'retry-after': '7', 'retry-after-ms': '900' } }).source, 'retry-after-ms');
  assert.equal(resolveDelay({ ...base, headers: { 'x-ratelimit-reset': '42' } }).source, 'ratelimit-reset');
  assert.equal(resolveDelay({ ...base, headers: { 'x-ratelimit-reset-requests': '2m59.56s' } }).source, 'go-duration');
  const now = Date.UTC(2026, 0, 1);
  assert.equal(
    resolveDelay({ ...base, headers: { 'anthropic-ratelimit-requests-reset': new Date(now + 5_000).toISOString() }, now: () => now })
      .source,
    'rfc3339-reset',
  );
});

test('resolveDelay ignores hints when honorRetryAfter is false', () => {
  const resolved = resolveDelay({
    providerRetryAfterMs: 9_000,
    attempt: 1,
    backoff,
    maxWaitMs: 120_000,
    honorRetryAfter: false,
    random: () => 0.5,
  });
  assert.equal(resolved.source, 'backoff');
  assert.equal(resolved.delayMs, 500);
});