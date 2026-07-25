// Recall gate for the dedup candidate pre-filter (selectDedupCandidates).
//
// The semantic dedup call used to ship EVERY same-type page to the LLM. On a
// real vault (~1285 entities) that is ~77K chars ≈ 40K prompt tokens for a
// yes/no answer worth 16 completion tokens. The pre-filter ranks candidates
// with the zero-token lexical matcher and sends only the top K.
//
// The risk this file guards: a pre-filter that drops the TRUE duplicate
// creates a duplicate page — a correctness bug, and in a from-scratch rebuild
// it happens at scale. So the criterion is RECALL = 100% over every fixture
// pair: for each (new candidate, true existing target), the target MUST be in
// the selected set. A failure means raise K or widen the fallback — never
// lower the bar.
//
// Both branches are covered:
//   - lexical branch: shared tokens exist → top-K must contain the target
//   - fallback branch: zero lexical overlap (translations, initialisms) → the
//     full list is returned, so the target is trivially retained

import { describe, it, expect } from 'vitest';
import { selectDedupCandidates } from '../../../wiki/page-factory/path-resolution';
import { DEDUP_CANDIDATE_TOP_K } from '../../../constants';

interface Page { path: string; title: string; aliases?: string[] }

function page(title: string, aliases?: string[]): Page {
  return { path: `wiki/entities/${title}.md`, title, aliases };
}

describe('selectDedupCandidates — lexical branch keeps the true duplicate', () => {
  it('finds Typ-2-Diabetes for the candidate "Diabetes-mellitus-Typ-2"', () => {
    const target = page('Typ-2-Diabetes');
    const pages = [page('Hypertonie'), target, page('Zöliakie')];
    const selected = selectDedupCandidates(
      'Diabetes-mellitus-Typ-2',
      'Diabetes als chronische Stoffwechselerkrankung mit Insulinresistenz.',
      pages,
    );
    expect(selected.map(p => p.path)).toContain(target.path);
  });

  it('finds the pre-rename Lactobacillus plantarum for Lactiplantibacillus plantarum', () => {
    const target = page('Lactobacillus plantarum');
    const pages = [page('Bifidobacterium longum'), target, page('Escherichia coli')];
    const selected = selectDedupCandidates(
      'Lactiplantibacillus plantarum',
      'Milchsäurebakterium, 2020 aus der Gattung Lactobacillus reklassifiziert.',
      pages,
    );
    expect(selected.map(p => p.path)).toContain(target.path);
  });

  it('keeps the true match inside top-K against 40+ scoring distractors', () => {
    // Every distractor shares the token "lactobacillus" (score 3); only the
    // true target also matches "plantarum" (score 6), so it must sort ahead of
    // all of them and survive the K cut.
    const target = page('Lactobacillus plantarum');
    const distractors = Array.from({ length: 44 }, (_, i) =>
      page(`Lactobacillus species-${i}`),
    );
    const pages = [...distractors.slice(0, 22), target, ...distractors.slice(22)];
    const selected = selectDedupCandidates(
      'Lactiplantibacillus plantarum',
      'Milchsäurebakterium der früheren Gattung Lactobacillus.',
      pages,
    );
    expect(selected.length).toBeLessThanOrEqual(DEDUP_CANDIDATE_TOP_K);
    expect(selected.map(p => p.path)).toContain(target.path);
  });

  it('matches via aliases, not only titles', () => {
    const target = page('Ferritin-Sättigung', ['Transferrinsättigung']);
    const pages = [page('Hämoglobin'), target];
    const selected = selectDedupCandidates(
      'Transferrinsättigung',
      'Laborwert des Eisenstoffwechsels.',
      pages,
    );
    expect(selected.map(p => p.path)).toContain(target.path);
  });
});

describe('selectDedupCandidates — zero-overlap fallback returns the full list', () => {
  it('retains "Massachusetts Institute of Technology" for the candidate "MIT"', () => {
    // Pins the NAME-gated fallback: the summary token "in" incidentally
    // substring-matches "Indiana" and "Institute", so a fallback gated on
    // the ranked list being empty would take the lexical branch here and
    // rank on summary noise. The name "MIT" matches nothing → full list.
    const target = page('Massachusetts Institute of Technology');
    const pages = [page('Stanford'), page('Indiana University'), target, page('ETH Zürich')];
    const selected = selectDedupCandidates(
      'MIT',
      'Private Forschungsuniversität in Cambridge.',
      pages,
    );
    expect(selected).toEqual(pages);
    expect(selected.map(p => p.path)).toContain(target.path);
  });

  it('retains the Chinese page 清华大学 for the candidate "Tsinghua University"', () => {
    const target = page('清华大学');
    const pages = [page('北京大学'), target, page('复旦大学')];
    const selected = selectDedupCandidates(
      'Tsinghua University',
      'Research institution founded 1911 in Beijing.',
      pages,
    );
    expect(selected).toEqual(pages);
    expect(selected.map(p => p.path)).toContain(target.path);
  });

  it('returns the input unchanged when there are no pages at all', () => {
    expect(selectDedupCandidates('X', 'y', [])).toEqual([]);
  });
});

describe('Gate 1c — token proof: rendered candidate list shrinks by orders of magnitude', () => {
  it('collapses a 1114-page same-type list to a few thousand characters', () => {
    // Mirrors the real vault shape (≈1114 concepts) and the exact rendering
    // used for {{existing_pages}} in path-resolution.ts.
    const target = page('Typ-2-Diabetes');
    const vault: Page[] = [
      target,
      ...Array.from({ length: 1113 }, (_, i) =>
        page(`Fachbegriff-Nummer-${i}`, [`Synonym-${i}`, `Abkürzung-${i}`]),
      ),
    ];
    const render = (pages: Page[]): string =>
      pages
        .map(p => {
          const aliasBlock = p.aliases?.length ? `\n  aliases: ${p.aliases.join(', ')}` : '';
          return `- path: ${p.path}\n  title: ${p.title}${aliasBlock}`;
        })
        .join('\n');

    const before = render(vault).length;
    const selected = selectDedupCandidates(
      'Diabetes-mellitus-Typ-2',
      'Diabetes als chronische Stoffwechselerkrankung mit Insulinresistenz.',
      vault,
    );
    const after = render(selected).length;

    // Measured on this fixture: 131,409 chars → 3,405 chars (97.4%
    // reduction, 1114 → 30 candidates). The 5% bound below enforces the
    // order-of-magnitude collapse without pinning exact fixture bytes.
    expect(selected.map(p => p.path)).toContain(target.path);
    expect(selected.length).toBeLessThanOrEqual(DEDUP_CANDIDATE_TOP_K);
    expect(after).toBeLessThan(before * 0.05);
  });
});
