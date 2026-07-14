/**
 * A mission must outlive the tool call that started it.
 *
 * Root cause (2026-07-14, live): opencode runs each `bash -c …` in its own
 * session and kills that process group when the tool call ends or times out. A
 * model invoking `uap deliver` from its bash tool was therefore spawning a long
 * mission inside a short-lived container, and it died wherever it happened to be.
 * Observed lifetimes were 531s, 258s, 34s, 0s, 291s — not timeouts, just
 * "whenever the tool call ended". Nothing ever landed.
 *
 * (The autoroute hook already spawned with start_new_session=True and was immune.
 * Only the direct, model-invoked path was exposed.)
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { shouldDetach, detachLogPath, NO_DETACH_ENV } from '../../src/cli/deliver-detach.js';

describe('shouldDetach — detach exactly when the caller is a tool call', () => {
  const base = { alreadyDetached: false, noDetach: false, isTTY: false, dryRun: false };

  it('DETACHES on captured stdout — the agent-tool-call shape that was killing missions', () => {
    const d = shouldDetach(base);
    expect(d.detach).toBe(true);
    expect(d.reason).toMatch(/outlive/);
  });

  it('leaves an INTERACTIVE run in the foreground (a human wants live output + Ctrl-C)', () => {
    expect(shouldDetach({ ...base, isTTY: true }).detach).toBe(false);
  });

  it('never re-detaches the child (no infinite recursion)', () => {
    expect(shouldDetach({ ...base, alreadyDetached: true }).detach).toBe(false);
  });

  it('does not detach a --dry-run (it only plans; there is nothing to outlive)', () => {
    expect(shouldDetach({ ...base, dryRun: true }).detach).toBe(false);
  });

  it(`honours the ${NO_DETACH_ENV} escape hatch`, () => {
    expect(shouldDetach({ ...base, noDetach: true }).detach).toBe(false);
  });

  it('names the log under the project (.uap/deliver-logs)', () => {
    expect(detachLogPath('/p', '20260714T070000')).toBe('/p/.uap/deliver-logs/deliver-20260714T070000.log');
  });
});

describe('END TO END: the mission survives the tool call being torn down', () => {
  it('killing the wrapper does NOT kill the mission, which leads its own session', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uap-dt-'));

    // Read a pid file ONLY once it holds a real pid. A half-written file yields
    // Number('') === 0 — and `kill -TERM 0` signals the CALLER's entire process
    // group, i.e. it would kill the test runner itself. Never let an unvalidated
    // pid reach kill(1). For the same reason this test derives pids from files
    // rather than `pgrep -f`, which self-matches the very shell running it.
    const pidOf = (f: string): number => {
      const raw = readFileSync(join(dir, f), 'utf-8').trim();
      const pid = Number(raw);
      if (!Number.isInteger(pid) || pid <= 1) throw new Error(`refusing to use pid ${JSON.stringify(raw)}`);
      return pid;
    };
    const waitFor = (f: string, ms = 20_000): boolean => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        try {
          if (existsSync(join(dir, f))) { pidOf(f); return true; }
        } catch { /* created but not yet populated — keep waiting */ }
        spawnSync('sleep', ['0.3']);
      }
      return false;
    };
    const psField = (field: 'sid' | 'pgid', p: number): number =>
      Number(spawnSync('ps', ['-o', `${field}=`, '-p', String(p)], { encoding: 'utf-8' }).stdout.trim() || 0);

    try {
      const harness = new URL('../fixtures/detach-harness.mjs', import.meta.url).pathname;

      // Reproduce opencode exactly: the command gets its OWN session, and its
      // stdout is captured (non-TTY). stdio:'ignore' is required — with the
      // default 'pipe', spawnSync blocks until every pipe end closes, and the
      // backgrounded harness holds the inherited FDs open for its whole life.
      spawnSync(
        'setsid',
        ['bash', '-c', `cd ${JSON.stringify(dir)} && node ${JSON.stringify(harness)} > out.log 2>&1 &`],
        { stdio: 'ignore', timeout: 20_000 }
      );

      expect(waitFor('wrapper.pid'), 'the wrapper should start').toBe(true);
      expect(waitFor('child.pid'), 'the wrapper should relaunch itself detached').toBe(true);
      const wrapper = pidOf('wrapper.pid');
      const child = pidOf('child.pid');

      // THE STRUCTURAL PROPERTY: the mission leads its OWN session and sits in a
      // different process group — precisely what puts it beyond the reach of the
      // process-group kill the client aims at the tool call.
      expect(child, 'the mission must lead its own session').toBe(psField('sid', child));
      expect(psField('pgid', child)).not.toBe(psField('pgid', wrapper));

      // Now the tool call dies.
      expect(wrapper).toBeGreaterThan(1);
      spawnSync('kill', ['-TERM', String(wrapper)], { stdio: 'ignore' });
      spawnSync('sleep', ['2']);

      expect(existsSync(`/proc/${wrapper}`), 'the wrapper should be gone').toBe(false);
      // THE ASSERTION: the mission outlives it.
      expect(existsSync(`/proc/${child}`), 'the mission must SURVIVE the teardown').toBe(true);

      // ...and it streamed to a FILE, so a dying wrapper's broken pipe cannot
      // hand the mission EPIPE and take it down anyway.
      const log = detachLogPath(dir, '20260714T000000');
      expect(existsSync(log)).toBe(true);
      expect(readFileSync(log, 'utf-8')).toContain('child alive');

      spawnSync('kill', ['-TERM', String(child)], { stdio: 'ignore' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
