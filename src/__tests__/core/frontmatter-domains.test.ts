// domain axis stage 2 (#568): `domains:` is a canonical frontmatter key.
//
// Why canonical and not passthrough: the array helpers re-serialize from the
// parsed object plus the *old* passthrough lines, so a union on an unknown key
// silently keeps the old value; and the constraints pass trims every line
// before its `- ` test, so block items under unknown keys are dropped. Both
// are exactly the operations the domain axis needs to survive.

import { describe, it, expect } from 'vitest';
import {
  serializeFrontmatter,
  extractPassthroughLines,
  CANONICAL_FRONTMATTER_KEYS,
  mergeFrontmatter,
  mergeFrontmatterArrayField,
  replaceFrontmatterArrayField,
  enforceFrontmatterConstraints,
  parseFrontmatter,
} from '../../core/frontmatter';

const DOMAINS = ['Sorte/Mineralstoff', 'Fachgebiet/Hämatologie'];

describe('domains: — canonical key', () => {
  it('is in the canonical set and therefore not a passthrough line', () => {
    expect(CANONICAL_FRONTMATTER_KEYS.has('domains')).toBe(true);
    const content = `---
type: entity
domains:
  - "Sorte/Mineralstoff"
redirect_to: "[[x]]"
---

# Body`;
    expect(extractPassthroughLines(content)).toEqual(['redirect_to: "[[x]]"']);
  });

  it('serializes as a block list between tags and reviewed, and is omitted when empty', () => {
    const block = serializeFrontmatter({
      type: 'entity', created: '2026-01-01', updated: '2026-08-21',
      tags: ['substance'], domains: DOMAINS, reviewed: true, aliases: ['Alt'],
    });
    expect(block).toContain('domains:\n  - "Sorte/Mineralstoff"\n  - "Fachgebiet/Hämatologie"');
    const order = ['tags:', 'domains:', 'reviewed:', 'aliases:'].map(k => block.indexOf(k));
    expect(order).toEqual([...order].sort((a, b) => a - b));

    const empty = serializeFrontmatter({ created: '2026-01-01', updated: '2026-08-21', domains: [] });
    expect(empty).not.toContain('domains');
    const absent = serializeFrontmatter({ created: '2026-01-01', updated: '2026-08-21' });
    expect(absent).not.toContain('domains');
  });

  it('mergeFrontmatter carries the existing domains across a re-ingest rewrite, once', () => {
    const existing = `---
type: concept
created: 2026-01-01
updated: 2026-01-02
sources:
  - "[[sources/a]]"
tags:
  - "method"
domains:
  - "Fachgebiet/Hämatologie"
---

# Body`;
    const { frontmatter } = mergeFrontmatter(existing, 'sources/b');
    expect(frontmatter.match(/^domains:/gm)?.length).toBe(1);
    expect(frontmatter).toContain('domains:\n  - "Fachgebiet/Hämatologie"');
    expect(frontmatter).toContain('[[sources/b]]');
  });

  it('array helpers union and replace the field like any other canonical list', () => {
    const content = `---
type: source
tags: [note]
domains:
  - "Sorte/Mineralstoff"
---

# Body`;
    const merged = mergeFrontmatterArrayField(content, 'domains', ['Sorte/Mineralstoff', 'Thema/Eisen']);
    expect(parseFrontmatter(merged)?.domains).toEqual(['Sorte/Mineralstoff', 'Thema/Eisen']);
    expect(merged.match(/^domains:/gm)?.length).toBe(1);

    const replaced = replaceFrontmatterArrayField(content, 'domains', ['Fachgebiet/Hämatologie']);
    expect(parseFrontmatter(replaced)?.domains).toEqual(['Fachgebiet/Hämatologie']);

    const cleared = replaceFrontmatterArrayField(content, 'domains', []);
    expect(cleared).not.toContain('domains');
  });

  it('enforceFrontmatterConstraints keeps block and inline domains, without a duplicate header', () => {
    const block = `---
type: entity
created: 2026-01-01
tags: [substance]
domains:
  - "Sorte/Mineralstoff"
  - "Fachgebiet/Hämatologie"
---

# Body`;
    const outBlock = enforceFrontmatterConstraints(block, 'entity');
    expect(parseFrontmatter(outBlock)?.domains).toEqual(DOMAINS);
    expect(outBlock.match(/^domains:/gm)?.length).toBe(1);

    const inline = `---
type: entity
created: 2026-01-01
tags: [substance]
domains: [Sorte/Mineralstoff, Fachgebiet/Hämatologie]
---

# Body`;
    const outInline = enforceFrontmatterConstraints(inline, 'entity');
    expect(parseFrontmatter(outInline)?.domains).toEqual(DOMAINS);
    expect(outInline.match(/^domains:/gm)?.length).toBe(1);
  });

  it('a page without the field stays without it through every writer (absence is not a signal)', () => {
    const content = `---
type: entity
created: 2026-01-01
tags: [substance]
---

# Body`;
    expect(enforceFrontmatterConstraints(content, 'entity')).not.toContain('domains');
    expect(mergeFrontmatter(content, 'sources/a').frontmatter).not.toContain('domains');
    expect(mergeFrontmatterArrayField(content, 'aliases', ['x'])).not.toContain('domains');
  });
});
