import assert from 'node:assert/strict';
import test from 'node:test';
import { concurrencyFor } from '../src/concurrency.ts';

test('an empty table leaves every provider unlimited, free ones included', () => {
  assert.equal(concurrencyFor({}, 'openai'), Infinity);
  assert.equal(concurrencyFor({}, 'teamrouter'), Infinity);
  assert.equal(concurrencyFor({}, 'zen-free'), Infinity);
  assert.equal(concurrencyFor({}, 'opencode-zen-free-provider'), Infinity);
});

test('an explicit default caps every provider without an entry', () => {
  assert.equal(concurrencyFor({ default: 3 }, 'openai'), 3);
  assert.equal(concurrencyFor({ default: 3 }, 'zen-free'), 3);
});

test('zero means unlimited, per provider or as the default', () => {
  assert.equal(concurrencyFor({ default: 0 }, 'openai'), Infinity);
  assert.equal(concurrencyFor({ default: 2, 'zen-free': 0 }, 'zen-free'), Infinity);
  assert.equal(concurrencyFor({ default: 0 }, 'zen-free'), Infinity);
});

test('an explicit entry outranks every fallback', () => {
  assert.equal(concurrencyFor({ default: 5, 'zen-free': 4 }, 'zen-free'), 4);
  assert.equal(concurrencyFor({ 'openai': 7 }, 'openai'), 7);
});
