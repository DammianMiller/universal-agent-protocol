/**
 * api-behavior outcome class extractor — quality-tier uplift plan 1.1.
 *
 * The artifact is an API transcript: a JSON file holding the contract (a
 * lightweight schema) and the measured exchanges — each one a request, the
 * golden `expected` response, the actual `response`, and its latency. The
 * SAME shape serves anchors (an exemplar run: response === expected) and
 * captures (a run to judge), so anchors and captures are always comparable.
 *
 * {
 *   "version": 1,
 *   "schema": { "required": ["id", "status"], "properties": { "id": "string", … } },
 *   "exchanges": [
 *     { "id": "create", "request": {…}, "expected": {…}, "response": {…}, "latencyMs": 96 }
 *   ]
 * }
 *
 * Axes (scalars on the TierVector; directions/directives live in classes.ts):
 *   schemaConformance  fraction of responses that satisfy the schema
 *   fieldCoverage      fraction of the golden field inventory the responses carry
 *   semanticFidelity   mean trigram-Dice similarity, response vs expected
 *   latencyP95Ms       nearest-rank 95th percentile latency in milliseconds
 *   exchangeCount      evidence volume (not a gated axis; degenerate guard)
 *
 * Deterministic by construction: stable JSON, sorted keys, set-based
 * similarity — no RNG, no clocks. Fail-soft: unreadable/malformed input
 * returns null and the caller reports it.
 */
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { TIER_EXTRACTOR_VERSION, TierVector } from './tier.js';

interface MiniSchema {
  required?: string[];
  properties?: Record<string, string | MiniSchema>;
}

interface Exchange {
  request?: unknown;
  expected?: unknown;
  response?: unknown;
  latencyMs?: number;
}

interface Transcript {
  version?: number;
  schema?: MiniSchema;
  exchanges?: Exchange[];
}

const r5 = (x: number): number => Math.round(x * 1e5) / 1e5;

/** Deterministic JSON: keys sorted at every level. */
function stableString(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableString).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableString(v)}`).join(',')}}`;
}

/** Character-trigram set of a string — the similarity basis. */
function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  const padded = `  ${s}  `;
  for (let i = 0; i < padded.length - 2; i++) out.add(padded.slice(i, i + 3));
  return out;
}

/** Dice coefficient over trigram sets: 1 = identical, 0 = disjoint. */
function trigramSimilarity(a: string, b: string): number {
  const A = trigrams(a);
  const B = trigrams(b);
  if (A.size === 0 && B.size === 0) return 1;
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const g of A) if (B.has(g)) shared += 1;
  return (2 * shared) / (A.size + B.size);
}

/** Does `value` satisfy the declared type word? ('integer' excludes floats.) */
function typeOk(value: unknown, type: string | MiniSchema): boolean {
  if (typeof type !== 'string') return conforms(value, type);
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array': return Array.isArray(value);
    default: return true; // unknown type words gate nothing (fail-open on the schema author)
  }
}

/** Recursive conformance: required keys present, declared types honored. */
function conforms(value: unknown, schema?: MiniSchema): boolean {
  if (!schema) return true;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return schema.required === undefined;
  }
  const obj = value as Record<string, unknown>;
  for (const key of schema.required ?? []) if (obj[key] === undefined) return false;
  for (const [key, type] of Object.entries(schema.properties ?? {})) {
    if (obj[key] === undefined) continue; // optional — presence is coverage's axis, not shape's
    if (!typeOk(obj[key], type)) return false;
  }
  return true;
}

/** Dotted leaf paths of a JSON value — the golden field inventory unit. */
function leafPaths(value: unknown, prefix = ''): Set<string> {
  const out = new Set<string>();
  if (value === null || typeof value !== 'object') {
    if (prefix) out.add(prefix);
    return out;
  }
  const entries = Array.isArray(value)
    ? value.map((v, i) => [String(i), v] as const)
    : Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    if (prefix) out.add(prefix);
    return out;
  }
  for (const [k, v] of entries) {
    const paths = leafPaths(v, prefix ? `${prefix}.${k}` : k);
    for (const p of paths) out.add(p);
  }
  return out;
}

/** Nearest-rank percentile (deterministic, no interpolation). */
function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const rank = Math.max(1, Math.ceil((p / 100) * sortedValues.length));
  return sortedValues[Math.min(sortedValues.length, rank) - 1];
}

/** Measure an API transcript file into a tier vector. Null on any read/shape failure. */
export function extractApiVector(path: string): TierVector | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  let t: Transcript;
  try {
    t = JSON.parse(raw) as Transcript;
  } catch {
    return null;
  }
  if (!t || typeof t !== 'object' || !Array.isArray(t.exchanges)) return null;
  const schema = t.schema ?? {};
  const exchanges = t.exchanges;

  // The golden field inventory: every leaf the exemplars declare, per exchange
  // index (order is stable within a transcript file), so coverage is measured
  // against what the contract actually demonstrates — not a schema key list.
  const inventory = exchanges.map((e) => leafPaths(e?.expected ?? null));

  let conforming = 0;
  let coveredLeaves = 0;
  let totalLeaves = 0;
  let fidelitySum = 0;
  const latencies: number[] = [];

  exchanges.forEach((e, i) => {
    const response = e?.response ?? null;
    if (conforms(response, schema)) conforming += 1;
    const goldenLeaves = inventory[i] ?? new Set<string>();
    totalLeaves += goldenLeaves.size;
    const got = leafPaths(response);
    for (const leaf of goldenLeaves) if (got.has(leaf)) coveredLeaves += 1;
    fidelitySum += trigramSimilarity(stableString(response), stableString(e?.expected ?? null));
    if (typeof e?.latencyMs === 'number' && Number.isFinite(e.latencyMs) && e.latencyMs >= 0) {
      latencies.push(e.latencyMs);
    }
  });

  const n = exchanges.length;
  const scalars: Record<string, number> = {
    schemaConformance: r5(n === 0 ? 0 : conforming / n),
    fieldCoverage: r5(totalLeaves === 0 ? 1 : coveredLeaves / totalLeaves),
    semanticFidelity: r5(n === 0 ? 0 : fidelitySum / n),
    latencyP95Ms: r5(percentile([...latencies].sort((a, b) => a - b), 95)),
    exchangeCount: n,
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
