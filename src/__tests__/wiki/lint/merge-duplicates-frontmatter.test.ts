// domain axis stage 2 (#568): `mergeDuplicatePages` was the one frontmatter
// writer without the #356 passthrough — a duplicate merge dropped every user-owned
// field of the surviving page. It now passes them through and unions `domains:`
// the way it unions `sources:`.

import { describe, it, expect } from 'vitest';
import { mergeDuplicatePages } from '../../../wiki/lint/merge-duplicates';
import { parseFrontmatter } from '../../../core/frontmatter';
import { createFakeLinkVault } from '../../__support__/link-vault';
import type { EngineContext } from '../../../types';

const TARGET = 'wiki/entities/Ferritin.md';
const SOURCE = 'wiki/entities/Ferritin-2.md';

function makeCtx(files: Record<string, string>) {
  const fake = createFakeLinkVault(files);
  const ctx = {
    app: { vault: fake.vault, metadataCache: fake.metadataCache },
    settings: { wikiFolder: 'wiki', language: 'en' },
    getClient: () => null,
    tryReadFile: async (path: string) => (files[path] === undefined ? fake.read(path) || null : fake.read(path)),
    createOrUpdateFile: async (path: string, content: string) => { fake.write(path, content); },
    deleteFile: async () => { /* not under test */ },
    getSchemaContext: async () => undefined,
  } as unknown as EngineContext;
  return { ctx, fake };
}

describe('mergeDuplicatePages — frontmatter passthrough and domains union', () => {
  it('passes the surviving page\'s unknown fields through', async () => {
    const { ctx, fake } = makeCtx({
      [TARGET]: '---\ntype: entity\ntags: [substance]\nredirect_to: "[[x]]"\nparent_org: Acme\n---\n\n# Ferritin\n\nIron store.\n',
      [SOURCE]: '---\ntype: entity\ntags: [substance]\n---\n\n# Ferritin-2\n\nAlso the iron store.\n',
    });
    await mergeDuplicatePages(ctx, TARGET, SOURCE);
    const written = fake.read(TARGET) ?? '';
    expect(written).toContain('redirect_to: "[[x]]"');
    expect(written).toContain('parent_org: Acme');
  });

  it('unions domains, survivor first, first occurrence wins', async () => {
    const { ctx, fake } = makeCtx({
      [TARGET]: '---\ntype: entity\ntags: [substance]\ndomains:\n  - "Sorte/Protein"\n  - "Fachgebiet/Hämatologie"\n---\n\n# Ferritin\n\nIron store.\n',
      [SOURCE]: '---\ntype: entity\ntags: [substance]\ndomains:\n  - "Fachgebiet/Hämatologie"\n  - "Thema/Eisen"\n---\n\n# Ferritin-2\n\nAlso the iron store.\n',
    });
    await mergeDuplicatePages(ctx, TARGET, SOURCE);
    const fm = parseFrontmatter(fake.read(TARGET) ?? '');
    expect(fm?.domains).toEqual(['Sorte/Protein', 'Fachgebiet/Hämatologie', 'Thema/Eisen']);
  });

  // Merging two pages is where the two spellings of one value meet, so this
  // is the site the raw-equality dedup hurt most: the survivor kept both.
  it('folds spelling variants across the two pages', async () => {
    const { ctx, fake } = makeCtx({
      [TARGET]: '---\ntype: entity\ntags: [substance]\ndomains:\n  - "Thema/Ernährung"\n---\n\n# Ferritin\n\nIron store.\n',
      [SOURCE]: '---\ntype: entity\ntags: [substance]\ndomains:\n  - "thema/ernährung"\n  - "Thema/Eisen"\n---\n\n# Ferritin-2\n\nAlso the iron store.\n',
    });
    await mergeDuplicatePages(ctx, TARGET, SOURCE);
    const fm = parseFrontmatter(fake.read(TARGET) ?? '');
    expect(fm?.domains).toEqual(['Thema/Ernährung', 'Thema/Eisen']);
  });
  it('leaves no domains field when neither page carries one', async () => {
    const { ctx, fake } = makeCtx({
      [TARGET]: '---\ntype: entity\ntags: [substance]\n---\n\n# Ferritin\n\nIron store.\n',
      [SOURCE]: '---\ntype: entity\ntags: [substance]\n---\n\n# Ferritin-2\n\nAlso the iron store.\n',
    });
    await mergeDuplicatePages(ctx, TARGET, SOURCE);
    expect(fake.read(TARGET) ?? '').not.toContain('domains');
  });
});
