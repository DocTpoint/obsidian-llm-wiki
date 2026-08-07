# LLM Wiki Plugin Roadmap

> Feature planning and improvement proposals

**Version:** v1.26.0 MINOR RELEASED 2026-08-06 (tag `1.26.0`). v1.26.x PATCH track active; v1.27.0 MINOR in design. v1.25.11 PATCH RELEASED. | **Updated:** 2026-08-07

## Current Status

**v1.26.0 MINOR SHIPPED 2026-08-06** (tag `1.26.0`). See [CHANGELOG.md v1.26.0 entry](./CHANGELOG.md#1260---2026-08-05) for the full release composition (117 commits / 110 files / +10,604 / −994 since v1.25.11, 2928 tests / 213 files passing). ROADMAP only carries **forward-looking planning** (current PATCH + next MINOR + research track); historical composition lives in CHANGELOG.

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

## v1.26.x PATCH follow-up track (target v1.26.1)

**Full ROI-ranked work list** lives in `~/.claude/projects/-Users-greener-project-obsidian-llm-wiki/memory/project_v1_26_x_patch_scope.md` — **READ FIRST on resume for PATCH work.** Contains: items 1-11 ranked top-to-bottom, "already merged in v1.26.x PATCH" table (PR #405 #408), "currently OPEN with v1.26.x PATCH milestone" table (#403 #407 #414 #398), "out of v1.26.1 scope" rationale, 3 open design questions to DocTpoint.

**Minimum recommended v1.26.1 ship** (3 short PRs, ~1 PR-equivalent effort): item 1 (#403 3-line cap fix) + item 2 (CR-1 dedup halving 2-line fix) + item 3 (PR #409 test additions). All three are well-defined; items 4-11 are design-track deferrals.

## After v1.26.0: v1.27.0 MINOR design track

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

