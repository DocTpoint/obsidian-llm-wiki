// v1.25.10 PATCH Issue #367 P1-2 — smart-skip controller unit tests.

import { describe, it, expect } from 'vitest';
import {
  aliasPhaseVerdict,
  dedupPhaseVerdict,
  isProgrammaticClean,
  llmVerdict,
  totalProgrammaticFindings,
  type ProgrammaticCounts,
} from '../../core/lint-smart-skip';

const ZERO: ProgrammaticCounts = {
  deadLinks: 0,
  orphanPages: 0,
  emptyPages: 0,
  aliasDeficient: 0,
  duplicateCandidates: 0,
  tagViolations: 0,
};

describe('totalProgrammaticFindings', () => {
  it('returns 0 for an all-zero counts object', () => {
    expect(totalProgrammaticFindings(ZERO)).toBe(0);
  });

  it('sums every field', () => {
    expect(totalProgrammaticFindings({
      deadLinks: 2, orphanPages: 3, emptyPages: 1,
      aliasDeficient: 4, duplicateCandidates: 5, tagViolations: 6,
    })).toBe(21);
  });
});

describe('isProgrammaticClean', () => {
  it('is true on every zero', () => {
    expect(isProgrammaticClean(ZERO)).toBe(true);
  });

  it('is false if any field is non-zero', () => {
    expect(isProgrammaticClean({ ...ZERO, tagViolations: 1 })).toBe(false);
    expect(isProgrammaticClean({ ...ZERO, deadLinks: 100 })).toBe(false);
  });
});

describe('aliasPhaseVerdict', () => {
  it('runs when aliasDeficient is positive', () => {
    expect(aliasPhaseVerdict({ ...ZERO, aliasDeficient: 1 })).toBe('run');
    expect(aliasPhaseVerdict({ ...ZERO, aliasDeficient: 50 })).toBe('run');
  });

  it('skips when aliasDeficient is zero and there is no cache', () => {
    expect(aliasPhaseVerdict(ZERO)).toBe('skip');
  });

  it('honours the cached verdict when programmatic counts are unchanged', () => {
    const cached = {
      contentHash: 'x', contentLength: 1, writtenAt: 0,
      programmaticCounts: { ...ZERO, aliasDeficient: 0 },
      llmVerdict: { aliasNeeded: 'run' as const, duplicateWorthInvestigating: 'skip' as const },
    };
    expect(aliasPhaseVerdict(ZERO, cached)).toBe('run');
  });

  it('falls back to skip when the cache verdict is stale relative to counts', () => {
    // Counts disagree — do NOT trust the cache.
    const stale = {
      contentHash: 'x', contentLength: 1, writtenAt: 0,
      programmaticCounts: { ...ZERO, aliasDeficient: 5 },
      llmVerdict: { aliasNeeded: 'run' as const, duplicateWorthInvestigating: 'skip' as const },
    };
    expect(aliasPhaseVerdict(ZERO, stale)).toBe('skip');
  });
});

describe('dedupPhaseVerdict', () => {
  it('runs when duplicateCandidates is positive', () => {
    expect(dedupPhaseVerdict({ ...ZERO, duplicateCandidates: 2 })).toBe('run');
  });

  it('skips otherwise; honours cache when counts match', () => {
    expect(dedupPhaseVerdict(ZERO)).toBe('skip');
    const cached = {
      contentHash: 'x', contentLength: 1, writtenAt: 0,
      programmaticCounts: { ...ZERO, duplicateCandidates: 0 },
      llmVerdict: { aliasNeeded: 'skip' as const, duplicateWorthInvestigating: 'run' as const },
    };
    expect(dedupPhaseVerdict(ZERO, cached)).toBe('run');
  });
});

describe('llmVerdict (combined)', () => {
  it('skips entirely when everything is clean', () => {
    expect(llmVerdict(ZERO)).toBe('skip');
  });

  it('runs if either phase needs it', () => {
    expect(llmVerdict({ ...ZERO, aliasDeficient: 1 })).toBe('run');
    expect(llmVerdict({ ...ZERO, duplicateCandidates: 1 })).toBe('run');
  });
});
