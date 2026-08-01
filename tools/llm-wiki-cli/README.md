# llm-wiki-cli

Runs the obsidian-llm-wiki plugin's real ingest pipeline under plain Node —
no Obsidian, no Electron, no display — against a vault directory on disk.

The engine is not simulated. `WikiEngine`, `SourceAnalyzer`, `PageFactory`,
`SchemaManager` and the AI-SDK LLM clients are imported straight from
`../../obsidian-llm-wiki/src/`. Only the host is replaced: the `obsidian`
module and the vault it reads and writes.

## Running

```bash
WIKI_API_KEY=... node tools/llm-wiki-cli/run-llm-wiki.mjs \
  --vault /path/to/your/vault \
  --source "sources/Attention Is All You Need.md" \
  --dry-run
```

| Flag | Meaning |
|---|---|
| `--help` | Print the flag list and exit. |
| `--vault` | Vault root. Required, no default. |
| `--source` | Source file, relative to the vault. Required. |
| `--dry-run` | Run everything, keep every write in memory. |
| `--force` | Ignore the duplicate-content gate and re-ingest anyway. |
| `--extract-only` | Stop after extraction. Implies `--dry-run`, so a run that cannot write cannot touch the vault by forgetting a second flag. |
| `--model` | Override the model, so two arms differ by which one answered rather than by an edited `data.json`. |
| `--temperature` | Sampling temperature. Named for extraction because it comes from `extractionTemperature`, and it reaches more than extraction: the wrapper applies it to every `createMessage` that does not set its own, and the schema manager arrives at the same value by passing `extractionTemperature` itself. Unset, the server's own preset applies — and presets differ per model, so comparing two models without this compares their presets too. |
| `--top-p` | Nucleus sampling. Pass it with `--temperature`: a preset is the pair, and overriding one alone runs on half of each. |
| `--seed` | Fix the sampling seed. Local servers honour it strictly. Anthropic has no such parameter, and neither, in practice, does the `openai` provider: the plugin builds it through `createOpenAI()`, which returns the Responses model, and that model answers `{type:'unsupported', feature:'seed'}` and leaves it out of the body. The best-effort seed belongs to Chat Completions, which this path does not use. |
| `--thinking` | `off` declines reasoning, the only direction the plugin can express. `on` asks for the server's default; omitting the flag leaves `data.json`'s setting in force, which may itself be `off`. |
| `--granularity` | `fine` \| `standard` \| `coarse` \| `minimal` \| `custom`. Decides batch size, item limit and round ceiling together. |
| `--batch-size` | How many items a round asks for. Comparing sizes through this flag keeps every arm on one build, which editing the code between arms does not. Under `--granularity custom` it survives unless the per-type caps sum above 10, in which case `calculateBatchLimits` derives the batch size from them and overwrites it. Each unset cap counts as `MIN_BATCH_SIZE` (5), so a plain `--granularity custom` sums to exactly 10, the rule needs strictly more, and this flag still applies. |
| `--max-rounds` | Sets the granularity's round base, not the ceiling. The ceiling is `min(base × 3, ceil(source_chars / 2000) + 2)`, so `--max-rounds 6` allows 18 — and on a short source the length term wins and the flag changes nothing. Under `--granularity custom` the same caps-above-10 rule can overwrite it. |
| `--max-tokens-per-call` | Caps `max_tokens` for every call. `0` removes the cap, leaving whatever the call site asks for — for extraction that is at least `MAX_TOKENS_BATCH` (16000), not "unlimited". |

**Without `--dry-run` the CLI writes into the real vault.** It is the same
write path Obsidian uses, so pages, `index.md`, `log.md` and the schema file
are all created or updated for real.

The engine's `console.debug` output goes to stdout verbatim (colouring is
switched off so lines are byte-comparable with the Obsidian DevTools
console). `console.warn` / `console.error` go to stderr, as in DevTools.
`Notice` toasts are printed as `[Notice] …`, progress messages as
`[progress] …`, and every completed write as `[write] …`.

At the end the CLI prints the withheld/actual write list and a summary:
extraction rounds, total LLM calls, entities, concepts, pages created and
updated, input and output tokens, elapsed time.

## Environment

- **Node 24** (matches the plugin's `.nvmrc`; `crypto.subtle` and `fetch` are
  native).
- **`WIKI_API_KEY`** — the provider key. Obsidian migrated it into
  SecretStorage (the OS keychain) in v1.25.3, and Node cannot read that, so
  the key must be supplied through the environment. Missing key for a
  provider that requires one is a hard error, never a silent fallback. For a
  keyless local endpoint (llama.cpp, Ollama, LM Studio) any non-empty value
  works. The key is never logged and never written to a file.
- `obsidian-llm-wiki/node_modules` must be installed — the bundler and every
  AI-SDK dependency are resolved from there.
- Settings are read from `<vault>/.obsidian/plugins/karpathywiki/data.json`
  and passed through the plugin's own `applySettingsMigrations`.

## How it is wired

`run-llm-wiki.mjs` invokes esbuild (from the plugin's `node_modules`) to bundle
`src/main.ts` for Node, rewriting every `from 'obsidian'` import — in plugin
code and CLI code alike — to `src/obsidian.ts`. One shared module means one
shared `TFile` class, which is what makes the engine's `instanceof TFile`
checks work. The bundle lands in `.build/` and is then imported and run.

| File | Role |
|---|---|
| `run-llm-wiki.mjs` | Bundles and runs. The thing you invoke. |
| `src/obsidian.ts` | The `obsidian` module: `TFile`, `TFolder`, `normalizePath`, `Notice`, `Platform`, `requestUrl`. |
| `src/vault.ts` | `App` over the real filesystem: vault index, reads, writes, `DataAdapter`, `metadataCache`, `fileManager`. |
| `src/node-globals.ts` | `window`, `activeWindow`, uncoloured console. |
| `src/main.ts` | Argument parsing, settings, client wiring, summary. |

`requestUrl` is implemented over Node's `fetch` rather than bypassed. It has
to exist: for a local base URL (`localhost`, `127.0.0.1`, RFC-1918) the
plugin's `streamWithFallback` takes the `isLocalBaseURL` branch straight into
`obsidianFetchBridge`, which imports `requestUrl` from `obsidian` with no
native-fetch fallback of its own. Shimming it keeps the production client
factory (`createLLMClient` → `createLLMClientFromSettingsSync`) on its real
path; constructing `OpenAICompatSdkClient` directly with a custom `fetch`
would have skipped the factory and the advanced-settings wrapper.

Token totals come from a thin accounting wrapper around the client that
chains each call's `onFinish`. "Extraction rounds" counts calls carrying
`cacheBreakpoint`, which `SourceAnalyzer`'s batch call is the only site in
the plugin to set.

## What the shim does not reproduce

- **SecretStorage.** Not reachable from Node; the key comes from the
  environment instead. Anything that writes secrets back is unavailable.
- **Streaming.** Every request goes through `requestUrl`, which buffers the
  whole body. That matches what Obsidian does for a local base URL, but for a
  cloud provider Obsidian would use `window.fetch` and stream. Ingest only
  uses `createMessage`, so nothing on this path depends on it.
- **`metadataCache`.** Obsidian's cache is a full parse (links, headings,
  tags, embeds) kept live by a watcher. Here `getFileCache` returns only
  `frontmatter`, parsed on demand by the plugin's own `parseFrontmatter`.
  That is the entire surface the ingest path reads, but a future feature that
  wants `links` or `headings` will get `undefined`.
- **Vault events.** `vault.on` / `metadataCache.on` return an inert handle.
  The CLI runs one ingest and exits, so auto-watch never applies.
- **The file index is a snapshot.** It is built by one synchronous walk at
  startup and updated only by the engine's own writes; Obsidian keeps its own
  index live with a watcher. Do not edit the vault — or run an ingest inside
  Obsidian against it — while the CLI is running. A page that vanishes
  mid-run stays in the index and the next read of it fails the ingest with
  `ENOENT`.
- **`trashFile`** moves into `<vault>/.trash/`, ignoring the user's Obsidian
  "deleted files" preference (system trash / permanent).
- **UI classes** (`Modal`, `ItemView`, `Setting`, `PluginSettingTab`,
  `Plugin`, `FuzzySuggestModal`, `MarkdownRenderer`) throw on construction.
  Reaching them from the ingest path is a bug, and it will say so instead of
  quietly doing nothing. `activeDocument` is likewise left undefined.
- **`normalizePath`** is implemented for real (backslashes to slashes,
  collapsed runs, trimmed ends, NFC) rather than as the identity function the
  unit-test mock uses. It is a reimplementation, not Obsidian's own code, so
  exotic inputs may differ.
- **Confirmation prompts.** `onConfirmReingest` is never wired, so a
  duplicate is always auto-skipped; use `--force` to re-ingest.
- **PDF sources** should work (the converter's `adapter.readBinary` and disk
  cache are implemented) but have not been exercised.
