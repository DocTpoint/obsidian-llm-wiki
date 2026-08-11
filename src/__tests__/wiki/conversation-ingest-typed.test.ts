// typed-output migration tests for conversation-ingest extraction (Commit 4).
//
// The ConversationIngestor class wires many collaborators (PageFactory,
// orchestrator, wikiEngine) so direct unit testing is heavy. We test the
// migration in two complementary ways:
//   1. Schema-on-wire: spy on the mock client's createMessage, confirm the
//      analysis call carries response_format.schema = SourceAnalysisLLMSchema.
//   2. Typed path: monkey-patch createMessageWithOutput, confirm it is invoked
//      when the client implements it (legacy Anthropic/OpenAI/Codex fall back
//      to createMessage).

import { describe, it, expect, vi } from 'vitest';
import { ConversationIngestor } from '../../wiki/conversation-ingest';
import { SourceAnalysisLLMSchema } from '../../llm-sdk/output-schemas';

// Minimal stub for the orchestrator + WikiEngine required by the
// ConversationIngestor constructor. We only exercise the extraction LLM
// call, so most collaborators can return empty values.
function makeContextStub(llmClient: unknown) {
  const ctx = {
    app: { vault: { getMarkdownFiles: () => [] } } as never,
    settings: {
      provider: 'mock',
      language: 'en',
      wikiLanguage: 'English',
      wikiFolder: 'wiki',
      slugCase: 'lower',
      disableThinking: false,
      model: 'mock-model',
    },
    getClient: () => llmClient,
    tryReadFile: async () => null, // index.md absent → skip dedup, go straight to extract
    buildSystemPrompt: async () => undefined,
    onProgress: undefined,
    onDone: undefined,
    getExistingWikiPages: async () => [],
    getSchemaContext: async () => undefined,
  } as never;
  const orch = {
    apiDelay: async () => {},
    ensureWikiStructure: async () => {},
    generateIndex: async () => {},
    updateLog: async () => {},
    getExistingWikiPages: async () => [],
  } as never;
  const pageFactory = {
    createOrUpdateEntityPage: async () => ({ path: '', created: true }),
    createOrUpdateConceptPage: async () => ({ path: '', created: true }),
  } as never;
  const wikiEngine = {} as never;
  return { ctx, orch, pageFactory, wikiEngine };
}

describe('ConversationIngestor — typed-output migration (#443 expanded scope)', () => {
  it('passes SourceAnalysisLLMSchema on the wire via response_format.schema (legacy client)', async () => {
    const spy = vi.fn(async (_params: unknown) => JSON.stringify({
      source_title: 'A conversation',
      summary: 'Conversation about X.',
      entities: [{ name: 'Alice', type: 'person', summary: 'A person.', mentions_in_source: [] }],
      concepts: [{ name: 'TopicA', type: 'theory', summary: 'A topic.', mentions_in_source: [], related_concepts: [] }],
    }));
    const client = { createMessage: spy };
    const { ctx, orch, pageFactory, wikiEngine } = makeContextStub(client);

    const ingestor = new ConversationIngestor(ctx, pageFactory, orch);
    try {
      await ingestor.ingestConversation({ messages: [{ role: 'user', content: 'Sample conversation', timestamp: Date.now() }] });
    } catch {
      // The stub's downstream collaborators throw / no-op; we only care that
      // the analysis LLM call was made with the schema attached.
    }

    expect(spy).toHaveBeenCalled();
    // The first call (conversation-extract) must carry the schema.
    const extractCall = spy.mock.calls.find(
      (c) => (c[0] as { task?: string }).task === 'conversation-extract'
    );
    expect(extractCall).toBeDefined();
    const args = extractCall![0] as { response_format?: { schema?: unknown } };
    expect(args.response_format?.schema).toBe(SourceAnalysisLLMSchema);
  });

  it('uses createMessageWithOutput when the client implements it (Tier 0 path)', async () => {
    const legacySpy = vi.fn(async (_params: unknown) => '{"source_title":"x","entities":[],"concepts":[]}');
    const typedResult = {
      text: JSON.stringify({
        source_title: 'A conversation',
        summary: 'Conversation about X.',
        entities: [{ name: 'Alice', type: 'person', summary: 'A person.', mentions_in_source: [] }],
        concepts: [],
      }),
      output: {
        source_title: 'A conversation',
        summary: 'Conversation about X.',
        entities: [{ name: 'Alice', type: 'person', summary: 'A person.', mentions_in_source: [] }],
      },
      outputMode: 'json_schema',
      finishReason: 'stop',
    };
    const typedSpy = vi.fn(async (_params: unknown) => typedResult);
    const client = {
      createMessage: legacySpy,
      createMessageWithOutput: typedSpy,
    };
    const { ctx, orch, pageFactory, wikiEngine } = makeContextStub(client);

    const ingestor = new ConversationIngestor(ctx, pageFactory, orch);
    try {
      await ingestor.ingestConversation({ messages: [{ role: 'user', content: 'Sample conversation', timestamp: Date.now() }] });
    } catch {
      // ignore downstream stub failures
    }

    expect(typedSpy).toHaveBeenCalled();
    // conversation-extract went through typed path; free-text callers
    // (summaryPageContent, free-form markdown body generation) remain
    // on legacy createMessage + cleanMarkdownResponse (out of schema
    // migration scope per the free-text exclusion).
    expect(typedSpy.mock.calls.some(c => (c[0] as { task?: string }).task === 'conversation-extract')).toBe(true);
    const extractCall = typedSpy.mock.calls.find(
      (c) => (c[0] as { task?: string }).task === 'conversation-extract'
    );
    expect(extractCall).toBeDefined();
  });

  it('falls back to createMessage + parseJsonResponse when client lacks createMessageWithOutput', async () => {
    const legacySpy = vi.fn(async (_params: unknown) => JSON.stringify({
      source_title: 'A conversation',
      summary: 'Conversation about X.',
      entities: [{ name: 'Alice', type: 'person', summary: 'A person.', mentions_in_source: [] }],
      concepts: [],
    }));
    const client = { createMessage: legacySpy }; // no createMessageWithOutput
    const { ctx, orch, pageFactory, wikiEngine } = makeContextStub(client);

    const ingestor = new ConversationIngestor(ctx, pageFactory, orch);
    try {
      await ingestor.ingestConversation({ messages: [{ role: 'user', content: 'Sample conversation', timestamp: Date.now() }] });
    } catch {
      // ignore downstream stub failures
    }

    expect(legacySpy).toHaveBeenCalled();
  });
});