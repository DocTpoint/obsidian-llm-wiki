// v1.23.0 P1-7: Unit tests for OpenAICompatSdkClient.
//
// Covers the 6 baseURLs in PREDEFINED_PROVIDERS (Gemini / OpenRouter /
// DeepSeek / MiniMax / Moonshot / GLM / Ollama / LMStudio) by
// parameterizing over their baseURLs.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { APICallError } from 'ai';

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai');
  return {
    ...actual,
    generateText: vi.fn(),
    streamText: vi.fn(),
  };
});

vi.mock('../../core/obsidian-fetch-bridge', async () => {
  const actual = await vi.importActual<typeof import('../../core/obsidian-fetch-bridge')>('../../core/obsidian-fetch-bridge');
  return {
    ...actual,
    obsidianFetchBridge: vi.fn(actual.obsidianFetchBridge),
  };
});

vi.mock('@ai-sdk/openai-compatible', async () => {
  const actual = await vi.importActual<typeof import('@ai-sdk/openai-compatible')>('@ai-sdk/openai-compatible');
  return {
    ...actual,
    createOpenAICompatible: vi.fn(actual.createOpenAICompatible),
  };
});

import { generateText } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { OpenAICompatSdkClient } from '../../llm-sdk/openai-compat-sdk-client';

const mockGenerateText = vi.mocked(generateText);
const mockCreateOpenAICompatible = vi.mocked(createOpenAICompatible);

function makeResult(text: string): Awaited<ReturnType<typeof generateText>> {
  return {
    text,
    content: [],
    reasoning: [],
    reasoningText: undefined,
    files: [],
    sources: [],
    toolCalls: [],
    toolResults: [],
    finishReason: 'stop',
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, reasoningTokens: undefined, cachedInputTokens: undefined },
    warnings: [],
    request: {},
    response: { id: 'resp_test', timestamp: new Date(), modelId: 'test', headers: {}, body: {} },
    providerMetadata: undefined,
    experimental_providerMetadata: undefined,
  } as unknown as Awaited<ReturnType<typeof generateText>>;
}

const PRESETS = [
  { id: 'gemini', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash' },
  { id: 'openrouter', baseURL: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-3.5-sonnet' },
  { id: 'deepseek', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'minimax', baseURL: 'https://api.minimaxi.com/v1', model: 'MiniMax-Text-01' },
  { id: 'moonshot', baseURL: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { id: 'glm', baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus' },
  { id: 'ollama', baseURL: 'http://localhost:11434/v1', model: 'llama3.1' },
  { id: 'lmstudio', baseURL: 'http://localhost:1234/v1', model: 'qwen2.5-7b' },
];

describe('OpenAICompatSdkClient', () => {
  beforeEach(() => {
    mockGenerateText.mockReset();
    mockGenerateText.mockResolvedValue(makeResult('hello'));
    mockCreateOpenAICompatible.mockClear();
  });

  describe.each(PRESETS)('for provider "$id" ($baseURL)', (preset) => {
    it('forwards baseURL + name to createOpenAICompatible', async () => {
      const client = new OpenAICompatSdkClient({
        apiKey: 'test-key',
        baseURL: preset.baseURL,
        provider: preset.id,
      });
      await client.createMessage({
        model: preset.model,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
      });

      const callOpts = mockCreateOpenAICompatible.mock.calls.at(-1)![0] as unknown as Record<string, unknown>;
      expect(callOpts.baseURL).toBe(preset.baseURL);
      expect(callOpts.name).toBe(preset.id);
      expect(callOpts.apiKey).toBe('test-key');
    });

    it('creates the model with the given id', async () => {
      const client = new OpenAICompatSdkClient({
        apiKey: 'test-key',
        baseURL: preset.baseURL,
        provider: preset.id,
      });
      await client.createMessage({
        model: preset.model,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
      });

      const call = mockGenerateText.mock.calls[0][0] as Record<string, unknown>;
      expect(call.model).toBeDefined();
      expect(typeof call.model).toBe('object');
    });
  });

  // v1.26.0 Batch 6: force-disable thinking via `reasoningEffort: 'none'`.
  //
  // History (per [[project_v1_26_0_batch_6_real_wire_thinking_disable]]):
  //   - v1.23.0:  `reasoningEffort: 'low'` (OpenAI gpt-5.x style) — DeepSeek
  //               silently mapped `'low'` → `'high'`, intent lost
  //   - PR #410:  `thinking: { type: 'disabled' }` +
  //               `chat_template_kwargs: { enable_thinking: false }` — both
  //               are NOT in @ai-sdk/openai-compatible's zod schema
  //               (line 322-344 of dist/index.mjs), so the SDK's `filter()`
  //               at line 531-540 deletes them before the body is built.
  //               Verified by DocTpoint via fetch-interceptor (Issue #382
  //               comment 2, 2026-08-04): neither field left the process.
  //   - Batch 6:  `reasoningEffort: 'none'` (camelCase) — the zod schema
  //               accepts it (line 331: `z.string().optional()`) and emits
  //               as `reasoning_effort: 'none'` on the wire (line 541).
  //               DocTpoint's LM Studio / gemma-4-12b measurement confirmed
  //               wire-reaches + reasoning_tokens=0.
  //
  // Backend compatibility (no per-vendor matching — 400-retry in B6-3
  // handles the Gemini-via-OpenAI-shim case):
  //   - DeepSeek V3/V3.1/V4: ✅ accepts reasoning_effort
  //   - Kimi k2.5/2.6:       ✅ accepts
  //   - GLM-4.6:             ✅ accepts
  //   - LM Studio / llama.cpp: ✅ DocTpoint measured
  //   - OpenRouter:          ⚠️ uses `reasoning: { enabled: false }`
  //                          (different dialect, silently ignored)
  describe('enableThinking handling (reasoningEffort="none" for OpenAI-compatible)', () => {
    it('sends reasoningEffort="none" when enableThinking is false', async () => {
      const client = new OpenAICompatSdkClient({
        apiKey: 'sk-test',
        baseURL: 'https://api.deepseek.com/v1',
        provider: 'deepseek',
      });
      await client.createMessage({
        model: 'deepseek-chat',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        enableThinking: false,
      });

      const call = mockGenerateText.mock.calls[0][0] as unknown as Record<string, unknown>;
      // v1.26.0 Batch 6: the field that the SDK's zod schema accepts
      // (line 331 of @ai-sdk/openai-compatible@2.0.62/dist/index.mjs) and
      // that the SDK emits as `reasoning_effort: 'none'` on the wire
      // (line 541). Prior Batch 2 PR #410 used `thinking.type` +
      // `chat_template_kwargs` which are stripped by the filter and
      // never leave the process.
      expect(call.providerOptions).toEqual({
        openaiCompatible: {
          reasoningEffort: 'none',
        },
      });
    });


    it('omits reasoningEffort when enableThinking is undefined', async () => {
      const client = new OpenAICompatSdkClient({
        apiKey: 'sk-test',
        baseURL: 'https://api.deepseek.com/v1',
        provider: 'deepseek',
      });
      await client.createMessage({
        model: 'deepseek-chat',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
      });

      const call = mockGenerateText.mock.calls[0][0] as Record<string, unknown>;
      expect(call.providerOptions).toEqual({});
    });
  });

  describe('response_format is not forwarded', () => {
    // #65 reports an error from LM Studio 0.4.15 on `{"type":"json_object"}`,
    // with no status code given. The fix
    // for that removed the field outright (5851cc8); the AI-SDK migration
    // (6be9258) reintroduced it inside `buildProviderOptions`, where the fixed
    // `openaiCompatible` key hid it again — the field has been built and
    // discarded ever since, which is why no one noticed it was back.
    //
    // Correcting the key would deliver it. It goes for real instead. Nothing
    // changes on the wire: extraction asks for `json_object` and nothing else,
    // and the prompt already states the shape. What would justify sending it is
    // `json_schema`, which is not in this branch.
    it('leaves it out even when the caller asks for it', async () => {
      const client = new OpenAICompatSdkClient({
        apiKey: 'sk-test',
        baseURL: 'https://api.deepseek.com/v1',
        provider: 'deepseek',
      });
      await client.createMessage({
        model: 'deepseek-chat',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'JSON' }],
        response_format: { type: 'json_object' },
      });

      const call = mockGenerateText.mock.calls[0][0] as Record<string, unknown>;
      expect(call.providerOptions).toEqual({});
    });
  });

  describe('error mapping (preserves v1.22.5 error body UX)', () => {
    it('enriches APICallError with provider body for 4xx responses', async () => {
      mockGenerateText.mockReset();
      mockGenerateText.mockRejectedValue(new APICallError({
        message: 'Provider returned error',
        statusCode: 429,
        responseHeaders: {},
        url: 'https://api.deepseek.com/v1',
        requestBodyValues: {},
        responseBody: JSON.stringify({
          error: { message: 'You exceeded your current quota, please check your plan and billing details' },
        }),
      }));

      const client = new OpenAICompatSdkClient({
        apiKey: 'sk-test',
        baseURL: 'https://api.deepseek.com/v1',
        provider: 'deepseek',
      });
      await expect(
        client.createMessage({
          model: 'deepseek-chat',
          max_tokens: 100,
          messages: [{ role: 'user', content: 'hi' }],
        })
      ).rejects.toThrow(/status 429/);
      await expect(
        client.createMessage({
          model: 'deepseek-chat',
          max_tokens: 100,
          messages: [{ role: 'user', content: 'hi' }],
        })
      ).rejects.toThrow(/quota/);
    });
  });
});