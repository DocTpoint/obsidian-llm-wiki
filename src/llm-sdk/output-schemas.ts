// output-schemas.ts
//
// v1.26.3 PATCH Phase B (Issue #443): Zod schemas for the 6 P0
// callers that opt into the typed-output path (`createMessageWithOutput`).
//
// These schemas define the canonical shape the LLM is expected to
// emit. The caller passes the schema to `response_format.schema` and
// the SDK encodes `{type: 'json_schema', json_schema: { schema, name, strict: true }}`
// on the wire (Tier 0, the strongest mode). On Tier 0 success,
// `result.output` is the parsed object; on Tier 1 / Tier 2 success,
// the caller falls back to `parseJsonResponse(result.text)`.
//
// Why Zod (vs raw JSONSchema or TypeScript-only types):
//   - Runtime validation: caller-side `result.output ?? parseJsonResponse(text)`
//     still parses the Tier 1 / Tier 2 path, where Zod gives the same
//     shape guarantee as Tier 0.
//   - Source of truth: schema lives in code, not in a prompt string.
//     Prompt drift between code and instruction text was a real
//     failure mode in v1.26.x (per dedup-phase batch lessons).
//   - Type inference: Zod's `z.infer<typeof Schema>` gives callers
//     the typed object without manual `as { ... }` casts.
//
// The 6 P0 schemas are intentionally minimal — they capture the
// post-`parseJsonResponse` shape the callers already use (after the
// `as { ... }` casts). Anything stricter would be a behavior change
// for callers that already gracefully handle `undefined` / missing
// fields. Per CLAUDE.md "no breaking changes" rule, these schemas
// MUST be permissive enough to accept what the existing prompts +
// parseJsonResponse flow already accepts.

import { z } from 'zod';

/**
 * seed-selector.ts — Selects which vault pages are the best seeds
 * for a query. Emits a flat array of vault-relative paths.
 *
 * Existing cast: `{ seeds?: string[] }`. The current code throws if
 * `seeds` is missing or not an array. The schema marks it required
 * for runtime validation; Tier 1/2 callers still get null guards.
 */
export const SeedSelectorSchema = z.object({
  seeds: z.array(z.string()),
});
export type SeedSelector = z.infer<typeof SeedSelectorSchema>;

/**
 * query-keywords.ts — Extracts query keywords for downstream search.
 * Emits a flat array of keyword strings.
 *
 * Existing cast: `{ keywords?: unknown }`. The current code
 * dedupes + filters non-strings, so the schema is permissive on
 * element type (every string survives; non-strings are silently
 * dropped by caller logic — no Zod-side coercion needed).
 */
export const QueryKeywordsSchema = z.object({
  keywords: z.array(z.string()),
});
export type QueryKeywords = z.infer<typeof QueryKeywordsSchema>;

/**
 * merge-triage.ts — Decides how two candidate pages should be
 * merged (insert / merge / reject). The current code requires
 * `strategy` to be one of MERGE_STRATEGIES (validated post-parse).
 * We mirror that contract in Zod.
 *
 * Items are optional (the merge may be a single-shot insert with no
 * items); `reason` is the LLM's free-text rationale.
 */
export const MergeTriageSchema = z.object({
  strategy: z.string(),
  items: z.array(z.object({
    kind: z.string().optional(),
    content: z.string().optional(),
    target_section: z.string().optional(),
    reason: z.string().optional(),
  })).optional(),
  reason: z.string().optional(),
});
export type MergeTriage = z.infer<typeof MergeTriageSchema>;

/**
 * link-orphan.ts — For an orphan page (no incoming wiki-links),
 * propose related pages and their link text. Existing cast:
 * `{ related_pages?: Array<{page_path, link_text, link_target}> }`.
 * The schema marks the array as optional (the current code returns
 * `[]` if missing — `link-orphan` is a "best effort" call).
 */
export const LinkOrphanSchema = z.object({
  related_pages: z.array(z.object({
    page_path: z.string(),
    link_text: z.string(),
    link_target: z.string(),
  })).optional(),
});
export type LinkOrphan = z.infer<typeof LinkOrphanSchema>;

/**
 * fix-dead-link.ts — For a dead wiki-link, propose either a
 * replacement target or a stub to create. Existing cast:
 * `{ action?, correct_link?, stub_title?, stub_type? }`. All fields
 * are optional — the caller branches on `action` first; everything
 * else is contextual.
 */
export const FixDeadLinkSchema = z.object({
  action: z.string().optional(),
  correct_link: z.string().optional(),
  stub_title: z.string().optional(),
  stub_type: z.string().optional(),
});
export type FixDeadLink = z.infer<typeof FixDeadLinkSchema>;

/**
 * QueryView-class.ts — "Is this conversation valuable enough to
 * save?" boolean + reason. Existing cast: `{ valuable?: boolean;
 * reason?: string }`. The boolean is optional because the current
 * code defaults to "skip suggestion" if missing.
 */
export const QueryViewValueSchema = z.object({
  valuable: z.boolean().optional(),
  reason: z.string().optional(),
});
export type QueryViewValue = z.infer<typeof QueryViewValueSchema>;