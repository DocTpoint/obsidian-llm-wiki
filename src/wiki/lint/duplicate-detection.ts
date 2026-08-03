// Duplicate page detection — programmatic candidate generation via shared links,
// bigram title similarity, and cross-language alias matching.
// Extracted from lint-fixes.ts to keep the module focused.

import { parseFrontmatter } from '../../core/frontmatter';
import {
  LINT_YIELD_EVERY_OUTER,
  LINT_YIELD_EVERY_PHASE1,
  LINT_YIELD_EVERY_COMPARISON,
  LINT_DEDUP_JACCARD_LINK_THRESHOLD,
  LINT_DEDUP_JACCARD_BODY_GATE,
  LINT_DEDUP_BIGRAM_THRESHOLD,
  LINT_DEDUP_BUCKET_PREFIX_LEN,
} from '../../constants';

export interface DuplicateCandidate {
  target: string;
  source: string;
  reason: string;
  signal: 'crossLang' | 'bigram' | 'sharedLinks' | 'caseVariant';
  score: number;
}

// ── Pure Functions (extracted for testability) ───────────────────────────────

/** Extract character bigrams from string for similarity comparison. */
export function bigrams(s: string): Set<string> {
  const result = new Set<string>();
  const normalized = s.toLowerCase().replace(/[^a-z0-9一-鿿]/g, '');
  for (let i = 0; i < normalized.length - 1; i++) {
    result.add(normalized.substring(i, i + 2));
  }
  return result;
}

/** Normalize string for cross-language matching. */
export function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[\s\-_]+/g, '').replace(/[^a-z0-9一-鿿]/g, '');
}

const BODY_STOPWORDS = new Set([
  'also', 'are', 'been', 'being', 'both', 'but', 'can', 'could', 'did',
  'does', 'each', 'from', 'had', 'has', 'have', 'into', 'its', 'may',
  'might', 'must', 'not', 'only', 'other', 'our', 'shall', 'should',
  'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these',
  'they', 'this', 'those', 'through', 'was', 'were', 'what', 'when',
  'where', 'which', 'while', 'will', 'with', 'would', 'your',
]);

/** Extract unique meaningful words from body text for content similarity comparison. */
export function bodyWordSet(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .replace(/[^\w\s一-鿿]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3 && !BODY_STOPWORDS.has(w)),
  );
}

/** Compute Jaccard similarity between two sets. */
export function computeJaccard<T>(setA: Set<T>, setB: Set<T>): number {
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

// Generate duplicate-page candidates using programmatic signals.
// Returns candidates for LLM verification, capped by the O(n²) algorithm.
// Three signals, ordered by reliability:
//   1. Shared outgoing wiki-links (Jaccard >= LINT_DEDUP_JACCARD_LINK_THRESHOLD)
//   2. Character bigram title similarity (catches spelling variants, same-language near-matches)
//   3. Cross-language alias match
//
// Thresholds are passed as an optional `options` argument. Each field is
// optional: unset (or non-finite / out-of-[0,1]) values fall back to
// DEFAULT_DEDUP_THRESHOLDS below. Callers (e.g. the lint dedup-phase)
// pass settings fields through directly; the callee handles coalescing +
// clamping so the defaults live in exactly one place.
export interface DuplicateDetectionThresholds {
  jaccardLinkThreshold?: number;   // 0..1
  jaccardBodyGate?: number;        // 0..1
  bigramThreshold?: number;        // 0..1
}

/**
 * Default threshold values, derived from the named constants in
 * src/constants.ts. This is the single source of truth for the 3
 * detection thresholds — callers must NOT re-state these defaults
 * (a caller-side coalesce would fork the value into two places).
 */
export const DEFAULT_DEDUP_THRESHOLDS: Required<DuplicateDetectionThresholds> = {
  jaccardLinkThreshold: LINT_DEDUP_JACCARD_LINK_THRESHOLD,
  jaccardBodyGate: LINT_DEDUP_JACCARD_BODY_GATE,
  bigramThreshold: LINT_DEDUP_BIGRAM_THRESHOLD,
};

/**
 * Resolve one threshold: fall back to `fallback` when the input is
 * missing, null, NaN, or ±Infinity; clamp finite values to the [0,1]
 * Jaccard range. Without the clamp, a settings value of 1.5 would
 * silently disable a signal (`x >= 1.5` is never true) and −0.1 would
 * flood every pair into the candidate set (`x >= −0.1` is always true).
 */
function resolveThreshold(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

// v1.26.0 (#382 item 3, Batch 1): the local PageMeta shape used inside
// generateDuplicateCandidates. Exported so the partition helper below
// can accept the same input type without forcing callers to reconstruct
// it.
export interface LintPageMeta {
  path: string;
  title: string;
  aliases: string[];
  links: Set<string>;
  bodyWords: Set<string>;
}

/**
 * v1.26.0 (#382 item 3, Batch 1): dual-key bucket partition for the
 * bucketed dedup refactor. Each page is hashed into:
 *
 *   - one `tp:` bucket keyed by the first {@link LINT_DEDUP_BUCKET_PREFIX_LEN}
 *     characters of the title, normalised via {@link normalizeForMatch}.
 *     This preserves the title-prefix-similar pages in the same bucket,
 *     so the `bigram` / `crossLang` / `caseVariant` signals still fire
 *     in O(B²) within the bucket.
 *
 *   - one `lh:` bucket per outgoing wiki-link target (also normalised).
 *     This is the second dimension: pages sharing an outgoing hub link
 *     end up in the same `lh:<hub>` bucket regardless of title prefix,
 *     recovering sharedLinks recall that would otherwise be lost.
 *
 * The same `meta` object reference is shared across the buckets it
 * lands in — no metadata duplication, no deep copy. Page order within
 * each bucket follows input order, which keeps signal-pair ordering
 * deterministic for the LLM verify phase.
 *
 * Pure: no IO, no yield, no global state. Suitable for unit tests.
 *
 * Bucket key prefixes (`tp:` / `lh:`) make the partition self-describing
 * when reading debug output and prevent collisions between the two
 * dimensions.
 */
export function partitionPagesMultiBucket(
  metas: LintPageMeta[],
): Map<string, LintPageMeta[]> {
  const buckets = new Map<string, LintPageMeta[]>();

  const addToBucket = (key: string, meta: LintPageMeta): void => {
    const existing = buckets.get(key);
    if (existing) {
      existing.push(meta);
    } else {
      buckets.set(key, [meta]);
    }
  };

  for (const meta of metas) {
    // Title-prefix bucket (tp:).
    const titleKey = normalizeForMatch(meta.title).slice(
      0,
      LINT_DEDUP_BUCKET_PREFIX_LEN,
    );
    // When the title has fewer than PREFIX_LEN normalised chars (e.g.
    // a single CJK ideograph), slice returns whatever is available —
    // empty string for empty titles. Pages with empty keys all land
    // in the same `tp:` bucket (empty-suffix bucket); they are
    // inherently few, and over-partitioning them would not help recall.
    if (titleKey.length > 0) {
      addToBucket(`tp:${titleKey}`, meta);
    }

    // Link-hash buckets (lh:) — one per outgoing wiki-link.
    for (const link of meta.links) {
      const linkKey = normalizeForMatch(link);
      if (linkKey.length > 0) {
        addToBucket(`lh:${linkKey}`, meta);
      }
    }
  }

  return buckets;
}

export async function generateDuplicateCandidates(
  pages: Array<{ path: string; content: string; title: string }>,
  options: Partial<DuplicateDetectionThresholds> = {},
): Promise<DuplicateCandidate[]> {
  const thresholds = {
    jaccardLinkThreshold: resolveThreshold(
      options.jaccardLinkThreshold,
      DEFAULT_DEDUP_THRESHOLDS.jaccardLinkThreshold,
    ),
    jaccardBodyGate: resolveThreshold(
      options.jaccardBodyGate,
      DEFAULT_DEDUP_THRESHOLDS.jaccardBodyGate,
    ),
    bigramThreshold: resolveThreshold(
      options.bigramThreshold,
      DEFAULT_DEDUP_THRESHOLDS.bigramThreshold,
    ),
  };
  interface PageMeta {
    path: string;
    title: string;
    aliases: string[];
    links: Set<string>;
    bodyWords: Set<string>;
  }

  const metas: PageMeta[] = [];
  const linkRegex = /\[\[([^\]|#]+)(?:[|#][^\]]+)?\]\]/g;

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];

    if (i > 0 && i % LINT_YIELD_EVERY_PHASE1 === 0) {
      await new Promise(resolve => window.setTimeout(resolve, 0));
    }

    const fm = parseFrontmatter(page.content);
    const aliases = Array.isArray(fm?.aliases) ? fm.aliases : [];

    const links = new Set<string>();
    const body = page.content.replace(/---[\s\S]*?---/, '');
    let match: RegExpExecArray | null;
    while ((match = linkRegex.exec(body)) !== null) {
      links.add(match[1].trim().toLowerCase());
    }

    // Strip wiki links before computing body words so link text doesn't inflate similarity
    const bodyText = body.replace(/\[\[[^\]]+\]\]/g, '');
    const bodyWords = bodyWordSet(bodyText);

    metas.push({ path: page.path, title: page.title, aliases, links, bodyWords });
  }

  const candidates = new Map<string, DuplicateCandidate>();

  const addCandidate = (pathA: string, pathB: string, reason: string, signal: DuplicateCandidate['signal'], score: number) => {
    const key = [pathA, pathB].sort().join('|||');
    if (!candidates.has(key)) {
      candidates.set(key, { target: pathA, source: pathB, reason, signal, score });
    } else if (score > candidates.get(key)!.score) {
      candidates.set(key, { target: pathA, source: pathB, reason, signal, score });
    }
  };

  let comparisonCount = 0;

  // Signal 1: Shared outgoing wiki-links (Jaccard >= LINT_DEDUP_JACCARD_LINK_THRESHOLD)
  for (let i = 0; i < metas.length; i++) {
    if (i > 0 && i % LINT_YIELD_EVERY_OUTER === 0) {
      await new Promise(resolve => window.setTimeout(resolve, 0));
    }
    for (let j = i + 1; j < metas.length; j++) {
      comparisonCount++;
      if (comparisonCount % LINT_YIELD_EVERY_COMPARISON === 0) {
        await new Promise(resolve => window.setTimeout(resolve, 0));
      }

      const a = metas[i], b = metas[j];
      if (a.links.size === 0 || b.links.size === 0) continue;
      const jaccard = computeJaccard(a.links, b.links);
      if (jaccard >= thresholds.jaccardLinkThreshold) {
        // Body similarity gate: pages with different content are not duplicates
        // even if they share the same set of wiki-links (e.g., two unrelated pages
        // both linking only to one popular hub page).
        const bodySim = computeJaccard(a.bodyWords, b.bodyWords);
        if (bodySim < thresholds.jaccardBodyGate) continue;
        addCandidate(a.path, b.path, `Shared wiki-links (${Math.round(jaccard * 100)}% overlap)`, 'sharedLinks', jaccard);
      }
    }
  }

  // Signal 2: Bigram + cross-language on titles/aliases
  for (let i = 0; i < metas.length; i++) {
    if (i > 0 && i % LINT_YIELD_EVERY_OUTER === 0) {
      await new Promise(resolve => window.setTimeout(resolve, 0));
    }
    for (let j = i + 1; j < metas.length; j++) {
      comparisonCount++;
      if (comparisonCount % LINT_YIELD_EVERY_COMPARISON === 0) {
        await new Promise(resolve => window.setTimeout(resolve, 0));
      }

      const a = metas[i], b = metas[j];
      const namesA = [a.title, ...a.aliases];
      const namesB = [b.title, ...b.aliases];

      // 2a: Bigram similarity on all names (titles + aliases)
      let maxSim = 0;
      for (const nameA of namesA) {
        for (const nameB of namesB) {
          const sim = computeJaccard(bigrams(nameA), bigrams(nameB));
          if (sim > maxSim) maxSim = sim;
        }
      }
      if (maxSim >= thresholds.bigramThreshold) {
        addCandidate(a.path, b.path, `Title/alias similarity (${Math.round(maxSim * 100)}% match)`, 'bigram', maxSim);
      }

      // 2b: Cross-language alias match
      const normalizedNamesA = namesA.map(n => normalizeForMatch(n));
      const normalizedAliasesB = b.aliases.map(n => normalizeForMatch(n));
      const normalizedTitleB = normalizeForMatch(b.title);

      let crossLangMatch = false;
      for (const normA of normalizedNamesA) {
        if (normA && (normalizedAliasesB.includes(normA) || normalizedTitleB === normA)) {
          addCandidate(a.path, b.path, 'Cross-language match (alias or title overlap)', 'crossLang', 1.0);
          crossLangMatch = true;
          break;
        }
      }

      if (!crossLangMatch) {
        const normalizedNamesB = namesB.map(n => normalizeForMatch(n));
        const normalizedAliasesA = a.aliases.map(n => normalizeForMatch(n));
        const normalizedTitleA = normalizeForMatch(a.title);

        for (const normB of normalizedNamesB) {
          if (normB && (normalizedAliasesA.includes(normB) || normalizedTitleA === normB)) {
            addCandidate(a.path, b.path, 'Cross-language match (alias or title overlap)', 'crossLang', 1.0);
            break;
          }
        }
      }
    }
  }

  // Signal 3: Case-variant title collision
  // Two pages whose titles differ only in casing are highly likely duplicates.
  // e.g., "Unix" vs "unix", "Claude Code" vs "claude-code"
  for (let i = 0; i < metas.length; i++) {
    for (let j = i + 1; j < metas.length; j++) {
      const a = metas[i], b = metas[j];
      const lowerA = a.title.toLowerCase();
      const lowerB = b.title.toLowerCase();
      if (lowerA === lowerB && a.title !== b.title) {
        // Always pick lowercase-as-slug as target (deterministic merge direction)
        const [canonical, variant] = a.title < b.title ? [a, b] : [b, a];
        addCandidate(canonical.path, variant.path,
          `Case-variant duplicate: "${a.title}" ↔ "${b.title}"`, 'caseVariant', 0.9);
      }
    }
  }

  return Array.from(candidates.values());
}
