/**
 * Policy liveness (F1, deliver-hardening 2026-07-13).
 *
 * Defect 10: a policy can demand a compliant path that does not WORK — a
 * missing skill, an agent-locked artifact dir, a deliver that no-ops — and
 * nothing notices: the policy blocks, the sanctioned route is broken, and the
 * agent sits in a catch-22 (the pay2u incident's failure class). Every gated
 * policy here declares its compliant path as machine-checkable requirements
 * (`commands` on PATH, `writableDirs` the agent must be able to write,
 * `skills` that must resolve). The check runs at `uap policy enable`/install
 * and session-start (cached to .uap/policy-liveness.json), an unhealthy policy
 * is marked in `uap policy status`, and the gate hook can act on the cache.
 *
 * SABOTAGE GUARD — auto-degrade is NOT the default. An agent could break a
 * compliant path on purpose (delete a skill, wedge deliver) to force a
 * blocking policy down to advisory. So `degradable` is computed only when the
 * policy opts in (degradeOnDeadPath) AND every failure is on a surface the
 * agent cannot write: a missing PATH command or an unwritable SYSTEM dir is
 * environmental; anything under the repo or in a skill dir is agent-writable
 * and keeps the policy blocking while the operator decides.
 */

import { spawnSync, execFileSync } from 'child_process';
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { homedir, tmpdir } from 'os';
import { isAbsolute, join, resolve, sep } from 'path';

export interface PolicyLivenessSpec {
  /** Commands that must resolve on PATH. */
  commands?: string[];
  /** Directories (relative to the project root, or absolute) that must exist and be agent-writable. */
  writableDirs?: string[];
  /** Skill names that must resolve in a known skill/droid dir. */
  skills?: string[];
  /** Opt-in: the gate may downgrade this policy to advisory when its compliant
   * path is dead AND every failure is outside agent-writable surfaces. */
  degradeOnDeadPath?: boolean;
}

/**
 * Requirements registry, keyed by policy-name slug. Deliberately seeded only
 * where the compliant path has a REAL external dependency — a requirement that
 * cannot fail is noise, and a guessed one is worse than none.
 */
export const POLICY_LIVENESS: Record<string, PolicyLivenessSpec> = {
  // The compliant path is `uap deliver`, which shells out to git for the
  // baseline probe, snapshots and the diff the acceptance judge reads. A repo
  // without git makes every deliver a no-op candidate — the first catch-22.
  'delivery-enforcement': { commands: ['git'] },
  // The compliant path is `uap worktree create` — dead without git.
  'worktree-required': { commands: ['git'] },
};

export type RequirementSurface = 'external' | 'agent-writable';

export interface RequirementFailure {
  kind: 'command' | 'dir' | 'skill';
  target: string;
  surface: RequirementSurface;
  detail: string;
}

export interface PolicyLivenessResult {
  name: string;
  healthy: boolean;
  degradeOnDeadPath: boolean;
  /** True ONLY when opted-in and every failure is outside agent-writable surfaces. */
  degradable: boolean;
  failures: RequirementFailure[];
}

export interface LivenessCache {
  /** Contract version — the gate hook's bash reader is pinned to 1. */
  version: 1;
  checkedAt: string;
  /** Keyed by policy-name slug — the SAME rule as policyNameSlug in
   * src/cli/policy.ts and the inline re.sub in the gate hook's degrade
   * consult. Three copies, one rule: lowercase, non-alnum runs to '-',
   * trim '-'. Change it in all three or the degrade lookup misses. */
  policies: Record<string, Omit<PolicyLivenessResult, 'name'>>;
}

const CACHE_REL = join('.uap', 'policy-liveness.json');

/**
 * The MAIN checkout root for a session cwd. The gate hook strips
 * `/.worktrees/<name>` to find it (${CHECKOUT_ROOT%%/.worktrees/*}); the
 * writers must anchor the same way or a worktree session — the workflow
 * CLAUDE.md MANDATES — writes the cache and reads the policy DB where the
 * gate never looks (review should-fix, 2026-07-13). policies.db lives ONLY
 * in the main checkout (the hook's own header documents this), so the DB
 * read must anchor too. Non-git roots (unit fixtures) pass through unchanged.
 */
export function mainCheckoutRoot(projectRoot: string): string {
  try {
    const r = spawnSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: projectRoot,
      encoding: 'utf-8',
    });
    if (r.status !== 0) return projectRoot;
    const top = (r.stdout ?? '').trim();
    if (!top) return projectRoot;
    const i = top.indexOf(`${sep}.worktrees${sep}`);
    return i === -1 ? top : top.slice(0, i);
  } catch {
    return projectRoot;
  }
}

/** Directories skills are resolved from, repo first then user-level. */
function skillDirs(projectRoot: string): string[] {
  return [
    join(projectRoot, '.claude', 'skills'),
    join(projectRoot, '.factory', 'skills'),
    join(projectRoot, '.factory', 'droids'),
    join(homedir(), '.claude', 'skills'),
    join(homedir(), '.factory', 'skills'),
    join(homedir(), '.factory', 'droids'),
  ];
}

function commandExists(cmd: string): boolean {
  const r = spawnSync('sh', ['-c', 'command -v "$1"', 'sh', cmd], { encoding: 'utf-8' });
  return r.status === 0 && (r.stdout ?? '').trim().length > 0;
}

function skillResolves(name: string, projectRoot: string): boolean {
  for (const dir of skillDirs(projectRoot)) {
    if (existsSync(join(dir, name, 'SKILL.md')) || existsSync(join(dir, `${name}.md`))) return true;
  }
  return false;
}

/**
 * Whether a failed path requirement sits on a surface the AGENT could have
 * broken. Inside the repo → agent-writable (it could have deleted or chmod'd
 * it, so no auto-degrade). Anything outside the repo is environmental →
 * external. The boundary compare is separator-terminated: `/repo-evil` must
 * NOT classify as inside `/repo` (review nit, 2026-07-13).
 */
export function classifySurface(target: string, projectRoot: string): RequirementSurface {
  const root = resolve(projectRoot);
  const abs = resolve(target);
  if (abs !== root && !abs.startsWith(root + sep)) return 'external';
  return 'agent-writable';
}

/** Check one policy's declared requirements against the live environment. */
export function checkPolicyLiveness(projectRoot: string, name: string): PolicyLivenessResult | null {
  // Anchor at the main checkout: in a worktree session the caller's cwd is a
  // `.worktrees/<n>` tree, but the gate reads the main root's cache and the
  // policy DB lives only there.
  projectRoot = mainCheckoutRoot(projectRoot);
  const spec = POLICY_LIVENESS[name];
  if (!spec) return null; // no declared requirements — nothing to check
  const failures: RequirementFailure[] = [];

  for (const cmd of spec.commands ?? []) {
    if (!commandExists(cmd)) {
      // PATH is operator/environment-controlled; the agent cannot uninstall a
      // system tool from inside a policy hook (and PATH tampering is already
      // self-protect-gated).
      failures.push({ kind: 'command', target: cmd, surface: 'external', detail: `command '${cmd}' not on PATH` });
    }
  }

  for (const dir of spec.writableDirs ?? []) {
    const abs = isAbsolute(dir) ? dir : join(projectRoot, dir);
    const surface = classifySurface(abs, projectRoot);
    if (!existsSync(abs)) {
      failures.push({ kind: 'dir', target: dir, surface, detail: `directory '${dir}' does not exist` });
      continue;
    }
    try {
      accessSync(abs, constants.W_OK);
    } catch {
      // An unwritable dir INSIDE the repo is agent-chmod-able, so it is not
      // proof of a dead external path — classify it like any in-repo path
      // (review nit: hardcoding 'external' here was a sabotage hole: chmod a
      // compliance dir away and the policy would degrade).
      failures.push({ kind: 'dir', target: dir, surface, detail: `directory '${dir}' is not writable` });
    }
  }

  for (const skill of spec.skills ?? []) {
    if (!skillResolves(skill, projectRoot)) {
      // Skills live in agent-editable dirs by construction — a missing skill
      // is exactly the sabotage vector the degrade guard exists for.
      failures.push({ kind: 'skill', target: skill, surface: 'agent-writable', detail: `skill '${skill}' does not resolve` });
    }
  }

  const healthy = failures.length === 0;
  const degradeOnDeadPath = spec.degradeOnDeadPath === true;
  const degradable = !healthy && degradeOnDeadPath && failures.every((f) => f.surface === 'external');
  return { name, healthy, degradeOnDeadPath, degradable, failures };
}

/** Check every named policy that declares requirements. */
export function runLiveness(projectRoot: string, policyNames: string[]): PolicyLivenessResult[] {
  const out: PolicyLivenessResult[] = [];
  for (const name of policyNames) {
    const r = checkPolicyLiveness(projectRoot, name);
    if (r) out.push(r);
  }
  return out;
}

/** Persist the liveness cache the gate hook consults (session-start cadence). */
export function writeLivenessCache(projectRoot: string, results: PolicyLivenessResult[]): string {
  // Anchor at the MAIN root — the gate hook reads $MAIN_ROOT/.uap/…, so a
  // cache written under a worktree would be invisible to it (review fix).
  projectRoot = mainCheckoutRoot(projectRoot);
  const policies: LivenessCache['policies'] = {};
  for (const r of results) {
    const { name, ...rest } = r;
    policies[name] = rest;
  }
  const cache: LivenessCache = { version: 1, checkedAt: new Date().toISOString(), policies };
  const dir = join(projectRoot, '.uap');
  mkdirSync(dir, { recursive: true });
  const path = join(projectRoot, CACHE_REL);
  writeFileSync(path, JSON.stringify(cache, null, 2));
  return path;
}

/** Read the liveness cache; null when absent or unreadable (fail-open). */
export function readLivenessCache(projectRoot: string): LivenessCache | null {
  projectRoot = mainCheckoutRoot(projectRoot);
  try {
    const raw = JSON.parse(readFileSync(join(projectRoot, CACHE_REL), 'utf-8')) as LivenessCache;
    if (!raw || typeof raw !== 'object' || typeof raw.policies !== 'object' || !raw.policies) return null;
    return raw;
  } catch {
    return null;
  }
}

/** Enabled policy names (slugged) from the project policy DB; [] when none. */
export async function enabledPolicySlugs(projectRoot: string): Promise<string[]> {
  // policies.db lives ONLY in the main checkout (the gate hook's header
  // documents this) — a worktree cwd would find no DB and check nothing.
  projectRoot = mainCheckoutRoot(projectRoot);
  // Read the DB directly (sqlite3, same shape as the gate hook) rather than
  // the memory manager: liveness must also work in fixtures and from the
  // session-start cadence, where the manager's process-cwd coupling is wrong.
  const db = join(projectRoot, 'agents', 'data', 'memory', 'policies.db');
  if (!existsSync(db)) return [];
  const r = spawnSync(
    'sqlite3',
    [db, "SELECT name FROM policies WHERE isActive = 1;"],
    { encoding: 'utf-8' }
  );
  if (r.status !== 0) return [];
  const slug = (s: string): string =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (r.stdout ?? '')
    .split('\n')
    .map((s) => slug(s.trim()))
    .filter(Boolean);
}

/**
 * F1 canary: prove the deliver compliant path itself is alive — a real mission
 * in a temp repo must produce a 1-line diff and pass its gate. Model-backed
 * and slow, so it runs only on explicit request (`uap policy canary`), never
 * on a cadence. Returns a human verdict plus the evidence tail.
 */
export async function runDeliverCanary(opts: {
  cliEntry: string;
  timeoutMs?: number;
}): Promise<{ alive: boolean; detail: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'uap-canary-'));
  try {
    const git = (args: string[]): void => {
      execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    };
    git(['init', '-b', 'main']);
    git(['config', 'user.email', 'canary@example.com']);
    git(['config', 'user.name', 'canary']);
    // A gate that fails at baseline and passes exactly when the mission's file
    // exists — a no-op run can never satisfy it.
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'canary',
        scripts: { test: 'test -f canary.txt && grep -q ok canary.txt' },
      })
    );
    git(['add', '-A']);
    git(['commit', '-m', 'init']);

    const r = spawnSync(
      process.execPath,
      [opts.cliEntry, 'deliver', 'create canary.txt containing the single line: ok', '--no-auto', '--max-turns', '6', '--json'],
      { cwd: dir, encoding: 'utf-8', timeout: opts.timeoutMs ?? 600_000, maxBuffer: 8 * 1024 * 1024 }
    );
    const diff = spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf-8' });
    const changed = (diff.stdout ?? '').trim();
    const canaryContent = existsSync(join(dir, 'canary.txt'))
      ? readFileSync(join(dir, 'canary.txt'), 'utf-8').trim()
      : '';
    const alive = r.status === 0 && canaryContent === 'ok';
    const detail = alive
      ? `canary delivered (${changed || 'change committed by run'})`
      : `deliver exited ${r.status ?? 'null'}; tree: ${changed || 'clean'}; canary.txt: ${canaryContent || 'missing'}` +
        `\n${(r.stderr ?? '').slice(-800)}`;
    return { alive, detail };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
