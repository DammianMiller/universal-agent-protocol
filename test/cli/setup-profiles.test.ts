/**
 * Setup profile presets (Maximum / Minimal) — the "turn it all on" bundle and
 * its lean counterpart, plus the .uap.json each writes via applyWizardConfig.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  maxSelections,
  minSelections,
  applyWizardConfig,
} from '../../src/cli/wizard-config.js';

describe('maxSelections — everything on at max capability', () => {
  it('enables the full feature set with a local model + docker', () => {
    const s = maxSelections({ platforms: ['claude'], localModel: 'http://localhost:8080/v1', hasDocker: true });
    // memory (Qdrant tiers available)
    expect(s.memory).toMatchObject({ longTermMemory: true, knowledgeGraph: true, prepopDocs: true, prepopGit: true });
    // multi-agent, patterns, policy all on
    expect(s.multiAgent).toMatchObject({ coordinationDb: true, worktreeIsolation: true, deployBatching: true, agentMessaging: true });
    expect(s.patterns).toMatchObject({ patternLibrary: true, patternRag: true, reinforcementLearning: true });
    expect(s.policy.policyEngine).toBe(true);
    // routing to the local-first preset; delivery in block mode; collab always
    expect(s.model).toMatchObject({ provider: 'local', modelRouting: true, routingPreset: 'fable-local-opus' });
    expect(s.delivery).toMatchObject({ enforcement: 'block', localMode: 'deliver', runtimeVerify: true });
    expect(s.collaboration.mode).toBe('always');
    // recipes fusion + self-judge; design + reactor; proxy autostart; handsfree aggressive
    expect(s.recipes).toMatchObject({ enabled: true, recipe: 'fusion', allowSelfJudge: true });
    expect(s.design).toMatchObject({ enabled: true, tokenGate: true });
    expect(s.reactor.enabled).toBe(true);
    expect(s.proxy.autostart).toBe(true);
    expect(s.handsfree).toMatchObject({ enabled: true, intensity: 'aggressive' });
    expect(s.hooks).toMatchObject({ sessionStart: true, preCompact: true, taskCompletion: true, autoApproveTools: true });
  });

  it('gates Qdrant-dependent tiers off when Docker is absent', () => {
    const s = maxSelections({ platforms: ['claude'], localModel: null, hasDocker: false });
    expect(s.memory.longTermMemory).toBe(false);
    expect(s.memory.knowledgeGraph).toBe(false);
    expect(s.patterns.patternRag).toBe(false);
    expect(s.patterns.reinforcementLearning).toBe(false);
    // but the always-available features stay on
    expect(s.patterns.patternLibrary).toBe(true);
    expect(s.proxy.autostart).toBe(true);
    expect(s.handsfree.enabled).toBe(true);
  });

  it('leaves routing single-model when no local endpoint is present', () => {
    const s = maxSelections({ platforms: ['claude'], localModel: null, hasDocker: true });
    expect(s.model.provider).toBe('anthropic');
    expect(s.model.routingPreset).toBe('none');
    expect(s.handsfree.intensity).toBe('moderate'); // frontier intensity
  });
});

describe('maxSelections completeness contract (guards silent drift)', () => {
  // Every master switch the "Maximum" profile promises must be ON. When a new
  // top-level feature is added to the wizard, add its switch here so Maximum
  // keeps meaning "everything on" instead of silently inheriting a default.
  it('has every advertised master switch enabled (with docker+local)', () => {
    const s = maxSelections({ platforms: ['claude'], localModel: 'http://localhost:8080/v1', hasDocker: true });
    const on: Array<[string, boolean]> = [
      ['memory.longTerm', s.memory.longTermMemory],
      ['multiAgent.agentMessaging', s.multiAgent.agentMessaging],
      ['patterns.patternRag', s.patterns.patternRag],
      ['policy.policyEngine', s.policy.policyEngine],
      ['model.modelRouting', s.model.modelRouting],
      ['hooks.autoApproveTools', s.hooks.autoApproveTools],
      ['browser.cloakBrowser', s.browser.cloakBrowser],
      ['recipes.enabled', s.recipes.enabled],
      ['delivery.runtimeVerify', s.delivery.runtimeVerify],
      ['concurrency.enabled', s.concurrency.enabled],
      ['design.enabled', s.design.enabled],
      ['reactor.enabled', s.reactor.enabled],
      ['proxy.autostart', s.proxy.autostart],
      ['handsfree.enabled', s.handsfree.enabled],
    ];
    const off = on.filter(([, v]) => v !== true).map(([k]) => k);
    expect(off).toEqual([]);
    // strongest settings
    expect(s.delivery.enforcement).toBe('block');
    expect(s.collaboration.mode).toBe('always');
    expect(s.recipes.recipe).toBe('fusion');
  });
});

describe('minSelections — core only', () => {
  it('keeps essentials on and everything heavy off', () => {
    const s = minSelections({ platforms: ['claude'], localModel: null, hasDocker: false });
    expect(s.memory).toMatchObject({ shortTermMemory: true, longTermMemory: false });
    expect(s.multiAgent).toMatchObject({ coordinationDb: true, worktreeIsolation: true, deployBatching: false });
    expect(s.patterns).toMatchObject({ patternLibrary: true, patternRag: false });
    expect(s.policy.policyEngine).toBe(false);
    expect(s.recipes.enabled).toBe(false);
    expect(s.delivery.enforcement).toBe('advisory');
    expect(s.collaboration.mode).toBe('off');
    expect(s.design.enabled).toBe(false);
    expect(s.reactor.enabled).toBe(false);
    expect(s.proxy.autostart).toBe(false);
    expect(s.handsfree.enabled).toBe(false);
  });
});

describe('applyWizardConfig persists the Maximum bundle to .uap.json', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-maxcfg-'));
    writeFileSync(join(dir, '.uap.json'), JSON.stringify({ version: '1' }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes handsfree, proxy.autostart, delivery block and routing', async () => {
    const s = maxSelections({ platforms: ['claude'], localModel: 'http://localhost:8080/v1', hasDocker: true });
    const written = await applyWizardConfig(dir, s);
    expect(written).toBeTruthy();
    const cfg = JSON.parse(readFileSync(join(dir, '.uap.json'), 'utf8'));
    expect(cfg.handsfree).toMatchObject({ enabled: true, intensity: 'aggressive' });
    expect(cfg.proxy).toMatchObject({ autostart: true });
    expect(cfg.delivery).toMatchObject({ enforcement: 'block' });
    expect(cfg.collaboration).toMatchObject({ mode: 'always' });
    expect(cfg.multiModel?.enabled).toBe(true); // routing preset materialized
  });

  it('minimal bundle does not enable handsfree or proxy autostart', async () => {
    const s = minSelections({ platforms: ['claude'] });
    await applyWizardConfig(dir, s);
    const cfg = JSON.parse(readFileSync(join(dir, '.uap.json'), 'utf8'));
    expect(cfg.handsfree?.enabled).not.toBe(true);
    expect(cfg.proxy?.autostart).toBe(false);
  });
});
