/**
 * Project preflight — refuse to start a mission in a project that structurally
 * CANNOT deliver, and self-heal the config posture that must always hold.
 *
 * Why this exists: a fresh scaffold silently reproduced two blockers that had
 * already been diagnosed and hand-fixed once. `uap init` did not `git init`, so
 * the project was not a repo — and deliver's candidate workspace is worktree
 * based, so deliver, epics, orchestration and tasks were ALL dead. Nothing said
 * so; the mission just failed to make progress. A hand-patched project is not a
 * fix, because the next scaffold reset recreates the same hole.
 *
 * Two classes of problem, deliberately handled differently:
 *  - BLOCKER (not a git repo): deliver cannot function. Fail loudly with the
 *    exact command to fix it. Failing closed beats burning a turn budget on a
 *    mission that cannot land.
 *  - POSTURE (deliver.orchestrate / deliver.epics unset): the desired state is
 *    "always on". Refusing to run would punish every project that simply never
 *    set the key, so SELF-HEAL: write the intended posture and say so. Explicit
 *    `false`/`'off'` is a real operator decision and is never overridden.
 */

import { spawnSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

export interface PreflightResult {
  /** False when a hard blocker means the mission must not start. */
  ok: boolean;
  /** Fatal, actionable reasons the project cannot deliver. */
  blockers: string[];
  /** Config posture repaired in place (reported, not fatal). */
  healed: string[];
}

/** True when `dir` is inside a git work tree. */
export function isGitRepo(dir: string): boolean {
  const r = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: dir,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return r.status === 0 && String(r.stdout).trim() === 'true';
}

/**
 * Check a project can actually deliver, healing config posture as needed.
 * Pure-ish: only writes `.uap.json`, and only to add absent keys.
 */
export function preflightProject(dir: string): PreflightResult {
  const blockers: string[] = [];
  const healed: string[] = [];

  if (!isGitRepo(dir)) {
    blockers.push(
      'not a git repository — deliver runs each candidate in a git worktree, so ' +
        'deliver, epics, orchestration and tasks cannot run at all here.\n' +
        `  fix: git -C ${dir} init && git -C ${dir} add -A && git -C ${dir} commit -m "baseline"`
    );
  }

  const configPath = join(dir, '.uap.json');
  if (existsSync(configPath)) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      let changed = false;

      // Every enforcement surface is ON by default. Each of these was previously
      // unset in a fresh scaffold, and each silently downgraded the pipeline:
      // without them a rebuilt project looked configured while enforcing almost
      // nothing. In every case an EXPLICIT value is an operator decision and is
      // never overridden — we only fill in what is ABSENT.
      const seed = (
        section: string,
        key: string,
        value: unknown,
        why: string
      ): void => {
        const obj = (cfg[section] as Record<string, unknown> | undefined) ?? {};
        if (obj[key] === undefined) {
          obj[key] = value;
          cfg[section] = obj;
          healed.push(`${section}.${key} was unset — defaulted to ${JSON.stringify(value)} (${why})`);
          changed = true;
        } else {
          cfg[section] = obj;
        }
      };

      // Decompose + epic-loop every mission, not only when a flag is remembered.
      seed('deliver', 'orchestrate', 'on', 'orchestrate always');
      seed('deliver', 'epics', 'on', 'epic loop always');
      // fidelity:max is what makes the visual, vision and acceptance gates
      // BLOCKING. Without it they are advisory — the deliverable can look
      // verified while nothing actually gates it.
      seed('fidelity', 'mode', 'max', 'visual/vision/acceptance gates BLOCK');
      // Route all work through deliver, and run the runtime gate.
      seed('delivery', 'enforcement', 'block', 'all work routes through deliver');
      seed('delivery', 'localMode', 'deliver', 'local edits route to deliver');
      seed('delivery', 'runtimeVerify', true, 'runtime gate runs');

      if (changed) writeFileSync(configPath, JSON.stringify(cfg, null, 2));
    } catch {
      // A malformed .uap.json is the config layer's problem to report, not ours;
      // never let preflight throw out of a mission start.
    }
  }

  return { ok: blockers.length === 0, blockers, healed };
}

/** Human-readable preflight failure, with the fix inline. */
export function formatPreflightFailure(result: PreflightResult): string {
  return [
    'This project cannot deliver:',
    ...result.blockers.map((b) => `  ✗ ${b}`),
  ].join('\n');
}
