/**
 * Visibility settings adapter: the `llm-ctl` settings section that persists the
 * two model-visibility tables.
 *
 * The settings provider is an optional dependency. {@link installVisibilitySettings}
 * attaches through `ctx.inject(['settings'], …)`, so a deployment without a
 * settings provider still loads: the handle keeps answering reads from the
 * composition `base` and refuses writes with `SETTINGS_ERROR`. When a provider
 * is present the section is registered with
 * `settings.installSection(ctx, ns, schema, base, hooks)` — the owner is the
 * plugin context, so disposing the plugin fiber removes the namespace — and the
 * hooks keep the authoritative value and the section revision in sync.
 *
 * Writes are path-addressed (`settings.mutate`), never wholesale, so a caller
 * holding a redacted view cannot delete fields it never saw; `expectedRevision`
 * is forwarded verbatim so a stale writer is refused with `SETTINGS_CONFLICT`.
 *
 * @module dsh-llm-ctl/visibility-settings
 */
import z from '@deepseek-ai/schemastery';
import { modelKey, normalizePattern, type VisibilitySettings } from './visibility.ts';

/** Namespace the visibility tables are persisted under. */
export const VISIBILITY_SETTINGS_NS = 'llm-ctl';

/** Message returned when no settings provider is attached. */
const UNAVAILABLE_MESSAGE = 'settings provider unavailable';

/** Message returned once the handle has been disposed. */
const DISPOSED_MESSAGE = 'visibility settings handle disposed';

/** One path-addressed edit to the section's user layer. */
export type SettingsPathOp =
  | { op: 'set'; path: readonly string[]; value: unknown }
  | { op: 'unset'; path: readonly string[] };

/** Outcome of one settings write. */
export interface VisibilityWriteResult {
  /** True when the provider committed every op. */
  ok: boolean;
  /** Section revision after a successful write. */
  revision?: number;
  /** Machine-readable failure class, absent on success. */
  code?: 'SETTINGS_CONFLICT' | 'SETTINGS_ERROR';
  /** Human-readable failure detail, absent on success. */
  message?: string;
}

/** Owner-facing handle over the persisted visibility switches. */
export interface VisibilitySettingsHandle {
  /** Detached snapshot of the authoritative switches; never a live reference. */
  read(): VisibilitySettings;
  /** Last observed section revision, or undefined before the first read/write. */
  revision(): number | undefined;
  /**
   * Apply path-addressed edits to the section's user layer.
   * @param ops - ordered edits, applied by the provider as it stands at write time.
   * @param expectedRevision - revision the caller read; a moved section is refused.
   * @returns the write outcome, never a rejection.
   */
  write(ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<VisibilityWriteResult>;
  /**
   * Write one provider's switch.
   * @param provider - provider id.
   * @param visible - whether the provider is visible.
   * @returns the write outcome.
   */
  setProvider(provider: string, visible: boolean): Promise<VisibilityWriteResult>;
  /**
   * Write one model's switch.
   * @param provider - provider id.
   * @param model - model id.
   * @param visible - whether the model is visible.
   * @returns the write outcome.
   */
  setModel(provider: string, model: string, visible: boolean): Promise<VisibilityWriteResult>;
  /**
   * Read the queue override slice; empty means the cordis base applies.
   * @returns a detached override snapshot, never a live reference.
   */
  queue(): QueueSettingsOverride;
  /**
   * Write queue override fields; undefined fields are left untouched.
   * @param partial - override fields to set.
   * @param expectedRevision - revision the caller read; a moved section is refused.
   * @returns the write outcome.
   */
  setQueue(partial: QueueSettingsOverride, expectedRevision?: number): Promise<VisibilityWriteResult>;
  /**
   * Drop the queue override, re-inheriting the cordis composition base.
   * @param expectedRevision - revision the caller read; a moved section is refused.
   * @returns the write outcome.
   */
  resetQueue(expectedRevision?: number): Promise<VisibilityWriteResult>;
  /**
   * Drop both tables, re-inheriting the composition base and schema defaults.
   * @returns the write outcome.
   */
  resetAll(): Promise<VisibilityWriteResult>;
  /** Release the handle; idempotent, and every later write fails. */
  dispose(): void;
}

/**
 * Structural subset of the Cordis context the adapter needs: optional-dependency
 * injection plus effect scoping. Keeping it structural avoids a dependency on
 * `@deepseek-ai/dsh-settings` and lets tests drive the seam with a stub.
 */
export interface SettingsContextLike {
  /**
   * Run `callback` once every named service is available, and again whenever
   * one re-attaches.
   * @param deps - required service names.
   * @param callback - receives the dependency-injected context.
   */
  inject(deps: string[], callback: (ctx: unknown) => void): void;
  /**
   * Scope a teardown to the owning context.
   * @param cb - returns the disposer to run on unload.
   * @param label - diagnostic label.
   */
  effect?(cb: () => (() => void) | void, label?: string): void;
}

/** Options for {@link installVisibilitySettings}. */
export interface InstallOptions {
  /** Section namespace; defaults to {@link VISIBILITY_SETTINGS_NS}. */
  namespace?: string;
  /** Composition presets, normalized and retained for visibility surfaces. */
  patterns?: readonly string[];
  /** Composition-layer fallback entry, also used while no provider is attached. */
  base?: VisibilitySettings;
  /**
   * Called after every committed change with a detached snapshot of the next
   * switches, including the attach and detach transitions.
   * @param next - the authoritative switches after the change.
   */
  onChange?: (next: VisibilitySettings) => void;
}

/** User-layer override of the global queue budget; every field is optional. */
export interface QueueSettingsOverride {
  /** Single wait budget in ms; undefined inherits the cordis composition base. */
  maxWaitMs?: number | undefined;
  /** Queue depth cap; undefined inherits the cordis composition base. */
  maxQueueDepth?: number | undefined;
  /** Default per-provider concurrency (`0` = unlimited); undefined inherits the base. */
  defaultConcurrency?: number | undefined;
  /** Provider-specific entries (`0` = unlimited); undefined inherits the base table. */
  perProviderConcurrency?: Record<string, number> | undefined;
}

/** Section schema: both tables default to empty, i.e. everything visible. */
export const VisibilitySettingsSchema = z.object({
  providers: z.dict(z.boolean()).default({}),
  models: z.dict(z.boolean()).default({}),
  queue: z.object({
    maxWaitMs: z.number().min(0),
    maxQueueDepth: z.number().step(1).min(1),
    defaultConcurrency: z.number().step(1).min(0),
    perProviderConcurrency: z.dict(z.number().step(1).min(0)),
  }),
});

/** One registered namespace as described by the settings provider. */
interface SettingsDescriptorLike {
  ns?: unknown;
  revision?: unknown;
  value?: unknown;
}

/** Hooks a consumer hands to `settings.installSection`. */
interface SettingsSectionHooksLike {
  setSource(current: unknown): void;
  onChange(): void;
  validate?(value: unknown): void;
}

/** Structural subset of `ctx.settings` this adapter uses. */
interface SettingsProviderLike {
  installSection(owner: unknown, ns: string, schema: unknown, entry: unknown, hooks: SettingsSectionHooksLike): void;
  describe(options?: { redactSecrets?: boolean }): readonly SettingsDescriptorLike[];
  mutate(ns: string, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void>;
}

/** A handle that additionally exposes the composition presets it was given. */
export interface VisibilitySettingsHandleWithPatterns extends VisibilitySettingsHandle {
  /** Normalized composition presets, in declaration order. */
  patterns(): readonly string[];
}

/** Copy one table, keeping only boolean entries; a missing or bad table is empty. */
function copyTable(table: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (typeof table !== 'object' || table === null) return out;
  for (const [key, value] of Object.entries(table as Record<string, unknown>)) {
    if (typeof value === 'boolean') out[key] = value;
  }
  return out;
}

/** Detach the queue override slice of a resolved section value. */
function detachQueue(value: unknown): QueueSettingsOverride {
  const record = (typeof value === 'object' && value !== null ? value : {}) as { queue?: unknown };
  const queue = (typeof record.queue === 'object' && record.queue !== null ? record.queue : {}) as Record<string, unknown>;
  const out: QueueSettingsOverride = {};
  if (typeof queue['maxWaitMs'] === 'number' && Number.isFinite(queue['maxWaitMs']) && (queue['maxWaitMs'] as number) >= 0) {
    out.maxWaitMs = queue['maxWaitMs'] as number;
  }
  if (typeof queue['maxQueueDepth'] === 'number' && Number.isFinite(queue['maxQueueDepth']) && (queue['maxQueueDepth'] as number) >= 1) {
    out.maxQueueDepth = Math.floor(queue['maxQueueDepth'] as number);
  }
  if (typeof queue['defaultConcurrency'] === 'number' && Number.isFinite(queue['defaultConcurrency']) && (queue['defaultConcurrency'] as number) >= 0) {
    out.defaultConcurrency = Math.floor(queue['defaultConcurrency'] as number);
  }
  const table = queue['perProviderConcurrency'];
  if (typeof table === 'object' && table !== null) {
    const entries: Record<string, number> = {};
    for (const [key, value] of Object.entries(table as Record<string, unknown>)) {
      if (key.length === 0 || typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue;
      entries[key] = Math.floor(value);
    }
    if (Object.keys(entries).length > 0) out.perProviderConcurrency = entries;
  }
  return out;
}

/** Detach a resolved section into a fresh, deeply independent settings object. */
function detach(value: unknown): VisibilitySettings {
  const record = (typeof value === 'object' && value !== null ? value : {}) as { providers?: unknown; models?: unknown };
  return { providers: copyTable(record.providers), models: copyTable(record.models) };
}

/** Render an unknown rejection as a message. */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Read the machine code off an unknown rejection. */
function errorCode(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return undefined;
  return (error as { code?: unknown }).code;
}

/**
 * Install the visibility settings section on an optional settings provider.
 *
 * The handle is usable immediately and stays usable when no provider is ever
 * attached; `read()` then answers from `options.base` and every write fails
 * with `SETTINGS_ERROR`. With a provider present the section is registered
 * under `options.namespace`, `setSource` supplies the authoritative value, and
 * `onChange` refreshes the revision before notifying `options.onChange`.
 *
 * @param ctx - plugin context owning the registration and its teardown.
 * @param options - namespace, composition presets, base entry, and change sink.
 * @returns the handle; at runtime it also implements
 * {@link VisibilitySettingsHandleWithPatterns} for the composition presets.
 */
export function installVisibilitySettings(
  ctx: SettingsContextLike,
  options: InstallOptions = {},
): VisibilitySettingsHandle {
  const namespace = options.namespace ?? VISIBILITY_SETTINGS_NS;
  const base = detach(options.base);
  const patterns = (options.patterns ?? []).map((pattern) => normalizePattern(pattern));

  let settingsProvider: SettingsProviderLike | undefined;
  let source: () => unknown = () => base;
  let revision: number | undefined;
  let disposed = false;

  /** Seed or refresh the revision from the provider's own descriptor. */
  function refreshRevision(target: SettingsProviderLike | undefined): void {
    if (target === undefined) return;
    try {
      const descriptor = target.describe().find((entry) => entry.ns === namespace);
      if (descriptor !== undefined && typeof descriptor.revision === 'number') revision = descriptor.revision;
    } catch {
      // A provider that cannot describe itself keeps the last observed revision.
    }
  }

  function read(): VisibilitySettings {
    if (disposed) return detach(base);
    try {
      return detach(source());
    } catch {
      return detach(base);
    }
  }

  function readQueue(): QueueSettingsOverride {
    if (disposed) return {};
    try {
      return detachQueue(source());
    } catch {
      return {};
    }
  }

  async function write(ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<VisibilityWriteResult> {
    if (disposed) return { ok: false, code: 'SETTINGS_ERROR', message: DISPOSED_MESSAGE };
    const target = settingsProvider;
    if (target === undefined) return { ok: false, code: 'SETTINGS_ERROR', message: UNAVAILABLE_MESSAGE };
    try {
      await target.mutate(namespace, ops, expectedRevision);
    } catch (error) {
      return {
        ok: false,
        code: errorCode(error) === 'SETTINGS_CONFLICT' ? 'SETTINGS_CONFLICT' : 'SETTINGS_ERROR',
        message: errorMessage(error),
      };
    }
    refreshRevision(target);
    return revision === undefined ? { ok: true } : { ok: true, revision };
  }

  /** Attach one provider: register the section and adopt its value source. */
  function attach(target: SettingsProviderLike): void {
    target.installSection(ctx, namespace, VisibilitySettingsSchema, base, {
      setSource(current: unknown) {
        source = typeof current === 'function' ? (current as () => unknown) : () => current;
      },
      onChange() {
        refreshRevision(settingsProvider);
        options.onChange?.(read());
      },
    });
    settingsProvider = target;
    refreshRevision(target);
  }

  ctx.inject(['settings'], (settingsCtx) => {
    const target = (settingsCtx as { settings?: SettingsProviderLike } | null | undefined)?.settings;
    if (target === undefined) return;
    attach(target);
  });

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    settingsProvider = undefined;
    source = () => base;
  }

  ctx.effect?.(() => () => {
    dispose();
  }, 'llm-ctl: dispose visibility settings handle');

  const handle: VisibilitySettingsHandleWithPatterns = {
    read,
    revision: () => (disposed ? undefined : revision),
    write,
    setProvider: (provider: string, visible: boolean) =>
      write([{ op: 'set', path: ['providers', provider], value: visible }]),
    setModel: (provider: string, model: string, visible: boolean) =>
      write([{ op: 'set', path: ['models', modelKey(provider, model)], value: visible }]),
    queue: readQueue,
    setQueue: (partial: QueueSettingsOverride, expectedRevision?: number) => {
      const ops: SettingsPathOp[] = [];
      if (partial.maxWaitMs !== undefined) ops.push({ op: 'set', path: ['queue', 'maxWaitMs'], value: partial.maxWaitMs });
      if (partial.maxQueueDepth !== undefined) ops.push({ op: 'set', path: ['queue', 'maxQueueDepth'], value: partial.maxQueueDepth });
      if (partial.defaultConcurrency !== undefined) ops.push({ op: 'set', path: ['queue', 'defaultConcurrency'], value: partial.defaultConcurrency });
      if (partial.perProviderConcurrency !== undefined) ops.push({ op: 'set', path: ['queue', 'perProviderConcurrency'], value: partial.perProviderConcurrency });
      if (ops.length === 0) return Promise.resolve({ ok: true });
      return write(ops, expectedRevision);
    },
    resetQueue: (expectedRevision?: number) => write([{ op: 'unset', path: ['queue'] }], expectedRevision),
    resetAll: () => write([{ op: 'unset', path: ['providers'] }, { op: 'unset', path: ['models'] }]),
    dispose,
    patterns: () => [...patterns],
  };
  return handle;
}
