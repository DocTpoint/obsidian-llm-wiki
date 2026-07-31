import { EngineContext } from '../../types';
import { parseFrontmatter } from '../../core/frontmatter';
import { isPageEmpty } from './utils';
import { isInFolderScope } from '../../core/folder-scope';

export async function deleteEmptyStubs(
  ctx: EngineContext,
  wikiFolder: string
): Promise<{ deleted: number; failed: number; errors: string[] }> {
  const files = ctx.app.vault.getMarkdownFiles()
    .filter(f => isInFolderScope(f.path, wikiFolder, false) &&
                 !f.path.endsWith('/index.md') &&
                 !f.path.includes('/schema/') &&
                 !f.path.includes('/sources/') &&
                 !f.path.includes('/contradictions/') &&
                 !f.path.includes('log.md'));

  let deleted = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const file of files) {
    try {
      const content = await ctx.app.vault.read(file);
      if (!isPageEmpty(content)) continue;
      const fm = parseFrontmatter(content);
      if (fm?.reviewed === true) continue;
      await ctx.deleteFile(file.path);
      deleted++;
    } catch (e) {
      failed++;
      const errMsg = e instanceof Error ? e.message : String(e);
      errors.push(`${file.path}: ${errMsg}`);
      console.error(`[deleteEmptyStubs] Failed: ${file.path}`, e);
    }
  }
  return { deleted, failed, errors };
}
