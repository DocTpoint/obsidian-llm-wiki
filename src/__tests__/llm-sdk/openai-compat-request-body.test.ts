import { describe, it, expect, vi } from 'vitest';
import { OpenAICompatSdkClient } from '../../llm-sdk/openai-compat-sdk-client';

// Everything this client adds beyond the standard fields travels as
// `providerOptions`, and the AI SDK forwards those to the request body only
// under a key matching the provider's own name. The client was emitting them
// under a fixed `openaiCompatible` key instead, so for every openai-compatible
// provider — custom, Ollama, LM Studio — they were dropped silently.
//
// The existing test for this asserted the argument handed to `generateText`,
// which is exactly the value the SDK then discarded: it recorded the intent and
// was blind to the outcome. This one reads the request body.
describe('OpenAICompatSdkClient — what reaches the request body', () => {
  it('carries response_format, the thinking toggle and the seed', async () => {
    let body: Record<string, unknown> = {};
    const stub = vi.fn(async (_url: string, init?: { body?: unknown }) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        id: 'x', object: 'chat.completion', created: 0, model: 'm',
        choices: [{ index: 0, message: { role: 'assistant', content: '{}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const client = new OpenAICompatSdkClient({
      apiKey: 'k', baseURL: 'http://localhost/v1/', provider: 'custom',
      fetch: stub as never,
    });
    await client.createMessage({
      model: 'm', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }],
      response_format: { type: 'json_object' }, enableThinking: false, seed: 42,
      repetition_penalty: 1.05,
    });

    expect(body).toHaveProperty('seed', 42);
    expect(body).toHaveProperty('response_format');
    expect(body).toHaveProperty('chat_template_kwargs', { enable_thinking: false });
    // Under its wire name: llama.cpp, vLLM and Ollama all read
    // `repetition_penalty`, and a camelCased key travels but is ignored —
    // indistinguishable from not travelling at all.
    expect(body).toHaveProperty('repetition_penalty', 1.05);
  });

});
