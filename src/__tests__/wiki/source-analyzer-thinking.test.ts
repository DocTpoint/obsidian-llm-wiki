import { describe, it, expect, vi } from 'vitest';
import { createMockContext, createMockFile } from '../__support__/engine-context';
import { SourceAnalyzer } from '../../wiki/source-analyzer';
import { TFile } from 'obsidian';

const SOURCE = 'sources/note.md';

// Extraction was the one call site in the plugin that never consulted the
// thinking setting, so whatever the server had been started with decided it and
// the setting meant nothing here.
//
// Sent in the disable direction only, matching every other call site.
// `disableThinking` defaults to false, so a call that asked for reasoning would
// fire on every install that never opened the setting, putting
// `chat_template_kwargs` into every request to every OpenAI-compatible provider
// on the strength of measurements against one local server.

function analyzerFor(settings: { disableThinking?: boolean }) {
  const { ctx } = createMockContext({
    vaultFiles: { [SOURCE]: '# Note\nThe striatum encodes habit formation.' },
    llmResponses: [JSON.stringify({
      source_title: 'Note',
      summary: 'A summary.',
      entities: [{ name: 'Striatum', type: 'other', summary: 'a', mentions_in_source: [] }],
      concepts: [],
    })],
    settings,
  });
  return ctx;
}

async function thinkingSentBy(settings: { disableThinking?: boolean }) {
  const ctx = analyzerFor(settings);
  const spy = vi.spyOn(ctx.getClient()!, 'createMessage');
  // eslint-disable-next-line obsidianmd/no-tfile-tfolder-cast
  await new SourceAnalyzer(ctx).analyzeSource(createMockFile(SOURCE) as unknown as TFile);
  return spy.mock.calls[0][0];
}

describe('SourceAnalyzer — the thinking setting reaches the extraction call', () => {
  it('asks the model not to reason when the user turned it off', async () => {
    expect((await thinkingSentBy({ disableThinking: true })).enableThinking).toBe(false);
  });

  // The default, and the state every install that never opened the setting is
  // in. Asking for thinking here was tried and withdrawn: the field would then
  // travel in every extraction request to every OpenAI-compatible provider,
  // and the evidence that it is harmless comes from one local server.
  //
  // Not written as `disableThinking: undefined` — the settings merge fills the
  // default in, so that state does not exist at runtime and a test asserting it
  // would pass without covering anything.
  it('leaves the server alone when the user has not turned reasoning off', async () => {
    expect(await thinkingSentBy({ disableThinking: false })).not.toHaveProperty('enableThinking');
  });
});
