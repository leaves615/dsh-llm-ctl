/**
 * Deterministic clock and timer queue for gate tests.
 *
 * @module dsh-llm-ctl/test/fake-scheduler
 */
import type { Scheduler } from '../src/queue.js';

interface FakeTimer {
  id: number;
  at: number;
  callback: () => void;
}

/** A scheduler whose time only moves when a test advances it. */
export class FakeScheduler implements Scheduler {
  private time: number;
  private seq = 0;
  private timers: FakeTimer[] = [];

  constructor(start = 0) {
    this.time = start;
  }

  now(): number {
    return this.time;
  }

  setTimer(callback: () => void, delayMs: number): unknown {
    const id = (this.seq += 1);
    this.timers.push({ id, at: this.time + Math.max(0, delayMs), callback });
    return id;
  }

  clearTimer(handle: unknown): void {
    this.timers = this.timers.filter((timer) => timer.id !== handle);
  }

  /** Advance time, firing every timer that becomes due in order. */
  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    for (;;) {
      const due = this.timers.filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (due === undefined) break;
      this.timers = this.timers.filter((timer) => timer.id !== due.id);
      this.time = due.at;
      due.callback();
      await Promise.resolve();
    }
    this.time = target;
    await Promise.resolve();
  }

  /** Timers still armed, for leak assertions. */
  get pending(): number {
    return this.timers.length;
  }
}

/** Let pending microtasks settle. */
export async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}
