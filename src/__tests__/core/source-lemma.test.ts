// patch 16 — the source note's own lemma must get a node, but only when it is
// genuinely missing and genuinely wanted. Every case here is drawn from a real
// vault observation, noted next to the assertion.
import { describe, it, expect } from 'vitest';
import {
  slugKeys,
  isLemmaExtracted,
  isDomainContainer,
  parseTagList,
  decideSourceLemma,
} from '../../core/source-lemma';

describe('slugKeys', () => {
  it('collects title and aliases, case-insensitively comparable', () => {
    const keys = slugKeys('Silent Inflammation', ['Stille Entzündung']);
    expect(keys.has('silent-inflammation')).toBe(true);
    expect(keys.has('stille-entzündung')).toBe(true);
  });

  it('ignores empty and whitespace-only aliases', () => {
    expect(slugKeys('Klotho', ['', '   ']).size).toBe(1);
  });

  it('yields no keys for an empty name', () => {
    expect(slugKeys('', []).size).toBe(0);
  });
});

describe('isLemmaExtracted', () => {
  it('matches an extracted item by name across space/dash spelling', () => {
    // The vault writes `Silent-Inflammation`; the note is titled with a space.
    const keys = slugKeys('Silent Inflammation');
    expect(isLemmaExtracted(keys, [{ name: 'Silent-Inflammation' }])).toBe(true);
  });

  it('matches via an alias the extraction pre-generated', () => {
    const keys = slugKeys('CoQ10');
    expect(isLemmaExtracted(keys, [{ name: 'Coenzym Q10', aliases: ['CoQ10'] }])).toBe(true);
  });

  it('does not match a merely related item', () => {
    // Klotho vs alpha-Klotho: the b1 run produced the latter and not the former.
    const keys = slugKeys('Klotho');
    expect(isLemmaExtracted(keys, [
      { name: 'alpha-Klotho' },
      { name: 'beta-Klotho' },
    ])).toBe(false);
  });

  it('is false for an empty extraction list', () => {
    expect(isLemmaExtracted(slugKeys('Klotho'), [])).toBe(false);
  });
});

describe('isDomainContainer', () => {
  const tags = parseTagList('Erkrankung, Neurologie, Kardiologie, Immunologie, Biochemie');

  it('recognises a note named after a configured domain', () => {
    expect(isDomainContainer(slugKeys('Neurologie'), tags)).toBe(true);
  });

  it('recognises it through a curated alias', () => {
    // `Notizen/Biochemie-Signalwege.md` carries `Biochemie` as an alias.
    expect(isDomainContainer(slugKeys('Biochemie-Signalwege', ['Biochemie']), tags)).toBe(true);
  });

  it('leaves a topic note alone', () => {
    expect(isDomainContainer(slugKeys('D-Manose'), tags)).toBe(false);
  });

  it('never fires when no domain vocabulary is configured', () => {
    expect(isDomainContainer(slugKeys('Neurologie'), [])).toBe(false);
  });
});

describe('parseTagList', () => {
  it('splits, trims and drops empties', () => {
    expect(parseTagList(' A ,, B , ')).toEqual(['A', 'B']);
  });

  it('treats undefined as no vocabulary', () => {
    expect(parseTagList(undefined)).toEqual([]);
  });
});

describe('decideSourceLemma', () => {
  const tags = parseTagList('Neurologie, Kardiologie, Biochemie');

  it('adds the lemma when the extraction missed it', () => {
    // The observed b1 case: alpha-/beta-Klotho extracted, Klotho itself not.
    expect(decideSourceLemma({
      sourceTitle: 'Klotho',
      entities: [{ name: 'alpha-Klotho' }, { name: 'beta-Klotho' }],
      concepts: [{ name: 'Phosphathaushalt' }],
      domainTags: tags,
    })).toEqual({ action: 'add', name: 'Klotho' });
  });

  it('skips when the lemma is already among the entities', () => {
    expect(decideSourceLemma({
      sourceTitle: 'Papain',
      entities: [{ name: 'Papain' }],
      concepts: [],
      domainTags: tags,
    })).toEqual({ action: 'skip', reason: 'already-extracted' });
  });

  it('skips when the lemma is already among the concepts', () => {
    expect(decideSourceLemma({
      sourceTitle: 'Silent Inflammation',
      entities: [],
      concepts: [{ name: 'Silent-Inflammation' }],
      domainTags: tags,
    })).toEqual({ action: 'skip', reason: 'already-extracted' });
  });

  it('skips a domain container even when its lemma is missing', () => {
    expect(decideSourceLemma({
      sourceTitle: 'Neurologie',
      sourceAliases: ['Neurowissenschaften'],
      entities: [{ name: 'Hippocampus' }],
      concepts: [],
      domainTags: tags,
    })).toEqual({ action: 'skip', reason: 'domain-container' });
  });

  it('prefers the container reason over the extraction reason', () => {
    // Both would fire; the reported reason must be stable for the log.
    expect(decideSourceLemma({
      sourceTitle: 'Neurologie',
      entities: [{ name: 'Neurologie' }],
      concepts: [],
      domainTags: tags,
    })).toEqual({ action: 'skip', reason: 'domain-container' });
  });

  it('skips when no title is available', () => {
    expect(decideSourceLemma({
      sourceTitle: '   ',
      entities: [],
      concepts: [],
      domainTags: tags,
    })).toEqual({ action: 'skip', reason: 'no-title' });
  });

  it('matches through a curated note alias, so no duplicate is added', () => {
    // `Notizen/LAMA-LABA.md` carries the alias `LAMA/LABA`; the slug of that
    // alias drops the slash, so the extracted `LAMALABA` is the same lemma.
    expect(decideSourceLemma({
      sourceTitle: 'LAMA-LABA',
      sourceAliases: ['LAMA/LABA'],
      entities: [{ name: 'LAMALABA' }],
      concepts: [],
      domainTags: tags,
    })).toEqual({ action: 'skip', reason: 'already-extracted' });
  });

  it('adds nothing for a vault with no domain vocabulary but an extracted lemma', () => {
    expect(decideSourceLemma({
      sourceTitle: 'Rutosid',
      entities: [{ name: 'Rutosid' }],
      concepts: [],
    })).toEqual({ action: 'skip', reason: 'already-extracted' });
  });
});
