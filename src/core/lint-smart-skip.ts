// v1.25.10 PATCH Issue #367 P1-2 — smart-skip controller.
//
// Decide, for each LLM-driven lint phase, whether it is worth running
// the LLM at all. Two signals matter:
//   1. Programmatic findings (cheap local scan): if dead-link /
//      orphan / empty-page / alias-deficient / duplicate-candidate
//      counts are all zero across the input, the LLM phase cannot
//      improve anything — skip.
//   2. Cache verdict: when a previous run on the same content
//      produced an identical-programmatic verdict AND the LLM verdict
//      was "skip", we can short-circuit without recomputing.
//
// Scope-locked. The LLM runner still owns the call to this helper;
// this module is the pure decision surface only, so unit tests can pin
// every transition.

import type { LintAnalysisEntry } from './lint-analysis-cache';

export interface ProgrammaticCounts {
  deadLinks: number;
  orphanPages: number;
  emptyPages: number;
  aliasDeficient: number;
  duplicateCandidates: number;
  tagViolations: number;
}

/** Sum of every programmatic count — zero means the LLM phase can be skipped. */
export function totalProgrammaticFindings(c: ProgrammaticCounts): number {
  return (
    c.deadLinks +
    c.orphanPages +
    c.emptyPages +
    c.aliasDeficient +
    c.duplicateCandidates +
    c.tagViolations
  );
}

/** True when nothing in the programmatic pass needs LLM input. */
export function isProgrammaticClean(c: ProgrammaticCounts): boolean {
  return totalProgrammaticFindings(c) === 0;
}

export type LlmPhaseVerdict = 'skip' | 'run';

/** Verdict for the LLM alias-completion phase. */
export function aliasPhaseVerdict(
  counts: ProgrammaticCounts,
  cached?: LintAnalysisEntry | null,
): LlmPhaseVerdict {
  if (counts.aliasDeficient > 0) return 'run';
  if (cached && cached.programmaticCounts.aliasDeficient === counts.aliasDeficient) {
    return cached.llmVerdict.aliasNeeded;
  }
  return 'skip';
}

/** Verdict for the LLM duplicate-dedup phase. */
export function dedupPhaseVerdict(
  counts: ProgrammaticCounts,
  cached?: LintAnalysisEntry | null,
): LlmPhaseVerdict {
  if (counts.duplicateCandidates > 0) return 'run';
  if (cached && cached.programmaticCounts.duplicateCandidates === counts.duplicateCandidates) {
    return cached.llmVerdict.duplicateWorthInvestigating;
  }
  return 'skip';
}

/**
 * Combined verdict: if either phase is worth running, return 'run'.
 * Otherwise the LLM is not needed for this page on this run.
 */
export function llmVerdict(
  counts: ProgrammaticCounts,
  cached?: LintAnalysisEntry | null,
): LlmPhaseVerdict {
  const a = aliasPhaseVerdict(counts, cached);
  const d = dedupPhaseVerdict(counts, cached);
  return a === 'run' || d === 'run' ? 'run' : 'skip';
}
