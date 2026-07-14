// Write-level audit trail — LOCAL PATCH (not upstream).
//
// Why this exists
// ---------------
// merge-guard.py classifies re-merge risk against a snapshot taken BEFORE a
// batch. A page that is created and then re-merged several times *within* the
// same ingest run never appears in that snapshot, so it is reported as a plain
// CREATE and its body diff is never shown. Rebuilding from an empty wiki makes
// that blind spot total: every page is created during the batch, so merge-guard
// reports 100% CREATE no matter how much intra-batch merging (and damage)
// happened. Batch size is therefore not a safety control — it only decides how
// much merge activity stays unobserved.
//
// The guard has to sit where the write happens. `createOrUpdateFile()` is the
// plugin's single write gate (see types.ts, "single write gate with pollution
// defense"), so one hook there covers create-page, all three merge routes,
// related-page, alias appends and the lint fixers.
//
// Division of labour
// ------------------
// This module is pure: no Obsidian imports, no I/O, no thresholds. It turns page
// content into facts and compares two fact sets. Deciding what the facts mean
// belongs to wiki/schema/audit-report.py. The plugin records; the deterministic
// script judges.

import { parseFrontmatter, extractBody } from '../core/frontmatter';
import { parseMentionsSection } from '../core/mentions-parser';
import { hashBody } from '../core/source-requirements';

/** Everything we can cheaply know about a page at write time. */
export interface PageFacts {
  exists: boolean;
  reviewed: boolean;
  bodyLen: number;
  bodyHash: string;
  sourceCount: number;
  /** A `## <mentions>` section is present at all. */
  mentionsFound: boolean;
  /**
   * Every content line in the mentions section parsed as a structured bullet.
   * False for hand-edited or legacy-format sections. This is NOT the same as an
   * empty section, and collapsing the two is precisely the misreading that made
   * the S36 fail-safe look like a working cross-source union.
   */
  mentionsParsed: boolean;
  mentionCount: number;
  /** Raw section length — measures shrinkage even when mentionsParsed is false. */
  mentionsRawLen: number;
}

export const ABSENT: PageFacts = {
  exists: false,
  reviewed: false,
  bodyLen: 0,
  bodyHash: '',
  sourceCount: 0,
  mentionsFound: false,
  mentionsParsed: true,
  mentionCount: 0,
  mentionsRawLen: 0,
};

/** Reduce page content to the facts a loss check needs. `null` = file absent. */
export function summarizePage(content: string | null, mentionsLabel: string): PageFacts {
  if (content === null) return { ...ABSENT };

  const fm = parseFrontmatter(content);
  const body = extractBody(content);
  const mentions = parseMentionsSection(body, mentionsLabel);

  return {
    exists: true,
    reviewed: fm?.reviewed === true,
    bodyLen: body.length,
    bodyHash: hashBody(body),
    sourceCount: fm?.sources?.length ?? 0,
    mentionsFound: mentions.found,
    mentionsParsed: mentions.fullyParsed,
    mentionCount: mentions.mentions.length,
    mentionsRawLen: mentions.raw?.length ?? 0,
  };
}

/**
 * Loss flags for a single write. Empty array = nothing shrank.
 *
 * A merge is supposed to be additive, so any shrinkage is worth a look. These
 * are tripwires, not verdicts: a legitimate mention dedup can shrink a section
 * too. False positives cost a line in a report; a missed loss costs a page.
 */
export function detectLosses(before: PageFacts, after: PageFacts): string[] {
  if (!before.exists) return []; // a create cannot lose anything

  const losses: string[] = [];
  if (after.bodyLen < before.bodyLen) losses.push('body_shrank');
  if (after.sourceCount < before.sourceCount) losses.push('sources_lost');
  if (before.mentionsFound && !after.mentionsFound) losses.push('mentions_section_gone');
  if (after.mentionsRawLen < before.mentionsRawLen) losses.push('mentions_section_shrank');
  if (before.mentionsParsed && after.mentionsParsed && after.mentionCount < before.mentionCount) {
    losses.push('mentions_lost');
  }
  if (before.reviewed && after.bodyHash !== before.bodyHash) losses.push('reviewed_page_rewritten');
  return losses;
}

export interface AuditEntry {
  ts: string;
  path: string;
  /** create vs update is derived from what was actually on disk, not from what
   *  the caller believed — which is also the correct fix for upstream #290
   *  (the ingest log labels merges as creates). */
  op: 'create' | 'update';
  /** Which code path wrote this, e.g. 'mergePage:llm-body-rewrite'. Passed
   *  explicitly from the call site rather than sniffed from a stack trace:
   *  mergePage and updateRelatedPage each write from two different routes, and
   *  a diagnostic must not itself rest on a brittle, minifier-dependent guess. */
  origin: string;
  before: PageFacts;
  after: PageFacts;
  losses: string[];
}

export function buildAuditEntry(
  path: string,
  before: PageFacts,
  after: PageFacts,
  origin: string = 'unknown'
): AuditEntry {
  return {
    ts: new Date().toISOString(),
    path,
    op: before.exists ? 'update' : 'create',
    origin,
    before,
    after,
    losses: detectLosses(before, after),
  };
}

/** One JSON object per line — appendable, greppable, streamable. */
export function formatAuditLine(entry: AuditEntry): string {
  return JSON.stringify(entry) + '\n';
}
