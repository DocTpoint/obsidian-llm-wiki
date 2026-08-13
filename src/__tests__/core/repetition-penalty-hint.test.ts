// repetition-penalty-hint.test.ts
//
// v1.26.3 PATCH follow-up (user E2E 2026-08-13): a custom `repetitionPenalty`
// above 1.0 was confirmed (on qwen3.5-9b / gemma-4-12b via LM Studio) to
// break grammar-constrained extraction — the model bails with empty or
// mis-structured JSON, and the ingest fails with a generic "Source analysis
// failed" message that never mentioned the setting. This helper appends a
// localized hint to that failure message ONLY when the user opted into the
// setting, so the fix is actionable.

import { describe, it, expect } from 'vitest';
import { buildRepetitionPenaltyHint } from '../../core/repetition-penalty-hint';

describe('buildRepetitionPenaltyHint', () => {
  it('returns an empty string when no custom repetitionPenalty is set', () => {
    expect(buildRepetitionPenaltyHint('en', undefined)).toBe('');
    // 1.0 is a no-op value (no penalty) — a user who set it deliberately is
    // not at risk, but the value is still "custom". Treat any defined value
    // as opted-in so the hint surfaces for the exact failure class.
    expect(buildRepetitionPenaltyHint('en', 1.0)).toContain('1.0');
  });

  it('interpolates the set value into the localized hint', () => {
    const hint = buildRepetitionPenaltyHint('en', 1.5);
    expect(hint).toContain('1.5');
    expect(hint.toLowerCase()).toContain('repetition penalty');
    expect(hint.toLowerCase()).toContain('reduce');
  });

  it('returns a string meant to be appended (leading separator, empty when unset)', () => {
    const set = buildRepetitionPenaltyHint('en', 1.5);
    expect(set.startsWith(' ')).toBe(true);
    expect(buildRepetitionPenaltyHint('en', undefined)).toBe('');
  });

  it('localizes the hint per language while keeping the value', () => {
    const zh = buildRepetitionPenaltyHint('zh', 1.5);
    expect(zh).toContain('1.5');
    expect(zh).not.toBe(buildRepetitionPenaltyHint('en', 1.5));
  });
});
