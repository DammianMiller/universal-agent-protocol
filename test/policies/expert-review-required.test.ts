/**
 * expert-review-required enforcer tests
 *
 * Spawns the Python enforcer against a throwaway git repo and asserts the
 * allow (exit 0) / block (exit 2) contract: ship actions are blocked until a
 * review artifact exists for the branch and covers HEAD.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync, execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const ENFORCER = join(
  process.cwd(),
  'src',
  'policies',
  'enforcers',
  'expert_review_required.py'
);

/**
 * A copy of the environment with all GIT_* variables stripped. Git hooks (e.g.
 * pre-push, which runs this suite) export GIT_DIR / GIT_WORK_TREE /
 * GIT_INDEX_FILE; if those leak into the nested `git init` below it operates on
 * the wrong repo and fails (status 128). Run the throwaway-repo git ops and the
 * enforcer in a clean git environment.
 */
function cleanGitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  return env;
}

function git(repo: string, args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'ignore', env: cleanGitEnv() });
}

/** Run the enforcer; returns its exit code (0 = allow, 2 = block). */
function runEnforcer(
  repo: string,
  command: string,
  env: Record<string, string> = {}
): number {
  const res = spawnSync(
    'python3',
    [ENFORCER, '--operation', 'Bash', '--args', JSON.stringify({ command })],
    { cwd: repo, env: cleanGitEnv({ UAP_REPO_ROOT: repo, ...env }) }
  );
  return res.status ?? -1;
}

describe('expert-review-required enforcer', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'uap-review-gate-'));
    git(repo, ['init', '-q']);
    git(repo, ['checkout', '-q', '-b', 'feature/x']);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('blocks git commit when no review artifact exists', () => {
    expect(runEnforcer(repo, 'git commit -m "wip"')).toBe(2);
  });

  /** Branch `feature/x` → injective slug `feature%2Fx`. */
  function writeReview(data: Record<string, unknown>): void {
    mkdirSync(join(repo, '.uap', 'reviews'), { recursive: true });
    writeFileSync(join(repo, '.uap', 'reviews', 'feature%2Fx.json'), JSON.stringify(data));
  }

  it('allows the ship action once a review artifact exists for the branch', () => {
    writeReview({ verdict: 'approve', reviewers: ['code-quality-reviewer'] });
    expect(runEnforcer(repo, 'git commit -m "done"')).toBe(0);
  });

  it('blocks git merge without a review artifact', () => {
    expect(runEnforcer(repo, 'git merge origin/master')).toBe(2);
  });

  it('does not collide distinct refs onto one slug (feature/x vs feature-x)', () => {
    // A review written for the sibling ref `feature-x` must NOT satisfy `feature/x`.
    mkdirSync(join(repo, '.uap', 'reviews'), { recursive: true });
    writeFileSync(
      join(repo, '.uap', 'reviews', 'feature-x.json'),
      JSON.stringify({ verdict: 'approve' })
    );
    expect(runEnforcer(repo, 'git commit -m x')).toBe(2);
  });

  it('rejects an artifact that records a different branch', () => {
    writeReview({ verdict: 'approve', branch: 'feature/other' });
    expect(runEnforcer(repo, 'git commit -m x')).toBe(2);
  });

  it('does not block read-only commands containing the word "merge"', () => {
    // bug_001 regression guard: bare "merge"/"signoff" tokens must not trip the gate.
    expect(runEnforcer(repo, 'git diff --merge-base origin/master HEAD')).toBe(0);
    expect(runEnforcer(repo, 'rg merge src/')).toBe(0);
    expect(runEnforcer(repo, 'cat docs/merge-strategy.md')).toBe(0);
  });

  it('honors the UAP_NO_REVIEW override', () => {
    expect(runEnforcer(repo, 'git push', { UAP_NO_REVIEW: '1' })).toBe(0);
  });

  it('does NOT honor an inline UAP_NO_REVIEW=1 prefix — it was self-grantable', () => {
    // This test previously asserted the OPPOSITE, on the reasoning that the
    // policy-gate hook runs in the harness env so an exported override never
    // reaches a hook-spawned enforcer, leaving the inline form as the only one
    // that could work. The reasoning was right and the conclusion was wrong:
    // the agent composes its own command strings, so an inline override is one
    // it grants itself. One session waived review on all eleven commits it
    // made — not delegating the decision, removing the gate.
    //
    // Now environment-only. An operator sets it when launching the session;
    // the env-free routes for harnesses that strip the environment are the
    // waiver files, which are visible in the tree rather than per-command.
    expect(runEnforcer(repo, 'UAP_NO_REVIEW=1 git push')).toBe(2);
    expect(runEnforcer(repo, 'FOO=bar UAP_NO_REVIEW=1 git push')).toBe(2);
    // Look-alikes and non-1 values were already refused; still are.
    expect(runEnforcer(repo, 'UAP_NO_REVIEW=0 git push')).toBe(2);
    expect(runEnforcer(repo, 'UAP_NO_REVIEWS=1 git push')).toBe(2);
    expect(runEnforcer(repo, 'git commit -m \"note: never set UAP_NO_REVIEW=1\"')).toBe(2);
    // Unchanged: a non-ship command is not gated at all.
    expect(runEnforcer(repo, 'echo hi')).toBe(0);
  });

  it('ignores non-ship commands', () => {
    expect(runEnforcer(repo, 'ls -la')).toBe(0);
  });
});

describe('expert-review-required: risk-scope + file waiver', () => {
  let repo: string;

  /** A repo with a `master` base commit and a `feature/x` branch we add to. */
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'uap-review-scope-'));
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 't@t.dev']);
    git(repo, ['config', 'user.name', 't']);
    git(repo, ['checkout', '-q', '-b', 'master']);
    writeFileSync(join(repo, 'README.md'), '# base\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'base']);
    git(repo, ['checkout', '-q', '-b', 'feature/x']);
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  function add(path: string, content = 'x'): void {
    const full = join(repo, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', `add ${path}`]);
  }

  it('ALLOWS gh pr merge for a frontend-only diff (captures registered, no review artifact)', () => {
    add('src/components/Button.tsx', 'export const B = () => null;');
    add('src/styles/app.css', '.b{color:var(--x);}');
    add('docs/guide.md', '# guide');
    // Since uplift 0.3, frontend-only diffs still skip the parallel review
    // artifact, but UI files require registered before/after captures —
    // without them the ship is blocked (see the visual-captures suite below).
    writeFileSync(join(repo, 'before.png'), 'b');
    writeFileSync(join(repo, 'after.png'), 'a');
    mkdirSync(join(repo, '.uap', 'reviews'), { recursive: true });
    writeFileSync(
      join(repo, '.uap', 'reviews', 'feature%2Fx.captures.json'),
      JSON.stringify({
        captures: [{ tool: 'tuistory', before: 'before.png', after: 'after.png', at: new Date().toISOString() }],
        at: new Date().toISOString(),
      })
    );
    expect(runEnforcer(repo, 'gh pr merge 12 --merge --admin')).toBe(0);
  });

  it('BLOCKS a frontend-only diff WITHOUT captures (0.3 changed the low-risk semantics)', () => {
    add('src/components/Button.tsx', 'export const B = () => null;');
    add('docs/guide.md', '# guide');
    expect(runEnforcer(repo, 'gh pr merge 12 --merge --admin')).toBe(2);
  });

  it('STILL BLOCKS when the diff touches IaC (.tf)', () => {
    add('src/components/Button.tsx', 'export const B = () => null;');
    add('infra/terraform/main.tf', 'resource "null_resource" "x" {}');
    expect(runEnforcer(repo, 'gh pr merge 12 --merge')).toBe(2);
  });

  it('STILL BLOCKS for a CI workflow change (low-risk ext, high-risk path)', () => {
    add('.github/workflows/deploy.yml', 'on: push');
    expect(runEnforcer(repo, 'gh pr merge 12 --merge')).toBe(2);
  });

  it('STILL BLOCKS for substantive backend src changes', () => {
    add('src/server/handler.ts', 'export function h(){return 1;}');
    expect(runEnforcer(repo, 'git push')).toBe(2);
  });

  it('file waiver (policies/waivers/*expert-review*.md) bypasses without env vars', () => {
    add('src/server/handler.ts', 'export function h(){return 2;}');
    expect(runEnforcer(repo, 'gh pr merge 12 --merge')).toBe(2);
    add('policies/waivers/2026-frontend-expert-review.md', '# waiver');
    expect(runEnforcer(repo, 'gh pr merge 12 --merge')).toBe(0);
  });

  it('.uap/reviews/WAIVER marker also bypasses', () => {
    add('src/server/handler.ts', 'export function h(){return 3;}');
    add('.uap/reviews/WAIVER', 'frontend sprint');
    expect(runEnforcer(repo, 'git push')).toBe(0);
  });
});

describe('expert-review-required: visual-captures gate (uplift 0.3)', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'uap-review-visual-'));
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 't@t.dev']);
    git(repo, ['config', 'user.name', 't']);
    git(repo, ['checkout', '-q', '-b', 'master']);
    writeFileSync(join(repo, 'README.md'), '# base\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'base']);
    git(repo, ['checkout', '-q', '-b', 'feature/x']);
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  function add(path: string, content = 'x'): void {
    const full = join(repo, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', `add ${path}`]);
  }

  /** A valid captures artifact: one pair whose files exist, taken "now". */
  function writeCaptures(): void {
    writeFileSync(join(repo, 'before.png'), 'b');
    writeFileSync(join(repo, 'after.png'), 'a');
    mkdirSync(join(repo, '.uap', 'reviews'), { recursive: true });
    writeFileSync(
      join(repo, '.uap', 'reviews', 'feature%2Fx.captures.json'),
      JSON.stringify({
        branch: 'feature/x',
        ui_files: ['src/app.tsx'],
        captures: [{ tool: 'tuistory', before: 'before.png', after: 'after.png', at: new Date().toISOString() }],
        at: new Date().toISOString(),
      })
    );
  }

  it('BLOCKS a UI diff with no captures artifact (even though UI-only diffs skip review)', () => {
    add('src/app.tsx', 'export const A = () => null;');
    expect(runEnforcer(repo, 'git push')).toBe(2);
  });

  it('ALLOWS a UI diff once a fresh before/after pair is registered', () => {
    add('src/app.tsx', 'export const A = () => null;');
    writeCaptures();
    expect(runEnforcer(repo, 'git push')).toBe(0);
  });

  it('BLOCKS when the captures artifact has no complete pair', () => {
    add('src/app.tsx');
    mkdirSync(join(repo, '.uap', 'reviews'), { recursive: true });
    writeFileSync(
      join(repo, '.uap', 'reviews', 'feature%2Fx.captures.json'),
      JSON.stringify({ captures: [{ tool: 'tuistory', before: 'b.png' }], at: new Date().toISOString() })
    );
    expect(runEnforcer(repo, 'git push')).toBe(2);
  });

  it('BLOCKS when a UI file changed after the captures (stale)', () => {
    add('src/app.tsx');
    writeCaptures();
    // Newer UI edit after the captures artifact was written. The mtime is set
    // explicitly past the 1s grace window — whole-second filesystems would
    // otherwise keep a same-second rewrite inside it.
    add('src/app.tsx', 'export const A = () => "changed";');
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(repo, 'src', 'app.tsx'), future, future);
    expect(runEnforcer(repo, 'git push')).toBe(2);
  });

  it('does not affect non-UI diffs', () => {
    add('docs/guide.md', '# g');
    expect(runEnforcer(repo, 'git push')).toBe(0); // low-risk, no UI
  });

  it('still requires the full review artifact for HIGH-risk UI diffs (both gates apply)', () => {
    add('src/app.tsx');
    add('infra/terraform/main.tf', 'resource "null_resource" "x" {}');
    writeCaptures();
    // captures satisfied, but the diff is high-risk => review artifact required
    expect(runEnforcer(repo, 'git push')).toBe(2);
  });

  it('honors the operator env escape hatch UAP_VISUAL_GATE_OFF=1', () => {
    add('src/app.tsx');
    expect(runEnforcer(repo, 'git push', { UAP_VISUAL_GATE_OFF: '1' })).toBe(0);
  });

  it('BLOCKS artifacts referencing absolute or escaping capture paths (gate does not trust the recorder)', () => {
    add('src/app.tsx');
    mkdirSync(join(repo, '.uap', 'reviews'), { recursive: true });
    for (const bad of ['/etc/hostname', '../outside.png']) {
      writeFileSync(
        join(repo, '.uap', 'reviews', 'feature%2Fx.captures.json'),
        JSON.stringify({
          captures: [{ tool: 't', before: bad, after: 'after.png', at: new Date().toISOString() }],
          at: new Date().toISOString(),
        })
      );
      writeFileSync(join(repo, 'after.png'), 'a');
      expect(runEnforcer(repo, 'git push')).toBe(2);
    }
  });

  it('treats UI directory prefixes case-insensitively like the TS classifier', () => {
    // `Public/` (capital P) must be seen as the `public/` UI prefix — and the
    // file needs a low-risk extension (.md) so the ONLY gate that can fire is
    // the captures gate (`.bin` would also trip the review requirement).
    add('Public/logo.md', '# logo notes');
    expect(runEnforcer(repo, 'git push')).toBe(2); // UI by prefix, no captures
    writeCaptures();
    expect(runEnforcer(repo, 'git push')).toBe(0);
  });
});
