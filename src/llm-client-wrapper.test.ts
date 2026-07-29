import { describe, it, expect, vi } from 'vitest';
import { wrapWithAdvancedSettings, type WrapperSettings } from './llm-client-wrapper';
import type { LLMClient } from './types';

// The wrapper is where a setting becomes a request field, and every field it
// forwards is one the caller could also have set. Two rules hold for all of
// them: an unset setting sends nothing, and a caller who passed a value keeps
// it. Neither had a test, and the second is the one that silently breaks — a
// wrapper that overwrote its caller would make per-call overrides look like
// they applied while sending something else.

type SentBody = Record<string, unknown>;

function clientSpy() {
  const sentBodies: SentBody[] = [];
  const createMessage = vi.fn(async (body: SentBody) => {
    sentBodies.push(body);
    return 'ok';
  });
  const client = { createMessage } as unknown as LLMClient;
  return { client, sentBodies };
}

const CALL = { model: 'm', max_tokens: 100, messages: [{ role: 'user' as const, content: 'hi' }] };

function sent(settings: Partial<WrapperSettings>, params: SentBody = {}): SentBody {
  const { client, sentBodies } = clientSpy();
  const wrapped = wrapWithAdvancedSettings(client, { maxTokensPerCall: 0, ...settings });
  void wrapped.createMessage({ ...CALL, ...params } as Parameters<LLMClient['createMessage']>[0]);
  return sentBodies[0];
}

describe('wrapWithAdvancedSettings — settings become request fields', () => {
  it('sends nothing the user has not configured', () => {
    const body = sent({});
    for (const field of ['temperature', 'top_p', 'seed', 'repetition_penalty']) {
      expect(body).not.toHaveProperty(field);
    }
  });

  // Sampling is a preset, not a set of independent knobs. Forwarding the
  // temperature while dropping top_p leaves a run on half of one preset and
  // half of whatever the server defaults to — which is how two models were
  // compared for a while without noticing they were sampled differently.
  it('forwards the whole sampling preset, not half of it', () => {
    const body = sent({ extractionTemperature: 0.7, extractionTopP: 0.8 });
    expect(body.temperature).toBe(0.7);
    expect(body.top_p).toBe(0.8);
  });

  it('forwards the seed, which is what makes two runs comparable', () => {
    expect(sent({ samplingSeed: 42 }).seed).toBe(42);
  });

  it('leaves a caller-provided value alone', () => {
    const body = sent(
      { extractionTemperature: 0.7, extractionTopP: 0.8, samplingSeed: 42 },
      { temperature: 0.1, top_p: 0.95, seed: 7 },
    );
    expect([body.temperature, body.top_p, body.seed]).toEqual([0.1, 0.95, 7]);
  });

  it('treats zero as a value, not as unset', () => {
    // `temperature: 0` is the setting that matters most for extraction and is
    // the one a truthiness check drops.
    expect(sent({ extractionTemperature: 0 }).temperature).toBe(0);
  });
});
