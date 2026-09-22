/**
 * Standalone request recovery for deployments without `@deepseek-ai/dsh-llm-retry`.
 *
 * The plugin never races the retry executor: it registers the provider cooldown,
 * asks the rest of the `agent/request-error` waterfall for a decision, and only
 * spends its own bounded budget when no downstream listener took the failure.
 *
 * @module dsh-llm-ctl/reactive
 */
import type { DelayResolution } from './delay.ts';

/**
 * Failure codes a queue can meaningfully wait out. Mirrors the default retryable
 * set of `dsh-llm`; quota, auth, and context failures are terminal.
 */
export const WAITABLE_CODES: readonly string[] = ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE'];

/** Why standalone recovery did or did not schedule a retry. */
export type ReactiveReason =
  | 'scheduled'
  | 'downstream-owns'
  | 'code-not-waitable'
  | 'disabled'
  | 'budget-exhausted'
  | 'over-budget';

/** One standalone recovery decision. */
export interface ReactiveDecision {
  retry: boolean;
  delayMs: number;
  reason: ReactiveReason;
}

/** Inputs to {@link decideReactive}. */
export interface ReactiveInput {
  code: string;
  /** True when a downstream listener returned `{kind:'retry'}`. */
  delegated: boolean;
  /** Retries already scheduled for this session/provider/turn/step. */
  attempts: number;
  /** Configured cap; 0 disables standalone recovery. */
  limit: number;
  delay: DelayResolution;
}

/**
 * Decide whether this plugin should schedule the retry itself.
 *
 * A downstream decision always wins; the local budget is the fallback for a
 * deployment that mounts no retry executor at all.
 */
export function decideReactive(input: ReactiveInput): ReactiveDecision {
  if (input.delegated) return { retry: false, delayMs: input.delay.delayMs, reason: 'downstream-owns' };
  if (!WAITABLE_CODES.includes(input.code)) return { retry: false, delayMs: input.delay.delayMs, reason: 'code-not-waitable' };
  if (input.limit <= 0) return { retry: false, delayMs: input.delay.delayMs, reason: 'disabled' };
  if (input.attempts >= input.limit) return { retry: false, delayMs: input.delay.delayMs, reason: 'budget-exhausted' };
  if (input.delay.overBudget) return { retry: false, delayMs: input.delay.delayMs, reason: 'over-budget' };
  return { retry: true, delayMs: input.delay.delayMs, reason: 'scheduled' };
}

/** Bounded per-step retry counters keyed by session, provider, turn, and step. */
export class RetryBudget {
  private readonly counts = new Map<string, number>();
  private readonly maxEntries: number;

  constructor(maxEntries = 500) {
    this.maxEntries = Math.max(1, maxEntries);
  }

  /** Retries already scheduled for this key. */
  attempts(key: string): number {
    return this.counts.get(key) ?? 0;
  }

  /** Record one scheduled retry and return the new count. */
  record(key: string): number {
    const next = this.attempts(key) + 1;
    this.counts.delete(key);
    this.counts.set(key, next);
    while (this.counts.size > this.maxEntries) {
      const oldest = this.counts.keys().next();
      if (oldest.done === true) break;
      this.counts.delete(oldest.value);
    }
    return next;
  }

  /** Forget one key, e.g. after the step completed. */
  forget(key: string): void {
    this.counts.delete(key);
  }

  /** Current entry count, for tests and diagnostics. */
  get size(): number {
    return this.counts.size;
  }
}

/** Abortable delay; resolves false when the wait was cancelled. */
export function cancellableDelay(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  if (delayMs <= 0) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, delayMs);
    function onAbort(): void {
      clearTimeout(timer);
      resolve(false);
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
