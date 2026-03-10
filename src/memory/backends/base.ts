export interface MemoryEntry {
  id: string;
  timestamp: string;
  type: 'action' | 'observation' | 'thought' | 'goal';
  content: string;
  embedding?: number[];
  tags?: string[];
  importance?: number;
  metadata?: Record<string, unknown>;
}

export interface MemoryBackend {
  // Check if backend is properly configured
  isConfigured(): Promise<boolean>;

  // Store a memory with embedding
  store(entry: MemoryEntry): Promise<void>;

  // Query memories by semantic similarity
  query(query: string, limit?: number): Promise<MemoryEntry[]>;

  // Get recent memories
  getRecent(limit?: number): Promise<MemoryEntry[]>;

  // Delete old memories (pruning)
  prune(olderThan: Date): Promise<number>;
}
