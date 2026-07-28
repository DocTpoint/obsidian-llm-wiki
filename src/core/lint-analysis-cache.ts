// v1.25.10 PATCH Issue #367 P1-1 — content-hash cache for lint analysis.
//
// Lint scans a wiki page (entity / concept) twice per run per vault:
//   1. programatically (alias / dead-link / orphan / empty-page / duplicate)
//      — pure, runs locally
//   2. via LLM (alias completion / duplicate dedup / contradiction)
//      — costliest, AI-call dependent
//
// The LLM phases are gated on the programmatic results. If those are
// empty for a given page, we skip the LLM call for that page entirely.
// Across multiple Lint runs on a slow-changing wiki the vault content
// is usually identical, so caching the *result shape* of each scan
// keyed by a content hash lets us avoid both the local work (when the
// page content is unchanged) and the LLM work (when the programmatic
// result is unchanged AND the cache for the LLM phase is fresh enough).
//
// Scope-locked: this is a simple JSON-on-disk cache. No embedding, no
// vector store, no RAG — see [[feedback_no_rag_embedding_perf]].

import type { App } from 'obsidian';
import { DiskCache } from './disk-cache';
import { hashBody } from './source-requirements';

export interface LintAnalysisEntry {
  /** SHA-1 of the page body that produced this entry. */
  contentHash: string;
  /** Total byte length of the original page content (defends against hash collision). */
  contentLength: number;
  /** When the entry was written (epoch ms). */
  writtenAt: number;
  /** Programmatic findings: counts (no list — caller re-runs scanner on hit to fetch items). */
  programmaticCounts: {
    deadLinks: number;
    orphanPages: number;
    emptyPages: number;
    aliasDeficient: number;
    duplicateCandidates: number;
    tagViolations: number;
  };
  /**
   * Per-page verdict for the LLM phases: "skip" when there is nothing
   * the LLM can add; "run" when an LLM call is justified.
   */
  llmVerdict: {
    aliasNeeded: 'skip' | 'run';
    duplicateWorthInvestigating: 'skip' | 'run';
  };
}

export class LintAnalysisCache {
  private readonly cache: DiskCache<LintAnalysisEntry>;

  constructor(app: App) {
    const cacheDir = `.obsidian/plugins/karpathywiki/cache/lint-analysis`;
    this.cache = new DiskCache<LintAnalysisEntry>({
      cacheDir,
      adapter: app.vault.adapter,
      // Lint content doesn't change every minute; 24h TTL is a sensible
      // ceiling so a corrected source note gets re-tested the next day
      // even without a manual cache invalidation.
      ttlMs: 24 * 60 * 60 * 1000,
      // 5 MB and 200 entries: plenty for a 2000-page vault without
      // spilling into the user's general disk-cache budget.
      maxBytes: 5 * 1024 * 1024,
      maxEntries: 200,
      maxSingleEntryBytes: 32 * 1024,
    });
  }

  /**
   * Build the cache key from a wiki page's body. We use
   * `hashBody` (FNV-1a 32-bit length-prefixed) so two pages that happen
   * to share a hash prefix still need matching lengths to collide.
   */
  static contentKey(content: string): string {
    return hashBody(content);
  }

  async get(content: string): Promise<LintAnalysisEntry | null> {
    const key = LintAnalysisCache.contentKey(content);
    return await this.cache.get(key);
  }

  async set(content: string, entry: Omit<LintAnalysisEntry, 'contentHash' | 'contentLength' | 'writtenAt'>): Promise<void> {
    const hash = LintAnalysisCache.contentKey(content);
    const payload: LintAnalysisEntry = {
      ...entry,
      contentHash: hash,
      contentLength: content.length,
      writtenAt: Date.now(),
    };
    await this.cache.set(hash, payload);
  }

  async invalidate(content: string): Promise<void> {
    await this.cache.invalidate(LintAnalysisCache.contentKey(content));
  }

  async clear(): Promise<void> {
    await this.cache.clear();
  }
}
