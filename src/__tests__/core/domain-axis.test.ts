// domain axis stage 3 (#568): the model chooses the subset, the code
// decides what counts — only values the note itself carries are written.

import { describe, it, expect } from 'vitest';
import { buildDomainContext, selectDomains, DOMAINS_FIELD, COVERAGE_VALUES } from '../../core/domain-axis';

const NOTE_TAGS = ['Sorte/Protein', 'Fach/Hämatologie', 'Thema/Diagnostik'];

describe('domain-axis — selectDomains', () => {
  it('keeps only values the note carries, in the note\'s spelling and the model\'s order', () => {
    const r = selectDomains(['thema/diagnostik', 'Sorte/Protein', 'Thema/Erfunden'], NOTE_TAGS);
    expect(r.kept).toEqual(['Thema/Diagnostik', 'Sorte/Protein']);
    expect(r.rejected).toEqual(['Thema/Erfunden']);
  });

  it('is NFC-insensitive and deduplicates', () => {
    const decomposed = 'Fach/Hämatologie'; // ä as a + combining diaeresis
    const r = selectDomains([decomposed, 'Fach/Hämatologie', ' Sorte/Protein '], NOTE_TAGS);
    expect(r.kept).toEqual(['Fach/Hämatologie', 'Sorte/Protein']);
    expect(r.rejected).toEqual([]);
  });

  it('treats anything that is not a string array as no choice', () => {
    expect(selectDomains(undefined, NOTE_TAGS)).toEqual({ kept: [], rejected: [] });
    expect(selectDomains('Sorte/Protein', NOTE_TAGS)).toEqual({ kept: [], rejected: [] });
    expect(selectDomains([42, '', '  ', null], NOTE_TAGS)).toEqual({ kept: [], rejected: [] });
  });

  it('rejects everything when the note has no tags — the empty list is the allowed list', () => {
    const r = selectDomains(['Sorte/Protein'], []);
    expect(r.kept).toEqual([]);
    expect(r.rejected).toEqual(['Sorte/Protein']);
  });
});

describe('domain-axis — buildDomainContext', () => {
  it('is the empty string for a note without tags, so the prompt is unchanged', () => {
    expect(buildDomainContext([])).toBe('');
    expect(buildDomainContext(['', '  '])).toBe('');
  });

  it('names the tags as the allowed list and forbids additions', () => {
    const block = buildDomainContext(NOTE_TAGS);
    expect(block).toContain('**Domain tags of this source:** [Sorte/Protein, Fach/Hämatologie, Thema/Diagnostik]');
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
