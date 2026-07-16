/**
 * Policy selection — the shared engine behind `uap policy select` and the
 * policy-picker step in `uap setup`. Enumerates the built-in policy universe
 * with live install/enable status, plans the install/enable/disable actions for
 * a chosen set, and applies them against the policy store.
 *
 * REQUIRED-level policies are treated as PROTECTED: always kept on and never
 * offered for removal (disabling `workdir-scope` or `enforcement-infra-protect`
 * would defeat the safety rails). Everything else is freely selectable.
 */
import { readFileSync } from 'fs';
import { getPolicyMemoryManager } from '../policies/policy-memory.js';
import { getPolicyGate } from '../policies/policy-gate.js';
import {
  listBuiltinPolicies,
  builtinPolicyPath,
  autoAttachEnforcer,
} from './policy.js';

export interface PolicyChoice {
  name: string;
  category: string;
  /** REQUIRED | RECOMMENDED | OPTIONAL */
  level: string;
  stage: string;
  installed: boolean;
  enabled: boolean;
  /** REQUIRED level → always on, cannot be deselected. */
  protected: boolean;
  /** One-line summary parsed from the schema. */
  description: string;
}

export type PolicyActionKind = 'install' | 'enable' | 'disable' | 'unchanged';

export interface PolicyAction {
  name: string;
  kind: PolicyActionKind;
}

export interface SelectionResult {
  installed: string[];
  enabled: string[];
  disabled: string[];
  unchanged: string[];
}

/** First prose sentence of a policy schema (after the title / `## Rule`), trimmed. */
export function policyDescription(name: string): string {
  const path = builtinPolicyPath(name);
  if (!path) return '';
  try {
    const md = readFileSync(path, 'utf-8');
    // Prefer the first non-empty line under a `## Rule` heading; else the first
    // prose line that isn't a heading / metadata (`**Key**:`) / list marker.
    const lines = md.split('\n');
    const ruleIdx = lines.findIndex((l) => /^##\s+rule/i.test(l.trim()));
    const scan = ruleIdx >= 0 ? lines.slice(ruleIdx + 1) : lines;
    for (const raw of scan) {
      const l = raw.trim();
      if (!l || l.startsWith('#') || /^\*\*[^*]+\*\*:/.test(l) || l.startsWith('- ') || l.startsWith('>')) continue;
      return l.replace(/`/g, '').replace(/\s+/g, ' ').slice(0, 110);
    }
  } catch {
    /* fail-soft */
  }
  return '';
}

/**
 * The full selectable universe: every built-in policy with live install/enable
 * status merged in. Async because it reads the policy store.
 */
/** Normalize a policy name/slug for matching: filenames are kebab slugs but the
 * stored `name` is the schema H1 title (e.g. "Enforcement Self-Protect"). */
function normPolicyKey(s: string): string {
  return s.toLowerCase().replace(/[\s_]+/g, '-').replace(/-+/g, '-').trim();
}

export async function listPolicyChoices(): Promise<PolicyChoice[]> {
  const builtins = listBuiltinPolicies();
  const installed = await getPolicyMemoryManager().getAllPolicies();
  const byName = new Map(installed.map((p) => [normPolicyKey(p.name), p]));
  return builtins
    .map((b) => {
      const inst = byName.get(normPolicyKey(b.name));
      const level = (inst?.level ?? b.level ?? 'REQUIRED').toUpperCase();
      return {
        name: b.name,
        category: inst?.category ?? b.category,
        level,
        stage: inst?.enforcementStage ?? b.stage,
        installed: Boolean(inst),
        enabled: Boolean(inst?.isActive),
        protected: level === 'REQUIRED',
        description: policyDescription(b.name),
      };
    })
    .sort((a, b) => (a.category === b.category ? a.name.localeCompare(b.name) : a.category.localeCompare(b.category)));
}

/**
 * PURE planner: given the current choices and the set the user wants ON, decide
 * what to install/enable/disable. PROTECTED policies are always wanted. Testable
 * without a DB or TTY.
 */
export function planPolicySelection(choices: PolicyChoice[], selected: Set<string>): PolicyAction[] {
  return choices.map((c) => {
    const want = c.protected || selected.has(c.name);
    const isOn = c.installed && c.enabled;
    if (want && !c.installed) return { name: c.name, kind: 'install' as const };
    if (want && c.installed && !c.enabled) return { name: c.name, kind: 'enable' as const };
    if (!want && isOn) return { name: c.name, kind: 'disable' as const };
    return { name: c.name, kind: 'unchanged' as const };
  });
}

/**
 * Apply a selection: install newly-chosen policies (with their enforcer), enable
 * chosen-but-disabled ones, and disable de-selected ones (protected policies are
 * never disabled). Returns what changed. Invalidates the gate cache once.
 */
export async function applyPolicySelection(selectedNames: string[]): Promise<SelectionResult> {
  const choices = await listPolicyChoices();
  const plan = planPolicySelection(choices, new Set(selectedNames));
  const manager = getPolicyMemoryManager();
  const result: SelectionResult = { installed: [], enabled: [], disabled: [], unchanged: [] };

  // Refresh id map lazily after installs so enable/disable can resolve ids.
  let idByName = new Map((await manager.getAllPolicies()).map((p) => [p.name, p.id]));

  for (const a of plan) {
    if (a.kind === 'install') {
      const path = builtinPolicyPath(a.name);
      if (!path) continue;
      await manager.storeRawPolicy(readFileSync(path, 'utf-8'));
      await autoAttachEnforcer(a.name);
      result.installed.push(a.name);
    } else if (a.kind === 'enable') {
      const id = idByName.get(a.name);
      if (id) await manager.togglePolicy(id, true);
      result.enabled.push(a.name);
    } else if (a.kind === 'disable') {
      const id = idByName.get(a.name);
      if (id) await manager.togglePolicy(id, false);
      result.disabled.push(a.name);
    } else {
      result.unchanged.push(a.name);
    }
  }
  // Some installs created new ids; nothing else consumes idByName after this,
  // but refresh keeps the function honest if extended later.
  idByName = new Map((await manager.getAllPolicies()).map((p) => [p.name, p.id]));
  void idByName;

  try {
    getPolicyGate().invalidateCache();
  } catch {
    /* cache invalidation is best-effort */
  }
  return result;
}

/** Default ON set for a fresh selection: everything REQUIRED or RECOMMENDED. */
export function recommendedSelection(choices: PolicyChoice[]): string[] {
  return choices.filter((c) => c.level === 'REQUIRED' || c.level === 'RECOMMENDED').map((c) => c.name);
}

/**
 * The policies `uap setup` installs by DEFAULT: EVERY built-in policy, each with
 * its schema-declared level (REQUIRED/RECOMMENDED/OPTIONAL), EXCLUDING the pay2u
 * example pack — that stays opt-in behind its own flag (`includePay2u`). This is
 * what "apply all policies + their current state as the setup default" means.
 */
export function defaultSetupPolicies(choices: PolicyChoice[], includePay2u = false): string[] {
  return choices.filter((c) => includePay2u || !c.name.startsWith('pay2u')).map((c) => c.name);
}

/**
 * Non-interactive setup convenience: install ALL default policies (see
 * defaultSetupPolicies) into the project store. Fail-soft.
 */
export async function installAllDefaultPolicies(includePay2u = false): Promise<SelectionResult> {
  const choices = await listPolicyChoices();
  return applyPolicySelection(defaultSetupPolicies(choices, includePay2u));
}

/**
 * Gate-saturation lint ("never go full"): a selection that turns on EVERY gate
 * holds nothing back, and saturated configurations have deadlocked before --
 * the remedy for a blocked action was itself blocked (schema-diff-gate's own
 * fix gated; RECON told to write while the write gate forbade it). Pure and
 * advisory: returns human-readable warnings, never blocks the selection.
 */
export function lintSaturation(
  choices: PolicyChoice[],
  effectiveOn: Set<string>,
  opts: { fidelityMax?: boolean } = {},
): string[] {
  const warnings: string[] = [];
  // effectiveOn is the set of policies that ARE (or will be, post-apply) on.
  // Protected policies count like any other: a REQUIRED gate that is actually
  // off breaks saturation — the warning must never claim more than reality.
  // The pay2u example pack is opt-in demo content; its absence is not
  // "holding something back".
  const universe = choices.filter((c) => !c.name.startsWith('pay2u'));
  const fullySaturated = universe.length > 0 && universe.every((c) => effectiveOn.has(c.name));
  if (fullySaturated) {
    const blocking = universe.filter((c) => effectiveOn.has(c.name) && c.level === 'REQUIRED').length;
    warnings.push(
      `gate saturation: all ${universe.length} policies are on (${blocking} blocking) -- nothing held back. ` +
        'Saturated gate sets have deadlocked before (a blocked action whose remedy is also blocked). ' +
        'Verify each blocking gate keeps an escape hatch (review waivers, backup dirs, operator overrides), ' +
        'or leave at least one advisory policy advisory.',
    );
  }
  if (fullySaturated && opts.fidelityMax) {
    warnings.push(
      'full commitment: fidelity is `max` AND every policy is enforced -- the strongest possible configuration. ' +
        'Fine when attended; before an unattended/hands-free run, confirm UAP_FIDELITY=standard and the waiver ' +
        'paths still work so a wedged gate cannot strand the session.',
    );
  }
  return warnings;
}
