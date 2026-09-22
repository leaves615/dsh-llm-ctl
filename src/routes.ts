/**
 * Browser channel for the control plane.
 *
 * A Typert Remote namespace is not reachable from an out-of-repo client half:
 * the browser proxy in \`@deepseek-ai/dsh-api-remotes\` is generated per known
 * namespace, so a third-party namespace never appears on \`ctx.remote\`. The
 * supported channel for a plugin is therefore a plain HTTP route registered on
 * the optional \`webServer\` service (the same seam \`@linxin666/dsh-doctor\` uses).
 *
 * @module dsh-llm-ctl/routes
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CtlEvent } from './events.ts';
import type { GateSnapshot } from './queue.ts';
import type { VisibilitySettings } from './visibility.ts';

/** Route shape accepted by \`ctx.webServer.register\`. */
export interface WebRoute {
  kind: 'exact' | 'prefix';
  path: string;
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}

/** Minimal slice of the host web server the plugin needs. */
export interface WebServerLike {
  register(route: WebRoute): () => void;
}

/** Effective global queue budget surfaced to the settings UI. */
export interface QueueConfigState {
  /** Effective maxWaitMs in ms (settings override wins over the cordis base). */
  maxWaitMs: number;
  /** Effective maxQueueDepth (settings override wins over the cordis base). */
  maxQueueDepth: number;
  /** Effective default per-provider concurrency; `0` means unlimited. */
  defaultConcurrency: number;
  /** Effective provider-specific concurrency entries, excluding `default`; `0` means unlimited. */
  perProviderConcurrency: Record<string, number>;
  /** Cordis composition base, before the user-layer override. */
  defaults: { maxWaitMs: number; maxQueueDepth: number; defaultConcurrency: number };
  /** True when at least one field carries a user-layer override. */
  overridden: boolean;
  /** Current settings section revision, for write fencing. */
  revision: number;
}

/** Visibility slice of the state payload. */
export interface VisibilityState {
  settings: VisibilitySettings;
  /** Composition preset patterns, read-only. */
  patterns: readonly string[];
  /** Declared provider directory, including providers absent from the catalog. */
  configurableProviders: ConfigurableProviderView[];
}

/** State payload the browser polls. */
export interface ControlState {
  at: number;
  queue: GateSnapshot;
  events: CtlEvent[];
  reactive: { mode: 'auto' | 'off' | number; limit: number };
  queueConfig: QueueConfigState;
  visibility: VisibilityState;
}

/** Result of one visibility write. */
export interface VisibilityWriteOutcome {
  ok: boolean;
  code?: string;
  message?: string;
  revision?: number;
}

/** Configurable provider directory entry surfaced to the browser. */
export interface ConfigurableProviderView {
  provider: string;
  displayName: string;
  settingsNs: string;
}

/** Callbacks the routes delegate to. */
export interface RouteDeps {
  state: () => ControlState;
  cancel: (queueId: string) => boolean;
  setQueue: (input: { maxWaitMs?: number | undefined; maxQueueDepth?: number | undefined; defaultConcurrency?: number | undefined; perProviderConcurrency?: Record<string, number> | undefined; expectedRevision?: number }) => Promise<VisibilityWriteOutcome>;
  resetQueue: (input: { expectedRevision?: number }) => Promise<VisibilityWriteOutcome>;
  setVisibility: (input: { provider: string; model?: string; visible: boolean }) => Promise<VisibilityWriteOutcome>;
  resetVisibility: () => Promise<VisibilityWriteOutcome>;
  discover: (input: { provider: string; baseURL?: string; api?: string; apiKey?: string }) => Promise<unknown>;
}

/** Path of the polled state document. */
export const STATE_PATH = '/api/llm-ctl/state';
/** Path of the cancel action. */
export const CANCEL_PATH = '/api/llm-ctl/cancel';
/** Path of the visibility write action. */
export const VISIBILITY_PATH = '/api/llm-ctl/visibility';
/** Path of the visibility reset action. */
export const VISIBILITY_RESET_PATH = '/api/llm-ctl/visibility/reset';
/** Path of the upstream model discovery action. */
export const DISCOVER_PATH = '/api/llm-ctl/discover';
/** Path of the global queue-budget write action. */
export const QUEUE_PATH = '/api/llm-ctl/queue';
/** Path of the global queue-budget reset action. */
export const QUEUE_RESET_PATH = '/api/llm-ctl/queue/reset';

/** Write one JSON response with no caching. */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Read a bounded JSON request body. */
async function readJson(req: IncomingMessage, limitBytes = 4_096): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buffer.length;
    if (total > limitBytes) throw new Error('request body too large');
    chunks.push(buffer);
  }
  if (total === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Build the two routes the browser half uses.
 *
 * @param deps - state reader and cancel action.
 * @returns route descriptors ready for \`webServer.register\`.
 */
export function createRoutes(deps: RouteDeps): WebRoute[] {
  return [
    {
      kind: 'exact',
      path: STATE_PATH,
      handler: (_req, res) => {
        try {
          writeJson(res, 200, deps.state());
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
        }
      },
    },
    {
      kind: 'exact',
      path: CANCEL_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          writeJson(res, 405, { error: 'method not allowed' });
          return;
        }
        try {
          const body = await readJson(req);
          const queueId = body !== null && typeof body === 'object' ? (body as { queueId?: unknown }).queueId : undefined;
          if (typeof queueId !== 'string' || queueId.length === 0) {
            writeJson(res, 400, { error: 'queueId is required' });
            return;
          }
          writeJson(res, 200, { cancelled: deps.cancel(queueId) });
        } catch (error) {
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
      },
    },
    {
      kind: 'exact',
      path: VISIBILITY_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          writeJson(res, 405, { error: 'method not allowed' });
          return;
        }
        try {
          const body = await readJson(req);
          const record = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
          const provider = record['provider'];
          const model = record['model'];
          const visible = record['visible'];
          if (typeof provider !== 'string' || provider.length === 0 || typeof visible !== 'boolean') {
            writeJson(res, 400, { error: 'provider and visible are required' });
            return;
          }
          if (model !== undefined && typeof model !== 'string') {
            writeJson(res, 400, { error: 'model must be a string' });
            return;
          }
          const outcome = await deps.setVisibility({
            provider,
            ...(typeof model === 'string' && model.length > 0 ? { model } : {}),
            visible,
          });
          writeJson(res, outcome.ok ? 200 : 409, outcome);
        } catch (error) {
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
      },
    },
    {
      kind: 'exact',
      path: VISIBILITY_RESET_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          writeJson(res, 405, { error: 'method not allowed' });
          return;
        }
        try {
          const outcome = await deps.resetVisibility();
          writeJson(res, outcome.ok ? 200 : 409, outcome);
        } catch (error) {
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
      },
    },
    {
      kind: 'exact',
      path: QUEUE_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          writeJson(res, 405, { error: 'method not allowed' });
          return;
        }
        try {
          const body = await readJson(req);
          const record = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
          const input: { maxWaitMs?: number | undefined; maxQueueDepth?: number | undefined; defaultConcurrency?: number | undefined; perProviderConcurrency?: Record<string, number> | undefined; expectedRevision?: number } = {};
          if (record['maxWaitMs'] !== undefined) {
            if (typeof record['maxWaitMs'] !== 'number' || !Number.isFinite(record['maxWaitMs']) || (record['maxWaitMs'] as number) < 0) {
              writeJson(res, 400, { error: 'maxWaitMs must be a number >= 0' });
              return;
            }
            input.maxWaitMs = record['maxWaitMs'] as number;
          }
          if (record['maxQueueDepth'] !== undefined) {
            if (typeof record['maxQueueDepth'] !== 'number' || !Number.isFinite(record['maxQueueDepth']) || (record['maxQueueDepth'] as number) < 1) {
              writeJson(res, 400, { error: 'maxQueueDepth must be a number >= 1' });
              return;
            }
            input.maxQueueDepth = Math.floor(record['maxQueueDepth'] as number);
          }
          if (record['defaultConcurrency'] !== undefined) {
            if (typeof record['defaultConcurrency'] !== 'number' || !Number.isFinite(record['defaultConcurrency']) || (record['defaultConcurrency'] as number) < 0) {
              writeJson(res, 400, { error: 'defaultConcurrency must be a number >= 0 (0 means unlimited)' });
              return;
            }
            input.defaultConcurrency = Math.floor(record['defaultConcurrency'] as number);
          }
          if (record['perProviderConcurrency'] !== undefined) {
            const table = record['perProviderConcurrency'];
            if (typeof table !== 'object' || table === null || Array.isArray(table)) {
              writeJson(res, 400, { error: 'perProviderConcurrency must be an object' });
              return;
            }
            const entries: Record<string, number> = {};
            for (const [key, value] of Object.entries(table as Record<string, unknown>)) {
              if (key.length === 0 || typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
                writeJson(res, 400, { error: `perProviderConcurrency[${JSON.stringify(key)}] must be a number >= 0 (0 means unlimited)` });
                return;
              }
              entries[key] = Math.floor(value);
            }
            input.perProviderConcurrency = entries;
          }
          if (record['expectedRevision'] !== undefined) {
            if (typeof record['expectedRevision'] !== 'number' || !Number.isFinite(record['expectedRevision']) || (record['expectedRevision'] as number) < 0) {
              writeJson(res, 400, { error: 'expectedRevision must be a number >= 0' });
              return;
            }
            input.expectedRevision = Math.floor(record['expectedRevision'] as number);
          }
          if (input.maxWaitMs === undefined && input.maxQueueDepth === undefined && input.defaultConcurrency === undefined && input.perProviderConcurrency === undefined) {
            writeJson(res, 400, { error: 'maxWaitMs, maxQueueDepth, defaultConcurrency, or perProviderConcurrency is required' });
            return;
          }
          const outcome = await deps.setQueue(input);
          writeJson(res, outcome.ok ? 200 : 409, outcome);
        } catch (error) {
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
      },
    },
    {
      kind: 'exact',
      path: QUEUE_RESET_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          writeJson(res, 405, { error: 'method not allowed' });
          return;
        }
        try {
          const body = await readJson(req);
          const record = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
          const input: { expectedRevision?: number } = {};
          if (record['expectedRevision'] !== undefined) {
            if (typeof record['expectedRevision'] !== 'number' || !Number.isFinite(record['expectedRevision']) || (record['expectedRevision'] as number) < 0) {
              writeJson(res, 400, { error: 'expectedRevision must be a number >= 0' });
              return;
            }
            input.expectedRevision = Math.floor(record['expectedRevision'] as number);
          }
          const outcome = await deps.resetQueue(input);
          writeJson(res, outcome.ok ? 200 : 409, outcome);
        } catch (error) {
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
      },
    },
    {
      kind: 'exact',
      path: DISCOVER_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          writeJson(res, 405, { error: 'method not allowed' });
          return;
        }
        try {
          const body = await readJson(req);
          const record = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
          const provider = record['provider'];
          if (typeof provider !== 'string' || provider.length === 0) {
            writeJson(res, 400, { error: 'provider is required' });
            return;
          }
          const optional = (key: string): string | undefined => {
            const value = record[key];
            if (value === undefined) return undefined;
            if (typeof value !== 'string') throw new Error(key + ' must be a string');
            return value;
          };
          writeJson(
            res,
            200,
            await deps.discover({ provider, baseURL: optional('baseURL'), api: optional('api'), apiKey: optional('apiKey') }),
          );
        } catch (error) {
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
      },
    },
  ];
}