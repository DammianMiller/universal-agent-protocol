/**
 * Fidelity mode — the single source of truth for "how hard do the verification
 * gates block". Read by the verifier ladder, `uap verify`, deliver's acceptance
 * path, the vision judge, and the Python enforcers (via `uap fidelity --json`).
 *
 * `standard` keeps today's behaviour (cheap-first tiers, advisory vision,
 * fail-open visual). `max` flips every knob to its strongest:
 *   - verifier floor raised to runtime+integration (not just `fast`)
 *   - acceptance judge REQUIRED
 *   - vision aesthetic review BLOCKS (was advisory)
 *   - visual gate fails CLOSED when no browser is available (was a silent skip)
 *   - lenient decoder fallback is flagged rather than silently accepted
 *
 * Resolution order (first wins): `UAP_FIDELITY` env → `.uap.json` `fidelity.mode`
 * → `standard`. The env override lets a single command opt in/out without
 * rewriting config (mirrors UAP_ENFORCE_DELIVERY).
 */
import { loadUapConfig } from '../utils/config-loader.js';

export type FidelityMode = 'standard' | 'max';

export interface ResolvedFidelity {
  mode: FidelityMode;
  /** True when mode === 'max'. */
  max: boolean;
  /** Vision endpoint for aesthetic review (base URL, OpenAI-compat). */
  visionEndpoint?: string;
  /** Vision model id. */
  visionModel?: string;
  /** Minimum aesthetic score (0–10) to pass under max. */
  visionMinScore: number;
  /** Keep/enforce visual regression baselines. */
  visualBaselines: boolean;
  /** Where the mode came from (for transparent reporting). */
  source: 'env' | 'config' | 'default';
}

function normalizeMode(v: unknown): FidelityMode | null {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'max' || s === 'maximum' || s === 'strict' || s === 'high') return 'max';
  if (s === 'standard' || s === 'std' || s === 'normal' || s === 'off') return 'standard';
  return null;
}

/**
 * Resolve the effective fidelity settings for a project directory. Never throws;
 * an unreadable/absent config yields `standard`.
 */
export function resolveFidelity(cwd: string = process.cwd()): ResolvedFidelity {
  const cfg = loadUapConfig(cwd)?.fidelity;
  const envMode = normalizeMode(process.env.UAP_FIDELITY);
  const cfgMode = normalizeMode(cfg?.mode);
  const mode: FidelityMode = envMode ?? cfgMode ?? 'standard';
  const source: ResolvedFidelity['source'] = envMode ? 'env' : cfgMode ? 'config' : 'default';
  // Vision endpoint/model resolution. Explicit env/config win; otherwise fall
  // back to the project's inference endpoint so a local vision-capable model
  // (e.g. qwen3.6 at :8080) powers aesthetic review with no extra config. A
  // single-model llama.cpp server ignores the model id, so 'local' is a safe
  // default id whenever an endpoint is present.
  const visionEndpoint =
    process.env.UAP_VISION_ENDPOINT || cfg?.visionEndpoint || process.env.UAP_INFERENCE_ENDPOINT || undefined;
  const visionModel =
    process.env.UAP_VISION_MODEL || cfg?.visionModel || (visionEndpoint ? 'local' : undefined);
  return {
    mode,
    max: mode === 'max',
    visionEndpoint,
    visionModel,
    visionMinScore: typeof cfg?.visionMinScore === 'number' ? cfg.visionMinScore : 6,
    visualBaselines: cfg?.visualBaselines !== false,
    source,
  };
}

/** Convenience: is maximum-fidelity mode active for this project? */
export function isMaxFidelity(cwd: string = process.cwd()): boolean {
  return resolveFidelity(cwd).max;
}
