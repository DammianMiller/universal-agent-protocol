/* eslint-disable @typescript-eslint/no-explicit-any */
import Dexie from 'dexie';
import type { ShortTermMemoryBackend, MemoryType } from './factory.js';

interface ShortTermMemory {
  id?: number;
  timestamp: string;
  type: MemoryType;
  content: string;
  importance?: number;
  projectId?: string;
}

class AgentContextDB extends (Dexie as any) {
  memories: any;

  constructor(dbName: string) {
    super(dbName);
    this.version(2).stores({
      memories: '++id, timestamp, type, projectId, importance',
    });
  }
}

export class IndexedDBShortTermMemory implements ShortTermMemoryBackend {
  private db: AgentContextDB;
  private projectId: string;
  private maxEntries: number;

  constructor(config: { dbName: string; projectId?: string; maxEntries?: number }) {
    this.db = new AgentContextDB(config.dbName);
    this.projectId = config.projectId || 'default';
    this.maxEntries = config.maxEntries || 50;
  }

  async store(type: MemoryType, content: string, importance?: number): Promise<void> {
    await this.db.memories.add({
      timestamp: new Date().toISOString(),
      type,
      content,
      importance: importance ?? 0.5,
      projectId: this.projectId,
    });
    await this.prune();
  }

  async storeBatch(entries: Array<{ type: MemoryType; content: string; timestamp?: string; importance?: number }>): Promise<void> {
    const records = entries.map(e => ({
      timestamp: e.timestamp || new Date().toISOString(),
      type: e.type,
      content: e.content,
      importance: e.importance ?? 0.5,
      projectId: this.projectId,
    }));
    await this.db.memories.bulkAdd(records);
    await this.prune();
  }

  async getRecent(limit = 50): Promise<ShortTermMemory[]> {
    return this.db.memories
      .where('projectId')
      .equals(this.projectId)
      .reverse()
      .limit(limit)
      .toArray();
  }

  async query(searchTerm: string, limit = 10): Promise<ShortTermMemory[]> {
    const all = await this.getRecent(this.maxEntries);
    return all
      .filter((m: ShortTermMemory) => m.content.toLowerCase().includes(searchTerm.toLowerCase()))
      .slice(0, limit);
  }

  private async prune(): Promise<void> {
    const count = await this.db.memories.where('projectId').equals(this.projectId).count();
    if (count > this.maxEntries) {
      const toDelete = count - this.maxEntries;
      // Importance-aware pruning: delete lowest importance first, then oldest
      const all = await this.db.memories
        .where('projectId')
        .equals(this.projectId)
        .toArray();
      all.sort((a: ShortTermMemory, b: ShortTermMemory) => {
        const impA = a.importance ?? 0.5;
        const impB = b.importance ?? 0.5;
        if (impA !== impB) return impA - impB; // lowest importance first
        return (a.id ?? 0) - (b.id ?? 0); // oldest first
      });
      const idsToDelete = all.slice(0, toDelete).map((m: ShortTermMemory) => m.id!);
      await this.db.memories.bulkDelete(idsToDelete);
    }
  }

  async clear(): Promise<void> {
    await this.db.memories.where('projectId').equals(this.projectId).delete();
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}
