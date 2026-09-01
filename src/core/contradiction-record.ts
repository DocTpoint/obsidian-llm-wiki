// Contradiction record ("case file") builder + target resolution.
//
// An OPEN contradiction lives in two carriers, neither of them the page
// body: the `contradictions:` frontmatter marker on the affected wiki
// page (the index — `core/contradicted-marker.ts`), and one record file
// under `<wikiFolder>/contradictions/` (the prose). The body block
// `## ⚠️ Potential Contradiction` is not a durable carrier: it is
// unknown to the section schema, so `stripUnknownSections` removes it
// on the next model rewrite of the page.
//
// `source_page` arrives as MODEL OUTPUT (`z.string()`, unvalidated).
// It must never become a write path by string surgery: a bracket-less
// value passed through `.replace(/\[\[(.+)\]\]/, …)` unchanged and was
// written to verbatim — which is how the plugin wrote into a user's
// note, breaking the "the plugin never writes user notes" contract.
// `resolveContradictionTarget` therefore resolves the value against
// the real page index and refuses to guess: no match or an ambiguous
// match resolves to null, and the caller discards and reports.
//
// Pure, no IO.

import { slugify } from './slug';

/**
 * Localized section labels the record's four `##` sections use — the
 * `new_claim` / `existing_knowledge` / `resolution_suggestion` /
 * `source_page` entries of `getSectionLabels(settings)`.
 */
export type ContradictionRecordLabels = Record<string, string>;

/** The subset of the page index the resolver needs. */
export interface ResolvablePage {
  /** Full vault path, e.g. `wiki/entities/Statine.md`. */
  path: string;
  /** File basename without extension. */
  title: string;
  aliases?: string[];
}

export interface ResolvedContradictionTarget {
  /** Full vault path of the resolved wiki page. */
  path: string;
  /** Path relative to the wiki folder, without `.md` — the link form. */
  relPath: string;
}

/**
 * Resolve a model-provided `source_page` value against the real page
 * index. Accepts `[[name]]`, `[[folder/name]]`, `[[name|alias]]`, bare
 * names, and a trailing `.md`; matches (case-insensitively) the wiki
 * relative path first, then the page title, then curated aliases.
 * Returns null when nothing matches — or when more than one page
 * matches at the deciding tier, because a guessed target is exactly
 * the failure mode this function exists to prevent.
 */
export function resolveContradictionTarget(
  raw: string,
  pages: readonly ResolvablePage[],
  wikiFolder: string,
): ResolvedContradictionTarget | null {
  let inner = raw.trim();
  const bracket = inner.match(/^\[\[([\s\S]+)\]\]$/);
  if (bracket) inner = bracket[1];
  inner = inner.split('|')[0].trim().replace(/\.md$/i, '');
  if (!inner) return null;
  const needle = inner.toLowerCase();

  const prefix = `${wikiFolder}/`;
  const byRel: ResolvedContradictionTarget[] = [];
  const byTitle: ResolvedContradictionTarget[] = [];
  const byAlias: ResolvedContradictionTarget[] = [];

  for (const page of pages) {
    if (!page.path.startsWith(prefix)) continue;
    const relPath = page.path.slice(prefix.length).replace(/\.md$/i, '');
    const target = { path: page.path, relPath };
    if (relPath.toLowerCase() === needle) byRel.push(target);
    else if (page.title.toLowerCase() === needle) byTitle.push(target);
    else if (page.aliases?.some(a => a.trim().toLowerCase() === needle))
      byAlias.push(target);
  }

  for (const tier of [byRel, byTitle, byAlias]) {
    if (tier.length === 1) return tier[0];
    if (tier.length > 1) return null; // ambiguous — refuse to guess
  }
  return null;
}

export interface ContradictionRecordInput {
  /** What the new source claims. */
  claim: string;
  /** What the affected page (or section) says today. */
  existingView: string;
  /** Suggested resolution; may be empty when the flagging path has none. */
  resolution: string;
  /** Resolved wiki-relative path (no `.md`) of the affected page. */
  pageRelPath: string;
  /** Vault path of the note whose ingest raised the conflict. */
  sourceNotePath: string;
  /** YYYY-MM-DD. */
  date: string;
}

/**
 * Build one record file. The body keeps exactly four `##` sections in
 * this order — `getOpenContradictions` parses them positionally.
 */
export function buildContradictionRecord(
  input: ContradictionRecordInput,
  labels: ContradictionRecordLabels,
): { fileName: string; content: string } {
  const fileName = `${slugify(input.claim.substring(0, 50))}-${input.date}.md`;
  const pageLink = `[[${input.pageRelPath}]]`;
  const content = `---
status: detected
detected: ${input.date}
source_page: "${pageLink}"
source_note: "${input.sourceNotePath}"
---

# Contradiction: ${input.claim.substring(0, 60)}

## ${labels.new_claim}
${input.claim}

## ${labels.existing_knowledge}
${input.existingView}

## ${labels.resolution_suggestion}
${input.resolution}

## ${labels.source_page}
${pageLink}

---
*Auto-detected on ${input.date}*
`;
  return { fileName, content };
}
