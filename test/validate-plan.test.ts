/**
 * validate-plan-on-change: the enforcer forces `validate the plan` on any
 * plan-file write, and `uap plan validate` unblocks it for the window.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { planCommand } from '../src/cli/plan.js';

// UAP_PLAN_ENFORCER lets a candidate enforcer be proven before an operator
// installs it — the agent cannot write src/policies/enforcers/. CI never sets it.
const ENFORCER =
  process.env.UAP_PLAN_ENFORCER ||
  join(process.cwd(), 'src', 'policies', 'enforcers', 'validate_plan_on_change.py');
const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'uap-plan-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function run(op: string, filePath: string, env: Record<string, string> = {}, cwd?: string): number {
  const r = spawnSync('python3', [ENFORCER, '--operation', op, '--args', JSON.stringify({ file_path: filePath })], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    cwd,
  });
  return r.status ?? -1;
}

/** The gate now fires on build-ish Bash commands, so tests need this shape too. */
function runBash(command: string, env: Record<string, string> = {}, cwd?: string): number {
  const r = spawnSync('python3', [ENFORCER, '--operation', 'Bash', '--args', JSON.stringify({ command })], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    cwd,
  });
  return r.status ?? -1;
}

/**
 * A throwaway project with a real plan on disk. The gate resolves plan paths
 * against the CWD, so running it from the repo root (as these tests used to)
 * silently checks the wrong tree — pending entries point at files that are not
 * there, and a "blocked" assertion passes or fails for the wrong reason.
 */
function projectWithPlan(planPath = 'plans/my-plan.md', text = '# Plan\n\nDo the thing.\n'): string {
  const d = tmp();
  mkdirSync(join(d, '.uap'), { recursive: true });
  mkdirSync(join(d, planPath, '..'), { recursive: true });
  writeFileSync(join(d, planPath), text);
  return d;
}

function seedPending(project: string, planPath = 'plans/my-plan.md'): void {
  writeFileSync(
    join(project, '.uap', 'plan_state.json'),
    JSON.stringify({ pending: { [planPath]: Math.floor(Date.now() / 1000) } })
  );
}

/** Seed `.uap/plan_state.json` in a temp state dir with a validated_at offset. */
function seedValidatedAgo(secondsAgo: number): string {
  const d = tmp();
  mkdirSync(join(d, '.uap'), { recursive: true });
  writeFileSync(join(d, '.uap', 'plan_state.json'), JSON.stringify({ validated_at: Math.floor(Date.now() / 1000) - secondsAgo }));
  return join(d, '.uap');
}

/**
 * These assertions INVERTED deliberately.
 *
 * The gate used to block the plan WRITE unless `uap plan validate` had run in
 * the last 300s. That asked the agent to validate a plan before it existed: the
 * review found no artifact, recorded "skipped", stamped anyway, and for the next
 * five minutes any plan content went in unread — while nothing gated the build.
 * The plan that got implemented was never reviewed.
 *
 * Now the write is recorded and allowed, and the BUILD is what blocks. The
 * escape hatch and plan-artifact detection are unchanged; neither was the bug.
 */
describe('validate-plan-on-change enforcer', () => {
  it('ALLOWS a plan-file write and records it instead of blocking', () => {
    const d = projectWithPlan();
    expect(run('Write', 'plans/my-plan.md', {}, d)).toBe(0);
    const state = JSON.parse(readFileSync(join(d, '.uap', 'plan_state.json'), 'utf8'));
    expect(Object.keys(state.pending ?? {})).toContain('plans/my-plan.md');
  });

  it('BLOCKS a build while a plan is pending validation', () => {
    const d = projectWithPlan();
    seedPending(d);
    expect(runBash('npm run build', {}, d)).toBe(2);
    expect(runBash('uap deliver "ship it"', {}, d)).toBe(2);
  });

  it('leaves tests, linters and reads alone even while blocking a build', () => {
    // You cannot review a plan if you cannot inspect the tree or run its tests.
    const d = projectWithPlan();
    seedPending(d);
    for (const cmd of ['npm test', 'npx tsc --noEmit', 'git status', 'ls -la']) {
      expect(runBash(cmd, {}, d)).toBe(0);
    }
  });

  it('ALLOWS a build when nothing is pending', () => {
    const d = projectWithPlan();
    expect(runBash('npm run build', {}, d)).toBe(0);
  });

  it('ALLOWS non-plan files', () => {
    const d = projectWithPlan();
    expect(run('Write', 'src/foo.ts', {}, d)).toBe(0);
    expect(run('Write', 'planning-guide.md', {}, d)).toBe(0); // not "plan"
    expect(run('Write', 'explanation.md', {}, d)).toBe(0);
  });

  it('honors the UAP_PLAN_VALIDATE_OFF escape hatch', () => {
    const d = projectWithPlan();
    seedPending(d);
    expect(runBash('npm run build', { UAP_PLAN_VALIDATE_OFF: '1' }, d)).toBe(0);
  });
});

describe('uap plan validate CLI', () => {
  it('records a fresh validation the enforcer then honors', async () => {
    const d = tmp();
    await planCommand('validate', {}, d);
    // The state the CLI wrote should unblock the enforcer for the same dir.
    const code = run('Write', 'plans/my-plan.md', { UAP_STATE_DIR: join(d, '.uap') });
    expect(code).toBe(0);
  });

  it('status reports fresh right after validate, via JSON', async () => {
    const d = tmp();
    await planCommand('validate', {}, d);
    const orig = console.log;
    let out = '';
    console.log = (s?: unknown) => { out += String(s); };
    try {
      await planCommand('status', { json: true }, d);
    } finally {
      console.log = orig;
    }
    const parsed = JSON.parse(out);
    // `fresh` (a 300s clock) is gone: status now reports whether anything is
    // actually BLOCKING a build, which is what the gate keys on.
    expect(parsed.blocked).toBe(false);
    expect(parsed.pending).toEqual([]);
    expect(parsed.validated_at).toBeGreaterThan(0);
  });
});

describe('uap plan validate — real pre-stamp review (ATG)', () => {
  const savedExit = () => {
    const prev = process.exitCode;
    process.exitCode = undefined;
    return () => { process.exitCode = prev; };
  };

  it('REFUSES the stamp when the reviewer fails the plan, and sets exit code 1', async () => {
    const restore = savedExit();
    try {
      const d = tmp();
      writeFileSync(join(d, 'rollout-plan.md'), '# Plan\n1. deploy to prod\n2. build\n3. run tests');
      await planCommand('validate', {}, d, {
        reviewExecutor: async () => '{"verdict":"fail","findings":["deploys before building or testing"]}',
      });
      expect(process.exitCode).toBe(1);
      // Not stamped. The plan WRITE is no longer what gets blocked — the build
      // is — so the observable consequence is that nothing was recorded as
      // validated, and a build therefore stays gated.
      // A refused stamp writes no state at all, so "nothing was recorded as
      // validated" is either an absent file or an empty `validated` map.
      let validated: Record<string, string> = {};
      try {
        validated = JSON.parse(readFileSync(join(d, '.uap', 'plan_state.json'), 'utf-8')).validated ?? {};
      } catch {
        validated = {};
      }
      expect(validated).toEqual({});
    } finally {
      restore();
    }
  });

  it('stamps on a pass verdict and records the review in the state', async () => {
    const restore = savedExit();
    try {
      const d = tmp();
      writeFileSync(join(d, 'implementation-plan.md'), '# Plan\n1. build\n2. test\n3. deploy');
      await planCommand('validate', {}, d, {
        reviewExecutor: async () => '{"verdict":"pass","findings":[]}',
      });
      expect(process.exitCode ?? 0).toBe(0);
      const state = JSON.parse(readFileSync(join(d, '.uap', 'plan_state.json'), 'utf-8'));
      expect(state.validated_at).toBeGreaterThan(0);
      expect(state.review.status).toBe('pass');
      expect(state.review.file).toContain('implementation-plan.md');
    } finally {
      restore();
    }
  });

  it('force-stamps a failed review when UAP_PLAN_REVIEW_FORCE=1', async () => {
    const restore = savedExit();
    process.env.UAP_PLAN_REVIEW_FORCE = '1';
    try {
      const d = tmp();
      writeFileSync(join(d, 'plan.md'), '# Plan\n1. x');
      await planCommand('validate', {}, d, {
        reviewExecutor: async () => '{"verdict":"fail","findings":["bad"]}',
      });
      expect(process.exitCode ?? 0).toBe(0);
      const state = JSON.parse(readFileSync(join(d, '.uap', 'plan_state.json'), 'utf-8'));
      expect(state.validated_at).toBeGreaterThan(0);
      expect(state.review.status).toBe('fail');
    } finally {
      delete process.env.UAP_PLAN_REVIEW_FORCE;
      restore();
    }
  });

  it('stamps with a skipped review when no plan artifact exists (fail-open)', async () => {
    const restore = savedExit();
    try {
      const d = tmp(); // empty — nothing plan-like to review
      await planCommand('validate', {}, d, {
        reviewExecutor: async () => { throw new Error('must not be called'); },
      });
      expect(process.exitCode ?? 0).toBe(0);
      const state = JSON.parse(readFileSync(join(d, '.uap', 'plan_state.json'), 'utf-8'));
      expect(state.review.status).toBe('skipped');
    } finally {
      restore();
    }
  });

  it('UAP_PLAN_REVIEW=0 restores stamp-only behavior without calling the reviewer', async () => {
    const restore = savedExit();
    process.env.UAP_PLAN_REVIEW = '0';
    try {
      const d = tmp();
      writeFileSync(join(d, 'plan.md'), '# Plan');
      let called = false;
      await planCommand('validate', {}, d, {
        reviewExecutor: async () => { called = true; return '{"verdict":"fail"}'; },
      });
      expect(called).toBe(false);
      const state = JSON.parse(readFileSync(join(d, '.uap', 'plan_state.json'), 'utf-8'));
      expect(state.validated_at).toBeGreaterThan(0);
    } finally {
      delete process.env.UAP_PLAN_REVIEW;
      restore();
    }
  });

  it('reviews an explicit file passed positionally (argv seam)', async () => {
    const restore = savedExit();
    try {
      const d = tmp();
      writeFileSync(join(d, 'notes.md'), 'not plan-named but explicitly targeted');
      let sawPlanText = '';
      await planCommand('validate', {}, d, {
        argv: ['node', 'uap', 'plan', 'validate', join(d, 'notes.md')],
        reviewExecutor: async (prompt) => { sawPlanText = prompt; return '{"verdict":"pass","findings":[]}'; },
      });
      expect(sawPlanText).toContain('not plan-named but explicitly targeted');
    } finally {
      restore();
    }
  });

  it('a THROWING reviewer records SKIPPED, never a fabricated PASS', async () => {
    const restore = savedExit();
    try {
      const d = tmp();
      writeFileSync(join(d, 'plan.md'), '# Plan\n1. x');
      await planCommand('validate', {}, d, {
        reviewExecutor: async () => { throw new Error('endpoint down'); },
      });
      expect(process.exitCode ?? 0).toBe(0); // fail-open: still stamps
      const state = JSON.parse(readFileSync(join(d, '.uap', 'plan_state.json'), 'utf-8'));
      expect(state.review.status).toBe('skipped');
      expect(state.review.reason).toContain('reviewer unavailable');
    } finally {
      restore();
    }
  });

  it('an EMPTY reviewer completion records SKIPPED, never a fabricated PASS', async () => {
    const restore = savedExit();
    try {
      const d = tmp();
      writeFileSync(join(d, 'plan.md'), '# Plan\n1. x');
      await planCommand('validate', {}, d, {
        reviewExecutor: async () => '   ',
      });
      const state = JSON.parse(readFileSync(join(d, '.uap', 'plan_state.json'), 'utf-8'));
      expect(state.review.status).toBe('skipped');
      expect(state.review.reason).toContain('empty completion');
    } finally {
      restore();
    }
  });

  it('refuses to REVIEW an explicit non-.md or out-of-project file (skips, does not read it)', async () => {
    const restore = savedExit();
    try {
      const d = tmp();
      writeFileSync(join(d, 'secrets.env'), 'KEY=hunter2');
      let reviewerCalled = false;
      const reviewExecutor = async () => { reviewerCalled = true; return '{"verdict":"pass"}'; };
      await planCommand('validate', { file: join(d, 'secrets.env') }, d, { reviewExecutor });
      let state = JSON.parse(readFileSync(join(d, '.uap', 'plan_state.json'), 'utf-8'));
      expect(state.review.status).toBe('skipped');
      expect(state.review.reason).toContain('.md');

      const outside = tmp();
      writeFileSync(join(outside, 'other-plan.md'), 'outside the project');
      await planCommand('validate', { file: join(outside, 'other-plan.md') }, d, { reviewExecutor });
      state = JSON.parse(readFileSync(join(d, '.uap', 'plan_state.json'), 'utf-8'));
      expect(state.review.status).toBe('skipped');
      expect(state.review.reason).toContain('under the project');
      expect(reviewerCalled).toBe(false); // the content never reached the model
    } finally {
      restore();
    }
  });
});
