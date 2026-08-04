import { getText } from './i18n';
import { MAX_BATCH_DELAY_MS } from '../constants';

export interface RateLimitInfo {
  count: number;
  rateLimitNames: string[];
  suggestedConcurrency: number;
  suggestedDelay: number;
}

/**
 * v1.26.0 (#382 item 1, Batch 2): single source of truth for the
 * "is this failure reason a 429-style rate limit?" predicate. Previously
 * the regex literal lived only inside `detectRateLimitFailures`; the
 * dedup-phase non-rate-limit diagnostic (added in the same commit)
 * needed the same predicate with inverted semantics. Exported here so
 * the regex cannot drift between callers.
 *
 * Adding/removing markers (e.g. 'quota exceeded') is a one-line edit
 * here; both consumers pick up the change automatically.
 */
export const RATE_LIMIT_MARKER_RE = /429|rate.?limit|too many requests|throttl/i;

/** Predicate form of the rate-limit marker regex. */
export function isRateLimitFailure(reason: string | undefined): boolean {
  return RATE_LIMIT_MARKER_RE.test(reason || '');
}

export function detectRateLimitFailures(
  failedItems: Array<{ reason?: string; name?: string; type?: string }>,
  currentConcurrency: number,
  currentBatchDelay: number,
): RateLimitInfo | null {
  const rateLimitFailures = failedItems.filter(f => isRateLimitFailure(f.reason));

  if (rateLimitFailures.length === 0) return null;

  return {
    count: rateLimitFailures.length,
    rateLimitNames: rateLimitFailures.map(f => f.name || f.reason || 'unknown'),
    suggestedConcurrency: Math.max(1, currentConcurrency - 1),
    suggestedDelay: currentBatchDelay < 100
      ? 500
      : Math.min(MAX_BATCH_DELAY_MS, Math.round(currentBatchDelay * 2))
  };
}

export function formatRateLimitNotice(
  info: RateLimitInfo,
  language: string,
): string {
  return getText(language, 'rateLimitDetected')
    .replace('{count}', String(info.count))
    .replace('{suggestedConcurrency}', String(info.suggestedConcurrency))
    .replace('{suggestedDelay}', String(info.suggestedDelay));
}
