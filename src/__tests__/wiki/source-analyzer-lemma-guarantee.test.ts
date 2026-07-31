// patch 16 wiring — the pure decision is covered in core/source-lemma.test.ts.
// What is covered here is that `analyzeSource` actually calls it and that the
// added candidate reaches the returned analysis.
//
// This exists because the field smoke test cannot show it: when the extraction
// happens to produce the lemma on its own, "skipped correctly" and "never
// called" leave an identical vault. The code path has to be read, not the diff.

import { describe, it, expect } from 'vitest';
import { createMockContext, createMockFile } from '../__support__/engine-context';
import { SourceAnalyzer } from '../../wiki/source-analyzer';
import { TFile } from 'obsidian';

const NOTE = 'sources/Klotho.md';
const BODY = `---
aliases:
  - alpha-Klotho-Protein
---
Klotho ist ein Transmembranprotein und Ko-Rezeptor für FGF23. Ein Verlust
führt zu vorzeitigem Altern, gestörtem Phosphathaushalt und Gefäßverkalkung.
`;

/** Extraction that misses the note's own lemma — the observed b1 case. */
const EXTRACTION_WITHOUT_LEMMA = JSON.stringify({
  source_title: 'Klotho',
  summary: 'Die Notiz beschreibt Klotho als Regulator des Alterungsprozesses.',
  entities: [
    { name: 'alpha-Klotho', type: 'other', summary: 'Isoform.', mentions_in_source: ['a'] },
    { name: 'FGF23', type: 'other', summary: 'Hormon.', mentions_in_source: ['b'] },
  ],
  concepts: [],
});

/** Same, but the lemma is extracted on its own — the S45 Papain case. */
const EXTRACTION_WITH_LEMMA = JSON.stringify({
  source_title: 'Klotho',
  summary: 'Die Notiz beschreibt Klotho als Regulator des Alterungsprozesses.',
  entities: [
    { name: 'Klotho', type: 'other', summary: 'Protein.', mentions_in_source: ['a'] },
  ],
  concepts: [],
});

const EMPTY_BATCH = JSON.stringify({ entities: [], concepts: [] });
const TYPE_ENTITY = JSON.stringify({ kind: 'entity' });

function analyzerWith(responses: string[], settings?: Partial<Record<string, unknown>>) {
  const { ctx } = createMockContext({
    vaultFiles: { [NOTE]: BODY },
    llmResponses: responses,
    ...(settings ? { settings } : {}),
  } as Parameters<typeof createMockContext>[0]);
  return new SourceAnalyzer(ctx);
}

async function run(analyzer: SourceAnalyzer) {
  // eslint-disable-next-line obsidianmd/no-tfile-tfolder-cast
  return analyzer.analyzeSource(createMockFile(NOTE) as unknown as TFile);
}

describe('SourceAnalyzer — patch 16 lemma guarantee wiring', () => {
  it('adds the note\'s own lemma when the extraction missed it', async () => {
    const result = await run(analyzerWith([
      EXTRACTION_WITHOUT_LEMMA, EMPTY_BATCH, TYPE_ENTITY,
    ]));
    const names = (result?.entities ?? []).map(e => e.name);
    expect(names).toContain('Klotho');
  });

  it('names the added lemma after the file, and gives it the source summary', async () => {
    const result = await run(analyzerWith([
      EXTRACTION_WITHOUT_LEMMA, EMPTY_BATCH, TYPE_ENTITY,
    ]));
    const added = (result?.entities ?? []).find(e => e.name === 'Klotho');
    expect(added?.summary).toBe(result?.summary);
    // No mentions are invented for a candidate the extraction never saw.
    expect(added?.mentions_in_source).toEqual([]);
  });

  it('adds nothing when the extraction already produced the lemma', async () => {
    const result = await run(analyzerWith([EXTRACTION_WITH_LEMMA, EMPTY_BATCH]));
    const klotho = (result?.entities ?? []).filter(e => e.name === 'Klotho');
    expect(klotho).toHaveLength(1);
  });

  it('adds nothing when the type classification is unusable', async () => {
    const result = await run(analyzerWith([
      EXTRACTION_WITHOUT_LEMMA, EMPTY_BATCH, JSON.stringify({ kind: 'werkzeug' }),
    ]));
    const names = (result?.entities ?? []).map(e => e.name);
    expect(names).not.toContain('Klotho');
    expect(result?.concepts.map(c => c.name)).not.toContain('Klotho');
  });

  it('routes a concept answer into the concepts list', async () => {
    const result = await run(analyzerWith([
      EXTRACTION_WITHOUT_LEMMA, EMPTY_BATCH, JSON.stringify({ kind: 'concept' }),
    ]));
    expect((result?.concepts ?? []).map(c => c.name)).toContain('Klotho');
    expect((result?.entities ?? []).map(e => e.name)).not.toContain('Klotho');
  });

  it('respects the custom granularity cap so the added lemma does not exceed it', async () => {
    // P0 #3 regression: extraction-phase cap slice at :602-607 only trims
    // the LLM-extracted lists. The push in ensureSourceLemma used to bypass
    // it, so a user who set customEntityLimit: 1 (with extractionGranularity
    // 'custom') would get 2 entities. This test pins the post-fix behaviour:
    // when the entities list is already at the cap, the lemma push is skipped.
    const result = await run(analyzerWith(
      [EXTRACTION_WITHOUT_LEMMA, EMPTY_BATCH, TYPE_ENTITY],
      { extractionGranularity: 'custom', customEntityLimit: 2 },
    ));
    // EXTRACTION_WITHOUT_LEMMA already produces 2 entities (alpha-Klotho,
    // FGF23); the cap of 2 is hit, so the pushed Klotho is skipped.
    expect((result?.entities ?? []).map(e => e.name)).not.toContain('Klotho');
    expect((result?.entities ?? []).length).toBe(2);
  });
});
