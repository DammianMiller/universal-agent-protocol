import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  captureIntegrity,
  verifyAndRestore,
  integrityViolationFeedback,
} from '../../src/delivery/integrity.js';
import { ConvergenceLoop } from '../../src/delivery/convergence-loop.js';

const block = (path: string, content: string): string =>
  ['```file:' + path, content, '```'].join('\n');

describe('captureIntegrity / verifyAndRestore', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'integrity-'));
    mkdirSync(join(dir, 'test'), { recursive: true });
    writeFileSync(join(dir, 'test', 'spec.test.mjs'), 'ORIGINAL');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reports clean when nothing changed', () => {
    const snap = captureIntegrity(dir, ['test/spec.test.mjs']);
    const check = verifyAndRestore(dir, snap);
    expect(check.tampered).toEqual([]);
  });

  it('detects and restores a runtime-modified protected file', () => {
    const snap = captureIntegrity(dir, ['test/spec.test.mjs']);
    writeFileSync(join(dir, 'test', 'spec.test.mjs'), 'GUTTED AT RUNTIME');
    const check = verifyAndRestore(dir, snap);
    expect(check.tampered).toEqual(['test/spec.test.mjs']);
    expect(check.restored).toEqual(['test/spec.test.mjs']);
    expect(readFileSync(join(dir, 'test', 'spec.test.mjs'), 'utf-8')).toBe('ORIGINAL');
  });

  it('restores a deleted protected file', () => {
    const snap = captureIntegrity(dir, ['test/spec.test.mjs']);
    rmSync(join(dir, 'test', 'spec.test.mjs'));
    const check = verifyAndRestore(dir, snap);
    expect(check.restored).toEqual(['test/spec.test.mjs']);
    expect(readFileSync(join(dir, 'test', 'spec.test.mjs'), 'utf-8')).toBe('ORIGINAL');
  });

  it('removes a runtime-fabricated reserved oracle (absent at capture)', () => {
    const snap = captureIntegrity(dir, ['goldens/output.json']);
    mkdirSync(join(dir, 'goldens'), { recursive: true });
    writeFileSync(join(dir, 'goldens', 'output.json'), '{"fabricated": true}');
    const check = verifyAndRestore(dir, snap);
    expect(check.tampered).toEqual(['goldens/output.json']);
    expect(existsSync(join(dir, 'goldens', 'output.json'))).toBe(false);
  });

  it('renders violation feedback naming the files', () => {
    const text = integrityViolationFeedback({
      tampered: ['helpers/oracle.mjs'],
      restored: ['helpers/oracle.mjs'],
      unrecoverable: [],
    });
    expect(text).toContain('GATE INTEGRITY VIOLATION');
    expect(text).toContain('helpers/oracle.mjs');
    expect(text).toContain('restored');
  });
});

describe('ConvergenceLoop integrity guard (end-to-end)', () => {
  it('discards a green gate result when the gate run tampered with a protected spec', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'integrity-loop-'));
    try {
      mkdirSync(join(dir, 'test'), { recursive: true });
      writeFileSync(join(dir, 'test', 'spec.test.mjs'), 'ORIGINAL');

      const loop = new ConvergenceLoop(
        {
          projectRoot: dir,
          rungs: [{ id: 'g', name: 'gate', command: 'true', required: true }],
          maxTurns: 1,
          baselineCheck: false,
        },
        // Model emits an innocuous source file (passes the applier filter)…
        async () => block('src/impl.mjs', 'export const x = 1;'),
        {
          // …but the "gate run" (model-authored test executing) guts the spec
          // and reports green — exactly the runtime-bypass attack.
          ladderRunner: () => {
            writeFileSync(join(dir, 'test', 'spec.test.mjs'), 'while(0){} // gutted');
            return { passed: true, score: 1, results: [], feedback: 'all green' };
          },
        }
      );

      const result = await loop.deliver('make tests pass');
      expect(result.success).toBe(false);
      expect(result.finalFeedback).toContain('GATE INTEGRITY VIOLATION');
      expect(result.finalFeedback).toContain('test/spec.test.mjs');
      expect(readFileSync(join(dir, 'test', 'spec.test.mjs'), 'utf-8')).toBe('ORIGINAL');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves honest green results untouched', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'integrity-clean-'));
    try {
      mkdirSync(join(dir, 'test'), { recursive: true });
      writeFileSync(join(dir, 'test', 'spec.test.mjs'), 'ORIGINAL');
      const loop = new ConvergenceLoop(
        {
          projectRoot: dir,
          rungs: [{ id: 'g', name: 'gate', command: 'true', required: true }],
          maxTurns: 1,
          baselineCheck: false,
        },
        async () => block('src/impl.mjs', 'export const x = 1;'),
        { ladderRunner: () => ({ passed: true, score: 1, results: [], feedback: '' }) }
      );
      const result = await loop.deliver('task');
      expect(result.success).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
