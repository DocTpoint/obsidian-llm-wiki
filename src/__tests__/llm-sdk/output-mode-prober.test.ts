// output-mode-prober.test.ts
//
// v1.26.3 PATCH Phase A2: replaces json-object-strip-probe.ts with a
// 3-tier output-mode state machine. The probes per-tier:
//
//   isJsonSchemaFieldError — catches 400s that say "response_format.type
//   must NOT be 'json_schema'" (or similar) — i.e. the server does not
//   accept our strongest mode and we should demote Tier 0 → Tier 1.
//
//   isJsonObjectFieldError — existing json-object-strip-probe classifier
//   (kept verbatim so its regressions stay guarded) — catches 400s that
//   say "json_object / response_format not accepted" — i.e. server does
//   not accept Tier 1 either and we should demote Tier 1 → Tier 2.
//
// The cache contract:
//   - getMode(baseURL) returns the current tier. Default = 'json_schema'
//     (assume strongest, demote on 400).
//   - markMode(baseURL, mode) writes the tier to the cache.
//     Called AFTER retry success (not before — transient retry failure
//     must not permanently downgrade a baseURL).
//   - promote(baseURL) returns the next-weaker tier.
//
// Test matrix pins:
//   1. Default mode = 'json_schema'
//   2. markMode + getMode round-trip per baseURL (no cross-baseURL leak)
//   3. promote('json_schema') → 'json_object'
//   4. promote('json_object')  → 'text_prompt'
//   5. promote('text_prompt')  → 'text_prompt' (floor; no demotion beyond)
//   6. isJsonSchemaFieldError: catches 'json_schema' rejection
//      (e.g. Cloudflare / Anthropic-via-proxy hypothetical response)
//   7. isJsonSchemaFieldError: does NOT match bare 'json' / model names
//   8. isJsonObjectFieldError: matches the LM Studio 400 body verbatim
//      (regression guard — preserves the v1.26.2 fix)
//   9. input must be responseBody, not message — same shape contract as
//      reasoning-strip-probe.test.ts 'Classifier input contract'

import { describe, it, expect } from 'vitest';
import { APICallError } from 'ai';
import { OutputModeProber, type OutputMode } from '../../llm-sdk/output-mode-prober';

describe('OutputModeProber — cache & promotion', () => {
  it('default mode is json_schema (assume strongest, demote on 400)', () => {
    const prober = new OutputModeProber();
    expect(prober.getMode('https://api.deepseek.com/v1')).toBe('json_schema');
    expect(prober.getMode('https://api.example.com/v1')).toBe('json_schema');
  });

  it('markMode + getMode round-trip per baseURL (no cross-leak)', () => {
    const prober = new OutputModeProber();
    prober.markMode('https://api.deepseek.com/v1', 'json_object');
    expect(prober.getMode('https://api.deepseek.com/v1')).toBe('json_object');
    // Different baseURL unaffected
    expect(prober.getMode('https://api.openai.com/v1')).toBe('json_schema');
  });

  it('promote: json_schema → json_object', () => {
    expect(OutputModeProber.promote('json_schema')).toBe('json_object');
  });

  it('promote: json_object → text_prompt', () => {
    expect(OutputModeProber.promote('json_object')).toBe('text_prompt');
  });

  it('promote: text_prompt is the floor (no further demotion)', () => {
    expect(OutputModeProber.promote('text_prompt')).toBe('text_prompt');
  });
});

describe('OutputModeProber.isJsonSchemaFieldError — two-marker classifier for Tier 0 demotion', () => {
  it('matches Anthropic-style: unsupported + json_schema field', () => {
    expect(
      OutputModeProber.isJsonSchemaFieldError(
        "Field 'response_format.json_schema' is not supported by this endpoint",
      ),
    ).toBe(true);
  });

  it('matches Gemini-style: invalid value + json_schema field', () => {
    expect(
      OutputModeProber.isJsonSchemaFieldError(
        "Invalid value for 'response_format.json_schema': schema not allowed",
      ),
    ).toBe(true);
  });

  it('does NOT match when only the verb is present (no field marker)', () => {
    expect(OutputModeProber.isJsonSchemaFieldError('Invalid value for max_tokens')).toBe(false);
    expect(OutputModeProber.isJsonSchemaFieldError('Unsupported model')).toBe(false);
  });

  it('does NOT match when only the field marker is present (no rejection verb)', () => {
    expect(OutputModeProber.isJsonSchemaFieldError('request body contains json_schema')).toBe(false);
  });

  it('does NOT match bare "json" alone (would collide with content-type / model name)', () => {
    expect(OutputModeProber.isJsonSchemaFieldError('Invalid json content')).toBe(false);
  });

  it('is case-insensitive on both verb and field', () => {
    expect(OutputModeProber.isJsonSchemaFieldError('UNSUPPORTED JSON_SCHEMA')).toBe(true);
  });

  it('handles empty / whitespace input safely', () => {
    expect(OutputModeProber.isJsonSchemaFieldError('')).toBe(false);
    expect(OutputModeProber.isJsonSchemaFieldError('   ')).toBe(false);
  });
});

describe('OutputModeProber.isJsonObjectFieldError — two-marker classifier for Tier 1 demotion (regression-guard)', () => {
  // Mirrors the v1.26.2 contract from json-object-strip-probe.ts:
  // same REJECTION_VERBS + FIELD_MARKERS list. If the classifier changes,
  // the contract test below will catch it.

  it('matches LM Studio 400 body verbatim (real-world case)', () => {
    expect(
      OutputModeProber.isJsonObjectFieldError(
        `'response_format.type' must be 'json_schema' or 'text'`,
      ),
    ).toBe(true);
  });

  it('matches OpenAI-style: unsupported + response_format field', () => {
    expect(
      OutputModeProber.isJsonObjectFieldError(
        "Unsupported value: 'response_format.type' = 'json_object'",
      ),
    ).toBe(true);
  });

  it('is case-insensitive on both verb and field', () => {
    expect(OutputModeProber.isJsonObjectFieldError('UNSUPPORTED RESPONSE_FORMAT')).toBe(true);
  });

  it('does NOT match when only the verb is present', () => {
    expect(OutputModeProber.isJsonObjectFieldError('Invalid value for max_tokens')).toBe(false);
  });

  it('does NOT match when only the field marker is present', () => {
    expect(OutputModeProber.isJsonObjectFieldError('response_format supplied')).toBe(false);
  });

  it('does NOT match unrelated 400s (status-only filters handled by TokenKeyProber)', () => {
    expect(OutputModeProber.isJsonObjectFieldError('Request too large')).toBe(false);
    expect(OutputModeProber.isJsonObjectFieldError('Invalid API key')).toBe(false);
    expect(OutputModeProber.isJsonObjectFieldError('Rate limit exceeded')).toBe(false);
  });
});

// v1.26.3 PATCH follow-up — REGRESSION GUARD for the bug surfaced by
// real E2E on LM Studio 0.4.20 (2026-08-10):
//
// AI SDK's APICallError.message is a FIXED template string
// ("Provider returned error") — it does NOT include the provider's
// actual error body. The provider body lives in `err.responseBody`.
// Both classifiers must be called with `err.responseBody`, NOT
// `err.message`. This test simulates the real shape and pins the
// contract (same pattern as reasoning-strip-probe.test.ts).
describe('Classifier input contract: responseBody vs message', () => {
  it('isJsonObjectFieldError matches the responseBody (LM Studio json_object 400)', () => {
    const err = new APICallError({
      message: 'Provider returned error',  // ← AI SDK template (NOT the real body)
      statusCode: 400,
      responseHeaders: {},
      url: 'http://localhost:1234/v1/chat/completions',
      requestBodyValues: {},
      responseBody: '{"error":"\'response_format.type\' must be \'json_schema\' or \'text\'"}',
    });

    // The bug: classifier was called with err.message — "Provider returned
    // error" — no field-rejection marker → false.
    expect(OutputModeProber.isJsonObjectFieldError(err.message ?? '')).toBe(false);
    // The fix: classifier is called with err.responseBody — real body
    // contains "must be" + "response_format" → true.
    expect(OutputModeProber.isJsonObjectFieldError(err.responseBody ?? '')).toBe(true);
  });
});