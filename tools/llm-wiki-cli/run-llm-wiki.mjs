#!/usr/bin/env node
// Entry point for the ingest CLI.
//
// The plugin's sources are TypeScript and import a module named `obsidian`
// that only exists inside the app. esbuild solves both in one pass: it
// compiles the TS and rewrites every `obsidian` import to the shim in
// ./src/obsidian.ts, so plugin code and CLI code share one TFile class and
// `instanceof` keeps working. The bundle is then imported and run.

import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as nodePath from 'node:path';

const CLI_DIR = nodePath.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = nodePath.resolve(CLI_DIR, '../..');
const BUNDLE_PATH = nodePath.join(CLI_DIR, '.build', 'llm-wiki-cli.mjs');
const OBSIDIAN_SHIM = nodePath.join(CLI_DIR, 'src', 'obsidian.ts');

const require = createRequire(nodePath.join(PLUGIN_ROOT, 'package.json'));
const esbuild = require('esbuild');

const obsidianShimPlugin = {
  name: 'obsidian-shim',
  setup(build) {
    build.onResolve({ filter: /^obsidian$/ }, () => ({ path: OBSIDIAN_SHIM }));
  },
};

await esbuild.build({
  entryPoints: [nodePath.join(CLI_DIR, 'src', 'main.ts')],
  outfile: BUNDLE_PATH,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: 'inline',
  logLevel: 'warning',
  absWorkingDir: PLUGIN_ROOT,
  plugins: [obsidianShimPlugin],
  // Some bundled dependencies still call `require` at runtime; ESM output has
  // no such binding, so provide one built from this module's URL.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);",
  },
});

const { main } = await import(pathToFileURL(BUNDLE_PATH).href);

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
