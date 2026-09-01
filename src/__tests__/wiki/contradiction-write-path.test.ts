// `source_page` is unvalidated model output, and the old path turned it
// into a write path by string surgery: `.replace(/\[\[(.+)\]\]/, …)`
// returns a bracket-less value unchanged, so the "target page" became
// whatever string the model wrote — including a user's note, which the
// plugin must never write. These tests pin the replacement contract:
// the value resolves against the real page index, and what does not
// resolve (or resolves ambiguously) produces ZERO writes.

import { describe, it, expect } from 'vitest';
import { ContradictionManager } from '../../wiki/contradictions';
import {
  resolveContradictionTarget,
  buildContradictionRecord,
} from '../../core/contradiction-record';
import type { EngineContext, ContradictionInfo } from '../../types';

function makeCtx(files: Record<string, string>) {
  const written: Record<string, string> = {};
  const ctx = {
    settings: { wikiFolder: 'wiki', wikiLanguage: 'en', disableThinking: false },
    app: {
      vault: {
        getMarkdownFiles: () =>
          Object.keys(files).map(path => ({
            path,
            basename: path.split('/').pop()!.replace(/\.md$/, ''),
            stat: { ctime: 0 },
          })),
        read: async (f: { path: string }) => files[f.path] ?? '',
        createFolder: async () => undefined,
      },
    },
    tryReadFile: async (p: string) => written[p] ?? files[p] ?? null,
    createOrUpdateFile: async (p: string, c: string) => {
      written[p] = c;
    },
  } as unknown as EngineContext;
  return { ctx, written };
}

const NOTE = '# Diet-Heart-Hypothese\n\nDie Notiz argumentiert dagegen.\n';
const PAGE = '---\ntype: entity\ncreated: 2026-01-01\n---\n\n# Statine\n\n## Description\nBody.\n';

const contradiction = (source_page: string): ContradictionInfo => ({
  claim: 'Saturated fat drives CHD',
  source_page,
  contradicted_by: 'The MCE re-analysis found no mortality benefit',
  resolution: 'Attribute both views',
});

describe('noteContradiction — unresolvable targets are discarded, never written', () => {
  it('a bracket-less note path produces zero writes and leaves the note untouched (Diet-Heart replay)', async () => {
    const { ctx, written } = makeCtx({
      'Notizen/Diet-Heart-Hypothese.md': NOTE,
      'wiki/entities/Statine.md': PAGE,
    });
    await new ContradictionManager(ctx).noteContradiction(
      contradiction('Notizen/Diet-Heart-Hypothese.md'),
      'Notizen/Diet-Heart-Hypothese.md'
    );
    expect(Object.keys(written)).toEqual([]);
  });

  it('a bracketed path that matches no page produces zero writes', async () => {
    const { ctx, written } = makeCtx({
      'wiki/entities/Statine.md': PAGE,
    });
    await new ContradictionManager(ctx).noteContradiction(
      contradiction('[[Notizen/Kognition.md]]'),
      'Notizen/Kognition.md'
    );
    expect(Object.keys(written)).toEqual([]);
  });

  it('an ambiguous title (entities and concepts twin) produces zero writes', async () => {
    const { ctx, written } = makeCtx({
      'wiki/entities/Stress.md': PAGE,
      'wiki/concepts/Stress.md': PAGE,
    });
    await new ContradictionManager(ctx).noteContradiction(
      contradiction('[[Stress]]'),
      'Notizen/Burnout.md'
    );
    expect(Object.keys(written)).toEqual([]);
  });
});

describe('noteContradiction — a resolved target gets marker + record, no body block', () => {
  it('stamps the frontmatter marker on the resolved page and writes the record', async () => {
    const { ctx, written } = makeCtx({
      'Notizen/Cholesterin.md': NOTE,
      'wiki/entities/Statine.md': PAGE,
    });
    await new ContradictionManager(ctx).noteContradiction(
      contradiction('[[Statine]]'),
      'Notizen/Cholesterin.md'
    );

    const page = written['wiki/entities/Statine.md'];
    expect(page).toBeDefined();
    expect(page).toContain('contradictions:');
    expect(page).toContain('Notizen/Cholesterin.md');
    // The body carries no block — the record is the prose carrier.
    expect(page).not.toContain('Potential Contradiction');
    expect(page).toContain('## Description\nBody.');

    const recordPath = Object.keys(written).find(p =>
      p.startsWith('wiki/contradictions/')
    );
    expect(recordPath).toBeDefined();
    const record = written[recordPath!];
    expect(record).toContain('status: detected');
    expect(record).toContain('source_page: "[[entities/Statine]]"');
    expect(record).toContain('source_note: "Notizen/Cholesterin.md"');
    expect(record).toContain('Saturated fat drives CHD');
    expect(record).toContain('The MCE re-analysis found no mortality benefit');
  });
});

describe('resolveContradictionTarget', () => {
  const pages = [
    { path: 'wiki/entities/Statine.md', title: 'Statine', aliases: ['Statins'] },
    { path: 'wiki/concepts/Entzündung.md', title: 'Entzündung' },
    { path: 'Notizen/Statine.md', title: 'Statine' },
  ];

  it('resolves the wiki-relative path first', () => {
    expect(
      resolveContradictionTarget('[[entities/Statine]]', pages, 'wiki')?.path
    ).toBe('wiki/entities/Statine.md');
  });

  it('strips brackets, alias half, and a trailing .md', () => {
    expect(
      resolveContradictionTarget('[[Statine.md|die Statine]]', pages, 'wiki')?.path
    ).toBe('wiki/entities/Statine.md');
  });

  it('resolves curated aliases case-insensitively', () => {
    expect(resolveContradictionTarget('statins', pages, 'wiki')?.path).toBe(
      'wiki/entities/Statine.md'
    );
  });

  it('never resolves to a path outside the wiki folder', () => {
    // The Notizen twin carries the same title; only the wiki page may win.
    const hit = resolveContradictionTarget('[[Statine]]', pages, 'wiki');
    expect(hit?.path).toBe('wiki/entities/Statine.md');
  });

  it('returns null for empty or unmatched values', () => {
    expect(resolveContradictionTarget('[[]]', pages, 'wiki')).toBeNull();
    expect(resolveContradictionTarget('Niacin', pages, 'wiki')).toBeNull();
  });
});

describe('buildContradictionRecord', () => {
  it('keeps exactly four ## sections in order (getOpenContradictions parses positionally)', () => {
    const { content } = buildContradictionRecord(
      {
        claim: 'A',
        existingView: 'B',
        resolution: 'C',
        pageRelPath: 'entities/X',
        sourceNotePath: 'Notizen/N.md',
        date: '2026-09-01',
      },
      {
        new_claim: 'New Claim',
        existing_knowledge: 'Existing Knowledge',
        resolution_suggestion: 'Resolution Suggestion',
        source_page: 'Source Page',
      }
    );
    const sections = content
      .split('\n')
      .filter(l => l.startsWith('## '))
      .map(l => l.slice(3));
    expect(sections).toEqual([
      'New Claim',
      'Existing Knowledge',
      'Resolution Suggestion',
      'Source Page',
    ]);
  });
});
