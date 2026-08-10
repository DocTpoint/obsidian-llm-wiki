// Output-args helper — translates the public `response_format` shape
// (`{ type: 'json_object' }` or `{ type: 'json_object', schema? }`,
// Issue #443) into the AI SDK's `Output` mechanism, so the SDK client
// does not have to know about `Output.json` / `Output.object` /
// `jsonSchema` directly.
//
// Why a helper instead of inlining the conditional:
//
//   * The same translation runs at every `createMessage` call site —
//     the compat SDK client has 4 such call sites (initial, URL
//     fallback, reasoning-strip retry, token-key retry, and the new
//     json-object-strip retry in v1.26.3 PATCH follow-up). Inlining the
//     `Output` call at every site risks a typo that silently drops the
//     wire field (this is exactly the v1.26.1 bug #443 is closing).
//     Centralising the translation here means a future retry path can
//     only forget `output` if it forgets to spread `outputArgs` — much
//     harder to miss than 4 separate `Output.json()` lines.
//
//   * AI SDK v6 contract: `generateText` reads `output.responseFormat`
//     (a `Promise`) and passes it to `stepModel.doGenerate` /
//     `doStream` (see `ai@6.0.230/dist/index.mjs:4686` and `:7709`).
//     `Output.json()` produces `{type:'json'}` (no schema) and the
//     compat SDK provider encodes that as
//     `response_format: { type: 'json_object' }` on the wire (see
//     `@ai-sdk/openai-compatible@2.0.62/dist/index.mjs:528`).
//     `Output.object({schema,name})` produces
//     `{type:'json', schema, name}` and the SDK encodes it as
//     `response_format: { type: 'json_schema', json_schema: {...} }`
//     when the provider's `supportsStructuredOutputs` flag is true
//     (line 520-527 of the same dist). LM Studio, Ollama (with the
//     right server build), and `custom` self-hosted servers accept
//     this form; the cloud cohort (openrouter / deepseek / kimi / glm
//     / gemini / minimax) accepts `json_object` and does NOT receive
//     `json_schema`.
//
//   * **No-schema case emits `Output.json()` for every openai-compat
//     provider — a single `Output.json()` call, no per-provider
//     branching.** The AI SDK encodes it as
//     `{type:'json_object'}` on the wire. 6 cloud providers accept
//     this (server-side type hint that reduces parse-failure class of
//     issues #443 is closing). The local server cohort (LM Studio /
//     Ollama / `custom`) may 400 on `json_object` (LM Studio is the
//     measured case, DocTpoint Issue #443 comment 1, 2026-08-09:
//     29 ms, `'response_format.type' must be 'json_schema' or 'text'`)
//     — handled by a runtime 400-strip fallback at the SDK client level
//     (`json-object-strip-probe.ts`, with a per-baseURL cache so the
//     cost is exactly one 400 per unique baseURL). The helper does not
//     know which cohort it's in — that's the SDK client's job, and the
//     client does not hardcode either: it just catches 400s whose
//     error message names `json_object` or `response_format`, retries
//     without `output`, and caches the strip decision.
//
//   * Behavioural note on `parseCompleteOutput` (corrects a v1
//     description that was wrong for ai@6.0.230): both `generateText`
//     (line 5021) and `streamText` (line 8277) call
//     `outputSpecification.parseCompleteOutput` after the model
//     finishes. `Output.object({schema})`'s variant runs `safeParseJSON`
//     and throws `NoObjectGeneratedError` on malformed JSON — callers
//     that opt into schema-mode are expected to either guarantee a
//     JSON-returning model or catch `NoObjectGeneratedError` and retry
//     without schema. Out of scope for the no-schema path that all 16
//     production sites use today.
//
//   * `Output.object({ schema })` requires a `Schema`, not a raw
//     JSONSchema object. The wrapper `jsonSchema()` (re-exported by
//     `ai` from `@ai-sdk/provider-utils`) adapts a raw JSONSchema
//     object to that interface — that is the only place in the
//     codebase that needs to know about the conversion.
//
// Usage:
//   const { generateText } = await import('ai');
//   const result = await generateText({
//     model: languageModel,
//     ...,
//     ...buildOutputArgs(response_format),
//   });

import { jsonSchema, Output } from 'ai';

export interface ResponseFormatWithSchema {
  type: 'json_object';
  schema?: Record<string, unknown>;
}

/**
 * Returns `{ output: <Output> }` to spread into `generateText` /
 * `streamText` options, or `{}` when no `response_format` is supplied.
 *
 * - No `response_format` → returns `{}` (caller spreads nothing).
 * - `response_format` without a schema → returns
 *   `{ output: Output.json() }`. The AI SDK encodes this as
 *   `response_format: { type: 'json_object' }` on the wire. 6 cloud
 *   providers accept it; LM Studio / Ollama / `custom` (local-server
 *   cohort) may 400 — handled by the runtime 400-strip fallback in
 *   `json-object-strip-probe.ts`. No provider is hardcoded here.
 * - `response_format` with a schema → returns
 *   `{ output: Output.object({ schema, name }) }` (encodes
 *   `json_schema` on the wire when the provider's
 *   `supportsStructuredOutputs` is true; falls back to `json_object`
 *   otherwise with an AI SDK warning pushed to `result.warnings`).
 *
 * `name` defaults to `'response'`. The AI SDK requires it on
 * `Output.object`; the default matches the convention used by
 * every call site in the codebase.
 */
export function buildOutputArgs(
  response_format: ResponseFormatWithSchema | undefined,
  options: { name?: string } = {},
): { output?: ReturnType<typeof Output.json> | ReturnType<typeof Output.object> } {
  if (!response_format) return {};
  // No-schema case: emit `Output.json()`. The AI SDK encodes this as
  // `{type:'json_object'}` on the wire (see file-header note for the
  // full rationale). The local-server cohort's 400 on `json_object`
  // is caught at the SDK client level by `json-object-strip-probe.ts`
  // — a runtime per-baseURL cache that retries without `output` and
  // remembers the strip decision. The helper does not branch on
  // provider here; the SDK client's catch-handler is provider-agnostic
  // (it only inspects the error message for `json_object` /
  // `response_format`).
  if (!('schema' in response_format) || response_format.schema === undefined) {
    return { output: Output.json() };
  }
  const name = options.name ?? 'response';
  return { output: Output.object({ schema: jsonSchema(response_format.schema), name }) };
}
