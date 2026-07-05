/**
 * `uap handsfree` — the hands-free persistence surface (Options A-D).
 *
 *   uap handsfree status                 show master switch, model profile, ledger progress
 *   uap handsfree on | off               toggle the master switch (.uap.json handsfree.enabled)
 *   uap handsfree init --mission <m> --items <json>   create the completion ledger
 *   uap handsfree complete <id> | fail <id>           update an item
 *   uap handsfree remaining              print what still needs doing
 *   uap handsfree stop-check             Stop-hook entry: block session-end (exit 2)
 *                                        while the build is incomplete, else allow (exit 0)
 *
 * `stop-check` is the enforcement lever (Option A). It is auto-ON but only ever
 * blocks when there is an ACTIVE ledger with remaining items, honors
 * stop_hook_active, applies the model profile (Option C), and is bounded by
 * per-build block/stagnation counters so it can never wedge the agent (the
 * balance between "never stop early" and "never spin forever").
 */

import chalk from 'chalk';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { findUapConfigPath, modifyUapConfig } from '../utils/config-loader.js';
import {
  loadLedger,
  initLedger,
  markItem,
  remainingItems,
  isComplete,
  formatRemaining,
  progress,
  syncLedgerFromTodos,
  type NewItem,
  type TodoInput,
} from '../delivery/completion-ledger.js';
import { loadPersistenceConfig, resolveActiveModel } from '../delivery/handsfree-config.js';
import { resolvePersistenceProfile } from '../delivery/persistence-profile.js';

interface AntiSpinState {
  blocks: number;
  lastRemaining: number;
}

function statePath(cwd: string): string {
  return join(cwd, '.uap', 'handsfree-state.json');
}
function loadState(cwd: string): AntiSpinState {
  try {
    return JSON.parse(readFileSync(statePath(cwd), 'utf-8')) as AntiSpinState;
  } catch {
    return { blocks: 0, lastRemaining: Number.MAX_SAFE_INTEGER };
  }
}
function saveState(cwd: string, st: AntiSpinState): void {
  try {
    const p = statePath(cwd);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(st));
  } catch {
    /* best-effort */
  }
}
function resetState(cwd: string): void {
  saveState(cwd, { blocks: 0, lastRemaining: Number.MAX_SAFE_INTEGER });
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  try {
    for await (const c of process.stdin) chunks.push(c as Buffer);
  } catch {
    return '';
  }
  return Buffer.concat(chunks).toString('utf-8').trim();
}

/**
 * Stop-hook decision. Pure so it is unit-testable without process/exit:
 * returns { block, message } given the current ledger state + profile + input.
 */
export function decideStopCheck(
  cwd: string,
  stopHookActive: boolean
): { block: boolean; message: string; giveUp?: boolean } {
  const cfg = loadPersistenceConfig(cwd);
  if (cfg.enabled === false) return { block: false, message: 'hands-free disabled' };
  if (stopHookActive) return { block: false, message: 'stop_hook_active — never re-block' };

  const ledger = loadLedger(cwd);
  if (!ledger) return { block: false, message: 'no active build ledger' };
  if (isComplete(ledger)) {
    resetState(cwd);
    return { block: false, message: 'build complete — all ledger items done' };
  }

  const profile = resolvePersistenceProfile(resolveActiveModel(cwd), cfg);
  if (!profile.stopHookBlocks) {
    return { block: false, message: `profile ${profile.family}/${profile.intensity} does not block` };
  }

  const rem = remainingItems(ledger).length;
  const st = loadState(cwd);
  const madeProgress = rem < st.lastRemaining;
  const blocks = madeProgress ? 0 : st.blocks; // progress resets the counter

  // Give up (allow stop) when the hard cap is hit, or we've stalled with no
  // progress for stagnationLimit consecutive blocks — never spin forever.
  if (blocks >= profile.maxBlocks || (!madeProgress && blocks >= profile.stagnationLimit)) {
    saveState(cwd, { blocks: 0, lastRemaining: rem });
    return {
      block: false,
      giveUp: true,
      message:
        `hands-free give-up after ${blocks} block(s) with no progress — ` +
        `${rem} item(s) still remain. Consider escalating the model or splitting the work.`,
    };
  }

  saveState(cwd, { blocks: blocks + 1, lastRemaining: rem });
  return {
    block: true,
    message:
      `NOT DONE — the multi-epic build is incomplete (${profile.family}/${profile.intensity}, ` +
      `block ${blocks + 1}/${profile.maxBlocks}). Keep working hands-free; do NOT stop.\n\n` +
      formatRemaining(ledger),
  };
}

export interface HandsfreeOptions {
  mission?: string;
  items?: string;
  intensity?: string;
}

export async function handsfreeCommand(
  sub: string | undefined,
  arg: string | undefined,
  options: HandsfreeOptions = {}
): Promise<void> {
  const cwd = process.cwd();
  const norm = (sub ?? 'status').toLowerCase();

  switch (norm) {
    case 'stop-check': {
      const input = await readStdin();
      const stopHookActive = /"stop_hook_active"\s*:\s*true/.test(input);
      const d = decideStopCheck(cwd, stopHookActive);
      if (d.block) {
        // stderr becomes model-facing feedback; exit 2 blocks session-end.
        process.stderr.write(d.message + '\n');
        process.exitCode = 2;
      } else {
        if (d.giveUp) process.stderr.write(chalk.dim(d.message) + '\n');
        process.exitCode = 0;
      }
      return;
    }

    case 'status': {
      const cfg = loadPersistenceConfig(cwd);
      const model = resolveActiveModel(cwd);
      const profile = resolvePersistenceProfile(model, cfg);
      const enabled = cfg.enabled !== false;
      console.log(`Hands-free persistence: ${enabled ? chalk.green('ON') : chalk.red('OFF')}`);
      console.log(
        `  model: ${chalk.cyan(model)} -> profile ${chalk.yellow(profile.family)}/${profile.intensity} ` +
          `(blocks<=${profile.maxBlocks}, stagnation=${profile.stagnationLimit}, ` +
          `stopHookBlocks=${profile.stopHookBlocks}, injectAutonomy=${profile.injectAutonomy})`
      );
      const ledger = loadLedger(cwd);
      if (ledger) {
        const p = progress(ledger);
        console.log(
          `  ledger: ${chalk.bold(`${p.done}/${p.total}`)} done (${p.pct}%), ` +
            `${p.failed} failed, ${p.pending} pending`
        );
        if (!isComplete(ledger)) console.log(chalk.dim('  ' + formatRemaining(ledger, 6).replace(/\n/g, '\n  ')));
      } else {
        console.log(chalk.dim('  ledger: none (no multi-epic build in progress)'));
      }
      return;
    }

    case 'on':
    case 'off': {
      if (!findUapConfigPath()) {
        console.error(chalk.yellow('No .uap.json found — run `uap init` first.'));
        process.exitCode = 1;
        return;
      }
      const enabled = norm === 'on';
      modifyUapConfig(cwd, (c) => {
        const hf = { ...((c as Record<string, unknown>).handsfree as Record<string, unknown> | undefined) };
        hf.enabled = enabled;
        return { ...c, handsfree: hf };
      });
      console.log(chalk.green(`✓ Hands-free persistence ${enabled ? 'ENABLED' : 'DISABLED'} (.uap.json handsfree.enabled).`));
      return;
    }

    case 'init': {
      const mission = options.mission ?? arg ?? '';
      if (!mission) {
        console.error(chalk.red('init requires --mission "<goal>"'));
        process.exitCode = 1;
        return;
      }
      let items: NewItem[] = [];
      const raw = options.items ?? (await readStdin());
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as NewItem[];
          if (Array.isArray(parsed)) items = parsed;
        } catch {
          console.error(chalk.red('--items must be a JSON array of {id,title,kind?,deps?,criteria?}'));
          process.exitCode = 1;
          return;
        }
      }
      if (items.length === 0) {
        console.error(chalk.red('init requires at least one item (--items JSON or stdin).'));
        process.exitCode = 1;
        return;
      }
      const ledger = initLedger(cwd, mission, items);
      resetState(cwd);
      console.log(chalk.green(`✓ Completion ledger created: ${ledger.items.length} item(s) for "${mission.slice(0, 60)}".`));
      return;
    }

    case 'complete':
    case 'done': {
      if (!arg) { console.error(chalk.red('complete requires <id>')); process.exitCode = 1; return; }
      console.log(markItem(cwd, arg, 'done') ? chalk.green(`✓ ${arg} marked done`) : chalk.yellow(`no ledger item '${arg}'`));
      return;
    }
    case 'fail': {
      if (!arg) { console.error(chalk.red('fail requires <id>')); process.exitCode = 1; return; }
      console.log(markItem(cwd, arg, 'failed', 'marked failed') ? chalk.red(`✗ ${arg} marked failed`) : chalk.yellow(`no ledger item '${arg}'`));
      return;
    }

    case 'remaining': {
      const ledger = loadLedger(cwd);
      if (!ledger) { console.log('no active build ledger'); return; }
      console.log(formatRemaining(ledger, 50));
      return;
    }

    case 'sync-todos': {
      // Auto-seed (full automation): mirror the model's plan (TodoWrite) into
      // the completion ledger so an interactive multi-step build gets a ledger
      // with zero manual `init`. Silent + fail-open; only seeds a real plan.
      const cfg = loadPersistenceConfig(cwd);
      if (cfg.enabled === false) return;
      const input = await readStdin();
      let todos: TodoInput[] = [];
      try {
        const payload = JSON.parse(input) as { tool_input?: { todos?: TodoInput[] }; todos?: TodoInput[] };
        todos = payload.tool_input?.todos ?? payload.todos ?? [];
      } catch {
        return;
      }
      const minTodos = Number(process.env.UAP_HANDSFREE_MIN_TODOS ?? 3);
      // Only auto-seed a genuine multi-step plan. But once a ledger exists, keep
      // it in sync even if the list temporarily shrinks below the threshold.
      const { ledgerExists } = await import('../delivery/completion-ledger.js');
      if (todos.length < minTodos && !ledgerExists(cwd)) return;
      if (todos.length === 0) return;
      syncLedgerFromTodos(cwd, todos, options.mission);
      return;
    }

    case 'resume-banner': {
      // Auto-resume: on session start, surface an in-progress build so the
      // model picks it back up without being asked. Prints nothing otherwise.
      const cfg = loadPersistenceConfig(cwd);
      if (cfg.enabled === false) return;
      const ledger = loadLedger(cwd);
      if (!ledger || isComplete(ledger)) return;
      const p = progress(ledger);
      console.log('## Resuming a build in progress (hands-free)');
      console.log(
        `A multi-epic build is ${p.done}/${p.total} (${p.pct}%) complete and was left unfinished. ` +
          'Resume it now and keep going hands-free until every item is done — do not wait to be asked, ' +
          'do not restart from scratch.'
      );
      console.log('');
      console.log(formatRemaining(ledger, 20));
      return;
    }

    default:
      console.error(chalk.red(`Unknown handsfree subcommand '${sub}'. Use: status | on | off | init | complete | fail | remaining | sync-todos | resume-banner | stop-check`));
      process.exitCode = 1;
  }
}
