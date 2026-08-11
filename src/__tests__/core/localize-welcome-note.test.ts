// localize-welcome-note.test.ts — D8 Welcome note LLM dynamic translation
//
// v1.23.0 design (D8, user-locked 2026-06-23):
//   - Welcome content = 1 English template (no 10-locale hardcoded i18n)
//   - At write time, the plugin LLM-translates the body into the user's
//     `wikiLanguage` if the LLM is configured and reachable
//   - On LLM failure, fall back to writing the English template (so the
//     user always gets a usable note) and surface the error so the caller
//     can show a "Run Configuration Test" Notice
//
// What this tests:
//   - Happy path: LLM returns translated body → output is the LLM's text
//   - JSON-wrapped LLM response: extract `translated` field
//   - LLM not configured (probe returns ok=false) → return English fallback
//   - LLM throws → caught and fallback returned
//   - Short-circuit: targetLanguage === 'en' → skip LLM call entirely

import { describe, it, expect, vi } from 'vitest';
import { localizeWelcomeNote, type LocalizeArgs } from '../../core/localize-welcome-note';
import { WelcomeTranslationLLMSchema } from '../../llm-sdk/output-schemas';

const ENGLISH_BODY = `---
title: Wiki Founding Note
type: welcome
created: 2026-06-27
---

# Welcome to your Wiki

Intro paragraph.
`;

const CHINESE_TRANSLATED = `---
title: 维基奠基笔记
type: welcome
created: 2026-06-27
---

# 欢迎使用你的维基

介绍段落。
`;

function makeArgs(overrides: Partial<LocalizeArgs> = {}): LocalizeArgs {
  return {
    englishBody: ENGLISH_BODY,
    targetLanguage: 'zh',
    llmClient: overrides.llmClient ?? {
      createMessage: vi.fn().mockResolvedValue(
        JSON.stringify({ translated: CHINESE_TRANSLATED }),
      ),
    },
    model: 'claude-opus-4-8',
    ...overrides,
  };
}

describe('localizeWelcomeNote — happy path', () => {
  it('returns the LLM-translated body when targetLanguage is non-English', async () => {
    const args = makeArgs();
    const result = await localizeWelcomeNote(args);

    expect(result.ok).toBe(true);
    expect(result.body).toBe(CHINESE_TRANSLATED);
    expect(result.localized).toBe(true);
  });

  it('parses JSON-wrapped LLM response (extracts `translated` field)', async () => {
    const args = makeArgs({
      llmClient: {
        createMessage: vi.fn().mockResolvedValue(
          JSON.stringify({ translated: CHINESE_TRANSLATED }),
        ),
      },
    });
    const result = await localizeWelcomeNote(args);
    expect(result.body).toBe(CHINESE_TRANSLATED);
  });

  it('passes target language in the system prompt to guide translation', async () => {
    const createMessage = vi.fn().mockResolvedValue(
      JSON.stringify({ translated: CHINESE_TRANSLATED }),
    );
    await localizeWelcomeNote(makeArgs({ llmClient: { createMessage }, targetLanguage: 'ja' }));

    const call = createMessage.mock.calls[0][0] as { system: string; messages: Array<{ content: string }> };
    expect(call.system).toMatch(/Japanese|Japanese language/i);
    expect(call.messages[0].content).toContain(ENGLISH_BODY);
  });

  it('sends a single user message with the English body to translate', async () => {
    const createMessage = vi.fn().mockResolvedValue(
      JSON.stringify({ translated: CHINESE_TRANSLATED }),
    );
    await localizeWelcomeNote(makeArgs({ llmClient: { createMessage } }));

    const call = createMessage.mock.calls[0][0] as {
      messages: Array<{ role: string; content: string }>;
      max_tokens: number;
      model: string;
    };
    expect(call.messages).toHaveLength(1);
    expect(call.messages[0].role).toBe('user');
    expect(call.messages[0].content).toBe(ENGLISH_BODY);
    expect(call.max_tokens).toBeGreaterThan(0);
    expect(call.model).toBe('claude-opus-4-8');
  });
});

describe('localizeWelcomeNote — short-circuit', () => {
  it('returns English body without calling LLM when targetLanguage is en', async () => {
    const createMessage = vi.fn();
    const result = await localizeWelcomeNote(
      makeArgs({ llmClient: { createMessage }, targetLanguage: 'en' }),
    );

    expect(result.ok).toBe(true);
    expect(result.body).toBe(ENGLISH_BODY);
    expect(result.localized).toBe(false);
    expect(createMessage).not.toHaveBeenCalled();
  });
});

describe('localizeWelcomeNote — fallback on LLM failure', () => {
  it('returns English body when LLM throws an error', async () => {
    const result = await localizeWelcomeNote(
      makeArgs({
        llmClient: {
          createMessage: vi.fn().mockRejectedValue(new Error('rate limit')),
        },
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.localized).toBe(false);
    expect(result.body).toBe(ENGLISH_BODY);
    expect(result.error).toMatch(/rate limit/);
  });

  it('returns English body when LLM returns invalid JSON', async () => {
    const result = await localizeWelcomeNote(
      makeArgs({
        llmClient: {
          createMessage: vi.fn().mockResolvedValue('not json at all'),
        },
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.localized).toBe(false);
    expect(result.body).toBe(ENGLISH_BODY);
    expect(result.error).toBeDefined();
  });

  it('returns English body when JSON is valid but missing `translated` field', async () => {
    const result = await localizeWelcomeNote(
      makeArgs({
        llmClient: {
          createMessage: vi.fn().mockResolvedValue(JSON.stringify({ other: 'value' })),
        },
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.body).toBe(ENGLISH_BODY);
  });

  it('preserves English body verbatim in fallback (no truncation, no decoration)', async () => {
    const result = await localizeWelcomeNote(
      makeArgs({
        llmClient: {
          createMessage: vi.fn().mockRejectedValue(new Error('boom')),
        },
      }),
    );

    expect(result.body).toBe(ENGLISH_BODY);
    expect(result.body).not.toMatch(/ERROR|FAIL|⚠️/);
  });
});

describe('localizeWelcomeNote — JSON repair (LLM adds stray prose)', () => {
  it('extracts JSON when LLM wraps it with prose before/after', async () => {
    const result = await localizeWelcomeNote(
      makeArgs({
        llmClient: {
          createMessage: vi.fn().mockResolvedValue(
            `Sure, here is the translation:\n${JSON.stringify({ translated: CHINESE_TRANSLATED })}\nDone.`,
          ),
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.body).toBe(CHINESE_TRANSLATED);
  });
});

// === typed-output migration (v1.26.3 PATCH Issue #443 expanded scope) ===
// Commit 11 — localize-welcome-note now uses createMessageWithOutput when
// available; falls back to createMessage + extractTranslatedField on legacy
// clients. Schema enforcement kills the `<|channel>thought` / ```json```
// wraparound failure mode observed in user's 2026-08-10 LMStudio log.
describe('localizeWelcomeNote — typed-output migration (#443 expanded scope)', () => {
  it('passes WelcomeTranslationLLMSchema on the wire via response_format.schema (legacy client)', async () => {
    const createMessage = vi.fn().mockResolvedValue(JSON.stringify({ translated: CHINESE_TRANSLATED }));
    await localizeWelcomeNote(makeArgs({
      targetLanguage: 'zh',
      llmClient: { createMessage },
    }));
    expect(createMessage).toHaveBeenCalled();
    const calls = createMessage.mock.calls as unknown as Array<[unknown]>;
    const args = calls[0]?.[0] as { response_format?: { schema?: unknown } };
    expect(args.response_format?.schema).toBe(WelcomeTranslationLLMSchema);
  });

  it('uses createMessageWithOutput when client implements it (Tier 0 path)', async () => {
    const createMessageWithOutput = vi.fn().mockResolvedValue({
      text: JSON.stringify({ translated: CHINESE_TRANSLATED }),
      output: { translated: CHINESE_TRANSLATED },
      outputMode: 'json_schema',
      finishReason: 'stop',
    });
    const createMessage = vi.fn();
    const result = await localizeWelcomeNote(makeArgs({
      targetLanguage: 'zh',
      llmClient: { createMessage, createMessageWithOutput },
    }));
    expect(createMessageWithOutput).toHaveBeenCalled();
    expect(createMessage).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.body).toBe(CHINESE_TRANSLATED);
  });

  it('falls back to createMessage + extractTranslatedField when client lacks createMessageWithOutput', async () => {
    const createMessage = vi.fn().mockResolvedValue(
      `<|channel>thought reasoning preface\n\n\`\`\`json\n${JSON.stringify({ translated: CHINESE_TRANSLATED })}\n\`\`\``
    );
    const result = await localizeWelcomeNote(makeArgs({
      targetLanguage: 'zh',
      llmClient: { createMessage },
    }));
    expect(createMessage).toHaveBeenCalled();
    // Even with LMStudio's `<|channel>thought` + ```json``` wrapping, the
    // legacy parseJsonResponse + greedy regex path still extracts the
    // translated body. The schema-based Tier 0 path replaces this in the
    // happy case (test above), but the legacy fallback remains functional
    // for older clients without the typed-output method.
    expect(result.ok).toBe(true);
    expect(result.body).toBe(CHINESE_TRANSLATED);
  });
});
