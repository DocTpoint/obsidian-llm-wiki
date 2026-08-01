// Globals that Obsidian's renderer provides and Node does not.
//
// `window.setTimeout` is called directly by WikiEngine.createOrUpdateFile and
// `activeWindow` is Obsidian's popout-aware window reference. `activeDocument`
// is deliberately left undefined — only UI code reads it, and the ingest path
// reaching it should crash rather than silently render into nothing. Node 24
// already has a native `crypto.subtle`, so nothing is stubbed there.

import { Console } from 'node:console';

export function installObsidianGlobals(): void {
  const globals = globalThis as Record<string, unknown>;
  globals.window = globalThis;
  globals.activeWindow = globalThis;
  globals.console = plainConsole();
}

/**
 * Node colourizes inspected values in `console.debug('x:', 123)`; Obsidian's
 * DevTools console does not. Dropping the escape codes keeps the engine's
 * log lines byte-comparable between an Obsidian run and a CLI run.
 */
function plainConsole(): Console {
  return new Console({
    stdout: process.stdout,
    stderr: process.stderr,
    inspectOptions: { colors: false },
  });
}
