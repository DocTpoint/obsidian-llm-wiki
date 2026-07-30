/**
 * Status bar text composition for ingestion progress.
 *
 * Pure functions — zero IO. Composes the existing localized status-bar label
 * (e.g. "提取中... 点击取消") with the current document name and, during a
 * folder batch run, the [current/total] counter.
 *
 * v1.25.11 PATCH #169: also accepts a fine-grained `stage` label that is
 * sandwiched between the filename and the always-visible base label, so the
 * user sees "My Note · Generating summary · 提取中... 点击取消" instead of
 * just the base label. The base label is preserved (not removed) — the
 * stage is ADD-only emission, never a replacement, so the always-visible
 * cancel hint remains clickable throughout every stage of every long
 * ingest / lint / PDF / batch operation.
 *
 * Examples (label = "提取中... 点击取消"):
 *   single:        "My Note · 提取中... 点击取消"
 *   single+stage:  "My Note · Generating summary · 提取中... 点击取消"
 *   batch:         "[4/10] My Note · 提取中... 点击取消"
 *   batch+stage:   "[4/10] My Note · Generating summary · 提取中... 点击取消"
 *   no info:       "提取中... 点击取消"  (backward-compatible fallback)
 */

export interface BatchProgress {
  current: number;
  total: number;
}

/**
 * Compose the status-bar text.
 *
 * @param label    Always-visible base label (e.g. localized "提取中... 点击取消").
 *                 This is NEVER replaced — `stage` is an additional sandwiched
 *                 segment, not a replacement. Preserves the always-visible
 *                 cancel affordance.
 * @param filename Optional page basename; trimmed, empty/whitespace = omitted.
 * @param batch    Optional batch progress; when set, prefixes "[c/t] ".
 * @param stage    Optional fine-grained stage label (e.g. "Generating summary").
 *                 Sandwiched between filename and the base label. Empty/whitespace
 *                 = omitted (backward-compatible with the v3 plan's "ADD-only emission"
 *                 contract — stage is never a replacement for the base label).
 */
export function buildIngestStatusBarText(
  label: string,
  filename?: string,
  batch?: BatchProgress | null,
  stage?: string
): string {
  const name = filename?.trim() || '';
  const stageSegment = stage?.trim() || '';
  const prefix = batch ? `[${batch.current}/${batch.total}] ` : '';
  const middle = name && stageSegment
    ? `${name} · ${stageSegment}`
    : name || stageSegment;
  const body = middle ? `${middle} · ${label}` : label;
  return `${prefix}${body}`;
}
