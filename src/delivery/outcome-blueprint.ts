/**
 * Phase 0 Outcome Blueprint (Option B1)
 *
 * Counters the local-model "minimum viable toy" first-draft bias on ANY
 * substantive task (web app, CLI, API, library, pipeline, game, 3D scene,
 * documentation). Before writing code, a thinking-ON planning turn expands
 * the user prompt into concrete subsystems, quantitative fidelity targets,
 * machine-checkable runtime invariants, verification perspectives, and
 * anti-patterns — persisted to `.uap/blueprint.json` and `.uap/blueprint.md`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { extractJsonObject } from './acceptance-judge.js';
import { measureQueryComplexity } from '../utils/query-complexity.js';

export interface BlueprintSubsystem {
  name: string;
  purpose: string;
  keyArtifacts: string[];
}

export interface BlueprintRuntimeInvariant {
  subsystem: string;
  invariant: string;
  howToVerify: string;
}

export interface OutcomeBlueprint {
  summary: string;
  subsystems: BlueprintSubsystem[];
  fidelityTargets: string[];
  runtimeInvariants: BlueprintRuntimeInvariant[];
  verificationPerspectives: string[];
  antiPatterns: string[];
  generatedAt: string;
}

export interface GenerateBlueprintOptions {
  instruction: string;
  projectRoot: string;
  executor: (prompt: string) => Promise<string>;
  repoHints?: string;
  persist?: boolean;
}

interface RawBlueprintSubsystem {
  name?: string;
  purpose?: string;
  keyArtifacts?: string[];
  key_artifacts?: string[];
}

interface RawBlueprintInvariant {
  subsystem?: string;
  invariant?: string;
  howToVerify?: string;
  how_to_verify?: string;
}

interface RawBlueprintPayload {
  summary?: string;
  subsystems?: RawBlueprintSubsystem[];
  fidelityTargets?: string[];
  fidelity_targets?: string[];
  runtimeInvariants?: RawBlueprintInvariant[];
  runtime_invariants?: RawBlueprintInvariant[];
  verificationPerspectives?: string[];
  verification_perspectives?: string[];
  antiPatterns?: string[];
  anti_patterns?: string[];
}

function cleanStringList(input: string[] | undefined, cap = 12): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((item): item is string => typeof item === 'string')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, cap);
}

/** Build the generalized Phase 0 Outcome Blueprint prompt for ANY task/domain. */
export function buildBlueprintPrompt(instruction: string, repoHints?: string): string {
  return [
    'You are a Principal Systems Architect creating a Phase 0 Outcome Blueprint BEFORE any code is written.',
    'Your job is to raise the deliverable from a "minimum viable toy" to a complete, cohesive, flagship-quality outcome appropriate to the task domain.',
    '',
    'Produce a structured JSON blueprint with:',
    '1. "summary": 1-2 sentences defining the flagship end state.',
    '2. "subsystems": every concrete functional subsystem required (name, purpose, keyArtifacts). Cover all stated and implied requirements — no omitted features.',
    '3. "fidelityTargets": 4-8 quantitative, domain-appropriate craft/scale/completeness bars distinguishing a flagship deliverable from a bare-bones prototype.',
    '4. "runtimeInvariants": 4-8 machine-checkable RUNTIME truths (what must actually populate, execute, render, respond, or compute at runtime — NOT "it compiles").',
    '5. "verificationPerspectives": 3-6 distinct angles, states, inputs, or edge cases that must be verified independently.',
    '6. "antiPatterns": 3-6 hollow shortcuts to forbid (e.g., stubbed arrays, undefined lookup keys, dead controls, single-file monolith thrashing, unexercised error paths).',
    '',
    `TASK SPECIFICATION:\n${instruction.slice(0, 6000)}`,
    repoHints ? `\nEXISTING REPO CONTEXT:\n${repoHints.slice(0, 2000)}` : '',
    '',
    'Respond with a single JSON object matching this exact schema:',
    '{"summary":"...","subsystems":[{"name":"...","purpose":"...","keyArtifacts":["..."]}],"fidelityTargets":["..."],"runtimeInvariants":[{"subsystem":"...","invariant":"...","howToVerify":"..."}],"verificationPerspectives":["..."],"antiPatterns":["..."]}',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Parse a model response into a validated OutcomeBlueprint, or null on invalid output. */
export function parseOutcomeBlueprint(raw: string): OutcomeBlueprint | null {
  const obj = extractJsonObject(raw) as RawBlueprintPayload | null;
  if (!obj || typeof obj !== 'object') return null;

  const rawSubs = Array.isArray(obj.subsystems) ? obj.subsystems : [];
  const subsystems: BlueprintSubsystem[] = rawSubs
    .filter((s): s is RawBlueprintSubsystem => Boolean(s && typeof s === 'object'))
    .map((s) => ({
      name: typeof s.name === 'string' ? s.name.trim() : '',
      purpose: typeof s.purpose === 'string' ? s.purpose.trim() : '',
      keyArtifacts: cleanStringList(s.keyArtifacts ?? s.key_artifacts, 8),
    }))
    .filter((s) => s.name.length > 0)
    .slice(0, 14);

  const rawInvs = Array.isArray(obj.runtimeInvariants ?? obj.runtime_invariants)
    ? (obj.runtimeInvariants ?? obj.runtime_invariants ?? [])
    : [];
  const runtimeInvariants: BlueprintRuntimeInvariant[] = rawInvs
    .filter((inv): inv is RawBlueprintInvariant => Boolean(inv && typeof inv === 'object'))
    .map((inv) => ({
      subsystem: typeof inv.subsystem === 'string' ? inv.subsystem.trim() : 'core',
      invariant: typeof inv.invariant === 'string' ? inv.invariant.trim() : '',
      howToVerify:
        typeof (inv.howToVerify ?? inv.how_to_verify) === 'string'
          ? String(inv.howToVerify ?? inv.how_to_verify).trim()
          : 'verify via runtime test/execution',
    }))
    .filter((inv) => inv.invariant.length > 0)
    .slice(0, 12);

  const fidelityTargets = cleanStringList(obj.fidelityTargets ?? obj.fidelity_targets, 10);
  const verificationPerspectives = cleanStringList(
    obj.verificationPerspectives ?? obj.verification_perspectives,
    8
  );
  const antiPatterns = cleanStringList(obj.antiPatterns ?? obj.anti_patterns, 8);
  const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';

  if (subsystems.length === 0 && fidelityTargets.length === 0 && runtimeInvariants.length === 0) {
    return null;
  }

  return {
    summary: summary || 'Outcome blueprint for the requested deliverable.',
    subsystems,
    fidelityTargets,
    runtimeInvariants,
    verificationPerspectives,
    antiPatterns,
    generatedAt: new Date().toISOString(),
  };
}

/** Render the OutcomeBlueprint as readable Markdown persisted to `.uap/blueprint.md`. */
export function renderBlueprintMarkdown(bp: OutcomeBlueprint): string {
  const lines: string[] = [
    '# Outcome Blueprint',
    '',
    bp.summary,
    '',
  ];
  if (bp.subsystems.length > 0) {
    lines.push('## Subsystems');
    for (const s of bp.subsystems) {
      const arts = s.keyArtifacts.length > 0 ? ` (${s.keyArtifacts.join(', ')})` : '';
      lines.push(`- **${s.name}**${arts}: ${s.purpose}`);
    }
    lines.push('');
  }
  if (bp.fidelityTargets.length > 0) {
    lines.push('## Fidelity Targets');
    for (const t of bp.fidelityTargets) lines.push(`- ${t}`);
    lines.push('');
  }
  if (bp.runtimeInvariants.length > 0) {
    lines.push('## Runtime Invariants');
    for (const inv of bp.runtimeInvariants) {
      lines.push(`- [${inv.subsystem}] ${inv.invariant} *(verify: ${inv.howToVerify})*`);
    }
    lines.push('');
  }
  if (bp.verificationPerspectives.length > 0) {
    lines.push('## Verification Perspectives');
    for (const v of bp.verificationPerspectives) lines.push(`- ${v}`);
    lines.push('');
  }
  if (bp.antiPatterns.length > 0) {
    lines.push('## Anti-Patterns to Avoid');
    for (const a of bp.antiPatterns) lines.push(`- ${a}`);
    lines.push('');
  }
  return lines.join('\n').trim() + '\n';
}

/** Concise prompt contract injected into ConvergenceLoop beside acceptanceContract/tierContract. */
export function formatBlueprintContract(bp: OutcomeBlueprint): string {
  const sections: string[] = ['OUTCOME BLUEPRINT (build to this flagship bar — not a minimal toy):'];
  if (bp.summary) sections.push(`Goal: ${bp.summary}`);
  if (bp.subsystems.length > 0) {
    sections.push(
      'Required subsystems:\n' +
        bp.subsystems
          .map((s) => `  - ${s.name}: ${s.purpose}${s.keyArtifacts.length ? ` [${s.keyArtifacts.join(', ')}]` : ''}`)
          .join('\n')
    );
  }
  if (bp.fidelityTargets.length > 0) {
    sections.push('Fidelity targets:\n' + bp.fidelityTargets.map((t) => `  - ${t}`).join('\n'));
  }
  if (bp.runtimeInvariants.length > 0) {
    sections.push(
      'Runtime invariants (must hold at runtime, not just compile):\n' +
        bp.runtimeInvariants.map((i) => `  - [${i.subsystem}] ${i.invariant}`).join('\n')
    );
  }
  if (bp.antiPatterns.length > 0) {
    sections.push('Avoid these hollow shortcuts:\n' + bp.antiPatterns.map((a) => `  - ${a}`).join('\n'));
  }
  return sections.join('\n');
}

/** Persist blueprint JSON + Markdown under `<projectRoot>/.uap/`. */
export function saveOutcomeBlueprint(projectRoot: string, bp: OutcomeBlueprint): void {
  const dir = join(projectRoot, '.uap');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'blueprint.json'), JSON.stringify(bp, null, 2) + '\n', 'utf-8');
  writeFileSync(join(dir, 'blueprint.md'), renderBlueprintMarkdown(bp), 'utf-8');
}

/** Load an existing OutcomeBlueprint from `<projectRoot>/.uap/blueprint.json` (or null). */
export function loadOutcomeBlueprint(projectRoot: string): OutcomeBlueprint | null {
  const file = join(projectRoot, '.uap', 'blueprint.json');
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as OutcomeBlueprint;
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.subsystems)) {
      return parsed;
    }
  } catch {
    /* ignore malformed blueprint file */
  }
  return null;
}

/** Generate (and optionally persist) the Phase 0 Outcome Blueprint. Fail-soft on errors. */
export async function generateOutcomeBlueprint(
  opts: GenerateBlueprintOptions
): Promise<OutcomeBlueprint | null> {
  try {
    const raw = await opts.executor(buildBlueprintPrompt(opts.instruction, opts.repoHints));
    const bp = parseOutcomeBlueprint(raw);
    if (!bp) return null;
    if (opts.persist !== false) {
      saveOutcomeBlueprint(opts.projectRoot, bp);
    }
    return bp;
  } catch {
    return null;
  }
}

/**
 * Reactor injection (direct sessions):
 * - If `.uap/blueprint.md` already exists in the project, surface a concise excerpt.
 * - Otherwise, for substantive multi-subsystem prompts (moderate/complex per
 *   `measureQueryComplexity`, >= 60 chars, domain-agnostic), inject a Phase 0
 *   Outcome Blueprint discipline directive so direct-mode agents plan subsystems,
 *   fidelity targets, and runtime invariants before editing.
 */
export function maybeBlueprintInjection(cwd: string, promptText: string): string | null {
  const existingMd = join(cwd, '.uap', 'blueprint.md');
  if (existsSync(existingMd)) {
    try {
      const md = readFileSync(existingMd, 'utf-8').trim();
      if (md) {
        return `Active project blueprint (.uap/blueprint.md — verify all subsystems & runtime invariants):\n${md.slice(0, 1400)}`;
      }
    } catch {
      /* ignore unreadable blueprint */
    }
  }

  const trimmed = promptText.trim();
  if (trimmed.length < 60) return null;
  const complexity = measureQueryComplexity(trimmed);
  if (complexity === 'simple') return null;

  return (
    'Before writing code on this multi-part task, establish a brief Phase 0 Outcome Blueprint ' +
    '(save to `.uap/blueprint.md` if helpful): ' +
    '(1) list every required subsystem and artifact, ' +
    '(2) set concrete quantitative fidelity/completeness targets so the first draft is flagship quality rather than a bare-bones stub, ' +
    '(3) define runtime invariants that must hold when executed (not just compile-green), and ' +
    '(4) plan multi-angle behavioral verification before finishing.'
  );
}
