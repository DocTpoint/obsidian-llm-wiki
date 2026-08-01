// Parser-contract tests for the headless ingest CLI. They pin parse-time
// validation so a future flag change cannot silently regress error behaviour.
// Importing `main` pulls in the CLI shims (vault, node-globals) and the real
// production modules, but module scope only defines constants and functions —
// nothing runs until `main()` is called, so this import stays side-effect-free.

import nodePath from 'node:path';
import { describe, it, expect } from 'vitest';

import { parseCliOptions, dispatchCli } from '../../../../tools/llm-wiki-cli/src/main';

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
