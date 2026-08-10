/**
 * A launch must not be killed just because the caller stopped watching.
 *
 * `relaunchDetached` detaches the mission and then mirrors its log until the
 * child exits. For a terminal or CI caller that is the whole point. For an
 * AGENT it inverts: the tool budget expires mid-mirror, the call is killed, and
 * a launch that SUCCEEDED is reported to the model as a timeout.
 *
 * Verbatim from a session on 2026-08-10:
 *
 *   shell tool terminated command after exceeding timeout 300000 ms
 *   "The deliver tool keeps timing out. Let me take a different approach"
 *   $ ps aux | grep -E "node.*deliver" | awk '{print $2}' | xargs kill -9
 *   0
 *
 * It killed the run that was still working. The mirror is a convenience; the
 * mission is already detached by then, so bounding it costs nothing and turns a
 * kill into an answer.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { relaunchDetached, STILL_RUNNING } from '../../src/cli/deliver-detach.js';

const roots: string[] = [];
function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'uap-mirror-'));
  roots.push(root);
  mkdirSync(join(root, '.uap'), { recursive: true });
  writeFileSync(join(root, '.uap.json'), '{}');
  return root;
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop() as string, { recursive: true, force: true });
});

describe('the mirror budget', () => {
  it('returns STILL_RUNNING rather than waiting for the child', async () => {
    // A 1ms budget fires on the next tick, long before a spawned node process
    // can start and exit. An earlier version used 1200ms and the child — a
    // `deliver` with no instruction — failed FIRST, so the test measured the
    // child's exit code (1) instead of the budget. The budget has to be the
    // thing that wins for this to be testing anything.
    const root = project();
    const started = Date.now();
    const code = await relaunchDetached(root, 'teststamp', { mirrorBudgetMs: 1 });
    const elapsed = Date.now() - started;

    expect(code).toBe(STILL_RUNNING);
    expect(elapsed).toBeLessThan(15_000);
  }, 40_000);

  it('waits for the child when NO budget is given — the terminal keeps that', async () => {
    // The unbounded path must stay unbounded: a human or CI caller wants the
    // stream to completion, which is what the long-standing behaviour is for.
    const root = project();
    const code = await relaunchDetached(root, 'teststamp-unbounded');
    expect(code).not.toBe(STILL_RUNNING); // it waited and reported a real code
    // Let the mirror's FINAL flush land before afterEach deletes the tree.
    // resolve() happens 500ms before that last pump, so tearing the directory
    // down immediately raced it — which is exactly how this test broke the
    // publish on CI (ENOENT on its own log) while passing locally.
    await new Promise((r) => setTimeout(r, 800));
  }, 40_000);

  it('STILL_RUNNING cannot be confused with a real exit code', () => {
    // A caller maps the return onto process.exitCode; a sentinel colliding with
    // 0 (success) or 1 (not delivered) would be read as an outcome.
    expect(STILL_RUNNING).toBeLessThan(0);
  });

  it('leaves the detached mission alive after it returns', async () => {
    // The whole claim: "this launch stopped watching, the mission did not
    // stop". If returning killed the child, this would be a worse bug than the
    // one being fixed.
    const root = project();
    const code = await relaunchDetached(root, 'teststamp2', { mirrorBudgetMs: 1 });
    expect(code).toBe(STILL_RUNNING); // otherwise this asserts nothing
    const logDir = join(root, '.uap', 'deliver-logs');
    expect(existsSync(logDir)).toBe(true);
    // The log keeps GROWING after we stopped mirroring — proof the child lives.
    const sizeAt = (): number => {
      let total = 0;
      for (const f of require('fs').readdirSync(logDir)) {
        total += require('fs').statSync(join(logDir, f)).size;
      }
      return total;
    };
    const before = sizeAt();
    await new Promise((r) => setTimeout(r, 2500));
    expect(sizeAt()).toBeGreaterThanOrEqual(before);
  }, 40_000);
});

