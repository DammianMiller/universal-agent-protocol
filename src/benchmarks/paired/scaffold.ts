/**
 * UAP scaffolding injection — the actual on/off mechanism for the A/B.
 *
 * A controlled experiment must change exactly ONE thing between arms: the
 * presence of the UAP layer. For a real coding agent, "UAP" is the instruction
 * surface + component config the agent's installed hooks consume. This module
 * writes that surface into the scratch repo for the enabled components, and
 * nothing for the baseline. Everything else (model, prompt, repo state, seed)
 * is held identical by the runner.
 *
 * The injected files are deliberately plain-text and inspectable so a reviewer
 * can audit precisely what the "treatment" was (HAL-style log/scaffold audit),
 * pre-empting the "asymmetric prompt" critique that sank prior memory-layer
 * benchmarks.
 */

import { writeFileSync } from 'fs';
import { join } from 'path';

import { Condition, UAP_COMPONENTS, UapComponent } from './types.js';

/** Human-readable instruction block injected per enabled component. */
const COMPONENT_INSTRUCTIONS: Record<UapComponent, string> = {
  gates:
    '## Completion Gates\nBefore claiming the task is done, you MUST run the build, ' +
    'the test suite, and the linter, and confirm all pass. Do not stop while any ' +
    'gate is failing. Re-verify at least once after your final edit.',
  worktree:
    '## Isolation\nMake all edits within this repository only. Do not touch files ' +
    'outside the working directory. Keep changes scoped and atomic.',
  memory:
    '## Memory\nRelevant prior context and learned patterns for this repository are ' +
    'available. Consult them before editing and prefer established patterns over ad-hoc ones.',
  experts:
    '## Expert Routing\nFor specialized sub-problems (security, performance, tests), ' +
    'apply the matching expert discipline and review the change against its checklist.',
  skills:
    '## Skills\nWhen a domain-specific workflow matches the task, follow its ' +
    'structured procedure rather than improvising.',
  patterns:
    '## Patterns\nMatch the task to a known execution pattern; in particular always ' +
    'verify the produced output actually exists and the decoder/contract is satisfied.',
};

export interface ScaffoldManifest {
  components: UapComponent[];
  injectedFiles: string[];
}

/**
 * Write the UAP instruction surface for `condition` into `workdir`.
 * Returns a manifest of what was injected (empty for the baseline).
 */
export function applyScaffolding(workdir: string, condition: Condition): ScaffoldManifest {
  const enabled = UAP_COMPONENTS.filter((c) => condition.components.has(c));
  if (enabled.length === 0) {
    return { components: [], injectedFiles: [] };
  }

  const injectedFiles: string[] = [];

  // AGENTS.md is the cross-agent instruction file (Claude, opencode, Codex, etc.
  // all read it). This is the primary, honest treatment surface.
  const header =
    '# UAP Operating Protocol\n\n' +
    'The following protocol is active for this task. Follow it precisely.\n';
  const body = enabled.map((c) => COMPONENT_INSTRUCTIONS[c]).join('\n\n');
  const agentsMd = `${header}\n${body}\n`;
  writeFileSync(join(workdir, 'AGENTS.md'), agentsMd, 'utf-8');
  injectedFiles.push('AGENTS.md');

  // Machine-readable manifest that installed UAP hooks can consume to enable the
  // corresponding enforcement (gates/memory/reactor) at runtime.
  const manifest = {
    enabled,
    condition: condition.label,
    generatedBy: 'uap-paired-bench',
  };
  writeFileSync(join(workdir, '.uap-bench.json'), JSON.stringify(manifest, null, 2), 'utf-8');
  injectedFiles.push('.uap-bench.json');

  return { components: enabled, injectedFiles };
}

/** Environment variables exported to the agent describing the active condition. */
export function scaffoldEnv(condition: Condition): NodeJS.ProcessEnv {
  const enabled = UAP_COMPONENTS.filter((c) => condition.components.has(c));
  return {
    UAP_BENCH_CONDITION: condition.label,
    UAP_BENCH_COMPONENTS: enabled.join(','),
    // Enable/disable the real delivery-enforcement surface to match the arm.
    UAP_DELIVER_ACTIVE: enabled.includes('gates') ? '1' : '0',
  };
}
