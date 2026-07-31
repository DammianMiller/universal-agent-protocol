/**
 * Self-Harness — the Modification ("Mod") DSL.
 *
 * The autonomous proposer may ONLY emit values of the `Mod` union below — never
 * free-form code. Each Mod is mechanically applicable and automatically
 * reversible, and `env` Mods are constrained to an allow-list of knobs with
 * declared safe ranges. This is the "minimal, targeted modification" surface
 * from the Self-Harness paper (arXiv:2606.09498), widened to UAP's three layers
 * (scaffold text, proxy/llama env knobs, proxy middleware).
 *
 * See docs/design/SELF_HARNESS.md.
 */

import { UapComponent, UAP_COMPONENTS } from '../benchmarks/paired/types.js';
import { getSetting } from '../config/settings-registry.js';

export type JsonScalar = string | number | boolean;

// ---------------------------------------------------------------------------
// Env-knob allow-list. Deliberately EXCLUDES every model/ctx/KV/spec knob
// (LLAMA_MODEL, LLAMA_CTX_SIZE, LLAMA_CACHE_TYPE_*, LLAMA_SPEC_TYPE, ...): those
// require a slot-cache clear and risk OOM, so they are out of the autonomous
// loop's reach. Only safe, hot-reloadable sampler/guardrail knobs are listed.
// ---------------------------------------------------------------------------

/**
 * Where a knob takes effect. `executor` was added with ToolMod (harness plan
 * B1): unlike proxy/llama targets it is read CLIENT-side by the delivery
 * executor, so changing it needs an env var on the candidate arm rather than an
 * inference-server restart — which is precisely why tool knobs can auto-validate.
 */
export type KnobTarget = 'proxy' | 'llama' | 'executor';

export interface NumericKnob {
  target: KnobTarget;
  type: 'number';
  /** Inclusive safe range. A proposed value outside this is rejected. */
  min: number;
  max: number;
  /** Whether the value must be an integer. */
  integer?: boolean;
  description: string;
}

export interface EnumKnob {
  target: KnobTarget;
  type: 'enum';
  values: readonly string[];
  description: string;
}

export type KnobSpec = NumericKnob | EnumKnob;

export const KNOB_ALLOWLIST = {
  // --- llama sampler knobs (hot-reload via env + server restart, no slot clear) ---
  LLAMA_N_PREDICT: {
    target: 'llama', type: 'number', min: 512, max: 16384, integer: true,
    description: 'per-turn generation cap; low values bound a runaway turn',
  },
  LLAMA_REPEAT_PENALTY: {
    target: 'llama', type: 'number', min: 1.0, max: 1.3,
    description: 'repetition penalty; damps token-level loops',
  },
  // --- proxy guardrail knobs (live per-request, no restart) ---
  PROXY_HARD_FINALIZE_TURNS: {
    target: 'proxy', type: 'number', min: 10, max: 80, integer: true,
    description: 'tool-turn ceiling before the proxy strips tools to force termination',
  },
  PROXY_RECON_CONVERGENCE_THRESHOLD: {
    target: 'proxy', type: 'number', min: 20, max: 200, integer: true,
    description: 'no-write turns before the recon-convergence directive fires',
  },
  PROXY_TOOL_NARROWING_KEEP: {
    target: 'proxy', type: 'number', min: 2, max: 24, integer: true,
    description: 'how many tools to retain after relevance narrowing (soft floor)',
  },
  PROXY_FORCED_THRESHOLD: {
    target: 'proxy', type: 'number', min: 5, max: 40, integer: true,
    description: 'consecutive forced tool_choice=required turns before loop-breaker release',
  },
} as const satisfies Record<string, KnobSpec>;

export type KnownKnob = keyof typeof KNOB_ALLOWLIST;

export function isKnownKnob(k: string): k is KnownKnob {
  return Object.prototype.hasOwnProperty.call(KNOB_ALLOWLIST, k);
}

/**
 * Look up a knob spec as the full `KnobSpec` union. Indexing KNOB_ALLOWLIST
 * directly preserves each entry's narrow literal type (all numeric today), which
 * makes the enum branch in validateMod unreachable (`never`); returning the union
 * keeps both branches type-checkable as enum knobs are added later.
 */
export function knobSpec(key: KnownKnob): KnobSpec {
  return KNOB_ALLOWLIST[key];
}

// ---------------------------------------------------------------------------
// Middleware Mods (Phase 2). Purpose-built proxy interceptors the proposer may
// toggle/parameterize. The first is the tool-call path-normalizer — a
// mechanical fix for the filename-garbling failure that prompt/param Mods can't
// reach (see SELF_HARNESS.md §4, §11 P2).
// ---------------------------------------------------------------------------

export const MIDDLEWARE_IDS = ['toolcall-path-normalizer'] as const;
export type MiddlewareId = (typeof MIDDLEWARE_IDS)[number];

export function isMiddlewareId(s: string): s is MiddlewareId {
  return (MIDDLEWARE_IDS as readonly string[]).includes(s);
}

// ---------------------------------------------------------------------------
// Tool Mods (harness plan area B1, 2026-07-31).
//
// WHY these exist: the self-harness search space was env knobs ONLY — the
// inference server's launch parameters. The Agentic-Harness-Engineering ablation
// (arXiv 2604.25850) measures where harness gains actually come from:
//
//     long-term memory +5.6pp | tools +3.3pp | middleware +2.2pp | prompt -2.3pp
//
// Server knobs are not on that list, and prompt edits are NEGATIVE. So the loop
// was searching the one surface with no measured value while the surfaces with
// measured value were gated behind a human.
//
// Tool knobs are CLIENT-side (the executor reads them per run), which is also
// why they can auto-validate where env knobs could not: flipping one needs an
// environment variable on the candidate arm, not a server restart.
// ---------------------------------------------------------------------------

export const TOOL_KNOB_ALLOWLIST = {
  UAP_EDIT_TOLERANT: {
    target: 'executor', type: 'enum', values: ['0', '1'],
    description: 'edit_file falls back to whitespace-tolerant matching on an exact miss',
  },
  UAP_EDIT_DIAGNOSTICS: {
    target: 'executor', type: 'enum', values: ['0', '1'],
    description: 'a failed edit returns the nearest current region instead of "not found"',
  },
  UAP_READ_WINDOW_BYTES: {
    target: 'executor', type: 'number', min: 2000, max: 32000, integer: true,
    description: 'bytes of a file read_file returns per call',
  },
  UAP_MAX_TOOL_ROUNDS: {
    target: 'executor', type: 'number', min: 4, max: 40, integer: true,
    description: 'tool-call rounds before a final answer is forced',
  },
} as const satisfies Record<string, KnobSpec>;

export type KnownToolKnob = keyof typeof TOOL_KNOB_ALLOWLIST;

export function isKnownToolKnob(k: string): k is KnownToolKnob {
  return Object.prototype.hasOwnProperty.call(TOOL_KNOB_ALLOWLIST, k);
}

export function toolKnobSpec(key: KnownToolKnob): KnobSpec {
  return TOOL_KNOB_ALLOWLIST[key];
}

// ---------------------------------------------------------------------------
// The Mod union.
// ---------------------------------------------------------------------------

export interface EnvMod {
  kind: 'env';
  key: KnownKnob;
  /** Prior value (for revert + audit). */
  from: string;
  /** Proposed value, as it will be written to the env file. */
  to: string;
}

export interface ScaffoldMod {
  kind: 'scaffold';
  component: UapComponent;
  op: 'replace' | 'append';
  /** New text (replace) or text to append. */
  text: string;
  /** Prior text of the component block (for revert). */
  from?: string;
}

export interface MiddlewareMod {
  kind: 'middleware';
  id: MiddlewareId;
  params: Record<string, JsonScalar>;
}

/**
 * A change to a first-class UAP setting (a `settings-registry` key: `.uap.json`
 * json flags OR proxyEnv/shell env flags). This is the LLM-Self-Tuning surface
 * (recipes.*, modelConcurrency.*, handsfree.*, memory.*, delivery.*, PROXY_*),
 * widening the Mod DSL beyond the env-knob allow-list. Validated against the
 * registry's declared type/enum/bounds, so an out-of-range value is rejected at
 * parse time exactly like an env knob. See docs/design/LLM_SELF_TUNING_ANALYSIS.md.
 */
export interface ConfigMod {
  kind: 'config';
  /** settings-registry key, e.g. `recipes.confidenceThreshold`. */
  key: string;
  /** Prior value (string form, for revert + audit). */
  from: string;
  /** Proposed value (string form). */
  to: string;
  /** settings-registry category id (for grouping/diffs). */
  category: string;
}

/**
 * A change to the TOOL SURFACE the model sees (harness plan B1). Same shape as
 * an EnvMod, different allow-list and a different application seam: tool knobs
 * are read by the executor process, so an A/B needs an env var on the candidate
 * arm rather than an inference-server restart.
 */
export interface ToolMod {
  kind: 'tool';
  key: KnownToolKnob;
  /** Prior value (for revert + audit). */
  from: string;
  /** Proposed value. */
  to: string;
}

export type Mod = EnvMod | ScaffoldMod | MiddlewareMod | ConfigMod | ToolMod;

export interface ValidationOk {
  ok: true;
}
export interface ValidationErr {
  ok: false;
  reason: string;
}
export type ValidationResult = ValidationOk | ValidationErr;

/**
 * Validate a Mod against the DSL constraints. A proposer's output that fails
 * this is rejected at parse time — it never reaches the apply/validate stages.
 */
export function validateMod(mod: Mod): ValidationResult {
  switch (mod.kind) {
    case 'env': {
      if (!isKnownKnob(mod.key)) {
        return { ok: false, reason: `unknown/non-allow-listed knob: ${mod.key}` };
      }
      const spec = knobSpec(mod.key);
      if (spec.type === 'number') {
        const n = Number(mod.to);
        if (!Number.isFinite(n)) {
          return { ok: false, reason: `${mod.key}: "${mod.to}" is not numeric` };
        }
        if (spec.integer && !Number.isInteger(n)) {
          return { ok: false, reason: `${mod.key}: must be an integer, got ${mod.to}` };
        }
        if (n < spec.min || n > spec.max) {
          return {
            ok: false,
            reason: `${mod.key}=${mod.to} out of safe range [${spec.min}, ${spec.max}]`,
          };
        }
        return { ok: true };
      }
      // enum
      if (!spec.values.includes(mod.to)) {
        return { ok: false, reason: `${mod.key}="${mod.to}" not in {${spec.values.join(', ')}}` };
      }
      return { ok: true };
    }
    case 'scaffold': {
      if (!(UAP_COMPONENTS as readonly string[]).includes(mod.component)) {
        return { ok: false, reason: `unknown UAP component: ${mod.component}` };
      }
      if (mod.op !== 'replace' && mod.op !== 'append') {
        return { ok: false, reason: `scaffold op must be replace|append` };
      }
      if (!mod.text.trim()) {
        return { ok: false, reason: `scaffold text is empty` };
      }
      return { ok: true };
    }
    case 'middleware': {
      if (!isMiddlewareId(mod.id)) {
        return { ok: false, reason: `unknown middleware id: ${(mod as MiddlewareMod).id}` };
      }
      return { ok: true };
    }
    case 'config':
      return validateConfigMod(mod);
    case 'tool': {
      // Same bounds discipline as an env knob: an out-of-range tool knob is
      // rejected at parse time, never handed to a bench arm.
      if (!isKnownToolKnob(mod.key)) {
        return { ok: false, reason: `unknown/non-allow-listed tool knob: ${String(mod.key)}` };
      }
      const spec = toolKnobSpec(mod.key);
      if (spec.type === 'number') {
        const n = Number(mod.to);
        if (!Number.isFinite(n)) return { ok: false, reason: `${mod.key}: "${mod.to}" is not numeric` };
        if (spec.integer && !Number.isInteger(n)) {
          return { ok: false, reason: `${mod.key}: must be an integer, got ${mod.to}` };
        }
        if (n < spec.min || n > spec.max) {
          return {
            ok: false,
            reason: `${mod.key}=${mod.to} out of safe range [${spec.min}, ${spec.max}]`,
          };
        }
        return { ok: true };
      }
      if (!spec.values.includes(mod.to)) {
        return { ok: false, reason: `${mod.key}="${mod.to}" not in {${spec.values.join(', ')}}` };
      }
      return { ok: true };
    }
    default:
      return { ok: false, reason: `unknown mod kind` };
  }
}

/** Validate a ConfigMod against its settings-registry declaration. */
function validateConfigMod(mod: ConfigMod): ValidationResult {
  const spec = getSetting(mod.key);
  if (!spec) return { ok: false, reason: `unknown setting: ${mod.key}` };
  if (spec.secret) return { ok: false, reason: `${mod.key} is a secret and is not tunable` };
  if (spec.type === 'boolean') {
    const v = mod.to.toLowerCase();
    if (!['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'].includes(v)) {
      return { ok: false, reason: `${mod.key}: "${mod.to}" is not boolean` };
    }
    return { ok: true };
  }
  if (spec.type === 'enum') {
    if (!(spec.enumValues ?? []).includes(mod.to)) {
      return { ok: false, reason: `${mod.key}="${mod.to}" not in {${(spec.enumValues ?? []).join(', ')}}` };
    }
    return { ok: true };
  }
  if (spec.type === 'number') {
    const n = Number(mod.to);
    if (!Number.isFinite(n)) return { ok: false, reason: `${mod.key}: "${mod.to}" is not numeric` };
    if (spec.int && !Number.isInteger(n)) return { ok: false, reason: `${mod.key}: must be an integer` };
    if (spec.min != null && n < spec.min) return { ok: false, reason: `${mod.key}=${mod.to} < min ${spec.min}` };
    if (spec.max != null && n > spec.max) return { ok: false, reason: `${mod.key}=${mod.to} > max ${spec.max}` };
    return { ok: true };
  }
  return { ok: true }; // string
}

/** One-line, human-readable description of a Mod (for logs and profile diffs). */
export function describeMod(mod: Mod): string {
  switch (mod.kind) {
    case 'env':
      return `env ${mod.key}: ${mod.from} -> ${mod.to}`;
    case 'scaffold':
      return `scaffold ${mod.component} (${mod.op}, ${mod.text.length} chars)`;
    case 'middleware':
      return `middleware ${mod.id}(${JSON.stringify(mod.params)})`;
    case 'config':
      return `config ${mod.key}: ${mod.from} -> ${mod.to}`;
    case 'tool':
      return `tool ${mod.key}: ${mod.from} -> ${mod.to}`;
  }
}

/**
 * Produce the inverse Mod that undoes `mod` (for rollback). Env/scaffold revert
 * to their captured prior value; a middleware Mod reverts by disabling it.
 */
export function invertMod(mod: Mod): Mod {
  switch (mod.kind) {
    case 'env':
      return { kind: 'env', key: mod.key, from: mod.to, to: mod.from };
    case 'scaffold':
      // Only a captured prior text can be restored; an append has no clean
      // inverse without the original, so callers must supply `from` to revert.
      return {
        kind: 'scaffold',
        component: mod.component,
        op: 'replace',
        text: mod.from ?? '',
        from: mod.op === 'replace' ? mod.text : undefined,
      };
    case 'middleware':
      return { kind: 'middleware', id: mod.id, params: { ...mod.params, enabled: false } };
    case 'config':
      return { kind: 'config', key: mod.key, from: mod.to, to: mod.from, category: mod.category };
    case 'tool':
      return { kind: 'tool', key: mod.key, from: mod.to, to: mod.from };
  }
}
