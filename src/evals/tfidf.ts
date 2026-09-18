/**
 * TF-IDF RANKER — pure-TypeScript retrieval scorer for routing evals.
 *
 * Airgap-pure by design: no embedding model, no network, deterministic output.
 * Used by the routing eval harness (0.4) to measure whether corpus entries
 * (patterns, droids, skills) stay separable as the registry grows.
 */

/** Minimal stopword list — keeps domain tokens, drops glue words. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'else', 'for', 'to',
  'of', 'in', 'on', 'at', 'by', 'with', 'from', 'as', 'is', 'are', 'was',
  'were', 'be', 'been', 'being', 'it', 'its', 'this', 'that', 'these',
  'those', 'i', 'we', 'you', 'they', 'he', 'she', 'do', 'does', 'did',
  'use', 'using', 'used', 'when', 'what', 'which', 'who', 'how', 'why',
  'our', 'your', 'their', 'my', 'his', 'her', 'its', 'not', 'no', 'so',
  'can', 'could', 'should', 'would', 'will', 'shall', 'may', 'might',
  'into', 'onto', 'upon', 'via', 'per', 'about', 'over', 'under', 'again',
]);

/**
 * Naive suffix stemmer — good enough for routing separability without a
 * dependency. Handles the dominant mismatch classes seen in calibration:
 * plurals ("interfaces"/"interface") and -ing forms ("tweaking"/"tweak").
 */
export function stem(token: string): string {
  if (token.length <= 4) return token;
  if (token.endsWith('ing') && token.length > 6) return token.slice(0, -3);
  if (token.endsWith('ed') && token.length > 5) return token.slice(0, -2);
  // "-es" after a sibilant: processes→process, classes→class (before plain -s)
  if (/(s|x|ch|sh)es$/.test(token) && token.length > 5) return token.slice(0, -2);
  if (token.endsWith('s') && !token.endsWith('ss') && !token.endsWith('us')) {
    return token.slice(0, -1);
  }
  return token;
}

/** Tokenize: lowercase, split on non-alphanumerics, stem, drop short + stopwords. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map(stem)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

function l2Norm(vec: Map<string, number>): number {
  let sum = 0;
  for (const v of vec.values()) sum += v * v;
  return Math.sqrt(sum);
}

function cosine(
  a: Map<string, number>,
  aNorm: number,
  b: Map<string, number>,
  bNorm: number,
): number {
  if (aNorm === 0 || bNorm === 0) return 0;
  // Iterate the smaller vector for speed.
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [term, w] of small) {
    const other = big.get(term);
    if (other !== undefined) dot += w * other;
  }
  return dot / (aNorm * bNorm);
}

export class TfIdfIndex {
  private readonly idf = new Map<string, number>();
  private vectors: Array<Map<string, number>> = [];
  private norms: number[] = [];
  /** Raw tokenized documents, kept for shared-token overlap analysis. */
  private docTokens: string[][] = [];

  constructor(documents: string[]) {
    this.build(documents);
  }

  /** Distinct content tokens shared between the query and a document. */
  sharedTokens(query: string, docIndex: number): string[] {
    const doc = this.docTokens[docIndex];
    if (!doc) return [];
    const docSet = new Set(doc);
    return [...new Set(tokenize(query))].filter((t) => docSet.has(t));
  }

  private build(documents: string[]): void {
    const tokenized = documents.map((d) => tokenize(d));
    this.docTokens = tokenized;
    const docFreq = new Map<string, number>();
    for (const tokens of tokenized) {
      for (const term of new Set(tokens)) {
        docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
      }
    }
    const total = Math.max(documents.length, 1);
    for (const [term, df] of docFreq) {
      this.idf.set(term, Math.log(1 + total / df));
    }
    this.vectors = tokenized.map((tokens) => this.vectorize(tokens));
    this.norms = this.vectors.map((v) => l2Norm(v));
  }

  private vectorize(tokens: string[]): Map<string, number> {
    const termFreq = new Map<string, number>();
    for (const t of tokens) termFreq.set(t, (termFreq.get(t) ?? 0) + 1);
    const vec = new Map<string, number>();
    for (const [term, count] of termFreq) {
      const idf = this.idf.get(term);
      if (idf === undefined) continue; // unseen term (query side)
      vec.set(term, (1 + Math.log(count)) * idf);
    }
    return vec;
  }

  /** Cosine score of the query against every document, in document order. */
  score(query: string): number[] {
    const qv = this.vectorize(tokenize(query));
    const qn = l2Norm(qv);
    return this.vectors.map((dv, i) => cosine(qv, qn, dv, this.norms[i]));
  }

  /** Index of the highest-scoring document, or -1 when all scores are 0. */
  topIndex(query: string): { index: number; score: number } {
    const scores = this.score(query);
    let best = -1;
    let bestScore = 0;
    for (let i = 0; i < scores.length; i++) {
      if (scores[i] > bestScore) {
        bestScore = scores[i];
        best = i;
      }
    }
    return { index: best, score: bestScore };
  }
}
