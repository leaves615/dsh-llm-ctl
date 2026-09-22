import assert from 'node:assert/strict';
import test from 'node:test';
import {
  VISIBILITY_SETTINGS_NS,
  VisibilitySettingsSchema,
  installVisibilitySettings,
} from '../src/visibility-settings.ts';
import type {
  InstallOptions,
  SettingsPathOp,
  VisibilitySettingsHandle,
  VisibilitySettingsHandleWithPatterns,
} from '../src/visibility-settings.ts';
import type { VisibilitySettings } from '../src/visibility.ts';
import { makeMockContext, type MockContext } from './mock-context.ts';

/** Hooks recorded from one `installSection` call. */
interface FakeHooks {
  setSource(current: unknown): void;
  onChange(): void;
  validate?(value: unknown): void;
}

/** One recorded `installSection` call. */
interface FakeInstall {
  owner: unknown;
  ns: string;
  schema: unknown;
  entry: unknown;
  hooks: FakeHooks;
}

/** One recorded `mutate` call. */
interface FakeMutate {
  ns: string;
  ops: readonly SettingsPathOp[];
  expectedRevision: number | undefined;
}

/** In-memory stand-in for the `settings` service. */
interface FakeSettings {
  provider: {
    installSection(owner: unknown, ns: string, schema: unknown, entry: unknown, hooks: FakeHooks): void;
    describe(options?: { redactSecrets?: boolean }): Array<{ ns: string; revision: number; value: unknown; applies: string }>;
    mutate(ns: string, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void>;
  };
  installs: FakeInstall[];
  mutates: FakeMutate[];
  value(): Partial<VisibilitySettings> & { queue?: { maxWaitMs?: number; maxQueueDepth?: number; defaultConcurrency?: number; perProviderConcurrency?: Record<string, number> } };
  revision(): number;
  setConflict(conflict: boolean): void;
  setFailure(failure: unknown): void;
  bump(): void;
}

/**
 * Build an in-memory settings provider.
 *
 * `installSection` behaves like the real service: it hands the consumer a thunk
 * over the live resolved value, then announces the attach. `mutate` applies the
 * path ops, bumps the revision, notifies every consumer, and can be told to fail
 * with a conflict or an arbitrary error.
 */
function makeFakeSettings(seed: Partial<VisibilitySettings> & { queue?: { maxWaitMs?: number; maxQueueDepth?: number; defaultConcurrency?: number; perProviderConcurrency?: Record<string, number> } } = {}, startRevision = 1): FakeSettings {
  const value: Partial<VisibilitySettings> & { queue?: { maxWaitMs?: number; maxQueueDepth?: number; defaultConcurrency?: number; perProviderConcurrency?: Record<string, number> } } = {};
  if (seed.providers !== undefined) value.providers = { ...seed.providers };
  if (seed.models !== undefined) value.models = { ...seed.models };
  if (seed.queue !== undefined) value.queue = { ...seed.queue };
  let revision = startRevision;
  let forcedConflict = false;
  let failure: unknown;
  const installs: FakeInstall[] = [];
  const mutates: FakeMutate[] = [];

  function table(head: string): Record<string, boolean> {
    if (head === 'providers') return (value.providers ??= {});
    return (value.models ??= {});
  }

  function applyOp(op: SettingsPathOp): void {
    const head = op.path[0];
    const key = op.path[1];
    if (head === undefined) return;
    if (head === 'queue') {
      if (op.op === 'unset' && key === undefined) {
        delete value.queue;
        return;
      }
      if (key === undefined) return;
      if (op.op === 'unset') {
        if (value.queue !== undefined) delete value.queue[key as 'maxWaitMs' | 'maxQueueDepth' | 'defaultConcurrency' | 'perProviderConcurrency'];
        return;
      }
      if (key === 'perProviderConcurrency') {
        if (typeof op.value === 'object' && op.value !== null) (value.queue ??= {}).perProviderConcurrency = { ...(op.value as Record<string, number>) };
        return;
      }
      if (typeof op.value === 'number') (value.queue ??= {})[key as 'maxWaitMs' | 'maxQueueDepth' | 'defaultConcurrency'] = op.value;
      return;
    }
    if (op.op === 'unset' && key === undefined) {
      if (head === 'providers') value.providers = {};
      else if (head === 'models') value.models = {};
      return;
    }
    if (key === undefined) return;
    if (op.op === 'unset') delete table(head)[key];
    else table(head)[key] = op.value === true;
  }

  function notify(): void {
    for (const install of installs) install.hooks.onChange();
  }

  const provider: FakeSettings['provider'] = {
    installSection(owner, ns, schema, entry, hooks) {
      installs.push({ owner, ns, schema, entry, hooks });
      hooks.setSource(() => value);
      hooks.onChange();
    },
    describe() {
      return [{ ns: installs[0]?.ns ?? VISIBILITY_SETTINGS_NS, revision, value, applies: 'live' }];
    },
    async mutate(ns, ops, expectedRevision) {
      mutates.push({ ns, ops, expectedRevision });
      if (failure !== undefined) throw failure;
      if (forcedConflict || (expectedRevision !== undefined && expectedRevision !== revision)) {
        const error = new Error(`settings section "${ns}" moved from revision ${expectedRevision} to ${revision}`);
        Object.assign(error, { code: 'SETTINGS_CONFLICT', expected: expectedRevision, actual: revision });
        throw error;
      }
      for (const op of ops) applyOp(op);
      revision += 1;
      notify();
    },
  };

  return {
    provider,
    installs,
    mutates,
    value: () => ({ ...value }),
    revision: () => revision,
    setConflict: (conflict) => {
      forcedConflict = conflict;
    },
    setFailure: (next) => {
      failure = next;
    },
    bump: () => {
      revision += 1;
    },
  };
}

/** Install a handle over a fresh mock context, optionally with a provider. */
function install(
  fake: FakeSettings | undefined,
  options?: InstallOptions,
): { ctx: MockContext; handle: VisibilitySettingsHandle } {
  const ctx = makeMockContext();
  if (fake !== undefined) ctx.reflect.provide('settings', fake.provider);
  return { ctx, handle: installVisibilitySettings(ctx, options) };
}

const BASE: VisibilitySettings = { providers: { 'zen-free': false }, models: { 'zen-free:gpt-4o': false } };

test('the namespace is the lowercase llm-ctl section id', () => {
  assert.equal(VISIBILITY_SETTINGS_NS, 'llm-ctl');
  assert.match(VISIBILITY_SETTINGS_NS, /^[a-z][a-z0-9-]*$/);
});

test('the section schema defaults both tables to empty', () => {
  assert.deepEqual(VisibilitySettingsSchema({}), { providers: {}, models: {}, queue: { perProviderConcurrency: {} } });
  assert.deepEqual(VisibilitySettingsSchema({ providers: { zen: false } }), {
    providers: { zen: false },
    models: {},
    queue: { perProviderConcurrency: {} },
  });
});

test('without a provider the handle reads the base and never registers a section', async () => {
  const { ctx, handle } = install(undefined, { base: BASE });
  assert.deepEqual(handle.read(), BASE);
  assert.equal(handle.revision(), undefined);
  assert.equal(ctx.services.has('settings'), false);
  const result = await handle.write([{ op: 'set', path: ['providers', 'zen-free'], value: true }]);
  assert.deepEqual(result, {
    ok: false,
    code: 'SETTINGS_ERROR',
    message: 'settings provider unavailable',
  });
  assert.deepEqual(await handle.setProvider('zen-free', true), {
    ok: false,
    code: 'SETTINGS_ERROR',
    message: 'settings provider unavailable',
  });
  assert.deepEqual(handle.read(), BASE);
});

test('without a provider and without a base the tables are empty', async () => {
  const { handle } = install(undefined);
  assert.deepEqual(handle.read(), { providers: {}, models: {} });
  const result = await handle.resetAll();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SETTINGS_ERROR');
});

test('with a provider the section is registered with the plugin owner, namespace, schema, and base', () => {
  const fake = makeFakeSettings();
  const { ctx, handle } = install(fake, { base: BASE });
  void handle;
  assert.equal(fake.installs.length, 1);
  const [call] = fake.installs;
  assert.equal(call?.owner, ctx);
  assert.equal(call?.ns, 'llm-ctl');
  assert.equal(call?.schema, VisibilitySettingsSchema);
  assert.deepEqual(call?.entry, BASE);
  assert.equal(typeof call?.hooks.setSource, 'function');
  assert.equal(typeof call?.hooks.onChange, 'function');
});

test('a custom namespace is registered and written to', async () => {
  const fake = makeFakeSettings();
  const { handle } = install(fake, { namespace: 'llm-ctl-visibility' });
  assert.equal(fake.installs[0]?.ns, 'llm-ctl-visibility');
  await handle.setProvider('zen-free', false);
  assert.equal(fake.mutates[0]?.ns, 'llm-ctl-visibility');
});

test('read reflects the installed source and reports the seeded revision', () => {
  const fake = makeFakeSettings({ providers: { 'zen-free': false }, models: {} }, 7);
  const { handle } = install(fake);
  assert.deepEqual(handle.read(), { providers: { 'zen-free': false }, models: {} });
  assert.equal(handle.revision(), 7);
});

test('a table missing from the resolved section reads as empty', () => {
  const fake = makeFakeSettings({ providers: { 'zen-free': false } });
  const { handle } = install(fake);
  assert.deepEqual(handle.read(), { providers: { 'zen-free': false }, models: {} });
});

test('setProvider writes one providers path op', async () => {
  const fake = makeFakeSettings();
  const { handle } = install(fake);
  const result = await handle.setProvider('zen-free', false);
  assert.equal(result.ok, true);
  assert.deepEqual(fake.mutates, [
    { ns: 'llm-ctl', ops: [{ op: 'set', path: ['providers', 'zen-free'], value: false }], expectedRevision: undefined },
  ]);
  assert.deepEqual(fake.value(), { providers: { 'zen-free': false } });
  assert.deepEqual(handle.read(), { providers: { 'zen-free': false }, models: {} });
});

test('setModel writes one models path op keyed provider:model', async () => {
  const fake = makeFakeSettings();
  const { handle } = install(fake);
  await handle.setModel('zen-free', 'gpt-4o', true);
  assert.deepEqual(fake.mutates[0]?.ops, [{ op: 'set', path: ['models', 'zen-free:gpt-4o'], value: true }]);
  assert.deepEqual(handle.read().models, { 'zen-free:gpt-4o': true });
});

test('resetAll unsets both tables', async () => {
  const fake = makeFakeSettings({ providers: { 'zen-free': false }, models: { 'zen-free:gpt-4o': false } });
  const { handle } = install(fake);
  const result = await handle.resetAll();
  assert.equal(result.ok, true);
  assert.deepEqual(fake.mutates[0]?.ops, [
    { op: 'unset', path: ['providers'] },
    { op: 'unset', path: ['models'] },
  ]);
  assert.deepEqual(handle.read(), { providers: {}, models: {} });
});

test('write forwards expectedRevision and returns the refreshed revision', async () => {
  const fake = makeFakeSettings({}, 4);
  const { handle } = install(fake);
  const result = await handle.write([{ op: 'set', path: ['providers', 'zen-free'], value: true }], 4);
  assert.equal(fake.mutates[0]?.expectedRevision, 4);
  assert.deepEqual(result, { ok: true, revision: 5 });
  assert.equal(handle.revision(), 5);
  assert.equal(fake.revision(), 5);
});

test('a moved section is reported as SETTINGS_CONFLICT', async () => {
  const fake = makeFakeSettings({}, 9);
  const { handle } = install(fake);
  const result = await handle.write([{ op: 'set', path: ['providers', 'zen-free'], value: false }], 3);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SETTINGS_CONFLICT');
  assert.match(result.message ?? '', /moved from revision 3 to 9/);
  assert.equal(handle.revision(), 9, 'a refused write leaves the observed revision alone');
});

test('any other provider rejection is reported as SETTINGS_ERROR', async () => {
  const fake = makeFakeSettings();
  fake.setFailure(new Error('document is read-only'));
  const { handle } = install(fake);
  const result = await handle.setProvider('zen-free', false);
  assert.deepEqual(result, { ok: false, code: 'SETTINGS_ERROR', message: 'document is read-only' });
  assert.equal(handle.revision(), 1);
});

test('a non-Error rejection still yields a message', async () => {
  const fake = makeFakeSettings();
  fake.setFailure('boom');
  const { handle } = install(fake);
  const result = await handle.setModel('zen-free', 'gpt-4o', false);
  assert.deepEqual(result, { ok: false, code: 'SETTINGS_ERROR', message: 'boom' });
});

test('read returns a detached deep copy', () => {
  const fake = makeFakeSettings({ providers: { 'zen-free': false }, models: {} });
  const { handle } = install(fake);
  const first = handle.read();
  first.providers['zen-free'] = true;
  first.providers.injected = true;
  first.models['injected:model'] = false;
  const second = handle.read();
  assert.notEqual(first, second);
  assert.notEqual(first.providers, second.providers);
  assert.notEqual(first.models, second.models);
  assert.deepEqual(second, { providers: { 'zen-free': false }, models: {} });
  assert.deepEqual(fake.value(), { providers: { 'zen-free': false }, models: {} });
});

test('onChange is notified on attach and after every committed change', async () => {
  const seen: VisibilitySettings[] = [];
  const fake = makeFakeSettings();
  const { handle } = install(fake, { onChange: (next) => seen.push(next) });
  assert.deepEqual(seen, [{ providers: {}, models: {} }], 'attach announces the resolved section');
  await handle.setProvider('zen-free', false);
  assert.deepEqual(seen, [
    { providers: {}, models: {} },
    { providers: { 'zen-free': false }, models: {} },
  ]);
  seen[1]!.providers.injected = true;
  assert.deepEqual(handle.read().providers, { 'zen-free': false }, 'the snapshot handed out is detached');
});

test('dispose is idempotent and every later write fails', async () => {
  const fake = makeFakeSettings({ providers: { 'zen-free': false }, models: {} });
  const { handle } = install(fake, { base: BASE });
  handle.dispose();
  handle.dispose();
  const result = await handle.setProvider('zen-free', true);
  assert.deepEqual(result, {
    ok: false,
    code: 'SETTINGS_ERROR',
    message: 'visibility settings handle disposed',
  });
  assert.equal(handle.revision(), undefined);
  assert.deepEqual(handle.read(), BASE, 'a disposed handle falls back to the composition base');
  assert.equal(fake.mutates.length, 0);
});

test('disposing the owning context disposes the handle', async () => {
  const fake = makeFakeSettings();
  const { ctx, handle } = install(fake);
  for (const dispose of ctx.disposers) await dispose();
  const result = await handle.resetAll();
  assert.equal(result.ok, false);
  assert.equal(result.message, 'visibility settings handle disposed');
});

test('composition patterns are normalized and exposed on the handle', () => {
  const fake = makeFakeSettings();
  const { handle } = install(fake, { patterns: ['  *-Test-*  ', 'zen-free:*Nightly*'] });
  const extended = handle as VisibilitySettingsHandleWithPatterns;
  assert.deepEqual(extended.patterns(), ['*-test-*', 'zen-free:*nightly*']);
  assert.notEqual(extended.patterns(), extended.patterns(), 'every read hands out a fresh array');
  assert.deepEqual(extended.patterns(), ['*-test-*', 'zen-free:*nightly*']);
});

test('without a provider the composition patterns are still exposed', () => {
  const { handle } = install(undefined, { patterns: ['*-test-*'] });
  assert.deepEqual((handle as VisibilitySettingsHandleWithPatterns).patterns(), ['*-test-*']);
});

test('the section schema keeps a partial queue override', () => {
  assert.deepEqual(VisibilitySettingsSchema({ queue: { maxWaitMs: 90000 } }), {
    providers: {},
    models: {},
    queue: { maxWaitMs: 90000, perProviderConcurrency: {} },
  });
});

test('the section schema keeps a concurrency override', () => {
  assert.deepEqual(VisibilitySettingsSchema({ queue: { defaultConcurrency: 4, perProviderConcurrency: { 'zen-free': 1 } } }), {
    providers: {},
    models: {},
    queue: { defaultConcurrency: 4, perProviderConcurrency: { 'zen-free': 1 } },
  });
  assert.deepEqual(VisibilitySettingsSchema({ queue: { defaultConcurrency: 0 } }).queue, { defaultConcurrency: 0, perProviderConcurrency: {} });
  assert.throws(() => VisibilitySettingsSchema({ queue: { defaultConcurrency: -1 } }));
  assert.throws(() => VisibilitySettingsSchema({ queue: { perProviderConcurrency: { 'zen-free': -1 } } }));
});

test('the section schema rejects a negative queue budget', () => {
  assert.throws(() => VisibilitySettingsSchema({ queue: { maxWaitMs: -5 } }));
});

test('queue override reads empty without a stored slice', () => {
  const fake = makeFakeSettings();
  const { handle } = install(fake);
  assert.deepEqual(handle.queue(), {});
});

test('queue override reflects the stored slice', () => {
  const fake = makeFakeSettings({ queue: { maxWaitMs: 30000, maxQueueDepth: 10 } });
  const { handle } = install(fake);
  assert.deepEqual(handle.queue(), { maxWaitMs: 30000, maxQueueDepth: 10 });
});

test('setQueue writes one path op per defined field', async () => {
  const fake = makeFakeSettings();
  const { handle } = install(fake);
  const result = await handle.setQueue({ maxWaitMs: 30000 });
  assert.equal(result.ok, true);
  assert.deepEqual(fake.mutates[0]?.ops, [{ op: 'set', path: ['queue', 'maxWaitMs'], value: 30000 }]);
  assert.deepEqual(handle.queue(), { maxWaitMs: 30000 });
});

test('setQueue writes concurrency ops and reads them back', async () => {
  const fake = makeFakeSettings();
  const { handle } = install(fake);
  const result = await handle.setQueue({ defaultConcurrency: 4, perProviderConcurrency: { 'zen-free': 1 } });
  assert.equal(result.ok, true);
  assert.deepEqual(fake.mutates[0]?.ops, [
    { op: 'set', path: ['queue', 'defaultConcurrency'], value: 4 },
    { op: 'set', path: ['queue', 'perProviderConcurrency'], value: { 'zen-free': 1 } },
  ]);
  assert.deepEqual(handle.queue(), { defaultConcurrency: 4, perProviderConcurrency: { 'zen-free': 1 } });
});

test('setQueue with no fields is a no-op success', async () => {
  const fake = makeFakeSettings();
  const { handle } = install(fake);
  const result = await handle.setQueue({});
  assert.equal(result.ok, true);
  assert.equal(fake.mutates.length, 0);
});

test('resetQueue drops the override slice', async () => {
  const fake = makeFakeSettings({ queue: { maxWaitMs: 30000 } });
  const { handle } = install(fake);
  const result = await handle.resetQueue();
  assert.equal(result.ok, true);
  assert.deepEqual(handle.queue(), {});
});

test('queue read ignores non-numeric garbage', () => { 
  const fake = makeFakeSettings({ queue: { maxWaitMs: 'soon', maxQueueDepth: -2 } as never });
  const { handle } = install(fake);
  assert.deepEqual(handle.queue(), {});
});
