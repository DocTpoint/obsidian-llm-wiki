/**
 * v1.25.11 PATCH #169 — fine-grained stage labels for the status bar.
 *
 * The v3 plan moves the always-changing pipeline progress (e.g. "Analyzing
 * source", "Generating summary", "Detecting duplicates") from Notice popups
 * to the bottom-right status bar. The always-visible base label (e.g. the
 * localized "Ingesting… (click to cancel)" / "Linting… (click to cancel)" /
 * "Reading PDF: foo.pdf" string) stays put — these stage labels are
 * ADD-only emission sandwiched between the page name and the base label.
 *
 * Two pieces:
 *   1. `STAGE_KEYS` — the canonical ordered list of stage key names. Order
 *      matters for any breadcrumb / telemetry consumer; pin it here.
 *   2. `stageLabel(lang, key, ...vars)` — thin composition helper over
 *      `getText()` that runs sequential `replace('{}', v)` substitution,
 *      the same pattern every existing caller uses.
 *
 * Why this file is a separate module (vs. inline getText in wiki-engine):
 *   - It is the one place that pins the contract — any test that imports
 *     STAGE_KEYS can assert "every key exists in every locale" without
 *     having to know about the wiki-engine's progress plumbing.
 *   - It centralizes the `{}` substitution rule. If the rule ever changes
 *     (e.g. to named placeholders `{step}`), only this file changes.
 */

import { getText } from './i18n';
import { TEXTS } from '../texts';

/**
 * Canonical ordered list of fine-grained stage keys. Exported for tests
 * and (eventually) for any UI that wants to render stage breadcrumbs.
 *
 * v3 plan coverage: ingest (7) + PDF (3) + lint scan (4) = 14 keys.
 */
export const STAGE_KEYS = [
  // Ingest pipeline — mirrors the 7 stages that wiki-engine.ts drives
  // through `onProgress` (analyze, summary, entity, concept, retry, save,
  // index). See `wiki-engine.ts:830-1069` for the per-stage emit points.
  'ingestStageAnalyze',
  'ingestStageSummary',
  'ingestStageEntity',
  'ingestStageConcept',
  'ingestStageRetry',
  'ingestStageSave',
  'ingestStageIndex',
  // PDF ingest pipeline — reading the file, LLM-driven conversion, optional
  // sidecar write when `writePdfMarkdownToVault` is on.
  'pdfStageReading',
  'pdfStageConverting',
  'pdfStageSidecar',
  // Lint SCAN pipeline (NOT lint fix) — preparation, programmatic checks,
  // LLM dedup pass, contradiction pass. Lint fix-all uses `makeMirroredNotice`
  // (lint/fix-runners.ts:33) which is already a dual-channel Notice +
  // status-bar mirror; no new keys needed there.
  'lintStagePrep',
  'lintStageProgrammatic',
  'lintStageDedup',
  'lintStageContradiction',
] as const;

/** Read-only tuple element type. */
export type StageKey = (typeof STAGE_KEYS)[number];

/**
 * Compose a localized stage label with optional `{}` placeholders.
 *
 * Sequential substitution: `stageLabel('en', 'lintStageDedup', '3/10')`
 * runs the same `.replace('{}', v)` pattern every existing caller uses.
 * Extra `{}` occurrences are replaced by an empty string (a single `''`
 * variadic arg means "all placeholders collapse to empty"), and missing
 * args leave the `{}` literal in place so a regression shows up in the UI
 * immediately rather than silently truncating to the prefix text.
 *
 * `getText` already falls back to `TEXTS.en` for unknown locales, so this
 * helper does NOT need its own fallback logic.
 */
export function stageLabel(
  language: string,
  key: StageKey,
  ...vars: ReadonlyArray<string>
): string {
  // Defensive cast: STAGE_KEYS is the canonical list, so the key is a
  // member of TEXTS.en. getText() types its key off `keyof typeof TEXTS`,
  // which TS narrows correctly here without a cast.
  const text = getText(language, key as keyof typeof TEXTS.en);
  if (vars.length === 0) return text;
  // Sequential substitution: each variadic arg replaces the first
  // remaining '{}' literal. Matches the project's existing
  // `text.replace('{}', v)` pattern at the call sites.
  let result = text;
  for (const v of vars) {
    result = result.replace('{}', v);
  }
  return result;
}
