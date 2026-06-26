import chalk from 'chalk';
import { CoordinationService } from '../coordination/service.js';
import { runChallengeAgents } from '../coordination/challenge-runner.js';

/**
 * `uap challenge` — open multi-agent challenge mode.
 *
 * Composes the collaboration board, findings ledger, staged-work relay, and the
 * benchmark significance norm into a single shared goal: N agents work a common
 * board, submit verified results, and a leaderboard ranks them with the
 * "frontier deltas within noise are ties" rule applied.
 */
export type ChallengeAction =
  | 'create' | 'submit' | 'verify' | 'leaderboard' | 'status' | 'list' | 'close' | 'run';

export interface ChallengeOptions {
  goal?: string;
  id?: string;
  metric?: string;
  ropeMargin?: string;
  lowerIsBetter?: boolean;
  score?: string;
  artifact?: string;
  note?: string;
  verified?: boolean;
  agent?: string;
  status?: string;
  json?: boolean;
  agents?: string;
  concurrency?: string;
  cmd?: string;
  timeout?: string;
  prefix?: string;
  yes?: boolean;
}

function agentId(o: ChallengeOptions): string {
  return o.agent || process.env.UAP_AGENT_ID || process.env.UAP_AGENT || 'cli';
}

/** Interactive y/N confirmation (auto-yes on non-TTY or with --yes). */
async function confirmLaunch(prompt: string, skip: boolean): Promise<boolean> {
  if (skip || !process.stdin.isTTY || !process.stdout.isTTY) return true;
  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = (await rl.question(prompt + ' [y/N] ')).trim().toLowerCase();
    return ans === 'y' || ans === 'yes';
  } finally {
    rl.close();
  }
}


export async function challengeCommand(action: ChallengeAction, options: ChallengeOptions = {}): Promise<void> {
  const service = new CoordinationService();
  switch (action) {
    case 'create': {
      const goal = (options.goal || '').trim();
      if (!goal) { console.log(chalk.yellow('  Usage: uap challenge create "<goal>" [--metric tps] [--rope-margin 4] [--lower-is-better]')); process.exitCode = 1; return; }
      const id = service.createChallenge(goal, {
        metric: options.metric,
        higherIsBetter: !options.lowerIsBetter,
        ropeMargin: options.ropeMargin ? parseFloat(options.ropeMargin) : 0,
      });
      console.log(chalk.green(`  ✓ challenge #${id} opened (goal + norms posted to the board)`));
      console.log(chalk.dim(`    agents: submit with  uap challenge submit ${id} --score <x> --artifact <ref> --verified`));
      return;
    }
    case 'submit': {
      const cid = parseInt(options.id || '', 10);
      const score = parseFloat(options.score || '');
      if (!Number.isFinite(cid) || !Number.isFinite(score)) { console.log(chalk.yellow('  Usage: uap challenge submit <challenge-id> --score <x> [--artifact] [--verified]')); process.exitCode = 1; return; }
      const sid = service.submitToChallenge(cid, agentId(options), score, {
        artifact: options.artifact, note: options.note, verified: options.verified,
      });
      console.log(chalk.green(`  ✓ submission #${sid} recorded (score ${score}${options.verified ? ', verified' : ', UNVERIFIED — only verified entries rank'})`));
      return;
    }
    case 'verify': {
      const sid = parseInt(options.id || '', 10);
      if (!Number.isFinite(sid)) { console.log(chalk.yellow('  Usage: uap challenge verify <submission-id>')); process.exitCode = 1; return; }
      const ok = service.verifySubmission(sid);
      console.log(ok ? chalk.green(`  ✓ submission #${sid} verified`) : chalk.yellow(`  submission #${sid} not found`));
      if (!ok) process.exitCode = 1;
      return;
    }
    case 'leaderboard':
    case 'status': {
      const cid = parseInt(options.id || '', 10);
      const ch = Number.isFinite(cid) ? service.getChallenge(cid) : null;
      if (!ch) { console.log(chalk.yellow(`  challenge #${options.id} not found`)); process.exitCode = 1; return; }
      const board = service.leaderboard(cid);
      if (options.json) { console.log(JSON.stringify({ challenge: ch, leaderboard: board }, null, 2)); return; }
      console.log(chalk.bold(`\n  Challenge #${ch.id} [${ch.status}] — ${ch.goal}`));
      console.log(chalk.dim(`  metric: ${ch.metric ?? '—'} · ${ch.higherIsBetter ? 'higher' : 'lower'} is better · tie margin ±${ch.ropeMargin}\n`));
      if (board.length === 0) {
        console.log(chalk.dim('  No verified submissions yet.\n'));
      } else {
        for (const e of board) {
          const badge = e.tiedForLead ? chalk.yellow('⚪ TIE-LEAD') : e.rank === 1 ? chalk.green('🟢 LEAD') : chalk.dim(`#${e.rank}`);
          console.log(`  ${badge}  score ${e.submission.score}  ${chalk.dim((e.submission.agentId || '—').slice(0, 14))}  ${e.submission.artifact ? chalk.dim(e.submission.artifact) : ''}`);
        }
        const tied = board.filter((e) => e.tiedForLead).length;
        if (tied > 1) console.log(chalk.dim(`\n  ${tied} entries tie for the lead (within ±${ch.ropeMargin} — noise).`));
        console.log('');
      }
      if (action === 'status') {
        const findings = service.listFindings({ limit: 100 }).length;
        const staged = service.listStaged({ limit: 200 }).length;
        const posts = service.readBoard({ limit: 500 }).length;
        console.log(chalk.dim(`  board posts: ${posts} · findings: ${findings} · staged items: ${staged}\n`));
      }
      return;
    }
    case 'list': {
      const chs = service.listChallenges({ status: options.status as 'open' | 'closed' | undefined });
      if (options.json) { console.log(JSON.stringify(chs, null, 2)); return; }
      if (chs.length === 0) { console.log(chalk.dim('  No challenges. Open one: uap challenge create "<goal>"')); return; }
      console.log(chalk.bold('\n  Challenges\n'));
      for (const c of chs) {
        const st = c.status === 'open' ? chalk.green('open') : chalk.gray('closed');
        console.log(`  #${c.id} ${st}  ${c.goal}${c.metric ? chalk.dim(` [${c.metric}]`) : ''}`);
      }
      console.log('');
      return;
    }
    case 'close': {
      const cid = parseInt(options.id || '', 10);
      const ok = Number.isFinite(cid) && service.closeChallenge(cid);
      console.log(ok ? chalk.green(`  ✓ challenge #${cid} closed`) : chalk.yellow(`  challenge #${options.id} not open/found`));
      if (!ok) process.exitCode = 1;
      return;
    }
    case 'run': {
      const cid = parseInt(options.id || '', 10);
      const agents = parseInt(options.agents || '', 10);
      if (!Number.isFinite(cid) || !Number.isFinite(agents) || agents < 1) {
        console.log(chalk.yellow('  Usage: uap challenge run <challenge-id> --agents <N> --cmd "<participant command>"'));
        process.exitCode = 1; return;
      }
      if (!options.cmd) {
        console.log(chalk.yellow('  --cmd is required: the participant program per agent.'));
        console.log(chalk.dim('  Placeholders: {agent} {challenge} {goal} {index}; env: UAP_AGENT_ID, UAP_CHALLENGE_ID, UAP_CHALLENGE_GOAL.'));
        console.log(chalk.dim('  The command should do the work and call: uap challenge submit {challenge} --score <x> --verified --agent {agent}'));
        process.exitCode = 1; return;
      }
      const { getMaxModelConcurrency, warmModelSlotBudget } = await import('../utils/model-slots.js');
      await warmModelSlotBudget(process.cwd());
      const conc = options.concurrency ? parseInt(options.concurrency, 10) : getMaxModelConcurrency(process.cwd());
      const proceed = await confirmLaunch(
        chalk.yellow(`  About to launch ${agents} agents (concurrency ${conc}) running per agent:\n    ${options.cmd}\n  This spawns processes that may build/run code. Proceed?`),
        !!options.yes
      );
      if (!proceed) { console.log(chalk.dim('  aborted.')); return; }
      console.log(chalk.bold(`\n  Running challenge #${cid} with ${agents} agents (concurrency ${conc})…\n`));
      let report;
      try {
        report = await runChallengeAgents(service, {
          challengeId: cid,
          agents,
          concurrency: conc,
          timeoutMs: options.timeout ? parseInt(options.timeout, 10) * 1000 : undefined,
          cmd: options.cmd,
          agentPrefix: options.prefix,
          onEvent: (e) => {
            if (e.type === 'finish') {
              const mark = e.ok ? chalk.green('✓') : chalk.red('✗');
              console.log(`  ${mark} ${e.agentId} — ${e.submitted > 0 ? chalk.green(e.submitted + ' submission(s)') : chalk.dim('no submission')}`);
            }
          },
        });
      } catch (err) {
        console.log(chalk.red('  run failed: ' + (err instanceof Error ? err.message : String(err))));
        process.exitCode = 1; return;
      }
      if (options.json) { console.log(JSON.stringify(report, null, 2)); return; }
      const submitted = report.results.filter((r) => r.submitted > 0).length;
      const failed = report.results.filter((r) => !r.ok).length;
      console.log(chalk.dim(`\n  ${report.agents} agents · ${submitted} submitted · ${failed} failed`));
      await challengeCommand('leaderboard', { id: String(cid) });
      return;
    }
  }
}
