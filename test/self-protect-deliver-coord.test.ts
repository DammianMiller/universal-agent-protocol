/**
 * Delivery COORDINATION state is not scratch: `.uap/deliver.lock` and
 * `.uap/deliver-runs/`.
 *
 * `.uap/` is deliberately permissive — the tooling rewrites verify-cadence,
 * logs, screenshots and pending-deliver constantly, and guarding the whole tree
 * would block the project's own plumbing. But two entries under it are
 * mechanisms rather than logs, and both were shell-removable:
 *
 *   - `deliver.lock` is the single-flight guard. Removing it does not free
 *     anything; it puts a SECOND mission on the same tree. Two runs on nested
 *     roots overwrote each other's edits to src/cooccurrence.rs on 2026-08-08
 *     until it stopped compiling. On 2026-08-10 an agent ran
 *     `rm -f .uap/deliver.lock && uap deliver "<reworded>"` to force relaunches
 *     past the guard, seven times in one session.
 *   - `deliver-runs/` holds every run's checkpoint — the resumable work itself.
 *     `rm -rf .uap/deliver-runs` was allowed and would discard all of it.
 *
 * The permissive cases matter as much as the refusals here: over-widening .uap/
 * is the failure this list was written narrow to avoid.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { join } from 'path';

const ENFORCER = join(process.cwd(), 'src', 'policies', 'enforcers', 'enforcement_self_protect.py');

function run(command: string): { blocked: boolean; reason: string } {
  const r = spawnSync(
    'python3',
    [ENFORCER, '--operation', 'bash', '--args', JSON.stringify({ command })],
    { env: { ...process.env, UAP_SELF_PROTECT_OFF: '' }, encoding: 'utf8' }
  );
  let reason = '';
  try {
    reason = JSON.parse(r.stdout || '{}').reason ?? '';
  } catch {
    reason = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  }
  return { blocked: (r.status ?? -1) !== 0, reason };
}

describe('the delivery coordination surface is not shell-removable', () => {
  it('refuses removing the single-flight lock', () => {
    expect(run('rm -f .uap/deliver.lock').blocked).toBe(true);
    expect(run('rm .uap/deliver.lock').blocked).toBe(true);
  });

  it('refuses the exact live abuse: clear the lock, then relaunch', () => {
    expect(run('rm -f .uap/deliver.lock && uap deliver "Update motivators.rs"').blocked).toBe(true);
  });

  it('refuses removing the checkpoints, relative or absolute', () => {
    expect(run('rm -rf .uap/deliver-runs').blocked).toBe(true);
    expect(run('rm -rf /home/x/proj/.uap/deliver-runs/').blocked).toBe(true);
  });

  it('refuses emptying the lock as well as deleting it', () => {
    // Truncation and a redirect defeat the guard just as completely as rm.
    expect(run('truncate -s 0 .uap/deliver.lock').blocked).toBe(true);
    expect(run('echo x > .uap/deliver.lock').blocked).toBe(true);
  });
});

describe('the refusal names the coordination surface, not the enforcers', () => {
  it('explains what the lock IS and what removing it does', () => {
    const { reason } = run('rm -f .uap/deliver.lock && uap deliver "x"');
    expect(reason).toMatch(/single-flight/i);
    expect(reason).toMatch(/second mission/i);
    // The old text claimed "policy enforcers or proxy env", which is not what
    // was touched. A refusal that describes the wrong thing teaches nothing.
    expect(reason).not.toMatch(/policy enforcers or proxy env/i);
  });

  it('names the alternative — reclaim is automatic, and STOP is the way to stop', () => {
    const { reason } = run('rm -rf .uap/deliver-runs');
    expect(reason).toMatch(/reclaimed automatically/i);
    expect(reason).toMatch(/deliver-runs\/STOP/);
  });

  it('leaves the enforcer/proxy refusal wording alone', () => {
    const { reason } = run('rm -rf /home/x/.policy-tools');
    expect(reason).toMatch(/policy enforcers or proxy env/i);
  });
});

describe('ordinary .uap plumbing keeps working', () => {
  it('allows the runtime state the tooling rewrites constantly', () => {
    // The repo's own hook templates do `echo 0 > .uap/verify-cadence`.
    for (const cmd of [
      'echo 0 > .uap/verify-cadence',
      'rm -f .uap/autoroute.log',
      'rm -rf .uap/visual',
      'cat .uap/pending-deliver.jsonl',
      'tail -50 .uap/deliver-logs/deliver-20260810T000000.log',
    ]) {
      expect(run(cmd).blocked, cmd).toBe(false);
    }
  });

  it('allows READING coordination state — only destroying it is refused', () => {
    expect(run('cat .uap/deliver-runs/run-x/state.json').blocked).toBe(false);
    expect(run('ls -la .uap/deliver-runs').blocked).toBe(false);
  });

  it('allows the sanctioned stop, which writes INTO deliver-runs', () => {
    // The remedy the refusal points at must not itself be refused.
    expect(run('touch .uap/deliver-runs/STOP').blocked).toBe(false);
  });
});

describe('the heartbeat is part of the same guard', () => {
  // Leaving it out left the bypass open one file over. `isDeliverLockAbandoned`
  // treats a MISSING heartbeat plus a lock older than the wedge timeout as
  // abandoned, so deleting it makes a LIVE holder look dead and the next launch
  // reclaims its lock — the same two-missions-on-one-tree collision, reached
  // without touching the lock at all. Verified against the real predicate: a
  // two-hour-old lock held by a live pid is abandoned=false with the heartbeat
  // present and abandoned=true once it is deleted.
  it('refuses removing or moving the heartbeat', () => {
    expect(run('rm -f .uap/deliver.heartbeat').blocked).toBe(true);
    expect(run('rm .uap/deliver.heartbeat').blocked).toBe(true);
    expect(run('mv .uap/deliver.heartbeat /tmp/x').blocked).toBe(true);
  });

  it('refuses destroying the pending-deliver replay queue', () => {
    // Named by the delivery-enforcement policy for the same reason: deleting it
    // discards recorded work rather than completing it.
    expect(run('rm -f .uap/pending-deliver.jsonl').blocked).toBe(true);
    expect(run('truncate -s 0 .uap/pending-deliver.jsonl').blocked).toBe(true);
  });

  it('still allows READING both', () => {
    expect(run('cat .uap/deliver.heartbeat').blocked).toBe(false);
    expect(run('cat .uap/pending-deliver.jsonl').blocked).toBe(false);
    expect(run('tail -5 .uap/pending-deliver.applied.jsonl').blocked).toBe(false);
  });

  it('explains what the heartbeat is for, not just that it is protected', () => {
    const { reason } = run('rm -f .uap/deliver.heartbeat');
    expect(reason).toMatch(/abandoned/i);
    expect(reason).toMatch(/reclaims a RUNNING mission/i);
  });
});
