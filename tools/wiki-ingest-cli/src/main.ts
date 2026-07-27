// Runs the plugin's real WikiEngine.ingestSource against a vault on disk,
// with no Obsidian and no display. Everything Obsidian-specific comes from
// the shim modules next to this file; the engine, the analyzer, the page
// factory, the schema manager and the LLM client are the production ones.

import { parseArgs } from 'node:util';
import { readFileSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import { normalizePath, TFile, type App } from 'obsidian';

import { WikiEngine } from '../../../obsidian-llm-wiki/src/wiki/wiki-engine';
import { SchemaManager } from '../../../obsidian-llm-wiki/src/schema/schema-manager';
import { createLLMClient } from '../../../obsidian-llm-wiki/src/core/create-plugin-llm-client';
import { preloadLLMClientModules } from '../../../obsidian-llm-wiki/src/llm-sdk/create-llm-client';
import { applySettingsMigrations } from '../../../obsidian-llm-wiki/src/core/settings-migrations';
import { allowsEmptyApiKey } from '../../../obsidian-llm-wiki/src/core/local-no-key-provider';
import type { IngestReport, LLMClient, LLMWikiSettings } from '../../../obsidian-llm-wiki/src/types';

import { createVaultApp, type VaultWriteRecord } from './vault';
import { installObsidianGlobals } from './node-globals';

const PLUGIN_ID = 'karpathywiki';
const API_KEY_ENV = 'WIKI_API_KEY';

const USAGE = `Usage:
  node plugin-dev/wiki-ingest-cli/run-ingest.mjs --vault <path> --source <path-in-vault> [--dry-run] [--force]

  --vault    Path to the Obsidian vault. Required.
  --source   Source file path relative to the vault. Required.
  --dry-run  Run the full ingest but keep every write in memory.
  --force    Ignore the duplicate-content gate and re-ingest anyway.

Environment:
  ${API_KEY_ENV}  Provider API key. Obsidian keeps it in the system keychain,
                which Node cannot read, so it must be supplied here.`;

interface CliOptions {
  vault: string;
  source: string;
  dryRun: boolean;
  force: boolean;
}

interface LLMUsageTotals {
  calls: number;
  extractionRounds: number;
  inputTokens: number;
  outputTokens: number;
}

function parseCliOptions(argv: string[]): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      vault: { type: 'string' },
      source: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }
  if (!values.vault) throw new Error(`--vault is required.\n\n${USAGE}`);
  if (!values.source) throw new Error(`--source is required.\n\n${USAGE}`);

  return {
    vault: nodePath.resolve(values.vault),
    source: values.source,
    dryRun: values['dry-run'] === true,
    force: values.force === true,
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
  if (!report) {
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

export async function main(argv: string[]): Promise<void> {
  const options = parseCliOptions(argv);
  installObsidianGlobals();

  if (!statSync(options.vault).isDirectory()) {
    throw new Error(`--vault is not a directory: ${options.vault}`);
  }

  const settings = loadSettings(options.vault);
  settings.apiKey = resolveApiKey(settings);

  const app = createVaultApp(options.vault, options.dryRun);
  const sourceFile = resolveSourceFile(app, options.source);

  await preloadLLMClientModules();
  const totals: LLMUsageTotals = { calls: 0, extractionRounds: 0, inputTokens: 0, outputTokens: 0 };
  const client = withUsageAccounting(createLLMClient(settings), totals);
  const getClient = (): LLMClient => client;

  const engineApp: App = app;
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
  console.log(`[cli] dry-run=${options.dryRun} force=${options.force}`);

  const startedAt = Date.now();
  try {
    await engine.ingestSource(sourceFile, {
      interactive: false,
      ...(options.force ? { forceReingest: true } : {}),
    });
  } finally {
    printSummary(options, report, totals, app.vault.writes, Date.now() - startedAt);
  }
}
