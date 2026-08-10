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

  describe('response_format: no-schema case sets output=Output.json() for the SDK to encode (Issue #443 elegant fallback)', () => {
    // v1.26.3 PATCH follow-up (elegant fallback) supersedes Option 1:
    //
    //   Option 1 (shipped in e053cef): buildOutputArgs returned `{}` for
    //   the no-schema case — `Output.json()` was never invoked, no
    //   `output` was set, the SDK never saw a `response_format` field.
    //   Rationale: LM Studio rejects `json_object` with HTTP 400
    //   (DocTpoint Issue #443 comment 1, 2026-08-09) — skip the field
    //   to avoid 400. Cost: the 6 cloud providers (deepseek / openrouter
    //   / kimi / glm / gemini / minimax) lose the server-side type hint
    //   that reduces parse-failure class of issues.
    //
    //   Elegant fallback (this follow-up): buildOutputArgs returns
    //   `{ output: Output.json() }` for the no-schema case. The SDK
    //   encodes `response_format: { type: 'json_object' }` on the wire
    //   for every openai-compat provider. The 6 cloud providers accept
    //   it (server-side type hint restored). The local-server cohort
    //   (LM Studio / Ollama / `custom`) that rejects the field is
    //   caught by the json-object-strip 400-retry at the client
    //   level (json-object-strip-probe.ts) — the cost is one 400 per
    //   unique baseURL, then cache hit and the wire field is dropped
    //   silently thereafter. No provider is hardcoded in the helper.
    //
    // This test pins the SDK-client call-site boundary: `output` IS
    // set (so the SDK encodes `json_object` on the wire). The
    // wire-body assertion in `openai-compat-request-body.test.ts`
    // pins what the SDK actually sends.
    it('sets top-level output=Output.json() when caller asks for json_object without schema', async () => {
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
      // Issue #443 elegant-fallback contract: no-schema case → `output`
      // is set (the SDK encodes it as `json_object` on the wire). The
      // strip probe at the client level handles backends that 400 on
      // the field (LM Studio is the measured case). The wire-body test
      // in `openai-compat-request-body.test.ts` pins the actual wire
      // shape: `{type:'json_object'}`.
      expect(call.output).toBeDefined();
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

  // v1.26.0 Batch 6: Layer-3 400-retry integration tests. Regression
  // guard for the force-disable-thinking mechanism — when the backend
  // rejects reasoning_effort='none' with HTTP 400, the client must
  // strip the field and retry exactly once, then cache the strip
  // decision so subsequent calls skip the probe.
  describe('reasoning-strip 400-retry (v1.26.0 Batch 6 Layer 3)', () => {
    it('retries without reasoningEffort after 400 mentioning reasoning_effort', async () => {
      mockGenerateText.mockReset();
      mockGenerateText
        .mockRejectedValueOnce(new APICallError({
          message: "Invalid value for 'reasoning_effort': 'none' is not supported",
          statusCode: 400,
          responseHeaders: {},
          url: 'https://api.deepseek.com/v1',
          requestBodyValues: {},
          responseBody: '{"error":{"message":"Invalid value for reasoning_effort"}}',
        }))
        .mockResolvedValueOnce(makeResult('hello'));

      const client = new OpenAICompatSdkClient({
        apiKey: 'sk-test',
        baseURL: 'https://api.deepseek.com/v1',
        provider: 'deepseek',
      });
      const text = await client.createMessage({
        model: 'deepseek-chat',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        enableThinking: false,
      });

      expect(text).toBe('hello');
      expect(mockGenerateText).toHaveBeenCalledTimes(2);

      // First call: reasoningEffort='none' is present
      const firstCall = mockGenerateText.mock.calls[0][0] as Record<string, unknown>;
      expect(firstCall.providerOptions).toEqual({
        openaiCompatible: { reasoningEffort: 'none' },
      });

      // Second call: reasoningEffort stripped
      const secondCall = mockGenerateText.mock.calls[1][0] as Record<string, unknown>;
      expect(secondCall.providerOptions).toEqual({});
    });

    it('caches the strip decision per baseURL — second call skips the 400', async () => {
      mockGenerateText.mockReset();
      // First call to this baseURL: 400 then retry success
      mockGenerateText
        .mockRejectedValueOnce(new APICallError({
          // v1.26.3 PATCH follow-up: simulate the real AI SDK APICallError
          // shape — `message` is the AI SDK template, `responseBody` is
          // the provider's actual body. The reasoning-strip classifier
          // now checks responseBody (not message). This matches what
          // the wire produces in production.
          message: 'Provider returned error',
          statusCode: 400,
          responseHeaders: {},
          url: 'https://api.deepseek.com/v1',
          requestBodyValues: {},
          responseBody: '{"error":{"message":"Invalid value for reasoning_effort"}}',
        }))
        .mockResolvedValueOnce(makeResult('hello-1'));
      // Second call: should NOT 400 again — strip is cached, the call
      // goes out without reasoningEffort from the start
      mockGenerateText.mockResolvedValueOnce(makeResult('hello-2'));

      const client = new OpenAICompatSdkClient({
        apiKey: 'sk-test',
        baseURL: 'https://api.deepseek.com/v1',
        provider: 'deepseek',
      });

      // First invocation: triggers 400 → retry → cache strip
      const text1 = await client.createMessage({
        model: 'deepseek-chat',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        enableThinking: false,
      });
      expect(text1).toBe('hello-1');
      expect(mockGenerateText).toHaveBeenCalledTimes(2);

      // Second invocation: cache hit, only ONE call, no reasoningEffort
      const text2 = await client.createMessage({
        model: 'deepseek-chat',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        enableThinking: false,
      });
      expect(text2).toBe('hello-2');
      expect(mockGenerateText).toHaveBeenCalledTimes(3); // 1st = 400, 2nd = retry-success, 3rd = second-call (single)

      const thirdCall = mockGenerateText.mock.calls[2][0] as Record<string, unknown>;
      expect(thirdCall.providerOptions).toEqual({});
    });

    it('does NOT add reasoningEffort when enableThinking is undefined (no override)', async () => {
      // When the user did NOT explicitly disable thinking, we don't
      // send reasoningEffort at all, so the 400 can't be on that field
      // in our config. The token-key retry may still fire (any 400
      // triggers it) but it does not add reasoningEffort either.
      mockGenerateText.mockReset();
      mockGenerateText.mockRejectedValue(new APICallError({
        // Real AI SDK shape — see comment above (line 325-333).
        message: 'Provider returned error',
        statusCode: 400,
        responseHeaders: {},
        url: 'https://api.deepseek.com/v1',
        requestBodyValues: {},
        responseBody: '{"error":{"message":"Invalid value for reasoning_effort"}}',
      }));

      const client = new OpenAICompatSdkClient({
        apiKey: 'sk-test',
        baseURL: 'https://api.deepseek.com/v1',
        provider: 'deepseek',
      });
      // v1.26.3 PATCH follow-up: the AI SDK's APICallError.message is
      // a fixed template ("Provider returned error"). The real
      // provider body is in responseBody. Assert the body carries
      // the reasoning_effort marker (the actual content the user
      // cares about), not the message string.
      await expect(
        client.createMessage({
          model: 'deepseek-chat',
          max_tokens: 100,
          messages: [{ role: 'user', content: 'hi' }],
          // enableThinking intentionally not set
        }),
      ).rejects.toMatchObject({
        responseBody: expect.stringContaining('reasoning_effort'),
      });
      // The original call AND the token-key retry fire (any 400 →
      // token-key retry) — but no reasoningEffort is added in either
      // call because enableThinking !== false.
      expect(mockGenerateText).toHaveBeenCalledTimes(2);
      const firstCall = mockGenerateText.mock.calls[0][0] as Record<string, unknown>;
      const secondCall = mockGenerateText.mock.calls[1][0] as Record<string, unknown>;
      expect(firstCall.providerOptions).toEqual({});
      expect(secondCall.providerOptions).toEqual({});
    });

    it('does NOT retry on 400 mentioning max_tokens (handled by TokenKeyProber instead)', async () => {
      // Sanity check: the reasoning-strip retry should NOT swallow 400s
      // that belong to the token-key mechanism. The 400 here mentions
      // max_tokens only — token-key retry handles it.
      mockGenerateText.mockReset();
      mockGenerateText
        .mockRejectedValueOnce(new APICallError({
          // Real AI SDK APICallError shape — responseBody carries the
          // provider's actual body, message is the AI SDK template.
          // The body mentions max_tokens only (no reasoning field
          // marker), so the reasoning-strip probe must NOT fire.
          message: 'Provider returned error',
          statusCode: 400,
          responseHeaders: {},
          url: 'https://api.deepseek.com/v1',
          requestBodyValues: {},
          responseBody: '{"error":{"message":"Invalid value for max_tokens"}}',
        }))
        .mockResolvedValueOnce(makeResult('hello'));

      const client = new OpenAICompatSdkClient({
        apiKey: 'sk-test',
        baseURL: 'https://api.deepseek.com/v1',
        provider: 'deepseek',
      });
      const text = await client.createMessage({
        model: 'deepseek-chat',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        enableThinking: false,
      });
      expect(text).toBe('hello');
      // Two calls — token-key retry path (different from reasoning-strip).
      // We don't assert which retry fired, only that the 400 was handled.
      expect(mockGenerateText).toHaveBeenCalledTimes(2);
    });
  });

  // v1.26.3 PATCH follow-up (Issue #443 elegant fallback): a 400 with
  // a `json_object` / `response_format` field marker triggers a one-shot
  // retry that omits `output` entirely, and caches the strip decision
  // per baseURL. Mirrors the reasoning-strip pattern (same Probe-class
  // design) but applies to the no-schema path. The strip decision is
  // committed AFTER the retry succeeds — a transient 5xx on the retry
  // must not permanently disable `json_object` for the baseURL.
  describe('json-object-strip 400-retry (v1.26.3 PATCH follow-up to #443)', () => {
    it('retries without output after 400 mentioning json_object / response_format', async () => {
      mockGenerateText.mockReset();
      mockGenerateText
        .mockRejectedValueOnce(new APICallError({
          message: "'response_format.type' must be 'json_schema' or 'text'",
          statusCode: 400,
          responseHeaders: {},
          url: 'https://api.deepseek.com/v1',
          requestBodyValues: {},
          responseBody: '{"error":{"message":"response_format.type must be json_schema or text"}}',
        }))
        .mockResolvedValueOnce(makeResult('hello'));

      const client = new OpenAICompatSdkClient({
        apiKey: 'sk-test',
        baseURL: 'https://api.deepseek.com/v1',
        provider: 'deepseek',
      });
      const text = await client.createMessage({
        model: 'deepseek-chat',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        response_format: { type: 'json_object' },
      });

      expect(text).toBe('hello');
      expect(mockGenerateText).toHaveBeenCalledTimes(2);

      // First call: response_format: json_object IS on the wire
      const firstCall = mockGenerateText.mock.calls[0][0] as Record<string, unknown>;
      expect(firstCall.output).toBeDefined();

      // Second call: output is undefined (the strip)
      const secondCall = mockGenerateText.mock.calls[1][0] as Record<string, unknown>;
      expect(secondCall.output).toBeUndefined();
    });

    it('caches the strip decision per baseURL — second call skips the 400', async () => {
      mockGenerateText.mockReset();
      // First call: 400 then retry success
      mockGenerateText
        .mockRejectedValueOnce(new APICallError({
          // Real AI SDK APICallError shape — responseBody carries the
          // provider's actual body. This is the LM Studio 0.4.20 +
          // qwythos-9b-claude-mythos-5-1m-mlx body from the 2026-08-10
          // E2E that surfaced the err.message vs err.responseBody bug.
          message: 'Provider returned error',
          statusCode: 400,
          responseHeaders: {},
          url: 'https://api.deepseek.com/v1',
          requestBodyValues: {},
          responseBody: '{"error":"\'response_format.type\' must be \'json_schema\' or \'text\'"}',
        }))
        .mockResolvedValueOnce(makeResult('hello-1'));
      // Second call: should NOT 400 — strip is cached, output omitted from the start
      mockGenerateText.mockResolvedValueOnce(makeResult('hello-2'));

      const client = new OpenAICompatSdkClient({
        apiKey: 'sk-test',
        baseURL: 'https://api.deepseek.com/v1',
        provider: 'deepseek',
      });

      // First invocation: triggers 400 → retry → cache strip
      const text1 = await client.createMessage({
        model: 'deepseek-chat',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        response_format: { type: 'json_object' },
      });
      expect(text1).toBe('hello-1');
      expect(mockGenerateText).toHaveBeenCalledTimes(2);

      // Second invocation: cache hit, only ONE call, no output
      const text2 = await client.createMessage({
        model: 'deepseek-chat',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        response_format: { type: 'json_object' },
      });
      expect(text2).toBe('hello-2');
      expect(mockGenerateText).toHaveBeenCalledTimes(3); // 1st=400, 2nd=retry-success, 3rd=second-call-single

      const thirdCall = mockGenerateText.mock.calls[2][0] as Record<string, unknown>;
      expect(thirdCall.output).toBeUndefined();
    });

    it('does NOT trigger strip on non-400 errors (e.g., 500, 401, 429)', async () => {
      // The strip retry is gated on statusCode === 400 + a json_object /
      // response_format field marker. Other status codes must NOT
      // trigger the strip — the existing token-key / URL-fallback paths
      // handle those, and silently disabling `json_object` for a
      // 500/401/429 would be a wrong cache decision.
      for (const statusCode of [500, 401, 429] as const) {
        mockGenerateText.mockReset();
        mockGenerateText.mockRejectedValue(new APICallError({
          // Real AI SDK shape — generic server error. No json_object /
          // response_format field marker in the body, so even on 400
          // the strip would not fire. statusCode guards the first
          // gate, field marker guards the second.
          message: 'Provider returned error',
          statusCode,
          responseHeaders: {},
          url: 'https://api.deepseek.com/v1',
          requestBodyValues: {},
          responseBody: '{"error":{"message":"server error"}}',
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
            response_format: { type: 'json_object' },
          })
        ).rejects.toThrow();
        // Single call: no retry, no strip probe. (Token-key fallback
        // would fire for some 400s, but for 500/401/429 it doesn't —
        // and even if it did, that's a different retry path that does
        // not omit `output`.)
        expect(mockGenerateText.mock.calls.length, `statusCode=${statusCode}`).toBeLessThanOrEqual(2);
      }
    });

    it('does NOT trigger strip when caller did not pass response_format', async () => {
      // No response_format → no `output` set → no json_object on the
      // wire → the 400 must not be misclassified as a json_object
      // rejection. Mirrors the reasoning-strip "no override → no field"
      // pattern.
      mockGenerateText.mockReset();
      mockGenerateText.mockRejectedValue(new APICallError({
        // Real AI SDK shape — body carries reasoning_effort, no
        // json_object marker. Reasoning-strip probe fires (because
        // the message identifies reasoning_effort as the cause);
        // json-object-strip does NOT (caller did not pass
        // response_format, and body has no json_object marker).
        message: 'Provider returned error',
        statusCode: 400,
        responseHeaders: {},
        url: 'https://api.deepseek.com/v1',
        requestBodyValues: {},
        responseBody: '{"error":{"message":"Invalid value for \'reasoning_effort\'"}}',
      }));

      const client = new OpenAICompatSdkClient({
        apiKey: 'sk-test',
        baseURL: 'https://api.deepseek.com/v1',
        provider: 'deepseek',
      });
      // The 400 here mentions reasoning_effort (not json_object), so
      // the reasoning-strip retry fires — but the json-object-strip
      // does NOT (the strip cache stays empty for this baseURL).
      // v1.26.3 PATCH follow-up: AI SDK's APICallError.message is a
      // fixed template; the real body is in responseBody. Assert the
      // body content (what the user cares about), not the message
      // string. Also assert the reasoning-strip branch fired (call
      // count = 2: original + retry without reasoning_effort), which
      // is the actual behavior we want to pin.
      await expect(
        client.createMessage({
          model: 'deepseek-chat',
          max_tokens: 100,
          messages: [{ role: 'user', content: 'hi' }],
          // response_format intentionally not set
        }),
      ).rejects.toMatchObject({
        responseBody: expect.stringContaining('reasoning_effort'),
      });
      // Reasoning-strip retry fired (1 = original, 2 = retry without
      // reasoning_effort). Json-object-strip did NOT fire — total calls
      // is exactly 2, not 3.
      expect(mockGenerateText).toHaveBeenCalledTimes(2);
    });
  });
});