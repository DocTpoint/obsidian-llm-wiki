// json-object-strip-probe.ts
//
// v1.26.3 PATCH follow-up to Issue #443: a runtime 400-strip-retry
// fallback for the no-schema `json_object` path.
//
// Some openai-compat backends (LM Studio is the measured case, DocTpoint
// Issue #443 comment 1, 2026-08-09, 29 ms,
// `'response_format.type' must be 'json_schema' or 'text'`) reject
// `response_format: { type: 'json_object' }` with HTTP 400. To avoid
// hardcoding which providers reject the field, the SDK client catches
// any 400 whose error message names `json_object` or `response_format`,
// retries exactly once without `output`, and caches the strip decision
// per baseURL so subsequent calls skip the probe.
//
// Design (mirrors [[reasoning-strip-probe.ts]] + [[token-key-probe.ts]]):
//
//   1. Send request with `Output.json()` → SDK encodes
//      `response_format: { type: 'json_object' }` on the wire.
//   2. If 400 with a rejection verb + json_object/response_format field
//      marker → retry once without `output`. Cache the strip decision.
//   3. If retry succeeds → caller gets the response.
//   4. If retry also fails → throw the error.
//   5. If cache already has an entry → skip the probe on this call.
//
// Why two-marker (verb + field), not single substring:
//   Same reasoning as `reasoning-strip-probe.ts` CR-2 fix. Bare
//   `response_format` could collide with other field names in error
//   messages; a generic 400 with "invalid value" (unrelated to
//   json_object) must NOT trigger the strip — that would permanently
//   disable server-side type hints for the baseURL. The two-marker
//   AND-pattern rejects false positives while still catching real
//   rejections like LM Studio's "must be 'json_schema' or 'text'".
//
// Why per-baseURL not per-model:
//   Same gateway → same wire format → same rejection behaviour. Model
//   granularity would over-invalidate the cache.
//
// Why message-match rather than "any 400 on a no-schema call":
//   Coarse 400-retry would swallow 400s that belong to the token-key
//   mechanism (`max_tokens` ↔ `max_completion_tokens`) or the
//   reasoning-strip mechanism (`reasoning_effort`). The token-key
//   path already runs (any 400 → swap keys → retry), and the
//   reasoning-strip path also runs (any 400 with a reasoning-field
//   marker → strip reasoning_effort → retry). The json-object-strip
//   path only runs for 400s whose error message identifies
//   `json_object` / `response_format` as the cause — keeping the
//   three retry mechanisms orthogonal. The ordering in the SDK
//   client's catch-handler is: reasoning-strip → json-object-strip →
//   token-key, so each path's message-match condition must be
//   disjoint from the others.

/**
 * Rejection verbs — what a backend says when it does NOT accept a field.
 * Single-substring on the lowercased error message. Mirrors the
 * `reasoning-strip-probe.ts` REJECTION_VERBS list. "Unrecognized" /
 * "unknown" / "invalid value" / "must be" are the most common forms
 * OpenAI-compat servers use in 400 bodies.
 */
const REJECTION_VERBS = [
  'unrecognized',
  'unknown',
  'invalid value',
  'unsupported',
  'not allowed',
  'not supported',
  'must be',
  'should be',
] as const;

/**
 * Field markers — names of the json_object / response_format fields,
 * as they would appear in a structured JSON error body. Both
 * `json_object` (the type the SDK sends) and `response_format` (the
 * outer field name) are listed so the classifier matches either form
 * a backend might use. Bare `json` is NOT here — too easily matched
 * by content type headers, file extensions, model names, and
 * unrelated fields.
 */
const FIELD_MARKERS = [
  'json_object',
  'json-object',
  'response_format',
  'response-format',
] as const;

/**
 * JsonObjectStripProber — per-client "should I strip `Output.json()`?"
 * cache.
 *
 * Cache keyed by baseURL because the same gateway typically uses the
 * same wire format across all models. Value is presence (true) — the
 * key itself is the signal — so a Set is the right primitive, not a
 * Map<string, true>. Mirrors the
 * `[[reasoning-strip-probe.ts]]` design exactly.
 */
export class JsonObjectStripProber {
  private readonly cache = new Set<string>();

  /**
   * Read cached strip decision for a baseURL.
   * `true` = we already learned this backend rejects `json_object`
   * and the next call should omit `output` entirely.
   */
  shouldStrip(baseUrl: string): boolean {
    return this.cache.has(baseUrl);
  }

  /**
   * Mark a baseURL as "strip `Output.json()` on future calls".
   * Called after a 400 retry revealed the field was the cause.
   */
  markStrip(baseUrl: string): void {
    this.cache.add(baseUrl);
  }

  /**
   * Does an error message indicate that `json_object` /
   * `response_format` was the cause of an HTTP 400?
   *
   * Two-marker classifier. BOTH conditions must hold (AND):
   *
   *   1. The message contains a REJECTION_VERB substring (e.g.
   *      "unrecognized", "invalid value", "must be"). Without this,
   *      messages that happen to contain "json_object" for unrelated
   *      reasons (response body, log line, model name) would
   *      trigger the strip.
   *   2. The message contains a FIELD_MARKER substring. Without this,
   *      generic "invalid value" 400s (unrelated to json_object)
   *      would trigger the strip.
   *
   * Both are case-insensitive substring matches. The classifier is
   * deliberately conservative — false negatives (real field-rejection
   * 400s that don't match) cost one extra HTTP call on the next
   * request; false positives (unrelated 400s that match) permanently
   * disable server-side type hints for the baseURL, which is much
   * worse. Mirrors the `reasoning-strip-probe.ts` classifier design.
   */
  static isJsonObjectFieldError(message: string): boolean {
    const lower = message.toLowerCase();
    const hasVerb = REJECTION_VERBS.some((v) => lower.includes(v));
    const hasField = FIELD_MARKERS.some((f) => lower.includes(f));
    return hasVerb && hasField;
  }
}
