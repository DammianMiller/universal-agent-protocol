import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  runAcceptanceGate,
  gatherEvidence,
  extractJsonObject,
  formatAcceptanceReport,
} from '../../src/delivery/acceptance-judge.js';

const SPEC = 'Build a counter: increment() returns count+1, and reset() sets it to 0.';

describe('extractJsonObject', () => {
  it('extracts a balanced JSON object with nested arrays, tolerating prose/fences', () => {
    const text = 'Here is my verdict:\n```json\n{"criteria":[{"requirement":"a","met":true,"reason":"x"}],"pass":true}\n```\nthanks';
    const o = extractJsonObject(text);
    expect(o).not.toBeNull();
    expect((o!.criteria as unknown[]).length).toBe(1);
    expect(o!.pass).toBe(true);
  });

  it('returns null when there is no JSON object', () => {
    expect(extractJsonObject('no json here')).toBeNull();
  });

  it('handles braces inside strings without truncating early', () => {
    const o = extractJsonObject('{"reason":"uses {x} token","pass":false}');
    expect(o!.reason).toBe('uses {x} token');
    expect(o!.pass).toBe(false);
  });
});

describe('gatherEvidence', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'acc-ev-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('collects source files with path headers and skips node_modules', () => {
    mkdirSync(join(dir, 'js'), { recursive: true });
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(dir, 'js/counter.js'), 'module.exports = { increment: () => 1 };');
    writeFileSync(join(dir, 'node_modules/pkg/index.js'), 'SHOULD_NOT_APPEAR');
    const ev = gatherEvidence(dir);
    expect(ev).toContain('js/counter.js');
    expect(ev).toContain('increment');
    expect(ev).not.toContain('SHOULD_NOT_APPEAR');
  });
});

describe('runAcceptanceGate', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'acc-'));
    writeFileSync(join(dir, 'counter.js'), 'exports.increment = (n) => n + 1; exports.reset = () => 0;');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('passes when the judge marks every criterion met', async () => {
    const executor = async () =>
      '{"criteria":[{"requirement":"increment returns count+1","met":true,"reason":"present"},{"requirement":"reset sets 0","met":true,"reason":"present"}],"pass":true}';
    const r = await runAcceptanceGate({ spec: SPEC, projectRoot: dir, executor });
    expect(r.passed).toBe(true);
    expect(r.score).toBe(1);
    expect(r.criteria).toHaveLength(2);
  });

  it('fails when any criterion is unmet (even if the model claims pass)', async () => {
    const executor = async () =>
      '{"criteria":[{"requirement":"increment","met":true,"reason":"ok"},{"requirement":"reset","met":false,"reason":"missing"}],"pass":true}';
    const r = await runAcceptanceGate({ spec: SPEC, projectRoot: dir, executor });
    expect(r.passed).toBe(false);
    expect(r.score).toBe(0.5);
    expect(formatAcceptanceReport(r)).toMatch(/MISS/);
  });

  it('fails OPEN (passed) on an unparseable verdict — never wedges on judge nondeterminism', async () => {
    const executor = async () => 'I think it looks pretty good overall!';
    const r = await runAcceptanceGate({ spec: SPEC, projectRoot: dir, executor });
    expect(r.passed).toBe(true);
    expect(r.parseError).toBeTruthy();
  });

  it('fails OPEN when the executor throws', async () => {
    const executor = async () => {
      throw new Error('model down');
    };
    const r = await runAcceptanceGate({ spec: SPEC, projectRoot: dir, executor });
    expect(r.passed).toBe(true);
    expect(r.parseError).toMatch(/executor error/);
  });

  it('passes (no-op) when there is no source evidence', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'acc-empty-'));
    const executor = async () => '{}';
    const r = await runAcceptanceGate({ spec: SPEC, projectRoot: empty, executor });
    expect(r.passed).toBe(true);
    expect(r.parseError).toMatch(/no source evidence/);
    rmSync(empty, { recursive: true, force: true });
  });
});
