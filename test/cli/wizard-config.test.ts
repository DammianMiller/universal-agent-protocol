import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  applyWizardConfig,
  defaultSelections,
  writeProxyEnv,
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

describe('applyWizardConfig — runtime feature sections', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-wizrt-'));
    writeFileSync(join(dir, '.uap.json'), JSON.stringify({ projectName: 'x' }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes recipes / delivery / concurrency / collaboration / design / reactor', async () => {
    const sel = defaultSelections({
      recipes: {
        enabled: true,
        recipe: 'fusion',
        confidenceThreshold: 0.6,
        fusionN: 4,
        allowSelfJudge: false,
        judgeModel: 'claude-opus-4-8',
        judgeEndpoint: 'https://api.anthropic.com',
        judgeApiKey: 'sk-ant-secret',
      },
      delivery: { enforcement: 'advisory', localMode: 'deliver', runtimeVerify: true },
      concurrency: { enabled: true, slots: 4 },
      collaboration: { mode: 'always' },
      design: { enabled: true, tokenGate: true },
      reactor: { enabled: false },
    });
    await applyWizardConfig(dir, sel);
    const cfg = JSON.parse(readFileSync(join(dir, '.uap.json'), 'utf-8'));
    expect(cfg.recipes.enabled).toBe(true);
    expect(cfg.recipes.recipe).toBe('fusion');
    expect(cfg.recipes.judge.model).toBe('claude-opus-4-8');
    // secret API key must NEVER land in .uap.json
    expect(JSON.stringify(cfg)).not.toContain('sk-ant-secret');
    expect(cfg.delivery.enforcement).toBe('advisory');
    expect(cfg.delivery.localMode).toBe('deliver');
    expect(cfg.modelConcurrency.adaptive).toBe(true);
    expect(cfg.modelConcurrency.slots).toBe(4);
    expect(cfg.collaboration.mode).toBe('always');
    expect(cfg.design.tokenGate).toBe(true);
    expect(cfg.reactor.enabled).toBe(false);
  });
});

describe('applyWizardConfig — routing preset', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-wizroute-'));
    writeFileSync(join(dir, '.uap.json'), JSON.stringify({ projectName: 'x' }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes multiModel from a selected routing preset', async () => {
    const sel = defaultSelections({
      model: {
        provider: 'anthropic',
        qwenOptimizations: false,
        toolCallProfile: 'claude-sonnet-4.6',
        costTracking: false,
        modelRouting: true,
        routingPreset: 'fable-local-opus',
      },
    });
    await applyWizardConfig(dir, sel);
    const cfg = JSON.parse(readFileSync(join(dir, '.uap.json'), 'utf-8'));
    expect(cfg.multiModel.enabled).toBe(true);
    expect(cfg.multiModel.roles).toEqual({
      planner: 'fable-5',
      executor: 'qwen38-27b',
      reviewer: 'opus-4.8',
      fallback: 'qwen38-27b',
    });
  });

  it('materializes complexity tiers into routingMatrix for a tiered preset (parity with `model routing use`)', async () => {
    const sel = defaultSelections({
      model: {
        provider: 'anthropic',
        qwenOptimizations: false,
        toolCallProfile: 'claude-sonnet-4.6',
        costTracking: false,
        modelRouting: true,
        routingPreset: 'cost-tiered',
      },
    });
    await applyWizardConfig(dir, sel);
    const cfg = JSON.parse(readFileSync(join(dir, '.uap.json'), 'utf-8'));
    expect(cfg.multiModel.enabled).toBe(true);
    // cost-tiered runs low/medium free on local, escalates high/critical to Opus.
    expect(cfg.multiModel.routingMatrix).toEqual({
      low: 'qwen38-27b',
      medium: 'qwen38-27b',
      high: 'opus-4.8',
      critical: 'opus-4.8',
    });
  });

  it('omits routingMatrix for a non-tiered preset (role-based routing only)', async () => {
    const sel = defaultSelections({
      model: {
        provider: 'anthropic',
        qwenOptimizations: false,
        toolCallProfile: 'claude-sonnet-4.6',
        costTracking: false,
        modelRouting: true,
        routingPreset: 'fable-local-opus',
      },
    });
    await applyWizardConfig(dir, sel);
    const cfg = JSON.parse(readFileSync(join(dir, '.uap.json'), 'utf-8'));
    expect(cfg.multiModel.routingMatrix).toBeUndefined();
  });

  it('does not write multiModel when no routing preset is chosen', async () => {
    await applyWizardConfig(dir, defaultSelections());
    const cfg = JSON.parse(readFileSync(join(dir, '.uap.json'), 'utf-8'));
    expect(cfg.multiModel).toBeUndefined();
  });
});

describe('writeProxyEnv', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-proxyenv-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('emits PROXY_* + delivery env, including the secret judge key', () => {
    const sel = defaultSelections({
      recipes: {
        enabled: true,
        recipe: 'fusion',
        confidenceThreshold: 0.5,
        fusionN: 3,
        allowSelfJudge: true,
        judgeModel: 'claude-opus-4-8',
        judgeEndpoint: 'https://api.anthropic.com',
        judgeApiKey: 'sk-ant-secret',
      },
      delivery: { enforcement: 'advisory', localMode: 'deliver', runtimeVerify: false },
    });
    const p = writeProxyEnv(dir, sel);
    expect(p).toBeTruthy();
    const env = readFileSync(p as string, 'utf-8');
    expect(env).toContain('PROXY_CONFIDENCE_ESCALATE=on');
    expect(env).toContain('PROXY_RECIPE=fusion');
    expect(env).toContain('PROXY_FUSION_N=3');
    expect(env).toContain('PROXY_ALLOW_SELF_JUDGE=1');
    expect(env).toContain('PROXY_ESCALATE_MODEL=claude-opus-4-8');
    expect(env).toContain('PROXY_ESCALATE_API_KEY=sk-ant-secret');
    expect(env).toContain('UAP_ENFORCE_DELIVERY=advisory');
    expect(env).toContain('UAP_DELIVER_LOCAL_MODE=deliver');
  });

  it('writes PROXY_CONFIDENCE_ESCALATE=off when recipes disabled and omits key', () => {
    const p = writeProxyEnv(dir, defaultSelections());
    const env = readFileSync(p as string, 'utf-8');
    expect(env).toContain('PROXY_CONFIDENCE_ESCALATE=off');
    expect(env).not.toContain('PROXY_ESCALATE_API_KEY');
    expect(env).toContain('UAP_DELIVER_LOCAL_MODE=advisory');
  });
});
