/**
 * System-1 classifier foundation (uplift §6) — interface contract, baseline
 * backend determinism, threshold application, shadow-log privacy, and the
 * CLI contract including the 50ms p95 latency budget.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  assessWithThresholds,
  defaultBackend,
  loadThresholds,
  recordShadow,
  shadowLogPath,
  BUILTIN_QUESTIONS,
  ClassifyError,
  type ShadowRecord,
} from '../src/classify/index.js';
import { classifyCommand } from '../src/cli/classify.js';

const OOM_STATE =
  'llama-server crashed with SIGABRT: KV cache allocation failed, the service is ' +
  'stuck restarting and the GPU is out of memory. Deliver gate blocked, evidence missing.';

const CLEAN_STATE = 'Docs typo fixed and committed; all tests pass on the branch.';

describe('baseline backend', () => {
  const backend = defaultBackend();

  it('answers every built-in question with the right shape', () => {
    const r = backend.assess(CLEAN_STATE, BUILTIN_QUESTIONS);
    for (const q of BUILTIN_QUESTIONS) {
      const a = r[q.name];
      expect(a.backend).toBe(backend.name);
      expect(a.probability).toBeGreaterThanOrEqual(0);
      expect(a.probability).toBeLessThanOrEqual(1);
      expect(a.confidence).toBeGreaterThanOrEqual(0);
      expect(a.confidence).toBeLessThanOrEqual(1);
    }
    expect(typeof r['escalation-risk'].value).toBe('boolean');
    expect(typeof r['task-risk'].value).toBe('number');
    expect(BUILTIN_QUESTIONS.find((q) => q.name === 'action-class')!.options).toContain(
      r['action-class'].value,
    );
  });

  it('separates incident language from clean states on escalation-risk', () => {
    const incident = backend.assess(OOM_STATE, BUILTIN_QUESTIONS)['escalation-risk'];
    const clean = backend.assess(CLEAN_STATE, BUILTIN_QUESTIONS)['escalation-risk'];
    expect(incident.probability).toBeGreaterThan(0.5);
    expect(clean.probability).toBeLessThan(0.5);
    expect(incident.value).toBe(true);
    expect(clean.value).toBe(false);
  });

  it('scores destructive operations riskier than benign ones', () => {
    const danger = backend.assess(
      'rm -rf the production database and force push over master, then rotate all credentials',
      BUILTIN_QUESTIONS,
    )['task-risk'];
    const benign = backend.assess('rename a local variable in a test helper', BUILTIN_QUESTIONS)['task-risk'];
    expect(danger.value as number).toBeGreaterThan(benign.value as number);
  });

  it('is deterministic — same input, same output', () => {
    const a = backend.assess(OOM_STATE, BUILTIN_QUESTIONS);
    const b = backend.assess(OOM_STATE, BUILTIN_QUESTIONS);
    expect(a).toEqual(b);
  });

  it('reports low confidence on empty states rather than guessing confidently', () => {
    const a = backend.assess('', BUILTIN_QUESTIONS)['escalation-risk'];
    expect(a.confidence).toBe(0);
  });

  it('action-class: incident states escalate, pure-destructive states stop', () => {
    const incident = backend.assess(OOM_STATE, BUILTIN_QUESTIONS)['action-class'];
    expect(incident.value).toBe('escalate');
    // Zero escalation vocabulary + dense destructive vocabulary must be
    // reachable as 'stop' (regression: stop used to be dominated by escalate).
    const destructive = backend.assess(
      'rm -rf production database, drop all tables, wipe the disks, destroy backups',
      BUILTIN_QUESTIONS,
    )['action-class'];
    expect(destructive.value).toBe('stop');
  });

  it('refuses questions outside the built-in registry — no silent mis-scope', () => {
    expect(() =>
      backend.assess('state', [{ name: 'verbatim-worthy', kind: 'noul', prompt: 'x' }]),
    ).toThrow(ClassifyError);
  });
});

describe('thresholds (reviewed policy config)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-classify-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('tau moves the noul decision boundary', () => {
    const state = 'the build failed once but recovered cleanly on retry';
    const loose = assessWithThresholds(state, BUILTIN_QUESTIONS, { 'escalation-risk': { tau: 0.2, confidenceFloor: 0 } });
    const strict = assessWithThresholds(state, BUILTIN_QUESTIONS, { 'escalation-risk': { tau: 0.95, confidenceFloor: 0 } });
    expect(loose[0].value).toBe(true);
    expect(strict[0].value).toBe(false);
  });

  it('defers below the confidence floor — heuristic decides', () => {
    const d = assessWithThresholds('tiny', BUILTIN_QUESTIONS, {
      'escalation-risk': { tau: 0.5, confidenceFloor: 0.99 },
    });
    expect(d[0].defer).toBe(true);
  });

  it('loads config from the project config/ directory and validates loudly', () => {
    expect(loadThresholds(dir)).toEqual({}); // none declared — defaults apply
    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(
      join(dir, 'config', 'classify-thresholds.json'),
      JSON.stringify({ version: 1, questions: { 'escalation-risk': { tau: 0.7, confidenceFloor: 0.4 } } }),
    );
    expect(loadThresholds(dir)['escalation-risk'].tau).toBe(0.7);
    writeFileSync(join(dir, 'config', 'classify-thresholds.json'), '{"version":2}');
    expect(() => loadThresholds(dir)).toThrow(ClassifyError);
    expect(() => loadThresholds(dir, join(dir, 'nope.json'))).toThrow(/not found/);
  });
});

describe('shadow log', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-shadow-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('records hash + result, never the raw state text', () => {
    const backend = defaultBackend();
    const secretish = 'token hunter2 appeared in the failed deploy log';
    recordShadow(dir, secretish, BUILTIN_QUESTIONS, backend.assess(secretish, BUILTIN_QUESTIONS));
    const path = shadowLogPath(dir);
    expect(existsSync(path)).toBe(true);
    const raw = readFileSync(path, 'utf-8');
    expect(raw).not.toContain('hunter2');
    const rec = JSON.parse(raw.trim()) as ShadowRecord;
    expect(rec.v).toBe(1);
    expect(rec.stateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rec.questions).toEqual(BUILTIN_QUESTIONS.map((q) => q.name));
    expect(rec.result['escalation-risk'].value).toBe(true); // "failed" fires
    expect(rec.heuristicDecision).toBeUndefined();
  });

  it('records the heuristic decision when a consumer supplies one', () => {
    const backend = defaultBackend();
    recordShadow(dir, 'gate blocked', BUILTIN_QUESTIONS, backend.assess('gate blocked', BUILTIN_QUESTIONS), {
      heuristicDecision: { 'escalation-risk': true, source: 'supervisor-heuristic' },
    });
    const rec = JSON.parse(readFileSync(shadowLogPath(dir), 'utf-8').trim()) as ShadowRecord;
    expect(rec.heuristicDecision).toEqual({ 'escalation-risk': true, source: 'supervisor-heuristic' });
  });
});

describe('classify CLI', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-classify-cli-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  it('assesses and can shadow-log from the CLI', async () => {
    await classifyCommand({ projectDir: dir, state: OOM_STATE, shadow: true });
    expect(process.exitCode).toBeUndefined();
    expect(existsSync(shadowLogPath(dir))).toBe(true);
  });

  it('rejects unknown questions and missing state with exit 1 via the CLI wrapper contract', async () => {
    await expect(classifyCommand({ projectDir: dir, state: 'x', question: 'nope' })).rejects.toThrow(ClassifyError);
    await expect(classifyCommand({ projectDir: dir })).rejects.toThrow(/state text is required/);
  });

  it('meets the 50ms p95 latency budget', async () => {
    await classifyCommand({ projectDir: dir, bench: 300 });
    expect(process.exitCode).toBeUndefined(); // bench sets exitCode=1 on FAIL
  });

  it('--question filters to one assessment and --json pins the consumer shape', async () => {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (s: unknown) => logs.push(String(s));
    try {
      await classifyCommand({ projectDir: dir, state: OOM_STATE, question: 'escalation-risk', json: true });
    } finally {
      console.log = orig;
    }
    const out = JSON.parse(logs.join('\n'));
    expect(out.reportVersion).toBe(1);
    expect(out.backend).toBe('baseline-tfidf-v1');
    expect(out.assessments).toHaveLength(1);
    expect(out.assessments[0].name).toBe('escalation-risk');
    expect(out.assessments[0].value).toBe(true);
  });

  it('--bench --json emits the machine-readable bench report', async () => {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (s: unknown) => logs.push(String(s));
    try {
      await classifyCommand({ projectDir: dir, bench: 50, json: true });
    } finally {
      console.log = orig;
    }
    const out = JSON.parse(logs.join('\n'));
    expect(out.bench.pass).toBe(true);
    expect(out.bench.budgetMs).toBe(50);
  });
});
