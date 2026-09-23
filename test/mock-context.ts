/**
 * Minimal Cordis-shaped context for plugin wiring tests.
 *
 * Only the surface `@leaves615/dsh-llm-ctl` actually uses is implemented: listener
 * registration, logger, effect disposal, and service provision.
 *
 * @module dsh-llm-ctl/test/mock-context
 */
import type { CtlEventKind } from '../src/events.ts';

type Listener = (...args: unknown[]) => unknown;

/** Cordis-shaped context stub. */
export interface MockContext {
  listeners: Map<string, Listener[]>;
  services: Map<string, unknown>;
  disposers: Array<() => void | Promise<void>>;
  logger: { debug: (...args: unknown[]) => void; info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; logs: string[] };
  on(name: string, listener: Listener, options?: { global?: boolean; prepend?: boolean }): () => void;
  get(name: string): unknown;
  effect(callback: () => (() => void | Promise<void>) | void, label?: string): void;
  inject(deps: string[], callback: (ctx: MockContext) => void): void;
  routes: Array<{ kind: string; path: string; handler: (req: unknown, res: unknown) => void | Promise<void> }>;
  reflect: { provide(name: string, value: unknown, check?: unknown): () => void };
}

/** Create a context stub, optionally recording logger output. */
export function makeMockContext(): MockContext {
  const listeners = new Map<string, Listener[]>();
  const services = new Map<string, unknown>();
  const disposers: Array<() => void | Promise<void>> = [];
  const logs: string[] = [];
  const record =
    (level: string) =>
    (...args: unknown[]): void => {
      logs.push(`${level} ${args.map((value) => String(value)).join(' ')}`);
    };
  const ctx: MockContext = {
    listeners,
    services,
    disposers,
    logger: { debug: record('debug'), info: record('info'), warn: record('warn'), logs },
    get(name: string) {
      return services.get(name);
    },
    on(name, listener, options = {}) {
      const list = listeners.get(name) ?? [];
      if (options.prepend === true) list.unshift(listener);
      else list.push(listener);
      listeners.set(name, list);
      return () => {
        const current = listeners.get(name) ?? [];
        listeners.set(
          name,
          current.filter((candidate) => candidate !== listener),
        );
      };
    },
    effect(callback) {
      const disposer = callback();
      if (typeof disposer === 'function') disposers.push(disposer);
    },
    inject(deps, callback) {
      if (deps.every((dep) => services.has(dep))) callback(ctx);
    },
    routes: [],
    reflect: {
      provide(name, value) {
        services.set(name, value);
        (ctx as unknown as Record<string, unknown>)[name] = value;
        return () => {
          services.delete(name);
          delete (ctx as unknown as Record<string, unknown>)[name];
        };
      },
    },
  };
  return ctx;
}

/**
 * Run one waterfall exactly like Cordis: outermost listener first, each calling
 * `next()` to reach the following listener or the innermost callback.
 */
export function runWaterfall<T>(ctx: MockContext, name: string, payload: unknown, inner: () => T): T {
  const chain = [...(ctx.listeners.get(name) ?? [])];
  const next = (): T => {
    const listener = chain.shift();
    if (listener === undefined) return inner();
    return listener(payload, next) as T;
  };
  return next();
}

/** Build an async iterable from a fixed chunk list. */
export async function* fromChunks<T>(chunks: readonly T[]): AsyncGenerator<T> {
  for (const chunk of chunks) yield chunk;
}

/** Read every chunk from an async iterable. */
export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
}

/** Control-plane facts recorded by the plugin, newest last. */
export function eventKinds(ctx: MockContext): CtlEventKind[] {
  const controller = ctx.services.get('llmCtlController') as
    | { snapshot(): { events: Array<{ kind: CtlEventKind }> } }
    | undefined;
  return controller?.snapshot().events.map((event) => event.kind) ?? [];
}
/** Install a recording web server service on the mock context. */
export function installWebServer(ctx: MockContext): MockContext['routes'] {
  const routes: MockContext['routes'] = ctx.routes;
  ctx.reflect.provide('webServer', {
    register(route: MockContext['routes'][number]) {
      routes.push(route);
      return () => {
        const index = routes.indexOf(route);
        if (index >= 0) routes.splice(index, 1);
      };
    },
  });
  return routes;
}

/** Minimal response recorder for route handlers. */
export function makeResponse(): { status: number; headers: Record<string, string>; body: string; writeHead(s: number, h?: Record<string, string>): void; end(b?: string): void } {
  const res = {
    status: 0,
    headers: {} as Record<string, string>,
    body: '',
    writeHead(status: number, headers?: Record<string, string>) {
      res.status = status;
      if (headers !== undefined) res.headers = headers;
    },
    end(body?: string) {
      res.body = body ?? '';
    },
  };
  return res;
}