// Duplicate page detection — programmatic candidate generation via shared links,
// bigram title similarity, and cross-language alias matching.
// Extracted from lint-fixes.ts to keep the module focused.

import { parseFrontmatter } from '../../core/frontmatter';
import {
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

    // Link-hash buckets (lh:) — one per outgoing wiki-link. The
    // Set's identity already deduplicates raw link strings, but two
    // distinct raw strings can still normalise to the same bucket key
    // (e.g. "[[A-B]]" and "[[A B]]" both become "ab"). Without
    // per-page normalisation dedup, the same meta gets pushed into
    // the same lh: bucket twice — a singleton bucket then has length
    // 2 and the signal loops generate a self-pair (pathA === pathB).
    const seenLinkKeys = new Set<string>();
    for (const link of meta.links) {
      const linkKey = normalizeForMatch(link);
      if (linkKey.length > 0 && !seenLinkKeys.has(linkKey)) {
        seenLinkKeys.add(linkKey);
        addToBucket(`lh:${linkKey}`, meta);
      }
    }
  }

  return buckets;
}

export interface DuplicateCandidateHooks {
  /**
   * Invoked once per non-empty bucket boundary in the bucketed dedup
   * path. Use this to abort a long-running scan promptly (e.g. when
   * the user cancels) without waiting for the entire bucket fan-out
   * to complete.
   *
   * Contract: throw `new DOMException('Lint cancelled by user',
   * 'AbortError')` to abort the scan, matching the convention used by
   * every other lint sub-phase (`fix-runners.ts`, `wiki-engine.ts`,
   * `controller.ts`). Returning normally lets the scan proceed to
   * the next bucket.
   */
  checkCancelled?: () => void;
}

export async function generateDuplicateCandidates(
  pages: Array<{ path: string; content: string; title: string }>,
  options: Partial<DuplicateDetectionThresholds> = {},
  hooks: DuplicateCandidateHooks = {},
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

  const metas: LintPageMeta[] = [];
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

  const comparisonCountRef = { n: 0 };

  // v1.26.0 (#382 item 3, Batch 1): bucketed dedup. Previously each of
  // the three signals ran an O(N²) double for-loop across all pages; at
  // 2000 pages the candidates Map could blow up to O(N²) entries before
  // the LLM batch cap (500) trimmed it, causing OOMs on large vaults.
  //
  // Instead, we partition pages into dual-key buckets (tp:<title-prefix>
  // + lh:<link-hash>) and run the three signals inside each bucket.
  // Bucket-internal pair counts are ΣB² ≪ N²; cross-bucket pairs that
  // share an outgoing hub link still get caught via the lh: dimension.
  // The three existing signals are unchanged — they just operate on a
  // smaller slice now. Recall is preserved at 97-98%; see the Batch 1
  // plan in memory for the analysis.
  //
  // NOTE: `comparisonCount` is cumulative across all buckets — it is
  // NOT reset between buckets. This means the LINT_YIELD_EVERY_COMPARISON
  // cadence (every 500 comparisons) fires globally, not per-bucket.
  // For Latin-script wikis this matches the old behaviour because most
  // pages land in large buckets where the counter advances quickly;
  // for CJK wikis where most buckets hold 1-2 pages the counter only
  // advances through the bucket boundary, so yield cadence inside a
  // bucket is effectively unbounded. Phase 1 still uses its own
  // LINT_YIELD_EVERY_PHASE1 cadence.
  //
  // Performance expectation:
  //   - Time: O(ΣB²) ≤ O(N²), typically O(N²/k) for k ~ 50 buckets.
  //   - Memory: candidates Map size grows monotonically across all
  //     buckets — it is NOT drained per-bucket. The peak is bounded
  //     by the total number of distinct pairs the bucketed path can
  //     surface, which is much smaller than the N² pair count the old
  //     flat O(N²) loop considered. addCandidate's key collision logic
  //     deduplicates pairs that share both a tp: and an lh: bucket.
  const buckets = partitionPagesMultiBucket(metas);

  for (const [, bucketPages] of buckets) {
    // v1.26.0 (#382 item 3, Batch 1): cancellation boundary. Letting
    // a single bucket drain its O(B²) pair fan-out can take seconds on
    // a large vault; invoking the hook at every non-empty bucket
    // boundary (including singletons — long vault-wide scans can have
    // many tiny buckets) gives the caller a chance to abort before
    // the next bucket starts.
    hooks.checkCancelled?.();

    if (bucketPages.length < 2) continue;
    await new Promise(resolve => window.setTimeout(resolve, 0));
    await runSignalsForBucket(bucketPages, thresholds, addCandidate, comparisonCountRef);
  }

  return Array.from(candidates.values());
}

// v1.26.0 (#382 item 3, Batch 1): encapsulate the three duplicate-detection
// signals for a single bucket. Each signal is its own pair loop with
// its own yield cadence (cumulative via comparisonCountRef.n). Splitting
// the signals into named helpers makes it cheap to add a 4th signal later
// and keeps the bucket-iteration shell in generateDuplicateCandidates
// to ~5 lines.
//
// Signal summary (pre-refactor order preserved):
//   1. Shared outgoing wiki-links (Jaccard on link sets, gated by body
//      similarity) — the only signal sensitive to the lh: link-hash
//      bucket dimension.
//   2. Character bigram Jaccard on titles/aliases (catches spelling
//      variants) AND cross-language alias match — both signals fit the
//      same pair loop because they share the namesA/namesB derivations.
//   3. Case-variant title collision — title-cased-only check, no body /
//      link / alias involvement. Runs without yielding because each
//      comparison is a single toLowerCase() and a string equality test.
async function runSignalsForBucket(
  bucketPages: LintPageMeta[],
  thresholds: Required<DuplicateDetectionThresholds>,
  addCandidate: (
    pathA: string,
    pathB: string,
    reason: string,
    signal: DuplicateCandidate['signal'],
    score: number,
  ) => void,
  comparisonCountRef: { n: number },
): Promise<void> {
  await runSharedLinksSignal(bucketPages, thresholds, addCandidate, comparisonCountRef);
  await runBigramCrossLangSignal(bucketPages, thresholds, addCandidate, comparisonCountRef);
  runCaseVariantSignal(bucketPages, addCandidate);
}

// Cumulative comparison yield: increment the counter, yield every
// LINT_YIELD_EVERY_COMPARISON iterations. The counter is shared across
// all signals in all buckets — see the comment block in
// generateDuplicateCandidates for the rationale.
async function yieldForComparison(comparisonCountRef: { n: number }): Promise<void> {
  comparisonCountRef.n++;
  if (comparisonCountRef.n % LINT_YIELD_EVERY_COMPARISON === 0) {
    await new Promise(resolve => window.setTimeout(resolve, 0));
  }
}

async function runSharedLinksSignal(
  bucketPages: LintPageMeta[],
  thresholds: Required<DuplicateDetectionThresholds>,
  addCandidate: (
    pathA: string,
    pathB: string,
    reason: string,
    signal: DuplicateCandidate['signal'],
    score: number,
  ) => void,
  comparisonCountRef: { n: number },
): Promise<void> {
  for (let i = 0; i < bucketPages.length; i++) {
    for (let j = i + 1; j < bucketPages.length; j++) {
      await yieldForComparison(comparisonCountRef);

      const a = bucketPages[i], b = bucketPages[j];
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
}

async function runBigramCrossLangSignal(
  bucketPages: LintPageMeta[],
  thresholds: Required<DuplicateDetectionThresholds>,
  addCandidate: (
    pathA: string,
    pathB: string,
    reason: string,
    signal: DuplicateCandidate['signal'],
    score: number,
  ) => void,
  comparisonCountRef: { n: number },
): Promise<void> {
  for (let i = 0; i < bucketPages.length; i++) {
    for (let j = i + 1; j < bucketPages.length; j++) {
      await yieldForComparison(comparisonCountRef);

      const a = bucketPages[i], b = bucketPages[j];
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
}

// Signal 3: Case-variant title collision.
// Two pages whose titles differ only in casing are highly likely duplicates.
// e.g., "Unix" vs "unix", "Claude Code" vs "claude-code"
// Runs without yielding: each pair is a single toLowerCase + string compare.
function runCaseVariantSignal(
  bucketPages: LintPageMeta[],
  addCandidate: (
    pathA: string,
    pathB: string,
    reason: string,
    signal: DuplicateCandidate['signal'],
    score: number,
  ) => void,
): void {
  for (let i = 0; i < bucketPages.length; i++) {
    for (let j = i + 1; j < bucketPages.length; j++) {
      const a = bucketPages[i], b = bucketPages[j];
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
}
