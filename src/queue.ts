/**
 * Per-provider admission queue: concurrency cap, arrival-order FIFO, and the
 * provider cooldown clock that follows a rate-limit failure.
 *
 * The gate is deliberately transport-free: it never touches a stream, only
 * decides when a request may be dispatched. Clock and timers are injectable so
 * the whole scheduler is testable without real time.
 *
 * @module dsh-llm-ctl/queue
 */
import type { CtlEvent, CtlEventKind, Origin } from './events.ts';

/** Why an admission request did not get a slot. */
export type AcquireFailureCode = 'QUEUE_FULL' | 'QUEUE_TIMEOUT' | 'ABORTED';

/** Successful admission: the caller must invoke `release` exactly once. */
export interface AcquireGranted {
  ok: true;
  queueId: string;
  provider: string;
  origin: Origin;
  waitMs: number;
  release: () => void;
}

/** Refused admission. */
export interface AcquireRefused {
  ok: false;
  code: AcquireFailureCode;
  provider: string;
  origin: Origin;
  waitMs: number;
  reason: string;
  queueId?: string;
}

/** Result of one admission attempt. */
export type AcquireOutcome = AcquireGranted | AcquireRefused;

/** Minimal clock and timer seam, so tests can drive time deterministically. */
export interface Scheduler {
  now(): number;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
}

/** Production scheduler backed by the global timers. */
export const realScheduler: Scheduler = {
  now: () => Date.now(),
  setTimer: (callback, delayMs) => setTimeout(callback, Math.max(0, delayMs)),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface Waiter {
  id: string;
  provider: string;
  origin: Origin;
  enqueuedAt: number;
  settled: boolean;
  deadline: unknown;
  resolve: (outcome: AcquireOutcome) => void;
  detachAbort: () => void;
  settle: (outcome: AcquireOutcome) => void;
}

interface Lane {
  active: number;
  waiters: Waiter[];
  cooldownUntil: number;
  cooldownTimer: unknown;
  /** EWMA of observed request durations, used for queue ETA estimates. */
  averageDurationMs: number;
}

/** One queued request as reported to the UI. */
export interface QueueWaiterView {
  queueId: string;
  provider: string;
  origin: Origin;
  position: number;
  waitedMs: number;
  etaMs: number;
}

/** Current control-plane state. */
export interface GateSnapshot {
  at: number;
  lanes: Array<{
    provider: string;
    active: number;
    /** Effective cap; `0` means unlimited. */
    concurrency: number;
    queued: number;
    cooldownRemainingMs: number;
    averageDurationMs: number;
  }>;
  waiters: QueueWaiterView[];
}

/** Construction options for {@link ProviderGate}. */
export interface GateOptions {
  scheduler?: Scheduler;
  concurrencyFor: (provider: string) => number;
  maxQueueDepth: number;
  maxWaitMs: number;
  /** Emit one observable fact. */
  onEvent?: (kind: CtlEventKind, detail: Omit<CtlEvent, 'seq' | 'at' | 'kind'>) => void;
  idFactory?: () => string;
}

/** Admission gate over all provider routes. */
export class ProviderGate {
  private readonly scheduler: Scheduler;
  private readonly concurrencyFor: (provider: string) => number;
  private maxQueueDepth: number;
  private maxWaitMs: number;
  private readonly onEvent: GateOptions['onEvent'];
  private readonly idFactory: () => string;
  private readonly lanes = new Map<string, Lane>();
  private disposed = false;
  private counter = 0;

  constructor(options: GateOptions) {
    this.scheduler = options.scheduler ?? realScheduler;
    this.concurrencyFor = options.concurrencyFor;
    this.maxQueueDepth = Math.max(1, options.maxQueueDepth);
    this.maxWaitMs = Math.max(0, options.maxWaitMs);
    this.onEvent = options.onEvent;
    this.idFactory = options.idFactory ?? (() => `q${(this.counter += 1)}`);
  }

  private lane(provider: string): Lane {
    let lane = this.lanes.get(provider);
    if (lane === undefined) {
      lane = { active: 0, waiters: [], cooldownUntil: 0, cooldownTimer: undefined, averageDurationMs: 1_000 };
      this.lanes.set(provider, lane);
    }
    return lane;
  }

  private emit(kind: CtlEventKind, detail: Omit<CtlEvent, 'seq' | 'at' | 'kind'>): void {
    this.onEvent?.(kind, detail);
  }

  private grant(provider: string, lane: Lane, origin: Origin, queueId: string, waitMs: number): AcquireGranted {
    const grantedAt = this.scheduler.now();
    lane.active += 1;
    this.emit('granted', { provider, origin, queueId, waitMs, position: 0 });
    return {
      ok: true,
      queueId,
      provider,
      origin,
      waitMs,
      release: () => this.release(provider, this.scheduler.now() - grantedAt),
    };
  }

  /** Refuse immediately when the provider cannot serve inside the budget. */
  private preflightRefusal(lane: Lane, provider: string, origin: Origin, now: number): AcquireRefused | undefined {
    const cooldownRemaining = lane.cooldownUntil - now;
    if (cooldownRemaining > this.maxWaitMs) {
      this.emit('queue-timeout', { provider, origin, reason: 'cooldown-exceeds-budget', delayMs: cooldownRemaining });
      return { ok: false, code: 'QUEUE_TIMEOUT', provider, origin, waitMs: 0, reason: 'cooldown-exceeds-budget' };
    }
    if (lane.waiters.length >= this.maxQueueDepth) {
      this.emit('queue-full', { provider, origin, reason: 'max-queue-depth', position: lane.waiters.length });
      return { ok: false, code: 'QUEUE_FULL', provider, origin, waitMs: 0, reason: 'max-queue-depth' };
    }
    return undefined;
  }

  /** Request admission; resolves once a slot is granted or refused. */
  acquire(provider: string, options: { origin: Origin; signal?: AbortSignal | undefined }): Promise<AcquireOutcome> {
    const { origin, signal } = options;
    if (this.disposed) {
      return Promise.resolve({ ok: false, code: 'ABORTED', provider, origin, waitMs: 0, reason: 'disposed' });
    }
    const lane = this.lane(provider);
    const now = this.scheduler.now();

    if (lane.active < this.concurrencyFor(provider) && lane.waiters.length === 0 && now >= lane.cooldownUntil) {
      const queueId = this.idFactory();
      return Promise.resolve(this.grant(provider, lane, origin, queueId, 0));
    }

    const refused = this.preflightRefusal(lane, provider, origin, now);
    if (refused !== undefined) return Promise.resolve(refused);

    return new Promise<AcquireOutcome>((resolve) => {
      const waiter: Waiter = {
        id: this.idFactory(),
        provider,
        origin,
        enqueuedAt: now,
        settled: false,
        deadline: undefined,
        resolve,
        detachAbort: () => undefined,
        settle: () => undefined,
      };
      const settle = (outcome: AcquireOutcome): void => {
        if (waiter.settled) return;
        waiter.settled = true;
        this.scheduler.clearTimer(waiter.deadline);
        waiter.detachAbort();
        const index = lane.waiters.indexOf(waiter);
        if (index >= 0) lane.waiters.splice(index, 1);
        resolve(outcome);
      };
      waiter.settle = settle;
      waiter.deadline = this.scheduler.setTimer(() => {
        const waitedMs = this.scheduler.now() - waiter.enqueuedAt;
        this.emit('queue-timeout', { provider, origin, queueId: waiter.id, reason: 'max-wait', waitMs: waitedMs });
        settle({ ok: false, code: 'QUEUE_TIMEOUT', provider, origin, waitMs: waitedMs, reason: 'max-wait', queueId: waiter.id });
      }, this.maxWaitMs);

      if (signal !== undefined) {
        if (signal.aborted) {
          settle({ ok: false, code: 'ABORTED', provider, origin, waitMs: 0, reason: 'aborted', queueId: waiter.id });
          return;
        }
        const onAbort = (): void => {
          settle({
            ok: false,
            code: 'ABORTED',
            provider,
            origin,
            waitMs: this.scheduler.now() - waiter.enqueuedAt,
            reason: 'aborted',
            queueId: waiter.id,
          });
        };
        signal.addEventListener('abort', onAbort, { once: true });
        waiter.detachAbort = () => signal.removeEventListener('abort', onAbort);
      }

      lane.waiters.push(waiter);
      this.emit('queued', {
        provider,
        origin,
        queueId: waiter.id,
        position: lane.waiters.length,
        waitMs: 0,
        delayMs: Math.max(0, lane.cooldownUntil - now),
      });
      this.armCooldown(provider, lane);
    });
  }

  /**
   * Replace the global wait budget and depth cap at runtime.
   *
   * Only admissions started after the call observe the new values: waiters
   * already queued keep the deadline timer armed at acquire time.
   *
   * @param limits - partial limits; each defined field replaces the current one.
   */
  updateLimits(limits: { maxWaitMs?: number; maxQueueDepth?: number }): void {
    if (limits.maxWaitMs !== undefined) this.maxWaitMs = Math.max(0, limits.maxWaitMs);
    if (limits.maxQueueDepth !== undefined) this.maxQueueDepth = Math.max(1, limits.maxQueueDepth);
  }

  /** Return a slot granted by {@link acquire}. */
  release(provider: string, durationMs?: number): void {
    const lane = this.lanes.get(provider);
    if (lane === undefined) return;
    if (lane.active > 0) lane.active -= 1;
    if (durationMs !== undefined && Number.isFinite(durationMs) && durationMs >= 0) {
      lane.averageDurationMs = lane.averageDurationMs * 0.7 + durationMs * 0.3;
    }
    this.emit('released', { provider, position: lane.active });
    this.pump(provider);
  }

  /**
   * Push the provider's cooldown to at least `now + delayMs`.
   *
   * A cooldown longer than the wait budget fails every current waiter at once:
   * none of them could be served before its own deadline, so waiting would only
   * spend the user's time to produce the same failure.
   */
  registerCooldown(provider: string, delayMs: number, reason: string, source?: string): void {
    if (!Number.isFinite(delayMs) || delayMs <= 0) return;
    const lane = this.lane(provider);
    const now = this.scheduler.now();
    const until = now + delayMs;
    if (until <= lane.cooldownUntil) return;
    lane.cooldownUntil = until;
    this.emit('cooldown', { provider, delayMs, reason, ...(source === undefined ? {} : { source }) });
    if (delayMs > this.maxWaitMs) {
      for (const waiter of [...lane.waiters]) {
        waiter.settle({
          ok: false,
          code: 'QUEUE_TIMEOUT',
          provider,
          origin: waiter.origin,
          waitMs: now - waiter.enqueuedAt,
          reason: 'cooldown-exceeds-budget',
          queueId: waiter.id,
        });
        this.emit('queue-timeout', {
          provider,
          origin: waiter.origin,
          queueId: waiter.id,
          reason: 'cooldown-exceeds-budget',
          delayMs,
        });
      }
      return;
    }
    this.armCooldown(provider, lane);
  }

  /** Cancel one still-queued request. */
  cancel(queueId: string): boolean {
    for (const lane of this.lanes.values()) {
      const waiter = lane.waiters.find((candidate) => candidate.id === queueId);
      if (waiter === undefined) continue;
      waiter.settle({
        ok: false,
        code: 'ABORTED',
        provider: waiter.provider,
        origin: waiter.origin,
        waitMs: this.scheduler.now() - waiter.enqueuedAt,
        reason: 'cancelled',
        queueId: waiter.id,
      });
      this.emit('cancelled', { provider: waiter.provider, origin: waiter.origin, queueId: waiter.id, reason: 'user' });
      return true;
    }
    return false;
  }

  /** Current lanes and waiters, ordered by provider then arrival. */
  snapshot(): GateSnapshot {
    const now = this.scheduler.now();
    const lanes: GateSnapshot['lanes'] = [];
    const waiters: QueueWaiterView[] = [];
    for (const [provider, lane] of this.lanes) {
      const limit = this.concurrencyFor(provider);
      // The wire value stays JSON-safe: Infinity would serialize to null.
      const concurrency = Number.isFinite(limit) ? Math.max(1, limit) : 0;
      lanes.push({
        provider,
        active: lane.active,
        concurrency,
        queued: lane.waiters.length,
        cooldownRemainingMs: Math.max(0, lane.cooldownUntil - now),
        averageDurationMs: lane.averageDurationMs,
      });
      lane.waiters.forEach((waiter, index) => {
        waiters.push({
          queueId: waiter.id,
          provider,
          origin: waiter.origin,
          position: index + 1,
          waitedMs: now - waiter.enqueuedAt,
          // index 之前还有 lane.active 个正在跑的请求占着并发槽；
          // (index + active) / limit 算出还要排空几波（不限流时只剩冷却）。
          etaMs: Math.max(0, lane.cooldownUntil - now) + Math.floor((index + lane.active) / limit) * lane.averageDurationMs,
        });
      });
    }
    return { at: now, lanes, waiters };
  }

  /** Fail every waiter and stop all timers. */
  dispose(): void {
    this.disposed = true;
    const now = this.scheduler.now();
    for (const lane of this.lanes.values()) {
      this.scheduler.clearTimer(lane.cooldownTimer);
      lane.cooldownTimer = undefined;
      for (const waiter of [...lane.waiters]) {
        waiter.settle({
          ok: false,
          code: 'ABORTED',
          provider: waiter.provider,
          origin: waiter.origin,
          waitMs: now - waiter.enqueuedAt,
          reason: 'disposed',
          queueId: waiter.id,
        });
      }
    }
  }

  private armCooldown(provider: string, lane: Lane): void {
    this.scheduler.clearTimer(lane.cooldownTimer);
    lane.cooldownTimer = undefined;
    const remaining = lane.cooldownUntil - this.scheduler.now();
    if (remaining <= 0) {
      this.pump(provider);
      return;
    }
    lane.cooldownTimer = this.scheduler.setTimer(() => {
      lane.cooldownTimer = undefined;
      this.pump(provider);
    }, remaining);
  }

  private pump(provider: string): void {
    const lane = this.lanes.get(provider);
    if (lane === undefined || this.disposed) return;
    const now = this.scheduler.now();
    if (now < lane.cooldownUntil) {
      this.armCooldown(provider, lane);
      return;
    }
    const concurrency = Math.max(1, this.concurrencyFor(provider));
    while (lane.waiters.length > 0 && lane.active < concurrency) {
      const waiter = lane.waiters.shift();
      if (waiter === undefined) break;
      if (waiter.settled) continue;
      waiter.settled = true;
      this.scheduler.clearTimer(waiter.deadline);
      waiter.detachAbort();
      const waitMs = now - waiter.enqueuedAt;
      waiter.resolve(this.grant(provider, lane, waiter.origin, waiter.id, waitMs));
    }
  }
}
