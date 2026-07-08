/**
 * The dashboard "Live Events" feed was permanently empty: the DashboardEventBus
 * is a per-process singleton whose emitters run in the mcp-router/executor
 * processes, while the feed is served by the separate `uap dash serve` process.
 *
 * The fix persists every emitted event to telemetry.db (dashboard_events) and
 * has the server read it back cross-process. These tests cover that store, plus
 * the related fix where an expert-droid consultation was mis-recorded as a
 * `raw == context` (0%-savings) compression sample and the compression savings
 * row now reads the persisted store instead of the empty in-process singleton.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  persistEvent,
  readEventsSince,
  readRecentEvents,
  persistCompressionSample,
  closeTelemetryStores,
} from '../src/utils/telemetry-store.js';
import { getSavingsByInfluence } from '../src/dashboard/savings.js';

describe('telemetry-store — cross-process dashboard events', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-events-'));
  });
  afterEach(() => {
    closeTelemetryStores(dir);
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns no events before anything is persisted', () => {
    expect(readEventsSince(dir, 0)).toEqual([]);
    expect(readRecentEvents(dir)).toEqual([]);
  });

  it('persists an event and reads it back with parsed metadata (the cross-process path)', () => {
    const id = persistEvent(dir, {
      category: 'agent',
      type: 'tool',
      severity: 'success',
      title: 'read_file',
      detail: 'fs · 512b',
      metadata: { tool: 'fs/read_file', server: 'fs' },
    });
    expect(id).toBe(1);
    const events = readEventsSince(dir, 0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: 1,
      category: 'agent',
      type: 'tool',
      severity: 'success',
      title: 'read_file',
      detail: 'fs · 512b',
      metadata: { tool: 'fs/read_file', server: 'fs' },
    });
    expect(typeof events[0].timestamp).toBe('string');
  });

  it('readEventsSince(afterId) only returns strictly newer rows (incremental SSE poll)', () => {
    const id1 = persistEvent(dir, { category: 'deploy', type: 'queue', severity: 'info', title: 'a' });
    const id2 = persistEvent(dir, { category: 'deploy', type: 'flush', severity: 'info', title: 'b' });
    persistEvent(dir, { category: 'policy', type: 'block', severity: 'error', title: 'c' });
    const fresh = readEventsSince(dir, id1);
    expect(fresh.map((e) => e.id)).toEqual([id2, id2 + 1]);
    // Nothing newer than the last id.
    expect(readEventsSince(dir, id2 + 1)).toEqual([]);
  });

  it('readRecentEvents returns the tail in chronological (ascending id) order', () => {
    for (let i = 0; i < 5; i++) {
      persistEvent(dir, { category: 'system', type: 'info', severity: 'info', title: `e${i}` });
    }
    const recent = readRecentEvents(dir, 3);
    expect(recent.map((e) => e.title)).toEqual(['e2', 'e3', 'e4']);
  });

  it('is fail-open: bad metadata never throws, event still round-trips', () => {
    const id = persistEvent(dir, { category: 'system', type: 'info', severity: 'info', title: 'ok' });
    expect(id).toBeGreaterThan(0);
    expect(readRecentEvents(dir)[0].metadata).toBeUndefined();
  });
});

describe('savings — context compression reads the persisted store cross-process', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-sav-'));
  });
  afterEach(() => {
    closeTelemetryStores(dir);
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports the compression row as measured with real savings (not the empty singleton 0%)', () => {
    // A genuine compression sample: 8000 raw -> 2000 context = 75% saved.
    persistCompressionSample(dir, 'read_file', 8000, 2000);
    const comp = getSavingsByInfluence(dir).influences.find(
      (i) => i.influence === 'Context compression'
    );
    expect(comp).toBeDefined();
    expect(comp!.quality).toBe('measured');
    expect(comp!.tokensSaved).toBeGreaterThan(0);
    expect(comp!.detail).toContain('75%');
  });

  it('a raw == context sample (the old droid mis-record) yields 0% and stays unmeasured', () => {
    // This is exactly what execute.ts used to write for an expert consultation.
    persistCompressionSample(dir, 'expert/critic', 8395, 8395);
    const comp = getSavingsByInfluence(dir).influences.find(
      (i) => i.influence === 'Context compression'
    );
    expect(comp!.quality).toBe('unmeasured');
    expect(comp!.tokensSaved).toBe(0);
  });
});
