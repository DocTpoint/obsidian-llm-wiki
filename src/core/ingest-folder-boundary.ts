// v1.25.10 PATCH Issue #364 — folder ingest boundary.
//
// `selectFolderToIngest` used to filter with `f.path.startsWith(folder.path)`
// which silently matched siblings sharing the same name prefix
// (`"Notizen-temp/x.md".startsWith("Notizen")` is true). Selecting "Notizen"
// would ingest every sibling folder named `Notizen-*`.
//
// `filterFilesInFolder` is the pure helper that enforces a path-prefix
// boundary: a folder match must reach the trailing separator, with the
// root folder treated as a wildcard ancestor. Has no IO; takes plain
// string lists so unit tests do not need a TFile vault stub.

/**
 * Return the subset of `filePaths` that live under `folderPath`.
 *
 * Boundary rules:
 *   - Root folder (`isRoot === true`): every file is included (no prefix).
 *   - Non-root: the file path must start with `${folderPath}/`. A bare
 *     `folderPath` prefix is NOT sufficient — this prevents siblings like
 *     `Notizen-temp/...` from being swallowed when the user picked
 *     `Notizen`.
 *
 * Allowed extensions filter is preserved at the call site (see
 * `selectFolderToIngest`); this helper is only the boundary check.
 *
 * Pure: no IO, no vault access.
 */
export function filterFilesInFolder(
  filePaths: readonly string[],
  folderPath: string,
  isRoot: boolean,
): string[] {
  if (isRoot) {
    return Array.from(filePaths);
  }
  if (!folderPath) return [];
  const prefix = `${folderPath}/`;
  return filePaths.filter(p => typeof p === 'string' && p.startsWith(prefix));
}
