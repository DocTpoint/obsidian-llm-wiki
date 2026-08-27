// domain axis stage 3 (#568): the model chooses the subset, the code
// decides what counts — validated against the vault's tag vocabulary, with a
// deterministic fold for the measured failure mode (bare value spelling).

import { describe, it, expect } from 'vitest';
import { buildDomainContext, collectDomainVocabulary, selectDomains, DOMAINS_FIELD, COVERAGE_VALUES } from '../../core/domain-axis';
import type { App } from 'obsidian';

const VOCAB = ['Fach/Hämatologie', 'Sorte/Protein', 'Thema/Diagnostik', 'Thema/Mikrobiom'];

describe('domain-axis — selectDomains', () => {
  it('keeps only vocabulary values, in the vocabulary\'s spelling and the model\'s order', () => {
    const r = selectDomains(['thema/diagnostik', 'Sorte/Protein', 'Thema/Erfunden'], VOCAB);
    expect(r.kept).toEqual(['Thema/Diagnostik', 'Sorte/Protein']);
    expect(r.rejected).toEqual(['Thema/Erfunden']);
  });

  it('is NFC-insensitive and deduplicates', () => {
    const decomposed = 'Fach/Hämatologie'; // ä as a + combining diaeresis
    const r = selectDomains([decomposed, 'Fach/Hämatologie', ' Sorte/Protein '], VOCAB);
    expect(r.kept).toEqual(['Fach/Hämatologie', 'Sorte/Protein']);
    expect(r.rejected).toEqual([]);
  });

  it('accepts a bare value without the group prefix when it is unique — the measured failure mode', () => {
    const r = selectDomains(['Mikrobiom', 'diagnostik'], VOCAB);
    expect(r.kept).toEqual(['Thema/Mikrobiom', 'Thema/Diagnostik']);
    expect(r.rejected).toEqual([]);
  });

  it('rejects a bare value that two vocabulary entries share — no guessing', () => {
    const vocab = ['Sorte/Erkrankung', 'Thema/Erkrankung'];
    const r = selectDomains(['Erkrankung'], vocab);
    expect(r.kept).toEqual([]);
    expect(r.rejected).toEqual(['Erkrankung']);
  });

  it('deduplicates a bare and a full spelling of the same tag', () => {
    const r = selectDomains(['Mikrobiom', 'Thema/Mikrobiom'], VOCAB);
    expect(r.kept).toEqual(['Thema/Mikrobiom']);
    expect(r.rejected).toEqual([]);
  });

  it('treats anything that is not a string array as no choice', () => {
    expect(selectDomains(undefined, VOCAB)).toEqual({ kept: [], rejected: [] });
    expect(selectDomains('Sorte/Protein', VOCAB)).toEqual({ kept: [], rejected: [] });
    expect(selectDomains([42, '', '  ', null], VOCAB)).toEqual({ kept: [], rejected: [] });
  });

  it('rejects everything when the vocabulary is empty — the empty list is the allowed list', () => {
    const r = selectDomains(['Sorte/Protein'], []);
    expect(r.kept).toEqual([]);
    expect(r.rejected).toEqual(['Sorte/Protein']);
  });
});

describe('domain-axis — collectDomainVocabulary', () => {
  function fakeApp(files: Record<string, string[] | undefined>): App {
    return {
      vault: { getMarkdownFiles: () => Object.keys(files).map(path => ({ path })) },
      metadataCache: {
        getFileCache: (f: { path: string }) => {
          const tags = files[f.path];
          return tags === undefined ? null : { frontmatter: { tags } };
        },
      },
    } as unknown as App;
  }

  it('collects distinct note tags, excludes the wiki folder, sorted, first spelling wins', () => {
    const app = fakeApp({
      'Notizen/A.md': ['Thema/Mikrobiom', 'Sorte/Erkrankung'],
      'Notizen/B.md': ['thema/mikrobiom', 'Fach/Kardiologie'],
      'wiki/entities/X.md': ['other'],
      'Notizen/leer.md': undefined,
    });
    expect(collectDomainVocabulary(app, 'wiki')).toEqual(['Fach/Kardiologie', 'Sorte/Erkrankung', 'Thema/Mikrobiom']);
  });

  it('ignores non-string and empty tag entries', () => {
    const app = fakeApp({ 'Notizen/A.md': ['', '  ', 'Thema/Schlaf'] });
    expect(collectDomainVocabulary(app, 'wiki')).toEqual(['Thema/Schlaf']);
  });
});

describe('domain-axis — buildDomainContext', () => {
  it('is the empty string for a vault without note tags, so the prompt is unchanged', () => {
    expect(buildDomainContext([])).toBe('');
    expect(buildDomainContext(['', '  '])).toBe('');
  });

  it('names the vocabulary as the allowed list, demands the exact spelling, forbids additions', () => {
    const block = buildDomainContext(VOCAB);
    expect(block).toContain('**Domain tag vocabulary of this vault:** [Fach/Hämatologie, Sorte/Protein, Thema/Diagnostik, Thema/Mikrobiom]');
    expect(block).toContain('Copy the exact spelling');
    expect(block).toContain('Never add a tag that is not in this list');
    expect(block).toContain('Use [] when none applies');
  });
});

describe('domain-axis — constants', () => {
  it('names the frontmatter key once and the three coverage values', () => {
    expect(DOMAINS_FIELD).toBe('domains');
    expect([...COVERAGE_VALUES].sort()).toEqual(['defined', 'discussed', 'named']);
  });
});
