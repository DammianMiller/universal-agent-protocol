/**
 * Staleness guard for `uap deliver --resume`.
 *
 * Incident class (live, 2026-11-17): a day-old run that had been killed by
 * SIGTERM was resumed while another deliver was already editing the same
 * tree — two whole-file rewriters fighting over one artifact destroyed ~12
 * measurement passes of newer work before both were found and killed. The
 * resume path skipped the concurrency lock by design ("it continues the SAME
 * mission"), and nothing asked whether the run's plan still matched the tree
 * it was about to replay over.
 *
 * The guard here is deliberately cheap and conservative: a run whose last
 * heartbeat is older than the window (default 24h) is refused, because a
 * mission that stale cannot be assumed to describe the current tree. The
 * off-switch matches the lock's pattern: a launch-environment variable that
 * an in-flight tool call cannot set for itself.
 */

/** Default staleness window. A resume older than this is refused. */
export const RESUME_STALE_DEFAULT_HOURS = 24;

/** The subset of DeliverRunState the staleness decision reads. */
export interface ResumableRunState {
  runId?: string;
  updatedAt?: string;
  exit?: { signal?: string; reason?: string } | null;
}

/** Age of a run's last heartbeat, in hours. Missing/invalid stamps count as
 * infinitely stale: a state file without a parseable heartbeat was written by
 * an older format or truncated mid-write, and either way its age is unknown. */
export function resumeAgeHours(state: ResumableRunState, now: Date = new Date()): number {
  const t = Date.parse(state.updatedAt ?? '');
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (now.getTime() - t) / 3_600_000);
}

/**
 * Why this resume must be refused, or null when it may proceed.
 *
 * `UAP_DELIVER_RESUME_STALE_HOURS` widens/narrows the window (0 disables it);
 * `UAP_DELIVER_RESUME_STALE=1` is the deliberate override, for an operator who
 * has verified the tree still matches the stale mission.
 */
export function staleResumeRefusal(
  state: ResumableRunState,
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): string | null {
  if (env.UAP_DELIVER_RESUME_STALE === '1') return null;
  const raw = Number(env.UAP_DELIVER_RESUME_STALE_HOURS ?? RESUME_STALE_DEFAULT_HOURS);
  const windowH = Number.isFinite(raw) && raw >= 0 ? raw : RESUME_STALE_DEFAULT_HOURS;
  if (windowH === 0) return null;
  const ageH = resumeAgeHours(state, now);
  if (ageH <= windowH) return null;
  const killed = state.exit?.signal ? ` (last exit ${state.exit.signal})` : '';
  return (
    `refusing to resume run ${state.runId ?? '<unknown>'}: its last heartbeat is ` +
    `${ageH === Number.POSITIVE_INFINITY ? 'unknown' : `${ageH.toFixed(1)}h`}${killed} — ` +
    `outside the ${windowH}h staleness window. A mission that old predates tree changes ` +
    `made after it died, and replaying its edit plan over the current tree clobbers that ` +
    `newer work. Verify the tree first (uap verify), and only continue deliberately with ` +
    `UAP_DELIVER_RESUME_STALE=1 set in the LAUNCH environment.`
  );
}
