// Runs the plugin's real WikiEngine.ingestSource against a vault on disk,
// with no Obsidian and no display. Everything Obsidian-specific comes from
// the shim modules next to this file; the engine, the analyzer, the page
// factory, the schema manager and the LLM client are the production ones.

import { parseArgs } from 'node:util';
import { readFileSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import { normalizePath, TFile, type App } from 'obsidian';

import { WikiEngine } from '../../../src/wiki/wiki-engine';
import { SchemaManager } from '../../../src/schema/schema-manager';
import { createLLMClient } from '../../../src/core/create-plugin-llm-client';
import { preloadLLMClientModules } from '../../../src/llm-sdk/create-llm-client';
import { applySettingsMigrations } from '../../../src/core/settings-migrations';
import { allowsEmptyApiKey } from '../../../src/core/local-no-key-provider';
import { GRANULARITY_CONFIG } from '../../../src/core/batch-limits';
import type { ExtractionGranularity, IngestReport, LLMClient, LLMWikiSettings } from '../../../src/types';

import { createVaultApp, type VaultWriteRecord } from './vault';
import { installObsidianGlobals } from './node-globals';

const PLUGIN_ID = 'karpathywiki';
const API_KEY_ENV = 'WIKI_API_KEY';

const TOOL_USAGE = `Usage:
  llm-wiki <command> [flags]

Commands:
  ingest   Run the real ingest pipeline against a vault on disk.

Run \`llm-wiki <command> --help\` for command-specific flags.`;

const INGEST_USAGE = `Usage:
  node tools/llm-wiki-cli/run-llm-wiki.mjs ingest --vault <path> --source <path-in-vault> [flags]

  --vault         Path to the Obsidian vault. Required.
  --source        Source file path relative to the vault. Required.
  --dry-run       Run the full ingest but keep every write in memory.
  --force         Ignore the duplicate-content gate and re-ingest anyway.
  --extract-only  Stop after extraction; write no pages. Implies --dry-run.
  --seed          Fix the sampling seed, so two runs of the same source are
                  comparable. Without it the provider picks one per request.
                  Local servers honour it strictly. Anthropic has no such
                  parameter, and the openai provider drops it: that path builds
                  the Responses model, which reports seed unsupported and omits
                  it. Best-effort seed is a Chat Completions feature.
  --max-tokens-per-call  Cap max_tokens for every call. 0 removes the cap and
                  leaves whatever the call site asks for — for extraction that
                  is at least 16000, not "unlimited".
  --batch-size    How many items a round asks for. Comparing sizes through this
                  flag keeps every arm on one build, which a code edit between
                  arms does not. Under --granularity custom it survives unless
                  the per-type caps sum above 10, where the batch size is
                  derived from them instead; an unset cap counts as 5, so plain
                  --granularity custom sums to exactly 10 and this still applies.
  --max-rounds    Sets the granularity's round base, not the ceiling: the
                  ceiling is min(base * 3, ceil(source_chars / 2000) + 2), so 6
                  allows 18 — and on a short source the length term wins and
                  this changes nothing. Under --granularity custom the same
                  caps-above-10 rule can overwrite it.
  --model         Override the model, so two arms differ only by which one
                  answered. Otherwise every run takes the model from data.json.
  --temperature   Set the extraction sampling temperature. Unset, the server's
                  own preset applies — which differs per model, so comparing two
                  models without this compares their presets as well.
  --top-p         Set nucleus sampling. Pass it with --temperature: a preset is
                  the pair, and overriding one alone runs on half of each.
  --granularity   fine | standard | coarse | minimal | custom. Decides the batch
                  size, the item limit and the round ceiling together.
  --thinking      off declines reasoning, which is the only direction the
                  plugin can express. "on" asks for the server's own default.
                  Omitting the flag leaves whatever data.json says, which may
                  itself be "off" — so the three are not interchangeable.

Environment:
  ${API_KEY_ENV}  Provider API key. Obsidian keeps it in the system keychain,
                which Node cannot read, so it must be supplied here.`;

interface CliOptions {
  vault: string;
  source: string;
  dryRun: boolean;
  force: boolean;
  extractOnly: boolean;
  seed?: number;
  maxTokensPerCall?: number;
  batchSize?: number;
  maxRounds?: number;
  model?: string;
  temperature?: number;
  topP?: number;
  granularity?: string;
  thinking?: string;
  help: boolean;
}

interface LLMUsageTotals {
  calls: number;
  extractionRounds: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Subcommand dispatch. Pure function — no I/O, no logging, no side effects.
 *
 * Returning a tagged union rather than a string keeps `main()` honest: adding
 * a new command means adding a `case` here and the compiler will refuse to
 * forget it. The `unknown` case for flag-shaped first arguments is deliberate
 * — it catches `llm-wiki --vault /path` (user forgot `ingest`) and turns it
 * into a helpful error rather than letting parseArgs swallow it as ingest flags.
 */
export type Dispatch =
  | { kind: 'tool-help' }
  | { kind: 'ingest'; rest: string[] }
  | { kind: 'unknown'; command: string };

export function dispatchCli(argv: string[]): Dispatch {
  const [first] = argv;
  if (first === undefined || first === '--help' || first === '-h') return { kind: 'tool-help' };
  if (first === 'ingest') return { kind: 'ingest', rest: argv.slice(1) };
  return { kind: 'unknown', command: first };
}

// Sentinel stamped on Error instances whose message already carries the ingest
// USAGE block, so `withUsage` can detect and skip a second append instead of
// matching on message text (which would be brittle to future reformatting).
const HAS_INGEST_USAGE = Symbol('hasIngestUsage');

/**
 * Returns a copy of `error` whose message includes the ingest USAGE block,
 * idempotently. Validation errors thrown by `parseCliOptions` go through here
 * so the user sees the flag list right after the bad-input line; errors that
 * already include the block (because they were assembled with it inline) skip
 * the append.
 */
function withUsage(error: Error): Error {
  if ((error as Error & { [HAS_INGEST_USAGE]?: boolean })[HAS_INGEST_USAGE]) return error;
  const wrapped = new Error(`${error.message}\n\n${INGEST_USAGE}`);
  (wrapped as Error & { [HAS_INGEST_USAGE]?: boolean })[HAS_INGEST_USAGE] = true;
  return wrapped;
}

function parseInteger(raw: string, flagName: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    const err = new Error(`${flagName} must be an integer, got: ${raw}`);
    (err as Error & { [HAS_INGEST_USAGE]?: boolean })[HAS_INGEST_USAGE] = true;
    throw err;
  }
  return n;
}

function parsePositiveInteger(raw: string, flagName: string): number {
  const n = parseInteger(raw, flagName);
  if (n < 1) {
    const err = new Error(`${flagName} must be a positive integer, got: ${raw}`);
    (err as Error & { [HAS_INGEST_USAGE]?: boolean })[HAS_INGEST_USAGE] = true;
    throw err;
  }
  return n;
}

function parseNonNegativeNumber(raw: string, flagName: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    const err = new Error(`${flagName} must be a non-negative number, got: ${raw}`);
    (err as Error & { [HAS_INGEST_USAGE]?: boolean })[HAS_INGEST_USAGE] = true;
    throw err;
  }
  return n;
}

function parseProbability(raw: string, flagName: string): number {
  const n = parseNonNegativeNumber(raw, flagName);
  if (n === 0 || n > 1) {
    const err = new Error(`${flagName} must be within (0, 1], got: ${raw}`);
    (err as Error & { [HAS_INGEST_USAGE]?: boolean })[HAS_INGEST_USAGE] = true;
    throw err;
  }
  return n;
}

export function parseCliOptions(argv: string[]): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      vault: { type: 'string' },
      source: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      'extract-only': { type: 'boolean', default: false },
      seed: { type: 'string' },
      'max-tokens-per-call': { type: 'string' },
      'batch-size': { type: 'string' },
      'max-rounds': { type: 'string' },
      model: { type: 'string' },
      temperature: { type: 'string' },
      'top-p': { type: 'string' },
      granularity: { type: 'string' },
      thinking: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  const help = values.help === true;

  // `--help` short-circuits before the required-flag checks so a bare
  // `llm-wiki ingest --help` prints USAGE without demanding --vault/--source.
  if (help) {
    return {
      vault: '',
      source: '',
      dryRun: false,
      force: false,
      extractOnly: false,
      help: true,
    };
  }

  // Required-flag checks throw plain errors (no USAGE inline). They will be
  // wrapped by `withUsage` below before the caller surfaces them.
  if (!values.vault) throw withUsage(new Error('--vault is required.'));
  if (!values.source) throw withUsage(new Error('--source is required.'));

  const extractOnly = values['extract-only'] === true;

  // Wrap every numeric parse so a bad value surfaces as a single Error with
  // both the flag-specific message and the ingest USAGE block. The helpers
  // stamp HAS_INGEST_USAGE so the wrapping `withUsage` here is idempotent.
  let seed: number | undefined;
  if (values.seed !== undefined) seed = parseInteger(String(values.seed), '--seed');

  let maxTokensPerCall: number | undefined;
  if (values['max-tokens-per-call'] !== undefined) {
    maxTokensPerCall = parseNonNegativeNumber(String(values['max-tokens-per-call']), '--max-tokens-per-call');
  }

  let batchSize: number | undefined;
  if (values['batch-size'] !== undefined) batchSize = parsePositiveInteger(String(values['batch-size']), '--batch-size');

  let maxRounds: number | undefined;
  if (values['max-rounds'] !== undefined) maxRounds = parsePositiveInteger(String(values['max-rounds']), '--max-rounds');

  let temperature: number | undefined;
  if (values.temperature !== undefined) temperature = parseNonNegativeNumber(String(values.temperature), '--temperature');

  let topP: number | undefined;
  if (values['top-p'] !== undefined) topP = parseProbability(String(values['top-p']), '--top-p');

  let granularity: string | undefined;
  if (values.granularity !== undefined) {
    const g = String(values.granularity);
    if (!GRANULARITY_CONFIG[g]) {
      throw withUsage(new Error(`Unknown granularity: ${g}. Known: ${Object.keys(GRANULARITY_CONFIG).join(', ')}`));
    }
    granularity = g;
  }

  let thinking: string | undefined;
  if (values.thinking !== undefined) {
    const t = String(values.thinking);
    if (t !== 'on' && t !== 'off') {
      throw withUsage(new Error(`--thinking must be "on" or "off", got: ${t}`));
    }
    thinking = t;
  }

  let model: string | undefined;
  if (values.model !== undefined) {
    const m = String(values.model);
    if (!m.trim()) throw withUsage(new Error('--model must not be empty.'));
    model = m;
  }

  return {
    // Both are validated as present just above; `parseArgs` types every value
    // as string-or-boolean because a flag declared `string` can still appear
    // bare on the command line.
    vault: nodePath.resolve(String(values.vault)),
    source: String(values.source),
    // Extraction alone never writes, and a run that cannot write must not be
    // able to touch the vault by forgetting a second flag.
    dryRun: values['dry-run'] === true || extractOnly,
    force: values.force === true,
    extractOnly,
    ...(seed !== undefined ? { seed } : {}),
    ...(maxTokensPerCall !== undefined ? { maxTokensPerCall } : {}),
    ...(batchSize !== undefined ? { batchSize } : {}),
    ...(maxRounds !== undefined ? { maxRounds } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(topP !== undefined ? { topP } : {}),
    ...(granularity !== undefined ? { granularity } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
    help,
  };
}

function loadSettings(vaultRoot: string): LLMWikiSettings {
  const dataPath = nodePath.join(vaultRoot, '.obsidian', 'plugins', PLUGIN_ID, 'data.json');
  const raw = readFileSync(dataPath, 'utf8');
  const { settings } = applySettingsMigrations(JSON.parse(raw));
  return settings;
}

function resolveApiKey(settings: LLMWikiSettings): string {
  const fromEnv = (process.env[API_KEY_ENV] ?? '').trim();
  if (fromEnv) return fromEnv;
  if (allowsEmptyApiKey(settings.provider, '')) return '';
  throw new Error(
    `No API key available for provider "${settings.provider}". ` +
    `Obsidian stores it in the system keychain, which this CLI cannot read — ` +
    `export ${API_KEY_ENV} before running.`
  );
}

/**
 * Wraps the production client to total up token usage and to count how many
 * of the calls were source-extraction rounds. `cacheBreakpoint` is the marker:
 * SourceAnalyzer's batch call is the only call site in the plugin that sets it.
 */
function withUsageAccounting(client: LLMClient, totals: LLMUsageTotals): LLMClient {
  const accounting = Object.create(client) as LLMClient;
  accounting.createMessage = params => {
    totals.calls++;
    if (params.cacheBreakpoint !== undefined) totals.extractionRounds++;
    const callerOnFinish = params.onFinish;
    return client.createMessage({
      ...params,
      onFinish: meta => {
        totals.inputTokens += meta.usage?.inputTokens ?? 0;
        totals.outputTokens += meta.usage?.outputTokens ?? 0;
        callerOnFinish?.(meta);
      },
    });
  };
  return accounting;
}

function resolveSourceFile(app: ReturnType<typeof createVaultApp>, sourcePath: string): TFile {
  const path = normalizePath(sourcePath);
  const file = app.vault.getAbstractFileByPath(path);
  if (file instanceof TFile) return file;
  throw new Error(`Source not found in vault index: ${path}`);
}

function printWriteLog(writes: VaultWriteRecord[]): void {
  const pageWrites = writes.filter(write => write.action !== 'mkdir');
  if (pageWrites.length === 0) {
    console.log('  (no file writes)');
    return;
  }
  for (const write of pageWrites) {
    console.log(`  ${write.action.padEnd(6)} ${write.path}`);
  }
}

function printSummary(
  options: CliOptions,
  report: IngestReport | null,
  totals: LLMUsageTotals,
  writes: VaultWriteRecord[],
  elapsedMs: number,
): void {
  console.log('');
  console.log(options.dryRun ? '=== Dry run: writes that were withheld ===' : '=== Writes ===');
  printWriteLog(writes);

  console.log('');
  console.log('=== Summary ===');
  if (options.extractOnly) {
    console.log('  extract-only      page generation was skipped');
  } else if (!report) {
    console.log('  no ingest report was emitted (the engine returned before onDone)');
  } else {
    console.log(`  source            ${report.sourceFile}`);
    console.log(`  success           ${report.success}`);
    if (report.skipped) console.log(`  skipped           ${JSON.stringify(report.rejectedFiles ?? [])}`);
    if (report.errorMessage) console.log(`  error             ${report.errorMessage}`);
    console.log(`  new entity pages  ${report.entitiesCreated}`);
    console.log(`  new concept pages ${report.conceptsCreated}`);
    console.log(`  pages created     ${report.createdPages.length}`);
    console.log(`  pages updated     ${report.updatedPages.length}`);
    console.log(`  contradictions    ${report.contradictionsFound}`);
    console.log(`  failed items      ${report.failedItems.length}`);
  }
  console.log(`  extraction rounds ${totals.extractionRounds}`);
  console.log(`  llm calls         ${totals.calls}`);
  console.log(`  tokens in         ${totals.inputTokens}`);
  console.log(`  tokens out        ${totals.outputTokens}`);
  console.log(`  elapsed           ${(elapsedMs / 1000).toFixed(1)}s`);
}

async function runIngest(argv: string[]): Promise<void> {
  const options = parseCliOptions(argv);
  if (options.help) {
    console.log(INGEST_USAGE);
    return;
  }

  installObsidianGlobals();

  if (!statSync(options.vault).isDirectory()) {
    throw new Error(`--vault is not a directory: ${options.vault}`);
  }

  const settings = loadSettings(options.vault);
  settings.apiKey = resolveApiKey(settings);
  if (options.seed !== undefined) settings.samplingSeed = options.seed;
  if (options.thinking !== undefined) settings.disableThinking = options.thinking === 'off';
  if (options.granularity !== undefined) settings.extractionGranularity = options.granularity as ExtractionGranularity;

  // `--batch-size` and `--max-rounds` have no settings of their own: the numbers
  // live in the granularity table. Overriding them writes into that table, and
  // the table is a shared `export const` — the engine itself only ever reads a
  // copy of it (batch-limits.ts). Replacing the entry rather than mutating it
  // keeps the write local to this row, so nothing else in the process sees a
  // granularity that has been edited underneath it.
  const overrideGranularity = (patch: Partial<typeof GRANULARITY_CONFIG[string]>) => {
    const name = settings.extractionGranularity || 'standard';
    const config = GRANULARITY_CONFIG[name];
    if (!config) throw new Error(`Unknown granularity in settings: ${name}`);
    GRANULARITY_CONFIG[name] = { ...config, ...patch };
  };

  if (options.batchSize !== undefined) overrideGranularity({ initialBatchSize: options.batchSize });
  if (options.maxRounds !== undefined) overrideGranularity({ maxBatchesBase: options.maxRounds });
  if (options.temperature !== undefined) settings.extractionTemperature = options.temperature;
  if (options.topP !== undefined) settings.extractionTopP = options.topP;
  if (options.model !== undefined) settings.model = options.model;
  if (options.maxTokensPerCall !== undefined) settings.maxTokensPerCall = options.maxTokensPerCall;

  const app = createVaultApp(options.vault, options.dryRun);
  const sourceFile = resolveSourceFile(app, options.source);

  await preloadLLMClientModules();
  const totals: LLMUsageTotals = { calls: 0, extractionRounds: 0, inputTokens: 0, outputTokens: 0 };
  const client = withUsageAccounting(createLLMClient(settings), totals);
  const getClient = (): LLMClient => client;

  // The shim implements the surface the engine touches — vault, metadataCache,
  // fileManager — and nothing else. `App` also declares the workspace, the
  // keymap and six more members that only exist inside a running Obsidian, and
  // a headless run reaches none of them.
  const engineApp = app as unknown as App;
  const schemaManager = new SchemaManager(engineApp, settings, getClient);

  let report: IngestReport | null = null;
  const engine = new WikiEngine(
    engineApp,
    settings,
    getClient,
    schemaManager,
    path => console.log(`[write] ${path}`),
    message => console.log(`[progress] ${message}`),
    finished => { report = finished; },
    globalThis.crypto.subtle,
  );

  console.log(`[cli] vault=${options.vault}`);
  console.log(`[cli] source=${sourceFile.path}`);
  console.log(`[cli] provider=${settings.provider} model=${settings.model} baseUrl=${settings.baseUrl}`);
  // Every knob that decides how the model answers, printed once per run. A log
  // that does not say what it was configured with cannot be compared against
  // another log later, and two of this session's comparisons died on exactly
  // that — arms that turned out to differ by something no line recorded.
  console.log(`[cli] dry-run=${options.dryRun} force=${options.force}`
    + ` model=${settings.model} thinking=${settings.disableThinking ? 'off' : 'server default'}`
    + ` temp=${settings.extractionTemperature ?? 'server default'} top-p=${settings.extractionTopP ?? 'server default'}`
    + ` seed=${settings.samplingSeed ?? 'random'} max-tokens=${settings.maxTokensPerCall || 'uncapped'}`
    + ` batch=${options.batchSize ?? 'default'} max-rounds=${options.maxRounds ?? 'default'}`
    + ` granularity=${settings.extractionGranularity}`);

  const startedAt = Date.now();
  try {
    if (options.extractOnly) {
      await runExtractionOnly(engine, sourceFile);
    } else {
      await engine.ingestSource(sourceFile, {
        interactive: false,
        ...(options.force ? { forceReingest: true } : {}),
      });
    }
  } finally {
    printSummary(options, report, totals, app.vault.writes, Date.now() - startedAt);
  }
}

export async function main(argv: string[]): Promise<void> {
  const d = dispatchCli(argv);
  switch (d.kind) {
    case 'tool-help':
      console.log(TOOL_USAGE);
      return;
    case 'ingest':
      return runIngest(d.rest);
    case 'unknown': {
      // First arg is flag-shaped: the user almost certainly typed a flag at
      // the tool level and forgot `ingest`. Surface a hint rather than the
      // generic "unknown command" error.
      const hint = d.command.startsWith('-')
        ? `(did you forget \`ingest\`? try \`llm-wiki ingest ${argv.join(' ')}\`)`
        : '';
      throw new Error(`Unknown command: ${d.command}${hint ? ' ' + hint : ''}\n\n${TOOL_USAGE}`);
    }
  }
}

/**
 * Run the extraction loop and stop, skipping page generation.
 *
 * Page generation is one LLM call per page and dominates a full ingest — on a
 * 135K-character source, 3 extraction rounds against 226 page calls. Tuning the
 * extraction loop paid for all of that on every measurement.
 *
 * The analyzer is reached through the engine rather than constructed here so it
 * runs with the engine's own EngineContext — the same schema context, system
 * prompt and tag vocabulary a real ingest would use. Reproducing that context in
 * the CLI would make the measurement describe the CLI instead of the plugin.
 */
async function runExtractionOnly(engine: WikiEngine, sourceFile: TFile): Promise<void> {
  const analysis = await engine.runExtractionOnly(sourceFile);

  console.log('');
  console.log('=== Extraction ===');
  if (!analysis) {
    console.log('  the analyzer returned nothing (blank source, or round 1 was unusable)');
    return;
  }
  console.log(`  title             ${analysis.source_title}`);
  console.log(`  entities          ${analysis.entities.length}`);
  console.log(`  concepts          ${analysis.concepts.length}`);
  console.log(`  key points        ${analysis.key_points.length}`);
  console.log(`  contradictions    ${analysis.contradictions.length}`);
  console.log(`  entity names      ${analysis.entities.map(e => e.name).join(', ')}`);
  console.log(`  concept names     ${analysis.concepts.map(c => c.name).join(', ')}`);
}
