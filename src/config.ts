/**
 * Plugin configuration schema and normalization.
 *
 * @module dsh-llm-ctl/config
 */
import z from '@deepseek-ai/schemastery';
import type { BackoffConfig } from './delay.ts';

export { UNLIMITED_CONCURRENCY, concurrencyFor } from './concurrency.ts';
/** Single wait budget covering both queue patience and honored cooldown. */
export const DEFAULT_MAX_WAIT_MS = 120_000;
/** Default bounded budget for standalone recovery when no retry executor is mounted. */
export const DEFAULT_REACTIVE_RETRIES = 3;

/** Local backoff used when a provider supplies no hint. */
export const BackoffConfigSchema = z.object({
  initialDelayMs: z.number().min(0).default(500),
  maxDelayMs: z.number().min(0).default(10_000),
  jitterRatio: z.number().min(0).max(1).default(0.1),
});

/** Admission queue configuration. */
export const QueueConfigSchema = z.object({
  /**
   * Per-provider concurrency. The reserved key `default` applies to every
   * provider without an explicit entry; free routes fall back to 1.
   */
  perProviderConcurrency: z.dict(z.number().step(1).min(0)).default({}),
  maxQueueDepth: z.number().step(1).min(1).default(50),
  maxWaitMs: z.number().min(0).default(DEFAULT_MAX_WAIT_MS),
  honorRetryAfter: z.boolean().default(true),
  backoff: BackoffConfigSchema,
});

/** Visibility presets owned by the composition, not by the user layer. */
export const VisibilityConfigSchema = z.object({
  /** Read-only glob patterns; only \`*\` is a metacharacter. */
  hiddenPatterns: z.array(z.string()).default([]),
});

/** Whole-plugin configuration. */
export const Config = z.object({
  queue: QueueConfigSchema,
  visibility: VisibilityConfigSchema,
  /**
   * Standalone recovery budget. `auto` engages only when the
   * `agent/request-error` waterfall reaches no downstream retry decision;
   * `off` never retries; a number caps retries per step.
   */
  reactiveRetry: z.union(['auto', 'off', z.number().step(1).min(0)]).default('auto'),
});

/** Normalized configuration used by the runtime. */
export interface ResolvedConfig {
  queue: {
    perProviderConcurrency: Record<string, number>;
    maxQueueDepth: number;
    maxWaitMs: number;
    honorRetryAfter: boolean;
    backoff: BackoffConfig;
  };
  /** `auto` is resolved to a numeric cap; 0 means disabled. */
  reactiveRetryLimit: number;
  reactiveRetryMode: 'auto' | 'off' | number;
  /** Composition-level hide patterns (read-only for the user layer). */
  hiddenPatterns: readonly string[];
}

/** Configuration shape accepted by {@link resolveConfig}. */
export interface ConfigInput {
  queue?: {
    perProviderConcurrency?: Record<string, number>;
    maxQueueDepth?: number;
    maxWaitMs?: number;
    honorRetryAfter?: boolean;
    backoff?: Partial<BackoffConfig>;
  };
  reactiveRetry?: 'auto' | 'off' | number;
  visibility?: { hiddenPatterns?: readonly string[] };
}



/** Normalize raw plugin config, applying every documented default. */
export function resolveConfig(input: ConfigInput | undefined): ResolvedConfig {
  const queue = input?.queue ?? {};
  const backoffInput = queue.backoff ?? {};
  const reactiveRetryMode = input?.reactiveRetry ?? 'auto';
  return {
    queue: {
      perProviderConcurrency: { ...(queue.perProviderConcurrency ?? {}) },
      maxQueueDepth: queue.maxQueueDepth ?? 50,
      maxWaitMs: queue.maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
      honorRetryAfter: queue.honorRetryAfter ?? true,
      backoff: {
        initialDelayMs: backoffInput.initialDelayMs ?? 500,
        maxDelayMs: backoffInput.maxDelayMs ?? 10_000,
        jitterRatio: backoffInput.jitterRatio ?? 0.1,
      },
    },
    reactiveRetryMode,
    hiddenPatterns: [...(input?.visibility?.hiddenPatterns ?? [])],
    reactiveRetryLimit:
      reactiveRetryMode === 'off' ? 0 : reactiveRetryMode === 'auto' ? DEFAULT_REACTIVE_RETRIES : reactiveRetryMode,
  };
}