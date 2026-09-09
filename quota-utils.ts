export interface RateLimitInfo {
  utilization?: string;
  status?: string;
  reset?: string;
  weeklyUtilization?: string;
  weeklyStatus?: string;
  weeklyReset?: string;
  requestsLimit?: string;
  requestsRemaining?: string;
  requestsReset?: string;
  tokensLimit?: string;
  tokensRemaining?: string;
  tokensReset?: string;
  capturedAt?: number;
}

const PASSIVE_LIMIT_THRESHOLD = 0.99;
const PASSIVE_RATE_LIMIT_STALE_MS = 5 * 60 * 60 * 1000;
const DEFAULT_COOLDOWN_MS = 5 * 60 * 60 * 1000;

export function isRateLimitInfoStale(info: RateLimitInfo | undefined, now = Date.now()): boolean {
  if (!info?.capturedAt) return false;
  return now - info.capturedAt > PASSIVE_RATE_LIMIT_STALE_MS;
}

export function getPassiveRateLimitCooldownMs(info: RateLimitInfo | undefined, now = Date.now()): number {
  if (!info?.utilization) return 0;
  if (isRateLimitInfoStale(info, now)) return 0;
  if (Number(info.utilization) < PASSIVE_LIMIT_THRESHOLD) return 0;
  if (!info.reset) return 0;

  const resetSeconds = Number(info.reset);
  if (!Number.isFinite(resetSeconds)) return 0;
  return Math.max(0, resetSeconds * 1000 - now);
}

export function isClaudeUsageAvailable(usage: { limits?: { percent?: number }[] } | null): boolean | undefined {
  if (!usage?.limits?.length) return undefined;
  return usage.limits.every((limit) => (limit.percent ?? 0) < 100);
}

/** 5h ("session") usage percent from the Anthropic OAuth usage payload. */
export function claudeSessionPercent(
  usage: { limits?: { kind?: string; percent?: number }[] } | null,
): number | undefined {
  const session = usage?.limits?.find((limit) => limit.kind === "session");
  return session?.percent === undefined ? undefined : Math.round(session.percent);
}

interface CodexWindowLike {
  used_percent: number;
  limit_window_seconds: number;
  reset_after_seconds: number;
}

/** 5h window usage percent from the Codex usage payload (weekly-only responses yield undefined). */
export function codexSessionPercent(
  usage: { rate_limit?: { primary_window?: CodexWindowLike; secondary_window?: CodexWindowLike } } | null,
): number | undefined {
  const day = 24 * 3600;
  const window = [usage?.rate_limit?.primary_window, usage?.rate_limit?.secondary_window].find(
    (w): w is CodexWindowLike => !!w && w.limit_window_seconds <= day && w.reset_after_seconds <= day,
  );
  return window ? Math.round(window.used_percent) : undefined;
}

export function isProviderRateLimitError(message: string | undefined): boolean {
  if (!message) return false;
  return /\b429\b|rate_limit_error|rate limit/i.test(message);
}

export function parseCooldownMs(
  headers: Record<string, string> | undefined,
  now = Date.now(),
  defaultCooldownMs = DEFAULT_COOLDOWN_MS,
): number {
  if (!headers) return defaultCooldownMs;
  const reset = headers["anthropic-ratelimit-unified-5h-reset"] ?? headers["anthropic-ratelimit-unified-reset"];
  if (reset) {
    const seconds = Number(reset);
    if (Number.isFinite(seconds)) {
      const ms = seconds * 1000 - now;
      if (ms > 0) return ms;
    }
  }
  const retryAfterMs = headers["retry-after-ms"];
  if (retryAfterMs) {
    const ms = Number(retryAfterMs);
    if (!Number.isNaN(ms) && ms > 0) return ms;
  }
  const retryAfter = headers["retry-after"];
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (!Number.isNaN(seconds) && seconds > 0) return seconds * 1000;
  }
  return defaultCooldownMs;
}
