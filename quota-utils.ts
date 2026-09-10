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

export interface StatusQuota {
  label: "5h" | "Weekly";
  percent: number;
}

/** Prefer the subscription's 5h limit; fall back to its weekly limit. */
export function claudeStatusQuota(
  usage: { limits?: { kind?: string; percent?: number }[] } | null,
): StatusQuota | undefined {
  const limit = usage?.limits?.find((item) => item.kind === "session")
    ?? usage?.limits?.find((item) => item.kind === "weekly_all");
  if (limit?.percent === undefined) return undefined;
  return { label: limit.kind === "session" ? "5h" : "Weekly", percent: Math.round(limit.percent) };
}

interface CodexWindowLike {
  used_percent: number;
  limit_window_seconds: number;
  reset_after_seconds: number;
}

/** Prefer a live 5h Codex window; Pro accounts that only expose a weekly window fall back to Weekly. */
export function codexStatusQuota(
  usage: { rate_limit?: { primary_window?: CodexWindowLike; secondary_window?: CodexWindowLike } } | null,
): StatusQuota | undefined {
  const day = 24 * 3600;
  const windows = [usage?.rate_limit?.primary_window, usage?.rate_limit?.secondary_window].filter(
    (window): window is CodexWindowLike => !!window,
  );
  const session = windows.find((window) => window.limit_window_seconds <= day && window.reset_after_seconds <= day);
  const window = session ?? windows.reduce<CodexWindowLike | undefined>(
    (latest, item) => !latest || item.reset_after_seconds > latest.reset_after_seconds ? item : latest,
    undefined,
  );
  return window ? { label: session ? "5h" : "Weekly", percent: Math.round(window.used_percent) } : undefined;
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
