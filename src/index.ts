/**
 * dsh-llm-ctl — rate-limit admission control and standalone request recovery.
 *
 * Two seams, both official:
 *
 * - `llm/stream` (global, prepended): every model call — agent loop and
 *   background tasks alike — waits for a per-provider slot before `next()`
 *   dispatches, so no provider I/O happens while queued and the chunk protocol
 *   is untouched.
 * - `agent/request-error` (global, prepended): the provider cooldown is
 *   registered, then the downstream waterfall decides. When no retry executor
 *   is mounted the plugin spends its own bounded budget so a first 429 does not
 *   end the turn.
 *
 * @module dsh-llm-ctl
 */
import type { Context } from '@deepseek-ai/cordis';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { Config, UNLIMITED_CONCURRENCY, concurrencyFor, resolveConfig, type ConfigInput } from './config.ts';
import { CtlEventLog } from './events.ts';
import { resolveDelay } from './delay.ts';
import { ProviderGate, type Scheduler } from './queue.ts';
import { RetryBudget, WAITABLE_CODES, cancellableDelay, decideReactive } from './reactive.ts';
import { LlmCtlController, type LlmCtlSnapshot } from './controller.ts';
import { createRoutes, type ControlState, type VisibilityWriteOutcome, type WebServerLike } from './routes.ts';
import {
  VISIBILITY_SETTINGS_NS,
  installVisibilitySettings,
  type QueueSettingsOverride,
  type VisibilitySettingsHandle,
} from './visibility-settings.ts';
import { discoverProviderModels, type LlmDiscoveryLike } from './discover.ts';
import { isModelVisible, pickFallback, type CatalogEntry } from './visibility.ts';

/** Cordis plugin name. */
export const name = 'llm-ctl';

/** No service is required; both seams are event listeners. */
export const inject: string[] = [];

export { Config };

/** Non-serializable hooks that make timing deterministic in tests. */
export interface LlmCtlInternals {
  random?: () => number;
  scheduler?: Scheduler;
  now?: () => number;
}

/** Payload of `agent/request-error`, typed structurally to avoid a hard dep. */
interface RequestErrorPayload {
  agent: Agent;
  turn: number;
  step: number;
  provider: string;
  failure: { code: string; message: string; providerRetryAfterMs?: number | undefined };
  signal: AbortSignal;
}

/** Downstream recovery decision of the `agent/request-error` waterfall. */
type RequestErrorAction = { kind: 'retry' } | undefined;

/** Terminal error chunk used to refuse admission without dispatching. */
function refusalChunk(code: string, message: string): StreamChunk {
  return { type: 'finish', reason: { kind: 'error', failure: { code, message } } };
}

/**
 * Install admission control and standalone recovery.
 *
 * @param ctx - plugin context owning both listeners and every pending wait.
 * @param config - queue and recovery configuration.
 * @param internals - deterministic hooks for tests.
 */
export function apply(ctx: Context, config: ConfigInput = {}, internals: LlmCtlInternals = {}): void {
  const resolved = resolveConfig(config);
  const random = internals.random ?? Math.random;
  const now = internals.now;
  const events = new CtlEventLog(200);
  const budget = new RetryBudget();
  const lifetime = new AbortController();
  const active = new Set<Promise<unknown>>();

  const gate = new ProviderGate({
    ...(internals.scheduler === undefined ? {} : { scheduler: internals.scheduler }),
    concurrencyFor: (provider) => concurrencyFor(resolved.queue.perProviderConcurrency, provider),
    maxQueueDepth: resolved.queue.maxQueueDepth,
    maxWaitMs: resolved.queue.maxWaitMs,
    onEvent: (kind, detail) => {
      events.push({ kind, ...detail });
    },
  });

  /** Cordis composition base for the global queue budget; the settings user layer may override it. */
  const baseMaxWaitMs = resolved.queue.maxWaitMs;
  const baseMaxQueueDepth = resolved.queue.maxQueueDepth;
  const basePerProviderConcurrency: Record<string, number> = { ...resolved.queue.perProviderConcurrency };
  const baseDefaultConcurrency = basePerProviderConcurrency['default'] ?? UNLIMITED_CONCURRENCY;

  /** Track one in-flight recovery so disposal can drain it. */
  function track<T>(operation: Promise<T>): Promise<T> {
    const tracked = operation.finally(() => active.delete(tracked));
    active.add(tracked);
    return tracked;
  }

  function resolveFailureDelay(provider: string, failure: { providerRetryAfterMs?: number | undefined }, attempt: number) {
    return resolveDelay({
      providerRetryAfterMs: failure.providerRetryAfterMs,
      attempt,
      backoff: resolved.queue.backoff,
      maxWaitMs: resolved.queue.maxWaitMs,
      honorRetryAfter: resolved.queue.honorRetryAfter,
      random,
      ...(now === undefined ? {} : { now }),
    });
  }

  /** Register the cooldown a terminal failure implies. */
  function observeTerminal(provider: string, origin: 'loop' | 'background', chunk: StreamChunk): void {
    if (chunk.type !== 'finish') return;
    const reason = chunk.reason;
    if (reason.kind !== 'error' && reason.kind !== 'aborted') return;
    const failure = reason.failure;
    if (!WAITABLE_CODES.includes(failure.code)) return;
    const delay = resolveFailureDelay(provider, failure, 1);
    ctx.logger.debug(
      'llm-ctl: provider %s reported %s (%s), cooldown %dms',
      provider,
      failure.code,
      delay.source,
      delay.delayMs,
    );
    gate.registerCooldown(provider, delay.delayMs, 'terminal-failure', delay.source);
  }

  const disposeStream = ctx.on(
    'llm/stream',
    (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => {
      const provider = options.provider;
      const origin = options.purpose === undefined ? 'loop' : 'background';
      const signal = options.signal;
      return (async function* admission(): AsyncIterable<StreamChunk> {
        const outcome = await gate.acquire(provider, { origin, signal });
        if (!outcome.ok) {
          ctx.logger.warn(
            'llm-ctl: refusing %s request for provider %s (%s)',
            origin,
            provider,
            outcome.reason,
          );
          yield refusalChunk(outcome.code, `dsh-llm-ctl: ${outcome.code} for provider "${provider}" (${outcome.reason})`);
          return;
        }
        try {
          for await (const chunk of next()) {
            observeTerminal(provider, origin, chunk);
            yield chunk;
          }
        } finally {
          outcome.release();
        }
      })();
    },
    { global: true, prepend: true },
  );

  /** Standalone recovery: cooldown first, downstream second, own budget last. */
  async function recover(payload: RequestErrorPayload, next: () => Promise<RequestErrorAction>): Promise<RequestErrorAction> {
    const { agent, provider, failure, turn, step, signal } = payload;
    const key = `${agent.session.id}:${provider}:${turn}:${step}`;
    const attempts = budget.attempts(key);
    const delay = resolveFailureDelay(provider, failure, attempts + 1);

    gate.registerCooldown(provider, delay.delayMs, 'request-error', delay.source);

    let delegated = false;
    let downstreamError: unknown;
    try {
      const action = await next();
      delegated = action?.kind === 'retry';
    } catch (error) {
      downstreamError = error;
    }

    if (delegated) {
      events.push({ kind: 'retry-delegated', provider, code: failure.code, reason: 'downstream', attempt: attempts });
      return { kind: 'retry' };
    }

    const decision = decideReactive({
      code: failure.code,
      delegated: false,
      attempts,
      limit: resolved.reactiveRetryLimit,
      delay,
    });
    if (!decision.retry) {
      events.push({
        kind: 'retry-skipped',
        provider,
        code: failure.code,
        reason: decision.reason,
        attempt: attempts,
        delayMs: decision.delayMs,
      });
      if (downstreamError !== undefined) throw downstreamError;
      return undefined;
    }

    budget.record(key);
    const fused = AbortSignal.any([signal, lifetime.signal]);
    events.push({
      kind: 'retry-scheduled',
      provider,
      code: failure.code,
      reason: decision.reason,
      attempt: attempts + 1,
      delayMs: decision.delayMs,
      source: delay.source,
    });
    const waited = await cancellableDelay(decision.delayMs, fused);
    if (!waited || fused.aborted) {
      events.push({ kind: 'retry-skipped', provider, code: failure.code, reason: 'cancelled', attempt: attempts + 1 });
      return undefined;
    }
    return { kind: 'retry' };
  }

  const disposeError = ctx.on(
    'agent/request-error',
    (payload: RequestErrorPayload, next: () => Promise<RequestErrorAction>) => {
      if (lifetime.signal.aborted) return Promise.resolve(undefined);
      return track(recover(payload, next));
    },
    { global: true, prepend: true },
  );

  /** Best-effort handle on the llm service; undefined in compositions without one. */
  function llmService():
    | (LlmDiscoveryLike & {
        listProviders(): Array<{ id: string; name: string }>;
        listModels(provider: string): Promise<Array<{ id: string; name: string }>>;
      })
    | undefined {
    try {
      return ctx.get('llm') as ReturnType<typeof llmService>;
    } catch {
      return undefined;
    }
  }

  /**
   * Late-bound queue-override reader.
   *
   * The settings attach may fire `onChange` synchronously inside
   * `installVisibilitySettings`, i.e. before the handle binding below is
   * assigned; reading the handle directly there would throw a TDZ error.
   */
  let readQueueOverride: () => QueueSettingsOverride = () => ({});
  let visibilityReady = false;

  /** Reconcile the effective queue budget: settings override wins, cordis base is the fallback. */
  function applyQueueOverrides(): void {
    const override = readQueueOverride();
    const nextTable: Record<string, number> = {
      ...basePerProviderConcurrency,
      ...(override.defaultConcurrency === undefined ? {} : { default: override.defaultConcurrency }),
      ...override.perProviderConcurrency,
    };
    const next = {
      maxWaitMs: override.maxWaitMs ?? baseMaxWaitMs,
      maxQueueDepth: override.maxQueueDepth ?? baseMaxQueueDepth,
    };
    const tableBefore = JSON.stringify(resolved.queue.perProviderConcurrency);
    const changed =
      next.maxWaitMs !== resolved.queue.maxWaitMs ||
      next.maxQueueDepth !== resolved.queue.maxQueueDepth ||
      JSON.stringify(nextTable) !== tableBefore;
    resolved.queue.maxWaitMs = next.maxWaitMs;
    resolved.queue.maxQueueDepth = next.maxQueueDepth;
    // The gate's concurrency lookup closes over this table object, so replacing
    // it takes effect for every admission decided after this call.
    resolved.queue.perProviderConcurrency = nextTable;
    gate.updateLimits(next);
    if (changed) events.push({ kind: 'queue-config-changed', provider: '*', reason: 'settings' });
  }

  const controlState = (): ControlState => ({
    at: Date.now(),
    queue: gate.snapshot(),
    events: events.list(100),
    reactive: { mode: resolved.reactiveRetryMode, limit: resolved.reactiveRetryLimit },
    queueConfig: (() => {
      const override = visibility.queue();
      const { default: _default, ...perProvider } = resolved.queue.perProviderConcurrency;
      void _default;
      return {
        maxWaitMs: resolved.queue.maxWaitMs,
        maxQueueDepth: resolved.queue.maxQueueDepth,
        defaultConcurrency: resolved.queue.perProviderConcurrency['default'] ?? UNLIMITED_CONCURRENCY,
        perProviderConcurrency: perProvider,
        defaults: { maxWaitMs: baseMaxWaitMs, maxQueueDepth: baseMaxQueueDepth, defaultConcurrency: baseDefaultConcurrency },
        overridden:
          override.maxWaitMs !== undefined ||
          override.maxQueueDepth !== undefined ||
          override.defaultConcurrency !== undefined ||
          override.perProviderConcurrency !== undefined,
        revision: visibility.revision() ?? 0,
      };
    })(),
    visibility: {
      settings: visibility.read(),
      patterns: resolved.hiddenPatterns,
      configurableProviders: (() => {
        try {
          return llmService()?.listConfigurableProviders() ?? [];
        } catch {
          return [];
        }
      })(),
    },
  });

  // ── model visibility ───────────────────────────────────────────────────────
  const visibility: VisibilitySettingsHandle = installVisibilitySettings(ctx as unknown as Parameters<typeof installVisibilitySettings>[0], {
    namespace: VISIBILITY_SETTINGS_NS,
    patterns: resolved.hiddenPatterns,
    onChange: () => {
      events.push({ kind: 'visibility-changed', provider: '*', reason: 'settings' });
      // Attach may fire synchronously inside installVisibilitySettings, before
      // the handle binding below is assigned; the explicit calls after install
      // cover that first transition.
      if (!visibilityReady) return;
      applyQueueOverrides();
      void reconcileDefaultModel();
    },
  });
  readQueueOverride = () => visibility.queue();
  visibilityReady = true;
  applyQueueOverrides();
  void reconcileDefaultModel();

  /** Enumerate the advisory catalog for fallback selection. */
  async function collectCatalog(): Promise<Array<CatalogEntry & { name: string }>> {
    const llm = ctx.get('llm') as
      | {
          listProviders(): Array<{ id: string; name: string }>;
          listModels(provider: string): Promise<Array<{ id: string; name: string }>>;
        }
      | undefined;
    if (llm === undefined) return [];
    const out: Array<CatalogEntry & { name: string }> = [];
    for (const provider of llm.listProviders()) {
      try {
        for (const model of await llm.listModels(provider.id)) {
          out.push({ provider: provider.id, model: model.id, name: model.name });
        }
      } catch {
        // Advisory catalog only; an unreachable provider simply contributes none.
      }
    }
    return out;
  }

  /**
   * Move the default selection off a hidden model so fresh sessions stay usable.
   * The catalog default is exactly what new agents read, so this is the one place
   * a visibility switch can strand them.
   */
  async function reconcileDefaultModel(): Promise<void> {
    const service = ctx.get('agentDefaultModel') as
      | {
          currentSelection(): { provider: string; model: string; reasoningEffort?: string };
          saveSelection(next: { provider: string; model: string; reasoningEffort?: string }): Promise<void>;
        }
      | undefined;
    if (service === undefined) return;
    const current = service.currentSelection();
    const settings = visibility.read();
    const config = { hiddenPatterns: resolved.hiddenPatterns };
    if (isModelVisible(current.provider, current.model, settings, config)) return;
    const fallback = pickFallback(current, await collectCatalog(), settings, config);
    if (fallback === undefined) {
      events.push({
        kind: 'default-model-hidden',
        provider: current.provider,
        code: 'MODEL_HIDDEN',
        reason: 'no-visible-fallback',
      });
      return;
    }
    try {
      await service.saveSelection({ provider: fallback.provider, model: fallback.model });
      events.push({
        kind: 'default-model-fallback',
        provider: fallback.provider,
        code: 'MODEL_HIDDEN',
        reason: `${current.provider}:${current.model}`,
      });
    } catch (error) {
      ctx.logger.warn('llm-ctl: default model fallback failed: %o', error);
    }
  }

  const controller = new LlmCtlController(ctx, {
    snapshot: (): LlmCtlSnapshot => controlState(),
    cancel: (queueId) => gate.cancel(queueId),
  });
  void controller;

  // The browser half talks HTTP: a third-party Typert namespace is not reachable
  // from the generated client proxy. The route seat exists only in web profiles,
  // so the injection is optional and the plugin stays loadable headless.
  ctx.inject(['webServer'], (webCtx) => {
    const server = (webCtx as unknown as { webServer: WebServerLike }).webServer;
    const adapt = (result: Awaited<ReturnType<VisibilitySettingsHandle['setProvider']>>): VisibilityWriteOutcome => ({
      ok: result.ok,
      ...(result.code === undefined ? {} : { code: result.code }),
      ...(result.message === undefined ? {} : { message: result.message }),
      ...(result.revision === undefined ? {} : { revision: result.revision }),
    });
    const disposers = createRoutes({
      state: controlState,
      cancel: (queueId) => gate.cancel(queueId),
      setVisibility: async (input) =>
        adapt(input.model === undefined ? await visibility.setProvider(input.provider, input.visible) : await visibility.setModel(input.provider, input.model, input.visible)),
      resetVisibility: async () => adapt(await visibility.resetAll()),
      setQueue: async (input) => adapt(await visibility.setQueue(input, input.expectedRevision)),
      resetQueue: async (input) => adapt(await visibility.resetQueue(input.expectedRevision)),
      discover: async (input) => {
        const llm = llmService();
        let advertised: string[] = [];
        if (llm !== undefined) {
          try {
            advertised = (await llm.listModels(input.provider)).map((model) => model.id);
          } catch {
            advertised = [];
          }
        }
        return discoverProviderModels(
          {
            llm,
            logger: {
              info: (first: unknown, ...rest: Array<unknown>): void => {
                ctx.logger.info(first, ...rest);
              },
              warn: (first: unknown, ...rest: Array<unknown>): void => {
                ctx.logger.warn(first, ...rest);
              },
            },
          },
          { provider: input.provider, baseURL: input.baseURL, api: input.api, advertised },
        );
      },
    }).map((route) => server.register(route));
    webCtx.effect(() => () => {
      for (const dispose of disposers) dispose();
    }, 'llm-ctl: unregister control routes');
  });

  ctx.effect(
    () => async () => {
      disposeStream();
      disposeError();
      lifetime.abort(new Error('dsh-llm-ctl disposed'));
      visibility.dispose();
      gate.dispose();
      await Promise.allSettled([...active]);
    },
    'llm-ctl: abort and drain queue and recovery',
  );

  ctx.logger.info(
    'llm-ctl: queue maxWaitMs=%d maxQueueDepth=%d reactiveRetry=%s',
    resolved.queue.maxWaitMs,
    resolved.queue.maxQueueDepth,
    String(resolved.reactiveRetryMode),
  );
}