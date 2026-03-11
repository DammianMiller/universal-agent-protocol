/* eslint-disable @typescript-eslint/no-explicit-any */
import Dexie from 'dexie';

interface ShortTermMemory {
  id?: number;
  timestamp: string;
  type: 'action' | 'observation' | 'thought' | 'goal';
  content: string;
  projectId?: string; // Key by project/repo URL
}

class AgentContextDB extends (Dexie as any) {
  memories: any;

  constructor(dbName: string) {
    super(dbName);
    this.version(1).stores({
      memories: '++id, timestamp, type, projectId',
    });
  }
}

export class IndexedDBShortTermMemory {
  private db: AgentContextDB;
  private projectId: string;
  private maxEntries: number;

  constructor(config: { dbName: string; projectId?: string; maxEntries?: number }) {
    this.db = new AgentContextDB(config.dbName);
    this.projectId = config.projectId || 'default';
    this.maxEntries = config.maxEntries || 50;
  }

  async store(type: ShortTermMemory['type'], content: string, _importance?: number): Promise<void> {
    await this.db.memories.add({
      timestamp: new Date().toISOString(),
      type,
      content,
      projectId: this.projectId,
    });
    // Auto-prune if exceeds maxEntries
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
      .filter((m) => m.content.toLowerCase().includes(searchTerm.toLowerCase()))
      .slice(0, limit);
  }

  private async prune(): Promise<void> {
    const count = await this.db.memories.where('projectId').equals(this.projectId).count();
    if (count > this.maxEntries) {
      const toDelete = count - this.maxEntries;
      const oldest = await this.db.memories
        .where('projectId')
        .equals(this.projectId)
        .limit(toDelete)
        .toArray();
      await this.db.memories.bulkDelete(oldest.map((m: any) => m.id!));
    }
  }

  async clear(): Promise<void> {
    await this.db.memories.where('projectId').equals(this.projectId).delete();
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}
