/**
 * HALO Trace Exporter
 *
 * Emits agent/LLM/tool execution as JSONL spans in the OTLP / OpenInference
 * shape that the HALO engine (https://github.com/context-labs/HALO) ingests
 * for systemic harness-failure analysis. One JSON object per line.
 *
 * Opt-in and zero-overhead when disabled: every emit path short-circuits on
 * `isHaloTracingEnabled()` before doing any work. Enable with:
 *
 *   UAP_HALO_TRACE=1                       # turn on
 *   UAP_HALO_TRACE_PATH=/path/traces.jsonl # output file (default .uap/halo/traces.jsonl)
 *   UAP_HALO_PROJECT_ID=uap                # inference.project_id (default "uap")
 *
 * Then feed the file to HALO:  halo <traces>.jsonl -p "systemic failure modes?"
 *
 * Failures here never throw into the caller — tracing must not break execution.
 */

import { appendFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { randomBytes, createHash } from 'crypto';

/** HALO `inference.observation_kind` / `openinference.span.kind` values. */
export type HaloObservationKind = 'AGENT' | 'LLM' | 'TOOL' | 'CHAIN' | 'GUARDRAIL' | 'SPAN';

/** Schema version HALO expects in `inference.export.schema_version`. */
export const HALO_SCHEMA_VERSION = 1;
const SERVICE_NAME_DEFAULT = 'uap';
const SCOPE_NAME = 'uap-mcp-router';

export interface HaloSpanInput {
  kind: HaloObservationKind;
  /** Span name, e.g. "tool.github.create_issue" or "agent.security-auditor". */
  name: string;
  startTimeMs: number;
  endTimeMs: number;
  /** true → STATUS_CODE_OK, false → STATUS_CODE_ERROR. */
  ok: boolean;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  /** Kind-specific attributes merged into the span's attribute map. */
  attributes?: Record<string, unknown>;
  serviceName?: string;
  projectId?: string;
  scopeVersion?: string;
}

/** The serialized span object written as one JSONL line. */
export interface HaloSpan {
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  name: string;
  kind: string;
  start_time: string;
  end_time: string;
  status: { code: 'STATUS_CODE_OK' | 'STATUS_CODE_ERROR' };
  resource: { attributes: Record<string, unknown> };
  scope: { name: string; version: string };
  attributes: Record<string, unknown>;
}

export function isHaloTracingEnabled(): boolean {
  const v = process.env.UAP_HALO_TRACE;
  return v === '1' || v === 'true';
}

export function haloTracePath(): string {
  return process.env.UAP_HALO_TRACE_PATH || join(process.cwd(), '.uap', 'halo', 'traces.jsonl');
}

function projectId(override?: string): string {
  return override || process.env.UAP_HALO_PROJECT_ID || SERVICE_NAME_DEFAULT;
}

/** 32-hex-char OTLP trace id. */
export function newTraceId(): string {
  return randomBytes(16).toString('hex');
}

/** 16-hex-char OTLP span id. */
export function newSpanId(): string {
  return randomBytes(8).toString('hex');
}

/** Stable 16-hex span id derived from a seed (e.g. an agent id) for linkage. */
export function deterministicSpanId(seed: string): string {
  return createHash('sha1').update(seed).digest('hex').slice(0, 16);
}

/**
 * ISO-8601 timestamp with nanosecond precision and trailing `Z`, as HALO's
 * verifier requires. JS clocks are millisecond-resolution, so the sub-ms
 * nanosecond digits are zero-padded.
 */
export function isoNanos(ms: number): string {
  // e.g. "2026-05-30T22:45:33.123Z" → "2026-05-30T22:45:33.123000000Z"
  return new Date(ms).toISOString().replace(/Z$/, '000000Z');
}

// One trace id per process so all spans from a single run group together.
let _sessionTraceId: string | null = null;
export function sessionTraceId(): string {
  if (!_sessionTraceId) _sessionTraceId = newTraceId();
  return _sessionTraceId;
}

/** Reset module state. Test-only. */
export function _resetHaloSession(): void {
  _sessionTraceId = null;
  _warned = false;
}

/** Build the serialized span object without performing any I/O (pure). */
export function buildHaloSpan(input: HaloSpanInput): HaloSpan {
  const span: HaloSpan = {
    trace_id: input.traceId ?? sessionTraceId(),
    span_id: input.spanId ?? newSpanId(),
    name: input.name,
    kind: 'SPAN_KIND_INTERNAL',
    start_time: isoNanos(input.startTimeMs),
    end_time: isoNanos(input.endTimeMs),
    status: { code: input.ok ? 'STATUS_CODE_OK' : 'STATUS_CODE_ERROR' },
    resource: { attributes: { 'service.name': input.serviceName ?? SERVICE_NAME_DEFAULT } },
    scope: { name: SCOPE_NAME, version: input.scopeVersion ?? '0.0.0' },
    attributes: {
      'inference.project_id': projectId(input.projectId),
      'inference.observation_kind': input.kind,
      'inference.export.schema_version': HALO_SCHEMA_VERSION,
      'openinference.span.kind': input.kind,
      ...(input.attributes ?? {}),
    },
  };
  if (input.parentSpanId) span.parent_span_id = input.parentSpanId;
  return span;
}

let _warned = false;

/** Append a span to the trace file. No-op when tracing is disabled. */
export function recordHaloSpan(input: HaloSpanInput): void {
  if (!isHaloTracingEnabled()) return;
  try {
    const span = buildHaloSpan(input);
    const path = haloTracePath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(span) + '\n');
  } catch (err) {
    if (!_warned) {
      console.error(`[halo] trace export failed: ${(err as Error).message}`);
      _warned = true;
    }
  }
}

/** Convenience: record a TOOL span. */
export function recordToolSpan(
  toolPath: string,
  startTimeMs: number,
  endTimeMs: number,
  ok: boolean,
  extra?: Record<string, unknown>
): void {
  if (!isHaloTracingEnabled()) return;
  recordHaloSpan({
    kind: 'TOOL',
    name: `tool.${toolPath}`,
    startTimeMs,
    endTimeMs,
    ok,
    attributes: { 'tool.name': toolPath, ...(extra ?? {}) },
  });
}

/** Convenience: record an AGENT span, linking to a parent agent id when present. */
export function recordAgentSpan(
  agentId: string,
  agentName: string,
  startTimeMs: number,
  endTimeMs: number,
  ok: boolean,
  parentAgentId?: string | null,
  extra?: Record<string, unknown>
): void {
  if (!isHaloTracingEnabled()) return;
  recordHaloSpan({
    kind: 'AGENT',
    name: `agent.${agentName}`,
    startTimeMs,
    endTimeMs,
    ok,
    spanId: deterministicSpanId(agentId),
    parentSpanId: parentAgentId ? deterministicSpanId(parentAgentId) : undefined,
    attributes: { 'agent.name': agentName, ...(extra ?? {}) },
  });
}
