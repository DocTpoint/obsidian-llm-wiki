// reasoning-strip-probe.ts
//
// v1.26.0 Batch 6: Layer-3 of the 4-layer fallback for force-disable thinking.
//
// Some openai-compat backends (notably Gemini-via-OpenAI-shim, Issue #137)
// reject `reasoning_effort: 'none'` with HTTP 400. We catch the 400 by
// inspecting the error message for `reasoning_effort`, `thinking`, or
// `chat_template`, strip the field from the next attempt, and retry
// exactly once. Cache the per-baseURL "strip" decision so subsequent
// calls skip the probe.
//
// Design (mirrors [[token-key-probe.ts]]):
//
//   1. Send request with `reasoningEffort: 'none'` (Layer 1).
//   2. If 400 with a reasoning-related field name in the message → retry
//      once without `reasoningEffort`. Cache the strip decision.
//   3. If retry succeeds → caller gets the response.
//   4. If retry also fails → throw the *original* error.
//   5. If cache already has an entry → skip the probe on this call.
//
// Why message-match rather than a broader 400-retry:
//   - 400 on any other field (max_tokens vs max_completion_tokens) is
//     already handled by [[TokenKeyProber]] — different mechanism, no
//     overlap.
//   - 401 (auth) / 429 (rate) / 5xx (server) have distinct status codes
//     and are NOT covered here.
//
// Why per-baseURL not per-model:
//   Same gateway → same wire format → same rejection behaviour. Model
//   granularity would over-invalidate the cache.

const REASONING_FIELD_PATTERNS = [
  'reasoning_effort',
  'reasoning-effort',
  'thinking',
  'chat_template',
  'chat-template',
] as const;

/**
 * ReasoningStripProber — per-client "should I strip reasoningEffort?"
 * cache.
 *
 * Cache keyed by baseURL because the same gateway typically uses the
 * same wire format across all models.
 */
export class ReasoningStripProber {
  private readonly cache: Map<string, true> = new Map();

  /**
   * Read cached strip decision for a baseURL.
   * `true` = we already learned this backend rejects reasoningEffort
   * and the next call should omit it.
   */
  shouldStrip(baseUrl: string): boolean {
    return this.cache.get(baseUrl) === true;
  }

  /**
   * Mark a baseURL as "strip reasoningEffort on future calls".
   * Called after a 400 retry revealed the field was the cause.
   */
  markStrip(baseUrl: string): void {
    this.cache.set(baseUrl, true);
  }

  /**
   * Invalidate cached entries. Called when the user changes baseURL
   * or API key (re-probe on next request), or for unit tests.
   */
  invalidate(baseUrl?: string): void {
    if (baseUrl === undefined) {
      this.cache.clear();
    } else {
      this.cache.delete(baseUrl);
    }
  }

  /**
   * Does an error message indicate a reasoning-related field was the
   * cause of the failure?
   *
   * Conservative match: substring on the patterns above. Backends vary
   * in error wording — Gemini uses "Invalid value for `reasoning_effort`",
   * DeepSeek uses "thinking.type not supported" (none of our patterns
   * but the user explicitly opts into DeepSeek's reasoning behavior so
   * a 400 here is more likely model-config than field rejection; left
   * alone). Match is case-insensitive.
   */
  static isReasoningFieldError(message: string): boolean {
    const lower = message.toLowerCase();
    return REASONING_FIELD_PATTERNS.some((p) => lower.includes(p));
  }
}