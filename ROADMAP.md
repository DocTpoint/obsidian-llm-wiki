# LLM Wiki Plugin Roadmap

> Feature planning and improvement proposals

**Version:** v1.26.1 PATCH RELEASED 2026-08-08 (tag `1.26.1`). v1.27.0 MINOR in design. v1.26.0 MINOR RELEASED 2026-08-06. | **Updated:** 2026-08-08

## Current Status

**v1.26.1 PATCH SHIPPED 2026-08-08** (tag `1.26.1`). 21 PRs since v1.26.0: high-ROI bug fixes (#399 / #403 / #408 / #419 / #424 / #435 + CR-1 dedup halving + #398 silent-save), #407 Stage 0 parse-failure naming, per-step LLM timing (PR #409), 24 Dependabot alerts closed, plus H1 hardening and `--seed` / `thinking` doc corrections. See [CHANGELOG.md v1.26.1 entry](./CHANGELOG.md#1261---2026-08-08) for the full composition. ROADMAP only carries **forward-looking planning** (next MINOR + research track); historical composition lives in CHANGELOG.

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

**Remaining follow-ups (moved to v1.27.0 window):**
- **#407 Stages 1+2** — port the 8 silent-failure call sites (`path-resolution.ts:220` + `conversation-ingest.ts:337` first), one PR per blast radius.
- **#414** — `repetitionPenalty` → `repeat_penalty` per-backend spelling transform (LM Studio measured; DeepSeek / Kimi / GLM / Ollama / vLLM gap).
- **#438** — frontmatter writer data-loss (awaiting vaclavdobsicek's PR; two defects split into A cosmetic / B data-loss).

**Bedrock Stage 2 — SSO/Profile auth (decision 2026-08-07; cancels the prior "≥3 user requests" gate).** Now scoped to **v1.27.0** via a **zero-AWS-SDK** path: hand-rolled IAM Identity Center OIDC (reusing the Codex OAuth skeleton at `src/llm-sdk/openai-codex/`) → `GetRoleCredentials` → temp IAM creds → **hand-written SigV4** → existing `bedrock-mantle` endpoint. ~+10 KB, zero new npm deps (vs the rejected PR #263's +1.2 MB). Rationale: the `bedrock-mantle` endpoint accepts AWS credentials (SigV4) per AWS docs and speaks standard OpenAI/Anthropic protocols over plain SSE — no native ConverseStream event-stream signing needed. Design plan + implementation checklist: [[project_bedrock_stage2_codex_style_sigv4]].

## v1.27.0 MINOR design track

Items NOT in v1.26.0 P0+P1 scope but in #358 design orbit (target v1.27.0 MINOR):

| Item | Issue | Note |
|---|---|---|
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
- External LLM-wiki CLI (sibling project) — depends on stable mutation interface
- Multi-vault isolation (#142) — long-term
- Explicit event type (#112) — long-term
- Scheduled ingest (#295) — conflicts with v1.26.0 external orchestration philosophy
- Obsidian Bases for index (#184) — post-PPR integration
- Slug-list prompt-share (#306) — DocTpoint self-corrected hypothesis (Pearson r = +0.008), pure perf savings, no quality fix needed
- Lint details in user README — partial completion via Advanced settings UI; full section TBD
- OS-async observation window policy — formalize SecretStorage 5-version stabilization pattern

