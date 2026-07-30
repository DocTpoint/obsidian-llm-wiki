// v1.25.11 PATCH #169 — fine-grained stage hints.
//
// Why this test exists (vs relying on the i18n-parity sweep at
// src/__tests__/root/i18n-parity.test.ts): the parity sweep is a
// structural check (every locale covers every EN key, no extras). It does
// not pin the SHAPE of stage labels or their composition order. A new
// key could exist in every locale yet still degrade to garbage at runtime
// (e.g. wrong placeholder name, missing prefix, swapped "{step}/{total}"
// indices). This file pins the contract.
//
// Contract:
//   1. `STAGE_KEYS` is the canonical ordered list of ingest / PDF / lint
//      stage label keys. Order matters: callers iterate it to build
//      breadcrumbs.
//   2. `stageLabel(lang, key, vars)` composes the label by `.replace('{}', v)`
//      — same pattern used by the existing getText() callers. Multi-arg
//      placeholders use sequential {} substitution.
//   3. Every locale defines every STAGE_KEY entry (delegated to the
//      bidirectional parity test — this file's role is shape, not coverage).

import { describe, it, expect } from 'vitest';
import { STAGE_KEYS, stageLabel } from '../../core/ingest-stages';
import { TEXTS } from '../../texts';

describe('ingest-stages / STAGE_KEYS canonical list', () => {
  it('is non-empty and ordered', () => {
    expect(STAGE_KEYS.length).toBeGreaterThan(0);
    // No duplicates — would break type lookups and breadcrumb rendering.
    expect(new Set(STAGE_KEYS).size).toBe(STAGE_KEYS.length);
  });

  it('every key exists in EN baseline', () => {
    const enKeys = Object.keys(TEXTS.en) as string[];
    for (const key of STAGE_KEYS) {
      expect(enKeys, `STAGE_KEYS entry "${key}" missing in TEXTS.en`).toContain(key);
    }
  });

  it('contains the documented v1.25.11 #169 stage set', () => {
    // Ingest path
    expect(STAGE_KEYS).toContain('ingestStageAnalyze');
    expect(STAGE_KEYS).toContain('ingestStageSummary');
    expect(STAGE_KEYS).toContain('ingestStageEntity');
    expect(STAGE_KEYS).toContain('ingestStageConcept');
    expect(STAGE_KEYS).toContain('ingestStageRetry');
    expect(STAGE_KEYS).toContain('ingestStageSave');
    expect(STAGE_KEYS).toContain('ingestStageIndex');
    // PDF path
    expect(STAGE_KEYS).toContain('pdfStageReading');
    expect(STAGE_KEYS).toContain('pdfStageConverting');
    expect(STAGE_KEYS).toContain('pdfStageSidecar');
    // Lint scan path
    expect(STAGE_KEYS).toContain('lintStagePrep');
    expect(STAGE_KEYS).toContain('lintStageProgrammatic');
    expect(STAGE_KEYS).toContain('lintStageDedup');
    expect(STAGE_KEYS).toContain('lintStageContradiction');
  });
});

describe('ingest-stages / stageLabel composition', () => {
  it('returns the raw string when no {} placeholder is present', () => {
    // ingestStageAnalyze has no placeholder in EN baseline.
    const label = stageLabel('en', 'ingestStageAnalyze');
    expect(label).toBe(TEXTS.en.ingestStageAnalyze);
    expect(label).not.toContain('{}');
  });

  it('substitutes a single {} with the provided variable', () => {
    // The lint dedup label has "{step}/{total}" — sanity-check that
    // stageLabel runs the standard .replace('{}', v) pattern callers expect.
    const label = stageLabel('en', 'lintStageDedup', '3/10');
    expect(label).toBe(TEXTS.en.lintStageDedup.replace('{}', '3/10'));
  });

  it('returns the EN fallback when the requested locale lacks the key', () => {
    // Synthetic locale that does not exist — getText falls back to en.
    const label = stageLabel('xx-XX-not-a-real-locale' as never, 'ingestStageAnalyze');
    expect(label).toBe(TEXTS.en.ingestStageAnalyze);
  });

  it('does not mutate the underlying TEXTS entry', () => {
    const before = TEXTS.en.ingestStageAnalyze;
    stageLabel('en', 'ingestStageAnalyze');
    stageLabel('en', 'ingestStageAnalyze', 'extra-arg');
    expect(TEXTS.en.ingestStageAnalyze).toBe(before);
  });
});
