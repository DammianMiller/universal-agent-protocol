/**
 * Challenge run orchestrator: launch N participant agents against a challenge
 * goal, bounded by a concurrency cap, and render the significance-gated
 * leaderboard when they finish.
 *
 * Each participant is either an in-process function (programmatic / tests) or a
 * shell command (the agent program). Participants do the work and call
 * `uap challenge submit ... --verified`; the orchestrator registers each agent,
 * supplies the goal + ids via env, tracks who submitted, and reports.
 */
import { spawn } from 'child_process';
import type { CoordinationService } from './service.js';
import type { LeaderboardEntry } from '../types/coordination.js';
import { getMaxModelConcurrency, warmModelSlotBudget } from '../utils/model-slots.js';

export interface ParticipantContext {
  agentId: string;
  challengeId: number;
  goal: string;
  metric?: string;
  index: number;
  service: CoordinationService;
}

export interface ChallengeRunOptions {
  challengeId: number;
  agents: number;
  concurrency?: number;
  timeoutMs?: number;
  /** Shell command template per agent. Placeholders: {agent} {challenge} {goal} {index}. */
  cmd?: string;
  /** In-process participant (used for programmatic runs and tests). Takes
   *  precedence over `cmd`. */
  participant?: (ctx: ParticipantContext) => Promise<void>;
  cwd?: string;
  agentPrefix?: string;
  capabilities?: string[];
  onEvent?: (e: RunEvent) => void;
}

export type RunEvent =
  | { type: 'start'; agentId: string; index: number }
  | { type: 'finish'; agentId: string; ok: boolean; submitted: number };

export interface AgentRunResult {
  agentId: string;
  ok: boolean;
  submitted: number;
  durationMs: number;
  exitCode?: number | null;
  error?: string;
}

export interface ChallengeRunReport {
  challengeId: number;
  agents: number;
  results: AgentRunResult[];
  leaderboard: LeaderboardEntry[];
}

/** Bounded-concurrency map over indices. */
async function runPool<T>(
  count: number,
  limit: number,
  worker: (index: number) => Promise<T>
): Promise<T[]> {
  const results: T[] = new Array(count);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, count)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= count) return;
      results[i] = await worker(i);
    }
  });
  await Promise.all(lanes);
  return results;
}

function interpolate(tmpl: string, vars: Record<string, string>): string {
  return tmpl.replace(/\{(agent|challenge|goal|index)\}/g, (_, k) => vars[k] ?? '');
}

function runCommand(
  cmd: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<{ exitCode: number | null; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', cmd], { cwd, env, stdio: 'ignore' });
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        child.kill('SIGKILL');
        resolve({ exitCode: null, error: `timeout after ${timeoutMs}ms` });
      }
    }, timeoutMs);
    child.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ exitCode: null, error: e.message });
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ exitCode: code });
    });
  });
}

/**
 * Run a challenge with N participant agents. Returns per-agent results and the
 * final leaderboard. Either `participant` (in-process) or `cmd` (shell) must be
 * provided.
 */
export async function runChallengeAgents(
  service: CoordinationService,
  opts: ChallengeRunOptions
): Promise<ChallengeRunReport> {
  const ch = service.getChallenge(opts.challengeId);
  if (!ch) throw new Error(`challenge #${opts.challengeId} not found`);
  if (ch.status !== 'open') throw new Error(`challenge #${opts.challengeId} is ${ch.status}`);
  if (!opts.participant && !opts.cmd) {
    throw new Error('provide a participant function or a --cmd template');
  }

  const n = Math.max(1, Math.floor(opts.agents));
  const cwd = opts.cwd ?? process.cwd();
  // Default concurrency to the model-slot budget so participants don't exhaust
  // the inference backend; warm it (probe) once up front.
  await warmModelSlotBudget(cwd);
  const concurrency = Math.max(1, opts.concurrency ?? getMaxModelConcurrency(cwd));
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const prefix = opts.agentPrefix ?? 'agent';

  service.postBoard('challenge', `challenge #${ch.id} run: launching ${n} agents`, 'note');

  const results = await runPool<AgentRunResult>(n, concurrency, async (i) => {
    const agentId = `${prefix}-${i + 1}`;
    const t0 = Date.now();
    opts.onEvent?.({ type: 'start', agentId, index: i });
    // Register the participant so `uap coord status` sees it.
    service.register(agentId, opts.capabilities ?? ['challenge'], undefined, agentId);
    service.updateStatus(agentId, 'active', `challenge #${ch.id}`);

    const before = service.getSubmissions(ch.id).filter((s) => s.agentId === agentId).length;
    let ok = true;
    let exitCode: number | null | undefined;
    let error: string | undefined;

    try {
      // No slot lease here: a subprocess participant self-leases via its model
      // client (per actual call), and the pool below bounds spawns — so wrapping
      // here too would double-count the same call. In-process participants that
      // call models also lease at the client.
      if (opts.participant) {
        await opts.participant({
          agentId,
          challengeId: ch.id,
          goal: ch.goal,
          metric: ch.metric,
          index: i,
          service,
        });
      } else {
        const cmd = interpolate(opts.cmd!, {
          agent: agentId,
          challenge: String(ch.id),
          goal: ch.goal,
          index: String(i),
        });
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          UAP_AGENT_ID: agentId,
          UAP_CHALLENGE_ID: String(ch.id),
          UAP_CHALLENGE_GOAL: ch.goal,
          UAP_CHALLENGE_METRIC: ch.metric ?? '',
        };
        const r = await runCommand(cmd, cwd, env, timeoutMs);
        exitCode = r.exitCode;
        error = r.error;
        ok = r.exitCode === 0 && !r.error;
      }
    } catch (e) {
      ok = false;
      error = e instanceof Error ? e.message : String(e);
    }

    const after = service.getSubmissions(ch.id).filter((s) => s.agentId === agentId).length;
    const submitted = after - before;
    service.updateStatus(agentId, ok ? 'completed' : 'failed');
    opts.onEvent?.({ type: 'finish', agentId, ok, submitted });
    return { agentId, ok, submitted, durationMs: Date.now() - t0, exitCode, error };
  });

  return {
    challengeId: ch.id,
    agents: n,
    results,
    leaderboard: service.leaderboard(ch.id),
  };
}
