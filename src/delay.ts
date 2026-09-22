/**
 * Delay resolution ladder for rate-limit recovery.
 *
 * Every source normalizes to milliseconds. Levels 2-6 need an adapter to expose
 * raw response headers through `LlmError.details`; the parsers ship now so M2 is
 * only wiring, while M1 uses level 1 (the adapter's parsed hint) and level 7
 * (local bounded backoff).
 *
 * @module dsh-llm-ctl/delay
 */

/** Local bounded exponential backoff with symmetric jitter. */
export interface BackoffConfig {
  initialDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
}

/** Where the resolved delay came from, for observability and tests. */
export type DelaySource =
  | 'provider-retry-after-ms'
  | 'retry-after-ms'
  | 'retry-after'
  | 'ratelimit-reset'
  | 'go-duration'
  | 'rfc3339-reset'
  | 'backoff'

/** One resolved wait, already normalized to milliseconds. */
export interface DelayResolution {
  delayMs: number;
  source: DelaySource;
  /** True when the provider asked for longer than the single wait budget. */
  overBudget: boolean;
}

/** Inputs to one delay resolution. */
export interface DelayLadderInput {
  /** Delay the adapter already parsed out of the provider response. */
  providerRetryAfterMs?: number | undefined;
  /**
   * Raw provider response headers. M1 adapters do not expose these; the ladder
   * accepts them so M2 only has to pass them through.
   */
  headers?: Record<string, string | undefined> | undefined;
  /** 1-based attempt number used by the local backoff. */
  attempt: number;
  backoff: BackoffConfig;
  /** Single wait budget shared by queueing and cooldown. */
  maxWaitMs: number;
  honorRetryAfter: boolean;
  random: () => number;
  /** Clock used by absolute-time headers; defaults to Date.now. */
  now?: () => number;
}

/** Seconds or HTTP-date, per RFC 9110. Returns undefined for unusable values. */
export function parseRetryAfterHeader(value: string | undefined, now: number = Date.now()): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
  }
  const at = Date.parse(trimmed);
  if (!Number.isFinite(at)) return undefined;
  const delta = at - now;
  return delta > 0 ? delta : undefined;
}

/** `retry-after-ms` carries milliseconds directly. */
export function parseRetryAfterMsHeader(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const ms = Number(value.trim());
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

/**
 * A numeric reset header: small values are seconds, large ones are an epoch in
 * seconds (OpenRouter). The 3600s boundary keeps ordinary second values exact.
 */
export function parseNumericResetHeader(value: string | undefined, now: number = Date.now()): number | undefined {
  if (value === undefined) return undefined;
  const raw = Number(value.trim());
  if (!Number.isFinite(raw) || raw <= 0) return undefined;
  if (raw > 3600) {
    const delta = raw * 1000 - now;
    return delta > 0 ? delta : undefined;
  }
  return raw * 1000;
}

/** Go duration strings used by OpenAI and Groq reset headers, e.g. `6m0s`. */
export function parseGoDurationMs(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const units: Record<string, number> = { ns: 1e-6, us: 1e-3, 'µs': 1e-3, ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
  const pattern = /(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g;
  let total = 0;
  let matched = 0;
  let consumed = 0;
  for (const match of trimmed.matchAll(pattern)) {
    const amount = Number(match[1]);
    const unit = units[match[2] ?? ''];
    if (!Number.isFinite(amount) || unit === undefined) return undefined;
    total += amount * unit;
    matched += 1;
    consumed += match[0].length;
  }
  if (matched === 0 || consumed !== trimmed.length) return undefined;
  return total > 0 ? total : undefined;
}

/** RFC 3339 absolute reset instant (Anthropic), converted against the local clock. */
export function parseRfc3339ResetHeader(value: string | undefined, now: number = Date.now()): number | undefined {
  if (value === undefined) return undefined;
  const at = Date.parse(value.trim());
  if (!Number.isFinite(at)) return undefined;
  const delta = at - now;
  return delta > 0 ? delta : undefined;
}

/** Local bounded exponential backoff with symmetric jitter. */
export function backoffDelay(attempt: number, config: BackoffConfig, random: () => number): number {
  const exponent = Math.min(Math.max(attempt - 1, 0), 16);
  const exponential = Math.min(config.initialDelayMs * 2 ** exponent, config.maxDelayMs);
  const jitter = 1 - config.jitterRatio + 2 * config.jitterRatio * random();
  return Math.max(0, Math.min(exponential * jitter, config.maxDelayMs));
}

/**
 * Resolve the wait for one failed request.
 *
 * Priority: adapter-parsed provider hint, then raw headers (ms, Retry-After,
 * numeric reset, Go duration, RFC 3339 reset), then local backoff. A resolved
 * delay above `maxWaitMs` is reported as over budget so the caller can fail
 * fast instead of waiting out a budget it can never satisfy.
 */
export function resolveDelay(input: DelayLadderInput): DelayResolution {
  const nowMs = (input.now ?? Date.now)();
  const finish = (delayMs: number, source: DelaySource): DelayResolution => ({
    delayMs,
    source,
    overBudget: delayMs > input.maxWaitMs,
  });

  if (input.honorRetryAfter) {
    const hint = input.providerRetryAfterMs;
    if (hint !== undefined && Number.isFinite(hint) && hint > 0) return finish(hint, 'provider-retry-after-ms');

    const headers = input.headers;
    if (headers !== undefined) {
      const read = (name: string): string | undefined => headers[name] ?? headers[name.toLowerCase()];
      const afterMs = parseRetryAfterMsHeader(read('retry-after-ms'));
      if (afterMs !== undefined) return finish(afterMs, 'retry-after-ms');
      const after = parseRetryAfterHeader(read('retry-after'), nowMs);
      if (after !== undefined) return finish(after, 'retry-after');
      const numericReset = parseNumericResetHeader(read('x-ratelimit-reset'), nowMs);
      if (numericReset !== undefined) return finish(numericReset, 'ratelimit-reset');
      const goDuration = parseGoDurationMs(read('x-ratelimit-reset-requests') ?? read('x-ratelimit-reset-tokens'));
      if (goDuration !== undefined) return finish(goDuration, 'go-duration');
      const rfcReset =
        parseRfc3339ResetHeader(read('anthropic-ratelimit-requests-reset'), nowMs) ??
        parseRfc3339ResetHeader(read('anthropic-ratelimit-tokens-reset'), nowMs);
      if (rfcReset !== undefined) return finish(rfcReset, 'rfc3339-reset');
    }
  }

  return finish(backoffDelay(input.attempt, input.backoff, input.random), 'backoff');
}