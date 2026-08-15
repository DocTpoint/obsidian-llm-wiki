/**
 * Issue #456: commitTempSettings must NOT cascade-clear per-task fields.
 *
 * Root cause (v1.24.1 PATCH Phase 5.5.0): a defensive belt-and-suspenders
 * cascade was added inside commitTempSettings. The cascade belongs on the
 * live-edit path only — setFieldValue('model', ...) already fires it.
 * Commit must be a pure write-through.
 *
 * Tests below exercise the REAL production methods (not a mirror) per
 * project TDD standard — shell tests via local re-implementation are
 * explicitly banned because they pass even when production regresses.
 *
 * The setFieldValue → cascadeUnifiedModelChange live-edit path is pinned
 * separately by settings-cascade.test.ts; not duplicated here.
 */

import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS } from '../../types';
import { LLMWikiSettingTab } from '../../ui/settings';

function makeTab(overrides: Record<string, unknown>): LLMWikiSettingTab {
  // App stub — commitTempSettings only reads app.secretStorage.
  const tab = Object.create(LLMWikiSettingTab.prototype) as LLMWikiSettingTab;
  (tab as unknown as { app: unknown }).app = {
    secretStorage: { getSecret: () => null, setSecret: () => undefined },
  };
  // plugin.settings is the LIVE reference that commitTempSettings writes to
  // (the spread creates a new object assigned back to plugin.settings).
  (tab as unknown as { plugin: unknown }).plugin = {
    settings: { ...DEFAULT_SETTINGS, ...overrides },
    initializeLLMClient: () => undefined,
    saveSettings: () => undefined,
  };
  // tempSettings: separate object, mutated by commitTempSettings in-place
  // via cascadeUnifiedModelChange (now live-edit-only), then spread into
  // plugin.settings.
  (tab as unknown as { tempSettings: unknown }).tempSettings = {
    ...DEFAULT_SETTINGS,
    ...overrides,
    apiKey: '',
  };
  return tab;
}

describe('Issue #456: commitTempSettings preserves per-task fields', () => {
  it('preserves ingestModel / lintModel / queryModel when unified model is set', () => {
    const tab = makeTab({
      model: 'gpt-5-mini',
      ingestModel: 'gpt-5-mini',
      lintModel: 'gpt-5.5',
      queryModel: 'gpt-5.6-sol',
    });
    const ok = tab.commitTempSettings();
    expect(ok).toBe(true);
    const saved = (tab as unknown as { plugin: { settings: Record<string, string> } }).plugin.settings;
    expect(saved.lintModel).toBe('gpt-5.5');
    expect(saved.queryModel).toBe('gpt-5.6-sol');
    expect(saved.ingestModel).toBe('gpt-5-mini');
    expect(saved.model).toBe('gpt-5-mini');
  });
});