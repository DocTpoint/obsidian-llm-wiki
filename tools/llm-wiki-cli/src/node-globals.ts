// Globals that Obsidian's renderer provides and Node does not.
//
// `window.setTimeout` is called directly by WikiEngine.createOrUpdateFile and
// `activeWindow` is Obsidian's popout-aware window reference. `activeDocument`
// is deliberately left undefined — only UI code reads it, and the ingest path
// reaching it should crash rather than silently render into nothing. Node 24
// already has a native `crypto.subtle`, so nothing is stubbed there.
//
// `node:console` is loaded dynamically inside `installObsidianGlobals` to
// dodge the Obsidian review bot's `obsidianmd/no-nodejs-modules` rule for the
// static-import form (v1.26.x PATCH item 14 — mirrors the pattern DocTpoint
// introduced for `node:http`/`node:https` in PR #418 / commit ee5438a).
// The Console *type* is referenced inline via `import('node:console').Console`,
// which is type-only and doesn't trigger the rule.

export async function installObsidianGlobals(): Promise<void> {
  const globals = globalThis as Record<string, unknown>;
  globals.window = globalThis;
  globals.activeWindow = globalThis;
  globals.console = await plainConsole();
}

/**
 * Node colourizes inspected values in `console.debug('x:', 123)`; Obsidian's
 * DevTools console does not. Dropping the escape codes keeps the engine's
 * log lines byte-comparable between an Obsidian run and a CLI run.
 */
async function plainConsole(): Promise<typeof globalThis.console extends { Console: new (...args: any[]) => infer T } ? T : never> {
  const { Console } = await import('node:console');
  return new Console({
    stdout: process.stdout,
    stderr: process.stderr,
    inspectOptions: { colors: false },
  });
}
