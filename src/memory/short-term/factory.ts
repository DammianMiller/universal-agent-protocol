import { IndexedDBShortTermMemory } from './indexeddb.js';
import { SQLiteShortTermMemory } from './sqlite.js';
import type { AgentContextConfig } from '../../types/index.js';

export interface ShortTermMemoryBackend {
  store(type: 'action' | 'observation' | 'thought' | 'goal', content: string, importance?: number): Promise<void>;
  storeBatch?(entries: Array<{ type: 'action' | 'observation' | 'thought' | 'goal'; content: string; timestamp?: string; importance?: number }>): Promise<void>;
  getRecent(limit?: number): Promise<Array<{ timestamp: string; type: string; content: string; importance?: number }>>;
  query(searchTerm: string, limit?: number): Promise<Array<{ timestamp: string; type: string; content: string; importance?: number }>>;
  clear(): Promise<void>;
  close?(): Promise<void>;
}

export async function createShortTermMemory(
  config: AgentContextConfig
): Promise<ShortTermMemoryBackend | null> {
  if (!config.memory?.shortTerm?.enabled) {
    return null;
  }

  const shortTerm = config.memory.shortTerm;

  // Auto-detect environment
  // @ts-ignore - window is available in browser but not in Node.js
  const isWeb = typeof window !== 'undefined' && !shortTerm.forceDesktop;

  if (isWeb) {
    // Use IndexedDB for web environments
    return new IndexedDBShortTermMemory({
      dbName: shortTerm.webDatabase || 'agent_context_memory',
      projectId: config.project.name,
      maxEntries: shortTerm.maxEntries,
    });
  } else {
    // Use SQLite for desktop/CLI environments
    return new SQLiteShortTermMemory({
      dbPath: shortTerm.path || './agents/data/memory/short_term.db',
      projectId: config.project.name,
      maxEntries: shortTerm.maxEntries,
    });
  }
}
