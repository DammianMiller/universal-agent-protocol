/**
 * ideation-outcome class extractor — frontier-parity plan F: the outcome class
 * for ideation artifacts (candidate idea sets), the class the innovation /
 * aspiration axes of the uplift mission gate on.
 *
 * The artifact is an ideation document (Markdown): a SET of candidate ideas,
 * one `##` section per candidate (the shape `uap ideate` curates into, and
 * the open-collider curated_ideas bridge renders). The SAME shape serves
 * anchors (an exemplar idea set) and captures (a set to judge).
 *
 * Axes (scalars on the TierVector; directions/directives live in classes.ts):
 *   stanceShare        fraction of candidates that carry a stance — a claim
 *                      committed to, not a hedge stack (P48 rule 1). A
 *                      candidate carries a stance when it holds at least one
 *                      committed sentence and no more hedged than committed.
 *   compositionDepth   mean sub-structure lines per candidate (sub-headings,
 *                      list items, bold-label part-lines like "**Stance:**")
 *                      — a candidate built of parts, not one flat paragraph
 *                      (composition-hierarchy). Format-aware since extractor
 *                      v2 (wave 6, item 5): the 2026-11-25 A.2 parity probes
 *                      found the free-form condition scored compositionDepth
 *                      0 against the tier-contract condition's 14.29 purely
 *                      on format — inkling composes candidates from
 *                      **Label:** part-lines, which the markdown-only
 *                      counter never saw. A labeled part-line is composition
 *                      evidence regardless of the marker it uses.
 *   topicDiversity     distinct significant words / total significant words —
 *                      how much of the solution space the set draws on
 *                      (subsystem-coverage: the ambition floor generalized
 *                      out of visual-scene).
 *   ideaDistance       mean nearest-neighbor Jaccard distance between
 *                      candidates' significant-word sets — the deterministic
 *                      local novelty measure. Clustered sets (hivemind) sit
 *                      near 0; disjoint explorations near 1. When a
 *                      deterministic embedding seam exists this is the axis
 *                      to re-express on it.
 *   candidateCount     evidence volume (degenerate guard, not a gated axis)
 *   proseChars         evidence volume (degenerate guard, not a gated axis)
 *
 * Deterministic by construction: pure text counting, no RNG, no clocks, no
 * network. Fail-soft: unreadable input returns null and the caller reports it.
 */
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { extractorVersionFor } from './classes.js';
import { TierVector } from './tier.js';

const r5 = (x: number): number => Math.round(x * 1e5) / 1e5;

/** Hedging vocabulary — a sentence counted by one of these takes no position. */
const HEDGE_RE = /\b(might|may|could|perhaps|possibly|maybe|potentially|arguably|seems|appears|somewhat|likely|presumably)\b/gi;
/** Commitment vocabulary — a sentence counted by one of these takes a stance. */
const COMMIT_RE = /\b(will|must|choose|chooses|picks|wins|beats|recommend|recommends|commit|commits|decisive|always|never)\b/gi;

/** Words too common to carry topic signal. Kept short and deterministic. */
const STOPWORDS = new Set([
  'about', 'above', 'after', 'again', 'against', 'along', 'although', 'always',
  'another', 'because', 'before', 'being', 'below', 'between', 'beyond',
  'could', 'every', 'first', 'found', 'great', 'group', 'however', 'into',
  'itself', 'just', 'large', 'later', 'least', 'less', 'might', 'more',
  'most', 'much', 'never', 'often', 'other', 'others', 'over', 'quite',
  'rather', 'really', 'since', 'small', 'some', 'still', 'their', 'them',
  'there', 'these', 'things', 'those', 'through', 'under', 'until', 'very',
  'what', 'where', 'which', 'while', 'whose', 'with', 'would', 'should',
  'your',
]);

export interface IdeationSection {
  /** Prose with scaffolding stripped (sentences/markers measure this). */
  prose: string;
  /** Sub-structure lines (sub-headings, list items) — composition evidence. */
  subLines: number;
  /** The section's significant-word set — the novelty metric's unit. */
  sigWords: Set<string>;
}

/** Split an ideation doc into candidate sections: `##`-separated blocks.
 *  The preamble before the first `##` (title, framing) is NOT a candidate. */
export function sectionsOf(raw: string): IdeationSection[] {
  const out: IdeationSection[] = [];
  const blocks = raw.split(/^##\s+/m).slice(1);
  for (const block of blocks) {
    const body = block.slice(block.indexOf('\n') + 1);
    // Sub-structure = a composed part-line. Three marker families, one role:
    //   ### sub-headings            — markdown composition
    //   - / * / 1. list items       — markdown composition
    //   **Short label** at line start — bold-label parts (wave 6, item 5).
    // The bold-label family is what free-form ideation actually emits
    // ("**Stance:** …", "**Mechanism:** …"); counting only the markdown
    // families scored genuinely composed candidates as flat prose, a
    // format-conditional zero the tier-contract condition could not produce.
    // A short span (<49 chars) at line start is a label; a whole bold
    // SENTENCE opening a paragraph is emphasis, not a part-label.
    const subLines = (
      body.match(
        /^(?:#{3,}\s|\s*(?:[-*+]|\d+[.)])\s|\s*\*\*[^*\n]{1,48}\*\*)/gm,
      ) || []
    ).length;
    const prose = body
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`[^`\n]*`/g, ' ')
      .replace(/^\s*\|.*\|.*$/gm, ' ')
      .replace(/^#{1,}.*$/gm, ' ')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^\s*(?:[-*+]|\d+[.)])\s/gm, '')
      .trim();
    if (prose.replace(/\s/g, '').length === 0) continue;
    out.push({ prose, subLines, sigWords: sigWordsOf(body) });
  }
  return out;
}

/** Significant words of a text: ≥5 letters, lowercased, stopwords dropped. */
export function sigWordsOf(text: string): Set<string> {
  const out = new Set<string>();
  const stripped = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  for (const w of stripped.match(/[A-Za-z][A-Za-z'-]{4,}/g) || []) {
    const low = w.toLowerCase();
    if (!STOPWORDS.has(low)) out.add(low);
  }
  return out;
}

/** Nearest-neighbor Jaccard distance of section i to every other section.
 *  Novel when the CLOSEST other candidate is still far — a candidate similar
 *  to any other has a small nearest distance no matter how far the rest are. */
function nearestDistance(i: number, sections: IdeationSection[]): number {
  let best = Infinity;
  for (let j = 0; j < sections.length; j++) {
    if (j === i) continue;
    const a = sections[i].sigWords;
    const b = sections[j].sigWords;
    if (a.size === 0 || b.size === 0) continue;
    let inter = 0;
    for (const w of a) if (b.has(w)) inter += 1;
    const union = a.size + b.size - inter;
    if (union > 0) {
      const d = 1 - inter / union;
      if (d < best) best = d;
    }
  }
  return best === Infinity ? 0 : best;
}

/** True when a section holds at least one committed sentence and no more
 *  hedged sentences than committed ones — it takes and keeps a stance. */
function carriesStance(prose: string): boolean {
  const sentences = prose
    .split(/[.!?]+(\s|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  let committed = 0;
  let hedged = 0;
  for (const s of sentences) {
    const hasHedge = HEDGE_RE.test(s);
    HEDGE_RE.lastIndex = 0;
    const hasCommit = COMMIT_RE.test(s);
    COMMIT_RE.lastIndex = 0;
    if (hasCommit) committed += 1;
    else if (hasHedge) hedged += 1;
  }
  return committed >= 1 && committed >= hedged;
}

/**
 * Rank a plain idea list by measured novelty — mean Jaccard distance from
 * each idea to every other. The most distinct idea ranks first. This is the
 * measured-novelty selection the `uap ideate` curation reads (plan F): the
 * judge's taste proposes, the distance measurement decides.
 */
export function rankIdeasByNovelty(ideas: string[]): Array<{ index: number; idea: string; novelty: number }> {
  const sets = ideas.map((i) => sigWordsOf(i));
  return ideas
    .map((idea, i) => {
      let total = 0;
      let pairs = 0;
      for (let j = 0; j < sets.length; j++) {
        if (j === i) continue;
        const a = sets[i];
        const b = sets[j];
        if (a.size === 0 || b.size === 0) continue;
        let inter = 0;
        for (const w of a) if (b.has(w)) inter += 1;
        const union = a.size + b.size - inter;
        if (union > 0) {
          total += 1 - inter / union;
          pairs += 1;
        }
      }
      return { index: i, idea, novelty: r5(pairs > 0 ? total / pairs : 0) };
    })
    .sort((a, b) => b.novelty - a.novelty);
}

/** Measure an ideation document into a tier vector. Null on read failure. */
export function extractIdeationVector(path: string): TierVector | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const sections = sectionsOf(raw);
  const candidateCount = sections.length;
  const proseChars = sections.reduce((n, s) => n + s.prose.replace(/\s/g, '').length, 0);

  const withStance = sections.filter((s) => carriesStance(s.prose)).length;
  const stanceShare = candidateCount > 0 ? withStance / candidateCount : 0;

  const compositionDepth =
    candidateCount > 0
      ? sections.reduce((n, s) => n + s.subLines, 0) / candidateCount
      : 0;

  const all: string[] = [];
  const distinct = new Set<string>();
  for (const s of sections) {
    for (const w of s.sigWords) {
      all.push(w);
      distinct.add(w);
    }
  }
  const topicDiversity = all.length > 0 ? distinct.size / all.length : 0;

  let distSum = 0;
  for (let i = 0; i < sections.length; i++) {
    distSum += nearestDistance(i, sections);
  }
  const ideaDistance = candidateCount >= 2 ? distSum / candidateCount : 0;

  const scalars: Record<string, number> = {
    stanceShare: r5(stanceShare),
    compositionDepth: r5(compositionDepth),
    topicDiversity: r5(topicDiversity),
    ideaDistance: r5(ideaDistance),
    candidateCount,
    proseChars,
  };

  return {
    // The class's own extractor version (v2: format-aware composition
    // depth), not the global baseline — this vector's semantics are what
    // the class version names, and extractorVersionFor is the source of
    // truth the tier staleness check compares against.
    extractorVersion: extractorVersionFor('ideation-outcome'),
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
