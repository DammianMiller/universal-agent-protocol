import { describe, it, expect, beforeEach, vi } from 'vitest';
import { QdrantCloudBackend } from './qdrant-cloud.js';
import type { MemoryEntry } from './base.js';

// Mock QdrantClient
vi.mock('@qdrant/js-client-rest', () => ({
  QdrantClient: vi.fn().mockImplementation(() => ({
    getCollections: vi.fn(),
    getCollection: vi.fn().mockResolvedValue({
      config: { params: { vectors: { size: 384 } } },
    }),
    createCollection: vi.fn(),
    upsert: vi.fn(),
    search: vi.fn(),
    scroll: vi.fn(),
    delete: vi.fn(),
  })),
}));

describe('QdrantCloudBackend', () => {
  let backend: QdrantCloudBackend;
  let mockClient: any;

  beforeEach(() => {
    // Set env vars
    process.env.QDRANT_URL = 'https://test.cloud.qdrant.io:6333';
    process.env.QDRANT_API_KEY = 'test-api-key';
    
    backend = new QdrantCloudBackend({
      url: 'https://test.cloud.qdrant.io:6333',
      apiKey: 'test-api-key',
      collection: 'agent_memory',
      projectId: 'test-project', // Explicit project ID for isolation
    });

    mockClient = (backend as any).client;
  });

  it('should check if configured', async () => {
    mockClient.getCollections.mockResolvedValueOnce({
      collections: [{ name: 'agent_memory' }],
    });

    const isConfigured = await backend.isConfigured();

    expect(isConfigured).toBe(true);
    expect(mockClient.getCollections).toHaveBeenCalled();
  });

  it('should store memory entry with embedding', async () => {
    mockClient.getCollections.mockResolvedValueOnce({
      collections: [{ name: 'agent_memory' }],
    });
    mockClient.upsert.mockResolvedValueOnce({});

    const entry: MemoryEntry = {
      id: 'test-id',
      timestamp: new Date().toISOString(),
      type: 'action',
      content: 'Test memory',
      embedding: new Array(384).fill(0.5),
      tags: ['tag1'],
      importance: 7,
    };

    await backend.store(entry);

    expect(mockClient.upsert).toHaveBeenCalled();

    const call = mockClient.upsert.mock.calls[0];
    // Collection name may be versioned if dimension migration occurred
    expect(call[0]).toMatch(/^agent_memory/);
    expect(call[1].points).toHaveLength(1);
    expect(call[1].points[0].payload.content).toBe('Test memory');
    expect(call[1].points[0].payload.tags).toEqual(['tag1']);
    expect(call[1].points[0].payload.importance).toBe(7);
  });

  it('should query memories with semantic search', async () => {
    const mockResults = [
      {
        id: '1',
        score: 0.95,
        vector: new Array(384).fill(0.5),
        payload: {
          content: 'Test memory',
          type: 'action',
          tags: ['test'],
          importance: 8,
          timestamp: new Date().toISOString(),
        },
      },
      {
        id: '2',
        score: 0.85,
        vector: new Array(384).fill(0.5),
        payload: {
          content: 'Another memory',
          type: 'action',
          tags: ['test'],
          importance: 6,
          timestamp: new Date().toISOString(),
        },
      },
    ];

    mockClient.search.mockResolvedValueOnce(mockResults);

    const results = await backend.query('test query', 10);

    expect(results).toHaveLength(2);
    expect(results[0].id).toBe('1');
    expect(results[0].content).toBe('Test memory');
    // Collection name includes project ID hash for isolation
    expect(mockClient.search).toHaveBeenCalledWith(
      expect.stringMatching(/^agent_memory_test-project_/),
      {
        vector: expect.any(Array),
        limit: 10,
        score_threshold: 0.5,
      }
    );
  });

  it('should get recent memories', async () => {
    mockClient.scroll.mockResolvedValueOnce({
      points: [
        {
          id: '1',
          payload: {
            content: 'Test memory',
            type: 'action',
            tags: ['test'],
            importance: 8,
            timestamp: new Date().toISOString(),
          },
        },
      ],
    });

    const results = await backend.getRecent(50);

    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('Test memory');
    // Collection name includes project ID hash for isolation
    expect(mockClient.scroll).toHaveBeenCalledWith(
      expect.stringMatching(/^agent_memory_test-project_/),
      {
        limit: 50,
        with_payload: true,
        with_vector: false,
      }
    );
  });

  it('should prune old memories', async () => {
    const oldDate = new Date(Date.now() - 1000000);
    
    mockClient.scroll.mockResolvedValueOnce({
      points: [{ id: 'old-1' }, { id: 'old-2' }],
    });
    mockClient.delete.mockResolvedValueOnce({});

    const deleted = await backend.prune(new Date());

    expect(deleted).toBe(2);
    // Collection name includes project ID hash for isolation
    expect(mockClient.delete).toHaveBeenCalledWith(
      expect.stringMatching(/^agent_memory_test-project_/),
      {
        points: ['old-1', 'old-2'],
      }
    );
  });
});
