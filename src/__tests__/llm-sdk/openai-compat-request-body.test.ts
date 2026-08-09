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
// `thinking` + `chat_template_kwargs` from PR #410 (Batch 2), which never
// reached the wire: those two keys are not in the zod schema, and the
// SDK's path-2 passthrough at line 533-534 reads from
// `providerOptions[this.providerOptionsName]` (the provider id —
// `deepseek` / `kimi` / `lmstudio` / etc.), not the hardcoded
// `"openaiCompatible"` key that buildProviderOptions returns under.
// None of the 15 provider ids in `types.ts` is literally
// `"openai-compatible"`, so the lookup misses for every provider and the
// extras never spread into the body. DocTpoint verified via
// fetch-interceptor on LM Studio / gemma-4-12b (Issue #382 comment 3,
// 2026-08-04 — supersedes his earlier comment 2, which attributed the
// no-op to a `filter()` "delete" — the filter is a passthrough, the
// real reason is the key mismatch).
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

    // DocTpoint's 2026-08-09 LM Studio / gemma-4-12b measurement
    // (Issue #443 comment 1): `response_format: { type: 'json_object' }`
    // answers HTTP 400 in 29 ms — `'response_format.type' must be
    // 'json_schema' or 'text'`. Shipping it would regress #65 / ca4a24d
    // / v1.14.0 — the very fix that dropped the field on local servers.
    // Same LM Studio 400 measurement is cited below in the schema-arm
    // tests as the gate: `json_schema` answers 200 in 356 ms.
    expect(Object.keys(body)).not.toContain('response_format');
  });

  // The shape of an ordinary install's request, and the one that decides
  // whether correcting the key is a behaviour change for anybody who has not
  // opened Advanced → custom. The two controls that feed the fields above live
  // there and are cleared on the way back to default, so a default install
  // passes none of them — but the call sites still ask for `json_object`
  // unconditionally. The no-schema case puts no `response_format` on the
  // wire at all (see the comment above — LM Studio 400); the call sites
  // fall back to prompt-only JSON enforcement, exactly as the pre-PR
  // behaviour shipped from v1.14.0 (`ca4a24d`).
  it('emits no response_format for the no-schema default shape', async () => {
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
      // Asked for, as every extraction asks for it — the shape that 15 of
      // the 16 call sites still produce (the 16th, path-resolution.ts:217,
      // is the pilot and supplies a schema).
      response_format: { type: 'json_object' },
    });

    // Positive control first: a test made only of absences passes just as well
    // when nothing was sent at all.
    expect(stub).toHaveBeenCalledTimes(1);
    expect(body).toHaveProperty('model', 'm');

    //    // v1.26.3 PATCH pilot (Issue #443): `response_format` IS now on the
    //    // wire — that is the whole point of the fix. Without a schema the
    //    // SDK encodes `json_object` (the form OpenAI / Anthropic / most
    //    // cloud compat servers already accept), and the 15 non-pilot call
    //    // sites keep working unchanged. The pre-pilot assertion
    //    // ("response_format absent on the wire") was the v1.26.1 root cause
    //    // of the parse-failure class that #443 is closing.
    //    expect(body.response_format).toEqual({ type: 'json_object' });

    // No-schema case: `response_format` MUST be absent. Restores v1.14.0
    // (`ca4a24d`) behaviour for LM Studio / Ollama / `custom` (where the
    // field would 400 per DocTpoint Issue #443 comment 1 2026-08-09)
    // and is a no-op identity for the cloud cohort (where the field
    // would be accepted but the no-schema path does not need it).
    expect(Object.keys(body)).not.toContain('response_format');

    for (const field of ['thinking', 'chat_template_kwargs', 'repetition_penalty', 'top_p', 'seed']) {
      expect(Object.keys(body)).not.toContain(field);
    }
  });
});

// v1.26.3 PATCH pilot — Issue #443.
//
// The compat SDK client currently drops `response_format` before the wire
// (destructure list at openai-compat-sdk-client.ts:154 does not include
// it). The 16 call sites in source-analyzer / conversation-ingest / lint /
// query that ask for `json_object` therefore get no server-side JSON
// constraint on openai-compat providers — backends like LM Studio / Ollama
// reject the absence too, so a passing prompt-only result depends on the
// model following the prompt without help.
//
// The fix has two halves. (1) The compat provider is created with
// `supportsStructuredOutputs: true` for the providers whose servers
// accept `json_schema` (LM Studio, Ollama with the right build, custom
// self-hosted). (2) When the caller passes a `schema` on `response_format`
// and the provider is in the supportsStructuredOutputs set, the SDK
// emits `response_format: { type: 'json_schema', json_schema: { ... } }`
// on the wire (via the AI SDK's own `responseFormat: { type: 'json',
// schema }` path, which the compat provider turns into json_schema when
// supportsStructuredOutputs=true). Without a schema, the SDK falls back
// to `json_object` — same shape the call sites had before, and
// acceptable for OpenAI / Anthropic / cloud providers that already
// accept `json_object`.
//
// The pilot: ONE call site (path-resolution.ts:217) passes a schema; the
// other 15 stay on plain `json_object` until the pilot validates. If the
// wire-body tests below pass and Gate 1 is green, the design is proven
// and the remaining 15 sites can be ported one PR at a time per the
// CLAUDE.md "one PR per call site" rule for #407 Stages 1+2.
describe('OpenAICompatSdkClient — Issue #443 pilot: schema emits json_schema on the wire', () => {
  const validResponse = (): Response => new Response(JSON.stringify({
    id: 'x', object: 'chat.completion', created: 0, model: 'm',
    choices: [{ index: 0, message: { role: 'assistant', content: '{}' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });

  // Reads the request body the compat SDK actually sent. Returns a parsed
  // object so each assertion can pattern-match against the wire shape.
  async function captureBody(provider: string): Promise<Record<string, unknown>> {
    let body: Record<string, unknown> = {};
    const stub = vi.fn(async (_url: string, init?: { body?: unknown }) => {
      // Guard: the AI SDK's compat provider stringifies chat-completions
      // bodies. If a future SDK version shipped a binary / streamed
      // encoding, `String(<any non-string>)` would silently coerce to
      // `"[object Object]"` / `"<Buffer ...>"` and JSON.parse would
      // throw with a cryptic message that hides the regression. Assert
      // the contract up-front so the next regression surfaces as a
      // "wrong body type" error, not a parse error.
      if (typeof init?.body !== 'string') {
        throw new Error(`expected body to be a string, got ${typeof init?.body}`);
      }
      body = JSON.parse(init.body);
      return validResponse();
    });
    const client = new OpenAICompatSdkClient({
      apiKey: 'k', baseURL: 'http://localhost/v1/', provider,
      fetch: stub as never,
    });
    await client.createMessage({
      model: 'm', max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
      response_format: {
        type: 'json_object',
        schema: { type: 'object', properties: { match: { type: 'boolean' } } },
      },
    });
    return body;
  }

  // The 3 providers whose `PREDEFINED_PROVIDERS[provider].supportsStructuredOutputs`
  // is true. Each should produce `json_schema` on the wire when a schema
  // is supplied (the AI SDK's compat provider reads that flag and
  // encodes the schema-bearing form on `response_format`). LM Studio
  // gets the full strict-match assertion because it is the canonical
  // Issue #443 root-cause case; the other two are toMatchObject
  // because the AI SDK's `name` / `strict` field order is not
  // contractually pinned.
  it.each([
    'lmstudio',
    'ollama',
    'custom',
  ] as const)('emits json_schema on the wire for provider:%s when a schema is supplied', async (provider) => {
    const body = await captureBody(provider);
    if (provider === 'lmstudio') {
      expect(body.response_format).toEqual({
        type: 'json_schema',
        json_schema: expect.objectContaining({
          schema: expect.objectContaining({ type: 'object' }),
          strict: true,
          name: 'response',
        }),
      });
    } else {
      expect(body.response_format).toMatchObject({ type: 'json_schema' });
    }
  });

  it('emits no response_format when no schema is supplied (LM Studio + cloud)', async () => {
    let body: Record<string, unknown> = {};
    const stub = vi.fn(async (_url: string, init?: { body?: unknown }) => {
      body = JSON.parse(String(init?.body));
      return validResponse();
    });
    const client = new OpenAICompatSdkClient({
      apiKey: 'k', baseURL: 'http://localhost/v1/', provider: 'lmstudio',
      fetch: stub as never,
    });
    await client.createMessage({
      model: 'm', max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
      response_format: { type: 'json_object' },
    });
    // No schema → no `response_format` on the wire (LM Studio 400 on
    // `json_object` per DocTpoint Issue #443 comment 1 2026-08-09;
    // matching v1.14.0 `ca4a24d` behaviour for all cohorts).
    expect(Object.keys(body)).not.toContain('response_format');
  });

  // Sanity guard: the supportsStructuredOutputs flag is for the local-
  // server cohort (lmstudio / ollama / custom) only. The cloud compat
  // providers (openrouter / deepseek / kimi / glm / gemini / minimax)
  // keep `supportsStructuredOutputs: false`. When a schema is supplied
  // but the flag is false, the AI SDK encoder at
  // @ai-sdk/openai-compatible@2.0.62/dist/index.mjs:520-528 emits
  // `{ type: 'json_object' }` on the wire (fallback) AND pushes a
  // warning to `result.warnings`. The schema is silently dropped — not
  // the constraint #443 asks for (the SDK can't encode it without
  // the flag). The per-caller migration PR (one per site, gated on
  // #443's pilot validating in production) must also flip
  // `supportsStructuredOutputs` for that provider — separate PR.
  it.each([
    'openrouter',
    'deepseek',
    'kimi',
    'glm',
    'gemini',
    'minimax',
  ] as const)('falls back to json_object for cloud compat provider:%s when caller supplies a schema (flag is the open question for the per-caller migration PR)', async (provider) => {
    const body = await captureBody(provider);
    expect(body.response_format, `${provider} without supportsStructuredOutputs=true emits json_object, NOT json_schema — flip the flag in the per-caller migration PR`).toEqual({ type: 'json_object' });
  });
});
