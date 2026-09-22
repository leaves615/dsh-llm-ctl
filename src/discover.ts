/**
 * Upstream model discovery for third-party providers.
 *
 * Two paths, cheapest first: the provider's own discovery registration on
 * `ctx.llm` (which reuses the stored credential server-side, so this module
 * never handles secrets), then the public OpenCode Zen feed for zen-family
 * routes, which needs no credential at all.
 *
 * @module dsh-llm-ctl/discover
 */

/** Public Zen model feed, readable without any credential. */
export const ZEN_MODELS_URL = 'https://opencode.ai/zen/v1/models';

/** True for zen-family provider routes served by the public feed. */
export function isZenProvider(provider: string): boolean {
  const normalized = provider.toLowerCase();
  return normalized.includes('zen') || normalized.includes('opencode');
}

/** One discovered model. */
export interface DiscoveredModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
}

/** Minimal slice of `ctx.llm` this module needs. */
export interface LlmDiscoveryLike {
  listConfigurableProviders(): Array<{ provider: string; displayName: string; settingsNs: string }>;
  discoverModels(
    settingsNs: string,
    request: { provider?: string; baseURL?: string; api?: string; apiKey?: string },
    signal?: AbortSignal,
  ): Promise<DiscoveredModel[]>;
}

/** Dependencies, all injectable for tests. */
export interface DiscoverDeps {
  llm?: LlmDiscoveryLike;
  fetchJson?: (url: string, headers?: Record<string, string>, signal?: AbortSignal) => Promise<unknown>;
  logger?: { info(...args: unknown[]): void; warn(...args: unknown[]): void };
  timeoutMs?: number;
}

/** Inputs for one discovery run. */
export interface DiscoverInput {
  provider: string;
  settingsNs?: string;
  baseURL?: string;
  api?: string;
  apiKey?: string;
  advertised?: readonly string[];
}

/** Where the discovered list came from. */
export type DiscoverSource = 'adapter' | 'zen-feed' | 'none';

/** One discovery result; business failures ride in `error`, never throw. */
export interface DiscoverResult {
  provider: string;
  settingsNs?: string;
  discovered: DiscoveredModel[];
  advertised: string[];
  fresh: string[];
  source: DiscoverSource;
  error?: string;
}

/** Default fetch: bounded JSON GET with a plain user agent. */
async function defaultFetchJson(url: string, headers: Record<string, string> | undefined, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { headers, signal });
  if (!response.ok) throw new Error(url + ': HTTP ' + response.status);
  return (await response.json()) as unknown;
}

/** Resolve the discovery namespace, preferring the explicit value. */
function resolveSettingsNs(
  llm: LlmDiscoveryLike | undefined,
  provider: string,
  explicit: string | undefined,
): string | undefined {
  if (explicit !== undefined && explicit.length > 0) return explicit;
  if (llm === undefined) return undefined;
  const entries = llm.listConfigurableProviders();
  return entries.find((entry) => entry.provider === provider)?.settingsNs ?? entries.find((entry) => entry.provider.toLowerCase() === provider.toLowerCase())?.settingsNs;
}

/** Normalize one raw model record; undefined when it carries no usable id. */
function normalizeModel(record: unknown): DiscoveredModel | undefined {
  if (record === null || typeof record !== 'object') return undefined;
  const entry = record as Record<string, unknown>;
  const id = entry['id'];
  const name = entry['name'];
  const contextWindow = entry['contextWindow'];
  const maxTokens = entry['maxTokens'];
  if (typeof id !== 'string' || id.length === 0) return undefined;
  const model: DiscoveredModel = { id };
  if (typeof name === 'string' && name.length > 0) model.name = name;
  if (typeof contextWindow === 'number' && Number.isFinite(contextWindow)) model.contextWindow = contextWindow;
  if (typeof maxTokens === 'number' && Number.isFinite(maxTokens)) model.maxTokens = maxTokens;
  return model;
}

/** Read the public Zen feed into model records. */
async function readZenFeed(
  fetchJson: (url: string, headers?: Record<string, string>, signal?: AbortSignal) => Promise<unknown>,
  signal: AbortSignal,
): Promise<DiscoveredModel[]> {
  const payload = await fetchJson(ZEN_MODELS_URL, { 'User-Agent': 'dsh-llm-ctl', accept: 'application/json' }, signal);
  if (payload === null || typeof payload !== 'object') throw new Error('zen feed: unexpected response shape');
  const data = (payload as Record<string, unknown>)['data'];
  if (!Array.isArray(data)) throw new Error('zen feed: unexpected response shape');
  const seen = new Set<string>();
  const out: DiscoveredModel[] = [];
  for (const record of data) {
    const model = normalizeModel(record);
    if (model === undefined || seen.has(model.id)) continue;
    seen.add(model.id);
    out.push(model);
  }
  return out;
}

/**
 * Discover the upstream model list for one provider.
 *
 * Tries the adapter registration first (server-side, reuses the stored
 * credential), then the public Zen feed for zen-family routes. Business
 * failures are reported in `error`; only aborts and programming errors throw.
 *
 * @param deps Host capabilities, all optional except the logger default.
 * @param input Provider identity plus optional discovery hints.
 * @param signal Caller cancellation; a 30s timeout applies when omitted.
 * @returns The discovered list with fresh ids relative to `advertised`.
 */
export async function discoverProviderModels(
  deps: DiscoverDeps,
  input: DiscoverInput,
  signal?: AbortSignal,
): Promise<DiscoverResult> {
  const advertised = [...(input.advertised ?? [])];
  const base: Omit<DiscoverResult, 'discovered' | 'fresh' | 'source'> & { error?: string } = {
    provider: input.provider,
    advertised,
  };
  const settingsNs = resolveSettingsNs(deps.llm, input.provider, input.settingsNs);
  if (settingsNs !== undefined) base.settingsNs = settingsNs;
  const timeoutMs = deps.timeoutMs ?? 30_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('discover timeout')), timeoutMs);
  const fused = signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]);
  try {
    if (settingsNs !== undefined && deps.llm !== undefined) {
      try {
        const raw = await deps.llm.discoverModels(
          settingsNs,
          { provider: input.provider, baseURL: input.baseURL, api: input.api, apiKey: input.apiKey },
          fused,
        );
        const seen = new Set<string>();
        const discovered: DiscoveredModel[] = [];
        for (const record of raw) {
          const model = normalizeModel(record);
          if (model === undefined || seen.has(model.id)) continue;
          seen.add(model.id);
          discovered.push(model);
        }
        deps.logger?.info('llm-ctl: discovered %d model(s) for provider %s via adapter', discovered.length, input.provider);
        return { ...base, discovered, advertised, fresh: discovered.map((model) => model.id).filter((id) => !advertised.includes(id)), source: 'adapter' };
      } catch (error) {
        if (fused.aborted) throw error;
        deps.logger?.warn('llm-ctl: adapter discovery failed for provider %s: %o', input.provider, error);
      }
    }
    if (isZenProvider(input.provider)) {
      try {
        const fetchJson = deps.fetchJson ?? defaultFetchJson;
        const discovered = await readZenFeed(fetchJson, fused);
        deps.logger?.info('llm-ctl: discovered %d model(s) for provider %s via zen feed', discovered.length, input.provider);
        return { ...base, discovered, advertised, fresh: discovered.map((model) => model.id).filter((id) => !advertised.includes(id)), source: 'zen-feed' };
      } catch (error) {
        if (fused.aborted) throw error;
        const message = error instanceof Error ? error.message : String(error);
        deps.logger?.warn('llm-ctl: zen feed failed for provider %s: %o', input.provider, error);
        return { ...base, discovered: [], advertised, fresh: [], source: 'zen-feed', error: message };
      }
    }
    const reason = settingsNs === undefined ? 'no discovery namespace for provider' : 'no llm service or adapter discovery failed';
    return { ...base, discovered: [], advertised, fresh: [], source: 'none', error: reason };
  } finally {
    clearTimeout(timer);
  }
}
