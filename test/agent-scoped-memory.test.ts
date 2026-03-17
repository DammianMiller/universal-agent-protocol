import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentScopedMemory } from '../src/memory/agent-scoped-memory.js';
import { existsSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';

const TEST_DB = join(process.cwd(), 'test/fixtures/test-agent-scoped.db');

describe('AgentScopedMemory', () => {
  let mem: AgentScopedMemory;

  beforeEach(() => {
    const dir = join(process.cwd(), 'test/fixtures');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    mem = new AgentScopedMemory(TEST_DB);
  });

  afterEach(() => {
    mem.close();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  });

  it('stores agent-scoped memories', () => {
    const id = mem.store('agent-a', 'Agent A observation', 'observation', 5);
    expect(id).toBeGreaterThan(0);

    const entries = mem.getForAgent('agent-a');
    expect(entries.length).toBe(1);
    expect(entries[0].content).toBe('Agent A observation');
    expect(entries[0].agentId).toBe('agent-a');
  });

  it('isolates memories between agents', () => {
    mem.store('agent-a', 'A private memory');
    mem.store('agent-b', 'B private memory');

    const aEntries = mem.getForAgent('agent-a');
    const bEntries = mem.getForAgent('agent-b');

    expect(aEntries.length).toBe(1);
    expect(bEntries.length).toBe(1);
    expect(aEntries[0].content).not.toBe(bEntries[0].content);
  });

  it('shares memories across agents when promoted', () => {
    const id = mem.store('agent-a', 'Shared discovery');
    mem.share(id);

    // Agent B can now see the shared entry
    const bEntries = mem.getForAgent('agent-b');
    expect(bEntries.length).toBe(1);
    expect(bEntries[0].content).toBe('Shared discovery');
    expect(bEntries[0].shared).toBe(1);
  });

  it('unshares memories', () => {
    const id = mem.store('agent-a', 'Temporarily shared');
    mem.share(id);

    let bEntries = mem.getForAgent('agent-b');
    expect(bEntries.length).toBe(1);

    mem.unshare(id);
    bEntries = mem.getForAgent('agent-b');
    expect(bEntries.length).toBe(0);
  });

  it('queries within agent scope', () => {
    mem.store('agent-a', 'TypeScript migration plan');
    mem.store('agent-b', 'TypeScript linting rules');

    const results = mem.query('agent-a', 'TypeScript');
    expect(results.length).toBe(1);
    expect(results[0].agentId).toBe('agent-a');
  });

  it('queries include shared entries from other agents', () => {
    mem.store('agent-a', 'TypeScript migration plan');
    const sharedId = mem.store('agent-b', 'TypeScript linting rules');
    mem.share(sharedId);

    const results = mem.query('agent-a', 'TypeScript');
    expect(results.length).toBe(2);
  });

  it('returns partition statistics', () => {
    mem.store('agent-a', 'Entry 1');
    mem.store('agent-a', 'Entry 2');
    mem.store('agent-b', 'Entry 3');

    const partitions = mem.getPartitions();
    expect(partitions.length).toBe(2);

    const agentA = partitions.find(p => p.agentId === 'agent-a');
    expect(agentA?.entryCount).toBe(2);
  });

  it('clears all memories for a specific agent', () => {
    mem.store('agent-a', 'To be deleted 1');
    mem.store('agent-a', 'To be deleted 2');
    mem.store('agent-b', 'Keep this');

    const deleted = mem.clearAgent('agent-a');
    expect(deleted).toBe(2);

    expect(mem.countForAgent('agent-a')).toBe(0);
    expect(mem.countForAgent('agent-b')).toBe(1);
  });
});
