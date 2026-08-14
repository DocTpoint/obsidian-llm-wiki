# LLM Wiki Plugin Roadmap

> Feature planning and improvement proposals

**Version:** v1.26.3 PATCH ready-to-tag (5/5 PRs merged: #447/#448/#453/#450/#454 on `main`; release workflow pending — Step 1 Gate 1 + Step 3 version bump + Step 6b.5 Obsidian Bot pre-review + Step 6c publish). v1.27.0 MINOR in design. v1.26.2 PATCH RELEASED 2026-08-09 (tag `1.26.2`). v1.26.1 PATCH RELEASED 2026-08-08. | **Updated:** 2026-08-14

## Current Status

**v1.26.3 PATCH ready-to-tag 2026-08-14 (release workflow pending):**

1. **PR #447** — Issue #443 fix: 3-tier output-mode state machine + Path 2 fix (`NoObjectGeneratedError` catch) + Phase B (11 caller migrations to typed output) + per-model placeholder demotion.
2. **PR #448 (`fix/ux-b1-b2-b3-provider-statusbar-dedup`)** — 5 UX fixes from the maintainer's 2026-08-12 vault E2E: B1 (Fetch Models misclassified auth failures as Network), B2 (status-bar cancel label), B3 (lint dedup cross-type filter), B2.5 (full status-bar i18n), Toast i18n.
3. **PR #453** — Issue #414 `repetitionPenalty` per-backend dialect dispatch (`lmstudio`/`ollama` → `repeat_penalty`; `kimi`/`openrouter`/`custom` → `repetition_penalty`; `anthropic`/`deepseek`/`gemini`/`minimax`/`glm` → dropped).
4. **PR #450** — Issue #438 frontmatter writer data-loss (`sources:` emptied by `enforceFrontmatterConstraints`); Finding 1 fixed in `2560ab4` (filter empty `preservedSources` entries), Finding 2 (`extractPassthroughLines` whole-class passthrough) tracked as new follow-up issue for v1.27.0 window.
5. **PR #454** — Issue #443 follow-up: A1 placeholder detector widened to `{"": {}}`/`{"": []}` empty-object/array variants (user E2E 2026-08-13 on qwen3.5-9b) + repetitionPenalty UX hint (localized, gated to wire-supporting providers via `core/repetition-penalty-dialect.ts`).

**All 5 PRs merged** on `main` (HEAD `b14929ef`). DocTpoint re-review APPROVED on #450 @2560ab4 (2026-08-13 16:16 UTC) + #454 @8512001 (2026-08-13 16:37 UTC). Release workflow: obsidian-plugin-release skill Step 1 Gate 1 → Step 3 version bump + docs → Step 4 pre-release-gate + doc-review → 🛑 HARD STOP ① → Step 5 commit/push/PR/merge → Step 6a wait for CI draft → Step 6b.5 **HARD STOP ②' Obsidian Bot pre-review** (mandated by release-skill v1.7.0 after PR #442 lesson) → Step 6b release notes → 🛑 HARD STOP ② → Step 6c publish.

**v1.26.2 PATCH SHIPPED 2026-08-09** Surgical fix for v1.26.1's pre-submission blind spot: the Obsidian review bot scans the whole repo `.ts` tree but local `pnpm lint` was `src/`-only, so v1.26.1 shipped a blocking `unsafe-call` Error in `tools/llm-wiki-cli/src/obsidian.ts` that local lint never saw. PR #442 fixes the Error + 8 type-safety warnings, adds `Platform.isDesktop` AST guards on the runtime-loaded `node:*` imports, and ships `pnpm lint:tools-bot` so the local blind spot stays closed. The **end-state** for the CLI Bot-blind-spot problem is the v1.27.0 [CLI repo split](#v1270-minor-design-track) — `tools/llm-wiki-cli/` is a temporary in-tree location, scheduled to move to a standalone sibling repo ([`green-dalii/obsidian-llm-wiki-cli`](https://github.com/green-dalii/obsidian-llm-wiki-cli), see [SPEC.md](https://github.com/green-dalii/obsidian-llm-wiki-cli/blob/main/SPEC.md)) where the Bot never scans it. Release skill v1.7.0 now mandates an Obsidian Bot pre-review (Step 6b.5, HARD STOP ②) — see [CHANGELOG.md v1.26.2 entry](./CHANGELOG.md#1262---2026-08-09).

**v1.26.1 PATCH SHIPPED 2026-08-08** (tag `1.26.1`). 21 PRs since v1.26.0: high-ROI bug fixes (#399 / #403 / #408 / #419 / #424 / #435 + CR-1 dedup halving + #398 silent-save), #407 Stage 0 parse-failure naming, per-step LLM timing (PR #409), 24 Dependabot alerts closed, plus H1 hardening and `--seed` / `thinking` doc corrections. See [CHANGELOG.md v1.26.1 entry](./CHANGELOG.md#1261---2026-08-08).

**v1.26.3 PATCH in development (2026-08-10).** PR #444 merged (Stage 1 of #407). PR #447 expanding to close Issue #443 properly:

- **#443** — openai-compat JSON output architecture. **Direction change 2026-08-10**: from "elegant 2-tier fallback (json_object → no-field)" to **3-tier output-mode state machine** (json_schema → json_object → text+prompt). User's LM Studio 0.4.20 E2E (2026-08-10) showed the 2-tier design fixes the 400 but leaves downstream parse failures (model emits unclosed arrays when not constrained). First-principles: `json_schema` is the strongest mode and is accepted by LM Studio / Ollama / OpenAI / Anthropic / Gemini / xAI / Qwen / Kimi — we were degrading *down* to json_object by default and probing for further demotion, which inverts the right order.

  **Phase A ships on this PATCH (no caller changes):** `OutputModeProber` (3-tier per-baseURL state, ordered promotion); `buildOutputArgs` accepts `OutputMode` and emits `Output.object` / `Output.json` / `{}`; catch block rewires to retry one tier weaker on 400 with structured-output-related rejection; new `json-prompt-prefix.ts` (the Plan A prefix moves from temporary hack to Tier 1/2 permanent companion); delete `json-object-strip-probe.ts`; debug logs preserved (`[OUTPUT-MODE-DEBUG]`). 16 callers unchanged. + simplify-round fixes (shared REJECTION_VERBS, hoisted Output.json, deleted dead `promote()`, deduplicated comment header).

  **Path 2 fix ships on this PATCH (DONE — commits `9789cbf` + `75af84f`):** DocTpoint CHANGES_REQUESTED (2026-08-10) revealed `Output.json().parseCompleteOutput` throws `NoObjectGeneratedError` on malformed text — same as `Output.object()`. With Phase A default mode=`json_schema` + all 16 callers passing `{type:'json_object'}` (no schema), `buildOutputArgs` falls through to `Output.json()`, SDK parses eagerly, throws on malformed text, **no caller catches `NoObjectGeneratedError`** → repair path dead on cloud cohort. Path 2 fix: catch `NoObjectGeneratedError` in `OpenAICompatSdkClient.createMessage`, return `err.text` so caller-side `parseJsonResponse` + greedy regex + LLM repair runs. Also fixes the misleading comment in `output-args.ts` claiming `Output.json()` "only warns" (it does throw on ai@6.0.230). 4 regression tests use the real `NoObjectGeneratedError` class.

  **Phase B ALSO ships on this PATCH (DONE — commits `f8d5b18` → `6bc4b7c`)** (user direction 2026-08-10 — was wrongly deferred to v1.27.0 earlier in the session). Adds `LLMClient.createMessageWithOutput` (optional method, backward-compat) returning `{text, output?, outputMode, finishReason, usage?}`; `src/llm-sdk/output-schemas.ts` (6 Zod schemas); `buildOutputArgs` accepts Zod via `zodSchema()`; `wrapWithAdvancedSettings` wraps the typed method (task accounting + sampling injection). The 6 low-complexity P0 callers (seed-selector / query-keywords / merge-triage / link-orphan / fix-dead-link / QueryView `evaluateWithLLM`) opt in: pass Zod schema via `response_format.schema`, prefer `result.output` over `parseJsonResponse(text)`. Per CLAUDE.md "one PR per call site" rule, each caller migration ships as a separate commit. **Query streaming path verified untouched** (answer output carries no response_format; only the JSON Suggest-Save call was migrated).

  **v1.26.3 PATCH EXPANDED SCOPE (DONE — commits `eb86588` → `37cf271`)** (user direction 2026-08-11 — reverses the prior "defer 10+ callers to v1.27.0" decision after LMStudio E2E showed Tier 2 demotion leads to model-emits-malformed-JSON → parse failure → ingest fails). 12 additional commits land 11 caller migrations + 9 Zod schemas: source-analyzer extract + extract-retry + lemma-classify; conversation-ingest extraction + save-dedup; dedup-phase; schema-manager; path-resolution; fix-runners alias-generate + tag-fix; localize-welcome-note. The expanded-scope commits all use `.passthrough()` schemas with widened types per the user's "针对格式内容多变的属性，必须留好冗余空间" requirement. The 10 free-text markdown callers (entity/concept/summary page bodies, contradiction fixes, etc.) stay on `createMessage` + `cleanMarkdownResponse` — Path 2 fix (`NoObjectGeneratedError` catch) protects them. 5 new `task` labels added (`lint-dedup`, `schema-suggest`, `lint-alias`, `lint-tag-fix`, `welcome-translate`) so per-step LLM timing is no longer recorded as 'untagged'. The pre-PR scope read "defer to v1.27.0" was wrong.

  **Status:** all 22 commits (Path 2 fix + Phase B + expanded scope) committed locally on `fix/443-pilot-json-schema-path-resolution`, 3156 tests green, Gate 1 clean. **Pending user E2E on a `build:dev` handoff before push / PR update / DocTpoint review reply.**

  Design plan: [[project_v1_26_3_three_tier_output_mode]].
- **#306** — `buildCompactSlugList` injects 67K chars (~77 %) of full vault slug list into Ingest extraction prompt. DocTpoint's 2026-08-08 measurement rejected the v1.26.0 PATCH-era `localKeywordMatch` design (34 % coverage ceiling) and the "K=30 is the lever" assumption. **Plan D accepted 2026-08-09:** dual-signal ingest context — source-analyzer entity extraction + 1-hop graph diffusion, reusing the same `scorePagesByNeedles` primitive as Query's Stage 1.5b but with 1-hop diffusion (vs Query's full PPR — overkill on rich source-note signal). Estimated 80-95 % recall, 4-5K chars prompt (~5-7 % of current 67K). Awaiting DocTpoint's two measurements (entity-stage recall, 1-hop diffusion marginal gain) on his 30-notes fixture before implementation. Design plan: [[project_ingest_context_dual_signal_plan_d]].

**#91 parked** (DocTpoint self-correction 2026-08-08: 99.8 % prompt-hint compliance on tag nesting + 4 read sites are all write-carry-display, no retrieval — read-end disambiguation is the better target; new issue to be opened separately).

**v1.26.0 P0+P1 final scope** (executed 2026-08-02 → 2026-08-05; all MERGED via PRs #401 / #406 / #410 / #411):

| Bucket | Issue | Status | Note |
|---|---|---|---|
| Batch 1 dual-key bucketed dedup | #382 item 3 | ✅ MERGED (PR #401) | Plan: `~/.claude/projects/-Users-greener-project-obsidian-llm-wiki/memory/project_v1_26_0_batch_1_dedup_streaming.md` |
| Batch 2 cross-type dedup + retry/halving | #382 item 1 | ✅ MERGED (PR #410) | 979s → 365s e2e on 2141-page vault (retry/backoff only; halving dead code, see CR-1) |
| Batch 3 P1-1/P1-2 wire-or-delete | #382 item 4 | ✅ MERGED (PR #406) | Delete recommended; PR #406 deletes the dead-code helpers |
| Batch 4 dead-code-as-docs policy | #382 item 5 | ✅ DONE (governance) | CLAUDE.md + pre-release-gate Phase 2g |
| Batch 5 enum-as-section-value | #358 item 8 | ❌ CANCELLED (2026-08-04) | out of scope |
| Batch 6 real-wire force-disable thinking | DocTpoint #382 comment 2 | ✅ MERGED (PR #411) | 4-layer fallback; 365s → 151s on the 2141-page vault (post-fallout correction; see [[feedback_force_disable_thinking_dedup_wiring]]) |
| Batch 7 dedup parse-failure routing | DocTpoint #382 comment 1 | ✅ MERGED (PR #411) | `dedupFailures` discriminator; see [[feedback_dedup_phase_truncation_vs_empty_conflation]] |

**Full composition** (117 commits / 110 files / +10,604 / −994 since v1.25.11, 2928 tests passing) lives in [CHANGELOG.md v1.26.0 entry](./CHANGELOG.md#1260---2026-08-05) and on the merged commit history (`git log ab0ecfb..1.26.0` — released tag). Do not duplicate the commit list in this file.

**Deferred to v1.27.0+** (per user decision 2026-08-02): #317, #326.

## Process notes (process standards live in CLAUDE.md)

See [CLAUDE.md §"🛡️ Six-Gate Quality Closure"](./CLAUDE.md) for Gate definitions, [[feedback_pr_merge_workflow]] for the per-PR workflow, and [[feedback_pr_merge_credit_preservation]] for the `gh pr update-branch --rebase` rule on contributor rebases. Do not duplicate process standards in this file.

## v1.26.0 release flow (after Batches 1-7 ship)

See [CLAUDE.md §"📦 Development Workflow"](./CLAUDE.md) + [`.claude/skills/obsidian-plugin-release/SKILL.md`](/Users/greener/.claude/skills/obsidian-plugin-release/SKILL.md) for the full 8-step release flow. The pre-release-gate + doc-review parallel run is in [`.claude/skills/pre-release-gate/SKILL.md`](/Users/greener/.claude/skills/pre-release-gate/SKILL.md) + [`.claude/skills/doc-review/SKILL.md`](/Users/greener/.claude/skills/doc-review/SKILL.md). ROADMAP does not duplicate the per-step checklist — only the items that are **planning decisions** (which version, which milestone, which item lands where) live here.

## v1.26.x PATCH follow-up track (CLOSED — v1.26.1 shipped 2026-08-08)

**v1.26.1 shipped with 21 PRs.** All v1.26.x PATCH items (1-14) landed: #403 caps, CR-1 halving, #419/#435 H1, #424 yaml devDep, #398 silent-save, #407 Stage 0, #423 seed, items 13/14, #439 deps, #409 timing. Full composition in [CHANGELOG.md v1.26.1 entry](./CHANGELOG.md#1261---2026-08-08).

**Shipped in v1.26.3 PATCH (canonical record in [CHANGELOG.md §1.26.3](./CHANGELOG.md#1263---2026-08-12)):** 5 PRs — #447 (Issue #443, JSON-schema wire + 11 caller migrations) + #448 (B1-B3 UX + B2.5 i18n + Toast i18n) + #453 (Issue #414 `repetitionPenalty` dialect dispatch) + #450 (Issue #438 `sources:` frontmatter data-loss, Finding 1 fixed in `2560ab4`, Finding 2 tracked as follow-up issue for v1.27.0 window) + #454 (A1 placeholder detector widening + repetitionPenalty UX hint, gated via `core/repetition-penalty-dialect.ts`). All 5 PRs merged on `main` (HEAD `b14929ef`, 2026-08-14). Test count growth: 2992 → 3305 (+313).

**Remaining follow-ups (moved to v1.27.0 window):**
- **#407 Stages 1+2** — port the 8 silent-failure call sites (`path-resolution.ts:220` + `conversation-ingest.ts:337` first), one PR per blast radius.
- **#451** — `wrapWithAdvancedSettings` `createMessageStream` settings-injection bug. `Object.create(client)` prototype inheritance bypasses settings injection on the stream path (Query Wiki, streaming UI). Affects temperature / top_p / seed / repetitionPenalty / enableThinking.
- **#450 Finding 2** — `extractPassthroughLines` whole-class passthrough (separate commit on `fix/438-frontmatter-...`, filed as new issue to track).
- **#449 (Direction 1)** — `cacheBreakpoint` → Anthropic `cache_control: { type: 'ephemeral' }` wire-up (~15 LOC). Per-note caching only. Awaiting DocTpoint PR (Direction 2 = cross-note, gated on #452 catalog-sort stability).

**Bedrock Stage 2 — SSO/Profile auth (decision 2026-08-07; cancels the prior "≥3 user requests" gate).** Now scoped to **v1.27.0** via a **zero-AWS-SDK** path: hand-rolled IAM Identity Center OIDC (reusing the Codex OAuth skeleton at `src/llm-sdk/openai-codex/`) → `GetRoleCredentials` → temp IAM creds → **hand-written SigV4** → existing `bedrock-mantle` endpoint. ~+10 KB, zero new npm deps (vs the rejected PR #263's +1.2 MB). Rationale: the `bedrock-mantle` endpoint accepts AWS credentials (SigV4) per AWS docs and speaks standard OpenAI/Anthropic protocols over plain SSE — no native ConverseStream event-stream signing needed. Design plan + implementation checklist: [[project_bedrock_stage2_codex_style_sigv4]].

## v1.27.0 MINOR design track

Items NOT in v1.26.0 P0+P1 scope but in #358 design orbit (target v1.27.0 MINOR):

| Item | Issue | Note |
|---|---|---|
| **CLI repo split** — `tools/llm-wiki-cli/` → standalone sibling repo `green-dalii/obsidian-llm-wiki-cli` | (see SPEC v2.0) | 4-phase migration (Boot → Coexist → Deprecate → Demote). **Current state (2026-08-13):** sibling repo is at **v0.1.0-dev, NOT yet published to npm**; the in-tree `pnpm llm-wiki` is the **only** user-facing CLI install path until v1.27.0 ships the Coexist phase. Phase 1 (Boot) lands in v1.26.x PATCH window per [[project_v1_27_0_cli_split_planning]]; Phase 4 (Demote) at v1.28.0 keeps in-tree `tools/` as a **dev-only test harness** referencing `../../src/` — not a user-facing CLI after Demote. |
| Per-type registration via Settings（#328 Phase 2） | #358 item 1 | 强耦合 cross-type dedup；v1.26.0 完成 D 后即可 kickoff |
| User-extensible typed edges（frontmatter `relations:`） | #358 item 2 / #285 | 社区等待 |
| Bidirectional frontmatter（`derived_from` + `wiki_pages`） | #358 item 3 / #220 | source-revision awareness 是基础 |
| Identity ambiguity record | #358 item 4 / #330 §7 | 核心 invariant |
| Preview-Confirm gate | #358 item 6 / #330 §2 | 用户体验成本评估待讨论 |
| Stable mutation interface | #358 item 7 / #330 §8 | 外部 LLM-wiki CLI 兄弟项目前置 |

## v1.27.0+ research track (NOT committed)

- Computable schema (`rules.ts`) — depends on typed edges
- Query profile selector (4 modes) — depends on rules.ts
- Periodic consolidation pass — depends on ambiguity records accumulating
- Multi-vault isolation (#142) — long-term
- Explicit event type (#112) — long-term
- Scheduled ingest (#295) — conflicts with v1.26.0 external orchestration philosophy
- Obsidian Bases for index (#184) — post-PPR integration
- Slug-list prompt-share (#306) — DocTpoint self-corrected hypothesis (Pearson r = +0.008), pure perf savings, no quality fix needed
- Lint details in user README — partial completion via Advanced settings UI; full section TBD
- OS-async observation window policy — formalize SecretStorage 5-version stabilization pattern

