// ingest-state.ts — the on-disk answer the file picker shows (#598).
//
// The picker used to describe every row from `ingestQueue.getSnapshot()`,
// which is session state: empty again after a plugin reload. So on a fresh
// Obsidian start every note read as never ingested, even when its summary
// page had been on disk for weeks. This module holds the two decisions the
// picker needs to say otherwise, and nothing else.
//
// PURE: no Obsidian APIs, no DOM, no IO. The caller reads the files and
// passes their contents in — which also lets it skip reading the note when
// the page is absent.

import { parseFrontmatter, originNoteRefs } from './frontmatter';

/**
 * What a candidate note's `sources/` page says about it.
 *
 *   none      no page under this note's slug, or one that belongs to a
 *             different note
 *   ingested  a page exists and was built from this note
 *   drifted   as above, and the note has been edited since
 */
export type IngestDiskState = 'none' | 'ingested' | 'drifted';

/**
 * Whether the `sources/` page found by slug was built from THIS note.
 *
 * Same decision as `isAlreadyIngested` (main-commands/ingest-commands.ts),
 * and deliberately the same code: the two answer one question, and a second
 * implementation of it is how #595 happened in the first place. The ownership
 * data lives in `source_file:` (scalar, canonical) with `sources:` as the
 * fallback — `originNoteRefs` is the resolver.
 *
 * A page with no recorded origin falls back to existence. That is the
 * pre-#164 behaviour and it is deliberate: absence of evidence is not proof
 * of a different owner. It is also the reason this reads note → slug → page
 * rather than indexing the `sources/` folder and inverting it — an inverted
 * index cannot attribute an origin-less page to any note at all, and would
 * silently disagree with the skip check on exactly those pages.
 */
export function pageBelongsToNote(pageContent: string, notePath: string): boolean {
  const fm = parseFrontmatter(pageContent);
  if (!fm) return true;
  const origins = originNoteRefs(fm);
  if (origins.length === 0) return true;
  return origins.includes(notePath);
}
