import { getText } from './i18n';

/**
 * v1.26.3 PATCH follow-up (user E2E 2026-08-13): a custom `repetitionPenalty`
 * above 1.0 was confirmed to break grammar-constrained extraction on small
 * local models (qwen3.5-9b / gemma-4-12b on LM Studio) — the model bails
 * with empty or mis-structured JSON and the ingest fails with a generic
 * "Source analysis failed" message that never mentioned the setting.
 *
 * Returns a localized hint (with a leading space, ready to append to an
 * existing failure message) when the user opted into a custom value, or ''
 * when they did not. The hint is deliberately tied to the setting being
 * PRESENT (any defined value, including 1.0) rather than to a specific
 * threshold — the actionable advice ("reduce or clear") lives in the i18n
 * key `repetitionPenaltyErrorHint`, not in code.
 */
export function buildRepetitionPenaltyHint(
  language: string,
  value: number | undefined,
): string {
  if (value === undefined) return '';
  return ' ' + getText(language, 'repetitionPenaltyErrorHint', { value: String(value) });
}
