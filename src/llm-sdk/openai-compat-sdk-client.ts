// v1.23.0 P1-7: OpenAI-compatible provider client backed by Vercel AI-SDK v6.
//
// Replaces the OpenAICompatibleClient's role as the catch-all for any
// non-Anthropic, non-Official-OpenAI provider. Covers 6 baseURLs from
// PREDEFINED_PROVIDERS:
//
//   - gemini:      https://generativelanguage.googleapis.com/v1beta/openai
//   - openrouter:  https://openrouter.ai/api/v1
//   - deepseek:    https://api.deepseek.com/v1
//   - minimaxi:    https://api.minimaxi.com/v1
//   - moonshot:    https://api.moonshot.cn/v1
//   - glm:         https://open.bigmodel.cn/api/paas/v4
//   - ollama:      http://localhost:11434/v1
//   - lmstudio:    http://localhost:1234/v1
//
// Architecture: thin wrapper around `@ai-sdk/openai-compatible`'s
// `createOpenAICompatible`. Per-baseURL `providerOptions` (e.g.
// `supportsStructuredOutputs`, `includeUsage`) are set automatically
// based on the `provider` id we pass in.

import { type LanguageModel, APICallError } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { LLMClient, type LLMFinishReason } from '../types';
import { PREDEFINED_PROVIDERS } from '../types';
import { obsidianFetchBridge, streamWithFallback } from '../core/obsidian-fetch-bridge';
import { mapAiSdkError } from './openai-sdk-client';
import {
  getCachedUrl,
  resolveBaseUrlWithFallback,
  isUrlError,
} from '../core/url-fallback';
import { TokenKeyProber } from './token-key-probe';
import { ReasoningStripProber } from './reasoning-strip-probe';
import { reportFinish } from './finish-reason';
import { buildSamplingArgs } from './sampling-args';
import { buildOutputArgs } from './output-args';

export interface OpenAICompatSdkClientOptions {
  apiKey: string;
  baseURL: string;
  /** Provider id used as the `name` (e.g. 'gemini', 'openrouter'). */
  provider: string;
  /** Override non-streaming fetch (used in tests). */
  fetch?: typeof obsidianFetchBridge;
  /** Override streaming fetch (default: streamWithFallback). */
  streamFetch?: typeof streamWithFallback;
}

export class OpenAICompatSdkClient implements LLMClient {
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly provider: string;
  private readonly fetchImpl: typeof obsidianFetchBridge;
  private readonly streamFetchImpl: typeof streamWithFallback;
  /**
   * v1.23.0 P1.5 follow-up: runtime probe-then-cache for token-key
   * preference (max_tokens vs max_completion_tokens). Owned per client
   * so cache lifetime == client lifetime. When the user changes baseURL
   * or API key in settings, a new client is constructed and probing
   * starts fresh.
   */
  private readonly tokenKeyProber = new TokenKeyProber();

  /**
   * v1.26.0 Batch 6: Layer-3 fallback cache. Some openai-compat
   * backends (Gemini-via-shim per #137) reject `reasoning_effort: 'none'`
   * with HTTP 400. On 400 with a reasoning-related field name in the
   * error message, we strip the field and retry exactly once; the
   * strip decision is cached per baseURL so subsequent calls skip
   * the probe. Mirrors the [[TokenKeyProber]] design.
   */
  private readonly reasoningStripProber = new ReasoningStripProber();

  /**
   * v1.26.3 PATCH (Issue #443): whether the openai-compat SDK provider
   * should be created with `supportsStructuredOutputs: true`. Reads
   * from `PREDEFINED_PROVIDERS` (the canonical per-provider config
   * table at `src/types.ts`) so adding a new compat provider that
   * accepts `json_schema` is a one-field config change instead of
   * editing the SDK client. Local servers (LM Studio / Ollama /
   * self-hosted `custom`) accept this form; cloud compat servers
   * (openrouter / deepseek / kimi / glm) accept `json_object` and
   * do NOT receive `json_schema` (they may 400 on it). The openai /
   * anthropic / codex paths go through their own SDK clients and
   * are unaffected by this flag.
   */
  private readonly supportsStructuredOutputs: boolean;

  constructor(opts: OpenAICompatSdkClientOptions) {
    this.apiKey = opts.apiKey;
    this.baseURL = opts.baseURL;
    this.provider = opts.provider;
    this.fetchImpl = opts.fetch ?? obsidianFetchBridge;
    this.streamFetchImpl = opts.streamFetch ?? streamWithFallback;
    this.supportsStructuredOutputs
      = PREDEFINED_PROVIDERS[opts.provider]?.supportsStructuredOutputs ?? false;
  }

  /**
   * Build the AI-SDK provider for a given model.
   *
   * `fetchFn` is the fetch adapter. Pass the streaming variant
   * (`streamFetchImpl`) for createMessageStream, the non-stream
   * variant (`fetchImpl`) for createMessage / listModels. When
   * omitted, defaults to streamFetchImpl — both are URL-based and
   * the streamFetchImpl's fallback handles CORS for cloud, so it's
   * safe to use for non-stream too (AI-SDK just doesn't iterate
   * the body stream). However, calling createMessage with
   * streamFetchImpl pulls in a bit more code path; tests that
   * want to mock non-stream fetch pass fetchImpl explicitly.
   */
  private getProvider(modelId: string, fetchFn: typeof obsidianFetchBridge | typeof streamWithFallback = this.streamFetchImpl, baseURLOverride?: string): LanguageModel {
    // v1.23.0 P1.5: baseURLOverride lets the fallback retry path pass a
    // corrected URL (e.g., `/v1` appended for Kimi Coding Plan) without
    // mutating this.baseURL. Cached resolved URLs flow through this.
    const effectiveBaseURL = baseURLOverride ?? getCachedUrl(this.baseURL) ?? this.baseURL;
    const provider = createOpenAICompatible({
      name: this.provider,
      baseURL: effectiveBaseURL,
      apiKey: this.apiKey,
      fetch: (fetchFn ?? this.streamFetchImpl) as unknown as typeof fetch,
      // includeUsage: Some OpenAI-compatible providers (DeepSeek, GLM)
      // don't return usage unless asked. AI-SDK's default is true for
      // OpenAI; we set it explicitly to ensure consistent token tracking.
      includeUsage: true,
      // v1.26.3 PATCH (Issue #443): when true AND a schema is supplied
      // on the call's `response_format`, the SDK encodes
      // `response_format: { type: 'json_schema', json_schema: { ... } }`
      // on the wire. Without a schema, the SDK falls back to
      // `json_object` — same shape the 15 non-pilot call sites
      // produce today. The flag is sourced from
      // `PREDEFINED_PROVIDERS[provider].supportsStructuredOutputs` and
      // cached on the instance in the constructor.
      supportsStructuredOutputs: this.supportsStructuredOutputs,
      // v1.23.0 P1.5 follow-up: token-key probe hook. Read the
      // current cached key for this baseURL at request time — this
      // closure captures `this` so each request consults the latest
      // probe result. If we have no cached entry, the transform is
      // a no-op and the request goes out with the AI-SDK default
      // (max_tokens). On rejection we probe + cache + next request
      // uses the swapped key.
      transformRequestBody: (args: Record<string, unknown>) => {
        const cached = this.tokenKeyProber.getCachedKey(this.baseURL);
        if (!cached) return args;
        if (cached === 'max_tokens') return args;
        // cached === 'max_completion_tokens'
        const body = { ...args };
        if (body.max_tokens !== undefined) {
          body.max_completion_tokens = body.max_tokens;
          delete body.max_tokens;
        }
        return body;
      },
    });
    return provider(modelId);
  }

  /**
   * Probe whether a baseURL works for OpenAI-compatible chat endpoint.
   * Used by the URL fallback to test candidate URLs without committing
   * the original request payload. Sends a minimal 1-token message and
   * treats 404 as "wrong URL" (return false), all other errors as
   * "auth/server error" (throw to propagate).
   */
  private async probeBaseURL(baseURL: string): Promise<boolean> {
    try {
      const languageModel = this.getProvider('gpt-4o-mini', this.fetchImpl, baseURL);
      const { generateText } = await import('ai');
      await generateText({
        model: languageModel,
        messages: [{ role: 'user', content: 'hi' }],
        maxOutputTokens: 1,
      });
      return true;
    } catch (err) {
      if (isUrlError(err)) return false;
      throw err;
    }
  }

  async createMessage(params: LLMClient['createMessage'] extends (p: infer P) => unknown ? P : never): Promise<string> {
    const { model, max_tokens, system, messages, temperature, top_p, repetition_penalty, seed, enableThinking, response_format, onFinish } = params;

    // v1.26.3 PATCH (Issue #443): translate the public `response_format`
    // shape into the AI SDK's `output` mechanism via `buildOutputArgs`
    // (see `src/llm-sdk/output-args.ts` for the contract). Build once
    // and spread at every generateText call site below — the URL
    // fallback and reasoning-strip retry paths both reuse the same
    // args. Without this shared object, a future retry path can
    // silently omit `output` and re-introduce the v1.26.1 bug #443
    // is closing.
    const outputArgs = buildOutputArgs(response_format);

    try {
      const languageModel = this.getProvider(model, this.fetchImpl);
      const { generateText } = await import('ai');

      const result = await generateText({
        model: languageModel,
        ...(system ? { system } : {}),
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        maxOutputTokens: max_tokens,
        ...outputArgs,
        providerOptions: this.buildProviderOptions({
          enableThinking,
          repetitionPenalty: repetition_penalty,
        }) as unknown as Parameters<typeof generateText>[0]['providerOptions'],
        ...buildSamplingArgs({ temperature, top_p, seed }),
      });
      reportFinish(onFinish, result.finishReason, result.usage);
      return result.text;
    } catch (err) {
      // v1.23.0 P1.5: URL fallback for custom baseURLs.
      // If user's baseURL is missing /v1, AI-SDK sends to wrong path
      // and gets 404. Try candidate URLs and cache the first working
      // one. Subsequent calls (Ingest/Lint/Query) reuse the cache.
      if (isUrlError(err)) {
        const mappedErr = mapAiSdkError(err);
        const resolved = await resolveBaseUrlWithFallback({
          baseUrl: this.baseURL,
          testFn: (url) => this.probeBaseURL(url),
          originalError: mappedErr,
        });
        const retryLanguageModel = this.getProvider(model, this.fetchImpl, resolved);
        const { generateText } = await import('ai');
        const result = await generateText({
          model: retryLanguageModel,
          ...(system ? { system } : {}),
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
          maxOutputTokens: max_tokens,
          ...outputArgs,
          providerOptions: this.buildProviderOptions({
            enableThinking,
            repetitionPenalty: repetition_penalty,
          }) as unknown as Parameters<typeof generateText>[0]['providerOptions'],
          ...buildSamplingArgs({ temperature, top_p, seed }),
        });
        reportFinish(onFinish, result.finishReason, result.usage);
        return result.text;
      }

      // v1.26.0 Batch 6: Layer-3 400-retry for reasoning-related fields.
      //
      // Some openai-compat backends (notably Gemini-via-OpenAI-shim per
      // Issue #137) reject `reasoning_effort: 'none'` with HTTP 400.
      // Match the error message for `reasoning_effort` / `thinking` /
      // `chat_template` (case-insensitive), then retry exactly once
      // with reasoningEffort stripped from the provider options.
      //
      // ORDER MATTERS: this branch runs BEFORE the token-key fallback
      // below. Token-key probe is a coarse "any 400 → swap max_tokens
      // ↔ max_completion_tokens" — if we let it run first on a
      // reasoning-related 400, it would mark the baseURL as
      // max_completion_tokens and skip the reasoning-strip probe
      // entirely. Then the retry would still send reasoning_effort
      // and the second 400 would not be retried at all. Reasoning-
      // strip must run first when the message clearly identifies the
      // reasoning field as the cause.
      //
      // Guard: skip retry if we've already cached "strip" for this
      // baseURL — means the first retry already happened (and the
      // retry would either succeed or fail the same way).
      //
      // No per-vendor matching: we don't know which backends reject
      // which dialect, and the user already opted into
      // enableThinking=false explicitly (per the dedup-phase
      // `enableThinkingOverride = false`). Per user guidance
      // (2026-08-04): "做好通用、完善的fallback机制即可".
      //
      // v1.26.0 Batch 6 Bug-3 fix: markStrip moved AFTER the retry
      // succeeds (not before). If the retry itself throws — same
      // backend, transient 5xx, network blip — we don't want the
      // cache permanently poisoned. Mirrors the token-key branch
      // pattern (setCachedKey + try + retry; if retry throws, the
      // outer throw mapAiSdkError catches and the cache is set, but
      // for the reasoning-strip the cache-write is gated on retry
      // success because the cache decision is "this baseURL rejects
      // reasoning_effort" — a transient retry failure shouldn't
      // cement that decision).
      if (
        APICallError.isInstance(err) &&
        err.statusCode === 400 &&
        enableThinking === false &&
        !this.reasoningStripProber.shouldStrip(this.baseURL) &&
        ReasoningStripProber.isReasoningFieldError(err.message ?? '')
      ) {
        const retryLanguageModel = this.getProvider(model, this.fetchImpl);
        const { generateText } = await import('ai');
        // Retry without reasoningEffort — pass enableThinking=true so
        // buildProviderOptions does not re-add the field. The user's
        // intent ("force-disable thinking") was honored by the first
        // attempt; on the retry we accept whatever the backend's
        // default reasoning behavior is, since the field itself is
        // rejected.
        const result = await generateText({
          model: retryLanguageModel,
          ...(system ? { system } : {}),
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
          maxOutputTokens: max_tokens,
          ...outputArgs,
          providerOptions: this.buildProviderOptions({
            enableThinking: true,
            repetitionPenalty: repetition_penalty,
          }) as unknown as Parameters<typeof generateText>[0]['providerOptions'],
          ...buildSamplingArgs({ temperature, top_p, seed }),
        });
        // Retry succeeded — commit the cache decision now. If the
        // retry above throws, this line never runs and the cache is
        // untouched; the outer catch propagates the error.
        this.reasoningStripProber.markStrip(this.baseURL);
        reportFinish(onFinish, result.finishReason, result.usage);
        return result.text;
      }

      // v1.23.0 P1.5 follow-up: token-key probe-then-retry fallback.
      //
      // On ANY HTTP 400 from the gateway, try the alternate token key
      // exactly once. No error-body inspection needed: status 400 is
      // sufficient signal that "something went wrong", and the cost
      // of a false-positive retry is one extra HTTP call (<1s LAN).
      //
      // Guard: skip retry if we already have a cached key for this
      // baseURL — means the first retry already happened (and failed),
      // so retrying again would loop.
      //
      // Runs AFTER the reasoning-strip branch above: the reasoning
      // branch handles a more specific 400 case (the message clearly
      // names a reasoning-related field). Token-key is the broader
      // catch-all for any other 400.
      if (APICallError.isInstance(err) && err.statusCode === 400 && !this.tokenKeyProber.getCachedKey(this.baseURL)) {
        // The default wire format is `max_tokens`. If the gateway
        // rejected it, try `max_completion_tokens`.
        this.tokenKeyProber.setCachedKey(this.baseURL, 'max_completion_tokens');
        const retryLanguageModel = this.getProvider(model, this.fetchImpl);
        const { generateText } = await import('ai');
        const result = await generateText({
          model: retryLanguageModel,
          ...(system ? { system } : {}),
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
          maxOutputTokens: max_tokens,
          ...outputArgs,
          providerOptions: this.buildProviderOptions({
            enableThinking,
            repetitionPenalty: repetition_penalty,
          }) as unknown as Parameters<typeof generateText>[0]['providerOptions'],
          ...buildSamplingArgs({ temperature, top_p, seed }),
        });
        reportFinish(onFinish, result.finishReason, result.usage);
        return result.text;
      }

      throw mapAiSdkError(err);
    }
  }

  /**
   * Map AI-SDK options → OpenAI-compatible provider options.
   *
   * Same shape as OpenAISdkClient (these providers all speak the
   * OpenAI Chat Completions format). `enableThinking=false` maps to
   * `reasoningEffort='none'` (v1.26.0 Batch 6) — verified wire-reaches
   * the openai-compat SDK's zod schema (@ai-sdk/openai-compatible@2.0.62
   * line 331) and is emitted as `reasoning_effort: 'none'` on the wire
   * (line 541). DocTpoint's LM Studio / gemma-4-12b fetch-interceptor
   * measurement (Issue #382 comment 2, 2026-08-04) confirmed the field
   * reaches the backend; reasoning_tokens=0 in the response.
   *
   * Earlier this mapped to `thinking.type: 'disabled'` — neither it nor
   * `chat_template_kwargs` were declared in the AI SDK's zod schema
   * (openaiCompatibleLanguageModelChatOptions, line 322-344 of
   * @ai-sdk/openai-compatible@2.0.62/dist/index.mjs), and the SDK's
   * "passthrough" path (line 533-534) reads from
   * `providerOptions[this.providerOptionsName]` (the provider id we
   * pass in — `deepseek` / `kimi` / `lmstudio` / etc.) rather than the
   * hardcoded `"openaiCompatible"` key that buildProviderOptions
   * returns under. None of the 15 provider ids in `types.ts` is the
   * literal string `"openai-compatible"`, so the lookup misses for
   * every provider and the extras never reach the wire. DocTpoint
   * identified this via fetch-interceptor on Issue #382 comment 3
   * (2026-08-04); the field never left the process on the openai-compat
   * path. The 979s→365s e2e gain came from retry/backoff only. See
   * [[project_v1_26_0_batch_6_real_wire_thinking_disable]] for the
   * full post-mortem.
   */
  private buildProviderOptions(opts: {
    enableThinking?: boolean;
    repetitionPenalty?: number;
  }): Record<string, Record<string, unknown>> {
    const openaiOpts: Record<string, unknown> = {};

    if (opts.enableThinking === false && !this.reasoningStripProber.shouldStrip(this.baseURL)) {
      // v1.26.0 Batch 6: force-disable thinking via reasoningEffort.
      //
      // Prior mechanism (PR #410 / Batch 2) used `thinking.type: 'disabled'`
      // + `chat_template_kwargs.enable_thinking: false` — neither is in
      // @ai-sdk/openai-compatible's zod schema
      // (openaiCompatibleLanguageModelChatOptions, line 322-344 of dist/index.mjs),
      // and the SDK's "passthrough" path at line 533-534 reads from
      // `providerOptions[this.providerOptionsName]` (our provider id —
      // `deepseek` / `kimi` / `lmstudio` / etc.), not the hardcoded
      // `"openaiCompatible"` key that buildProviderOptions returns under.
      // For every provider id we ship (none is literally
      // `"openai-compatible"`), that lookup misses and the fields never
      // reach the wire. Verified by DocTpoint via fetch-interceptor
      // (Issue #382 comment 3, 2026-08-04 — supersedes his earlier
      // comment 2 which called this "stripped"; it is misaddressed).
      //
      // The new mechanism is `reasoningEffort: 'none'` (camelCase) which
      // the zod schema DOES accept (line 331: `z.string().optional()`) and
      // which the SDK emits as `reasoning_effort: 'none'` (snake_case) on
      // the wire (line 541). DocTpoint's LM Studio / gemma-4-12b
      // measurement confirmed wire-reaches + reasoning_tokens=0.
      //
      // Backend compatibility (no per-vendor matching):
      //   - DeepSeek V3/V3.1/V4 — accepts (official reasoning_effort field)
      //   - Kimi k2.5/2.6 — accepts
      //   - GLM-4.6 (智谱 BigModel) — accepts
      //   - LM Studio / llama.cpp — DocTpoint measured
      //   - OpenRouter — uses `reasoning: { enabled: false }` (different
      //     dialect, silently ignored on openai-compat path; not a 400)
      //   - Gemini via OpenAI shim — likely 400; handled by Layer 3
      //     (400-retry in commit B6-3) which strips the field and retries
      //
      // The `!shouldStrip(this.baseURL)` guard: once the Layer-3 retry
      // learned this backend rejects reasoning_effort, future calls on
      // this baseURL should NOT re-add the field (otherwise the retry
      // path would just re-400 forever). The strip decision is a
      // per-baseURL "this backend doesn't accept this field" signal.
      openaiOpts.reasoningEffort = 'none';
    }

    if (opts.repetitionPenalty !== undefined) {
      // The spelling `OpenAICompatibleClient.buildRequestBody` put on the wire
      // before v1.23.0. Kept, so that correcting the providerOptions key
      // restores that spelling rather than inventing a new one — but only the
      // spelling. That client gated every non-standard field on an
      // `unsupportedFields` set held per client instance, learned from 400
      // bodies via `parseUnknownFields` and surfaced to the user as a
      // `paramStripped` notice. The AI-SDK migration dropped all of it, so
      // whenever a value is set this field now travels ungated — the setting
      // itself is opt-in, with no default and its input behind Custom Advanced
      // Settings.
      //
      // Which spelling is right is per-backend, not global:
      //   - llama.cpp b9205 ignores this one — measured once locally, same
      //     output hash as a field name invented on the spot, three seeds, both
      //     ends of the range, while `repeat_penalty` changed the output. No
      //     artefact kept, and the server is no longer reachable
      //   - the repository counts it among the fields the #137 retry stripped
      //     on a 400 (CHANGELOG «temperature, repetition_penalty, etc.»), and a
      //     code comment of that era cites `Unknown name 'repetition_penalty'`
      //     as a Gemini reply. The issue itself never names the field, and no
      //     live response is kept — the record is weaker than the thinking one
      //   - OpenRouter and vLLM document this spelling; whether it ever took
      //     effect for a user is not established either way
      // So the fix is a per-provider dialect plus something to replace the
      // learned blocklist, not a rename. A rename here would trade one broken
      // set of backends for another.
      openaiOpts.repetition_penalty = opts.repetitionPenalty;
    }

    // repetition_penalty is NOT in
    // openaiCompatibleLanguageModelChatOptions (zod schema, line 322-344 of
    // dist/index.mjs). The SDK's path-2 passthrough (line 533-534) reads
    // from `providerOptions[this.providerOptionsName]` — our provider id
    // (`deepseek` / `kimi` / `lmstudio` / etc.), not the hardcoded
    // `"openaiCompatible"` key that buildProviderOptions returns under.
    // None of the 15 provider ids is literally `"openai-compatible"`, so
    // the passthrough lookup misses for every provider and the field
    // never reaches the wire on the openai-compat path. Has been the case
    // since v1.23.0 — that migration dropped the
    // pre-AI-SDK `unsupportedFields` blocklist that used to gate this.
    //
    // v1.26.0 Batch 6: reasoningEffort (above) IS in the zod schema and
    // does reach the wire as `reasoning_effort` (line 541). repetition_penalty
    // is kept in the object for completeness — the user's Custom Advanced
    // Setting can opt in, but the field is a no-op today. Correcting it
    // is deliberately not part of this change: it would deliver
    // repetition_penalty to all ten providers on this path at once, and no
    // backend is known to read it.
    //
    // The follow-up does not need this key at all for most of it: the SDK
    // parses `openaiCompatible.reasoningEffort` through its own schema and
    // emits `reasoning_effort` regardless, which is Gemini's documented way to
    // decline reasoning, and structured output travels as the standard
    // `responseFormat` argument.
    return Object.keys(openaiOpts).length > 0 ? { openaiCompatible: openaiOpts } : {};
  }

  async createMessageStream(params: {
    model: string;
    max_tokens: number;
    system?: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    onChunk: (chunk: string) => void;
    enableThinking?: boolean;
    temperature?: number;
    top_p?: number;
    repetition_penalty?: number;
    seed?: number;
    onFinish?: (meta: { finishReason: LLMFinishReason }) => void;
  }): Promise<string> {
    const { model, max_tokens, system, messages, onChunk, temperature, top_p, repetition_penalty, seed, enableThinking, onFinish } = params;

    // v1.23.0 P1-7 follow-up: stream path uses streamWithFallback
    // (real streaming via window.fetch with CORS fallback to
    // requestUrl). See obsidian-fetch-bridge.ts for rationale.
    const languageModel = this.getProvider(model, this.streamFetchImpl);
    const { streamText } = await import('ai');

    try {
      // v1.23.0 P2: AI-SDK v6 stream consumption fix.
      //
      // Root cause of "一次性" (batch) streaming UX:
      // The previous code iterated `result.fullStream` first to collect
      // reasoning-delta events, THEN iterated `result.textStream` to
      // forward text chunks. AI-SDK v6's fullStream and textStream share
      // the same underlying event source — iterating fullStream causes
      // the framework to buffer all text-delta events internally and
      // yield them to textStream all at once when the stream completes.
      // Result: onChunk fires N times in ~50ms, UI shows a single render.
      //
      // Fix: consume ONLY textStream. For reasoning content (DeepSeek
      // doesn't emit reasoning; OpenAI o1-series does), read from
      // `result.reasoning` (a Promise<string>) after stream completes —
      // this is the AI-SDK v6 recommended pattern.
      const result = streamText({
        model: languageModel,
        ...(system ? { system } : {}),
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        maxOutputTokens: max_tokens,
        providerOptions: this.buildProviderOptions({
          enableThinking,
          repetitionPenalty: repetition_penalty,
        }) as unknown as Parameters<typeof streamText>[0]['providerOptions'],
        ...buildSamplingArgs({ temperature, top_p, seed }),
      });

      let fullText = '';
      let chunkCount = 0;
      const streamStartTime = Date.now();
      // v1.23.0 P2: Force a macrotask yield between chunks so the
      // browser can paint each onChunk's DOM update as a separate
      // frame. Without this, AI-SDK's async iterator drains the
      // entire response in a single microtask batch (all onChunk
      // calls complete before the next requestAnimationFrame fires),
      // making the UI appear to render the final state in one go.
      //
      // v1.24.1 PATCH Phase 5.5.0: removed per-chunk console.debug
      // (was noisy + triggered DevTools forced-reflow on long
      // streams). chunkCount is now used only by the post-loop
      // summary line below; we still append each chunk to fullText.
      for await (const chunk of result.textStream) {
        chunkCount++;
        fullText += chunk;
        onChunk(chunk);
        await new Promise<void>(resolve => window.setTimeout(resolve, 0));
      }
      console.debug(`[STREAM-CHUNK] total chunks forwarded: ${chunkCount} in ${Date.now() - streamStartTime}ms`);

      // Surface why generation stopped. Without this a `length` finish is
      // indistinguishable from a normal one and the answer simply ends
      // mid-sentence with no indication anything was cut.
      try {
        reportFinish(onFinish, await result.finishReason, await result.usage);
      } catch {
        /* finishReason unavailable on this provider — leave as unknown */
      }

      // Collect reasoning content (if any) from the post-stream Promise.
      // OpenAI o-series and reasoning-capable providers populate this.
      let reasoningContent = '';
      try {
        const reasoning = await result.reasoning;
        if (typeof reasoning === 'string' && reasoning) {
          reasoningContent = reasoning;
        } else if (Array.isArray(reasoning)) {
          reasoningContent = reasoning.map((r) => (r as { text?: string }).text || '').join('');
        }
      } catch {
        // No reasoning field for this provider (DeepSeek, etc.) — ignore.
      }

      if (reasoningContent) {
        fullText = `<think>\n${reasoningContent}\n</think>\n\n${fullText}`;
      }
      return fullText;
    } catch (err) {
      // v1.23.0 P1.5: URL fallback for streaming (Query Wiki) — same
      // logic as createMessage. If 404 on wrong URL, resolve to the
      // correct baseURL via the module-level cache and retry.
      if (isUrlError(err)) {
        const mappedErr = mapAiSdkError(err);
        const resolved = await resolveBaseUrlWithFallback({
          baseUrl: this.baseURL,
          testFn: (url) => this.probeBaseURL(url),
          originalError: mappedErr,
        });
        const retryLanguageModel = this.getProvider(model, this.streamFetchImpl, resolved);
        const { streamText } = await import('ai');

        const result = streamText({
          model: retryLanguageModel,
          ...(system ? { system } : {}),
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
          maxOutputTokens: max_tokens,
          providerOptions: this.buildProviderOptions({
            enableThinking,
            repetitionPenalty: repetition_penalty,
          }) as unknown as Parameters<typeof streamText>[0]['providerOptions'],
          ...buildSamplingArgs({ temperature, top_p, seed }),
        });

        let fullText = '';
        for await (const chunk of result.textStream) {
          fullText += chunk;
          onChunk(chunk);
        }
        let reasoningContent = '';
        try {
          const reasoning = await result.reasoning;
          if (typeof reasoning === 'string' && reasoning) {
            reasoningContent = reasoning;
          } else if (Array.isArray(reasoning)) {
            reasoningContent = reasoning.map((r) => (r as { text?: string }).text || '').join('');
          }
        } catch { /* no reasoning */ }
        if (reasoningContent) {
          fullText = `<think>\n${reasoningContent}\n</think>\n\n${fullText}`;
        }
        return fullText;
      }

      // v1.26.0 Batch 6 Bug-2 fix: Layer-3 400-retry for reasoning-related
      // fields (streaming variant — same logic as createMessage above).
      //
      // ORDER MATTERS: this branch runs BEFORE the token-key fallback
      // below. Token-key probe is coarse (any 400 →
      // max_tokens ↔ max_completion_tokens); if it runs first on a
      // reasoning-related 400, it would mark the baseURL and skip the
      // reasoning-strip probe entirely. Then the retry still sends
      // reasoning_effort and the second 400 is never retried.
      //
      // Bug-2 (Aug 2026 code-review): this branch used to be AFTER
      // the token-key branch on the streaming path — opposite of the
      // non-streaming path. The token-key branch would mark the
      // baseURL first and the reasoning-strip probe never fired. Now
      // both paths follow the same order.
      if (
        APICallError.isInstance(err) &&
        err.statusCode === 400 &&
        enableThinking === false &&
        !this.reasoningStripProber.shouldStrip(this.baseURL) &&
        ReasoningStripProber.isReasoningFieldError(err.message ?? '')
      ) {
        const retryLanguageModel = this.getProvider(model, this.streamFetchImpl);
        const { streamText } = await import('ai');
        const result = streamText({
          model: retryLanguageModel,
          ...(system ? { system } : {}),
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
          maxOutputTokens: max_tokens,
          providerOptions: this.buildProviderOptions({
            enableThinking: true,
            repetitionPenalty: repetition_penalty,
          }) as unknown as Parameters<typeof streamText>[0]['providerOptions'],
          ...buildSamplingArgs({ temperature, top_p, seed }),
        });
        let fullText = '';
        for await (const chunk of result.textStream) {
          fullText += chunk;
          onChunk(chunk);
        }
        let reasoningContent = '';
        try {
          const reasoning = await result.reasoning;
          if (typeof reasoning === 'string' && reasoning) {
            reasoningContent = reasoning;
          } else if (Array.isArray(reasoning)) {
            reasoningContent = reasoning.map((r) => (r as { text?: string }).text || '').join('');
          }
        } catch { /* no reasoning */ }
        // Bug-3: markStrip AFTER the retry succeeds. If the stream
        // throws (network blip, transient 5xx), the cache is not
        // poisoned; the outer catch propagates the error and the
        // next call gets a fresh probe.
        this.reasoningStripProber.markStrip(this.baseURL);
        if (reasoningContent) {
          fullText = `<think>\n${reasoningContent}\n</think>\n\n${fullText}`;
        }
        return fullText;
      }

      // v1.23.0 P1.5 follow-up: token-key probe-then-retry for streaming.
      // Same logic as createMessage — cache the alt key for this
      // baseURL and retry. No error-body inspection.
      if (APICallError.isInstance(err) && err.statusCode === 400 && !this.tokenKeyProber.getCachedKey(this.baseURL)) {
        this.tokenKeyProber.setCachedKey(this.baseURL, 'max_completion_tokens');
        const retryLanguageModel = this.getProvider(model, this.streamFetchImpl);
        const { streamText } = await import('ai');
        const result = streamText({
          model: retryLanguageModel,
          ...(system ? { system } : {}),
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
          maxOutputTokens: max_tokens,
          providerOptions: this.buildProviderOptions({
            enableThinking,
            repetitionPenalty: repetition_penalty,
          }) as unknown as Parameters<typeof streamText>[0]['providerOptions'],
          ...buildSamplingArgs({ temperature, top_p, seed }),
        });
        let fullText = '';
        for await (const chunk of result.textStream) {
          fullText += chunk;
          onChunk(chunk);
        }
        let reasoningContent = '';
        try {
          const reasoning = await result.reasoning;
          if (typeof reasoning === 'string' && reasoning) {
            reasoningContent = reasoning;
          } else if (Array.isArray(reasoning)) {
            reasoningContent = reasoning.map((r) => (r as { text?: string }).text || '').join('');
          }
        } catch { /* no reasoning */ }
        if (reasoningContent) {
          fullText = `<think>\n${reasoningContent}\n</think>\n\n${fullText}`;
        }
        return fullText;
      }

      throw mapAiSdkError(err);
    }
  }

  async listModels(): Promise<string[]> {
    return [];
  }
}