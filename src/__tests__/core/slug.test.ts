import { describe, it, expect } from 'vitest';
import { computeSlug, filterRedundantAliases, slugify } from '../../core/slug';
describe('slugify', () => {
  it('returns "untitled" for empty input', () => {
    expect(slugify('')).toBe('untitled');
    expect(slugify('   ')).toBe('untitled');
  });

  it('removes filesystem-unsafe characters', () => {
    // Slash, colon, pipe, asterisk are removed by the regex
    expect(slugify('hello/world')).toBe('helloworld');
    expect(slugify('test:file')).toBe('testfile');
    expect(slugify('a|b')).toBe('ab');
  });

  it('converts spaces and dots to dashes', () => {
    expect(slugify('hello world')).toBe('hello-world');
    expect(slugify('hello.world')).toBe('hello-world');
  });

  it('merges consecutive dashes', () => {
    expect(slugify('hello  ---  world')).toBe('hello-world');
    expect(slugify('a...b')).toBe('a-b');
  });

  it('strips leading and trailing dashes', () => {
    expect(slugify('-hello-')).toBe('hello');
  });

  it('preserves Chinese characters', () => {
    expect(slugify('思维链')).toBe('思维链');
  });

  it('preserves Korean characters', () => {
    expect(slugify('지식베이스')).toBe('지식베이스');
  });

  it('preserves Japanese characters', () => {
    expect(slugify('ノート一覧')).toBe('ノート一覧');
  });

  it('handles mixed CJK and ASCII', () => {
    expect(slugify('机器学习 Supervised Learning')).toBe('机器学习-supervised-learning');
  });

  it('removes angle brackets and quotes', () => {
    expect(slugify('"hello" <world>')).toBe('hello-world');
  });

  it('handles falsy values', () => {
    expect(slugify(null as unknown as string)).toBe('untitled');
    expect(slugify(undefined as unknown as string)).toBe('untitled');
  });

  it('returns fallback slug when input becomes empty after filtering', () => {
    const result = slugify('<>/\\:*?"|');
    expect(result).toMatch(/^untitled-\d+$/);
  });

  it('removes commas', () => {
    expect(slugify('Karpathy, Andrej')).toBe('karpathy-andrej');
  });

  it('normalizes spaces to hyphens for slug-match comparison (Issue #32)', () => {
    // resolvePagePath Fast path 2: slugify(p.title) === slug
    // catches files whose stored name uses spaces instead of hyphens
    expect(slugify('Metabolisches Syndrom')).toBe('metabolisches-syndrom');
    expect(slugify('Machine Learning Basics')).toBe('machine-learning-basics');
    expect(slugify('hello world') === slugify('hello-world')).toBe(true);
    expect(slugify('Test Page Name') === slugify('Test-Page-Name')).toBe(true);
  });

  it('slug-match handles edge cases with dots and spaces combined', () => {
    expect(slugify('Dr. Smith Report')).toBe('dr-smith-report');
    expect(slugify('v1.0 Release Notes')).toBe('v1-0-release-notes');
    // Mixed separators normalize to same slug
    expect(slugify('hello.world test') === slugify('hello-world-test')).toBe(true);
  });

  it('slug-match is case-insensitive for title comparison', () => {
    // resolvePagePath Fast path 2: slugify(p.title).toLowerCase() === targetSlug
    const targetSlug = slugify('deep learning').toLowerCase(); // "deep-learning"
    expect(slugify('Deep Learning').toLowerCase() === targetSlug).toBe(true);
    expect(slugify('DEEP LEARNING').toLowerCase() === targetSlug).toBe(true);
    expect(slugify('Deep-Learning').toLowerCase() === targetSlug).toBe(true);
    // Different casing in alias
    expect(slugify('Chain of Thought').toLowerCase() === 'chain-of-thought').toBe(true);
  });

  it('slug-match covers aliases with space/case variants', () => {
    // Fast path 2 also checks: aliases.some(a => slugify(a).toLowerCase() === targetSlug)
    const targetSlug = slugify('Chain of Thought').toLowerCase(); // "chain-of-thought"
    const aliases = ['Chain of Thought', '思维链', 'CoT Reasoning'];
    const aliasMatch = aliases.some(a => slugify(a).toLowerCase() === targetSlug);
    expect(aliasMatch).toBe(true);
    // Alias with different casing
    const targetSlug2 = slugify('cot reasoning').toLowerCase();
    const aliasMatch2 = aliases.some(a => slugify(a).toLowerCase() === targetSlug2);
    expect(aliasMatch2).toBe(true);
    // No match
    const targetSlug3 = slugify('unrelated term').toLowerCase();
    const aliasMatch3 = aliases.some(a => slugify(a).toLowerCase() === targetSlug3);
    expect(aliasMatch3).toBe(false);
  });
});

describe('computeSlug', () => {
  it('produces same result as slugify', () => {
    const inputs = ['Hello World', 'Machine-Learning', 'Test/Path'];
    for (const input of inputs) {
      expect(computeSlug(input)).toBe(slugify(input));
    }
  });

  it('returns untitled for empty input', () => {
    expect(computeSlug('')).toBe('untitled');
  });

  it('removes special characters and normalizes spaces', () => {
    expect(computeSlug('hello?world!')).toBe('helloworld');
  });

  it('lowercases single-word uppercase input', () => {
    expect(computeSlug('Unix')).toBe('unix');
  });

  it('lowercases mixed-case input', () => {
    expect(computeSlug('iPhone')).toBe('iphone');
  });

  it('lowercases multi-word uppercase input with spaces', () => {
    expect(computeSlug('Claude Code')).toBe('claude-code');
  });

  it('lowercases input with special characters preserved', () => {
    // & is not in the invalid-char regex, so it survives; the T→t step lowercases
    expect(computeSlug('AT&T')).toBe('at&t');
  });

  it('leaves already-lowercase input unchanged', () => {
    expect(computeSlug('hello')).toBe('hello');
  });

  it('lowercases ASCII portion while preserving CJK characters', () => {
    // CJK has no upper/lower case; only the ASCII "Supervised Learning" is lowercased
    expect(computeSlug('机器学习 Supervised Learning')).toBe('机器学习-supervised-learning');
  });
});

describe('filterRedundantAliases', () => {
  it('drops an alias identical to the page filename (case-insensitive)', () => {
    const result = filterRedundantAliases('wiki/entities/vigilanz.md', ['Vigilanz']);
    expect(result).toEqual([]);
  });

  it('keeps a genuine alias that differs from the filename', () => {
    // 3-character floor (v1.25.10 PATCH): use a multi-char CJK alias so it
    // clears the floor; the previous single-codepoint CJK alias "监测"
    // is now correctly rejected by MIN_ALIAS_LENGTH below.
    const result = filterRedundantAliases('wiki/entities/vigilanz.md', ['监测系统']);
    expect(result).toEqual(['监测系统']);
  });

  it('drops self-pointing alias but keeps distinct ones in the same batch', () => {
    const result = filterRedundantAliases('wiki/entities/openai.md', ['OpenAI', 'OAI']);
    expect(result).toEqual(['OAI']);
  });

  it('keeps a space-variant alias because Obsidian does not collapse spaces to dashes', () => {
    // File is deep-learning.md; [[Deep Learning]] would NOT auto-resolve to it,
    // so "Deep Learning" is a useful alias and must be kept.
    const result = filterRedundantAliases('wiki/concepts/deep-learning.md', ['Deep Learning']);
    expect(result).toEqual(['Deep Learning']);
  });

  it('removes duplicate aliases within the batch (case-insensitive)', () => {
    const result = filterRedundantAliases('wiki/entities/foo.md', ['GPT', 'gpt']);
    expect(result).toEqual(['GPT']);
  });

  it('skips empty or whitespace-only aliases', () => {
    const result = filterRedundantAliases('wiki/entities/openai.md', ['', '   ', 'OpenAI Inc']);
    expect(result).toEqual(['OpenAI Inc']);
  });

  it('handles paths without a folder prefix', () => {
    const result = filterRedundantAliases('vigilanz.md', ['Vigilanz', 'Surveillance']);
    expect(result).toEqual(['Surveillance']);
  });

  it('drops aliases shorter than the 3-character floor (v1.25.10 PATCH alias hardening)', () => {
    // "AI" and "ML" are too short to be useful aliases — they cannot
    // distinguish one entity from another in a wiki-link graph and provide
    // no dedup value over the page basename. "Überwachung" survives.
    const result = filterRedundantAliases('wiki/entities/vigilanz.md', ['AI', 'ML', 'Überwachung']);
    expect(result).toEqual(['Überwachung']);
  });

  it('accepts a 3-character boundary alias (>= 3 chars)', () => {
    // "LLM" is exactly 3 chars — at the floor. Must survive.
    const result = filterRedundantAliases('wiki/entities/openai.md', ['LLM']);
    expect(result).toEqual(['LLM']);
  });

  it('drops aliases that already exist on other pages (cross-page uniqueness)', () => {
    // "Vigilanz" is already an alias on another page — adding it to this
    // page would create a wikilink ambiguity. Pass them via the third arg.
    const result = filterRedundantAliases(
      'wiki/entities/new-page.md',
      ['Vigilanz', 'Surveillance'],
      ['Vigilanz'],
    );
    expect(result).toEqual(['Surveillance']);
  });

  it('cross-page uniqueness is case-insensitive (whitespace stripped)', () => {
    // Even with whitespace/case variations, the existing alias rejects the candidate.
    const result = filterRedundantAliases(
      'wiki/entities/new-page.md',
      ['VIGILANZ'],
      ['  vigilanz  '],
    );
    expect(result).toEqual([]);
  });

  it('omitting the cross-page argument preserves v1.25.9 behaviour (backward-compat)', () => {
    // No third argument — should not throw, must still apply filename + batch dedup.
    const result = filterRedundantAliases('wiki/entities/vigilanz.md', ['Vigilanz']);
    expect(result).toEqual([]);
  });
});
