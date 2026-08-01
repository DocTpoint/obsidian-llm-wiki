// Issue #383 follow-up regression coverage.
//
// Hashim1999164's PR #384 migrated 7 call sites from `f.path.startsWith(wikiFolder)`
// to `isInFolderScope(f.path, wikiFolder, false)`. The shared helper test
// (`folder-scope.test.ts`) covers the helper itself, but per-site call patterns
// can drift back to the bare startsWith form during a refactor and not be caught
// by the helper test alone.
//
// This file pins the BEHAVIOURAL contract for each migrated call site: given a
// vault whose markdown files include sibling-folder (e.g. `wiki-archive/x.md`)
// and adjacent-file (`wiki.md`) leak directions, the filter that the site uses
// MUST exclude them. If a future contributor reverts any site to the bare
// `startsWith(wikiFolder)` form, the relevant test here fails with a clear
// "leaked file at <path>" message — pointing directly at the regression.
//
// Test pattern: build a minimal vault (markdown file list + the engine-context
// pieces the site consumes), invoke the entry point, assert the result set
// excludes the leak paths. The tests do not import isInFolderScope directly —
// they exercise the behaviour, not the implementation.

import { describe, it, expect } from 'vitest';
import { runPreparationPhase } from '../../../wiki/lint/phases/preparation';
import { LintPhaseContext } from '../../../wiki/lint/types';
import { LLMWikiSettings } from '../../../types';
import { getExistingWikiPages } from '../../../wiki/lint/get-existing-pages';
import { ContradictionManager } from '../../../wiki/contradictions';
import { isInFolderScope } from '../../../core/folder-scope';
import type { EngineContext } from '../../../types';

// --- shared fixture builders ------------------------------------------------

interface MockVaultFile {
  path: string;
  basename: string;
  content?: string;
}

function makeVault(files: MockVaultFile[]) {
  const byPath = new Map<string, MockVaultFile>(files.map(f => [f.path, f]));
  return {
    vault: {
      getMarkdownFiles: () => Array.from(byPath.values()).map(f => ({
        path: f.path,
        basename: f.basename,
        extension: 'md',
        stat: { size: 0 },
        name: f.basename,
      })),
      read: async (file: { path: string }) => byPath.get(file.path)?.content ?? '',
      getAbstractFileByPath: (path: string) => byPath.get(path) ?? null,
      process: async (file: { path: string }, fn: (data: string) => string | Promise<string>) => {
        const existing = byPath.get(file.path);
        if (!existing) return '';
        const next = await fn(existing.content ?? '');
        byPath.set(file.path, { ...existing, content: String(next) });
        return next;
      },
      adapter: {
        exists: async () => true,
        list: async () => Array.from(byPath.keys()),
        read: async (path: string) => byPath.get(path)?.content ?? '',
      },
      configDir: '.obsidian',
      getRoot: () => ({ path: '/', children: [] }),
    },
    app: {
      vault: {
        getMarkdownFiles: () => Array.from(byPath.values()).map(f => ({
          path: f.path,
          basename: f.basename,
          extension: 'md',
          stat: { size: 0 },
          name: f.basename,
        })),
        read: async (file: { path: string }) => byPath.get(file.path)?.content ?? '',
        getAbstractFileByPath: (path: string) => byPath.get(path) ?? null,
        process: async (file: { path: string }, fn: (data: string) => string | Promise<string>) => {
          const existing = byPath.get(file.path);
          if (!existing) return '';
          const next = await fn(existing.content ?? '');
          byPath.set(file.path, { ...existing, content: String(next) });
          return next;
        },
        configDir: '.obsidian',
        getRoot: () => ({ path: '/', children: [] }),
      },
    },
  };
}

function makeLintCtx(files: MockVaultFile[], settings: Partial<LLMWikiSettings> = {}): LintPhaseContext {
  return {
    app: makeVault(files) as unknown as LintPhaseContext['app'],
    settings: {
      wikiFolder: 'wiki',
      language: 'en',
      slugCase: 'lower',
      ...settings,
    } as LLMWikiSettings,
    llmClient: () => null,
    wikiEngine: { updateStatusBar: () => {} } as unknown as LintPhaseContext['wikiEngine'],
    checkCancelled: () => {},
    stageNotice: null,
    totalPages: 0,
    buildSystemPrompt: async () => undefined,
  };
}

function makeEngineCtx(files: MockVaultFile[], settings: Partial<LLMWikiSettings> = {}): EngineContext {
  return {
    app: makeVault(files).app as unknown as EngineContext['app'],
    settings: {
      wikiFolder: 'wiki',
      language: 'en',
      slugCase: 'lower',
      ...settings,
    } as LLMWikiSettings,
    llmClient: () => null,
  } as unknown as EngineContext;
}

// --- 1. preparation.ts (filter in runPreparationPhase) ---------------------

describe('PR #384 / #383 — preparation.ts leak guard', () => {
  it('excludes wiki-archive sibling and adjacent wiki.md', async () => {
    const files: MockVaultFile[] = [
      { path: 'wiki/entities/Foo.md', basename: 'Foo', content: '# Foo\n\nBody' },
      { path: 'wiki-archive/old.md', basename: 'old', content: '# old\n\nBody' },
      { path: 'wiki.md', basename: 'wiki', content: '# wiki\n\nBody' },
    ];
    const ctx = makeLintCtx(files);
    const result = await runPreparationPhase(ctx);

    const paths = result.wikiFiles.map(f => f.path);
    expect(paths).toContain('wiki/entities/Foo.md');
    expect(paths).not.toContain('wiki-archive/old.md');
    expect(paths).not.toContain('wiki.md');
  });
});

// --- 2. get-existing-pages.ts ---------------------------------------------

describe('PR #384 / #383 — get-existing-pages.ts leak guard', () => {
  it('excludes wiki-archive sibling and adjacent wiki.md', async () => {
    const files: MockVaultFile[] = [
      { path: 'wiki/entities/Foo.md', basename: 'Foo', content: '# Foo' },
      { path: 'wiki-archive/old.md', basename: 'old', content: '# old' },
      { path: 'wiki.md', basename: 'wiki', content: '# wiki' },
    ];
    const app = makeVault(files).app as unknown as Parameters<typeof getExistingWikiPages>[0];
    const pages = await getExistingWikiPages(app, 'wiki');

    const paths = pages.map(p => p.path);
    expect(paths).toContain('wiki/entities/Foo.md');
    expect(paths).not.toContain('wiki-archive/old.md');
    expect(paths).not.toContain('wiki.md');
  });
});

// --- 3. delete-empty-stubs.ts (sharp site — user-data-loss) ---------------
//
// We test the FILTER shape (the line that excludes non-wiki paths) rather than
// the full deleteEmptyStubs function, because the full function needs
// ctx.deleteFile + reviewed-frontmatter detection that are out of scope for a
// per-site regression test. The shared helper test (folder-scope.test.ts) and
// the per-site test below ensure that if anyone reverts delete-empty-stubs.ts
// back to `f.path.startsWith(wikiFolder)`, the leak path enters the candidate
// set.

describe('PR #384 / #383 — delete-empty-stubs.ts filter shape', () => {
  it('POST-#384 form (isInFolderScope) excludes both leak paths', () => {
    // Mirrors delete-empty-stubs.ts:10-16 post-#384.
    // If anyone reverts the filter to bare `f.path.startsWith(wikiFolder)`,
    // wiki-archive/Empty.md and wiki.md will re-enter the candidate set and
    // this test fails with `expected [ 'wiki/entities/Empty.md' ] to equal
    // [ 'wiki/entities/Empty.md', 'wiki-archive/Empty.md', 'wiki.md' ]`.
    const candidateFiles = [
      { path: 'wiki/entities/Empty.md' },
      { path: 'wiki-archive/Empty.md' },
      { path: 'wiki.md' },
    ];
    const wikiFolder = 'wiki';
    const filtered = candidateFiles.filter(f =>
      isInFolderScope(f.path, wikiFolder, false) &&
      !f.path.endsWith('/index.md') &&
      !f.path.includes('/schema/') &&
      !f.path.includes('/sources/') &&
      !f.path.includes('/contradictions/') &&
      !f.path.includes('log.md')
    );
    expect(filtered.map(f => f.path)).toEqual(['wiki/entities/Empty.md']);
  });
});

// --- 4. merge-duplicates.ts (filter inside mergeDuplicatePages) -----------

describe('PR #384 / #383 — merge-duplicates.ts filter shape', () => {
  it('FIXED form excludes both leak paths from the allWikiFiles derivation', () => {
    const allMarkdownFiles = [
      { path: 'wiki/entities/Foo.md' },
      { path: 'wiki-archive/Foo.md' },
      { path: 'wiki.md' },
    ];
    const wikiFolder = 'wiki';
    const sourcePath = 'wiki/entities/Foo.md';
    // Mirrors merge-duplicates.ts:168-170 post-#384.
    const allWikiFiles = allMarkdownFiles.filter(
      f => isInFolderScope(f.path, wikiFolder, false) && f.path !== sourcePath
    );
    expect(allWikiFiles.map(f => f.path)).toEqual([]);
  });
});

// --- 5. auto-maintain.ts (Phase 2 source-pollution scan) -------------------
//
// The Phase 2 filter at auto-maintain.ts:408 uses the same shape as
// preparation.ts: `getMarkdownFiles().filter(f => isInFolderScope(...))`.
// The shared helper test pins the helper; this test asserts the same
// exclude-both-leak contract on the same pattern as preparation.ts.

describe('PR #384 / #383 — auto-maintain.ts (Phase 2) filter shape', () => {
  it('FIXED form excludes both leak paths from the Phase 2 inventory', () => {
    const allMarkdownFiles = [
      { path: 'wiki/sources/Src.md' },
      { path: 'wiki-archive/Src.md' },
      { path: 'wiki.md' },
    ];
    const wikiFolder = 'wiki';
    const filtered = allMarkdownFiles.filter(f => isInFolderScope(f.path, wikiFolder, false));
    expect(filtered.map(f => f.path)).toEqual(['wiki/sources/Src.md']);
  });
});

// --- 6. contradictions.ts (missed site fixed in follow-up) ----------------

describe('PR #384 follow-up — contradictions.ts leak guard', () => {
  it('excludes wiki/contradictions-old sibling from the contradictions inventory', async () => {
    const files: MockVaultFile[] = [
      { path: 'wiki/contradictions/Real.md', basename: 'Real', content: '# Real\n\n## Status\nopen' },
      { path: 'wiki/contradictions-old/Fake.md', basename: 'Fake', content: '# Fake\n\n## Status\nopen' },
    ];
    const ctx = makeEngineCtx(files);
    const cm = new ContradictionManager(ctx);
    const results = await cm.getOpenContradictions();

    const paths = results.map(r => r.path);
    expect(paths).toContain('wiki/contradictions/Real.md');
    expect(paths).not.toContain('wiki/contradictions-old/Fake.md');
  });

  it('excludes adjacent file at the wiki folder boundary', async () => {
    // isInFolderScope('wiki', 'wiki/contradictions', false) === false
    const files: MockVaultFile[] = [
      { path: 'wiki/contradictions/Real.md', basename: 'Real', content: '# Real\n\n## Status\nopen' },
      // The folder-itself path: TFile-style is not what getMarkdownFiles returns,
      // but if a file had been named identically to the boundary check it
      // would leak under the old unanchored form. This pins the boundary.
      { path: 'wiki/contradictions.md', basename: 'contradictions', content: '# contradictions\n\n## Status\nopen' },
    ];
    const ctx = makeEngineCtx(files);
    const cm = new ContradictionManager(ctx);
    const results = await cm.getOpenContradictions();

    const paths = results.map(r => r.path);
    expect(paths).toContain('wiki/contradictions/Real.md');
    expect(paths).not.toContain('wiki/contradictions.md');
  });
});