// v1.25.10 PATCH Issue #367 P1-1 — LintAnalysisCache unit tests.
//
// The cache itself delegates to the pre-existing DiskCache<T> machinery
// (which already pins LRU-by-mtime + size caps + TTL). These tests pin
// the wrapper's contract: the key is hashBody(content), get/set round-trip
// preserves every field, and the LLM verdict surface is large enough for
// the smart-skip controller (PR E Step 3) to read.

import { describe, it, expect, vi } from 'vitest';
import { LintAnalysisCache, type LintAnalysisEntry } from '../../core/lint-analysis-cache';

interface FakeEntry {
  data: string;
  mtime: number;
}

function createFakeAdapter() {
  const files = new Map<string, FakeEntry>();
  return {
    files,
    adapter: {
      read: vi.fn(async (p: string) => {
        const f = files.get(p);
        if (!f) throw new Error('ENOENT');
        return f.data;
      }),
      write: vi.fn(async (p: string, d: string) => {
        files.set(p, { data: d, mtime: Date.now() });
      }),
      remove: vi.fn(async (p: string) => { files.delete(p); }),
      list: vi.fn(async (dir: string) => {
        const prefix = dir.endsWith('/') ? dir : `${dir}/`;
        const seen = new Set<string>();
        for (const k of files.keys()) {
          if (k.startsWith(prefix)) {
            const tail = k.substring(prefix.length).split('/')[0];
            if (tail) seen.add(tail);
          }
        }
        return Array.from(seen);
      }),
      stat: vi.fn(async (p: string) => {
        const f = files.get(p);
        if (!f) return null;
        return { size: new TextEncoder().encode(f.data).length, mtime: f.mtime };
      }),
      mkdir: vi.fn(async () => undefined),
    },
  };
}

function makeAppLike(adapter: ReturnType<typeof createFakeAdapter>['adapter']) {
  return { vault: { adapter } } as never;
}

const EMPTY_VERDICT: LintAnalysisEntry['llmVerdict'] = {
  aliasNeeded: 'skip',
  duplicateWorthInvestigating: 'skip',
};

const ZERO_COUNTS: LintAnalysisEntry['programmaticCounts'] = {
  deadLinks: 0,
  orphanPages: 0,
  emptyPages: 0,
  aliasDeficient: 0,
  duplicateCandidates: 0,
  tagViolations: 0,
};

describe('LintAnalysisCache — round-trip', () => {
  it('set then get returns the same entry for the same content', async () => {
    const { adapter } = createFakeAdapter();
    const cache = new LintAnalysisCache(makeAppLike(adapter));
    const content = '# Heading\n\nSome body text.';
    await cache.set(content, {
      programmaticCounts: { ...ZERO_COUNTS, deadLinks: 3 },
      llmVerdict: { aliasNeeded: 'run', duplicateWorthInvestigating: 'skip' },
    });
    const got = await cache.get(content);
    expect(got).not.toBeNull();
    expect(got!.programmaticCounts.deadLinks).toBe(3);
    expect(got!.llmVerdict.aliasNeeded).toBe('run');
    expect(got!.contentHash).toBe(LintAnalysisCache.contentKey(content));
  });

  it('different content produces different keys (no false cache hit)', async () => {
    const { adapter } = createFakeAdapter();
    const cache = new LintAnalysisCache(makeAppLike(adapter));
    await cache.set('body A', {
      programmaticCounts: ZERO_COUNTS,
      llmVerdict: EMPTY_VERDICT,
    });
    expect(await cache.get('body B')).toBeNull();
  });

  it('returns null on cache miss', async () => {
    const { adapter } = createFakeAdapter();
    const cache = new LintAnalysisCache(makeAppLike(adapter));
    expect(await cache.get('untouched content')).toBeNull();
  });
});

describe('LintAnalysisCache — content-key derivation', () => {
  it('contentKey is stable for the same content', () => {
    const a = LintAnalysisCache.contentKey('same body');
    const b = LintAnalysisCache.contentKey('same body');
    expect(a).toBe(b);
  });

  it('contentKey normalizes whitespace-equivalent content (formatter-stable)', () => {
    // hashBody upstream does `trim().replace(/\s+/g, ' ')`, so two
    // contents that differ only by whitespace converge to the same hash.
    // This is intentional: a minor formatter rewrite of the page (e.g.
    // a trailing newline) must NOT invalidate the cache entry — the
    // Lint findings are unchanged.
    expect(LintAnalysisCache.contentKey('a  b'))
      .toBe(LintAnalysisCache.contentKey('a b'));
  });

  it('contentKey encodes length prefix so collision requires equal length and hash', () => {
    // Two unrelated 4-byte strings can in theory share a 32-bit hash
    // but the length prefix makes that astronomically unlikely.
    const a = LintAnalysisCache.contentKey('abcd');
    const b = LintAnalysisCache.contentKey('xyz!');
    expect(a).not.toBe(b);
  });
});

describe('LintAnalysisCache — invalidation', () => {
  it('invalidate() removes the entry and a subsequent get returns null', async () => {
    const { adapter } = createFakeAdapter();
    const cache = new LintAnalysisCache(makeAppLike(adapter));
    const content = 'body';
    await cache.set(content, {
      programmaticCounts: ZERO_COUNTS,
      llmVerdict: EMPTY_VERDICT,
    });
    expect(await cache.get(content)).not.toBeNull();
    await cache.invalidate(content);
    expect(await cache.get(content)).toBeNull();
  });

  it('clear() removes every entry', async () => {
    const { adapter } = createFakeAdapter();
    const cache = new LintAnalysisCache(makeAppLike(adapter));
    await cache.set('a', { programmaticCounts: ZERO_COUNTS, llmVerdict: EMPTY_VERDICT });
    await cache.set('b', { programmaticCounts: ZERO_COUNTS, llmVerdict: EMPTY_VERDICT });
    await cache.clear();
    expect(await cache.get('a')).toBeNull();
    expect(await cache.get('b')).toBeNull();
  });
});

describe('LintAnalysisCache — entry payload invariants', () => {
  it('writtenAt is populated on set', async () => {
    const { adapter } = createFakeAdapter();
    const cache = new LintAnalysisCache(makeAppLike(adapter));
    const before = Date.now();
    await cache.set('x', { programmaticCounts: ZERO_COUNTS, llmVerdict: EMPTY_VERDICT });
    const after = Date.now();
    const got = await cache.get('x');
    expect(got).not.toBeNull();
    expect(got!.writtenAt).toBeGreaterThanOrEqual(before);
    expect(got!.writtenAt).toBeLessThanOrEqual(after);
  });

  it('contentLength equals the original content length', async () => {
    const { adapter } = createFakeAdapter();
    const cache = new LintAnalysisCache(makeAppLike(adapter));
    const content = '0123456789';
    await cache.set(content, { programmaticCounts: ZERO_COUNTS, llmVerdict: EMPTY_VERDICT });
    const got = await cache.get(content);
    expect(got!.contentLength).toBe(content.length);
  });
});
