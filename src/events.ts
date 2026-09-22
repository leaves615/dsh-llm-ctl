/**
 * In-memory observability for queue and recovery decisions.
 *
 * Deliberately not written to the session log: `Session.append()` exposes no way
 * to mark an out-of-repo event type `ignorable`, and an unmarked unknown type
 * makes the persistence read path refuse to reconstruct the session. Queue
 * state is process-local anyway — a crash loses the in-flight request too.
 *
 * @module dsh-llm-ctl/events
 */

/** Where a queued request came from. */
export type Origin = 'loop' | 'background';

/** One observable control-plane fact. */
export type CtlEventKind =
  | 'queued'
  | 'granted'
  | 'released'
  | 'cooldown'
  | 'queue-timeout'
  | 'queue-full'
  | 'cancelled'
  | 'retry-scheduled'
  | 'retry-skipped'
  | 'retry-delegated'
  | 'visibility-changed'
  | 'queue-config-changed'
  | 'default-model-fallback'
  | 'default-model-hidden';

/** One recorded fact with its assigned sequence and timestamp. */
export interface CtlEvent {
  seq: number;
  at: number;
  kind: CtlEventKind;
  provider: string;
  queueId?: string;
  origin?: Origin;
  position?: number;
  waitMs?: number;
  delayMs?: number;
  code?: string;
  reason?: string;
  attempt?: number;
  source?: string;
}

/** Bounded ring of recent facts, newest last. */
export class CtlEventLog {
  private readonly capacity: number;
  private readonly entries: CtlEvent[] = [];
  private seq = 0;

  constructor(capacity = 200) {
    this.capacity = Math.max(1, capacity);
  }

  /** Append one fact, dropping the oldest when the ring is full. */
  push(fact: Omit<CtlEvent, 'seq' | 'at'> & { at?: number }): CtlEvent {
    const event: CtlEvent = { seq: (this.seq += 1), at: fact.at ?? Date.now(), ...fact } as CtlEvent;
    this.entries.push(event);
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
    return event;
  }

  /** Recent facts, newest last. */
  list(limit?: number): CtlEvent[] {
    if (limit === undefined || limit >= this.entries.length) return [...this.entries];
    return this.entries.slice(this.entries.length - Math.max(0, limit));
  }

  /** Drop every recorded fact. */
  clear(): void {
    this.entries.length = 0;
  }
}