/**
 * Workflow loader — turn `workflow.yaml` into a validated, ready-to-run DAG.
 *
 * Fail-closed by construction: every structural problem (unknown edge, cycle,
 * missing role prompt, parallel write collision, path escape) is a load error
 * here, BEFORE any model is paid for — the same "verify before you spend"
 * discipline the delivery layer applies to gates. A workflow that loads is a
 * workflow whose graph semantics are the orchestrator's, not its own.
 *
 * Search order (first hit wins, so an operator can override a bundled
 * workflow without touching the install):
 *   1. <projectRoot>/.uap/workflows/<name>/
 *   2. ~/.uap/workflows/<name>/
 *   3. <package root>/examples/workflows/<name>/     (bundled)
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { topoOrder } from '../delivery/decompose.js';
import type { DeliveryPhase } from '../delivery/decompose.js';
import { ModelPresets } from '../models/types.js';
import {
  WORKFLOW_FILE,
  parseWorkflowDef,
  type LoadedWorkflow,
  type WorkflowDef,
  type WorkflowStep,
} from './types.js';

/** Per-step read/write declarations are run-directory RELATIVE. Absolute
 * paths and `..` escapes would leak a step outside its file ledger. */
function assertRunDirRelative(label: string, p: string, dir: string): void {
  if (isAbsolute(p) || p.split('/').includes('..')) {
    throw new Error(`${label} "${p}" must be relative to the workflow run directory`);
  }
  // Prompt files live in the workflow's own directory, not the run dir.
  if (dir) {
    const abs = resolve(dir, p);
    if (relative(dir, abs).startsWith('..')) {
      throw new Error(`${label} "${p}" escapes the workflow directory`);
    }
  }
}

/** True when `from` reaches `to` over `requires` edges (direct or transitive). */
function reaches(steps: Map<string, WorkflowStep>, from: string, to: string): boolean {
  const seen = new Set<string>();
  const stack = [...(steps.get(from)?.requires ?? [])];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === to) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...(steps.get(cur)?.requires ?? []));
  }
  return false;
}

/** Kahn's algorithm: true when the graph has a cycle. Indegree counts a
 * step's own REQUIREMENTS (edges into it from its prerequisites). topoOrder
 * (decompose) fails SOFT to planner order on cycles — right for
 * model-authored plans, wrong for a static file, where a cycle is an
 * authoring bug to surface. */
function hasCycle(def: WorkflowDef): boolean {
  // Dedupe each step's requirements: a repeated edge ([a, a]) never reaches
  // indegree 0 and would masquerade as a cycle. Fail-closed, wrong reason.
  const indeg = new Map<string, number>();
  for (const s of def.steps) indeg.set(s.id, new Set(s.requires ?? []).size);
  const queue = [...indeg.entries()].filter(([, n]) => n === 0).map(([id]) => id);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.pop()!;
    visited++;
    for (const s of def.steps) {
      if ((s.requires ?? []).includes(id)) {
        const n = (indeg.get(s.id) ?? 0) - 1;
        indeg.set(s.id, n);
        if (n === 0) queue.push(s.id);
      }
    }
  }
  return visited !== def.steps.length;
}

/** Semantic checks that zod cannot express (cross-step invariants). */
function validateGraph(def: WorkflowDef): void {
  const ids = new Set<string>();
  for (const s of def.steps) {
    if (ids.has(s.id)) throw new Error(`duplicate step id "${s.id}"`);
    ids.add(s.id);
  }
  const byId = new Map(def.steps.map((s) => [s.id, s]));
  for (const s of def.steps) {
    for (const d of s.requires ?? []) {
      if (!ids.has(d)) throw new Error(`step "${s.id}" requires unknown step "${d}"`);
    }
    if (s.kind === 'agent' || s.kind === 'loop') {
      if ((s.prompt ? 1 : 0) + (s.goal ? 1 : 0) !== 1) {
        throw new Error(`${s.kind} step "${s.id}" needs exactly one of prompt: or goal:`);
      }
    }
    if (s.kind === 'command' && !s.command) {
      throw new Error(`command step "${s.id}" needs command:`);
    }
    if (s.kind !== 'command' && (s.command || s.neverFails || s.timeoutMs)) {
      throw new Error(`step "${s.id}" declares command-only fields but is kind: ${s.kind}`);
    }
    if (s.kind !== 'gate' && s.approvalPrompt) {
      throw new Error(`step "${s.id}" declares approvalPrompt: but is kind: ${s.kind}`);
    }
    if (s.kind !== 'agent' && s.kind !== 'loop' && (s.prompt || s.goal || s.reads)) {
      throw new Error(`step "${s.id}" declares agent/loop-only fields but is kind: ${s.kind}`);
    }
    if (s.kind !== 'loop' && (s.turns !== undefined || s.verifyOnly !== undefined)) {
      throw new Error(`step "${s.id}" declares loop-only fields but is kind: ${s.kind}`);
    }
    if (s.kind === 'loop' && s.writes && s.writes.length > 0) {
      // A loop works the project tree; its DeliveryResult is the blackboard
      // entry. Declaring run-dir writes would be dead data at best.
      throw new Error(`loop step "${s.id}" declares writes: — a loop's outcome is its delivery result, not a run-dir file`);
    }
    for (const p of s.reads ?? []) assertRunDirRelative(`step "${s.id}" reads`, p, '');
    for (const p of s.writes ?? []) assertRunDirRelative(`step "${s.id}" writes`, p, '');
    // Pins are static file content, so they validate at LOAD time — a typo'd
    // pin must exit 3 here, not burn GPU retries at run time (the loader's
    // own contract: "before any model is paid"). hasOwn for the
    // prototype-chain reason.
    if (s.model && !Object.hasOwn(ModelPresets, s.model)) {
      throw new Error(
        `step "${s.id}" pins unknown model "${s.model}" — see src/models/types.ts ModelPresets`
      );
    }
  }
  if (def.defaultModel && !Object.hasOwn(ModelPresets, def.defaultModel)) {
    throw new Error(
      `workflow defaultModel "${def.defaultModel}" is not a known preset — see src/models/types.ts ModelPresets`
    );
  }
  if (hasCycle(def)) {
    throw new Error('workflow graph has a cycle — requires: edges must form a DAG');
  }
  // Parallel write collision: two steps sharing a write target with no
  // dependency path between them may dispatch concurrently and clobber each
  // other (graph-safety FALSE INDEPENDENCE, checked at load time because a
  // static workflow can fix its declaration instead of paying a merge).
  // Keys are NORMALIZED — 'out.md' and './out.md' are the same file.
  const writers = new Map<string, string[]>();
  for (const s of def.steps) {
    for (const p of s.writes ?? []) {
      const key = normalize(p);
      writers.set(key, [...(writers.get(key) ?? []), s.id]);
    }
  }
  for (const [p, stepIds] of writers) {
    if (stepIds.length < 2) continue;
    for (let i = 0; i < stepIds.length; i++) {
      for (let j = i + 1; j < stepIds.length; j++) {
        const a = stepIds[i];
        const b = stepIds[j];
        if (!reaches(byId, a, b) && !reaches(byId, b, a)) {
          throw new Error(
            `steps "${a}" and "${b}" both write "${p}" with no requires: path between them — ` +
              `they can run in parallel and clobber each other; add an edge or split the file`
          );
        }
      }
    }
  }
}

/** The three roots a workflow can live in, in precedence order. */
export function workflowSearchRoots(projectRoot: string): string[] {
  const bundled = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'examples', 'workflows');
  return [join(projectRoot, '.uap', 'workflows'), join(homedir(), '.uap', 'workflows'), bundled];
}

/** Workflow names available across all roots (project overrides bundled). */
export function listWorkflows(projectRoot: string): Array<{ name: string; source: string }> {
  const out: Array<{ name: string; source: string }> = [];
  const seen = new Set<string>();
  for (const root of workflowSearchRoots(projectRoot)) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || seen.has(entry.name)) continue;
      if (!existsSync(join(root, entry.name, WORKFLOW_FILE))) continue;
      seen.add(entry.name);
      out.push({ name: entry.name, source: root });
    }
  }
  return out;
}

/** Resolve a workflow name to its directory (first root that has it). */
export function findWorkflowDir(name: string, projectRoot: string): string {
  for (const root of workflowSearchRoots(projectRoot)) {
    const dir = join(root, name);
    if (existsSync(join(dir, WORKFLOW_FILE))) return dir;
  }
  throw new Error(`workflow "${name}" not found in any of:\n  ${workflowSearchRoots(projectRoot).join('\n  ')}`);
}

/**
 * Load + validate a workflow: parse the YAML, check the graph, resolve every
 * agent role prompt from its file. Throws on any problem — callers translate
 * to exit code 3 (invalid), never to a half-loaded run.
 */
export function loadWorkflow(name: string, projectRoot: string): LoadedWorkflow {
  const dir = findWorkflowDir(name, projectRoot);
  const rawPath = join(dir, WORKFLOW_FILE);
  let raw: unknown;
  try {
    raw = yaml.load(readFileSync(rawPath, 'utf8'));
  } catch (err) {
    throw new Error(`cannot parse ${rawPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const def = parseWorkflowDef(raw);
  if (def.name !== name) {
    throw new Error(`workflow file ${rawPath} declares name "${def.name}" but was loaded as "${name}"`);
  }
  validateGraph(def);
  const rolePrompts = new Map<string, string>();
  for (const s of def.steps) {
    if ((s.kind !== 'agent' && s.kind !== 'loop') || !s.prompt) continue;
    assertRunDirRelative(`step "${s.id}" prompt`, s.prompt, dir);
    const p = join(dir, s.prompt);
    if (!existsSync(p)) throw new Error(`step "${s.id}" prompt file not found: ${s.prompt}`);
    rolePrompts.set(s.id, readFileSync(p, 'utf8'));
  }
  return { dir, def, rolePrompts };
}

/** Steps in execution (topological) order — the `--dry-run` plan view. */
export function orderedSteps(def: WorkflowDef): WorkflowStep[] {
  return topoOrder(def.steps as DeliveryPhase[]) as WorkflowStep[];
}
