// Parser-contract tests for the headless ingest CLI. They pin parse-time
// validation so a future flag change cannot silently regress error behaviour.
// Importing `main` pulls in the CLI shims (vault, node-globals) and the real
// production modules, but module scope only defines constants and functions —
// nothing runs until `main()` is called, so this import stays side-effect-free.

import nodePath from 'node:path';
import { describe, it, expect } from 'vitest';

import { parseCliOptions, dispatchCli, resolveApiKey, applyThinkingMode } from '../../../../tools/llm-wiki-cli/src/main';

const base = (extra: string[] = []): string[] => [
  '--vault', '/tmp/vault', '--source', 'notes.md', ...extra,
];

describe('parseCliOptions', () => {
  it('throws a USAGE-tagged error when required flags are missing', () => {
    expect(() => parseCliOptions([])).toThrow(/Usage:/);
  });

  it('parses a minimal valid invocation into absolute path + flags', () => {
    const opts = parseCliOptions(['--vault', '/tmp/vault', '--source', 'notes.md']);
    expect(nodePath.isAbsolute(opts.vault)).toBe(true);
    expect(opts.source).toBe('notes.md');
    expect(opts.dryRun).toBe(false);
    expect(opts.force).toBe(false);
    expect(opts.extractOnly).toBe(false);
  });

  it('rejects a non-integer seed with USAGE', () => {
    expect(() => parseCliOptions(base(['--seed', '1.5']))).toThrow(/--seed must be an integer/);
  });

  it('rejects an out-of-range top-p with USAGE', () => {
    expect(() => parseCliOptions(base(['--top-p', '1.5']))).toThrow(/--top-p/);
  });

  it('rejects a negative max-tokens-per-call with USAGE', () => {
    expect(() => parseCliOptions(base(['--max-tokens-per-call', '-1']))).toThrow(/--max-tokens-per-call/);
  });

  it('rejects a zero batch-size with USAGE', () => {
    expect(() => parseCliOptions(base(['--batch-size', '0']))).toThrow(/--batch-size/);
  });

  it('rejects a non-finite temperature with USAGE', () => {
    expect(() => parseCliOptions(base(['--temperature', 'NaN']))).toThrow(/--temperature/);
  });

  it('marks --help without exiting (pure function)', () => {
    const opts = parseCliOptions(['--help']);
    expect(opts.help).toBe(true);
  });
});

describe('dispatchCli', () => {
  it('returns tool-help for empty argv', () => {
    expect(dispatchCli([])).toEqual({ kind: 'tool-help' });
  });

  it('returns tool-help for --help at the top level', () => {
    expect(dispatchCli(['--help'])).toEqual({ kind: 'tool-help' });
    expect(dispatchCli(['-h'])).toEqual({ kind: 'tool-help' });
  });

  it('returns ingest with remaining args for the ingest command', () => {
    expect(dispatchCli(['ingest'])).toEqual({ kind: 'ingest', rest: [] });
    expect(dispatchCli(['ingest', '--vault', '/v', '--source', 'n.md']))
      .toEqual({ kind: 'ingest', rest: ['--vault', '/v', '--source', 'n.md'] });
  });

  it('returns unknown for an unknown subcommand name', () => {
    expect(dispatchCli(['lint'])).toEqual({ kind: 'unknown', command: 'lint' });
  });

  it('returns unknown when the first arg looks like a flag (likely missing ingest)', () => {
    expect(dispatchCli(['--vault', '/v'])).toEqual({ kind: 'unknown', command: '--vault' });
  });
});

describe('parseCliOptions — --thinking-mode', () => {
  it('accepts data-json / plugin-off / server-default', () => {
    expect(parseCliOptions(base(['--thinking-mode', 'data-json'])).thinkingMode).toBe('data-json');
    expect(parseCliOptions(base(['--thinking-mode', 'plugin-off'])).thinkingMode).toBe('plugin-off');
    expect(parseCliOptions(base(['--thinking-mode', 'server-default'])).thinkingMode).toBe('server-default');
  });

  it('rejects an unknown --thinking-mode value with USAGE', () => {
    expect(() => parseCliOptions(base(['--thinking-mode', 'on'])))
      .toThrow(/--thinking-mode/);
  });

  it('numeric validation errors include the ingest USAGE block', () => {
    // The boundary-catch contract: every error escaping parseCliOptions
    // ends up with INGEST_USAGE appended (unless the throw site already
    // inlined it). Tests assert on a stable substring of the USAGE block
    // (the example Usage line) rather than the full block, so future
    // whitespace reformatting in INGEST_USAGE doesn't break this test.
    const USAGE_FRAGMENT = /llm-wiki-cli\/run-llm-wiki\.mjs ingest/;
    expect(() => parseCliOptions(base(['--seed', '1.5']))).toThrow(USAGE_FRAGMENT);
    expect(() => parseCliOptions(base(['--top-p', '1.5']))).toThrow(USAGE_FRAGMENT);
    expect(() => parseCliOptions(base(['--max-tokens-per-call', '-1']))).toThrow(USAGE_FRAGMENT);
    expect(() => parseCliOptions(base(['--batch-size', '0']))).toThrow(USAGE_FRAGMENT);
    expect(() => parseCliOptions(base(['--temperature', 'NaN']))).toThrow(USAGE_FRAGMENT);
  });

  it('parseArgs errors (unknown option, missing argument) also include the USAGE block', () => {
    // A typo'd flag is the most common CLI mistake, and it's the one case
    // that previously showed the least help — Node's own parseArgs error
    // bubbles up bare. The boundary catch in main() (not parseCliOptions)
    // is what attaches USAGE to those.
    const USAGE_FRAGMENT = /llm-wiki-cli\/run-llm-wiki\.mjs ingest/;
    expect(() => parseCliOptions(['--vualt', '/v'])).toThrow(USAGE_FRAGMENT);
    expect(() => parseCliOptions(['--vault', '/v', '--source', 'x.md', '--batch-size'])).toThrow(USAGE_FRAGMENT);
  });

  it('throws a deprecation error for the legacy --thinking flag', () => {
    expect(() => parseCliOptions(base(['--thinking', 'off'])))
      .toThrow(/--thinking is deprecated.*v1\.26\.0.*--thinking-mode/);
    expect(() => parseCliOptions(base(['--thinking', 'data-json'])))
      .toThrow(/--thinking is deprecated/);
  });

  it('throws when both --thinking-mode and --thinking are given', () => {
    expect(() => parseCliOptions(base([
      '--thinking-mode', 'plugin-off',
      '--thinking', 'off',
    ]))).toThrow(/--thinking.*--thinking-mode/);
  });
});

describe('parseCliOptions — --round-base', () => {
  it('accepts a positive integer', () => {
    expect(parseCliOptions(base(['--round-base', '6'])).roundBase).toBe(6);
  });

  it('rejects zero (must be positive)', () => {
    expect(() => parseCliOptions(base(['--round-base', '0'])))
      .toThrow(/--round-base must be a positive integer/);
  });

  it('rejects a non-integer', () => {
    expect(() => parseCliOptions(base(['--round-base', 'abc'])))
      .toThrow(/--round-base/);
  });

  it('throws a deprecation error for the legacy --max-rounds flag', () => {
    expect(() => parseCliOptions(base(['--max-rounds', '6'])))
      .toThrow(/--max-rounds is deprecated.*v1\.26\.0.*--round-base/);
  });

  it('throws when both --round-base and --max-rounds are given', () => {
    expect(() => parseCliOptions(base([
      '--round-base', '6',
      '--max-rounds', '6',
    ]))).toThrow(/--max-rounds.*--round-base/);
  });
});

describe('resolveApiKey', () => {
  it('returns the trimmed env value when present', () => {
    expect(resolveApiKey('anthropic', { WIKI_API_KEY: 'sk-abc' })).toBe('sk-abc');
    expect(resolveApiKey('anthropic', { WIKI_API_KEY: '  sk-abc  ' })).toBe('sk-abc');
  });

  it('throws a friendly error for cloud providers when the env var is unset', () => {
    expect(() => resolveApiKey('anthropic', { WIKI_API_KEY: '' }))
      .toThrow(/No API key available for provider "anthropic"/);
  });

  it('throws when the env var is whitespace only', () => {
    expect(() => resolveApiKey('anthropic', { WIKI_API_KEY: '   ' }))
      .toThrow(/No API key available/);
  });

  it('the error tells the user how to extract the key on each OS', () => {
    const msg = expectError(() => resolveApiKey('deepseek', { WIKI_API_KEY: '' }));
    expect(msg).toMatch(/security find-generic-password/); // macOS
    expect(msg).toMatch(/Credential Manager/);              // Windows
    expect(msg).toMatch(/seahorse|secret-tool/);            // Linux
  });

  it('the error points at the failing provider name, not a generic "missing key"', () => {
    const msg = expectError(() => resolveApiKey('anthropic', { WIKI_API_KEY: '' }));
    expect(msg).toContain('anthropic');
  });

  it('the error explains the keyless local-provider escape hatch', () => {
    const msg = expectError(() => resolveApiKey('anthropic', { WIKI_API_KEY: '' }));
    expect(msg).toMatch(/ollama|lmstudio/i);
  });

  it('returns an empty string for local providers when no key is set', () => {
    expect(resolveApiKey('ollama', { WIKI_API_KEY: '' })).toBe('');
    expect(resolveApiKey('lmstudio', { WIKI_API_KEY: '' })).toBe('');
  });
});

function expectError(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error('expected fn() to throw, but it did not');
}

describe('parseCliOptions — granularity', () => {
  // Bare-property lookup on a plain object accepts prototype keys
  // (`constructor`, `toString`, `__proto__`, …). The CLI must reject them
  // explicitly with `Object.hasOwn`, otherwise `--granularity constructor`
  // passes validation and downstream `calculateBatchLimits` returns
  // `initialBatchSize: undefined` for a silently broken run.
  it('rejects prototype keys (constructor, toString, __proto__)', () => {
    for (const bad of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(() => parseCliOptions(base(['--granularity', bad])))
        .toThrow(/Unknown granularity/);
    }
  });
});

describe('applyThinkingMode', () => {
  // Pure settings-mutation helper. The CLI runs this once when the user
  // passes `--thinking-mode <value>`; the bug it fixed was collapsing all
  // three modes into a single boolean assignment, so `data-json` silently
  // overwrote whatever the vault's data.json held for `disableThinking`.

  const make = (disableThinking: boolean) => ({ disableThinking } as { disableThinking: boolean });

  it('data-json is a no-op — leaves the existing setting untouched', () => {
    const s1 = make(true);
    applyThinkingMode(s1, 'data-json');
    expect(s1.disableThinking).toBe(true);

    const s2 = make(false);
    applyThinkingMode(s2, 'data-json');
    expect(s2.disableThinking).toBe(false);
  });

  it('plugin-off forces reasoning off regardless of the prior setting', () => {
    const s1 = make(true);  applyThinkingMode(s1, 'plugin-off');
    expect(s1.disableThinking).toBe(true);
    const s2 = make(false); applyThinkingMode(s2, 'plugin-off');
    expect(s2.disableThinking).toBe(true);
  });

  it('server-default forces reasoning to defer to the server preset', () => {
    const s1 = make(true);  applyThinkingMode(s1, 'server-default');
    expect(s1.disableThinking).toBe(false);
    const s2 = make(false); applyThinkingMode(s2, 'server-default');
    expect(s2.disableThinking).toBe(false);
  });
});
