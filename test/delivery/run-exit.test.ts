/**
 * A deliver run must be able to say how it DIED.
 *
 * Live symptom (2026-07-14): client-spawned deliver runs vanished within seconds
 * while the identical binary run from a shell worked fine. Every corpse looked
 * the same — `status: 'running'`, a dead pid, nothing else — so there was no way
 * to tell a live mission from one that had been killed, let alone learn who
 * killed it. `status: 'running'` is deliberately left behind (it is what
 * `--resume` looks for), so the fix is not to change the status but to RECORD
 * the death alongside it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { saveRunState, loadRunState } from '../../src/delivery/run-state.js';
import { recordExit, formatExitLine, appendExitLog } from '../../src/delivery/run-exit.js';

const RUN_ID = 'run-20260714T000000-abc123';

const seedRun = (dir: string): void => {
  saveRunState({
    runId: RUN_ID,
    instruction: 'x',
    presetId: 'p',
    projectRoot: dir,
    status: 'running',
    pid: 4242,
    ppid: 111,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
};

describe('run-exit — the process becomes its own witness', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'uap-rx-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('records a signal death onto the run WITHOUT breaking resumability', () => {
    seedRun(dir);
    recordExit(dir, RUN_ID, {
      at: '2026-07-14T06:00:00.000Z',
      signal: 'SIGHUP',
      ppid: 111,
      reason: 'parent closed our process group (client tore down the spawn)',
    });
    const s = loadRunState(dir, RUN_ID) as any;
    expect(s.exit.signal).toBe('SIGHUP');
    expect(s.exit.ppid).toBe(111);
    // status stays 'running' — that IS the resumable marker.
    expect(s.status).toBe('running');
  });

  it('appends a greppable line to .uap/deliver-exits.log', () => {
    appendExitLog(dir, RUN_ID, { at: '2026-07-14T06:00:00.000Z', signal: 'SIGTERM', ppid: 9, reason: 'killed by SIGTERM' });
    const log = readFileSync(join(dir, '.uap', 'deliver-exits.log'), 'utf-8');
    expect(log).toContain(`run=${RUN_ID}`);
    expect(log).toContain('signal=SIGTERM');
    expect(log).toContain('ppid=9');
  });

  it('formats a normal exit by CODE, not signal', () => {
    const line = formatExitLine(RUN_ID, { at: 'T', code: 0, ppid: 5, reason: 'exited normally' });
    expect(line).toContain('code=0');
    expect(line).not.toContain('signal=');
  });

  it('logging never throws on an unwritable project (must not break a run)', () => {
    // A regular FILE used as a project root: every write under it fails with
    // ENOTDIR. Recording an exit is best-effort and must never take a run down
    // with it.
    const notADir = join(dir, 'imposter');
    writeFileSync(notADir, 'i am not a directory');
    expect(() => appendExitLog(notADir, RUN_ID, { at: 'T', code: 1, reason: 'x' })).not.toThrow();
    expect(() => recordExit(notADir, RUN_ID, { at: 'T', code: 1, reason: 'x' })).not.toThrow();
  });

  it('END TO END: a noted reason replaces the anonymous exit code', () => {
    // The orphan guard's exact shape: declare a cause, then exit(130). Without
    // the note this records "exited with code 130", which names no cause and
    // leaves the follower nothing to act on.
    const cli = new URL('../../dist/delivery/run-exit.js', import.meta.url).pathname;
    const state = new URL('../../dist/delivery/run-state.js', import.meta.url).pathname;
    const script = `
      const { installRunExitRecorder, noteExitReason } = require(${JSON.stringify(cli)});
      const { saveRunState } = require(${JSON.stringify(state)});
      const runId = ${JSON.stringify(RUN_ID)};
      saveRunState({ runId, instruction:'x', presetId:'p', projectRoot: process.cwd(),
        status:'running', pid: process.pid, ppid: process.ppid,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      installRunExitRecorder(process.cwd(), runId);
      noteExitReason('stopped by the orphan guard: the session that started this run (pid 99) exited');
      process.exit(130);
    `;
    spawnSync('node', ['-e', script], { cwd: dir, encoding: 'utf-8', timeout: 20_000 });

    const s = loadRunState(dir, RUN_ID) as any;
    expect(s.exit.code).toBe(130);
    expect(s.exit.reason).toContain('orphan guard');
    expect(s.exit.reason).not.toContain('exited with code');
  });

  it('END TO END: an observed SIGNAL beats a predicted reason', () => {
    // A note says why we EXPECT to stop; a signal is a cause observed directly.
    // If both are present the signal is the more reliable witness.
    const cli = new URL('../../dist/delivery/run-exit.js', import.meta.url).pathname;
    const state = new URL('../../dist/delivery/run-state.js', import.meta.url).pathname;
    const script = `
      const { installRunExitRecorder, noteExitReason } = require(${JSON.stringify(cli)});
      const { saveRunState } = require(${JSON.stringify(state)});
      const runId = ${JSON.stringify(RUN_ID)};
      saveRunState({ runId, instruction:'x', presetId:'p', projectRoot: process.cwd(),
        status:'running', pid: process.pid, ppid: process.ppid,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      installRunExitRecorder(process.cwd(), runId);
      noteExitReason('a prediction that never happened');
      process.kill(process.pid, 'SIGTERM');
      setTimeout(() => {}, 2000);
    `;
    spawnSync('node', ['-e', script], { cwd: dir, encoding: 'utf-8', timeout: 20_000 });

    const s = loadRunState(dir, RUN_ID) as any;
    expect(s.exit.signal).toBe('SIGTERM');
    expect(s.exit.reason).toContain('SIGTERM');
    expect(s.exit.reason).not.toContain('prediction');
  });

  it('END TO END: a killed process records its OWN death (SIGHUP → parent teardown)', () => {
    // The exact live scenario: the parent tears down the spawned deliver.
    const cli = new URL('../../dist/delivery/run-exit.js', import.meta.url).pathname;
    const state = new URL('../../dist/delivery/run-state.js', import.meta.url).pathname;
    const script = `
      const { installRunExitRecorder } = require(${JSON.stringify(cli)});
      const { saveRunState } = require(${JSON.stringify(state)});
      const runId = ${JSON.stringify(RUN_ID)};
      saveRunState({ runId, instruction:'x', presetId:'p', projectRoot: process.cwd(),
        status:'running', pid: process.pid, ppid: process.ppid,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      installRunExitRecorder(process.cwd(), runId);
      process.kill(process.pid, 'SIGHUP');
      setTimeout(() => {}, 2000);
    `;
    spawnSync('node', ['-e', script], { cwd: dir, encoding: 'utf-8', timeout: 20_000 });

    const logPath = join(dir, '.uap', 'deliver-exits.log');
    expect(existsSync(logPath)).toBe(true);
    expect(readFileSync(logPath, 'utf-8')).toMatch(/signal=SIGHUP.*parent closed our process group/);
    const s = loadRunState(dir, RUN_ID) as any;
    expect(s.exit.signal).toBe('SIGHUP');
  });
});
