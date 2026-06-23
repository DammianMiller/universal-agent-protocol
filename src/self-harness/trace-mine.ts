/**
 * Self-Harness — online weakness mining from PRODUCTION traces (P3).
 *
 * The records-miner (mine.ts) needs a paired bench. Online mining works on real
 * traffic from two sources:
 *  - HALO spans (.uap/halo/traces.jsonl) — the `uap deliver` pipeline.
 *  - Proxy log signals (journald) — the claude-local proxy path, where
 *    toolcall.path.garbled actually surfaces (records can't distinguish it from a
 *    logic error; the proxy's TOOLCALL PATH NORMALIZER line proves it occurred).
 *
 * Both produce the same ranked WeaknessReport[] keyed by stable signature.
 * Mining is READ-ONLY; prod-mined proposals are enqueued for gated validation,
 * never auto-applied (see pending.ts). docs/design/SELF_HARNESS.md §9.
 */

import {
  FailureKind,
  WeaknessReport,
  signatureHash,
  rankWeaknesses,
} from './weakness.js';

/** Minimal shape of a HALO span we classify (subset of HaloSpan). */
export interface HaloSpanLike {
  name?: string;
  status?: { code?: string };
  attributes?: Record<string, unknown>;
}

/** Classify one HALO span into a FailureKind, or null if it's not a failure. */
export function classifyHaloSpan(span: HaloSpanLike): FailureKind | null {
  const attrs = span.attributes ?? {};
  const isError = (span.status?.code ?? '').toUpperCase().includes('ERROR');
  const execErr = String(attrs['delivery.executor_error'] ?? '').toLowerCase();
  const applyErr = String(attrs['delivery.apply_error'] ?? '').toLowerCase();
  const err = `${execErr} ${applyErr}`.trim();

  if (err.includes('timed out') || err.includes('timeout')) return 'agent.timeout';
  // An apply error mentioning a path/file that could not be located → garbled path.
  if (applyErr && /(no such file|not found|does not exist|invalid path|outside)/.test(applyErr)) {
    return 'toolcall.path.garbled';
  }
  if (err.includes('exit') || err.includes('spawn') || err.includes('killed')) return 'agent.error';
  // Gates failed but the turn produced output → a wrong/insufficient deliverable.
  const gatesFailed = attrs['delivery.gates_failed'];
  if (isError || (typeof gatesFailed === 'string' && gatesFailed) || (Array.isArray(gatesFailed) && gatesFailed.length)) {
    return 'verify.fail';
  }
  return null;
}

/**
 * Classify one proxy journal line. The proxy already logs the structured signals
 * we care about; this turns them into FailureKinds for online mining.
 */
export function classifyProxyLogLine(line: string): FailureKind | null {
  if (line.includes('TOOLCALL PATH NORMALIZER')) return 'toolcall.path.garbled';
  if (line.includes('TURN-COUNT FINALIZE BREAKER')) return 'loop.nonterminate';
  if (line.includes('RECON CONVERGENCE') && line.includes('hard-escalated')) return 'guardrail.poison.recon';
  if (line.includes('exceeds the available context size')) return 'gen.runaway.npredict';
  if (line.includes('should_stop condition')) return 'agent.timeout';
  return null;
}

interface Agg {
  count: number;
  tasks: Set<string>;
  evidence: string[];
}

function aggregate(
  kinds: Iterable<{ kind: FailureKind; task: string; evidence: string }>,
  model: string,
  minFrequency: number,
): WeaknessReport[] {
  const byKind = new Map<FailureKind, Agg>();
  for (const { kind, task, evidence } of kinds) {
    let a = byKind.get(kind);
    if (!a) {
      a = { count: 0, tasks: new Set(), evidence: [] };
      byKind.set(kind, a);
    }
    a.count += 1;
    a.tasks.add(task);
    if (a.evidence.length < 5) a.evidence.push(evidence);
  }
  const reports: WeaknessReport[] = [];
  for (const [kind, a] of byKind) {
    if (a.count < minFrequency) continue;
    reports.push({
      signature: signatureHash({ kind, model }),
      kind,
      model,
      frequency: a.count,
      affectedTasks: [...a.tasks],
      hypothesis: `Observed in production traces (${a.count}×).`,
      evidence: a.evidence,
    });
  }
  return rankWeaknesses(reports);
}

export interface OnlineMineOptions {
  model: string;
  minFrequency?: number;
}

/** Mine weaknesses from HALO spans (the deliver pipeline). */
export function mineFromHaloSpans(spans: HaloSpanLike[], opts: OnlineMineOptions): WeaknessReport[] {
  const hits: { kind: FailureKind; task: string; evidence: string }[] = [];
  for (const span of spans) {
    const kind = classifyHaloSpan(span);
    if (!kind) continue;
    const task = String(span.attributes?.['inference.project_id'] ?? span.name ?? 'unknown');
    hits.push({ kind, task, evidence: `${span.name}: ${kind}` });
  }
  return aggregate(hits, opts.model, opts.minFrequency ?? 1);
}

/** Mine weaknesses from proxy journal lines (the claude-local proxy path). */
export function mineFromProxyLogLines(lines: string[], opts: OnlineMineOptions): WeaknessReport[] {
  const hits: { kind: FailureKind; task: string; evidence: string }[] = [];
  for (const line of lines) {
    const kind = classifyProxyLogLine(line);
    if (!kind) continue;
    // Sessions aren't tasks; use the proxy session fingerprint if present.
    const m = /fp:[0-9a-f]+/.exec(line);
    hits.push({ kind, task: m ? m[0] : 'proxy', evidence: line.slice(0, 160) });
  }
  return aggregate(hits, opts.model, opts.minFrequency ?? 1);
}
