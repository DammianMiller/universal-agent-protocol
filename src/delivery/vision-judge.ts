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

export interface VisionVerdict {
  /** 0–10 aesthetic/behavioral score across the reviewed screenshots. */
  score: number;
  findings: string[];
}

const MAX_IMAGES = 4;
const MAX_FINDINGS = 8;

export function visionJudgeConfigured(): boolean {
  return Boolean(process.env.UAP_VISION_MODEL && process.env.UAP_VISION_ENDPOINT);
}

/**
 * Auto-configure the vision judge from the ACTIVE local model when it isn't
 * explicitly configured. The aesthetic review used to report "no vision model"
 * whenever UAP_VISION_ENDPOINT/MODEL were unset — even though the local model
 * serving the run (e.g. Qwen3.6 with an mmproj projector) is vision-capable.
 * Probe candidate local OpenAI-compat endpoints' /props for
 * modalities.vision === true and, on a hit, set UAP_VISION_ENDPOINT/MODEL so
 * the judge uses the active model. Fail-soft: any error leaves config unset
 * (the caller then reports "not configured" exactly as before). Idempotent.
 */
export async function autodetectLocalVision(): Promise<boolean> {
  if (visionJudgeConfigured()) {
    // A pin is authoritative only while it answers. `uap setup` writes a
    // conventional 127.0.0.1:8080 endpoint, which is wrong the moment llama
    // runs on an ephemeral port — and because this early return preceded the
    // probing below, a dead pin permanently defeated discovery and the judge
    // failed later with a connection error instead of finding the live server.
    const pinned = (process.env.UAP_VISION_ENDPOINT ?? '').replace(/\/v1\/?$/, '').replace(/\/$/, '');
    try {
      const res = await fetch(`${pinned}/props`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {
      /* unreachable — fall through to discovery */
    }
    delete process.env.UAP_VISION_ENDPOINT;
    delete process.env.UAP_VISION_MODEL;
  }
  // Candidate OpenAI-compat bases, most-specific first. LLAMA_CPP_BASE is what
  // the proxy talks to; the rest are conventional local llama-server ports.
  // Explicit config first, then the servers actually listening, then the
  // conventional port. Without the discovery step this list is env vars that are
  // usually unset plus :8080 — which is empty whenever llama runs on an
  // ephemeral port (Unsloth Studio picks a new one every launch), so a
  // vision-capable server sitting right there reports "not configured".
  const bases = [
    process.env.UAP_INFERENCE_ENDPOINT,
    process.env.LLAMA_CPP_BASE,
    ...discoverLocalLlamaBases(),
    'http://127.0.0.1:8080/v1',
  ].filter((b): b is string => Boolean(b));
  for (const base of bases) {
    const root = base.replace(/\/v1\/?$/, '').replace(/\/$/, '');
    try {
      const propsRes = await fetch(`${root}/props`, { signal: AbortSignal.timeout(2000) });
      if (!propsRes.ok) continue;
      const props = (await propsRes.json()) as { modalities?: { vision?: boolean }; model_path?: string };
      if (!props?.modalities?.vision) continue;
      // Derive a model id (llama-server accepts any string; prefer the real one).
      let model = 'local';
      try {
        const modelsRes = await fetch(`${root}/v1/models`, { signal: AbortSignal.timeout(2000) });
        if (modelsRes.ok) {
          const m = (await modelsRes.json()) as { models?: { id?: string; name?: string }[]; data?: { id?: string }[] };
          model = m.models?.[0]?.id || m.models?.[0]?.name || m.data?.[0]?.id || model;
        }
      } catch { /* keep 'local' */ }
      process.env.UAP_VISION_ENDPOINT = `${root}/v1`;
      process.env.UAP_VISION_MODEL = model;
      return true;
    } catch {
      /* endpoint unreachable — try the next */
    }
  }
  return false;
}

/** Extract the first JSON object from model output (grammar-free fallback). */
export function parseVisionVerdict(text: string): VisionVerdict | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as { score?: unknown; findings?: unknown };
    const score = Number(parsed.score);
    if (!Number.isFinite(score)) return null;
    const findings = Array.isArray(parsed.findings)
      ? parsed.findings.filter((f): f is string => typeof f === 'string').slice(0, MAX_FINDINGS)
      : [];
    return { score: Math.max(0, Math.min(10, score)), findings };
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
    const body = {
      model,
      max_tokens: 800,
      temperature,
      // Disable model "thinking" for this call. A local reasoning model (e.g.
      // Qwen3.6 launched with --reasoning auto) otherwise spends the whole token
      // budget in reasoning_content and returns EMPTY content — the JSON verdict
      // never lands, so the review silently produced nothing. chat_template_kwargs
      // is honored by llama.cpp/vLLM and ignored by cloud OpenAI-compat APIs.
      chat_template_kwargs: { enable_thinking: false },
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                'You are a strict visual reviewer. These are frames of a rendered application. ' +
                'Judge (a) design/aesthetic quality (composition, color, readability, polish), ' +
                '(b) whether the visible behavior matches the spec below, and ' +
                (designContext
                  ? '(c) ADHERENCE TO THE DESIGN SYSTEM below — penalize off-palette colours, off-scale spacing, wrong fonts, and anything that violates the stated design intent. '
                  : '') +
                'Each finding must be a CONCRETE IMPLEMENTATION FIX a developer can act on — name the ' +
                'element/region and what to change — not a vague quality complaint like "looks generic". ' +
                'If a large region (especially a <canvas>) is blank or a near-uniform flat colour, say so ' +
                'explicitly: the app most likely does not RENDER its scene in the state shown — the fix is to ' +
                'run the render loop from load and draw the background/sprites in THIS state, not only during ' +
                'active interaction. If the scene looks uniformly dark/dim, check for a semi-opaque overlay ' +
                'dimming the view and recommend making it transparent. ' +
                'Respond with ONLY JSON: ' +
                '{"score": <0-10>, "findings": ["<specific, actionable fix>", ...]}\n\nSPEC:\n' +
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
