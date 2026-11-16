/**
 * doc-style outcome class extractor — quality-tier uplift plan 1.1's fourth
 * class, harvested from the operator-approved v2.51.1 rewrite corpus (commit
 * e3fbc295: "rewrite all documentation in the new default writing style",
 * 2131 prose em dashes normalized corpus-wide).
 *
 * The artifact is a documentation file (Markdown). The SAME shape serves
 * anchors (an exemplar doc — the shipped corpus) and captures (a doc to
 * judge). Code blocks, inline code, tables, and link syntax are stripped
 * before measuring: the axes judge PROSE, not scaffolding.
 *
 * Axes (scalars on the TierVector; directions/directives live in classes.ts):
 *   emDashPer1k      em dashes per 1000 prose chars (the rewrite's signature)
 *   sentenceLenMean  mean words per sentence (readability — one topic each)
 *   wordLenMean      mean letters per word (plain words over nominalizations)
 *   dupSentenceFrac  fraction of repeated >30-char sentences (copy-paste bloat)
 *   proseChars      evidence volume (degenerate guard, not a gated axis)
 *
 * Deterministic by construction: pure text counting, no RNG, no clocks.
 * Fail-soft: unreadable input returns null and the caller reports it.
 */
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { TIER_EXTRACTOR_VERSION, TierVector } from './tier.js';

const r5 = (x: number): number => Math.round(x * 1e5) / 1e5;

/** Strip non-prose scaffolding: fenced code, inline code, tables, headings,
 * blockquotes, and link syntax (link text stays — it is prose). */
function proseOf(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/^\s*\|.*\|.*$/gm, ' ')
    .replace(/^[#>].*$/gm, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
}

function sentencesOf(prose: string): string[] {
  return prose
    .split(/[.!?]+(\s|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Measure a documentation file into a tier vector. Null on read failure. */
export function extractDocVector(path: string): TierVector | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const prose = proseOf(raw);
  const proseChars = prose.replace(/\s/g, '').length;
  const emDashes = (prose.match(/—/g) || []).length;
  const sentences = sentencesOf(prose);
  const lens = sentences
    .map((s) => s.split(/\s+/).filter(Boolean).length)
    .filter((n) => n > 0);
  const sentenceLenMean = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 0;
  const words = prose.match(/[A-Za-z][A-Za-z'-]*/g) || [];
  const wordLenMean = words.length ? words.reduce((a, w) => a + w.length, 0) / words.length : 0;

  const seen = new Set<string>();
  let dup = 0;
  for (const s of sentences) {
    const key = s.toLowerCase();
    if (key.length > 30) {
      if (seen.has(key)) dup += 1;
      seen.add(key);
    }
  }

  const scalars: Record<string, number> = {
    emDashPer1k: r5((1000 * emDashes) / Math.max(1, proseChars)),
    sentenceLenMean: r5(sentenceLenMean),
    wordLenMean: r5(wordLenMean),
    dupSentenceFrac: r5(dup / Math.max(1, sentences.length)),
    proseChars,
  };

  return {
    extractorVersion: TIER_EXTRACTOR_VERSION,
    canonicalWidth: 0,
    canonicalHeight: 0,
    sha256: createHash('sha256').update(raw).digest('hex'),
    satMean: 0,
    valMean: 0,
    contrast: 0,
    edgeFrac: 0,
    glowFrac: 0,
    darkFrac: 0,
    colors12: 0,
    scalars,
  };
}
