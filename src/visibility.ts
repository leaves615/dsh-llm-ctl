/**
 * Model visibility: two-level switches plus wildcard presets.
 *
 * Priority, highest first: an explicit `models['provider:model']` entry, an
 * explicit `providers[provider]` entry, a matching `hiddenPatterns` entry,
 * visible by default. A provider switched off hides every one of its models,
 * even one carrying an explicit `true`.
 *
 * @module dsh-llm-ctl/visibility
 */

/** Two-level visibility switches, keyed exactly as {@link modelKey} produces. */
export interface VisibilitySettings {
  /** Provider id → visible. An explicit `false` hides all of its models. */
  providers: Record<string, boolean>;
  /** {@link modelKey} → visible. Outranks the provider entry. */
  models: Record<string, boolean>;
}

/** Composition-level presets, applied below the explicit switches. */
export interface VisibilityConfig {
  /** Wildcard patterns; only `*` is special, matching any run of characters. */
  hiddenPatterns?: readonly string[] | undefined;
}

/** Minimal shape of one catalog row, e.g. an `ctx.llm` model listing. */
export interface CatalogEntry {
  provider: string;
  model: string;
  displayName?: string | undefined;
}

/**
 * Canonical form of a wildcard pattern: surrounding whitespace trimmed and
 * lower-cased. Matching is case-insensitive, so this is the form compared.
 *
 * @param pattern Raw pattern, as written in configuration.
 * @returns The trimmed, lower-cased pattern.
 */
export function normalizePattern(pattern: string): string {
  return pattern.trim().toLowerCase();
}

/**
 * Greedy wildcard match where `*` consumes any run of characters, `:`
 * included. Every other character, including `?` and `[]`, is literal.
 *
 * @param pattern Lower-cased pattern containing at most `*` metacharacters.
 * @param value Lower-cased candidate string.
 * @returns True when the whole value is consumed by the pattern.
 */
function globMatch(pattern: string, value: string): boolean {
  let p = 0;
  let v = 0;
  let star = -1;
  let resume = 0;
  while (v < value.length) {
    if (p < pattern.length && pattern[p] === '*') {
      star = p;
      resume = v;
      p += 1;
      continue;
    }
    if (p < pattern.length && pattern[p] === value[v]) {
      p += 1;
      v += 1;
      continue;
    }
    if (star >= 0) {
      p = star + 1;
      resume += 1;
      v = resume;
      continue;
    }
    return false;
  }
  while (p < pattern.length && pattern[p] === '*') p += 1;
  return p === pattern.length;
}

/**
 * Test one wildcard pattern against a provider/model pair.
 *
 * `*` is the only metacharacter and matches any run of characters, `:`
 * included. A pattern may be written `provider:model` or, omitting the
 * provider segment, as a model-only pattern that applies to every provider.
 * When `model` is omitted only a pattern covering a whole provider
 * (`p:*`, `p:`) can match.
 *
 * @param pattern Pattern to test, with or without a provider segment.
 * @param provider Provider id to test.
 * @param model Model id to test; omit to ask about the provider as a whole.
 * @returns True when the pattern matches the pair.
 */
export function matchesPattern(pattern: string, provider: string, model?: string): boolean {
  const normalized = normalizePattern(pattern);
  const separator = normalized.indexOf(':');
  const providerGlob = separator < 0 ? '*' : normalized.slice(0, separator);
  const modelGlob = separator < 0 ? normalized : normalized.slice(separator + 1);
  if (!globMatch(providerGlob, provider.trim().toLowerCase())) return false;
  return globMatch(modelGlob, model === undefined ? '' : model.trim().toLowerCase());
}

/**
 * True when any configured preset pattern matches the pair.
 *
 * @param config Composition config carrying the presets; may be undefined.
 * @param provider Provider id to test.
 * @param model Model id to test, or undefined for the provider as a whole.
 * @returns True when at least one pattern hits.
 */
function matchesAnyPattern(config: VisibilityConfig | undefined, provider: string, model: string | undefined): boolean {
  const patterns = config?.hiddenPatterns;
  if (patterns === undefined) return false;
  return patterns.some((pattern) => matchesPattern(pattern, provider, model));
}

/**
 * Whether a provider is switched on.
 *
 * An explicit `providers[provider]` entry wins; otherwise a preset pattern
 * covering the provider's whole model set (`p:*`, `p:`) hides it; otherwise
 * it is visible.
 *
 * @param provider Provider id.
 * @param settings Two-level switches.
 * @param config Composition config with preset patterns; may be omitted.
 * @returns True when the provider is visible.
 */
export function isProviderVisible(provider: string, settings: VisibilitySettings, config?: VisibilityConfig): boolean {
  const explicit = settings.providers[provider];
  if (explicit !== undefined) return explicit;
  return !matchesAnyPattern(config, provider, undefined);
}

/**
 * Whether one model is switched on, resolving the full priority chain.
 *
 * A provider explicitly set to `false` hides all of its models. Otherwise an
 * explicit `models` entry wins, then an explicit `providers` entry, then a
 * matching preset pattern, then the visible default.
 *
 * @param provider Provider id.
 * @param model Model id.
 * @param settings Two-level switches.
 * @param config Composition config with preset patterns; may be omitted.
 * @returns True when the model is visible.
 */
export function isModelVisible(
  provider: string,
  model: string,
  settings: VisibilitySettings,
  config?: VisibilityConfig,
): boolean {
  if (settings.providers[provider] === false) return false;
  const explicitModel = settings.models[modelKey(provider, model)];
  if (explicitModel !== undefined) return explicitModel;
  const explicitProvider = settings.providers[provider];
  if (explicitProvider !== undefined) return explicitProvider;
  return !matchesAnyPattern(config, provider, model);
}

/**
 * Key under which one model's switch is stored.
 *
 * @param provider Provider id.
 * @param model Model id.
 * @returns The `provider:model` key used by {@link VisibilitySettings.models}.
 */
export function modelKey(provider: string, model: string): string {
  return `${provider}:${model}`;
}

/**
 * Return a new settings object with one provider switch written.
 *
 * The input is never mutated, and a repeated write of the same value still
 * returns a fresh object so callers can diff by identity.
 *
 * @param settings Two-level switches; left untouched.
 * @param provider Provider id.
 * @param visible Whether the provider is visible.
 * @returns A new settings object.
 */
export function setProviderVisible(settings: VisibilitySettings, provider: string, visible: boolean): VisibilitySettings {
  return { providers: { ...settings.providers, [provider]: visible }, models: { ...settings.models } };
}

/**
 * Return a new settings object with one model switch written.
 *
 * The input is never mutated, and a repeated write of the same value still
 * returns a fresh object so callers can diff by identity.
 *
 * @param settings Two-level switches; left untouched.
 * @param provider Provider id.
 * @param model Model id.
 * @param visible Whether the model is visible.
 * @returns A new settings object.
 */
export function setModelVisible(
  settings: VisibilitySettings,
  provider: string,
  model: string,
  visible: boolean,
): VisibilitySettings {
  return { providers: { ...settings.providers }, models: { ...settings.models, [modelKey(provider, model)]: visible } };
}

/**
 * Return an empty settings object, i.e. every provider and model visible.
 *
 * @param settings Two-level switches; left untouched.
 * @returns A new settings object with both tables empty.
 */
export function setAllVisible(settings: VisibilitySettings): VisibilitySettings {
  return { providers: {}, models: {} };
}

/**
 * Split a catalog into visible and hidden rows, preserving input order.
 *
 * Rows are neither copied nor modified; both arrays hold the original objects.
 *
 * @param entries Catalog rows to partition.
 * @param settings Two-level switches.
 * @param config Composition config with preset patterns; may be omitted.
 * @returns The visible rows and the hidden rows, each in input order.
 */
export function filterCatalog<T extends CatalogEntry>(
  entries: readonly T[],
  settings: VisibilitySettings,
  config?: VisibilityConfig,
): { visible: T[]; hidden: T[] } {
  const visible: T[] = [];
  const hidden: T[] = [];
  for (const entry of entries) {
    if (isModelVisible(entry.provider, entry.model, settings, config)) visible.push(entry);
    else hidden.push(entry);
  }
  return { visible, hidden };
}

/**
 * How many catalog rows the current switches hide.
 *
 * @param entries Catalog rows to inspect.
 * @param settings Two-level switches.
 * @param config Composition config with preset patterns; may be omitted.
 * @returns The hidden row count, equal to `filterCatalog(...).hidden.length`.
 */
export function hiddenCount<T extends CatalogEntry>(
  entries: readonly T[],
  settings: VisibilitySettings,
  config?: VisibilityConfig,
): number {
  return filterCatalog(entries, settings, config).hidden.length;
}

/**
 * Choose the fallback model when the current selection is hidden.
 *
 * @param current The selection to validate; it need not appear in `entries`.
 * @param entries Candidate catalog rows, scanned in order.
 * @param settings Two-level switches.
 * @param config Composition config with preset patterns; may be omitted.
 * @returns Undefined when `current` is visible, else the first visible entry,
 * else undefined when nothing is visible.
 */
export function pickFallback<T extends CatalogEntry>(
  current: CatalogEntry,
  entries: readonly T[],
  settings: VisibilitySettings,
  config?: VisibilityConfig,
): T | undefined {
  if (isModelVisible(current.provider, current.model, settings, config)) return undefined;
  for (const entry of entries) {
    if (isModelVisible(entry.provider, entry.model, settings, config)) return entry;
  }
  return undefined;
}
