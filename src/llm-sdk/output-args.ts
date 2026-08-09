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
//     fallback, reasoning-strip retry, token-key retry). Inlining the
//     `Output` call at every site risks a typo that silently drops the
//     wire field (this is exactly the v1.26.1 bug #443 is closing).
//     Centralising the translation here means a future retry path can
//     only forget `output` if it forgets to spread `outputArgs` — much
//     harder to miss than 4 separate `Output.json()` lines.
//
//   * AI SDK v6 contract: `generateText` reads `output.responseFormat`
//     (a `Promise`) and passes it to `stepModel.doGenerate` /
//     `doStream` (see `ai@6.0.230/dist/index.mjs:4686` and `:7709`).
//     `Output.json()` produces `{type:'json'}` (no schema) and
//     `Output.object({schema,name})` produces
//     `{type:'json', schema, name}`. The compat SDK provider
//     `supportsStructuredOutputs: true` flag (set on
//     lmstudio / ollama / custom in `PREDEFINED_PROVIDERS`,
//     `src/types.ts`) is what decides whether the SDK encodes
//     `json_schema` or falls back to `json_object` on the wire — see
//     `@ai-sdk/openai-compatible@2.0.62/dist/index.mjs:520-528`.
//
//   * **No-schema case returns `{}` — this is intentional, not a bug.**
//     `Output.json()` produces `{type:'json'}`, which the compat SDK
//     encodes as `response_format: { type: 'json_object' }` on the wire
//     when `supportsStructuredOutputs: false` (cloud cohort) — accepted
//     silently. When `supportsStructuredOutputs: true` (lmstudio /
//     ollama / custom), the AND at line 520 still falls through to
//     `json_object` because the schema half is false. **LM Studio
//     rejects `json_object` with HTTP 400** (DocTpoint measurement on
//     LM Studio 0.4.20 + gemma-4-12b, Issue #443 comment 1, 2026-08-09:
//     29 ms, `'response_format.type' must be 'json_schema' or 'text'`).
//     Shipping the no-schema `output` to LM Studio / Ollama / `custom`
//     would regress #65 / ca4a24d / v1.14.0 — the 16 production call
//     sites today fail before inference. The helper therefore returns
//     `{}` for the no-schema case, restoring pre-PR behaviour exactly.
//     The schema arm stays wired so a per-caller migration PR (one per
//     site, gated on #443's pilot validating in production) can opt in
//     to real constraint.
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
 * `streamText` options, or `{}` when no schema is supplied.
 *
 * - No `response_format` → returns `{}` (caller spreads nothing).
 * - `response_format` without a schema → returns `{}`. **No-schema
 *   `json_object` on the wire is rejected by LM Studio / Ollama / custom**
 *   (HTTP 400, DocTpoint Issue #443 comment 1 2026-08-09), so the no-
 *   schema case is a no-op, identical to the pre-v1.14.0 PATCH behaviour
 *   `ca4a24d` shipped to dodge Issue #65. This restores that behaviour
 *   across the 16 production call sites that pass `response_format`
 *   without a schema today.
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
  // No-schema case: do not set `output`. See the file-header note —
  // LM Studio rejects `json_object` with HTTP 400, so emitting it on
  // the wire would regress Issue #65. Restore pre-v1.14.0 PATCH
  // (`ca4a24d`) behaviour for the 16 production call sites today.
  if (!('schema' in response_format) || response_format.schema === undefined) return {};
  const name = options.name ?? 'response';
  return { output: Output.object({ schema: jsonSchema(response_format.schema), name }) };
}
