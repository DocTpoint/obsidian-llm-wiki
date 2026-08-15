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
//
// v1.26.4 PATCH (Issue #451): createMessageStream was silently inheriting
// verbatim via Object.create, dropping temperature/top_p/seed/repetitionPenalty
// on the stream path. Added explicit override that mirrors the
// createMessage / createMessageWithOutput pattern via shared helpers below.

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
 */
export function wrapWithAdvancedSettings(
  client: LLMClient,
  settings: WrapperSettings
): LLMClient {
  const capTokens = settings.maxTokensPerCall > 0;

  // Preserve prototype chain — Object.create inherits all prototype
  // methods (createMessageStream, listModels) from the original client.
  const wrapper = Object.create(client) as LLMClient;
  wrapper.createMessage = (params) => withTaskAccounting(params.task, async () => {
    logLlmCall(params.task, params.model, params.max_tokens);
    return client.createMessage({
      ...params,
      ...injectAdvancedSettings(params, settings, capTokens),
    });
  });

  if (client.createMessageWithOutput) {
    wrapper.createMessageWithOutput = (params) => withTaskAccounting(params.task, async () => {
      logLlmCall(params.task, params.model, params.max_tokens, 'typed');
      return client.createMessageWithOutput!({
        ...params,
        ...injectAdvancedSettings(params, settings, capTokens),
      });
    });
  }

  // Issue #451: createMessageStream previously inherited verbatim via
  // Object.create, silently dropping advanced settings on the stream path.
  // 'untagged' is hardcoded for task accounting — see Issue #469 for the
  // follow-up to extend the interface with a task field.
  if (client.createMessageStream) {
    wrapper.createMessageStream = (params) => withTaskAccounting(undefined, async () => {
      logLlmCall(undefined, params.model, params.max_tokens, 'stream');
      return client.createMessageStream!({
        ...params,
        ...injectAdvancedSettings(params, settings, capTokens),
      });
    });
  }
  return wrapper;
}

// Build the settings-injection overlay used by all three wrapper blocks.
// Caller-wins semantics: each spread only fires when the caller's params
// omitted the field AND the setting was configured.
function injectAdvancedSettings(
  params: { max_tokens?: number; temperature?: number; top_p?: number; repetition_penalty?: number; seed?: number },
  settings: WrapperSettings,
  capTokens: boolean,
): Record<string, unknown> {
  return {
    ...(capTokens ? { max_tokens: capMaxTokens(params.max_tokens ?? 0, { maxTokensPerCall: settings.maxTokensPerCall }), maxTokensPerCall: settings.maxTokensPerCall } : {}),
    ...(params.temperature === undefined && settings.extractionTemperature !== undefined ? { temperature: settings.extractionTemperature } : {}),
    ...(params.top_p === undefined && settings.extractionTopP !== undefined ? { top_p: settings.extractionTopP } : {}),
    ...(params.repetition_penalty === undefined && settings.repetitionPenalty !== undefined ? { repetition_penalty: settings.repetitionPenalty } : {}),
    ...(params.seed === undefined && settings.samplingSeed !== undefined ? { seed: settings.samplingSeed } : {}),
  };
}

// The one seam every call passes through (`createLLMClient` always returns
// this wrapper), so the step's name is logged here rather than at twelve
// call sites. Without it the debug log prints a provider, a model and a
// prompt length per call and never says which step asked. Stubbed out in
// production builds along with every other `console.debug`.
function logLlmCall(task: string | undefined, model: string, maxTokens: number, suffix?: string): void {
  console.debug(`[llm] task=${task ?? 'untagged'} model=${model} max_tokens=${maxTokens}${suffix ? ` ${suffix}` : ''}`);
}

// Timed around the whole call, not on success: a call that throws still
// spent the time, and leaving it out would flatter whichever step fails.
async function withTaskAccounting<T>(task: string | undefined, fn: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  try {
    return await fn();
  } finally {
    recordTaskUsage(task, Date.now() - startedAt);
  }
}