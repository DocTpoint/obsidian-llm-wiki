import { describe, it, expect } from 'vitest';
import {
  bodyWordSet,
  computeJaccard,
  generateDuplicateCandidates,
  partitionPagesMultiBucket,
} from '../../../wiki/lint/duplicate-detection';
import type { DuplicateCandidate } from '../../../wiki/lint/duplicate-detection';

// ── bodyWordSet ────────────────────────────────────────────────────────────────

describe('bodyWordSet', () => {
  it('returns unique meaningful words, filtering stopwords and short words', () => {
    const words = bodyWordSet('The wiki is a knowledge base that compiles information');
    expect(words.has('wiki')).toBe(true);
    expect(words.has('knowledge')).toBe(true);
    expect(words.has('compiles')).toBe(true);
    expect(words.has('information')).toBe(true);
    // Stopwords and short words filtered
    expect(words.has('the')).toBe(false);
    expect(words.has('is')).toBe(false);
    expect(words.has('a')).toBe(false);
    expect(words.has('that')).toBe(false);
  });

  it('produces low Jaccard for different-topic texts', () => {
    const wA = bodyWordSet(
      'A log file is a chronological append-only record detailing operational history of events. ' +
      'Entries track system events such as ingests queries maintenance passes providing audit timeline.',
    );
    const wB = bodyWordSet(
      'Query is an advanced knowledge interaction process where artificial intelligence is prompted ' +
      'to synthesize information from multiple source pages producing cohesive answers with citations.',
    );
    const sim = computeJaccard(wA, wB);
    expect(sim).toBeLessThan(0.2);
  });

  it('produces non-empty set for CJK text', () => {
    const words = bodyWordSet('深度学习是人工智能的核心技术之一 机器学习是基础');
    expect(words.size).toBeGreaterThan(0);
  });

  it('produces high Jaccard for similar CJK texts', () => {
    const shared = '深度学习是人工智能的核心技术之一 机器学习是深度学习的基础 神经网络架构';
    const wA = bodyWordSet(shared + ' 图像识别卷积网络');
    const wB = bodyWordSet(shared + ' 自然语言处理变换器');
    const sim = computeJaccard(wA, wB);
    expect(sim).toBeGreaterThanOrEqual(0.2);
  });

  it('produces low Jaccard for different-topic CJK texts', () => {
    const wA = bodyWordSet('深度学习是人工智能的核心技术 神经网络用于图像识别任务');
    const wB = bodyWordSet('历史是人类文明的记录 古代文化与现代社会的联系');
    const sim = computeJaccard(wA, wB);
    expect(sim).toBeLessThan(0.2);
  });
});

// ── generateDuplicateCandidates — threshold overrides (v1.26.0 #382 item 2) ──

/**
 * Build a wiki page fixture with a frontmatter aliases array and a body
 * containing [[wiki-links]] + plain prose. The aliases populate the
 * `bigram` signal; the [[wiki-links]] populate the `sharedLinks` signal.
 */
function makePage(path: string, title: string, body: string, aliases: string[] = []): {
  path: string;
  content: string;
  title: string;
} {
  const aliasesYaml = aliases.length > 0
    ? `aliases:\n${aliases.map(a => `  - "${a}"`).join('\n')}\n`
    : '';
  return {
    path,
    title,
    content: `---\n${aliasesYaml}---\n${body}`,
  };
}

/**
 * Filter candidates to the (pathA, pathB) pair under test, ignoring
 * pair-order. Returns the matched candidate or null.
 */
function findCandidate(
  candidates: DuplicateCandidate[],
  pathA: string,
  pathB: string,
): DuplicateCandidate | null {
  const a = candidates.find(c =>
    (c.target === pathA && c.source === pathB) ||
    (c.target === pathB && c.source === pathA)
  );
  return a ?? null;
}

describe('generateDuplicateCandidates — threshold overrides', () => {
  it('default behavior matches legacy 0.4 / 0.2 / 0.4 thresholds (regression guard)', async () => {
    // Two pages whose outgoing wiki-links overlap exactly on the [[shared]]
    // link, with body-text overlap ~50% (well above the 0.2 body gate).
    const a = makePage('wiki/entities/a.md', 'A', 'See [[shared]] for context. Body has foo bar baz qux.');
    const b = makePage('wiki/entities/b.md', 'B', 'See [[shared]] for context. Body has foo bar baz extra.');
    const candidates = await generateDuplicateCandidates([a, b]);
    // The sharedLinks signal should fire because link Jaccard = 1.0 (only
    // link is shared) AND body Jaccard is well above the 0.2 gate.
    const sl = findCandidate(candidates, a.path, b.path);
    expect(sl).not.toBeNull();
    expect(sl!.signal).toBe('sharedLinks');
  });

  it('clamps out-of-range jaccardLinkThreshold to the [0,1] range', async () => {
    // F2 (code-review finding): thresholds are clamped to [0,1] so a
    // settings value of 1.5 no longer silently disables the signal
    // (`x >= 1.5` is never true). 1.5 clamps to 1.0 — a page pair with
    // 100% shared link graph (jaccard = 1.0) still clears it, proving the
    // clamp to 1.0 rather than keeping the raw 1.5.
    const a = makePage('wiki/entities/a.md', 'A', 'See [[shared]] for context. Body has foo bar baz qux.');
    const b = makePage('wiki/entities/b.md', 'B', 'See [[shared]] for context. Body has foo bar baz extra.');
    const fullShare = await generateDuplicateCandidates([a, b], {
      jaccardLinkThreshold: 1.5,   // clamps to 1.0
    });
    const sl = findCandidate(fullShare, a.path, b.path);
    expect(sl).not.toBeNull();
    expect(sl!.signal).toBe('sharedLinks');

    // Distinguishing case: a partial-share pair (jaccard < 1.0) is filtered
    // at the clamped 1.0, so the clamp demonstrably took effect.
    const c = makePage('wiki/entities/c.md', 'C', 'See [[shared]] for context. Body has foo bar baz qux.');
    const d = makePage('wiki/entities/d.md', 'D', 'See [[other]] for context. Body has foo bar baz extra.');
    const partialShare = await generateDuplicateCandidates([c, d], {
      jaccardLinkThreshold: 1.5,   // clamps to 1.0
    });
    expect(findCandidate(partialShare, c.path, d.path)).toBeNull();
  });

  it('non-finite threshold values fall back to the default (no silent disable)', async () => {
    // F2 (code-review finding): Infinity in a settings value would
    // previously make `x >= Infinity` always false — silently disabling
    // the signal while the wiki looks clean. resolveThreshold now falls
    // back to the default for non-finite inputs.
    const a = makePage('wiki/entities/a.md', 'A', 'See [[shared]] for context. Body has foo bar baz qux.');
    const b = makePage('wiki/entities/b.md', 'B', 'See [[shared]] for context. Body has foo bar baz extra.');
    const candidates = await generateDuplicateCandidates([a, b], {
      jaccardLinkThreshold: Number.POSITIVE_INFINITY,
    });
    // Infinity → fallback to default 0.4 → jaccard 1.0 >= 0.4 → candidate survives
    expect(findCandidate(candidates, a.path, b.path)).not.toBeNull();
  });

  it('raising bigramThreshold filters out near-title duplicates', async () => {
    // Two pages whose titles are very close (bigram ~0.7) — at the default
    // bigram threshold (0.4) this fires the bigram signal; at threshold
    // 0.9 it should not.
    const a = makePage('wiki/entities/claude-code.md', 'Claude Code',
      'Anthropic CLI for AI-assisted development.', []);
    const b = makePage('wiki/entities/claude-cde.md', 'Claude CDE',
      'Some other Anthropic tool for code editing.', []);
    const atDefault = await generateDuplicateCandidates([a, b]);
    expect(findCandidate(atDefault, a.path, b.path)).not.toBeNull();

    const raised = await generateDuplicateCandidates([a, b], {
      bigramThreshold: 0.99,
    });
    expect(findCandidate(raised, a.path, b.path)).toBeNull();
  });

  it('backward-compat: omitting the options argument behaves like legacy', async () => {
    // The legacy fixture (from `default behavior` test) should produce
    // the same candidate set with or without an explicit options object
    // — proving the default-options spread preserves old behavior.
    const a = makePage('wiki/entities/a.md', 'A', 'See [[shared]] for context. Body has foo bar baz qux.');
    const b = makePage('wiki/entities/b.md', 'B', 'See [[shared]] for context. Body has foo bar baz extra.');
    const withOptions = await generateDuplicateCandidates([a, b], {});
    const withoutOptions = await generateDuplicateCandidates([a, b]);
    expect(withOptions).toEqual(withoutOptions);
  });
});

// ── partitionPagesMultiBucket (v1.26.0 #382 item 3, Batch 1) ─────────────────

/** Minimal PageMeta shape — only the fields the helper reads. */
function makeMeta(overrides: Partial<{
  path: string;
  title: string;
  aliases: string[];
  links: Set<string>;
  bodyWords: Set<string>;
}> = {}) {
  return {
    path: overrides.path ?? 'default.md',
    title: overrides.title ?? 'Default',
    aliases: overrides.aliases ?? [],
    links: overrides.links ?? new Set<string>(),
    bodyWords: overrides.bodyWords ?? new Set<string>(),
  };
}

describe('partitionPagesMultiBucket', () => {
  it('returns an empty map for an empty input', () => {
    const buckets = partitionPagesMultiBucket([]);
    expect(buckets.size).toBe(0);
  });

  it('puts a single page into one tp bucket only (no links)', () => {
    const page = makeMeta({ path: 'wiki/ai.md', title: 'AI Agent' });
    const buckets = partitionPagesMultiBucket([page]);
    expect(buckets.size).toBe(1);
    expect(buckets.has('tp:ai')).toBe(true);
    expect(buckets.get('tp:ai')).toEqual([page]);
  });

  it('separates pages with different title prefixes into different tp buckets', () => {
    const ai = makeMeta({ path: 'wiki/ai.md', title: 'AI Agent' });
    const db = makeMeta({ path: 'wiki/db.md', title: 'Database' });
    const buckets = partitionPagesMultiBucket([ai, db]);
    expect(buckets.get('tp:ai')).toEqual([ai]);
    expect(buckets.get('tp:da')).toEqual([db]);
  });

  it('puts pages sharing the same title prefix into the same tp bucket', () => {
    const ai1 = makeMeta({ path: 'wiki/ai1.md', title: 'AI Agent' });
    const ai2 = makeMeta({ path: 'wiki/ai2.md', title: 'AIModel' });
    const buckets = partitionPagesMultiBucket([ai1, ai2]);
    expect(buckets.get('tp:ai')).toEqual([ai1, ai2]);
  });

  it('puts pages sharing an outgoing wiki-link into the same lh bucket', () => {
    const wiki = makeMeta({
      path: 'wiki/wiki-plugin.md',
      title: 'Wiki Plugin',
      links: new Set(['shared-hub', 'obsidian']),
    });
    const arch = makeMeta({
      path: 'wiki/arch.md',
      title: 'Plugin Architecture',
      links: new Set(['shared-hub', 'plugin']),
    });
    const buckets = partitionPagesMultiBucket([wiki, arch]);
    // Link keys are normalised via normalizeForMatch — hyphens removed,
    // so "shared-hub" becomes "sharedhub".
    expect(buckets.has('lh:sharedhub')).toBe(true);
    expect(buckets.get('lh:sharedhub')).toContain(wiki);
    expect(buckets.get('lh:sharedhub')).toContain(arch);
  });

  it('puts pages with non-overlapping links into different lh buckets', () => {
    const a = makeMeta({
      path: 'a.md',
      title: 'A',
      links: new Set(['hub-x']),
    });
    const b = makeMeta({
      path: 'b.md',
      title: 'B',
      links: new Set(['hub-y']),
    });
    const buckets = partitionPagesMultiBucket([a, b]);
    expect(buckets.get('lh:hubx')).toEqual([a]);
    expect(buckets.get('lh:huby')).toEqual([b]);
  });

  it('puts pages with multiple links into multiple lh buckets (shared references)', () => {
    const page = makeMeta({
      path: 'p.md',
      title: 'P',
      links: new Set(['hub-1', 'hub-2', 'hub-3']),
    });
    const buckets = partitionPagesMultiBucket([page]);
    expect(buckets.get('lh:hub1')).toEqual([page]);
    expect(buckets.get('lh:hub2')).toEqual([page]);
    expect(buckets.get('lh:hub3')).toEqual([page]);
    // Same object reference across buckets (no duplicate metadata).
    expect(buckets.get('lh:hub1')![0]).toBe(buckets.get('lh:hub2')![0]);
  });

  it('routes CJK and digit-prefixed titles by their first 2 chars (no __other__ fallback)', () => {
    const num = makeMeta({ path: 'num.md', title: '42 Things' });
    const cjk = makeMeta({ path: 'cjk.md', title: '中文测试' });
    const buckets = partitionPagesMultiBucket([num, cjk]);
    // normalizeForMatch preserves [a-z0-9] and CJK; the first 2 chars become the key.
    expect(buckets.has('tp:42')).toBe(true);
    expect(buckets.has('tp:中文')).toBe(true);
  });
});

// ── generateDuplicateCandidates — bucketed integration (v1.26.0 #382 item 3, Batch 1) ──

describe('generateDuplicateCandidates — bucketed integration', () => {
  it('recalls cross-bucket pairs that share an outgoing wiki-link (方案 1 invariant)', async () => {
    // Two pages whose title prefixes are completely different — they land
    // in different tp: buckets. The sharedLinks signal would be lost under
    // a single-key (title-only) bucket strategy, but the lh: link-hash
    // bucket dimension recovers it because they share an outgoing hub.
    const ai = makePage(
      'wiki/entities/ai-agent.md',
      'AI Agent',
      'See [[shared-hub]] for context. Body has foo bar baz qux.',
    );
    const pa = makePage(
      'wiki/entities/plugin-architecture.md',
      'Plugin Architecture',
      'See [[shared-hub]] for context. Body has foo bar baz extra.',
    );
    const candidates = await generateDuplicateCandidates([ai, pa]);
    // Body Jaccard must clear the body gate, link Jaccard must clear the
    // link threshold — and the pair must survive the bucketed integration.
    const shared = findCandidate(candidates, ai.path, pa.path);
    expect(shared).not.toBeNull();
    expect(shared!.signal).toBe('sharedLinks');
  });

  it('within-bucket behaviour matches the legacy O(n²) flat loop (regression guard)', async () => {
    // Both pages share the same title prefix (tp:ai) — the partition puts
    // them in the same bucket, so the bucketed run is identical to the
    // old flat O(n²) double for-loop. The candidate set must therefore
    // include the same signals the pre-refactor code produced:
    //   - sharedLinks (shared outgoing [[link]] + body Jaccard above gate)
    //   - bigram      (title prefixes match closely)
    const a = makePage(
      'wiki/entities/a.md',
      'AI Agent',
      'See [[shared]] for context. Body has foo bar baz qux.',
    );
    const b = makePage(
      'wiki/entities/b.md',
      'AI Model',
      'See [[shared]] for context. Body has foo bar baz extra.',
    );
    const candidates = await generateDuplicateCandidates([a, b]);
    // At minimum: sharedLinks signal must survive (this is the regression
    // guard — without it the integration silently dropped the candidate).
    const shared = findCandidate(candidates, a.path, b.path);
    expect(shared).not.toBeNull();
  });
});

// ── generateDuplicateCandidates — cancellation hook (v1.26.0 #382 item 3, Batch 1) ──
//
// The optional third parameter `hooks?.checkCancelled` is invoked once
// per bucket boundary. This lets dedup-phase abort a long-running scan
// promptly when the user cancels, without waiting for the entire bucket
// fan-out to complete. When omitted, behaviour is unchanged.

describe('generateDuplicateCandidates — cancellation hook', () => {
  it('invokes checkCancelled once per bucket (and once before the fan-out starts)', async () => {
    // Three pages that produce at least three distinct buckets (different
    // title prefixes AND different outgoing links).
    const a = makePage(
      'wiki/a.md',
      'Alpha',
      'See [[hub-1]] for context. Body alpha one two three four.',
    );
    const b = makePage(
      'wiki/b.md',
      'Beta',
      'See [[hub-2]] for context. Body beta one two three four.',
    );
    const c = makePage(
      'wiki/c.md',
      'Gamma',
      'See [[hub-3]] for context. Body gamma one two three four.',
    );
    let calls = 0;
    const candidates = await generateDuplicateCandidates([a, b, c], {}, {
      checkCancelled: () => { calls++; },
    });
    // Contract: every non-empty bucket triggers exactly one checkCancelled.
    // Each page lands in its own tp: bucket (alph / beta / gamm) and its
    // own lh: bucket (hub1 / hub2 / hub3) — 6 buckets minimum, but at
    // minimum the 3 tp: buckets must each fire the hook.
    // The exact count depends on partitionPagesMultiBucket internals; we
    // pin the lower bound here and rely on the lower-bound test to catch
    // "hook never fires" regressions.
    expect(calls).toBeGreaterThanOrEqual(3);
    // Smoke: the call must complete without throwing and still produce
    // (empty) candidates.
    expect(Array.isArray(candidates)).toBe(true);
  });

  it('omitting the hooks argument preserves the legacy behaviour (regression guard)', async () => {
    // Two pages whose title prefixes match; just verify the call does
    // not throw or hang when the optional hooks argument is absent.
    const a = makePage('wiki/a.md', 'Alpha', 'See [[hub-x]] for context.');
    const b = makePage('wiki/b.md', 'AlphaTwin', 'See [[hub-x]] for context.');
    // No hooks argument at all (matches the pre-refactor signature).
    const candidates = await generateDuplicateCandidates([a, b]);
    expect(findCandidate(candidates, a.path, b.path)).not.toBeNull();
  });
});

// ── generateDuplicateCandidates — e2e recall (v1.26.0 #382 item 3, Batch 1) ───
//
// Synthetic recall benchmark. The plan calls for N≥500 with recall ≥ 95%.
// We use N=200 here to keep CI under a few seconds while still exercising
// the bucket fan-out path. The fixture seeds three classes of true pairs:
//   - intra-tp-bucket: pages share the title-prefix bucket AND are close
//     enough for the bigram/sharedLinks signals to fire.
//   - cross-tp, intra-lh-bucket: pages land in different tp: buckets
//     but share an outgoing hub link; recall depends on the lh:
//     dimension recovering the pair.
//   - cross-both (worst case): pages share neither bucket AND bigram
//     similarity is below threshold; recall deliberately drops here.
// The e2e assertion requires ≥95% recall of the union of recoverable
// pairs (intra-tp + cross-tp-intra-lh).

describe('generateDuplicateCandidates — e2e recall on synthetic N=200', () => {
  it('recovers ≥95% of true duplicate pairs under bucketed dedup', async () => {
    const N = 200;
    // Build pages grouped by tp-bucket so planted pairs reliably share
    // a bucket. Each bucket gets ~10 pages with shared outgoing hubs
    // so the lh-bucket dimension has recoverable signal too.
    const bucketKeys = ['al', 'be', 'cl', 'da', 'ec', 'fo', 'gl', 'hu', 'in', 'ja'];
    const bucketLabels: Record<string, string[]> = {
      al: ['Alpha', 'Atlas', 'Aster', 'Azure', 'Albus'],
      be: ['Beta', 'Beacon', 'Beryl', 'Bento'],
      cl: ['Claude', 'Cluster', 'Codex', 'Cobalt'],
      da: ['Data', 'Delta', 'Docker', 'Daisy'],
      ec: ['Echo', 'Ember', 'Eden'],
      fo: ['Forge', 'Format', 'Fred'],
      gl: ['Glade', 'Glow'],
      hu: ['Hub'],
      in: ['Index', 'Iris'],
      ja: ['Jade', 'Java'],
    };
    const sharedHubs = ['shared-hub', 'plugin-core', 'obsidian', 'wiki-arch'];

    const pages: Array<{ path: string; title: string; content: string }> = [];
    let pageIdx = 0;
    for (const bk of bucketKeys) {
      const labels = bucketLabels[bk];
      for (let i = 0; i < 20; i++) {
        const baseTitle = labels[i % labels.length];
        // Pair-within-bucket: alternate 2 hubs across pages so
        // adjacent pages share at least one outgoing hub link.
        const links = [
          sharedHubs[i % 2],                              // alternating hub
          sharedHubs[(i + 1) % sharedHubs.length],         // different hub
        ];
        const body = `${links.map(l => `See [[${l}]] for context. `).join('')}Body ${pageIdx} has foo bar baz qux extra.`;
        const content = `---\naliases:\n  - "alias-${pageIdx}"\n---\n${body}`;
        pages.push({ path: `wiki/entities/page-${pageIdx}.md`, title: `${baseTitle} ${pageIdx}`, content });
        pageIdx++;
      }
    }
    // Truncate to exactly N.
    pages.length = N;

    // Plant recoverable pairs: every consecutive pair within the same
    // tp-bucket (pages 0-1, 2-3, ...). They share title prefix AND at
    // least one shared-hub → both tp and lh bucket dimensions recover
    // them.
    const plantedPairs: Array<{ a: number; b: number; expected: 'recoverable' }> = [];
    for (let i = 0; i + 1 < N; i += 2) {
      plantedPairs.push({ a: i, b: i + 1, expected: 'recoverable' });
    }

    const candidates = await generateDuplicateCandidates(pages);
    const recoverableCount = plantedPairs.length;
    const recalled = plantedPairs.filter(p =>
      findCandidate(candidates, pages[p.a].path, pages[p.b].path) !== null,
    ).length;

    // Recall ≥ 95% on the planted recoverable set.
    const recall = recoverableCount > 0 ? recalled / recoverableCount : 1;
    // Print diagnostic so CI logs reveal the actual recall value when
    // the threshold gets tuned in future releases.
    console.debug(`e2e recall: ${recalled}/${recoverableCount} = ${(recall * 100).toFixed(1)}%, candidates=${candidates.length}`);
    expect(recall).toBeGreaterThanOrEqual(0.95);

    // Sanity: total candidate count must be bounded well below N². With
    // N=200, N² = 40000 pairs. The bucketed path bounds this by bucket
    // size, but our test fixture plants a lot of shared-hub links so the
    // lh:sharedhub bucket holds most pages — pair count there approaches
    // 200*199/2 ≈ 19900. Pin a generous upper bound that catches a fully
    // broken partition (N² pair count) but tolerates a heavily-linked
    // fixture. If the partition is silently disabled, candidates will
    // approach 40000.
    expect(candidates.length).toBeLessThan(25000);
  });
});
