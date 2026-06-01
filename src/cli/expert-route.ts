import chalk from 'chalk';
import {
  ExpertOrchestrator,
  planFromDescription,
  type ChainPlan,
  type ChainPhase,
} from '../coordination/expert-orchestrator.js';

export interface ExpertRouteOptions {
  files?: string[];
  json?: boolean;
}

const PHASE_LABEL: Record<ChainPhase, string> = {
  ideate: '💡 Ideate',
  plan: '📋 Plan',
  design: '🏗  Design',
  implement: '⚙️  Implement',
  review: '🔍 Review',
  release: '🚀 Release',
};

/**
 * `uap expert-route <task>` — print the recommended expert droid chain for
 * a task description. Supports `--files` to scope by affected paths and
 * `--json` for machine-readable output.
 */
export async function expertRouteCommand(
  description: string,
  options: ExpertRouteOptions = {}
): Promise<void> {
  if (!description || description.trim().length === 0) {
    console.error(chalk.red('expert-route: task description required'));
    process.exit(2);
  }

  const orchestrator = new ExpertOrchestrator();
  const plan = planFromDescription(description, orchestrator, options.files);

  if (options.json || !process.stdout.isTTY) {
    process.stdout.write(JSON.stringify(toJson(plan), null, 2) + '\n');
    return;
  }

  printPlan(plan);
}

function toJson(plan: ChainPlan): unknown {
  return {
    task: plan.task,
    confidence: plan.confidence,
    matched_capabilities: plan.capability.matchedCapabilities,
    steps: plan.steps.map((s) => ({
      phase: s.phase,
      droid: s.droid,
      parallel: s.parallel,
      rationale: s.rationale,
      success_rate: s.successRate,
    })),
  };
}

function printPlan(plan: ChainPlan): void {
  console.log(chalk.bold('\n🤖 Expert Droid Chain\n'));
  console.log(`  ${chalk.dim('Task:')}        ${plan.task}`);
  console.log(`  ${chalk.dim('Confidence:')}  ${(plan.confidence * 100).toFixed(0)}%`);
  console.log(
    `  ${chalk.dim('Matched:')}     ${plan.capability.matchedCapabilities.join(', ') || chalk.dim('(no specific capability)')}`
  );
  console.log('');

  let lastPhase: ChainPhase | null = null;
  for (const step of plan.steps) {
    if (step.phase !== lastPhase) {
      console.log(chalk.bold(`  ${PHASE_LABEL[step.phase]}`));
      lastPhase = step.phase;
    }
    const parallelTag = step.parallel ? chalk.dim(' [parallel]') : '';
    const rate =
      step.successRate === null
        ? chalk.dim(' (no history)')
        : ` ${chalk.green(((step.successRate * 100) | 0) + '% success')}`;
    console.log(`    • ${chalk.cyan(step.droid)}${parallelTag}${rate}`);
    console.log(`      ${chalk.dim(step.rationale)}`);
  }

  if (plan.steps.length === 0) {
    console.log(chalk.yellow('  No droids matched; consider broadening the task description.'));
  }
  console.log('');
}
