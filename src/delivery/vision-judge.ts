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

import { readFileSync } from 'fs';
import { fetchModelWithRetry } from '../models/long-fetch.js';

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
 * Score screenshots against the spec with the configured vision model.
 * Returns null when unconfigured or on any failure.
 */
export async function judgeScreenshots(
  screenshotPaths: string[],
  spec: string,
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
    const body = {
      model,
      max_tokens: 800,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                'You are a strict visual reviewer. These are frames of a rendered application. ' +
                'Judge (a) design/aesthetic quality (composition, color, readability, polish) and ' +
                '(b) whether the visible behavior matches the spec below. Respond with ONLY JSON: ' +
                '{"score": <0-10>, "findings": ["<specific, actionable issue>", ...]}\n\nSPEC:\n' +
                spec.slice(0, 4000),
            },
            ...images,
          ],
        },
      ],
    };
    const doFetch = fetchImpl ?? fetchModelWithRetry;
    const res = await doFetch(`${endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.UAP_VISION_API_KEY ? { Authorization: `Bearer ${process.env.UAP_VISION_API_KEY}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content ?? '';
    return parseVisionVerdict(content);
  } catch {
    return null;
  }
}

/** One-line advisory summary for reports/evidence. */
export function visionSummary(verdict: VisionVerdict | null): string | null {
  if (!verdict) return null;
  const findings = verdict.findings.length > 0 ? ` — ${verdict.findings.slice(0, 3).join('; ')}` : '';
  return `vision review: ${verdict.score.toFixed(1)}/10${findings}`;
}
