import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IndexedDBShortTermMemory } from './indexeddb.js';

describe('IndexedDBShortTermMemory', () => {
  let memory: IndexedDBShortTermMemory;
  const projectId = 'test-project';

  beforeEach(async () => {
    // Clear IndexedDB before each test
    const dbs = await indexedDB.databases();
    for (const db of dbs) {
      if (db.name) {
        indexedDB.deleteDatabase(db.name);
      }
    }
    
    memory = new IndexedDBShortTermMemory({
      dbName: 'agentContext',
      projectId,
      maxEntries: 5,
    });
  });

  it('should initialize database successfully', () => {
    expect(memory).toBeDefined();
  });

  it('should store memory entries', async () => {
    await memory.store('action', 'Test action');
    
    const memories = await memory.getRecent(10);
    expect(memories).toHaveLength(1);
    expect(memories[0].content).toBe('Test action');
  });

  it('should retrieve recent memories', async () => {
    await memory.store('action', 'Action 1');
    await memory.store('observation', 'Observation 1');
    await memory.store('thought', 'Thought 1');

    const recent = await memory.getRecent(2);
    expect(recent).toHaveLength(2);
    expect(recent[0].content).toBe('Thought 1'); // Most recent first
    expect(recent[1].content).toBe('Observation 1');
  });

  it('should isolate memories by project', async () => {
    const memory2 = new IndexedDBShortTermMemory({
      dbName: 'agentContext',
      projectId: 'other-project',
      maxEntries: 5,
    });

    await memory.store('action', 'Project 1 action');
    await memory2.store('action', 'Project 2 action');

    const project1Memories = await memory.getRecent(10);
    const project2Memories = await memory2.getRecent(10);

    expect(project1Memories).toHaveLength(1);
    expect(project2Memories).toHaveLength(1);
    expect(project1Memories[0].content).toBe('Project 1 action');
    expect(project2Memories[0].content).toBe('Project 2 action');
  });

  it('should auto-prune when exceeding max entries', async () => {
    // Add 7 entries when max is 5
    for (let i = 1; i <= 7; i++) {
      await memory.store('action', `Action ${i}`);
    }

    const allMemories = await memory.getRecent(10);
    expect(allMemories).toHaveLength(5);
    
    // Should keep most recent 5
    expect(allMemories[0].content).toBe('Action 7');
    expect(allMemories[4].content).toBe('Action 3');
  });

  it('should clear all memories for project', async () => {
    await memory.store('action', 'Action 1');
    await memory.store('action', 'Action 2');

    await memory.clear();

    const memories = await memory.getRecent(10);
    expect(memories).toHaveLength(0);
  });

  it('should handle different memory types', async () => {
    await memory.store('action', 'Action');
    await memory.store('observation', 'Observation');
    await memory.store('thought', 'Thought');
    await memory.store('goal', 'Goal');

    const memories = await memory.getRecent(10);
    expect(memories).toHaveLength(4);

    const types = memories.map(m => m.type);
    expect(types).toContain('action');
    expect(types).toContain('observation');
    expect(types).toContain('thought');
    expect(types).toContain('goal');
  });

  it('should store timestamps correctly', async () => {
    const beforeAdd = new Date();
    await memory.store('action', 'Test');
    const afterAdd = new Date();

    const memories = await memory.getRecent(1);
    const timestamp = new Date(memories[0].timestamp);

    expect(timestamp.getTime()).toBeGreaterThanOrEqual(beforeAdd.getTime());
    expect(timestamp.getTime()).toBeLessThanOrEqual(afterAdd.getTime());
  });
});
