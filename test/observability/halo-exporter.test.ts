/**
 * HALO Trace Exporter Tests
 *
 * Verifies the JSONL span shape conforms to HALO's OTLP/OpenInference schema,
 * that timestamps carry nanosecond precision with a trailing Z, and that the
 * exporter is a strict no-op when tracing is disabled.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildHaloSpan,
  recordHaloSpan,
  recordToolSpan,
  isoNanos,
  newTraceId,
  newSpanId,
  deterministicSpanId,
  isHaloTracingEnabled,
  haloTracePath,
  _resetHaloSession,
  HALO_SCHEMA_VERSION,
} from '../../src/observability/halo-exporter.js';

describe('halo-exporter', () => {
  beforeEach(() => {
    delete process.env.UAP_HALO_TRACE;
    delete process.env.UAP_HALO_TRACE_PATH;
    delete process.env.UAP_HALO_PROJECT_ID;
    _resetHaloSession();
  });

  describe('id + timestamp helpers', () => {
    it('generates 32-hex trace ids and 16-hex span ids', () => {
      expect(newTraceId()).toMatch(/^[0-9a-f]{32}$/);
      expect(newSpanId()).toMatch(/^[0-9a-f]{16}$/);
    });

    it('derives a stable span id from a seed', () => {
      expect(deterministicSpanId('agent-1')).toBe(deterministicSpanId('agent-1'));
      expect(deterministicSpanId('agent-1')).not.toBe(deterministicSpanId('agent-2'));
      expect(deterministicSpanId('agent-1')).toMatch(/^[0-9a-f]{16}$/);
    });

    it('formats timestamps with nanosecond precision and trailing Z', () => {
      const ts = isoNanos(Date.parse('2026-05-30T22:45:33.123Z'));
      expect(ts).toBe('2026-05-30T22:45:33.123000000Z');
      expect(ts).toMatch(/\.\d{9}Z$/);
    });
  });

  describe('buildHaloSpan', () => {
    it('produces a span with all HALO-required fields', () => {
      const span = buildHaloSpan({
        kind: 'TOOL',
        name: 'tool.github.create_issue',
        startTimeMs: Date.parse('2026-05-30T00:00:00.000Z'),
        endTimeMs: Date.parse('2026-05-30T00:00:01.000Z'),
        ok: true,
        attributes: { 'tool.name': 'github.create_issue' },
      });

      expect(span.trace_id).toMatch(/^[0-9a-f]{32}$/);
      expect(span.span_id).toMatch(/^[0-9a-f]{16}$/);
      expect(span.name).toBe('tool.github.create_issue');
      expect(span.kind).toBe('SPAN_KIND_INTERNAL');
      expect(span.status.code).toBe('STATUS_CODE_OK');
      expect(span.resource.attributes['service.name']).toBe('uap');
      expect(span.attributes['inference.project_id']).toBe('uap');
      expect(span.attributes['inference.observation_kind']).toBe('TOOL');
      expect(span.attributes['inference.export.schema_version']).toBe(HALO_SCHEMA_VERSION);
      expect(span.attributes['openinference.span.kind']).toBe('TOOL');
      expect(span.attributes['tool.name']).toBe('github.create_issue');
    });

    it('maps failure to STATUS_CODE_ERROR and honors parent + project overrides', () => {
      process.env.UAP_HALO_PROJECT_ID = 'my-project';
      const span = buildHaloSpan({
        kind: 'AGENT',
        name: 'agent.security-auditor',
        startTimeMs: 0,
        endTimeMs: 5,
        ok: false,
        parentSpanId: 'abc123def4560000',
      });
      expect(span.status.code).toBe('STATUS_CODE_ERROR');
      expect(span.parent_span_id).toBe('abc123def4560000');
      expect(span.attributes['inference.project_id']).toBe('my-project');
    });

    it('shares one session trace id across spans', () => {
      const a = buildHaloSpan({ kind: 'TOOL', name: 'a', startTimeMs: 0, endTimeMs: 1, ok: true });
      const b = buildHaloSpan({ kind: 'TOOL', name: 'b', startTimeMs: 0, endTimeMs: 1, ok: true });
      expect(a.trace_id).toBe(b.trace_id);
    });
  });

  describe('enable/disable + file output', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'uap-halo-'));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('is a no-op when tracing is explicitly disabled', () => {
      const path = join(dir, 'traces.jsonl');
      process.env.UAP_HALO_TRACE = '0';
      process.env.UAP_HALO_TRACE_PATH = path;
      expect(isHaloTracingEnabled()).toBe(false);
      recordToolSpan('github.create_issue', 0, 1, true);
      expect(existsSync(path)).toBe(false);
    });

    it('is ON by default (unset env) and honors off aliases', () => {
      delete process.env.UAP_HALO_TRACE;
      expect(isHaloTracingEnabled()).toBe(true);
      for (const off of ['0', 'false', 'off']) {
        process.env.UAP_HALO_TRACE = off;
        expect(isHaloTracingEnabled()).toBe(false);
      }
      process.env.UAP_HALO_TRACE = '1';
      expect(isHaloTracingEnabled()).toBe(true);
    });

    it('appends one valid JSONL span per call when enabled', () => {
      const path = join(dir, 'nested', 'traces.jsonl');
      process.env.UAP_HALO_TRACE = '1';
      process.env.UAP_HALO_TRACE_PATH = path;
      expect(isHaloTracingEnabled()).toBe(true);
      expect(haloTracePath()).toBe(path);

      recordToolSpan('github.create_issue', 0, 1, true);
      recordHaloSpan({ kind: 'LLM', name: 'llm.gpt', startTimeMs: 0, endTimeMs: 2, ok: true });

      const lines = readFileSync(path, 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(2);
      const first = JSON.parse(lines[0]);
      expect(first.attributes['inference.observation_kind']).toBe('TOOL');
      expect(first.start_time).toMatch(/\.\d{9}Z$/);
      const second = JSON.parse(lines[1]);
      expect(second.attributes['inference.observation_kind']).toBe('LLM');
    });
  });
});
