import { describe, it, expect } from 'vitest';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The held-out set exists to escape a specific bias: `real-gate-power` reached
 * its estimate by running, seeing which tasks discriminated, and dropping the
 * ones that did not. Five of its tasks survived that filter, so its number is
 * in-sample and no amount of extra epochs repairs it.
 *
 * A pre-registered set only fixes that if the registration is BINDING. A
 * markdown promise is not binding; deleting the task that scored badly is one
 * `rm -rf` away and would leave no trace in the diff of any analysis.
 *
 * So the registration is executable: the suite must contain exactly the
 * registered IDs. Pruning a task after seeing its result fails here, loudly,
 * instead of silently improving the headline number.
 */
const SUITE = join(__dirname, '..', '..', 'benchmarks', 'suites', 'real-gate-heldout');
const PREREG = join(SUITE, 'PREREGISTRATION.md');

/** The analysis set, registered 2026-08-03 before any measurement. */
const REGISTERED = [
  'js-base64',
  'js-cookie',
  'js-flatten',
  'js-natural-sort',
  'js-range-header',
  'js-roman',
  'js-shell-split',
  'js-word-wrap',
  'py-bencode',
  'py-column-align',
  'py-iban',
  'py-interval-set',
  'py-iso-duration',
  'py-rle',
  'py-slugify',
].sort();

/**
 * Present in the directory but deliberately outside the analysis set. Both have
 * an EMPTY gateCmd, so the raw adapter's gate loop never engages and both arms
 * run the identical single completion — they cannot express gate value under
 * any outcome. That is checkable without running anything, which is what makes
 * excluding them legitimate rather than convenient.
 */
const STRUCTURALLY_EXCLUDED = ['js-clamp', 'py-word-count'];

interface TaskSpec {
  gateCmd?: string;
  verifyCmd: string;
  verifyTimeoutSec: number;
}

const spec = (id: string): TaskSpec =>
  JSON.parse(readFileSync(join(SUITE, id, 'task.json'), 'utf-8')) as TaskSpec;

function run(cmd: string, cwd: string, timeoutSec: number): number {
  const r = spawnSync('bash', ['-lc', cmd], { cwd, encoding: 'utf-8', timeout: timeoutSec * 1000 });
  return r.status ?? 1;
}

function stage(id: string, withSolution: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'heldout-'));
  cpSync(join(SUITE, id, 'repo'), dir, { recursive: true });
  if (withSolution) cpSync(join(SUITE, id, 'solution'), dir, { recursive: true });
  return dir;
}

describe('held-out set pre-registration', () => {
  it('ships the pre-registration document', () => {
    expect(existsSync(PREREG)).toBe(true);
    const text = readFileSync(PREREG, 'utf-8');
    for (const id of REGISTERED) expect(text).toContain(id);
  });

  it('contains EXACTLY the registered tasks — no quiet pruning, no quiet additions', () => {
    const onDisk = readdirSync(SUITE)
      .filter((d) => existsSync(join(SUITE, d, 'task.json')))
      .filter((d) => !STRUCTURALLY_EXCLUDED.includes(d))
      .sort();
    // A deletion here means someone removed a task from the analysis set. If
    // that happened AFTER a run, the remaining aggregate is selected on its own
    // results and the held-out claim is void.
    expect(onDisk).toEqual(REGISTERED);
  });

  it('registers enough tasks to be worth running', () => {
    expect(REGISTERED.length).toBeGreaterThanOrEqual(15);
  });

  it('shares no task id with the suite the estimate was fitted to', () => {
    // A near-duplicate of a training task is not held out in any useful sense.
    const trainDir = join(__dirname, '..', '..', 'benchmarks', 'suites', 'real-gate-power');
    if (!existsSync(trainDir)) return;
    const train = new Set(readdirSync(trainDir));
    for (const id of REGISTERED) expect(train.has(id)).toBe(false);
  });

  it('documents the structural exclusion, and it is actually structural', () => {
    // The excluded pair must genuinely have no gate command — otherwise the
    // exclusion is a judgement call dressed as a structural fact.
    for (const id of STRUCTURALLY_EXCLUDED) {
      if (!existsSync(join(SUITE, id, 'task.json'))) continue;
      expect(spec(id).gateCmd ?? '').toBe('');
    }
    for (const id of REGISTERED) expect(spec(id).gateCmd ?? '').not.toBe('');
  });

  for (const id of REGISTERED) {
    it(`${id}: reference solves it and the stub does not`, () => {
      const s = spec(id);
      const withSol = stage(id, true);
      try {
        expect(run(s.gateCmd as string, withSol, s.verifyTimeoutSec)).toBe(0);
        expect(run(s.verifyCmd, withSol, s.verifyTimeoutSec)).toBe(0);
      } finally {
        rmSync(withSol, { recursive: true, force: true });
      }
      const bare = stage(id, false);
      try {
        expect(run(s.verifyCmd, bare, s.verifyTimeoutSec)).not.toBe(0);
      } finally {
        rmSync(bare, { recursive: true, force: true });
      }
    });
  }
});
