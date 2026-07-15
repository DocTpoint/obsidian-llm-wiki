// Local patch 11 — write-level audit trail.
//
// The audit exists because merge-guard.py is blind to intra-batch merges: it
// classifies risk against a pre-batch snapshot, so a page created AND re-merged
// inside one run is filed as a plain CREATE. These tests pin the two things that
// blindness cost us before — a body silently shrinking (S31: a whole `## Kerninhalt`
// vanished on merge) and a mentions section losing curated quotes (S36: the
// destructive updateRelatedPage rewrite).

import { describe, it, expect } from 'vitest';
import { summarizePage, detectLosses, buildAuditEntry, formatAuditLine } from '../../wiki/write-audit';

const LABEL = 'Erwähnungen in der Quelle';

function page(opts: {
  sources?: string[];
  reviewed?: boolean;
  body?: string;
  mentions?: string[];
  rawMentions?: string;
}): string {
  const fm = ['---', 'type: concept'];
  if (opts.reviewed) fm.push('reviewed: true');
  if (opts.sources?.length) {
    fm.push('sources:');
    for (const s of opts.sources) fm.push(`  - "[[sources/${s}]]"`);
  }
  fm.push('---');

  const parts = [fm.join('\n'), '', opts.body ?? 'Beschreibungstext.'];
  if (opts.rawMentions !== undefined) {
    parts.push('', `## ${LABEL}`, '', opts.rawMentions);
  } else if (opts.mentions?.length) {
    parts.push('', `## ${LABEL}`, '');
    for (const m of opts.mentions) {
      parts.push(`- "${m}" — [[sources/Butyrat|Butyrat]]`);
    }
  }
  return parts.join('\n');
}

describe('summarizePage', () => {
  it('reports an absent file as non-existent rather than empty', () => {
    const facts = summarizePage(null, LABEL);
    expect(facts.exists).toBe(false);
    expect(facts.bodyLen).toBe(0);
  });

  it('counts frontmatter sources and structured mentions', () => {
    const facts = summarizePage(
      page({ sources: ['Butyrat', 'Omega-3'], mentions: ['Zitat A', 'Zitat B'] }),
      LABEL
    );
    expect(facts.exists).toBe(true);
    expect(facts.sourceCount).toBe(2);
    expect(facts.mentionsFound).toBe(true);
    expect(facts.mentionsParsed).toBe(true);
    expect(facts.mentionCount).toBe(2);
  });

  it('distinguishes an unparseable section from an empty one (the S36 trap)', () => {
    // Legacy blockquote format: the section is full of curated content but the
    // bullet parser cannot structure it. Reporting mentionCount 0 alone would be
    // indistinguishable from "the section was emptied" — mentionsParsed and
    // mentionsRawLen are what keep those apart.
    const legacy = summarizePage(
      page({ rawMentions: '> **Source: [[sources/Butyrat]]**\n> "Ein kuratiertes Zitat."' }),
      LABEL
    );
    expect(legacy.mentionsFound).toBe(true);
    expect(legacy.mentionsParsed).toBe(false);
    expect(legacy.mentionCount).toBe(0);
    expect(legacy.mentionsRawLen).toBeGreaterThan(0);

    const emptied = summarizePage(page({ mentions: [] }), LABEL);
    expect(emptied.mentionsFound).toBe(false);
    expect(emptied.mentionsRawLen).toBe(0);
  });
});

describe('detectLosses', () => {
  it('flags nothing for a create — nothing existed to lose', () => {
    const after = summarizePage(page({ mentions: ['Zitat A'] }), LABEL);
    expect(detectLosses(summarizePage(null, LABEL), after)).toEqual([]);
  });

  it('flags nothing for a purely additive merge', () => {
    const before = summarizePage(page({ sources: ['Butyrat'], mentions: ['Zitat A'] }), LABEL);
    const after = summarizePage(
      page({
        sources: ['Butyrat', 'Omega-3'],
        body: 'Beschreibungstext. Und mehr.',
        mentions: ['Zitat A', 'Zitat B'],
      }),
      LABEL
    );
    expect(detectLosses(before, after)).toEqual([]);
  });

  it('flags a shrinking body (S31: a merge dropped a whole prose section)', () => {
    const before = summarizePage(
      page({ body: 'Absatz eins.\n\n## Kerninhalt\n\nDrei lange Absätze voller Prosa.' }),
      LABEL
    );
    const after = summarizePage(page({ body: 'Absatz eins.' }), LABEL);
    expect(detectLosses(before, after)).toContain('body_shrank');
  });

  it('flags curated quotes vanishing from the mentions section (S36)', () => {
    const before = summarizePage(page({ mentions: ['Zitat A', 'Zitat B', 'Zitat C'] }), LABEL);
    const after = summarizePage(page({ mentions: ['Zitat C'] }), LABEL);
    const losses = detectLosses(before, after);
    expect(losses).toContain('mentions_lost');
    expect(losses).toContain('mentions_section_shrank');
  });

  it('flags the mentions section disappearing entirely', () => {
    const before = summarizePage(page({ mentions: ['Zitat A'] }), LABEL);
    const after = summarizePage(page({ body: 'Nur noch Prosa.' }), LABEL);
    expect(detectLosses(before, after)).toContain('mentions_section_gone');
  });

  it('flags a shrinking legacy section even though it never parsed', () => {
    // mentionCount is 0 on both sides here, so the count rule cannot see this.
    // Raw length is what catches it.
    const before = summarizePage(
      page({ rawMentions: '> **Source: [[sources/Butyrat]]**\n> "Zitat eins."\n> "Zitat zwei."' }),
      LABEL
    );
    const after = summarizePage(page({ rawMentions: '> **Source: [[sources/Butyrat]]**' }), LABEL);
    const losses = detectLosses(before, after);
    expect(before.mentionsParsed).toBe(false);
    expect(losses).toContain('mentions_section_shrank');
    expect(losses).not.toContain('mentions_lost');
  });

  it('flags dropped provenance', () => {
    const before = summarizePage(page({ sources: ['Butyrat', 'Omega-3'] }), LABEL);
    const after = summarizePage(page({ sources: ['Omega-3'] }), LABEL);
    expect(detectLosses(before, after)).toContain('sources_lost');
  });

  it('flags any rewrite of a reviewed page (appendToReviewedPage, still open upstream)', () => {
    const before = summarizePage(page({ reviewed: true, body: 'Handkuratierter Text.' }), LABEL);
    const after = summarizePage(page({ reviewed: true, body: 'Vom Modell umgeschrieben.' }), LABEL);
    expect(detectLosses(before, after)).toContain('reviewed_page_rewritten');
  });
});

describe('audit entry', () => {
  it('labels writes by whether the page existed, not by what the caller claims', () => {
    const absent = summarizePage(null, LABEL);
    const present = summarizePage(page({}), LABEL);
    expect(buildAuditEntry('wiki/concepts/A.md', absent, present).op).toBe('create');
    expect(buildAuditEntry('wiki/concepts/A.md', present, present).op).toBe('update');
  });

  it('records which code path wrote, so a loss can be pinned to a route', () => {
    const before = summarizePage(page({ body: 'Lange Beschreibung mit Substanz.' }), LABEL);
    const after = summarizePage(page({ body: 'Kurz.' }), LABEL);
    const entry = buildAuditEntry(
      'wiki/entities/Butyrat.md',
      before,
      after,
      'mergePage:llm-body-rewrite'
    );
    expect(entry.origin).toBe('mergePage:llm-body-rewrite');
    expect(entry.losses).toContain('body_shrank');
  });

  it('falls back to "unknown" rather than dropping the field', () => {
    const facts = summarizePage(page({}), LABEL);
    expect(buildAuditEntry('wiki/entities/A.md', facts, facts).origin).toBe('unknown');
  });

  it('serialises to one parseable JSON object per line', () => {
    const before = summarizePage(page({ mentions: ['Zitat A', 'Zitat B'] }), LABEL);
    const after = summarizePage(page({ mentions: ['Zitat A'] }), LABEL);
    const line = formatAuditLine(buildAuditEntry('wiki/concepts/NF-κB.md', before, after));

    expect(line.endsWith('\n')).toBe(true);
    expect(line.trimEnd().includes('\n')).toBe(false);
    const parsed = JSON.parse(line) as { path: string; op: string; losses: string[] };
    expect(parsed.path).toBe('wiki/concepts/NF-κB.md');
    expect(parsed.op).toBe('update');
    expect(parsed.losses).toContain('mentions_lost');
  });
});
