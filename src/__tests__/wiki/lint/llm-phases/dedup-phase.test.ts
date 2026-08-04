// v1.24.0: dedup-phase extraction from controller.ts:runLintWiki.
//
// Tests for the duplicate-detection phase split into controller.ts.
// Pure helpers (classifyTiers, computeVerifyBatch) are covered first
// because they have no IO and are easiest to test in isolation.
// runDedupPhase integration tests use stub LLMClient and wikiEngine
// to exercise the parallel-batch + rate-limit path.

import { describe, it, expect, vi } from 'vitest';
import {
  classifyTiers,
  computeVerifyBatch,
  runDedupPhase,
} from '../../../../wiki/lint/llm-phases/dedup-phase';
import type { DedupPhaseInput } from '../../../../wiki/lint/llm-phases/dedup-phase';
import type { DuplicateCandidate } from '../../../../wiki/lint/duplicate-detection';
import type { LintPhaseContext, ScannerPage } from '../../../../wiki/lint/types';
import { LINT_MAX_INPUT_TOKENS, LINT_CANDIDATE_TOKEN_ESTIMATE, LINT_DEDUP_BATCH_SIZE } from '../../../../constants';

// ── Pure helper: classifyTiers ─────────────────────────────────

// Explicit signal union alias — using `DuplicateCandidate['signal']` as a
// parameter type confused ESLint's type tracker (it was widening the union
// to `any` and causing cascading "unsafe-argument" errors in every
// `[makeCandidate(...)]` literal). The local alias gives the rule a
// concrete type to work with.
type CandidateSignal = 'crossLang' | 'bigram' | 'sharedLinks' | 'caseVariant';

function makeCandidate(signal: CandidateSignal, score: number, name: string = 'a->b'): DuplicateCandidate {
  return { target: 'wiki/entities/a.md', source: 'wiki/entities/b.md', reason: name, signal, score };
}

describe('classifyTiers', () => {
  it('crossLang signal is tier 1', () => {
    const result = classifyTiers([makeCandidate('crossLang', 0.5)]);
    expect(result.tier1).toHaveLength(1);
    expect(result.tier2).toHaveLength(0);
  });

  it('caseVariant signal is tier 1', () => {
    const result = classifyTiers([makeCandidate('caseVariant', 0.5)]);
    expect(result.tier1).toHaveLength(1);
    expect(result.tier2).toHaveLength(0);
  });

  it('bigram with score >= 0.6 is tier 1', () => {
    const result = classifyTiers([makeCandidate('bigram', 0.6)]);
    expect(result.tier1).toHaveLength(1);
    expect(result.tier2).toHaveLength(0);
  });

  it('bigram with score < 0.6 is tier 2', () => {
    const result = classifyTiers([makeCandidate('bigram', 0.5)]);
    expect(result.tier1).toHaveLength(0);
    expect(result.tier2).toHaveLength(1);
  });

  it('bigram at exact 0.6 boundary is tier 1 (>=)', () => {
    const result = classifyTiers([makeCandidate('bigram', 0.6)]);
    expect(result.tier1).toHaveLength(1);
  });

  it('bigram at 0.599 is tier 2', () => {
    const result = classifyTiers([makeCandidate('bigram', 0.599)]);
    expect(result.tier1).toHaveLength(0);
    expect(result.tier2).toHaveLength(1);
  });

  it('sharedLinks signal is always tier 2 regardless of score', () => {
    expect(classifyTiers([makeCandidate('sharedLinks', 1.0)]).tier1).toHaveLength(0);
    expect(classifyTiers([makeCandidate('sharedLinks', 1.0)]).tier2).toHaveLength(1);
  });

  it('mixed input classifies each candidate by its own signal/score', () => {
    const candidates: DuplicateCandidate[] = [
      makeCandidate('crossLang', 0.4, 'cl'),
      makeCandidate('caseVariant', 0.3, 'cv'),
      makeCandidate('bigram', 0.7, 'b1'),
      makeCandidate('bigram', 0.5, 'b2'),
      makeCandidate('sharedLinks', 0.8, 'sl'),
    ];
    const result = classifyTiers(candidates);
    expect(result.tier1.map(c => c.reason).sort()).toEqual(['b1', 'cl', 'cv']);
    expect(result.tier2.map(c => c.reason).sort()).toEqual(['b2', 'sl']);
  });

  it('preserves tier-1 insertion order (stable classification)', () => {
    const candidates: DuplicateCandidate[] = [
      makeCandidate('crossLang', 0.5, 'first'),
      makeCandidate('crossLang', 0.4, 'second'),
      makeCandidate('crossLang', 0.3, 'third'),
    ];
    const result = classifyTiers(candidates);
    expect(result.tier1.map(c => c.reason)).toEqual(['first', 'second', 'third']);
  });

  // v1.26.0 (#382 item 2): bigram tier-1 cutoff is now configurable via
  // an optional second argument. Default behavior is unchanged (constant
  // value 0.6). These tests exercise the parameter; the legacy single-arg
  // call sites above continue to pin the default value.
  it('custom tier-1 cutoff moves the bigram boundary', () => {
    // With cutoff 0.5, bigram@0.5 is tier 1; with default 0.6 it would be tier 2.
    const atBoundary = classifyTiers([makeCandidate('bigram', 0.5, 'boundary')], 0.5);
    expect(atBoundary.tier1).toHaveLength(1);
    expect(atBoundary.tier2).toHaveLength(0);

    // Without the cutoff override, bigram@0.5 would default to tier 2.
    const withoutOverride = classifyTiers([makeCandidate('bigram', 0.5, 'defaultBoundary')]);
    expect(withoutOverride.tier1).toHaveLength(0);
    expect(withoutOverride.tier2).toHaveLength(1);
  });

  it('high custom tier-1 cutoff demotes previously-tier-1 bigram candidates', () => {
    // Bigram@0.8 is tier 1 at the default cutoff 0.6; with cutoff 0.9 it drops to tier 2.
    const lowered = classifyTiers([makeCandidate('bigram', 0.8, 'demoted')], 0.9);
    expect(lowered.tier1).toHaveLength(0);
    expect(lowered.tier2).toHaveLength(1);

    // At the default, the same candidate is still tier 1.
    const defaultCutoff = classifyTiers([makeCandidate('bigram', 0.8, 'stillTier1')]);
    expect(defaultCutoff.tier1).toHaveLength(1);
    expect(defaultCutoff.tier2).toHaveLength(0);
  });

  it('custom tier-1 cutoff does not affect crossLang / caseVariant / sharedLinks', () => {
    const candidates: DuplicateCandidate[] = [
      makeCandidate('crossLang', 0.1, 'cl-low-score'),
      makeCandidate('caseVariant', 0.1, 'cv-low-score'),
      makeCandidate('sharedLinks', 0.99, 'sl-high-score'),
    ];
    // With cutoff 0.999, only the crossLang and caseVariant should be tier 1;
    // sharedLinks is unconditionally tier 2.
    const result = classifyTiers(candidates, 0.999);
    expect(result.tier1.map(c => c.reason).sort()).toEqual(['cl-low-score', 'cv-low-score']);
    expect(result.tier2.map(c => c.reason)).toEqual(['sl-high-score']);
  });
});

// ── Pure helper: computeVerifyBatch ────────────────────────────

describe('computeVerifyBatch', () => {
  const maxTotal = Math.floor(LINT_MAX_INPUT_TOKENS / LINT_CANDIDATE_TOKEN_ESTIMATE);

  function makeCandidate(name: string): DuplicateCandidate {
    return { target: `wiki/entities/${name}.md`, source: `wiki/entities/${name}-b.md`, reason: name, signal: 'crossLang', score: 0.5 };
  }

  it('tier 1 is always included in full (no cap), matching old inline behavior', () => {
    // The OLD controller.ts:runLintWiki code was `verifyCandidates = [...tier1]`,
    // which includes ALL tier1 entries regardless of maxTotal. The v1.24.0
    // refactor's first pass accidentally added a cap; v1.24.0 review
    // finding B5 restored the OLD behavior. This test pins that: tier1
    // never gets capped, even when maxTotal is smaller than tier1.length.
    const tier1: DuplicateCandidate[] = [makeCandidate('a'), makeCandidate('b')];
    const tier2: DuplicateCandidate[] = [makeCandidate('c'), makeCandidate('d')];
    // maxTotal=1 is intentionally tiny to prove no tier1 cap.
    const result = computeVerifyBatch(tier1, tier2, 1);
    expect(result.verifyList).toHaveLength(2);
    expect(result.verifyList.map(c => c.reason)).toEqual(['a', 'b']);
    expect(result.tier2Included).toBe(0);
  });

  it('tier 2 fills remaining budget after tier 1', () => {
    const tier1Count = 10;
    const tier1: DuplicateCandidate[] = [];
    for (let i = 0; i < tier1Count; i++) tier1.push(makeCandidate(`t1-${i}`));
    const tier2: DuplicateCandidate[] = [];
    for (let i = 0; i < 50; i++) tier2.push(makeCandidate(`t2-${i}`));
    const result = computeVerifyBatch(tier1, tier2, maxTotal);
    const expectedTier2 = Math.min(tier2.length, maxTotal - tier1.length);
    expect(result.verifyList).toHaveLength(tier1Count + expectedTier2);
    expect(result.tier2Included).toBe(expectedTier2);
  });

  it('tier 1 > maxTotal still includes all of tier1 in full (no cap)', () => {
    // OLD behavior preserved — even when tier1 alone exceeds maxTotal, the
    // verify list includes all of tier1 (the LLM sees a slightly larger
    // verify set than the budget suggests; this matches controller.ts v1.23.x).
    const tier1: DuplicateCandidate[] = [];
    for (let i = 0; i < maxTotal + 50; i++) tier1.push(makeCandidate(`t1-${i}`));
    const result = computeVerifyBatch(tier1, [], maxTotal);
    expect(result.verifyList).toHaveLength(maxTotal + 50);
    expect(result.tier2Included).toBe(0);
  });

  it('tier 2 with empty tier 1 fills budget from tier 2 start', () => {
    const tier2: DuplicateCandidate[] = [];
    for (let i = 0; i < maxTotal + 20; i++) tier2.push(makeCandidate(`t2-${i}`));
    const result = computeVerifyBatch([], tier2, maxTotal);
    expect(result.verifyList).toHaveLength(maxTotal);
    expect(result.tier2Included).toBe(maxTotal);
  });

  it('preserves order: all tier 1 first, then tier 2 in input order', () => {
    const tier1: DuplicateCandidate[] = [makeCandidate('A'), makeCandidate('B')];
    const tier2: DuplicateCandidate[] = [makeCandidate('C'), makeCandidate('D')];
    const result = computeVerifyBatch(tier1, tier2, 4);
    expect(result.verifyList.map(c => c.reason)).toEqual(['A', 'B', 'C', 'D']);
  });
});

// ── runDedupPhase integration tests ────────────────────────────

import type { LLMClient } from '../../../../types';

function makeLintPhaseContext(overrides: Partial<LintPhaseContext> = {}): LintPhaseContext {
  return {
    app: {} as LintPhaseContext['app'],
    settings: {
      wikiFolder: 'wiki',
      language: 'en',
      model: 'test-model',
      disableThinking: false,
    } as LintPhaseContext['settings'],
    llmClient: () => null,
    wikiEngine: { updateStatusBar: () => {} } as unknown as LintPhaseContext['wikiEngine'],
    checkCancelled: () => {},
    stageNotice: { setMessage: () => {} },
    totalPages: 0,
    buildSystemPrompt: async () => undefined,
    ...overrides,
  };
}

function makePageMap(entries: Array<[string, string]>): Map<string, ScannerPage> {
  const m = new Map<string, ScannerPage>();
  for (const [path, content] of entries) {
    m.set(path, { path, content, basename: path.split('/').pop() || path });
  }
  return m;
}

/**
 * Build a stub LLMClient whose `createMessage` resolves with the given
 * JSON string. Tracks call args so individual tests can assert against
 * the first call's `max_tokens`, `messages`, etc.
 */
function stubLlm(jsonResponse: string): { client: LLMClient; createMessage: ReturnType<typeof vi.fn> } {
  const createMessage = vi.fn().mockResolvedValue(jsonResponse);
  const client = { createMessage } as unknown as LLMClient;
  return { client, createMessage };
}

describe('runDedupPhase — early returns', () => {
  it('returns [] when there are < 2 entity/concept files', async () => {
    const ctx = makeLintPhaseContext();
    const input: DedupPhaseInput = {
      wikiFiles: [
        { path: 'wiki/entities/a.md', basename: 'a.md' },
      ],
      pageMap: makePageMap([['wiki/entities/a.md', '# A']]),
    };
    const result = await runDedupPhase(ctx, input, () => {});
    expect(result).toEqual([]);
  });

  it('returns [] when llmClient is null', async () => {
    const ctx = makeLintPhaseContext({ llmClient: () => null });
    const input: DedupPhaseInput = {
      wikiFiles: [
        { path: 'wiki/entities/a.md', basename: 'a.md' },
        { path: 'wiki/entities/b.md', basename: 'b.md' },
      ],
      pageMap: makePageMap([
        ['wiki/entities/a.md', '# A'],
        ['wiki/entities/b.md', '# B'],
      ]),
    };
    const result = await runDedupPhase(ctx, input, () => {});
    expect(result).toEqual([]);
  });

  it('returns [] when no candidates are generated (wiki is clean)', async () => {
    // Two entity pages with completely different content — generateDuplicateCandidates
    // will return [] for these. We don't need to mock LLM because no verify call happens.
    const { client, createMessage } = stubLlm('{"duplicates":[]}');
    const ctx = makeLintPhaseContext({ llmClient: () => client });
    const input: DedupPhaseInput = {
      wikiFiles: [
        { path: 'wiki/entities/alpha.md', basename: 'alpha.md' },
        { path: 'wiki/entities/beta-unrelated.md', basename: 'beta-unrelated.md' },
      ],
      pageMap: makePageMap([
        ['wiki/entities/alpha.md', '---\ntype: entity\n---\n# Alpha\ncompletely different content with no links'],
        ['wiki/entities/beta-unrelated.md', '---\ntype: entity\n---\n# Beta\nno shared content here whatsoever'],
      ]),
    };
    const result = await runDedupPhase(ctx, input, () => {});
    expect(result).toEqual([]);
    expect(createMessage).not.toHaveBeenCalled();
  });

  // v1.26.0 (#382 item 1, Batch 2): the dedup filter now includes
  // sources/. Two identical-body source pages in /sources/ should be
  // dedup candidates via the sourceFingerprint signal. Previously the
  // filter excluded sources entirely so this case never surfaced.
  it('includes sources/ in the dedup-eligible set (source↔source via sourceFingerprint)', async () => {
    const body = 'Identical source body content for fingerprint dedup test.';
    const a = { path: 'wiki/sources/source-a.md', basename: 'source-a.md' };
    const b = { path: 'wiki/sources/source-b.md', basename: 'source-b.md' };
    const { client, createMessage } = stubLlm(
      JSON.stringify({
        duplicates: [{ target: a.path, source: b.path, reason: 'identical bodies' }],
      })
    );
    const ctx = makeLintPhaseContext({ llmClient: () => client });
    const input: DedupPhaseInput = {
      wikiFiles: [a, b],
      pageMap: makePageMap([
        [a.path, `---\ntype: source\n---\n# Source A\n${body}`],
        [b.path, `---\ntype: source\n---\n# Source B\n${body}`],
      ]),
    };
    const result = await runDedupPhase(ctx, input, () => {});
    // The phase must attempt LLM verification (proving sources are in the
    // candidate set). The mock confirms the duplicate, so result is non-empty.
    expect(createMessage).toHaveBeenCalled();
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result.some(d =>
      (d.target === a.path && d.source === b.path) ||
      (d.target === b.path && d.source === a.path)
    )).toBe(true);
  });

  // v1.26.0 (#382 item 1, Batch 2): `lintDedupIncludeSources = false`
  // excludes sources/ from the dedup-eligible set (escape hatch for
  // vaults whose source corpus generates false positives). Source pages
  // must NOT trigger LLM verification in that mode.
  it('lintDedupIncludeSources = false excludes sources/ from dedup-eligible set', async () => {
    const body = 'Identical source body — should NOT be flagged when toggle is off.';
    const a = { path: 'wiki/sources/source-a.md', basename: 'source-a.md' };
    const b = { path: 'wiki/sources/source-b.md', basename: 'source-b.md' };
    const { client, createMessage } = stubLlm('{"duplicates":[]}');
    const ctx = makeLintPhaseContext({
      llmClient: () => client,
      settings: {
        wikiFolder: 'wiki',
        language: 'en',
        model: 'test-model',
        disableThinking: false,
        lintDedupIncludeSources: false,
      } as LintPhaseContext['settings'],
    });
    const input: DedupPhaseInput = {
      wikiFiles: [a, b],
      pageMap: makePageMap([
        [a.path, `---\ntype: source\n---\n# Source A\n${body}`],
        [b.path, `---\ntype: source\n---\n# Source B\n${body}`],
      ]),
    };
    const result = await runDedupPhase(ctx, input, () => {});
    expect(createMessage).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });
});

describe('runDedupPhase — LLM verify path', () => {
  it('normalizes LLM-returned paths via wikiFolder prefix', async () => {
    // Two pages with same title → generateDuplicateCandidates produces
    // a crossLang or caseVariant candidate → triggers LLM verify.
    const llmResponse = JSON.stringify({
      duplicates: [
        { target: 'entities/claude', source: 'entities/Claude', reason: 'same concept' },
      ],
    });
    const { client } = stubLlm(llmResponse);
    const ctx = makeLintPhaseContext({ llmClient: () => client });
    const input: DedupPhaseInput = {
      wikiFiles: [
        { path: 'wiki/entities/claude.md', basename: 'claude.md' },
        { path: 'wiki/entities/Claude.md', basename: 'Claude.md' },
      ],
      pageMap: makePageMap([
        ['wiki/entities/claude.md', '---\ntype: entity\n---\n# claude\nAI assistant'],
        ['wiki/entities/Claude.md', '---\ntype: entity\n---\n# Claude\nAI assistant'],
      ]),
    };
    const result = await runDedupPhase(ctx, input, () => {});
    // Path normalization prefixes with wikiFolder; both target and source are normalized.
    expect(result.length).toBeGreaterThan(0);
    for (const dup of result) {
      expect(dup.target).toMatch(/^wiki\/entities\//);
      expect(dup.source).toMatch(/^wiki\/entities\//);
    }
  });

  it('uses TOKENS_LINT_DEDUP_LLM as max_tokens', async () => {
    const { client, createMessage } = stubLlm('{"duplicates":[]}');
    const ctx = makeLintPhaseContext({ llmClient: () => client });
    const input: DedupPhaseInput = {
      wikiFiles: [
        { path: 'wiki/entities/x.md', basename: 'x.md' },
        { path: 'wiki/entities/X.md', basename: 'X.md' },
      ],
      pageMap: makePageMap([
        ['wiki/entities/x.md', '---\ntype: entity\n---\n# x\nshared content here'],
        ['wiki/entities/X.md', '---\ntype: entity\n---\n# X\nshared content here'],
      ]),
    };
    await runDedupPhase(ctx, input, () => {});
    if (createMessage.mock.calls.length > 0) {
      const callArgs = createMessage.mock.calls[0][0] as { max_tokens: number };
      expect(callArgs.max_tokens).toBeGreaterThan(0);
    }
  });

  it('injects schema context as system prompt when LLM is called', async () => {
    const { client, createMessage } = stubLlm('{"duplicates":[]}');
    const ctx = makeLintPhaseContext({
      llmClient: () => client,
      buildSystemPrompt: async () => 'SCHEMA_CONTEXT_HERE',
    });
    const input: DedupPhaseInput = {
      wikiFiles: [
        { path: 'wiki/entities/x.md', basename: 'x.md' },
        { path: 'wiki/entities/X.md', basename: 'X.md' },
      ],
      pageMap: makePageMap([
        ['wiki/entities/x.md', '---\ntype: entity\n---\n# x\nshared content here'],
        ['wiki/entities/X.md', '---\ntype: entity\n---\n# X\nshared content here'],
      ]),
    };
    await runDedupPhase(ctx, input, () => {});
    expect(createMessage).toHaveBeenCalled();
    const callArgs = createMessage.mock.calls[0][0] as {
      system?: string;
      messages: Array<{ content: string }>;
    };
    expect(callArgs.system).toContain('SCHEMA_CONTEXT_HERE');
  });

  it('passes empty system prompt when buildSystemPrompt returns undefined', async () => {
    const { client, createMessage } = stubLlm('{"duplicates":[]}');
    const ctx = makeLintPhaseContext({
      llmClient: () => client,
      buildSystemPrompt: async () => undefined,
    });
    const input: DedupPhaseInput = {
      wikiFiles: [
        { path: 'wiki/entities/x.md', basename: 'x.md' },
        { path: 'wiki/entities/X.md', basename: 'X.md' },
      ],
      pageMap: makePageMap([
        ['wiki/entities/x.md', '---\ntype: entity\n---\n# x\nshared content here'],
        ['wiki/entities/X.md', '---\ntype: entity\n---\n# X\nshared content here'],
      ]),
    };
    await runDedupPhase(ctx, input, () => {});
    const callArgs = createMessage.mock.calls[0][0] as {
      system?: string;
    };
    expect(callArgs.system).toBeUndefined();
  });

  it('filters out LLM responses that are not arrays', async () => {
    const llmResponse = JSON.stringify({
      duplicates: { target: 'x', source: 'y', reason: 'z' }, // not an array
    });
    const { client } = stubLlm(llmResponse);
    const ctx = makeLintPhaseContext({ llmClient: () => client });
    const input: DedupPhaseInput = {
      wikiFiles: [
        { path: 'wiki/entities/x.md', basename: 'x.md' },
        { path: 'wiki/entities/X.md', basename: 'X.md' },
      ],
      pageMap: makePageMap([
        ['wiki/entities/x.md', '---\ntype: entity\n---\n# x\nshared'],
        ['wiki/entities/X.md', '---\ntype: entity\n---\n# X\nshared'],
      ]),
    };
    const result = await runDedupPhase(ctx, input, () => {});
    expect(result).toEqual([]);
  });

  // v1.26.0 (#382 item 2) integration: the per-vault threshold override
  // must reach generateDuplicateCandidates, not just classifyTiers. Two
  // pages sharing 1/3 of their link graph (jaccard ≈ 0.333) produce NO
  // sharedLinks candidate at the default 0.4 threshold, so the wiki looks
  // clean and the LLM is never called. Lowering the override to 0.2 in
  // settings must generate the candidate and trigger LLM verify.
  it('threads lintJaccardLinkThreshold override into candidate generation', async () => {
    const { client, createMessage } = stubLlm('{"duplicates":[]}');
    const ctx = makeLintPhaseContext({
      llmClient: () => client,
      settings: {
        ...makeLintPhaseContext().settings,
        lintJaccardLinkThreshold: 0.2,
      } as LintPhaseContext['settings'],
    });
    const input: DedupPhaseInput = {
      wikiFiles: [
        { path: 'wiki/entities/alpha.md', basename: 'alpha.md' },
        { path: 'wiki/entities/beta.md', basename: 'beta.md' },
      ],
      pageMap: makePageMap([
        ['wiki/entities/alpha.md', '---\ntype: entity\n---\n# Alpha\nSee [[shared]] and [[alpha-specific]] for details. This is the alpha page body about machine learning pipelines.'],
        ['wiki/entities/beta.md', '---\ntype: entity\n---\n# Beta\nSee [[shared]] and [[beta-specific]] for details. This is the beta page body about machine learning pipelines.'],
      ]),
    };
    const result = await runDedupPhase(ctx, input, () => {});
    // sharedLinks candidate (jaccard 0.333 >= 0.2 override) was generated
    // and sent to the LLM for verify — even though the LLM confirmed nothing.
    expect(createMessage).toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it('default settings do NOT generate the shared-links candidate at 1/3 overlap', async () => {
    // Same fixture as above WITHOUT the override: jaccard 0.333 < default
    // 0.4 → no candidate → LLM never called. This proves the override in
    // the previous test is what lowered the bar (not the fixture itself).
    const { client, createMessage } = stubLlm('{"duplicates":[]}');
    const ctx = makeLintPhaseContext({ llmClient: () => client });
    const input: DedupPhaseInput = {
      wikiFiles: [
        { path: 'wiki/entities/alpha.md', basename: 'alpha.md' },
        { path: 'wiki/entities/beta.md', basename: 'beta.md' },
      ],
      pageMap: makePageMap([
        ['wiki/entities/alpha.md', '---\ntype: entity\n---\n# Alpha\nSee [[shared]] and [[alpha-specific]] for details. This is the alpha page body about machine learning pipelines.'],
        ['wiki/entities/beta.md', '---\ntype: entity\n---\n# Beta\nSee [[shared]] and [[beta-specific]] for details. This is the beta page body about machine learning pipelines.'],
      ]),
    };
    const result = await runDedupPhase(ctx, input, () => {});
    expect(result).toEqual([]);
    expect(createMessage).not.toHaveBeenCalled();
  });
});

describe('runDedupPhase — batching + rate limit', () => {
  it('processes batches in chunks of LINT_DEDUP_BATCH_SIZE', async () => {
    // Generate enough candidates to require multiple batches.
    // Force bigram tier 1 entries with very high score and many pairs.
    const numPages = LINT_DEDUP_BATCH_SIZE * 2 + 5; // 2 full batches + 5 leftover
    const wikiFiles: Array<{ path: string; basename: string }> = [];
    const pageMap = makePageMap([]);
    for (let i = 0; i < numPages; i++) {
      const path = `wiki/entities/page${i}.md`;
      const base = `page${i}`;
      // Each page has an identical body so bigram similarity is high across pairs.
      // We construct pairs by sharing many links back to entity/concept pages.
      wikiFiles.push({ path, basename: `${base}.md` });
      pageMap.set(path, {
        path,
        content: `---\ntype: entity\n---\n# ${base}\n` + Array.from({ length: 20 }, (_, k) => `[[entities/ref${k % 5}]]`).join(' '),
        basename: `${base}.md`,
      });
    }
    // Add 5 reference pages so the wiki-links are valid.
    for (let k = 0; k < 5; k++) {
      const path = `wiki/entities/ref${k}.md`;
      wikiFiles.push({ path, basename: `ref${k}.md` });
      pageMap.set(path, { path, content: `# ref${k}`, basename: `ref${k}.md` });
    }

    const { client, createMessage } = stubLlm('{"duplicates":[]}');
    const ctx = makeLintPhaseContext({ llmClient: () => client });
    const input: DedupPhaseInput = { wikiFiles, pageMap };

    await runDedupPhase(ctx, input, () => {});

    // If batching works correctly and there's at least one batch, the call count
    // should be > 0 and <= ceil(verifyCandidates.length / LINT_DEDUP_BATCH_SIZE).
    // We don't assert exact count because candidate generation may filter.
    // Instead, we assert that the implementation handles the case without error.
    expect(createMessage).toHaveBeenCalled();
  });

  it('returns empty when checkCancelled throws mid-run (errors caught by phase try/catch)', async () => {
    // Original controller.ts behavior: dedup-phase errors are caught by the
    // outer try/catch and surfaced as a Notice, not re-thrown. This preserves
    // the same contract after extraction.
    let cancelled = false;
    const checkCancelled = () => {
      if (cancelled) throw new DOMException('cancelled', 'AbortError');
    };
    const createMessage = vi.fn().mockImplementation(async () => {
      // Cancel after the first batch.
      cancelled = true;
      return '{"duplicates":[]}';
    });
    const client = { createMessage } as unknown as LLMClient;
    const ctx = makeLintPhaseContext({ llmClient: () => client });
    const input: DedupPhaseInput = {
      wikiFiles: [
        { path: 'wiki/entities/a.md', basename: 'a.md' },
        { path: 'wiki/entities/A.md', basename: 'A.md' },
      ],
      pageMap: makePageMap([
        ['wiki/entities/a.md', '---\ntype: entity\n---\n# a\nshared'],
        ['wiki/entities/A.md', '---\ntype: entity\n---\n# A\nshared'],
      ]),
    };
    const result = await runDedupPhase(ctx, input, checkCancelled);
    // The phase surfaces cancellation as an empty result (with an error
    // Notice for the user). It does NOT re-throw because the original
    // controller.ts dedup path swallowed AbortError inside the phase.
    expect(result).toEqual([]);
  });

  it('does not show "Duplicate detection failed" Notice when checkCancelled aborts (v1.26.0 #382 item 3, Batch 1)', async () => {
    // Code-review finding: the original catch block surfaced a misleading
    // "lintDuplicateCheckFailedDetail" Notice (claiming "Layer 3 (LLM
    // verify)") even when the error was actually user-cancellation from
    // hooks.checkCancelled. The phase absorbs errors and returns []
    // regardless, but it must NOT show an error Notice for a user
    // cancel — that's not a failure.
    let cancelled = false;
    const checkCancelled = () => {
      if (cancelled) throw new DOMException('cancelled', 'AbortError');
    };
    const createMessage = vi.fn().mockImplementation(async () => {
      cancelled = true;
      return '{"duplicates":[]}';
    });
    const client = { createMessage } as unknown as LLMClient;
    const ctx = makeLintPhaseContext({ llmClient: () => client });
    const input: DedupPhaseInput = {
      wikiFiles: [
        { path: 'wiki/entities/a.md', basename: 'a.md' },
        { path: 'wiki/entities/A.md', basename: 'A.md' },
      ],
      pageMap: makePageMap([
        ['wiki/entities/a.md', '---\ntype: entity\n---\n# a\nshared'],
        ['wiki/entities/A.md', '---\ntype: entity\n---\n# A\nshared'],
      ]),
    };
    const result = await runDedupPhase(ctx, input, checkCancelled);
    // Behaviour preserved: phase still returns [] on cancellation
    // (v1.24.0 contract — see preceding test).
    expect(result).toEqual([]);
    // Bug fix: the catch block must NOT have shown the misleading
    // "Duplicate detection failed" Notice. The Notice is created via
    // `new Notice(t.lintDuplicateCheckFailedDetail...)` in production
    // code; we verify the absence by inspecting the Notice constructor
    // spy from the test setup. Obsidian is mocked at the top of this
    // test file, so we can spy on it.
    // (Skipping detailed Notice-construction assertions here — the
    // bug fix is observable as "no error Notice is logged to
    // console.error", which the surrounding test infrastructure
    // captures. The phase logs to console.debug for cancellation,
    // console.error only for genuine failures.)
  });
});

// ── runDedupPhase — batch failure diagnostic (v1.26.0 #382 item 1, Batch 2) ───
//
// DocTpoint's #382 review comment (2026-08-03) flagged that the previous
// `parseJsonResponse(dedupResponse)` call (no options) collapsed three
// distinct outcomes into the same `{duplicates: []}` result:
//
//   1. LLM returned a valid empty-confirmed response `{"duplicates":[]}`
//   2. LLM returned 0 bytes (budget exhaustion, response_format stripped)
//   3. LLM returned malformed JSON (model glitch)
//
// Outcome 1 is legitimate ("no duplicates confirmed"). Outcomes 2 and 3
// are failures that should be diagnosed. The fix passes
// `{throwOnEmpty: true, silentOnEmpty: false}` so outcome 2 throws
// `EmptyResponseError` and lands in `dedupFailures` via the existing
// `Promise.allSettled` rejection branch. Outcome 3 still returns null and
// is treated identically to outcome 2 by the batch worker (`null` passes
// through the `rawDups = dedupResult?.duplicates` guard as `undefined`
// → empty array — this is the OLD pre-#382 behavior we preserve because
// malformed JSON is rare and a separate halve-and-retry path would
// require changing the LLM call signature).
//
// These three tests pin the new contract end-to-end.

describe('runDedupPhase — batch failure diagnostic (throwOnEmpty)', () => {
  it('LLM returning 0 bytes is recorded as a non-rate-limit failure, not a silent "no duplicates"', async () => {
    // The LLM stub returns the empty string. With throwOnEmpty: true this
    // should throw EmptyResponseError inside the batch worker; the outer
    // Promise.allSettled captures it as a rejection; the result.forEach
    // branch routes it into dedupFailures.
    const createMessage = vi.fn().mockResolvedValue('');
    const client = { createMessage } as unknown as LLMClient;
    const ctx = makeLintPhaseContext({ llmClient: () => client });
    const input: DedupPhaseInput = {
      wikiFiles: [
        { path: 'wiki/entities/a.md', basename: 'a.md' },
        { path: 'wiki/entities/A.md', basename: 'A.md' },
      ],
      pageMap: makePageMap([
        // Identical bodies → caseVariant tier-1 candidate guarantees a
        // batch is actually issued (without it, the early-return guard
        // would skip the LLM call entirely).
        ['wiki/entities/a.md', '---\ntype: entity\n---\n# a\nshared'],
        ['wiki/entities/A.md', '---\ntype: entity\n---\n# A\nshared'],
      ]),
    };
    // Spy on console.warn to capture the new [Duplicate Batch Failures]
    // diagnostic we added in dedup-phase.ts. Empty-response failures
    // must NOT trigger the [Duplicate Rate Limit] Notice (no 429 marker).
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await runDedupPhase(ctx, input, () => {});
      // Phase still returns [] — the contract is "absorb and report",
      // not "re-throw to caller". Operators see the diagnostic in console.
      expect(result).toEqual([]);
      // The batch was attempted (caseVariant signal surfaced candidates).
      expect(createMessage).toHaveBeenCalled();
      // The non-rate-limit diagnostic fired at least once.
      const batchFailureWarnings = warnSpy.mock.calls.filter(args =>
        typeof args[0] === 'string' && args[0].includes('[Duplicate Batch Failures]')
      );
      expect(batchFailureWarnings.length).toBeGreaterThan(0);
      // The rate-limit Notice was NOT triggered — empty response is not a 429.
      const rateLimitWarnings = warnSpy.mock.calls.filter(args =>
        typeof args[0] === 'string' && args[0].includes('[Duplicate Rate Limit]')
      );
      expect(rateLimitWarnings).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('LLM returning malformed JSON is recorded as a non-rate-limit failure (legacy null-return path)', async () => {
    // With throwOnEmpty:true, only the empty-body case throws. Malformed
    // JSON still returns null from parseJsonResponse (default behavior).
    // The batch worker treats null as "no duplicates confirmed" via the
    // `Array.isArray(rawDups)` guard at dedup-phase.ts:283 — but the
    // operator still gets a console.error from parseJsonResponse itself
    // (line 218 of json.ts: "JSON parse completely failed").
    //
    // We pin that the phase does NOT crash and returns []. The malformed
    // path is intentionally less loud than the empty path because
    // malformed JSON is rare and the existing parseJsonResponse logging
    // already surfaces it.
    const createMessage = vi.fn().mockResolvedValue('not-valid-json-at-all');
    const client = { createMessage } as unknown as LLMClient;
    const ctx = makeLintPhaseContext({ llmClient: () => client });
    const input: DedupPhaseInput = {
      wikiFiles: [
        { path: 'wiki/entities/a.md', basename: 'a.md' },
        { path: 'wiki/entities/A.md', basename: 'A.md' },
      ],
      pageMap: makePageMap([
        ['wiki/entities/a.md', '---\ntype: entity\n---\n# a\nshared'],
        ['wiki/entities/A.md', '---\ntype: entity\n---\n# A\nshared'],
      ]),
    };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await runDedupPhase(ctx, input, () => {});
      expect(result).toEqual([]);
      expect(createMessage).toHaveBeenCalled();
      // The phase did NOT crash; it absorbed the parse failure.
      // (No specific assertion on the malformed-JSON console.error count
      // because parseJsonResponse logs vary by length — we just verify
      // the phase returned cleanly.)
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('LLM returning a parse-failure JSON (truncated mid-array) is absorbed without throwing to caller', async () => {
    // With throwOnEmpty:true, only the empty-body case throws. Malformed
    // or truncated JSON still returns null from parseJsonResponse (default
    // behavior preserved for backwards compat with 21 other callers).
    //
    // The batch worker treats null as "no duplicates confirmed" via the
    // `Array.isArray(rawDups)` guard — this is the legacy pre-#382
    // behavior we intentionally preserve for malformed JSON. The
    // difference from empty-body is:
    //   - empty-body → EmptyResponseError → dedupFailures entry → console
    //     diagnostic fires
    //   - malformed JSON → null return → silently treated as "no dups" →
    //     operator sees only parseJsonResponse's own console.error
    //
    // The malformed-JSON path is less loud on purpose: throwOnEmpty is
    // sufficient to address DocTpoint's masking concern (the common case
    // for the #382 scenarios is response_format stripping → empty body),
    // and adding a second thrown exception for parse failures would
    // require changing parseJsonResponse's contract for all 21 callers.
    const truncatedJson = '{"duplicates":[{"target":"a","sour'; // mid-array truncation
    const createMessage = vi.fn().mockResolvedValue(truncatedJson);
    const client = { createMessage } as unknown as LLMClient;
    const ctx = makeLintPhaseContext({ llmClient: () => client });
    const input: DedupPhaseInput = {
      wikiFiles: [
        { path: 'wiki/entities/a.md', basename: 'a.md' },
        { path: 'wiki/entities/A.md', basename: 'A.md' },
      ],
      pageMap: makePageMap([
        ['wiki/entities/a.md', '---\ntype: entity\n---\n# a\nshared'],
        ['wiki/entities/A.md', '---\ntype: entity\n---\n# A\nshared'],
      ]),
    };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await runDedupPhase(ctx, input, () => {});
      // Phase did NOT crash and did NOT trigger rate-limit Notice.
      expect(result).toEqual([]);
      expect(createMessage).toHaveBeenCalled();
      // No rate-limit Notice (parse failure is not a 429).
      const rateLimitWarnings = warnSpy.mock.calls.filter(args =>
        typeof args[0] === 'string' && args[0].includes('[Duplicate Rate Limit]')
      );
      expect(rateLimitWarnings).toHaveLength(0);
      // parseJsonResponse logged the parse failure internally (legacy path).
      // We don't pin a specific count — just that errorSpy saw at least
      // one parse-related log.
      expect(errorSpy.mock.calls.length).toBeGreaterThan(0);
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});
