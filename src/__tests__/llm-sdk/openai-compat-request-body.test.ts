import { describe, it, expect, vi } from 'vitest';
import { OpenAICompatSdkClient } from '../../llm-sdk/openai-compat-sdk-client';

// Everything this client adds beyond the standard fields travels as
// `providerOptions`. The AI SDK forwards those to the request body only
// under a key matching the provider's own name, OR through fields declared
// in the SDK's zod schema (`openaiCompatibleLanguageModelChatOptions`,
// @ai-sdk/openai-compatible@2.0.62/dist/index.mjs:322-344).
//
// v1.26.0 Batch 6: `reasoningEffort` IS in the zod schema (line 331:
// `z.string().optional()`) and IS emitted to the wire as `reasoning_effort`
// (line 541). This is the force-disable-thinking mechanism that replaced
// the stripped `thinking` + `chat_template_kwargs` from PR #410 (Batch 2),
// which the SDK's `filter()` at line 531-540 deleted before the body was
// built. DocTpoint verified wire-reaches via fetch-interceptor on LM
// Studio / gemma-4-12b (Issue #382 comment 2, 2026-08-04).
describe('OpenAICompatSdkClient — what reaches the request body', () => {
  it('carries reasoning_effort="none" + the seed and the sampling knobs', async () => {
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
      enableThinking: false, seed: 42, repetition_penalty: 1.05, top_p: 0.8,
      // Asked for on purpose: the assertion below is only worth anything if the
      // caller requests the field. Without it the test passes whether the
      // client withholds `response_format` or has stopped building any
      // provider options at all.
      response_format: { type: 'json_object' },
    });

    // What travels: standard `generateText` arguments, which the SDK maps
    // itself and which never depended on the providerOptions key.
    expect(body).toHaveProperty('seed', 42);
    expect(body).toHaveProperty('top_p', 0.8);

    // v1.26.0 Batch 6: the force-disable-thinking field IS on the wire.
    // `reasoningEffort` (camelCase) is in the zod schema and the SDK
    // emits it as `reasoning_effort` (snake_case). Backends that honor
    // the field (DeepSeek V3/V3.1/V4, Kimi k2.5/2.6, GLM-4.6, LM Studio
    // per DocTpoint's measurement) will turn reasoning off.
    expect(body).toHaveProperty('reasoning_effort', 'none');

    // What still does NOT travel, and this is the bug being preserved not
    // repeated. The prior PR #410 mechanism (`thinking.type` +
    // `chat_template_kwargs`) was stripped by the SDK's filter because
    // neither field is in the zod schema. The replacement
    // (`reasoningEffort`) IS in the schema, so it survives.
    for (const field of ['thinking', 'chat_template_kwargs', 'repetition_penalty']) {
      expect(Object.keys(body)).not.toContain(field);
    }

    // Requested above and absent for a second, independent reason: the client
    // no longer builds it at all. #65 reported this against LM Studio 0.4.15,
    // and it is not historical — measured again on 0.4.20 in #372 by curl,
    // outside both the plugin and the SDK: `{"type":"json_object"}` answers
    // 400 `'response_format.type' must be 'json_schema' or 'text'`, while
    // `json_schema` answers 200 and structures correctly. So `json_object` is
    // not a form to keep, and `json_schema` is not a form to inject raw — it
    // travels as the SDK's own `responseFormat` argument, which is where the
    // structured-output work will put it.
    expect(Object.keys(body)).not.toContain('response_format');
  });

  // The shape of an ordinary install's request, and the one that decides
  // whether correcting the key is a behaviour change for anybody who has not
  // opened Advanced → custom. The two controls that feed the fields above live
  // there and are cleared on the way back to default, so a default install
  // passes none of them — but it does pass `response_format`, which is not a
  // setting at all: fifteen call sites ask for `json_object` unconditionally,
  // two of them in extraction. That combination is the request LM Studio
  // actually receives, and it is asserted here rather than reasoned from the
  // settings code, because the settings code is not what the server sees.
  it('adds nothing of its own when the caller configures nothing', async () => {
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
      // Asked for, as every extraction asks for it, so its absence below is a
      // withholding and not an artefact of nobody wanting it.
      response_format: { type: 'json_object' },
    });

    // Positive control first: a test made only of absences passes just as well
    // when nothing was sent at all.
    expect(stub).toHaveBeenCalledTimes(1);
    expect(body).toHaveProperty('model', 'm');

    for (const field of ['thinking', 'chat_template_kwargs', 'repetition_penalty', 'top_p', 'seed', 'response_format']) {
      expect(Object.keys(body)).not.toContain(field);
    }
  });
});
