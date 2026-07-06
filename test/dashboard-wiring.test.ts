/**
 * Dashboard data-wiring: every panel must reflect real config/state or an honest
 * empty — never fabricated placeholder values. Covers the de-fabrication of the
 * model panel and the frontier-cost counterfactual.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { getModelData } from '../src/dashboard/data-service.js';
import { frontierCost } from '../src/dashboard/savings.js';

describe('frontierCost', () => {
  it('returns the frontier (opus) $/1M rates, not zero', () => {
    const fc = frontierCost();
    expect(fc.in).toBeGreaterThan(0);
    expect(fc.out).toBeGreaterThan(fc.in); // output tokens cost more than input
  });
});

describe('getModelData — honest, config-driven (no fabricated defaults)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'uap-model-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const writeConfig = (multiModel: unknown) =>
    writeFileSync(join(dir, '.uap.json'), JSON.stringify({ version: '1.0.0', project: { name: 'test' }, multiModel }));

  it('does NOT fabricate costOptimization when the project has not configured it', () => {
    writeConfig({ enabled: true, roles: { planner: 'opus-4.8' } }); // no costOptimization block
    const m = getModelData(dir);
    // Honest zeros -> the HTML renders "N/A", not a fake 90/20/3.
    expect(m.costOptimization.targetReduction).toBe(0);
    expect(m.costOptimization.maxPerformanceDegradation).toBe(0);
    expect(m.costOptimization.enabled).toBe(false);
  });

  it('surfaces REAL costOptimization values when they are configured', () => {
    writeConfig({ enabled: true, costOptimization: { enabled: true, targetReduction: 42, maxPerformanceDegradation: 7, fallbackThreshold: 2 } });
    const m = getModelData(dir);
    expect(m.costOptimization).toMatchObject({ enabled: true, targetReduction: 42, maxPerformanceDegradation: 7 });
  });

  it('does NOT fabricate 90/20/3 when costOptimization is configured but partial', () => {
    // A costOptimization object that omits fields must fall back to honest zeros
    // (renders N/A), never the legacy 90/20/3 placeholders.
    writeConfig({ enabled: true, costOptimization: { enabled: true } });
    const m = getModelData(dir);
    expect(m.costOptimization.enabled).toBe(true);
    expect(m.costOptimization.targetReduction).toBe(0);
    expect(m.costOptimization.maxPerformanceDegradation).toBe(0);
    expect(m.costOptimization.fallbackThreshold).toBe(0);
  });

  it('returns honest-empty roles / availableModels when multiModel is unconfigured (no opus-4.6/qwen35 seed)', () => {
    writeConfig(undefined);
    const m = getModelData(dir);
    expect(m.roles).toEqual({ planner: '', executor: '', reviewer: '', fallback: '' });
    expect(m.availableModels).toEqual([]);
    expect(m.enabled).toBe(false);
  });

  it('passes tier-form routingMatrix (complexity -> model string) through intact', () => {
    // cost/speed/sonnet-5 presets write a string-per-tier matrix; the panel must
    // surface it, not blank it out.
    writeConfig({ enabled: true, routingMatrix: { low: 'qwen36-a3b', high: 'opus-4.8' } });
    const m = getModelData(dir);
    expect(m.routingMatrix).toEqual({ low: 'qwen36-a3b', high: 'opus-4.8' });
  });

  it('normalizes ModelConfig-object entries in availableModels to ids (no [object Object])', () => {
    writeConfig({ enabled: true, models: [{ id: 'opus-4.8' }, 'qwen36-a3b'] });
    const m = getModelData(dir);
    expect(m.availableModels).toEqual(['opus-4.8', 'qwen36-a3b']);
  });

  it('reflects configured roles + models live (not the stale opus-4.6/qwen35 defaults)', () => {
    writeConfig({ enabled: true, roles: { planner: 'fable-5', executor: 'haiku-4.5', reviewer: 'opus-4.8', fallback: 'qwen36-a3b' }, models: ['fable-5', 'haiku-4.5', 'opus-4.8', 'qwen36-a3b'], routingStrategy: 'performance-first' });
    const m = getModelData(dir);
    expect(m.roles.planner).toBe('fable-5');
    expect(m.roles.executor).toBe('haiku-4.5');
    expect(m.availableModels).toContain('opus-4.8');
    expect(m.strategy).toBe('performance-first');
  });

  it('serves live recentRoutingDecisions from task_outcomes (proxy telemetry), not a stub', () => {
    const mdir = join(dir, 'agents', 'data', 'memory');
    mkdirSync(mdir, { recursive: true });
    const db = new Database(join(mdir, 'model_analytics.db'));
    db.exec('CREATE TABLE task_outcomes (id INTEGER PRIMARY KEY AUTOINCREMENT, modelId TEXT, taskType TEXT, complexity TEXT, success INTEGER, durationMs INTEGER, tokensIn INTEGER, tokensOut INTEGER, cost REAL, taskId TEXT, timestamp TEXT)');
    db.prepare('INSERT INTO task_outcomes (modelId,taskType,complexity,success,durationMs,tokensIn,tokensOut,cost,taskId,timestamp) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run('qwen36-a3b', 'proxy', 'medium', 1, 0, 100, 20, 0, 't', '2026-07-06T00:00:00Z');
    db.close();
    writeConfig({ enabled: false });
    const m = getModelData(dir);
    expect(m.recentRoutingDecisions.length).toBe(1);
    expect(m.recentRoutingDecisions[0].modelUsed).toBe('qwen36-a3b');
    // Honest empty reasoning — task_outcomes has no reasoning column, so we do
    // NOT stamp every decision 'auto-select'.
    expect(m.recentRoutingDecisions[0].reasoning).toBe('');
    // availableModels is derived from REAL analytics when config lists none.
    expect(m.availableModels).toEqual(['qwen36-a3b']);
    expect(m.sessionUsage.length).toBe(1);
    // A project with routing telemetry reads as effectively-enabled even if the
    // config flag is off — because real routing IS happening.
    expect(m.enabled).toBe(true);
  });
});

describe('dashboard.html — no stale hardcoded model map / cost-opt unit bug', () => {
  const html = () => readFileSync('web/dashboard.html', 'utf-8');
  it('MODEL_NAMES includes the current canonical models', () => {
    const s = html();
    for (const id of ['fable-5', 'opus-4.8', 'haiku-4.5', 'qwen36-a3b']) {
      expect(s).toContain(`'${id}'`);
    }
  });
  it('cost-optimization percent is rendered without the *100 unit bug', () => {
    expect(html()).not.toContain('co.targetReduction*100');
    expect(html()).not.toContain('co.maxPerformanceDegradation*100');
  });
});
