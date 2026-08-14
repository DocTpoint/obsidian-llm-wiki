/**
 * Issue #456: commitTempSettings must NOT cascade-clear per-task fields.
 *
 * Root cause (v1.24.1 PATCH Phase 5.5.0): a defensive belt-and-suspenders
 * cascade was added inside commitTempSettings (settings.ts:76-78). The
 * cascade belongs on the live-edit path only — setFieldValue('model', ...)
 * already fires it. Commit should be a pure write-through.
 *
 * Tests below exercise the REAL production methods (not a mirror) per
 * project TDD standard — shell tests via local re-implementation are
 * explicitly banned because they pass even when production regresses.
 */

import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../types';
import { LLMWikiSettingTab } from '../../ui/settings';

function makeTab(tempSettings: Record<string, unknown>) {
  const tab = Object.create(LLMWikiSettingTab.prototype) as LLMWikiSettingTab;
  // App stub — commitTempSettings only reads app.secretStorage.
  (tab as unknown as { app: unknown }).app = {
    secretStorage: { getSecret: () => null, setSecret: () => undefined },
  };
  // plugin.settings is the LIVE reference that commitTempSettings writes to.
  // We must read from this same object AFTER the spread, not from a local
  // capture (the spread creates a new object assigned back to plugin.settings).
  const liveSettings = { ...DEFAULT_SETTINGS, ...tempSettings };
  (tab as unknown as { plugin: unknown }).plugin = {
    settings: liveSettings,
    initializeLLMClient: vi.fn(),
    saveSettings: vi.fn(),
  };
  // tempSettings: separate object, mutated by commitTempSettings in-place
  // via cascadeUnifiedModelChange, then spread into plugin.settings.
  (tab as unknown as { tempSettings: unknown }).tempSettings = {
    ...DEFAULT_SETTINGS,
    ...tempSettings,
    apiKey: '',
  };
  return { tab, liveSettings };
}

describe('Issue #456: commitTempSettings preserves per-task fields (#456 bug fix)', () => {
  it('preserves ingestModel / lintModel / queryModel when unified model is set', () => {
    const { tab, liveSettings } = makeTab({
      model: 'gpt-5-mini',
      ingestModel: 'gpt-5-mini',
      lintModel: 'gpt-5.5',
      queryModel: 'gpt-5.6-sol',
    });
    const ok = tab.commitTempSettings();
    expect(ok).toBe(true);
    // Read from tab.plugin.settings (where commitTempSettings wrote to)
    const saved = (tab as unknown as { plugin: { settings: Record<string, string> } }).plugin.settings;
    expect(saved.lintModel).toBe('gpt-5.5');
    expect(saved.queryModel).toBe('gpt-5.6-sol');
    expect(saved.ingestModel).toBe('gpt-5-mini');
    expect(saved.model).toBe('gpt-5-mini');
  });

  it('preserves per-task fields even when unified model is a fresh value (#456 edge)', () => {
    const { tab } = makeTab({
      model: 'gpt-4o',
      ingestModel: 'a',
      lintModel: 'b',
      queryModel: 'c',
    });
    tab.commitTempSettings();
    const saved = (tab as unknown as { plugin: { settings: Record<string, string> } }).plugin.settings;
    expect(saved.ingestModel).toBe('a');
    expect(saved.lintModel).toBe('b');
    expect(saved.queryModel).toBe('c');
  });
});

describe('Issue #456: setFieldValue still cascades on live edits (UX preserved)', () => {
  // The live-edit cascade is the correct UX path. This test pins that
  // the production setFieldValue still does its job — even after the
  // commit-path cascade is removed, the live-edit path remains.
  it('cascadeUnifiedModelChange is invoked when setFieldValue(model, newValue) fires', () => {
    const { tab } = makeTab({
      model: 'gpt-5-mini',
      ingestModel: 'gpt-5-mini',
      lintModel: 'gpt-5.5',
      queryModel: 'gpt-5.6-sol',
    });
    tab.setFieldValue('model', 'gpt-4o');
    // setFieldValue delegates to cascadeUnifiedModelChange internally;
    // we verify via the public observable state (tempSettings fields).
    const temp = (tab as unknown as { tempSettings: Record<string, string> }).tempSettings;
    expect(temp.ingestModel).toBe('');
    expect(temp.lintModel).toBe('');
    expect(temp.queryModel).toBe('');
  });
});
