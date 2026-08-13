// Thin wrapper that injects advanced settings into createMessage calls.
// v1.20.0: by default the plugin does NOT inject any provider-specific
// thinking-control / temperature / repetition_penalty field. Each setting
// is only sent when the caller explicitly passed it AND when the user has
// configured a value in Custom Advanced Settings. This keeps backward
// compatibility: empty/undefined settings mean "use provider default".
//
// Issue #99: disableThinking (data.json field) was a v1.18.2 opt-out that
// was flipped to opt-in in v1.20.0 — see types.ts for the new semantics.
// When the user does enable it, the LLMClient itself walks the 3-tier
// dialect fallback (anthropic → openai → none). The wrapper stays passive.
// Issue #128: extractionTemperature / chatTemperature inject `temperature`.
// Issue #128 follow-up: repetitionPenalty injects `repetition_penalty`.
// Issue #75: maxTokensPerCall cap wraps max_tokens via capMaxTokens.

import { LLMClient } from './types';
import { capMaxTokens } from './core/token-cap';
import { recordTaskUsage } from './core/llm-task-usage';

export interface WrapperSettings {
  maxTokensPerCall: number;
  extractionTemperature?: number;
  /**
   * Nucleus sampling for extraction. Its partner, not an independent knob: a
   * server preset sets the two together, so overriding only the temperature
   * leaves the run on half of one preset and half of another.
   */
  extractionTopP?: number;
  /** Fixed sampling seed. Unset means the provider picks one per request. */
  samplingSeed?: number;
  chatTemperature?: number;
  repetitionPenalty?: number;
}

/**
 * Returns a new LLMClient whose `createMessage` injects advanced settings
 * when set; otherwise passes through. The returned client's `createMessage`
 * never modifies a caller-provided parameter — only fills in unset ones.
 *
 * v1.23.2 refactor: replaced `.bind()` + in-place mutation (the old
 * pattern silently mutated the caller's client reference) with
 * `Object.create(client)` + explicit override of `createMessage`.
 * spread `{ ...client }` is NOT used because `OpenAICompatSdkClient`
 * (and other implementations) define `createMessageStream` and
 * `listModels` as prototype methods — spread only captures own
 * enumerable properties, which drops all prototype methods.
 * `Object.create(client)` preserves the prototype chain, so the
 * wrapper inherits `createMessageStream` from the original client.
 *
 * **Known bug (v1.26.3 PATCH discovered):** prototype inheritance of
 * `createMessageStream` means settings (temperature / top_p / seed /
 * repetitionPenalty / enableThinking) are NOT injected on the stream
 * path. PR #443 Phase B added explicit `createMessageWithOutput`
 * wrapping (which works correctly), but `createMessageStream` still
 * relies on prototype inheritance and silently bypasses the wrapper.
 * Affects Query Wiki + streaming UI. Tracked as a separate v1.27.0
 * issue — the fix requires either explicit stream wrapping or a
 * different wrapper strategy that does not rely on `Object.create`.
 * See [project_v1_26_3_ux_patch] for the discovery + CHANGELOG
 * #414 entry for the full context.
 */
export function wrapWithAdvancedSettings(
  client: LLMClient,
  settings: WrapperSettings
): LLMClient {
  const capTokens = settings.maxTokensPerCall > 0;

  // Preserve prototype chain — Object.create inherits all prototype
  // methods (createMessageStream, listModels) from the original client.
  const wrapper = Object.create(client) as LLMClient;
  wrapper.createMessage = async (params) => {
    const startedAt = Date.now();
    // The one seam every call passes through (`createLLMClient` always returns
    // this wrapper), so the step's name is logged here rather than at twelve
    // call sites. Without it the debug log prints a provider, a model and a
    // prompt length per call and never says which step asked — and an ingest
    // is tens of calls. Stubbed out in production builds along with every
    // other `console.debug`.
    console.debug(`[llm] task=${params.task ?? 'untagged'} model=${params.model} max_tokens=${params.max_tokens}`);
    // Timed around the whole call, not on success: a call that throws still
    // spent the time, and leaving it out would flatter whichever step fails.
    try {
      return await client.createMessage({
        ...params,
        ...(capTokens ? { max_tokens: capMaxTokens(params.max_tokens, { maxTokensPerCall: settings.maxTokensPerCall }), maxTokensPerCall: settings.maxTokensPerCall } : {}),
        ...(params.temperature === undefined && settings.extractionTemperature !== undefined ? { temperature: settings.extractionTemperature } : {}),
        ...(params.top_p === undefined && settings.extractionTopP !== undefined ? { top_p: settings.extractionTopP } : {}),
        ...(params.repetition_penalty === undefined && settings.repetitionPenalty !== undefined ? { repetition_penalty: settings.repetitionPenalty } : {}),
        ...(params.seed === undefined && settings.samplingSeed !== undefined ? { seed: settings.samplingSeed } : {}),
      });
    } finally {
      recordTaskUsage(params.task, Date.now() - startedAt);
    }
  };

  // v1.26.3 PATCH Phase B (Issue #443): wrap the typed-output variant the
  // same way as createMessage. `Object.create(client)` inherits the
  // prototype implementation; an explicit override here keeps the seam
  // intact — task accounting + advanced settings injection apply to
  // Phase B callers (seed-selector / query-keywords / merge-triage /
  // link-orphan / fix-dead-link / QueryView) identically to the 16
  // legacy callers. Without this, a typed call would bypass the seam
  // and record under 'untagged' with no temperature/top_p/seed override.
  if (client.createMessageWithOutput) {
    wrapper.createMessageWithOutput = async (params) => {
      const startedAt = Date.now();
      console.debug(`[llm] task=${params.task ?? 'untagged'} model=${params.model} max_tokens=${params.max_tokens} (typed)`);
      try {
        return await client.createMessageWithOutput!({
          ...params,
          ...(capTokens ? { max_tokens: capMaxTokens(params.max_tokens, { maxTokensPerCall: settings.maxTokensPerCall }), maxTokensPerCall: settings.maxTokensPerCall } : {}),
          ...(params.temperature === undefined && settings.extractionTemperature !== undefined ? { temperature: settings.extractionTemperature } : {}),
          ...(params.top_p === undefined && settings.extractionTopP !== undefined ? { top_p: settings.extractionTopP } : {}),
          ...(params.repetition_penalty === undefined && settings.repetitionPenalty !== undefined ? { repetition_penalty: settings.repetitionPenalty } : {}),
          ...(params.seed === undefined && settings.samplingSeed !== undefined ? { seed: settings.samplingSeed } : {}),
        });
      } finally {
        recordTaskUsage(params.task, Date.now() - startedAt);
      }
    };
  }
  return wrapper;
}
