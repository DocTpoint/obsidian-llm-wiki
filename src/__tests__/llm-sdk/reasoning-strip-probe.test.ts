import { describe, it, expect } from 'vitest';
import { ReasoningStripProber } from '../../llm-sdk/reasoning-strip-probe';

// v1.26.0 Batch 6: per-baseURL "strip reasoningEffort" cache, plus the
// message-match classifier that decides whether a 400 is reasoning-related
// (Layer 3 of the 4-layer force-disable fallback).
//
// PR #410 / Batch 2 had no equivalent test — the SDK's silent field-stripping
// (zod schema filter at line 531-540 of @ai-sdk/openai-compatible@2.0.62)
// shipped without a regression guard. This file is the explicit guard for
// Batch 6: if the cache or the classifier ever drift, the tests fail.

describe('ReasoningStripProber', () => {
  it('starts empty for any baseURL', () => {
    const prober = new ReasoningStripProber();
    expect(prober.shouldStrip('https://api.deepseek.com/v1')).toBe(false);
    expect(prober.shouldStrip('https://api.example.com/v1')).toBe(false);
  });

  it('markStrip + shouldStrip round-trip per baseURL', () => {
    const prober = new ReasoningStripProber();
    prober.markStrip('https://api.deepseek.com/v1');
    expect(prober.shouldStrip('https://api.deepseek.com/v1')).toBe(true);
    // Different baseURL unaffected
    expect(prober.shouldStrip('https://api.openai.com/v1')).toBe(false);
  });

  // v1.26.0 Batch 6 review (PR #411 simplify 2026-08-05): the previous
  // `invalidate(baseUrl?)` overload was deleted (zero production
  // callers — only the test exercised it). The cache now exposes only
  // `shouldStrip` + `markStrip`; if a "user changed baseURL → re-probe"
  // hook ever needs to drop the cache, it's a one-line edit to add
  // back. The tests for invalidate() are removed with the method.
});

describe('ReasoningStripProber.isReasoningFieldError — two-marker (verb + field) classifier', () => {
  // v1.26.0 Batch 6 CR-2: the previous classifier matched any substring
  // of `reasoning_effort` / `thinking` / `chat_template` etc. The bare
  // word `thinking` collided with model names (`kimi-k2-thinking`,
  // `qwen3-235b-a22b-thinking-2507`, `glm-4.6-thinking`), causing
  // false-positive strip decisions on `*-thinking` model users. New
  // classifier requires BOTH a rejection verb AND a field marker.

  it('matches Gemini-style: rejection verb + reasoning_effort field', () => {
    expect(
      ReasoningStripProber.isReasoningFieldError(
        "Invalid value for 'reasoning_effort': 'none' is not supported",
      ),
    ).toBe(true);
  });

  it('matches Anthropic-style: unsupported + thinking.type field', () => {
    expect(
      ReasoningStripProber.isReasoningFieldError(
        "Field 'thinking.type' is not supported by this endpoint",
      ),
    ).toBe(true);
  });

  it('matches llama.cpp-style: unknown + chat_template_kwargs field', () => {
    expect(
      ReasoningStripProber.isReasoningFieldError(
        'Unknown parameter: chat_template_kwargs',
      ),
    ).toBe(true);
  });

  it('is case-insensitive on both verb and field', () => {
    expect(ReasoningStripProber.isReasoningFieldError('REASONING_EFFORT NOT SUPPORTED')).toBe(true);
    expect(ReasoningStripProber.isReasoningFieldError('unknown field ENABLE_THINKING')).toBe(true);
    expect(ReasoningStripProber.isReasoningFieldError('UNRECOGNIZED CHAT_TEMPLATE_KWARGS')).toBe(true);
  });

  it('matches kebab-case variants', () => {
    expect(ReasoningStripProber.isReasoningFieldError('unsupported reasoning-effort value')).toBe(true);
    expect(ReasoningStripProber.isReasoningFieldError('unknown chat-template-kwargs')).toBe(true);
  });

  // CR-2 regression: bare model names with 'thinking' substring must NOT
  // match. Without this guard, *-thinking model users would get their
  // baseURL permanently mis-stripped on the first 400 (bad model name,
  // context length, token-key mismatch).
  it('does NOT match model names containing "thinking"', () => {
    expect(ReasoningStripProber.isReasoningFieldError("Model 'kimi-k2-thinking' not found")).toBe(false);
    expect(ReasoningStripProber.isReasoningFieldError('model qwen3-235b-a22b-thinking-2507 is not loaded')).toBe(false);
    expect(ReasoningStripProber.isReasoningFieldError('Invalid value for max_tokens (model: glm-4.6-thinking)')).toBe(false);
    expect(ReasoningStripProber.isReasoningFieldError('context length exceeded for kimi-k2-thinking')).toBe(false);
  });

  it('does NOT match when only the verb is present (no field marker)', () => {
    // Generic 400 errors without the field marker must NOT trigger strip.
    expect(ReasoningStripProber.isReasoningFieldError('Invalid value for max_tokens')).toBe(false);
    expect(ReasoningStripProber.isReasoningFieldError('Unsupported model')).toBe(false);
  });

  it('does NOT match when only the field marker is present (no rejection verb)', () => {
    // Mention of the field name without a rejection verb (e.g. an info
    // log line) must NOT trigger strip.
    expect(ReasoningStripProber.isReasoningFieldError('request body contains reasoning_effort')).toBe(false);
    expect(ReasoningStripProber.isReasoningFieldError('chat_template_kwargs supplied')).toBe(false);
  });

  it('does NOT match unrelated 400s (status-only filters handled by TokenKeyProber)', () => {
    // 413 size limit
    expect(ReasoningStripProber.isReasoningFieldError('Request too large')).toBe(false);
    // 5xx server error
    expect(ReasoningStripProber.isReasoningFieldError('Internal server error')).toBe(false);
    // 401 auth
    expect(ReasoningStripProber.isReasoningFieldError('Invalid API key')).toBe(false);
    // 429 rate limit
    expect(ReasoningStripProber.isReasoningFieldError('Rate limit exceeded')).toBe(false);
  });

  it('does NOT match "temperature" alone (defensive — keyword could overlap)', () => {
    expect(ReasoningStripProber.isReasoningFieldError('Invalid temperature value')).toBe(false);
  });

  it('handles empty / whitespace input safely', () => {
    expect(ReasoningStripProber.isReasoningFieldError('')).toBe(false);
    expect(ReasoningStripProber.isReasoningFieldError('   ')).toBe(false);
  });
});