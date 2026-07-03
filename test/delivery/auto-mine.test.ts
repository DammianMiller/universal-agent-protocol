/**
 * Weakness → practice feedback: mined failure patterns become injectable
 * guidance so past failures change future prompts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import {
  weaknessGuidance,
  loadPersistedWeaknesses,
  autoMineHaloTraces,
} from '../../src/delivery/auto-mine.js';
import type { WeaknessReport } from '../../src/self-harness/weakness.js';

function report(kind: string, frequency: number): WeaknessReport {
  return {
    signature: `sig-${kind}`,
    kind: kind as WeaknessReport['kind'],
    model: 'm',
    frequency,
    affectedTasks: ['t'],
    hypothesis: 'h',
    evidence: [],
  };
}

describe('weaknessGuidance', () => {
  it('maps known failure kinds to imperative guidance, top-N only', () => {
    const lines = weaknessGuidance(
      [report('verify.fail', 9), report('toolcall.path.garbled', 4), report('agent.timeout', 3)],
      2
    );
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain('FAILED the completion gates');
    expect(lines[1]).toContain('file paths');
  });

  it('drops unknown kinds and returns [] for no reports', () => {
    expect(weaknessGuidance([])).toEqual([]);
    expect(weaknessGuidance([report('made.up.kind', 5)])).toEqual([]);
  });
});

describe('loadPersistedWeaknesses ⇄ autoMineHaloTraces roundtrip', () => {
  let dir: string;
  const saved = { path: process.env.UAP_HALO_TRACE_PATH, mine: process.env.UAP_HALO_AUTOMINE };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-mine-'));
    process.env.UAP_HALO_TRACE_PATH = join(dir, 'halo', 'traces.jsonl');
    delete process.env.UAP_HALO_AUTOMINE;
  });
  afterEach(() => {
    if (saved.path === undefined) delete process.env.UAP_HALO_TRACE_PATH;
    else process.env.UAP_HALO_TRACE_PATH = saved.path;
    if (saved.mine === undefined) delete process.env.UAP_HALO_AUTOMINE;
    else process.env.UAP_HALO_AUTOMINE = saved.mine;
    rmSync(dir, { recursive: true, force: true });
  });

  it('mined reports persist and load back as guidance for the next run', () => {
    const tracePath = process.env.UAP_HALO_TRACE_PATH!;
    mkdirSync(dirname(tracePath), { recursive: true });
    const failSpan = JSON.stringify({
      name: 'delivery.turn',
      status: { code: 'STATUS_CODE_ERROR' },
      attributes: { 'delivery.gates_failed': 'test', 'inference.project_id': 'demo' },
    });
    writeFileSync(tracePath, Array.from({ length: 3 }, () => failSpan).join('\n') + '\n');

    const mined = autoMineHaloTraces('test-model', 3);
    expect(mined.reports.length).toBeGreaterThan(0);
    expect(mined.reports[0].kind).toBe('verify.fail');
    expect(mined.reportPath).not.toBeNull();

    // Next run: the persisted report loads and yields guidance.
    const loaded = loadPersistedWeaknesses();
    expect(loaded.length).toBeGreaterThan(0);
    const guidance = weaknessGuidance(loaded);
    expect(guidance[0]).toContain('completion gates');
  });

  it('load fails soft on a missing/corrupt report file', () => {
    expect(loadPersistedWeaknesses()).toEqual([]);
    const badPath = process.env.UAP_HALO_TRACE_PATH!.replace(/[^/\\]+$/, 'weaknesses.json');
    mkdirSync(dirname(badPath), { recursive: true });
    writeFileSync(badPath, 'not json');
    expect(loadPersistedWeaknesses()).toEqual([]);
  });
});
