/**
 * Vision Judge — aesthetic/behavioral review of the visual gate's screenshots
 * by a vision-capable model (the seam the visual-verification policy names).
 *
 * The pixel heuristics prove "renders and moves"; only vision can judge
 * "looks right". When UAP_VISION_MODEL (+ UAP_VISION_ENDPOINT, OpenAI-compat
 * with image_url support) is configured, the saved screenshots are scored
 * against the spec; findings flow into reports/acceptance evidence as
 * ADVISORY context. Unset config or any failure returns null — this seam is
 * fail-soft by contract and never blocks a delivery on its own.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { fetchModelWithRetry } from '../models/long-fetch.js';
import { discoverLocalLlamaBases } from '../utils/llama-discovery.js';

export interface VisionAxes {
  completeness: number;
  craftDensity: number;
  cohesionPolish: number;
  framingErgonomics: number;
  runtimeIntegrity: number;
}

export type VisionTicketSeverity = 'blocker' | 'major' | 'polish';

export interface VisionTicket {
  severity: VisionTicketSeverity;
  axis: string;
  target: string;
  defect: string;
  fix: string;
}

export interface VisionVerdict {
  /** 0–10 aesthetic/behavioral score across the reviewed screenshots. */
  score: number;
  findings: string[];
  axes?: VisionAxes;
  tickets?: VisionTicket[];
}

const MAX_IMAGES = 4;
const MAX_FINDINGS = 8;
const SEVERITY_RANK: Record<VisionTicketSeverity, number> = { blocker: 0, major: 1, polish: 2 };

interface ModelsListPayload {
  models?: Array<{
    id?: string;
    name?: string;
    input_modalities?: string[];
    architecture?: { input_modalities?: string[] };
    capabilities?: { vision?: boolean };
    modalities?: { vision?: boolean };
  }>;
  data?: Array<{
    id?: string;
    name?: string;
    input_modalities?: string[];
    architecture?: { input_modalities?: string[] };
    capabilities?: { vision?: boolean };
    modalities?: { vision?: boolean };
  }>;
}

interface HealthPayload {
  images?: boolean;
  vision?: boolean;
  multimodal?: boolean;
  modalities?: { vision?: boolean };
}

interface PropsPayload {
  modalities?: { vision?: boolean };
  model_path?: string;
}

function entrySupportsVision(entry: NonNullable<ModelsListPayload['data']>[number]): boolean {
  const mods = [
    ...(entry.architecture?.input_modalities ?? []),
    ...(entry.input_modalities ?? []),
  ];
  if (mods.some((m) => m.toLowerCase() === 'image' || m.toLowerCase() === 'vision')) {
    return true;
  }
  return Boolean(entry.capabilities?.vision || entry.modalities?.vision);
}

async function isEndpointAlive(root: string, fetchFn: typeof fetch): Promise<boolean> {
  for (const path of ['/props', '/health', '/v1/models']) {
    try {
      const res = await fetchFn(`${root}${path}`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {
      /* try next probe path */
    }
  }
  return false;
}

async function fetchModelsInfo(
  root: string,
  fetchFn: typeof fetch
): Promise<{ model: string; vision: boolean }> {
  let model = 'local';
  let vision = false;
  try {
    const res = await fetchFn(`${root}/v1/models`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { model, vision };
    const payload = (await res.json()) as ModelsListPayload;
    const entries = payload.data ?? payload.models ?? [];
    if (entries.length > 0) {
      model = entries[0]?.id || entries[0]?.name || model;
      vision = entries.some((e) => entrySupportsVision(e));
    }
  } catch {
    /* keep defaults */
  }
  return { model, vision };
}

async function probeEndpointVision(
  root: string,
  fetchFn: typeof fetch
): Promise<{ vision: boolean; model: string }> {
  // 1. llama.cpp /props -> modalities.vision
  try {
    const propsRes = await fetchFn(`${root}/props`, { signal: AbortSignal.timeout(2000) });
    if (propsRes.ok) {
      const props = (await propsRes.json()) as PropsPayload;
      if (typeof props?.modalities?.vision === 'boolean') {
        if (!props.modalities.vision) return { vision: false, model: 'local' };
        const info = await fetchModelsInfo(root, fetchFn);
        return { vision: true, model: info.model };
      }
    }
  } catch {
    /* fall through to /health */
  }

  // 2. Basalt / engine /health -> images / vision / multimodal
  try {
    const healthRes = await fetchFn(`${root}/health`, { signal: AbortSignal.timeout(2000) });
    if (healthRes.ok) {
      const health = (await healthRes.json()) as HealthPayload;
      const hasVisionFlag =
        typeof health?.images === 'boolean' ||
        typeof health?.vision === 'boolean' ||
        typeof health?.multimodal === 'boolean' ||
        typeof health?.modalities?.vision === 'boolean';
      if (hasVisionFlag) {
        const vision = Boolean(
          health.images || health.vision || health.multimodal || health.modalities?.vision
        );
        if (!vision) return { vision: false, model: 'local' };
        const info = await fetchModelsInfo(root, fetchFn);
        return { vision: true, model: info.model };
      }
    }
  } catch {
    /* fall through to /v1/models */
  }

  // 3. Infernix / vLLM / OpenAI-compat /v1/models -> input_modalities / capabilities.vision
  return fetchModelsInfo(root, fetchFn);
}

export function visionJudgeConfigured(): boolean {
  return Boolean(process.env.UAP_VISION_MODEL && process.env.UAP_VISION_ENDPOINT);
}

/**
 * Auto-configure the vision judge from the ACTIVE local model when it isn't
 * explicitly configured. Probes candidate OpenAI-compat endpoints across
 * /props (llama.cpp), /health (Basalt), and /v1/models (Infernix/vLLM).
 * Fail-soft: any error leaves config unset. Idempotent.
 */
export async function autodetectLocalVision(fetchFn: typeof fetch = fetch): Promise<boolean> {
  if (visionJudgeConfigured()) {
    const pinned = (process.env.UAP_VISION_ENDPOINT ?? '').replace(/\/v1\/?$/, '').replace(/\/$/, '');
    if (pinned && (await isEndpointAlive(pinned, fetchFn))) {
      return true;
    }
    delete process.env.UAP_VISION_ENDPOINT;
    delete process.env.UAP_VISION_MODEL;
  }
  const bases = [
    process.env.UAP_INFERENCE_ENDPOINT,
    process.env.LLAMA_CPP_BASE,
    ...discoverLocalLlamaBases(),
    'http://127.0.0.1:8080/v1',
  ].filter((b): b is string => Boolean(b));
  const seen = new Set<string>();
  for (const base of bases) {
    const root = base.replace(/\/v1\/?$/, '').replace(/\/$/, '');
    if (!root || seen.has(root)) continue;
    seen.add(root);
    const probe = await probeEndpointVision(root, fetchFn);
    if (probe.vision) {
      process.env.UAP_VISION_ENDPOINT = `${root}/v1`;
      process.env.UAP_VISION_MODEL = probe.model;
      return true;
    }
  }
  return false;
}

function clampAxis(val: number | string | undefined): number | null {
  const n = Number(val);
  return Number.isFinite(n) ? Math.max(0, Math.min(10, n)) : null;
}

function parseVisionAxes(raw: Record<string, number | string | undefined> | undefined): VisionAxes | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const completeness = clampAxis(raw.completeness);
  const craftDensity = clampAxis(raw.craftDensity ?? raw.craft_density);
  const cohesionPolish = clampAxis(raw.cohesionPolish ?? raw.cohesion_polish);
  const framingErgonomics = clampAxis(raw.framingErgonomics ?? raw.framing_ergonomics);
  const runtimeIntegrity = clampAxis(raw.runtimeIntegrity ?? raw.runtime_integrity);
  if (
    completeness === null ||
    craftDensity === null ||
    cohesionPolish === null ||
    framingErgonomics === null ||
    runtimeIntegrity === null
  ) {
    return undefined;
  }
  return { completeness, craftDensity, cohesionPolish, framingErgonomics, runtimeIntegrity };
}

function parseVisionTickets(
  raw: Array<Record<string, string | undefined>> | undefined
): VisionTicket[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: VisionTicket[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const sevRaw = String(item.severity ?? 'major').toLowerCase();
    const severity: VisionTicketSeverity =
      sevRaw === 'blocker' || sevRaw === 'major' || sevRaw === 'polish' ? sevRaw : 'major';
    const defect = typeof item.defect === 'string' ? item.defect.trim() : '';
    const fix = typeof item.fix === 'string' ? item.fix.trim() : '';
    if (!defect && !fix) continue;
    out.push({
      severity,
      axis: typeof item.axis === 'string' && item.axis.trim() ? item.axis.trim() : 'completeness',
      target: typeof item.target === 'string' && item.target.trim() ? item.target.trim() : 'artifact',
      defect: defect || fix,
      fix: fix || defect,
    });
  }
  if (out.length === 0) return undefined;
  out.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  return out.slice(0, MAX_FINDINGS);
}

interface RawVisionJson {
  score?: number | string;
  findings?: Array<string | number | boolean | null>;
  axes?: Record<string, number | string | undefined>;
  tickets?: Array<Record<string, string | undefined>>;
}

/** Extract the first JSON object from model output (grammar-free fallback). */
export function parseVisionVerdict(text: string): VisionVerdict | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as RawVisionJson;
    const axes = parseVisionAxes(parsed.axes);
    const tickets = parseVisionTickets(parsed.tickets);
    const rawScore = Number(parsed.score);
    const derivedScore = axes
      ? (axes.completeness +
          axes.craftDensity +
          axes.cohesionPolish +
          axes.framingErgonomics +
          axes.runtimeIntegrity) /
        5
      : NaN;
    const score = Number.isFinite(rawScore) ? rawScore : derivedScore;
    if (!Number.isFinite(score)) return null;
    let findings = Array.isArray(parsed.findings)
      ? parsed.findings.filter((f): f is string => typeof f === 'string').slice(0, MAX_FINDINGS)
      : [];
    if (findings.length === 0 && tickets) {
      findings = tickets.map(
        (t) => `[${t.severity.toUpperCase()}/${t.axis}] ${t.target}: ${t.defect} — Fix: ${t.fix}`
      );
    }
    return {
      score: Math.max(0, Math.min(10, score)),
      findings,
      ...(axes ? { axes } : {}),
      ...(tickets ? { tickets } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * The project's design system as review context — the DESIGN.md token allow-list
 * (`.uap/design-tokens.json`, generated by `uap design`) plus the DESIGN.md
 * intent prose. Lets the vision reviewer score adherence to the *actual* design
 * system (palette, spacing, fonts, voice) instead of a generic "looks polished"
 * bar. Returns '' when the project has no design system (fail-soft).
 */
export function readDesignContext(projectRoot: string): string {
  const parts: string[] = [];
  try {
    const allowPath = join(projectRoot, '.uap', 'design-tokens.json');
    if (existsSync(allowPath)) {
      const a = JSON.parse(readFileSync(allowPath, 'utf-8')) as {
        name?: string;
        colors?: string[];
        spacing?: string[];
        fontFamilies?: string[];
      };
      if (a.name) parts.push(`Design system: "${a.name}".`);
      if (a.colors?.length) parts.push(`Approved palette (the UI must use ONLY these colours): ${a.colors.slice(0, 14).join(', ')}.`);
      if (a.spacing?.length) parts.push(`Spacing scale: ${a.spacing.slice(0, 12).join(', ')}.`);
      if (a.fontFamilies?.length) parts.push(`Font families: ${a.fontFamilies.slice(0, 4).join(', ')}.`);
    }
  } catch {
    /* allow-list is optional */
  }
  try {
    for (const name of ['DESIGN.md', 'design.md', 'Design.md']) {
      const p = join(projectRoot, name);
      if (existsSync(p)) {
        const md = readFileSync(p, 'utf-8').replace(/^---[\s\S]*?---\s*/, '').trim();
        if (md) parts.push(`Design intent (from ${name}):\n${md.slice(0, 1400)}`);
        break;
      }
    }
  } catch {
    /* DESIGN.md is optional */
  }
  return parts.join('\n');
}

/**
 * Hard bound on a single vision-model call.
 *
 * The autodetect probes were time-boxed (2s) but the calls that actually matter
 * — judgeScreenshots and corroborateFindings, which upload PNGs — were awaited
 * unbounded. A vision model that is merely BUSY (another agent session holding
 * the slots) therefore stalls the caller indefinitely: `uap verify --visual`
 * never returns, and under --fidelity max, where the vision review is BLOCKING,
 * a deliver run wedges on it. Measured: the same verify that returns in 13s
 * against an unreachable endpoint ran past 150s against the live busy model.
 *
 * Image inference is legitimately slow, so this is generous — it exists to make
 * the wait FINITE, not short. AbortSignal actually cancels the request rather
 * than merely letting the caller move on, so a timed-out judge leaves no
 * in-flight upload behind. Both callers already treat a null verdict as "no
 * vision review", so a timeout degrades to advisory-silence by construction.
 */
export const VISION_CALL_TIMEOUT_MS = Math.max(
  5_000,
  Number(process.env.UAP_VISION_TIMEOUT_MS) || 120_000
);

/**
 * Score screenshots against the spec with the configured vision model.
 * `designContext` (see readDesignContext) makes the review judge adherence to
 * the project's design system, not just generic polish. Returns null when
 * unconfigured or on any failure.
 */
export async function judgeScreenshots(
  screenshotPaths: string[],
  spec: string,
  designContext = '',
  fetchImpl?: typeof fetchModelWithRetry
): Promise<VisionVerdict | null> {
  if (!visionJudgeConfigured() || screenshotPaths.length === 0) return null;
  const endpoint = (process.env.UAP_VISION_ENDPOINT as string).replace(/\/$/, '');
  const model = process.env.UAP_VISION_MODEL as string;
  try {
    const images = screenshotPaths.slice(0, MAX_IMAGES).map((p) => ({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${readFileSync(p).toString('base64')}` },
    }));
    // Stability: the vision score gates a DONE claim, so run-to-run variance
    // (the same render scoring 3→8) can false-block a good deliverable. Default
    // to the MEDIAN of 3 independent scores (a small temperature makes the samples
    // vary so the median is meaningful) — robust to a single outlier judgment.
    // Set UAP_VISION_SAMPLES=1 for a deterministic single call (temperature 0);
    // higher values trade more latency for more stability.
    const samples = Math.max(1, Math.min(9, Number(process.env.UAP_VISION_SAMPLES) || 3));
    const temperature = samples > 1 ? 0.4 : 0;
    const thinkingOn = process.env.UAP_VISION_THINKING !== '0';
    const body = {
      model,
      max_tokens: thinkingOn ? 4096 : 800,
      temperature,
      // B4: Thinking ON by default so vision critiques reason about composition,
      // completeness, craft density, and runtime defects before scoring. Set
      // UAP_VISION_THINKING=0 to restore legacy fast no-thinking mode.
      chat_template_kwargs: { enable_thinking: thinkingOn },
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                'You are a rigorous visual and structural reviewer evaluating rendered output of an artifact against its specification. ' +
                'Score 5 axes independently from 0 to 10: ' +
                '(1) completeness (every required feature/element/region from the spec is visibly present, not omitted or stubbed), ' +
                '(2) craftDensity (richness, structural fidelity, and substantive detail rather than minimal bare-bones placeholders), ' +
                '(3) cohesionPolish (visual hierarchy, typography/palette harmony, lighting/contrast, surface finish' +
                (designContext ? ', and strict ADHERENCE TO THE DESIGN SYSTEM below' : '') +
                '), ' +
                '(4) framingErgonomics (subject framing, readability, layout balance, clipping/overlap, interactive affordances), ' +
                '(5) runtimeIntegrity (no blank canvas/region, no broken geometry/rendering artifacts, no dead/flat placeholder state). ' +
                'Emit severity-ranked defect tickets: "blocker" (broken/missing core element, blank/clipped subject, runtime failure), ' +
                '"major" (missing spec subsystem, hollow/bare-bones craft, severe layout/cohesion flaw), or "polish" (minor refinement). ' +
                'CRITICAL RULE: FORBID "polish" cosmetic micro-tweaks while ANY "blocker" or "major" defect exists or ANY axis scores below 7. ' +
                'Each ticket and finding must name a concrete target and an actionable implementation fix — never vague complaints. ' +
                'If a large region or <canvas> is blank or uniform flat color, emit a "blocker" on runtimeIntegrity noting the render loop is not drawing in this state. ' +
                'Respond with ONLY JSON: ' +
                '{"score": <0-10>, "axes": {"completeness": <0-10>, "craftDensity": <0-10>, "cohesionPolish": <0-10>, "framingErgonomics": <0-10>, "runtimeIntegrity": <0-10>}, ' +
                '"tickets": [{"severity": "blocker|major|polish", "axis": "<axis>", "target": "<element/subsystem>", "defect": "<what is wrong>", "fix": "<concrete fix>"}], ' +
                '"findings": ["<specific, actionable fix>", ...]}\n\nSPEC:\n' +
                spec.slice(0, 4000) +
                (designContext ? `\n\nDESIGN SYSTEM (score adherence to this):\n${designContext.slice(0, 2500)}` : ''),
            },
            ...images,
          ],
        },
      ],
    };
    const doFetch = fetchImpl ?? fetchModelWithRetry;
    const scoreOnce = async (): Promise<VisionVerdict | null> => {
      const res = await doFetch(`${endpoint}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(thinkingOn ? { 'x-uap-reasoning': '1' } : {}),
          ...(process.env.UAP_VISION_API_KEY ? { Authorization: `Bearer ${process.env.UAP_VISION_API_KEY}` } : {}),
        },
        signal: AbortSignal.timeout(VISION_CALL_TIMEOUT_MS),
        body: JSON.stringify(body),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
      };
      const msg = data.choices?.[0]?.message;
      // Prefer content; fall back to reasoning_content for any model that still
      // reasons (belt-and-suspenders alongside enable_thinking:false above) — the
      // verdict JSON may be embedded in the reasoning trace.
      return parseVisionVerdict(msg?.content || '') ?? parseVisionVerdict(msg?.reasoning_content || '');
    };

    if (samples === 1) return await scoreOnce();

    // Median-of-N: robust to a single outlier judgment. Take the median score and
    // surface the findings from that representative verdict.
    const verdicts: VisionVerdict[] = [];
    for (let i = 0; i < samples; i++) {
      const v = await scoreOnce();
      if (v) verdicts.push(v);
    }
    if (verdicts.length === 0) return null;
    verdicts.sort((a, b) => a.score - b.score);
    return verdicts[Math.floor((verdicts.length - 1) / 2)]; // lower-median (conservative)
  } catch {
    return null;
  }
}

/**
 * Drop findings the model cannot substantiate from the image.
 *
 * Diagnosed live (octopus_invaders_v3, 2026-07-26): asked CHECKABLE questions
 * about a frame, the model answered accurately — stars visible, nebula
 * gradients present, HUD text read correctly, health bar "full". Asked for a
 * `findings` ARRAY, the same model on the same frame then reported "no
 * nebulae", "UI elements appear randomly placed" and a health bar overflowing
 * its container. Perception was fine; the list-shaped task was not — a
 * `findings: []` slot plus a "strict reviewer" persona gets filled whether or
 * not defects exist, and single-frame input invites claims about animation and
 * hit-feedback that one still frame cannot show.
 *
 * So each finding is put back to the model with the image and asked for the
 * evidence. Anything it cannot point to is discarded rather than shipped as a
 * defect for an agent to "fix" in working code.
 */
export async function corroborateFindings(
  findings: string[],
  screenshotPaths: string[],
  fetchImpl?: typeof fetchModelWithRetry
): Promise<{ kept: string[]; dropped: string[] }> {
  const kept: string[] = [];
  const dropped: string[] = [];
  if (!visionJudgeConfigured() || findings.length === 0) {
    return { kept: findings, dropped };
  }
  const endpoint = (process.env.UAP_VISION_ENDPOINT as string).replace(/\/$/, '');
  const model = process.env.UAP_VISION_MODEL as string;
  const doFetch = fetchImpl ?? fetchModelWithRetry;
  const images = screenshotPaths.slice(0, MAX_IMAGES).map((p) => ({
    type: 'image_url',
    image_url: { url: `data:image/png;base64,${readFileSync(p).toString('base64')}` },
  }));
  for (const finding of findings.slice(0, MAX_FINDINGS)) {
    try {
      const res = await doFetch(`${endpoint}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(process.env.UAP_VISION_API_KEY ? { Authorization: `Bearer ${process.env.UAP_VISION_API_KEY}` } : {}),
        },
        signal: AbortSignal.timeout(VISION_CALL_TIMEOUT_MS),
        body: JSON.stringify({
          model,
          max_tokens: 220,
          temperature: 0,
          chat_template_kwargs: { enable_thinking: false },
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text:
                    'A reviewer made this claim about the image:\n"' +
                    finding.slice(0, 400) +
                    '"\n\nYour job is to CHECK it, not to agree with it. Answer ONLY JSON: ' +
                    '{"visible": <true|false>, "where": "<region of the image that shows it, or empty>"}\n' +
                    'Answer false if the claim is about motion, animation, timing, or what happens ' +
                    'when the user acts — a single still frame cannot show those. ' +
                    'Answer false if it is a matter of taste rather than something visible. ' +
                    'When in doubt, answer false.',
                },
                ...images,
              ],
            },
          ],
        }),
      });
      if (!res.ok) {
        // Cannot check ⇒ cannot substantiate. Withhold rather than assert.
        dropped.push(finding);
        continue;
      }
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
      };
      const raw = data.choices?.[0]?.message?.content || data.choices?.[0]?.message?.reasoning_content || '';
      const start = raw.indexOf('{');
      const end = raw.lastIndexOf('}');
      let visible = false;
      let where = '';
      if (start >= 0 && end > start) {
        try {
          const j = JSON.parse(raw.slice(start, end + 1)) as { visible?: unknown; where?: unknown };
          visible = j.visible === true;
          where = typeof j.where === 'string' ? j.where : '';
        } catch {
          visible = false;
        }
      }
      if (visible && where.trim()) kept.push(`${finding} [seen: ${where.trim().slice(0, 80)}]`);
      else dropped.push(finding);
    } catch {
      dropped.push(finding);
    }
  }
  return { kept, dropped };
}

/** One-line advisory summary for reports/evidence. */
export function visionSummary(verdict: VisionVerdict | null): string | null {
  if (!verdict) return null;
  const findings = verdict.findings.length > 0 ? ` — ${verdict.findings.slice(0, 3).join('; ')}` : '';
  return `vision review: ${verdict.score.toFixed(1)}/10${findings}`;
}
