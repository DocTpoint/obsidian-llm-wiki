// Issue #364 — folder-boundary scoping for "ingest a folder".
//
// A bare `path.startsWith(folder.path)` treats a folder path as a plain string
// prefix, which is not the same as "is a descendant of this folder". Two things
// leak through:
//
//   * sibling folders sharing a name prefix — picking "Notizen" also matches
//     "Notizen-temp/x.md", because "Notizen-temp/x.md".startsWith("Notizen")
//   * a file sitting next to the folder — "Notizen.md" also matches "Notizen"
//
// Anchoring on a trailing slash makes the comparison mean what the caller
// intends. The vault root is the one folder with no prefix: every path is a
// descendant of it, and its own `path` is "/" rather than "".
//
// Pure and IO-free so the boundary rule can be unit-tested without an Obsidian
// vault — the call site only supplies two primitives.

/**
 * The string prefix every descendant of a folder shares.
 * Returns '' for the vault root, so `startsWith` accepts every path.
 */
export function folderScopePrefix(folderPath: string, isRoot: boolean): string {
  if (isRoot) return '';
  const trimmed = folderPath.replace(/\/+$/, '');
  if (trimmed.length === 0) return '';
  return `${trimmed}/`;
}

/**
 * True when `filePath` names a file inside the given folder, at any depth.
 * A folder is not a descendant of itself.
 */
export function isInFolderScope(
  filePath: string,
  folderPath: string,
  isRoot: boolean
): boolean {
  return filePath.startsWith(folderScopePrefix(folderPath, isRoot));
}

/**
 * True when `filePath` names the folder itself OR anything inside it.
 * The sibling case is `isInFolderScope`; the identity case was previously
 * hand-rolled at every call site as `path === folder || isInFolderScope(...)`
 * (e.g. PR #384's `FolderSuggestModal`, where the missing identity clause
 * let the wiki folder itself leak back into the picker). Centralizing it
 * keeps the boundary semantics in one file with one test suite.
 *
 * `folderPath` is compared with trailing slashes stripped so a normalised
 * folder path and an unnormalised one with a trailing slash both match.
 */
export function isAtOrInFolderScope(
  filePath: string,
  folderPath: string,
  isRoot: boolean
): boolean {
  const trimmedFolder = folderPath.replace(/\/+$/, '');
  if (trimmedFolder.length > 0 && filePath === trimmedFolder) return true;
  return isInFolderScope(filePath, folderPath, isRoot);
}

/**
 * Whether a path may be presented to the user as an ingest source folder
 * or watched folder. Combines the wiki boundary, the config directory, and
 * the wiki folder's own identity. Used by both `FileSuggestModal`,
 * `FolderSuggestModal` and the multi-file variant — one rule, three sites.
 */
export function isExcludedFromSourcePicker(
  path: string,
  wikiFolder: string,
  configDir: string
): boolean {
  return (
    isAtOrInFolderScope(path, wikiFolder, false) ||
    isAtOrInFolderScope(path, configDir, false)
  );
}
