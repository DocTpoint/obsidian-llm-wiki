// v1.25.10 PATCH DocTpoint §4 — split `merge` vs `contradictory`.
//
// `merge` and `contradictory` currently both fall through to the same
// body-rewrite path. There is no frontmatter-level signal that the
// rewrite was triggered by a *conflict* between new and existing info,
// so Lint cannot tell a "conflicted rewrite" apart from a routine merge.
//
// This helper stamps a `contradicted_sources:` line into the frontmatter
// block when the triage returned `strategy: 'contradictory'`. The new
// field is plain YAML list-of-strings under the plugin's own namespace,
// preserved across re-touch by the v1.25.10 PATCH passthrough fix in
// `extractPassthroughLines`. Lint can later scan this field to surface
// pages that need editorial review.
//
// Pure, no IO. The merged sources list accumulates across re-touches —
// each contradictory re-ingest adds the new sourcePath without dropping
// earlier entries — so a page's history of contradictions is preserved.

import { parseFrontmatter } from './frontmatter';

export const CONTRADICTED_SOURCES_KEY = 'contradicted_sources';

/**
 * Append `sourcePath` to the `contradicted_sources:` list in
 * `frontmatter`. Idempotent against the same sourcePath being added
 * twice (case-insensitive, `.md` normalized). Returns the input
 * unchanged when the frontmatter has no opening `---` delimiter
 * (defensive — caller is expected to pass real content).
 *
 * @param frontmatter Existing frontmatter block, with or without
 *                    trailing newline. Begins with `---\n`.
 * @param sourcePath  Path of the source whose content contradicted
 *                    the page; e.g. `notes/foo.md`.
 */
export function appendContradictedByMarker(
  frontmatter: string,
  sourcePath: string,
): string {
  if (!frontmatter.startsWith('---')) return frontmatter;
  const normalized = sourcePath.trim();
  if (!normalized) return frontmatter;

  const fm = parseFrontmatter(frontmatter);
  const existing = Array.isArray(fm?.[CONTRADICTED_SOURCES_KEY])
    ? (fm[CONTRADICTED_SOURCES_KEY] as string[])
    : [];
  const normSet = new Set(existing.map(s => normalizeSource(s)));
  if (!normSet.has(normalizeSource(normalized))) {
    existing.push(normalized);
    normSet.add(normalizeSource(normalized));
  }

  const list = `contradicted_sources:\n${existing.map(s => `  - "${s.replace(/"/g, '\\"')}"`).join('\n')}`;
  if (fm && fm[CONTRADICTED_SOURCES_KEY] !== undefined) {
    return frontmatter.replace(
      /^contradicted_sources:[^\n]*(?:\n[ \t]+[^\n]*)*/m,
      list,
    );
  }
  const fmStart = frontmatter.indexOf('---');
  const fmEnd = frontmatter.indexOf('\n---', fmStart + 3);
  if (fmEnd === -1) return `${frontmatter.trimEnd()}\n${list}\n`;
  const fmText = frontmatter.substring(fmStart + 3, fmEnd);
  const tail = frontmatter.substring(fmEnd);
  const tailNorm = tail.startsWith('\n') ? tail : '\n' + tail;
  return `---${fmText}\n${list}${tailNorm}`.replace(/\n+$/, '\n');
}

function normalizeSource(s: string): string {
  return s.trim().replace(/^\[\[|\]\]$/g, '').trim().toLowerCase();
}
