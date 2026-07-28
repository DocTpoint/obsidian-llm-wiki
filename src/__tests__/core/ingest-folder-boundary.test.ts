// Unit tests for the v1.25.10 PATCH Issue #364 boundary helper.
// Pure function, no vault stub required.

import { describe, it, expect } from 'vitest';
import { filterFilesInFolder } from '../../core/ingest-folder-boundary';

const FILES = [
  // 'Notizen/' subtree — should be selected
  'Notizen/a.md',
  'Notizen/sub/c.md',
  'Notizen/sub/deeper/d.md',
  // Sibling sharing the name prefix — must NOT be selected
  'Notizen-temp/b.md',
  'Notizen-temp/inner/e.md',
  // Top-level files — selected only when the user picks the root
  'top.md',
  'unrelated.md',
];

describe('filterFilesInFolder — non-root folder', () => {
  it('keeps files inside the picked folder', () => {
    const result = filterFilesInFolder(FILES, 'Notizen', false);
    expect(result).toContain('Notizen/a.md');
    expect(result).toContain('Notizen/sub/c.md');
    expect(result).toContain('Notizen/sub/deeper/d.md');
  });

  it('excludes sibling folders that share the same name prefix', () => {
    // Repro from Issue #364: picking 'Notizen' must not also pull 'Notizen-temp'.
    const result = filterFilesInFolder(FILES, 'Notizen', false);
    expect(result).not.toContain('Notizen-temp/b.md');
    expect(result).not.toContain('Notizen-temp/inner/e.md');
  });

  it('excludes top-level files when a sub-folder is picked', () => {
    const result = filterFilesInFolder(FILES, 'Notizen', false);
    expect(result).not.toContain('top.md');
    expect(result).not.toContain('unrelated.md');
  });

  it('does NOT match a file that shares the folder basename outside the separator', () => {
    // Picked folder 'Foo' must not match 'Foo-bar/x.md'. The bare-prefix match
    // is the whole bug — this guard is what the v1.25.9 code was missing.
    const result = filterFilesInFolder(FILES, 'Foo', false);
    expect(result).toEqual([]);
  });

  it('returns [] when folderPath is empty and not root', () => {
    expect(filterFilesInFolder(FILES, '', false)).toEqual([]);
  });
});

describe('filterFilesInFolder — root folder', () => {
  it('includes every file when the user picked the vault root', () => {
    // Root is treated as a wildcard ancestor — folder ingestion from the
    // vault root collects the whole vault, matching the v1.25.9 intent.
    const result = filterFilesInFolder(FILES, '', true);
    expect(result).toEqual(expect.arrayContaining(FILES));
    expect(result.length).toBe(FILES.length);
  });

  it('is independent of folderPath when isRoot is true', () => {
    const result = filterFilesInFolder(FILES, 'Notizen', true);
    expect(result.length).toBe(FILES.length);
  });
});

describe('filterFilesInFolder — edge cases', () => {
  it('handles paths with leading nested separators', () => {
    // Picked folder 'a/b' must match 'a/b/c.md' but not 'a-b/c.md'.
    const files = ['a/b/c.md', 'a-b/c.md', 'a/bb/c.md'];
    const result = filterFilesInFolder(files, 'a/b', false);
    expect(result).toEqual(['a/b/c.md']);
  });

  it('preserves input order', () => {
    const files = ['Notizen/c.md', 'Notizen/a.md', 'Notizen/b.md'];
    const result = filterFilesInFolder(files, 'Notizen', false);
    expect(result).toEqual(['Notizen/c.md', 'Notizen/a.md', 'Notizen/b.md']);
  });

  it('ignores non-string entries defensively', () => {
    // The downstream caller passes TFile[].path strings, but defensive
    // typing here keeps the helper robust to repository quirks.
    const files = ['Notizen/a.md', null as unknown as string, undefined as unknown as string];
    const result = filterFilesInFolder(files, 'Notizen', false);
    expect(result).toEqual(['Notizen/a.md']);
  });
});
