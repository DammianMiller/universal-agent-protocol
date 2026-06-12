import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConvergenceLoop } from '../../src/delivery/convergence-loop.js';
import type { GateRung } from '../../src/delivery/verifier-ladder.js';

/**
 * Full-stack convergence: real applier writing model-emitted files, real
 * verifier ladder spawning a real gate command, iterating until the gate
 * goes green.
 */
describe('convergence loop end-to-end', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-e2e-'));
    // Gate: passes only when answer.txt contains exactly "42"
    writeFileSync(
      join(dir, 'check.js'),
      [
        "const { readFileSync } = require('fs');",
        'let content = "";',
        "try { content = readFileSync('answer.txt', 'utf-8').trim(); } catch { console.error('answer.txt missing'); process.exit(1); }",
        "if (content !== '42') { console.error(`expected 42, got: ${content}`); process.exit(1); }",
      ].join('\n')
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const gate: GateRung = {
    id: 'check',
    name: 'Answer check',
    command: 'node',
    args: ['check.js'],
    required: true,
    timeoutMs: 30_000,
  };

  it('a model that reads gate feedback converges to delivery', async () => {
    // Simulated weak model: first attempt is wrong; once feedback shows the
    // gate error ("expected 42"), the retry emits the right content.
    const loop = new ConvergenceLoop(
      { projectRoot: dir, maxTurns: 3, rungs: [gate] },
      async (prompt) => {
        if (prompt.includes('expected 42')) {
          return '```file:answer.txt\n42\n```';
        }
        return '```file:answer.txt\nwrong guess\n```';
      }
    );

    const result = await loop.deliver('write the answer to answer.txt');
    expect(result.alreadyDelivered).toBe(false);
    expect(result.success).toBe(true);
    expect(result.turns).toBe(2);
    expect(result.history[0].passed).toBe(false);
    expect(result.history[1].passed).toBe(true);
  });

  it('a model that never improves exhausts the turn budget with honest failure', async () => {
    const loop = new ConvergenceLoop(
      { projectRoot: dir, maxTurns: 2, rungs: [gate] },
      async () => '```file:answer.txt\nstill wrong\n```'
    );

    const result = await loop.deliver('write the answer');
    expect(result.success).toBe(false);
    expect(result.turns).toBe(2);
    expect(result.finalFeedback).toContain('expected 42');
  });
});
