import { describe, it, expect } from 'vitest';
import {
  bodyWordSet,
  computeJaccard,
  generateDuplicateCandidates,
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
