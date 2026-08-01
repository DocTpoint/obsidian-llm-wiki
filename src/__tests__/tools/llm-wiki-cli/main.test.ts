// Parser-contract tests for the headless ingest CLI. They pin parse-time
// validation so a future flag change cannot silently regress error behaviour.
// Importing `main` pulls in the CLI shims (vault, node-globals) and the real
// production modules, but module scope only defines constants and functions —
// nothing runs until `main()` is called, so this import stays side-effect-free.

import nodePath from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';

import { parseCliOptions, dispatchCli, resolveApiKey, applyThinkingMode, applyOverrides, parseNumber } from '../../../../tools/llm-wiki-cli/src/main';
import { GRANULARITY_CONFIG } from '../../../../src/core/batch-limits';

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

  it('trims the --model value', () => {
    // The emptiness guard checks the trimmed string but must also store the
    // trimmed value — a padded --model otherwise reaches the provider verbatim.
    expect(parseCliOptions(base(['--model', '  claude-sonnet-4-5  '])).model).toBe('claude-sonnet-4-5');
  });

  it('rejects an empty --model', () => {
    expect(() => parseCliOptions(base(['--model', '']))).toThrow(/--model must not be empty/);
    expect(() => parseCliOptions(base(['--model', '   ']))).toThrow(/--model must not be empty/);
  });

  it('rejects empty-string numeric flags', () => {
    // Number('') is 0, so without the parseNumber guard `--seed ""` would
    // silently become seed 0 and `--max-tokens-per-call ""` would silently
    // remove the token cap.
    expect(() => parseCliOptions(base(['--seed', '']))).toThrow(/--seed must be a number/);
    expect(() => parseCliOptions(base(['--max-tokens-per-call', '']))).toThrow(/--max-tokens-per-call must be a number/);
  });

  it('rejects integer flags above MAX_SAFE_INTEGER', () => {
    // Number() silently rounds beyond 2^53, so a seed that loses precision
    // would differ from what the user typed. isSafeInteger rejects it.
    expect(() => parseCliOptions(base(['--seed', '99999999999999999999']))).toThrow(/--seed must be an integer/);
    expect(() => parseCliOptions(base(['--round-base', '99999999999999999999']))).toThrow(/--round-base must be a positive integer/);
  });

  it('marks --help without exiting (pure function)', () => {
    const opts = parseCliOptions(['--help']);
    expect(opts.help).toBe(true);
  });

  it('accepts -h as an alias for --help at ingest level', () => {
    // dispatchCli special-cases -h at the tool level; the ingest subcommand
    // must accept the same short form instead of "Unknown option '-h'".
    expect(parseCliOptions(['-h']).help).toBe(true);
    expect(parseCliOptions(base(['-h'])).help).toBe(true);
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

  it('fires deprecations before the required-flag checks', () => {
    // A migrating script that still uses an old flag name AND omits
    // --vault/--source should learn about the rename first — not "--vault
    // is required." The deprecation blocks must precede the required checks.
    expect(() => parseCliOptions(['--thinking', 'off', '--source', 'n.md']))
      .toThrow(/--thinking is deprecated/);
    expect(() => parseCliOptions(['--max-rounds', '6', '--source', 'n.md']))
      .toThrow(/--max-rounds is deprecated/);
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

describe('parseNumber', () => {
  // Single helper replacing four near-identical validators (parseInteger,
  // parsePositiveInteger, parseNonNegativeNumber, parseProbability). Each
  // call site expresses its rule as a predicate.
  it('accepts any finite number when the predicate is the identity', () => {
    expect(parseNumber('0', '--x', () => true)).toBe(0);
    expect(parseNumber('-1.5', '--x', () => true)).toBe(-1.5);
    expect(parseNumber('42', '--x', () => true)).toBe(42);
  });

  it('rejects NaN and Infinity with a generic "must be a number" message', () => {
    expect(() => parseNumber('NaN', '--x', () => true)).toThrow(/--x must be a number/);
    expect(() => parseNumber('Infinity', '--x', () => true)).toThrow(/--x must be a number/);
  });

  it('rejects empty and whitespace-only raw values before Number() coercion', () => {
    // Number('') and Number('  ') are both 0, so without this guard
    // `--max-tokens-per-call ""` would silently mean "no cap".
    expect(() => parseNumber('', '--x', () => true)).toThrow(/--x must be a number, got: ""/);
    expect(() => parseNumber('   ', '--x', () => true)).toThrow(/--x must be a number, got: "   "/);
  });

  it('rejects when the predicate returns a non-true reason', () => {
    // 5.5 is not an integer, so the predicate returns the reason string.
    expect(() => parseNumber('5.5', '--x', n => Number.isInteger(n) || 'must be an integer'))
      .toThrow(/--x must be an integer, got: 5\.5/);
  });

  it('propagates the predicate reason verbatim after the flag prefix', () => {
    expect(() => parseNumber('0', '--top-p', n => (n > 0 && n <= 1) || 'must be within (0, 1]'))
      .toThrow(/--top-p must be within \(0, 1\], got: 0/);
  });
});

describe('applyOverrides', () => {
  // Pure settings hydration extracted from runIngest. Mutates settings in
  // place plus writes a patched row into GRANULARITY_CONFIG. The latter is
  // a shared `export const` and therefore a process-wide side effect, but
  // the test scope is one row per call and the table is rebuilt by the
  // next test's setup if needed.

  const baseSettings = () => ({
    provider: 'anthropic',
    model: 'claude-opus-4-8',
    baseUrl: '',
    disableThinking: false,
    samplingSeed: 0,
    extractionTemperature: 0,
    extractionTopP: 0,
    extractionGranularity: 'standard',
    maxTokensPerCall: 0,
  } as unknown as Parameters<typeof applyOverrides>[0]);

  // GRANULARITY_CONFIG is a shared `export const` with no reset function, so
  // snapshot every row and restore all of them in afterEach — not just
  // `standard`, or a test that patches a different row (or shadows an
  // inherited prototype key) would leak its mutation into every later test
  // in this worker.
  const ORIGINAL_ROWS = Object.fromEntries(
    Object.entries(GRANULARITY_CONFIG).map(([name, row]) => [name, { ...row }]),
  ) as Record<string, typeof GRANULARITY_CONFIG[keyof typeof GRANULARITY_CONFIG]>;

  afterEach(() => {
    for (const [name, row] of Object.entries(ORIGINAL_ROWS)) {
      (GRANULARITY_CONFIG as Record<string, typeof GRANULARITY_CONFIG[keyof typeof GRANULARITY_CONFIG]>)[name] = row;
    }
    // Drop own keys that were not in the original table — a prototype-key
    // attempt (`constructor`, `toString`) would have shadowed one via an own
    // property; delete it back.
    for (const name of Object.keys(GRANULARITY_CONFIG)) {
      if (!(name in ORIGINAL_ROWS)) {
        delete (GRANULARITY_CONFIG as Record<string, unknown>)[name];
      }
    }
  });

  it('applies direct settings fields when present', () => {
    const s = baseSettings();
    applyOverrides(s, {
      seed: 42,
      granularity: 'coarse',
      temperature: 0.7,
      topP: 0.9,
      model: 'claude-sonnet-4-5',
      maxTokensPerCall: 16000,
    } as Parameters<typeof applyOverrides>[1]);
    expect(s.samplingSeed).toBe(42);
    expect(s.extractionGranularity).toBe('coarse');
    expect(s.extractionTemperature).toBe(0.7);
    expect(s.extractionTopP).toBe(0.9);
    expect(s.model).toBe('claude-sonnet-4-5');
    expect(s.maxTokensPerCall).toBe(16000);
  });

  it('delegates thinkingMode to applyThinkingMode (the three-state enum)', () => {
    const s = baseSettings();
    applyOverrides(s, { thinkingMode: 'plugin-off' } as Parameters<typeof applyOverrides>[1]);
    expect(s.disableThinking).toBe(true);
  });

  it('patches GRANULARITY_CONFIG when batchSize/roundBase are present', () => {
    const s = baseSettings();
    applyOverrides(s, {
      batchSize: 7,
      roundBase: 4,
    } as Parameters<typeof applyOverrides>[1]);
    expect(GRANULARITY_CONFIG.standard.initialBatchSize).toBe(7);
    expect(GRANULARITY_CONFIG.standard.maxBatchesBase).toBe(4);
  });

  it('rejects prototype keys from settings granularity', () => {
    // The CLI's --granularity flag path guards against prototype keys, but the
    // name here comes from data.json (settings.extractionGranularity), which
    // bypasses parseCliOptions. A bare GRANULARITY_CONFIG[name] lookup would
    // accept 'constructor'/'__proto__' (inherited, truthy) and shadow the
    // shared table. applyOverrides must apply the same hasOwnProperty guard.
    for (const bad of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const s = baseSettings();
      (s as { extractionGranularity: string }).extractionGranularity = bad;
      expect(() => applyOverrides(s, { batchSize: 7 } as Parameters<typeof applyOverrides>[1]))
        .toThrow(/Unknown granularity in settings/);
    }
  });

  it('leaves untouched fields alone', () => {
    const s = baseSettings();
    const before = { ...s };
    applyOverrides(s, {} as Parameters<typeof applyOverrides>[1]);
    expect(s.samplingSeed).toBe(before.samplingSeed);
    expect(s.model).toBe(before.model);
    expect(s.disableThinking).toBe(before.disableThinking);
  });
});
