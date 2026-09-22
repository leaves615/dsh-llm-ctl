/**
 * Host half of the browser control surface: a Typert Remote namespace that
 * reports queue state and cancels a queued request.
 *
 * The `@Remote` marker is applied programmatically rather than with decorator
 * syntax: the marker is a prototype descriptor, and avoiding decorators keeps
 * the source runnable by Node's type-stripping test runner without a build step.
 *
 * @module dsh-llm-ctl/controller
 */
import type { Context } from '@deepseek-ai/cordis';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { CtlEvent } from './events.ts';
import type { GateSnapshot } from './queue.ts';

/** Everything the browser may read about the control plane. */
export interface LlmCtlSnapshot {
  at: number;
  queue: GateSnapshot;
  events: CtlEvent[];
  reactive: { mode: 'auto' | 'off' | number; limit: number };
}

/** Dependencies supplied by the host plugin. */
export interface ControllerDeps {
  snapshot: () => LlmCtlSnapshot;
  cancel: (queueId: string) => boolean;
}

/**
 * Mark one public instance method as a Remote export.
 *
 * @param instance - service instance whose prototype receives the marker.
 * @param name - public method name exported under the namespace.
 */
function markRemote(instance: object, name: string): void {
  const method = (instance as Record<string, unknown>)[name];
  if (typeof method !== 'function') throw new TypeError(`llm-ctl: remote method "${name}" is missing`);
  const context = {
    kind: 'method',
    name,
    static: false,
    private: false,
    access: {
      has: (target: object) => name in target,
      get: (target: object) => (target as Record<string, unknown>)[name],
    },
    metadata: {},
    addInitializer(initializer: () => void) {
      initializer.call(instance);
    },
  };
  Remote(method as () => unknown, context as unknown as ClassMethodDecoratorContext);
}

/** `ctx.remote.llmCtl` — the namespace the web client polls. */
export class LlmCtlController extends TypertRemoteService {
  private readonly deps: ControllerDeps;

  constructor(ctx: Context, deps: ControllerDeps) {
    super(ctx, 'llmCtlController', { namespace: 'llmCtl' });
    this.deps = deps;
    markRemote(this, 'snapshot');
    markRemote(this, 'cancel');
  }

  /** Current queue, cooldown, and recent control-plane facts. */
  snapshot(): LlmCtlSnapshot {
    return this.deps.snapshot();
  }

  /** Cancel one still-queued request; false when it already started or vanished. */
  cancel(request: { queueId: string }): { cancelled: boolean } {
    if (
      request === null ||
      typeof request !== 'object' ||
      typeof request.queueId !== 'string' ||
      request.queueId.length === 0
    ) {
      return { cancelled: false };
    }
    return { cancelled: this.deps.cancel(request.queueId) };
  }
}
