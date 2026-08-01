import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExecutionGate } from '../../src/delivery/execution-gate.js';

/**
 * The regression these pin, measured on the Octopus Invaders build (2026-08-01):
 * a whole-file rewrite deleted `window.addEventListener('load', () =>
 * Game.init())`. The artifact still parsed, defined everything, threw nothing,
 * and did nothing. The vm-dom harness fired only click/mousedown/mousemove —
 * never load — so it executed top-level definitions ONLY and reported
 * "booted N script(s) ... clean" for the broken artifact and the working one
 * alike. The sole failing signal was a user-path assertion three journeys later
 * saying "#hud NOT visible", which sent the model rewriting HUD markup for four
 * turns while the real defect was one missing line.
 */

const HTML = `<!DOCTYPE html><html><body>
<canvas id="gameCanvas"></canvas>
<script src="game.js"></script>
</body></html>`;

// Identical module in both cases — only the bootstrap line differs.
const MODULE = `
const Game = (() => {
  let ctx;
  function init() {
    const c = document.getElementById('gameCanvas');
    ctx = c.getContext('2d');
    requestAnimationFrame(loop);
  }
  function loop() { ctx.fillRect(0, 0, 10, 10); requestAnimationFrame(loop); }
  return { init };
})();
`.trim();

const WITH_BOOTSTRAP = `${MODULE}\nwindow.addEventListener('load', () => Game.init());\n`;

describe('execution gate: nothing-started detection', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'exec-gate-'));
    mkdirSync(join(dir, 'web'), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const write = (game: string) => {
    writeFileSync(join(dir, 'web', 'index.html'), HTML);
    writeFileSync(join(dir, 'web', 'game.js'), game);
  };

  it('passes an artifact whose load listener starts the program', async () => {
    write(WITH_BOOTSTRAP);
    const r = await runExecutionGate(dir, { timeoutMs: 20_000 });
    // The point is not merely "passed" — it is that the app's own code RAN.
    // Before the load dispatch, init() was never called and this passed for the
    // wrong reason.
    expect(r.passed).toBe(true);
    expect(r.outputTail).not.toMatch(/nothing started/i);
  }, 30_000);

  it('WARNS on the same artifact with its bootstrap deleted', async () => {
    // Advisory, not blocking: the identical signature is produced by code that
    // legitimately ran and did little, and blocking on it failed three real
    // fixtures in execution-gate.test.ts. The value is that the model is TOLD.
    write(MODULE); // defines Game, never invokes init
    const r = await runExecutionGate(dir, { timeoutMs: 20_000 });
    expect(r.outputTail).toMatch(/nothing started/i);
    // Must name the fix, not just the symptom — the whole point of this signal.
    expect(r.outputTail).toMatch(/never invokes it|actually STARTS it/);
  }, 30_000);

  it('the two artifacts are DISTINGUISHABLE, which they were not before', async () => {
    // Before the load dispatch, the gate reported the same "booted N script(s)
    // ... clean" for both, so the broken artifact was invisible here.
    write(WITH_BOOTSTRAP);
    const good = await runExecutionGate(dir, { timeoutMs: 20_000 });
    write(MODULE);
    const bad = await runExecutionGate(dir, { timeoutMs: 20_000 });
    expect(good.outputTail).not.toBe(bad.outputTail);
    expect(/nothing started/i.test(good.outputTail)).toBe(false);
    expect(/nothing started/i.test(bad.outputTail)).toBe(true);
  }, 60_000);

  it('a top-level init call also counts as started', async () => {
    // Not every app uses a load listener; the probe must accept any entry style.
    write(`${MODULE}\nGame.init();\n`);
    const r = await runExecutionGate(dir, { timeoutMs: 20_000 });
    expect(r.outputTail).not.toMatch(/nothing started/i);
  }, 30_000);

  it('an app that only registers a listener counts as started', async () => {
    // No animation frame at all — a form/UI page. Registering a handler is
    // proof an entry point ran, so this must not be called dead.
    write(`document.addEventListener('click', () => {});`);
    const r = await runExecutionGate(dir, { timeoutMs: 20_000 });
    expect(r.outputTail).not.toMatch(/nothing started/i);
  }, 30_000);
});
