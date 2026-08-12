// markdown.test.ts — prependReasoningForParse contract
//
// v1.26.x PATCH follow-up (LMStudio + Qwen3.5 — Issue #443 follow-up).
// The SDK's openai-compat client prepends `reasoning_content` to the
// visible response text. The previous contract wrapped reasoning in a
// `<think>...</think>` block, which caused `parseJsonResponse`'s block
// strip to discard the JSON-shaped reasoning payload before the
// balanced-JSON finder could reach it.
//
// `prependReasoningForParse` is the smart variant: keep the wrap only
// when reasoning already contains `<think>` tags (DeepSeek R1 / o-series
// contract), otherwise prepend raw so the structured payload survives
// parsing.
//
// Test matrix covers:
//   1. Empty reasoning → returns text unchanged
//   2. Reasoning already contains `<think>` → wrap with `<think>...</think>`
//      (preserves the DeepSeek-R1 / o-series contract that
//      extractThinkingBlocks in Query UI depends on).
//   3. Reasoning contains `<thinking>` → wrap (alternate XML form).
//   4. Reasoning with raw JSON, empty text → prepend raw (JSON survives).
//   5. Reasoning with raw JSON, non-empty text → prepend raw with
//      blank-line separator.
//   6. Literal `</think>` inside reasoning → escaped to prevent
//      premature block close by extractThinkingBlocks.

import { describe, it, expect } from 'vitest';
import { prependReasoningForParse } from '../../core/markdown';

describe('prependReasoningForParse — Issue #443 follow-up', () => {
  it('returns text unchanged when reasoning is empty', () => {
    expect(prependReasoningForParse('', 'visible body')).toBe('visible body');
    expect(prependReasoningForParse('', '')).toBe('');
  });

  it('wraps with <think> when reasoning already contains a <think> tag', () => {
    const reasoning = '<think>step 1: think</think>step 2: answer';
    const text = 'visible';
    const out = prependReasoningForParse(reasoning, text);
    expect(out).toMatch(/<think>/);
    expect(out).toMatch(/<\/think>/);
    // The wrap-format must still include the visible text after the block.
    expect(out).toContain('visible');
  });

  it('wraps reasoning when it contains any <think>/<thinking> opening tag', () => {
    // Once a tag is present, the function delegates to wrapReasoningContent
    // (which always uses `<think>...</think>`) so the existing Query UI
    // contract holds. The internal `<thinking>` opens are still safely
    // escaped so they do not close the outer wrap prematurely.
    const reasoning = '<thinking>alt reasoning</thinking>rest';
    const out = prependReasoningForParse(reasoning, 'visible');
    // wrapReasoningContent always emits `<think>...</think>` as the outer pair.
    expect(out.startsWith('<think>')).toBe(true);
    expect(out).toContain('<\/think>'); // outer block close
    // Inner `<thinking>` opener is preserved verbatim (not re-wrapped).
    expect(out).toContain('<thinking>alt reasoning');
    expect(out).toContain('visible');
  });

  it('prepends raw JSON-shaped reasoning without wrapping when no tags present', () => {
    const reasoning = '{"entities": [{"name": "X"}]}';
    const out = prependReasoningForParse(reasoning, '');
    // Must NOT be wrapped — JSON must be parseable by the balanced-JSON
    // finder downstream.
    expect(out).not.toMatch(/^<think>/);
    expect(out).toContain('"entities"');
    // Ends with blank-line separator so visible text follows cleanly if any.
    expect(out.endsWith('\n\n')).toBe(true);
  });

  it('prepends raw reasoning before non-empty text using blank-line separator', () => {
    const reasoning = '{"entities": [{"name": "X"}]}';
    const text = 'visible answer';
    const out = prependReasoningForParse(reasoning, text);
    expect(out).not.toMatch(/<think>/);
    expect(out).toContain('"entities"');
    expect(out.endsWith('visible answer')).toBe(true);
    expect(out).toContain('\n\n');
  });

  it('escapes literal </think inside reasoning to prevent premature block close', () => {
    const reasoning = 'hello </think> world';
    const out = prependReasoningForParse(reasoning, '');
    // The escape prevents extractThinkingBlocks regex from mis-splitting.
    expect(out).toContain('<\\/think');
  });
});