import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  applyWizardConfig,
  defaultSelections,
  profileChoicesFor,
} from '../../src/cli/wizard-config.js';

describe('defaultSelections', () => {
  it('returns conservative defaults and honors overrides', () => {
    const d = defaultSelections();
    expect(d.memory.shortTermMemory).toBe(true);
    expect(d.memory.longTermMemory).toBe(false);
    expect(d.policy.policyEngine).toBe(true);
    expect(d.model.provider).toBe('anthropic');
    const o = defaultSelections({ platforms: ['codex'] });
    expect(o.platforms).toEqual(['codex']);
  });
});

describe('profileChoicesFor', () => {
  it('returns provider-appropriate profiles', () => {
    expect(profileChoicesFor('anthropic').map((p) => p.value)).toContain('claude-sonnet-4.6');
    expect(profileChoicesFor('openai').map((p) => p.value)).toContain('gpt-5.4');
    expect(profileChoicesFor('local').map((p) => p.value)).toContain('qwen35-a3b');
    expect(profileChoicesFor('custom').map((p) => p.value)).toEqual(['generic']);
  });
});

describe('applyWizardConfig', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-wizcfg-'));
    writeFileSync(join(dir, '.uap.json'), JSON.stringify({ projectName: 'x' }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('persists the rich selections into .uap.json (merging onto existing)', async () => {
    const sel = defaultSelections({
      memory: { shortTermMemory: true, longTermMemory: true, knowledgeGraph: true, prepopDocs: true, prepopGit: false },
      patterns: { patternLibrary: true, patternRag: true, reinforcementLearning: true },
      model: { provider: 'local', qwenOptimizations: true, toolCallProfile: 'qwen35-a3b', costTracking: true, modelRouting: false },
      browser: { cloakBrowser: true },
    });
    const path = await applyWizardConfig(dir, sel);
    expect(path).toBeTruthy();

    const cfg = JSON.parse(readFileSync(join(dir, '.uap.json'), 'utf-8'));
    expect(cfg.projectName).toBe('x'); // existing key preserved
    expect(cfg.memory.longTerm.enabled).toBe(true);
    expect(cfg.memory.longTerm.provider).toBe('qdrant');
    expect(cfg.memory.knowledgeGraph.enabled).toBe(true);
    expect(cfg.memory.prepopulation.docs).toBe(true);
    expect(cfg.memory.patternRag.enabled).toBe(true);
    expect(cfg.patternRL.enabled).toBe(true);
    expect(cfg.model.provider).toBe('local');
    expect(cfg.model.qwenOptimizations).toBe(true);
    expect(cfg.toolCalls.modelProfile).toBe('qwen35-a3b');
    expect(cfg.policy.enabled).toBe(true);
    expect(cfg.browser.cloakBrowser).toBe(true);
  });

  it('disables long-term memory when not selected', async () => {
    const sel = defaultSelections(); // longTermMemory: false
    await applyWizardConfig(dir, sel);
    const cfg = JSON.parse(readFileSync(join(dir, '.uap.json'), 'utf-8'));
    expect(cfg.memory.longTerm.enabled).toBe(false);
    expect(cfg.model.provider).toBe('anthropic');
    // non-local provider → no qwenOptimizations key
    expect(cfg.model.qwenOptimizations).toBeUndefined();
  });
});
