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

  it('invalidate() clears all entries when called with no argument', () => {
    const prober = new ReasoningStripProber();
    prober.markStrip('https://a.example/v1');
    prober.markStrip('https://b.example/v1');
    prober.invalidate();
    expect(prober.shouldStrip('https://a.example/v1')).toBe(false);
    expect(prober.shouldStrip('https://b.example/v1')).toBe(false);
  });

  it('invalidate(baseURL) clears only that baseURL', () => {
    const prober = new ReasoningStripProber();
    prober.markStrip('https://a.example/v1');
    prober.markStrip('https://b.example/v1');
    prober.invalidate('https://a.example/v1');
    expect(prober.shouldStrip('https://a.example/v1')).toBe(false);
    expect(prober.shouldStrip('https://b.example/v1')).toBe(true);
  });
});

describe('ReasoningStripProber.isReasoningFieldError', () => {
  it('matches "reasoning_effort" in body', () => {
    expect(
      ReasoningStripProber.isReasoningFieldError(
        "Invalid value for 'reasoning_effort': 'none'",
      ),
    ).toBe(true);
  });

  it('matches "thinking" in body', () => {
    expect(
      ReasoningStripProber.isReasoningFieldError(
        "Field 'thinking.type' is not supported by this endpoint",
      ),
    ).toBe(true);
  });

  it('matches "chat_template" in body', () => {
    expect(
      ReasoningStripProber.isReasoningFieldError(
        'Unknown parameter: chat_template_kwargs',
      ),
    ).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(ReasoningStripProber.isReasoningFieldError('REASONING_EFFORT not supported')).toBe(true);
    expect(ReasoningStripProber.isReasoningFieldError('Thinking Disabled')).toBe(true);
    expect(ReasoningStripProber.isReasoningFieldError('CHAT_TEMPLATE missing')).toBe(true);
  });

  it('matches kebab-case variants', () => {
    expect(ReasoningStripProber.isReasoningFieldError('reasoning-effort not supported')).toBe(true);
    expect(ReasoningStripProber.isReasoningFieldError('chat-template error')).toBe(true);
  });

  it('does NOT match unrelated 400s', () => {
    // max_tokens vs max_completion_tokens is handled by TokenKeyProber
    expect(ReasoningStripProber.isReasoningFieldError('Invalid value for max_tokens')).toBe(false);
    // 413 size limit
    expect(ReasoningStripProber.isReasoningFieldError('Request too large')).toBe(false);
    // 5xx server error
    expect(ReasoningStripProber.isReasoningFieldError('Internal server error')).toBe(false);
    // 401 auth
    expect(ReasoningStripProber.isReasoningFieldError('Invalid API key')).toBe(false);
  });

  it('does NOT match "temperature" alone (no overlap)', () => {
    // Defensive — substring match could in principle false-positive on
    // 'tempeRATURE-thinking-...'. Lock the negative case.
    expect(ReasoningStripProber.isReasoningFieldError('Invalid temperature value')).toBe(false);
  });

  it('handles empty / whitespace input safely', () => {
    expect(ReasoningStripProber.isReasoningFieldError('')).toBe(false);
    expect(ReasoningStripProber.isReasoningFieldError('   ')).toBe(false);
  });
});