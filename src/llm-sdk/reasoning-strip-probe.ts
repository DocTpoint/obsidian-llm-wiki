// reasoning-strip-probe.ts
//
// v1.26.0 Batch 6: Layer-3 of the 4-layer fallback for force-disable thinking.
//
// Some openai-compat backends (notably Gemini-via-OpenAI-shim, Issue #137)
// reject `reasoning_effort: 'none'` with HTTP 400. We catch the 400 by
// inspecting the error message for a *rejection verb* AND a *field marker*
// (two-marker pattern, mirrors the established
// `[[isPdfRelatedLlmError]]` classifier in `src/wiki/wiki-engine.ts:587-608`),
// strip the field from the next attempt, and retry exactly once. Cache
// the per-baseURL "strip" decision so subsequent calls skip the probe.
//
// Design (mirrors [[token-key-probe.ts]]):
//
//   1. Send request with `reasoningEffort: 'none'` (Layer 1).
//   2. If 400 with a rejection verb + reasoning field marker → retry once
//      without `reasoningEffort`. Cache the strip decision.
//   3. If retry succeeds → caller gets the response.
//   4. If retry also fails → throw the error.
//   5. If cache already has an entry → skip the probe on this call.
//
// Why two-marker (verb + field), not single substring:
//   v1.26.0 Batch 6 CR-2 fix: the previous single-substring pattern list
//   included the bare word 'thinking', which collides with model *names*
//   (kimi-k2-thinking, qwen3-235b-a22b-thinking-2507, glm-4.6-thinking,
//   and several others). Any 400 on these models — bad model name,
//   context-length exceeded, max_tokens mismatch — was misclassified as
//   a reasoning-field rejection, permanently marked the baseURL as
//   "strip" (silently disabling force-disable-thinking for the rest of
//   the session), AND consumed the 400 so the token-key fallback
//   (`max_tokens ↔ max_completion_tokens`) never fired. Durable
//   functional regression for *-thinking model users.
//
//   The two-marker classifier rejects all four false positives above —
//   none of those error messages contain a rejection verb that names
//   the reasoning field — while still catching the real rejections
//   (e.g., Gemini's "Invalid value for `reasoning_effort`").
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

/**
 * Rejection verbs — what a backend says when it does NOT accept a field.
 * Single-substring on the lowercased error message. Chosen to match the
 * patterns an HTTP 400 with a JSON body typically uses. "Unrecognized" /
 * "unknown" / "invalid value" are the most common.
 */
const REJECTION_VERBS = [
  'unrecognized',
  'unknown',
  'invalid value',
  'unsupported',
  'not allowed',
  'not supported',
] as const;

/**
 * Field markers — names of the reasoning-related fields, as they would
 * appear in a structured JSON error body. Bare 'thinking' is NOT here —
 * it's too easily matched by model names (see CR-2). Use the full
 * `thinking.type` or `enable_thinking` to disambiguate from a model id.
 */
const FIELD_MARKERS = [
  'reasoning_effort',
  'reasoning-effort',
  'thinking.type',
  'enable_thinking',
  'chat_template_kwargs',
  'chat-template-kwargs',
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
   * Does an error message indicate that a reasoning-related field was
   * the cause of an HTTP 400?
   *
   * v1.26.0 Batch 6 CR-2: two-marker classifier. BOTH conditions must
   * hold (AND):
   *
   *   1. The message contains a REJECTION_VERB substring (e.g.
   *      "unrecognized", "unknown", "invalid value"). Without this,
   *      messages like "context length exceeded for kimi-k2-thinking"
   *      or "Model 'glm-4.6-thinking' not found" (which contain the
   *      bare word 'thinking' but are NOT field rejections) would
   *      trigger the strip.
   *   2. The message contains a FIELD_MARKER substring. Without this,
   *      generic "invalid value" 400s (unrelated to reasoning) would
   *      trigger the strip.
   *
   * Both are case-insensitive substring matches. The classifier is
   * deliberately conservative — false negatives (real field-rejection
   * 400s that don't match) cost one extra HTTP call on the next
   * request; false positives (unrelated 400s that match) permanently
   * disable force-disable-thinking for the baseURL, which is much
   * worse. Mirrors the [[isPdfRelatedLlmError]] classifier's design.
   */
  static isReasoningFieldError(message: string): boolean {
    const lower = message.toLowerCase();
    const hasVerb = REJECTION_VERBS.some((v) => lower.includes(v));
    const hasField = FIELD_MARKERS.some((f) => lower.includes(f));
    return hasVerb && hasField;
  }
}