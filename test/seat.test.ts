import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveSeatProvider } from '../src/client-plugin.ts';

test('the seat resolves the row provider from owner props, not the closure', () => {
  assert.equal(resolveSeatProvider({ provider: { provider: 'anthropic', displayName: 'Anthropic' } }, 'amazon-bedrock'), 'anthropic');
});

test('the closure id is only a fallback for missing owner props', () => {
  assert.equal(resolveSeatProvider(undefined, 'amazon-bedrock'), 'amazon-bedrock');
  assert.equal(resolveSeatProvider({}, 'amazon-bedrock'), 'amazon-bedrock');
  assert.equal(resolveSeatProvider({ provider: { provider: '', displayName: 'x' } }, 'amazon-bedrock'), 'amazon-bedrock');
  assert.equal(resolveSeatProvider({ configured: true } as never, 'amazon-bedrock'), 'amazon-bedrock');
});
