/**
 * The runId-free stop file: `.uap/deliver-runs/STOP`.
 *
 * WHY IT EXISTS
 * The detach banner hands the caller a pid roughly 90 seconds before the run
 * registers a runId. For that whole window — which is exactly when an impatient
 * caller decides to intervene — the pid is the only handle it has, and it uses
 * it. Measured 2026-08-10: eleven runs in two and a half hours, eight killed by
 * signal, most before completing a single turn, one launched every ~4 minutes.
 *
 * A kill is the worst available option: SIGKILL runs no handler, so nothing is
 * checkpointed, no exit is recorded, the lock is left behind, and the next
 * launch starts from zero. That is what turns impatience into a loop.
 *
 * The consuming behaviour is the load-bearing part. A stop-file that outlived
 * its run would silently stop every future run — a worse failure than the one
 * being fixed, and unlike the per-run file nothing scopes this one to a mission
 * that has ended.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  isStopRequested,
  projectStopFilePath,
  requestStop,
  clearStop,
} from '../../src/delivery/run-state.js';

const roots: string[] = [];
function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'uap-stop-'));
  roots.push(root);
  mkdirSync(join(root, '.uap', 'deliver-runs'), { recursive: true });
  return root;
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop() as string, { recursive: true, force: true });
});

const RUN = 'run-20260810T120000-abcdef';

describe('project-level STOP — a handle that needs no runId', () => {
  it('stops a run that has not registered its runId yet', () => {
    const root = project();
    expect(isStopRequested(root, RUN)).toBe(false);
    writeFileSync(projectStopFilePath(root), 'x');
    expect(isStopRequested(root, RUN)).toBe(true);
  });

  it('stops even when the runId is unusable — the caller may not have one', () => {
    // Genuinely invalid ids. `not-a-run-id` READS invalid but passes
    // isValidRunId (it is just word characters and hyphens), so a mutant that
    // gated the project file behind a valid runId survived that version of
    // this test. Empty and traversal ids actually fail the predicate.
    for (const badId of ['', '../escape', 'a/b']) {
      const root = project();
      writeFileSync(projectStopFilePath(root), 'x');
      expect(isStopRequested(root, badId)).toBe(true);
    }
  });

  it('is CONSUMED when observed, so it cannot stop the next run too', () => {
    const root = project();
    writeFileSync(projectStopFilePath(root), 'x');
    expect(isStopRequested(root, RUN)).toBe(true);
    expect(existsSync(projectStopFilePath(root))).toBe(false);
    // A fresh run must not inherit it.
    expect(isStopRequested(root, 'run-20260810T130000-fedcba')).toBe(false);
  });

  it('leaves the PER-RUN file alone — that one is scoped and must persist', () => {
    // The loop checks per turn; consuming the per-run file on the first read
    // would let a mission continue past a cancel it had already acknowledged.
    const root = project();
    requestStop(root, RUN);
    expect(isStopRequested(root, RUN)).toBe(true);
    expect(isStopRequested(root, RUN)).toBe(true); // still stopped
    clearStop(root, RUN);
    expect(isStopRequested(root, RUN)).toBe(false);
  });

  it('does not stop a run when no stop was requested at all', () => {
    const root = project();
    expect(isStopRequested(root, RUN)).toBe(false);
  });

  it('survives a missing deliver-runs directory rather than throwing', () => {
    const root = mkdtempSync(join(tmpdir(), 'uap-stop-bare-'));
    roots.push(root);
    expect(isStopRequested(root, RUN)).toBe(false);
  });
});
