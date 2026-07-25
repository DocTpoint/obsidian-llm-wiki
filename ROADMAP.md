# LLM Wiki Plugin Roadmap

> Feature planning and improvement proposals

**Version:** 1.25.7 PATCH (RELEASED 2026-07-25). | **Updated:** 2026-07-25

## Current Status

**v1.25.7 — RELEASED 2026-07-25.** PATCH scope:
- **PR #344** (DocTpoint): cache-stable prompt layout — invariant list first + ctime ascending sort. Cold 54s → repeat 1.2s on Gemma-4-26B MoE LM Studio. 2805p field wall-clock 1836s → 784s (2.34×).
- **PR #345** (DocTpoint): slim dedup + top-K candidate pre-filter + 'index' schema selector. Field prompt tokens 660K → 372K (−44%). 8 recall fixtures pin 100% recall over canonical pairs.
- **PR #346** (self): API key switching bug fix (regression since v1.25.3 #182) — new `resolveInitialApiKey` helper + `pendingKey` parameter on `resolveProviderApiKey`; threaded through Fetch Models / Test Connection / `createLLMClient`. Codex Provider fully isolated. 11 new tests.
- 19 new tests since v1.25.6 (+12 from DocTpoint +7 from API key fix). **Bot 0/0 preserved.** 2566 tests / 192 files.

**v1.25.7 PATCH deferred items** (moved to v1.26.0 MINOR — out of PATCH scope to avoid over-inflation):
- **P0-1 fix-runners parallelization** — 5串行 fix phases → `Promise.allSettled` × concurrency (model: `runAliasCompletion`)
- **P1-1 analysis content-hash cache** — `.obsidian/plugins/karpathywiki/cache/lint-analysis.json`, LRU 50 entries
- **P1-2 smart-skip controller** — programmatic-empty + cache-double-hit → skip both LLM phases

Full archived plan: [[project_v1.25.7_lint_perf_plan]]. Out of scope (v1.26.0 MINOR): embedding/RAG Tier 2 预筛 — 🚫 **永久禁用** per [[feedback_no_rag_embedding_perf]].

## Next: v1.26.0 MINOR (after v1.25.7 ships)

Theme: Kimi Files API + non-routine PDF providers (PR4, AkaSakana contribution) + wiki-engine.ts decomposition (3rd-party audit P1, 2026-07-19) + #220 source-revision awareness Tier 0+1 + #328 Schema Phase 2/3 + DocTpoint open issues (#330/#312/#306 follow-up).

Historic compositions (v1.25.6 and earlier) live in [CHANGELOG.md](./CHANGELOG.md) — kept brief here.

---

## Version Timeline
| Version | Date | Headline |
|---------|------|----------|
| **1.25.7** | 2026-07-25 | PATCH: API key switching bug fix (regression since v1.25.3 #182, PR #346) + DocTpoint dedup perf PRs #344+#345. Cache-stable prompt layout (54s→1.2s repeat) + slim dedup + top-K candidate pre-filter (660K→372K prompt tokens, −44%). 19 new tests since v1.25.6. Bot 0/0 preserved. 2566 tests / 192 files |
| **1.25.6** | 2026-07-24 | PATCH: Eliminated 14 `@typescript-eslint/no-unsafe-*` Bot warnings via `createRequire(__filename)` over bare `require('node:http')`. **Bot 0/0 first time.** 2535 tests |
| **1.25.5** | 2026-07-24 | PATCH: P0 Bot compliance (Platform.isDesktop guard + getSettingDefinitions stub + eslint.config.mjs cleanup) — pathway toward 0/0 |
| **1.25.4** | 2026-07-24 | PATCH: SecretStorage Win10 regression (#339 fix) + fast-uri CVE bump |
| **1.25.3** | 2026-07-23 | feat(security): provider API key → Obsidian SecretStorage (#182). Closes #182 |
| **1.25.2** | 2026-07-22 | Schema Phase 1 (Option A bug-fix #328) + Codex OAuth + ESLint 0.4.1 Route A |
| **1.25.1** | 2026-07-20 | PATCH: silent Mentions loss on Related re-ingest fixed (#288 closes #287) + LLM rewrite drops schema sections prevented (#302 closes #292) + legacy pre-#244 Mentions shape healed on parse (#303 closes #289) + LM Studio no-key ingest (#272). Big-file splits: `wiki-engine.ts` 1799→1619 with 657 LOC of helpers into `engine-internals/` (Phase C-PR1), `settings.ts` 1439→370 with 1183 LOC across 8 settings-sections (Phase C-PR2), `main.ts` 1304→300 with 915 LOC across 6 main-commands via mixin pattern (Phase C-PR3). `DiskCache<T>` extracted with bounded growth + ledger optimization (Phase F). Node 24 + AI-SDK patches pinned via `.nvmrc` + `.npmrc` + dual-direction lockfile regen from single `node_modules` snapshot (Phase E). 11 commits, ~80 files, 2274 tests |
| 1.25.0 | 2026-07-18 | MINOR: cache-only PDF Ingest (Level 1) — three-defense-layer bounded cache (100MB / 1000 / 10MB + LRU-by-mtime) + provider gate (anthropic/openai/bedrock-* native, others via `forcePdfSupport` universal escape hatch) + content-hash cache key with `converterVersion` + two new settings (`forcePdfSupport`, `writePdfMarkdownToVault`) + verbatim OCR-style PDF prompt. 2182 tests |
| 1.24.1 | 2026-07-14 | PATCH: 5-stage PPR cascade (#281) + parseJsonResponse quiet path (#282, closes #255/#274) + redundant Basic Information removal (#283, closes #258) + Bedrock Stage 1 (#277) + LM Studio no-key (#269) + Tier C bypass (#271) + page-factory split (#276) + non-lossy Mentions re-ingest (#267). 2080 tests |
| 1.24.0 | 2026-07-10 | MINOR: per-task models (#208) + Custom Query Instructions (#251) + 4 monolith splits (#248/#249/#250/#257) + source-note aliases (#185) + frontmatter write repair + merge triage (#216) + PPR graph warmup. 1825 tests |
| 1.23.2 | 2026-07-05 | PATCH: #234/#221/#219 + DocTpoint #238/#241 + graph cache invalidation + Apache 2.0 + DCO. 1431 tests |
| 1.23.1 | 2026-07-02 | Obsidian review hotfix — strictBindCallApply alignment + dead function removal + lockfile regen |
| 1.23.0 | 2026-07-02 | Graph Engine PPR (Issue #198) + Vercel AI-SDK v6 migration + Sponsor section + v1.22.6 hotfix folded in |
| **1.22.6** | 2026-06-29 | Hotfix — #204 wire onAutoIngestDone + Auto Smart Fix trigger dispatch + #207 broaden Responses API to -pro variants |
| **1.22.5** | 2026-06-29 | Hotfix — Responses API path for reasoning model family (#207 follow-up) + provider body in Notice + withRetry on Responses path |
| **1.22.4** | 2026-06-27 | Hotfix — GPT-5.x probe-then-cache (Closes #207) + provider error UX + lint knobs centralisation |
| **1.22.3** | 2026-06-26 | Hotfix — language-agnostic log header + content-folder guard for `generation_complete` |
| **1.22.2** | 2026-06-26 | Hotfix — auto-ingest modal→Notice (#204) + log i18n + periodic lint refined |
| **1.22.1** | 2026-06-24 | Hotfix — fixDeadLink fabrication (#197) + startupCheck migration (#199) + CSS `:has()` + Query side panel (#196) + related-link corrector (#187) |
| **1.22.0** | 2026-06-23 | Schema one-click apply (#97) + dynamic tag sync + zh-Hant + ingest status bar (#189, @YounianC) |
| 1.21.1 | 2026-06-22 | Hotfix — #173 Symptom A NFC/NFD + esbuild 0.28.1 |
| 1.21.0 | 2026-06-21 | Pre-ingest gate (#164) + Schema Phase 1 (#124) + History Panel (#122) + Italian (#159) |
| 1.20.3 | 2026-06-20 | Hotfix — source-slug fingerprint (#155) + alias dedup (#154) + Stage-4 guard (#158) |
| 1.20.2 | 2026-06-19 | Anthropic fallback system-role hotfix (PR #151 by @Indexed-Apogrypha, Closes #141/#147) |
| 1.20.1 | 2026-06-18 | Anthropic prefill rejection hotfix (Closes #141/#147) |
| 1.20.0 | 2026-06-18 | Provider-first thinking control + reasoning UI (Closes #141/#134/#143) |
| 1.19.1 | 2026-06-17 | Gemini HTTP 400 hotfix (Closes #137) |
| 1.19.0 | 2026-06-16 | Ingest quality & cost hardening — advanced LLM params, quote grounding, compact slugs |
| 1.18.2 | 2026-06-12 | Custom extraction limits hard-enforced (Closes #120) + #114 tags preservation + #111 slug casing |
| 1.18.1 | 2026-06-11 | Obsidian review compliance (document ban + prefer-active-doc) |
| 1.18.0 | 2026-06-10 | Tag controlled vocabulary (Closes #85) v6/v7/v8 — chip input UX, end-to-end customTags pipeline |
| 1.17.0 | 2026-06-08 | Long-document ingestion + source attribution (Closes #90) |
| 1.16.3 | 2026-06-07 | v1.16.2 P0 hotfix completion |
| 1.16.2 | 2026-06-07 | Lint cancel + thinking token bleeding + delete empty stubs |
| 1.16.0 | 2026-06-04 | Sources normalization + Context Window + LMStudio |
| 1.15.0 | 2026-06-01 | PR #87/#88 + aliases unification |
| 1.13.0 | 2026-05-26 | ConflictResolver + 6 audited improvements |
| 1.12.0 | 2026-05-20 | Extraction rearchitected, ~80% faster |
| 1.10.0 | 2026-05-15 | Aliases + granularity expansion |
| 1.9.0 | 2026-05-10 | Pollution defense + 14-issue batch |
| 1.8.1 | 2026-05-05 | Rate limit + smart fix all + 53 tests |
| 1.0.0 | initial | First Obsidian release |

> **Out of scope for v1.26.0 MINOR:** Bedrock Stage 2 (bearer-only via `@ai-sdk/amazon-bedrock@^5`) — conditional on 3+ user issues for Claude Sonnet 4 / Llama 4 on Bedrock. Bedrock Stage 3 SSO — indefinite deferral.
