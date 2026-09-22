/**
 * Per-provider concurrency resolution.
 *
 * The wire value {@link UNLIMITED_CONCURRENCY} (`0`) means "no cap". Inside
 * the gate it is normalized to `Infinity`, so every existing comparison
 * (`active < limit`) and ETA estimate keeps working without a special case.
 * State payloads and settings always carry the wire value, never `Infinity`
 * (which JSON would silently turn into `null`).
 *
 * @module dsh-llm-ctl/concurrency
 */

/** Wire value meaning "no concurrency cap" in settings, routes, and state. */
export const UNLIMITED_CONCURRENCY = 0;

/**
 * Resolve one provider's effective concurrency.
 *
 * An explicit entry wins (including `0` = unlimited for that provider);
 * otherwise the table's `default` applies; without either, the provider is
 * unlimited. There is deliberately no special case for free/shared routes:
 * fragility there is handled by rate-limit cooldown, not by a default cap.
 *
 * @param table - per-provider table; the reserved key `default` applies to
 * every provider without an explicit entry. `0` (or a negative number,
 * defensively) means unlimited.
 * @param provider - provider id to resolve.
 * @returns the effective cap, or `Infinity` when uncapped.
 */
export function concurrencyFor(table: Record<string, number>, provider: string): number {
  const exact = table[provider];
  if (exact !== undefined) return exact <= 0 ? Infinity : exact;
  const fallback = table['default'];
  if (fallback === undefined || fallback <= 0) return Infinity;
  return fallback;
}
