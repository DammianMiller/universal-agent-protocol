import chalk from 'chalk';
import { CoordinationService } from '../coordination/service.js';

/**
 * `uap challenge` — open multi-agent challenge mode.
 *
 * Composes the collaboration board, findings ledger, staged-work relay, and the
 * benchmark significance norm into a single shared goal: N agents work a common
 * board, submit verified results, and a leaderboard ranks them with the
 * "frontier deltas within noise are ties" rule applied.
 */
export type ChallengeAction =
  | 'create' | 'submit' | 'verify' | 'leaderboard' | 'status' | 'list' | 'close';

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
}

function agentId(o: ChallengeOptions): string {
  return o.agent || process.env.UAP_AGENT_ID || process.env.UAP_AGENT || 'cli';
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
  }
}
