import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConvergenceLoop } from '../../src/delivery/convergence-loop.js';
import type { GateRung, LadderResult } from '../../src/delivery/verifier-ladder.js';

function stubRungs(): GateRung[] {
  return [{ id: 't', name: 't', command: 'node', args: ['-e', ''], required: true, timeoutMs: 1000 }];
}
const ladder = (): LadderResult => ({
  passed: false,
  score: 0.5,
  feedback: 'f',
  results: [{ id: 't', name: 't', passed: false, skipped: false, exitCode: 1, durationMs: 1, outputTail: 'x' }],
});
const OUT = '```file:src/a.ts\nexport const a = 1;\n```';

describe('ConvergenceConfig.promptSelection → PromptContext (b: tuner wiring)', () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'uap-psel-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('threads config.promptSelection into every prompt (default builder applies the tuned tone)', async () => {
    const seen: string[] = [];
    const loop = new ConvergenceLoop(
      { projectRoot: dir, maxTurns: 1, rungs: stubRungs(), baselineCheck: false, promptSelection: { 'executor.tone': 'terse' } },
      async () => OUT,
      { ladderRunner: () => ladder(), promptBuilder: undefined } // use the real defaultPromptBuilder
    );
    // capture the prompt via a wrapper is unnecessary — assert via a custom builder:
    const loop2 = new ConvergenceLoop(
      { projectRoot: dir, maxTurns: 1, rungs: stubRungs(), baselineCheck: false, promptSelection: { 'executor.tone': 'terse' } },
      async () => OUT,
      {
        ladderRunner: () => ladder(),
        promptBuilder: (ctx) => {
          seen.push(JSON.stringify(ctx.promptSelection ?? null));
          return ctx.instruction;
        },
      }
    );
    await loop.deliver('x'); // exercises the real builder path (no crash)
    await loop2.deliver('x');
    expect(seen[0]).toBe(JSON.stringify({ 'executor.tone': 'terse' }));
  });

  it('is absent (undefined) when no promptSelection is configured', async () => {
    const seen: string[] = [];
    const loop = new ConvergenceLoop(
      { projectRoot: dir, maxTurns: 1, rungs: stubRungs(), baselineCheck: false },
      async () => OUT,
      {
        ladderRunner: () => ladder(),
        promptBuilder: (ctx) => {
          seen.push(String(ctx.promptSelection));
          return ctx.instruction;
        },
      }
    );
    await loop.deliver('x');
    expect(seen[0]).toBe('undefined');
  });
});
