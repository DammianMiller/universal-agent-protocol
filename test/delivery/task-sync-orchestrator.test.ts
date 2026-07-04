/**
 * Durable publish of orchestrator task outcomes (P3/P4). A completed task's
 * verified interface is written to short-term memory so later tasks and future
 * fresh sessions retrieve it. The write is fail-soft and never scaffolds a
 * memory DB into a target repo that doesn't already have one.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordOrchestratorTaskOutcome } from '../../src/delivery/task-sync.js';

describe('recordOrchestratorTaskOutcome', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-orch-pub-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('is a no-op (no throw, no scaffold) when the project has no memory DB', async () => {
    await expect(
      recordOrchestratorTaskOutcome('store', 'Event store', 'class Store { append() }', dir)
    ).resolves.toBeUndefined();
    // must NOT have created a memory DB in the target repo
    expect(existsSync(join(dir, 'agents', 'data', 'memory', 'short_term.db'))).toBe(false);
  });

  it('writes a decision memory when a short-term DB exists', async () => {
    const memDir = join(dir, 'agents', 'data', 'memory');
    mkdirSync(memDir, { recursive: true });
    const { SQLiteShortTermMemory } = await import('../../src/memory/short-term/sqlite.js');
    const dbPath = join(memDir, 'short_term.db');
    const seed = new SQLiteShortTermMemory({ dbPath });
    await seed.close?.();

    await recordOrchestratorTaskOutcome('store', 'Event store', 'class Store { append(): void }', dir);

    const mem = new SQLiteShortTermMemory({ dbPath });
    const recent = await mem.getRecent(20);
    await mem.close?.();
    const hit = recent.find((m: { content: string }) => m.content.includes("task 'store'"));
    expect(hit).toBeTruthy();
    expect(hit!.content).toContain('interface:');
  });
});
