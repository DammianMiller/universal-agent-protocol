/**
 * `uap workflow` — the declarative workflow surface.
 *
 *   uap workflow list                     workflows available (project → home → bundled)
 *   uap workflow show <name>              the validated plan: topo order, kinds, pins, edges
 *   uap workflow run <name> [opts]        execute; exit 0 ok / 1 step failed /
 *                                          2 blocked at a gate / 3 invalid workflow
 *   uap workflow status [runId]            run states under .uap/workflow-runs/
 *   uap workflow resume <runId>            continue a blocked/failed run at the boundary
 *   uap workflow approve <runId> <step>   mark a gate approved (then resume)
 *
 * A workflow is DATA: `.uap/workflows/<name>/workflow.yaml` + role-prompt
 * files. Steps name no model — the pin ladder (step → workflow default →
 * CLI --model → the local fleet default) answers, so the same file runs on
 * the strata arm today and whatever serves tomorrow.
 */

import chalk from 'chalk';
import { existsSync, readdirSync, cpSync, rmSync, statSync } from 'fs';
import { basename, join } from 'path';
import { OpenAICompatClient } from '../models/openai-compat-client.js';
import { ModelPresets, type ModelConfig } from '../models/types.js';
import type { ModelClient } from '../models/executor.js';
import { listWorkflows, loadWorkflow, orderedSteps } from '../workflow/loader.js';
import type { LoadedWorkflow } from '../workflow/types.js';
import {
  approveGate,
  newRunId,
  readRunState,
  runStatePath,
  runWorkflow,
  runsDir,
  type WorkflowRunResult,
} from '../workflow/runner.js';
import { WORKFLOW_EXIT } from '../workflow/types.js';

/**
 * The local fleet default pin — the strata arm preset (proxy-routed, see
 * ModelPresets['qwen38-27b']). Workflows that name nothing run here; a
 * workflow is still fully portable by pinning per step or per file.
 */
export const FLEET_DEFAULT_MODEL = 'qwen38-27b';

export type WorkflowAction = 'list' | 'show' | 'run' | 'status' | 'resume' | 'approve';

export interface WorkflowOptions {
  input?: string;
  model?: string;
  endpoint?: string;
  runId?: string;
  mission?: string;
  parallel?: string;
  temperature?: string;
  dryRun?: boolean;
  json?: boolean;
}

function projectRoot(): string {
  return process.cwd();
}

/** Run ids and workflow names join into filesystem paths — a slug keeps
 * `--run-id ../../somewhere` and friends from relocating the run. */
function assertSafeId(id: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new Error(`invalid ${label} "${id}" — letters, digits, dot, dash, underscore only`);
  }
  return id;
}

/** Pin ladder: step → workflow default → CLI --model → local fleet default. */
function makeModelResolver(
  loaded: LoadedWorkflow,
  cliModel: string | undefined,
  endpoint: string | undefined
): (pin: string | undefined) => ModelConfig {
  const pinFor = (step?: { model?: string }): string =>
    step?.model ?? loaded.def.defaultModel ?? cliModel ?? FLEET_DEFAULT_MODEL;
  return (pin: string | undefined): ModelConfig => {
    // hasOwn, not truthiness: prototype-chain keys ('constructor', '__proto__')
    // are truthy on a bare lookup — the exact trap deliver.ts fixed twice.
    const effective = pin ?? pinFor();
    if (!Object.hasOwn(ModelPresets, effective)) {
      throw new Error(
        `unknown model preset "${effective}" (step pin, workflow defaultModel, --model, or fleet default) — see src/models/types.ts ModelPresets`
      );
    }
    return endpoint ? { ...ModelPresets[effective], endpoint } : ModelPresets[effective];
  };
}

function findRunDir(id: string): string {
  assertSafeId(id, 'run id');
  const dir = join(runsDir(projectRoot()), id);
  if (!existsSync(dir)) {
    throw new Error(`run "${id}" not found under ${runsDir(projectRoot())} — try \`uap workflow status\``);
  }
  return dir;
}

function printResult(res: WorkflowRunResult): void {
  if (res.status === 'succeeded') {
    console.log(chalk.green(`✓ workflow run complete — ${res.completed.length} step(s) accepted, ${res.turns} turn(s)`));
  } else if (res.status === 'blocked') {
    console.log(
      chalk.yellow(`⏸ blocked at gate "${res.blockedStep}" — approve it (\`uap workflow approve <runId> ${res.blockedStep}\`) then \`uap workflow resume <runId>\``)
    );
  } else {
    console.log(chalk.red(`✗ workflow run failed — failed step(s): ${res.failed.join(', ') || '(none recorded)'}`));
  }
}

/** Execute one workflow in `dir` (run or resume share this path). */
async function execute(
  loaded: LoadedWorkflow,
  dir: string,
  options: WorkflowOptions,
  initialDone?: Array<{ id: string; summary: string; contract?: string }>,
  mission?: string
): Promise<never> {
  if (options.dryRun) {
    console.log(chalk.cyan(`workflow "${loaded.def.name}" — execution plan (dry run)`));
    for (const s of orderedSteps(loaded.def)) {
      const pin =
        s.kind === 'agent' ? ` pin=${s.model ?? loaded.def.defaultModel ?? options.model ?? FLEET_DEFAULT_MODEL}` : '';
      console.log(
        `  ${s.kind.padEnd(8)} ${s.id.padEnd(14)}${pin}${s.requires?.length ? `  requires=[${s.requires.join(',')}]` : ''}${s.writes?.length ? `  writes=[${s.writes.join(',')}]` : ''}`
      );
    }
    process.exit(WORKFLOW_EXIT.ok);
  }
  const client: ModelClient = new OpenAICompatClient();
  const log = (line: string): void => console.log(line);
  // --temperature is operator input: validate once, not per request.
  let temperature: number | undefined;
  if (options.temperature !== undefined) {
    temperature = Number(options.temperature);
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      throw new Error(`--temperature must be a number in [0, 2] (got "${options.temperature}")`);
    }
  }
  let parallel: number | undefined;
  if (options.parallel !== undefined) {
    parallel = Number(options.parallel);
    if (!Number.isInteger(parallel) || parallel < 1 || parallel > 16) {
      throw new Error(`--parallel must be an integer in [1, 16] (got "${options.parallel}")`);
    }
  }
  console.log(chalk.cyan(`▶ workflow "${loaded.def.name}" — run ${basename(dir)} (${dir})`));
  try {
    const res = await runWorkflow({
      loaded,
      runDir: dir,
      mission: mission ?? options.mission ?? loaded.def.description ?? `Run workflow "${loaded.def.name}"`,
      resolveModel: makeModelResolver(loaded, options.model, options.endpoint),
      client,
      ...(initialDone ? { initialDone } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      ...(parallel !== undefined ? { parallel } : {}),
      log,
    });
    printResult(res);
    process.exit(res.exitCode);
  } catch (err) {
    console.log(chalk.red(`workflow execution error: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(WORKFLOW_EXIT.stepFailed);
  }
}

export async function workflowCommand(
  action: string,
  nameOrRunId: string | undefined,
  stepId: string | undefined,
  options: WorkflowOptions
): Promise<void> {
  try {
    switch (action) {
      case 'list': {
        const found = listWorkflows(projectRoot());
        if (found.length === 0) {
          console.log(chalk.yellow('no workflows found (searched .uap/workflows/, ~/.uap/workflows/, bundled examples)'));
          return;
        }
        for (const w of found) {
          console.log(`  ${chalk.cyan(w.name.padEnd(24))} ${chalk.gray(w.source)}`);
        }
        return;
      }
      case 'show': {
        if (!nameOrRunId) throw new Error('usage: uap workflow show <name>');
        const loaded = loadWorkflow(nameOrRunId, projectRoot());
        console.log(chalk.cyan(`workflow "${loaded.def.name}"`) + (loaded.def.description ? ` — ${loaded.def.description}` : ''));
        for (const s of orderedSteps(loaded.def)) {
          const pin =
            s.kind === 'agent' ? ` pin=${s.model ?? loaded.def.defaultModel ?? options.model ?? FLEET_DEFAULT_MODEL}` : '';
          console.log(
            `  ${s.kind.padEnd(8)} ${s.id.padEnd(14)}${pin}` +
              `${s.requires?.length ? `  requires=[${s.requires.join(',')}]` : ''}` +
              `${s.writes?.length ? `  writes=[${s.writes.join(',')}]` : ''}` +
              `${s.reads?.length ? `  reads=[${s.reads.join(',')}]` : ''}`
          );
        }
        return;
      }
      case 'run': {
        if (!nameOrRunId) throw new Error('usage: uap workflow run <name> [--input <dir>]');
        const loaded = loadWorkflow(nameOrRunId, projectRoot());
        const runId = assertSafeId(options.runId ?? newRunId(loaded.def.name), 'run id');
        const dir = join(runsDir(projectRoot()), runId);
        // A run into a directory that already holds run state is a restart
        // masquerading as a resume: the runner starts clean and the first
        // progress write would discard the accepted-step ledger. Refuse.
        if (existsSync(runStatePath(dir))) {
          throw new Error(
            `run "${runId}" already exists — resume it (\`uap workflow resume ${runId}\`), or pass a fresh --run-id`
          );
        }
        if (options.input) {
          if (!existsSync(options.input)) throw new Error(`--input directory not found: ${options.input}`);
          if (!statSync(options.input).isDirectory()) {
            throw new Error(`--input must be a directory: ${options.input}`);
          }
          // dereference:true — a symlink planted in the input bundle must not
          // turn a later step write into an arbitrary-file write (or a read
          // into an exfil of whatever it points at).
          cpSync(options.input, dir, { recursive: true, dereference: true });
          // A fresh run owns its state: a run-state.json planted by the input
          // bundle would otherwise look like prior progress (the runner
          // already ignores it; this keeps the directory honest too).
          rmSync(runStatePath(dir), { force: true });
        }
        await execute(loaded, dir, options);
        return;
      }
      case 'resume': {
        if (!nameOrRunId) throw new Error('usage: uap workflow resume <runId>');
        const dir = findRunDir(nameOrRunId);
        const state = readRunState(dir);
        if (!state) throw new Error(`run "${nameOrRunId}" has no readable run-state.json`);
        const loaded = loadWorkflow(state.workflow, projectRoot());
        console.log(chalk.cyan(`▶ resuming "${state.workflow}" run ${state.runId} — ${state.done.length} step(s) already accepted`));
        await execute(loaded, dir, options, state.done, state.mission);
        return;
      }
      case 'approve': {
        if (!nameOrRunId || !stepId) throw new Error('usage: uap workflow approve <runId> <stepId>');
        const dir = findRunDir(nameOrRunId);
        const state = readRunState(dir);
        if (!state) throw new Error(`run "${nameOrRunId}" has no readable run-state.json`);
        const loaded = loadWorkflow(state.workflow, projectRoot());
        const gate = loaded.def.steps.find((s) => s.id === stepId);
        if (!gate || gate.kind !== 'gate') {
          throw new Error(`step "${stepId}" is not a gate of workflow "${state.workflow}"`);
        }
        approveGate(dir, stepId);
        console.log(chalk.green(`✓ gate "${stepId}" approved — \`uap workflow resume ${nameOrRunId}\``));
        return;
      }
      case 'status': {
        const root = runsDir(projectRoot());
        if (nameOrRunId) {
          const state = readRunState(findRunDir(nameOrRunId));
          if (!state) throw new Error(`run "${nameOrRunId}" has no readable run-state.json`);
          if (options.json) {
            console.log(JSON.stringify(state, null, 2));
          } else {
            console.log(
              `${chalk.cyan(state.runId)}  ${state.status}  done=${state.done.length} failed=[${state.failed.join(',')}]  updated=${state.updatedAt}`
            );
            for (const d of state.done) console.log(`  ✓ ${d.id}: ${d.summary}`);
          }
          return;
        }
        if (!existsSync(root)) {
          console.log(chalk.yellow('no workflow runs yet'));
          return;
        }
        const ids = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
        for (const id of ids) {
          const state = readRunState(join(root, id.name));
          console.log(
            state
              ? `  ${state.status.padEnd(10)} ${state.runId.padEnd(36)} done=${String(state.done.length).padStart(2)} ${state.updatedAt}`
              : `  ${chalk.gray('unknown'.padEnd(10))} ${id.name}`
          );
        }
        return;
      }
      default:
        throw new Error(
          `unknown workflow action "${action}" — use list | show | run | status | resume | approve`
        );
    }
  } catch (err) {
    console.log(chalk.red(err instanceof Error ? err.message : String(err)));
    process.exit(WORKFLOW_EXIT.invalid);
  }
}
