import assert from 'node:assert/strict';
import test from 'node:test';
import { ZEN_MODELS_URL, discoverProviderModels, isZenProvider, type DiscoverDeps, type LlmDiscoveryLike } from '../src/discover.ts';

function makeLlm(overrides: Partial<LlmDiscoveryLike> = {}): LlmDiscoveryLike {
  return {
    listConfigurableProviders: () => [
      { provider: 'zen-free', displayName: 'Zen', settingsNs: 'zen-ns' },
      { provider: 'DeepSeek', displayName: 'DeepSeek', settingsNs: 'deepseek-ns' },
    ],
    discoverModels: async () => [],
    ...overrides,
  };
}

function deps(overrides: Partial<DiscoverDeps> = {}): DiscoverDeps {
  return { llm: makeLlm(), logger: { info: () => undefined, warn: () => undefined }, ...overrides };
}

test('isZenProvider matches zen-family routes case-insensitively', () => {
  assert.equal(isZenProvider('opencode-zen-free-provider'), true);
  assert.equal(isZenProvider('Zen-Free'), true);
  assert.equal(isZenProvider('OpenCode'), true);
  assert.equal(isZenProvider('deepseek-official'), false);
  assert.equal(isZenProvider('openai'), false);
});

test('explicit settingsNs wins over directory lookup', async () => {
  const seen: string[] = [];
  const llm = makeLlm({
    discoverModels: async (ns) => {
      seen.push(ns);
      return [{ id: 'm1' }];
    },
  });
  const result = await discoverProviderModels({ llm }, { provider: 'zen-free', settingsNs: 'custom-ns', advertised: ['m1'] });
  assert.deepEqual(seen, ['custom-ns']);
  assert.equal(result.source, 'adapter');
  assert.deepEqual(result.discovered, [{ id: 'm1' }]);
  assert.deepEqual(result.fresh, []);
  assert.equal(result.error, undefined);
});

test('settingsNs resolves by exact provider id', async () => {
  const seen: string[] = [];
  const llm = makeLlm({
    discoverModels: async (ns) => {
      seen.push(ns);
      return [{ id: 'a' }];
    },
  });
  await discoverProviderModels({ llm }, { provider: 'zen-free' });
  assert.deepEqual(seen, ['zen-ns']);
});

test('settingsNs resolves case-insensitively as a fallback', async () => {
  const seen: string[] = [];
  const llm = makeLlm({
    discoverModels: async (ns) => {
      seen.push(ns);
      return [{ id: 'a' }];
    },
  });
  await discoverProviderModels({ llm }, { provider: 'DEEPSEEK' });
  assert.deepEqual(seen, ['deepseek-ns']);
});

test('adapter results are filtered, deduplicated, and diffed against advertised', async () => {
  const llm = makeLlm({
    discoverModels: async () => [
      { id: 'm1', name: 'M One' },
      { id: '', name: 'empty' },
      { id: 'm1', name: 'M One dup' },
      { id: 'm2' },
      null as never,
    ],
  });
  const result = await discoverProviderModels({ llm }, { provider: 'zen-free', advertised: ['m1'] });
  assert.equal(result.source, 'adapter');
  assert.deepEqual(result.discovered, [
    { id: 'm1', name: 'M One' },
    { id: 'm2' },
  ]);
  assert.deepEqual(result.fresh, ['m2']);
});

test('discovery hints reach the adapter call', async () => {
  const calls: unknown[] = [];
  const llm = makeLlm({
    discoverModels: async (_ns, request) => {
      calls.push(request);
      return [];
    },
  });
  await discoverProviderModels({ llm }, { provider: 'p', settingsNs: 'ns', baseURL: 'https://x.test/v1', api: 'openai-completions', apiKey: 'k' });
  assert.deepEqual(calls, [{ provider: 'p', baseURL: 'https://x.test/v1', api: 'openai-completions', apiKey: 'k' }]);
});

test('adapter failure falls back to the zen feed for zen routes', async () => {
  const llm = makeLlm({
    discoverModels: async () => {
      throw new Error('nope');
    },
  });
  const calls: string[] = [];
  const result = await discoverProviderModels(
    {
      llm,
      fetchJson: async (url) => {
        calls.push(url);
        return { data: [{ id: 'z-1' }, { id: '' }, { id: 'z-1' }, { noid: true }] };
      },
    },
    { provider: 'opencode-zen-free-provider', advertised: ['old'] },
  );
  assert.deepEqual(calls, [ZEN_MODELS_URL]);
  assert.equal(result.source, 'zen-feed');
  assert.deepEqual(result.discovered, [{ id: 'z-1' }]);
  assert.deepEqual(result.fresh, ['z-1']);
});

test('zen feed shape errors surface in error, not as throws', async () => {
  const llm = makeLlm({
    discoverModels: async () => {
      throw new Error('down');
    },
  });
  const result = await discoverProviderModels({ llm, fetchJson: async () => ({ wrong: true }) }, { provider: 'zen-free' });
  assert.equal(result.source, 'zen-feed');
  assert.deepEqual(result.discovered, []);
  assert.ok((result.error ?? '').includes('unexpected response shape'));
});

test('non-zen routes without a namespace report none with a reason', async () => {
  const result = await discoverProviderModels({ llm: makeLlm() }, { provider: 'unknown-provider' });
  assert.equal(result.source, 'none');
  assert.deepEqual(result.discovered, []);
  assert.ok((result.error ?? '').length > 0);
});

test('aborts propagate instead of becoming results', async () => {
  const llm = makeLlm({
    discoverModels: async (_ns, _req, signal) => {
      await new Promise((_, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
      return [];
    },
  });
  const controller = new AbortController();
  const pending = discoverProviderModels({ llm, timeoutMs: 60_000 }, { provider: 'zen-free', settingsNs: 'ns' }, controller.signal);
  controller.abort();
  await assert.rejects(pending, /aborted/);
});

test('adapter and zen both log through the injected logger', async () => {
  const infos: unknown[][] = [];
  const warns: unknown[][] = [];
  const llm = makeLlm({ discoverModels: async () => [{ id: 'm' }] });
  await discoverProviderModels({ llm, logger: { info: (...a) => infos.push(a), warn: (...a) => warns.push(a) } }, { provider: 'p', settingsNs: 'ns' });
  assert.equal(infos.length, 1);
  const llmDown = makeLlm({
    discoverModels: async () => {
      throw new Error('down');
    },
  });
  const fallback = await discoverProviderModels(
    {
      llm: llmDown,
      fetchJson: async () => ({ data: [{ id: 'z-fallback' }] }),
      logger: { info: (...a) => infos.push(a), warn: (...a) => warns.push(a) },
    },
    { provider: 'zen-free' },
  );
  assert.ok(warns.length >= 1, 'adapter failure is logged');
  assert.equal(fallback.source, 'zen-feed');
});

test('missing llm service still allows the zen feed path', async () => {
  const result = await discoverProviderModels(
    { fetchJson: async () => ({ data: [{ id: 'z-9', name: 'Zed' }] }) },
    { provider: 'zen-free' },
  );
  assert.equal(result.source, 'zen-feed');
  assert.deepEqual(result.discovered, [{ id: 'z-9', name: 'Zed' }]);
  assert.equal(result.settingsNs, undefined);
});
