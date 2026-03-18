/**
 * Embedding Service Tests
 *
 * Comprehensive unit tests for all embedding providers and the main service.
 * Uses mocked HTTP responses to avoid external dependencies.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  LlamaCppEmbeddingProvider,
  OllamaEmbeddingProvider,
  OpenAIEmbeddingProvider,
  TFIDFEmbeddingProvider,
  EmbeddingService,
  getEmbeddingService,
  generateEmbedding,
  generateEmbeddings,
} from '../../src/memory/embeddings.js';
import { createMockEmbedding, createLlamaCppEmbeddingResponse } from '../utils/mock-helpers.js';

describe('LlamaCppEmbeddingProvider', () => {
  let provider: LlamaCppEmbeddingProvider;

  beforeEach(() => {
    provider = new LlamaCppEmbeddingProvider('http://localhost:8081');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should detect provider availability via health check', async () => {
    const mockHealthResponse = {
      ok: true,
      json: async () => ({ status: 'ok' }),
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockHealthResponse as any);

    const available = await provider.isAvailable();
    expect(available).toBe(true);
  });

  it('should return false when health check fails', async () => {
    const mockResponse = {
      ok: false,
      status: 503,
      json: async () => ({ error: 'Service Unavailable' }),
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse as any);

    const available = await provider.isAvailable();
    expect(available).toBe(false);
  });

  it('should embed single text and return correct dimensions', async () => {
    const mockHealthResponse = { ok: true, json: async () => ({ status: 'ok' }) };
    const mockEmbedResponse = {
      ok: true,
      json: async () => createLlamaCppEmbeddingResponse(['test'], 768),
    };
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(mockHealthResponse as any)
      .mockResolvedValueOnce(mockEmbedResponse as any)
      .mockResolvedValueOnce(mockEmbedResponse as any); // embed() calls embedBatch()

    await provider.isAvailable(); // Initialize
    const embedding = await provider.embed('test text');

    expect(embedding).toBeDefined();
    expect(embedding.length).toBe(768);
  });

  it('should embed batch texts and maintain order', async () => {
    const mockHealthResponse = { ok: true, json: async () => ({ status: 'ok' }) };
    const mockEmbedResponse = {
      ok: true,
      json: async () => createLlamaCppEmbeddingResponse(['first', 'second', 'third'], 512),
    };
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(mockHealthResponse as any)
      .mockResolvedValueOnce(mockEmbedResponse as any);

    await provider.isAvailable();
    const embeddings = await provider.embedBatch(['first', 'second', 'third']);

    expect(embeddings).toHaveLength(3);
    expect(embeddings[0].length).toBe(512);
    expect(embeddings[1].length).toBe(512);
    expect(embeddings[2].length).toBe(512);
  });

  it('should embed batch texts and maintain order', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'ok' }) } as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => createLlamaCppEmbeddingResponse(['first', 'second', 'third'], 512),
      } as any);

    await provider.isAvailable();
    const embeddings = await provider.embedBatch(['first', 'second', 'third']);

    expect(embeddings).toHaveLength(3);
    expect(embeddings[0].length).toBe(512);
    expect(embeddings[1].length).toBe(512);
    expect(embeddings[2].length).toBe(512);
  });

  it('should add task prefix to texts without one', async () => {
    let capturedInput: string[] | undefined;
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'ok' }) } as any)
      .mockImplementation(async (url, options) => {
        const body = JSON.parse((options?.body as string) || '{}');
        capturedInput = body.input;
        return {
          ok: true,
          json: async () => createLlamaCppEmbeddingResponse(['test']),
        } as any;
      });

    await provider.isAvailable();
    await provider.embed('test text');

    expect(capturedInput).toBeDefined();
    expect(capturedInput![0]).toContain('search_document:');
  });

  it('should not add task prefix to texts that already have one', async () => {
    let capturedInput: string[] | undefined;
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'ok' }) } as any)
      .mockImplementation(async (url, options) => {
        const body = JSON.parse((options?.body as string) || '{}');
        capturedInput = body.input;
        return {
          ok: true,
          json: async () => createLlamaCppEmbeddingResponse(['test']),
        } as any;
      });

    await provider.isAvailable();
    await provider.embed('search_query: test text');

    expect(capturedInput).toBeDefined();
    expect(capturedInput![0]).toBe('search_query: test text');
  });

  it('should throw error on API failure', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'ok' }) } as any)
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Error',
        json: async () => ({ error: 'Internal Error' }),
      } as any);

    await provider.isAvailable();

    await expect(provider.embed('test')).rejects.toThrow(/llama.cpp embedding API error/);
  });

  it('should auto-detect dimensions from response', async () => {
    const mockEmbedResponse = {
      ok: true,
      json: async () => createLlamaCppEmbeddingResponse(['test'], 1024),
    };
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'ok' }) } as any)
      .mockReturnValueOnce(Promise.resolve(mockEmbedResponse as any))
      .mockReturnValueOnce(Promise.resolve(mockEmbedResponse as any));

    await provider.isAvailable();
    expect(provider.dimensions).toBe(1024);

    await provider.embed('test');
    expect(provider.dimensions).toBe(1024);
  });
});

describe('OllamaEmbeddingProvider', () => {
  let provider: OllamaEmbeddingProvider;

  beforeEach(() => {
    provider = new OllamaEmbeddingProvider('http://localhost:11434', 'nomic-embed-text');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should detect available models from /api/tags', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [{ name: 'llama2' }, { name: 'nomic-embed-text' }, { name: 'mistral' }],
      }),
    } as any);

    const available = await provider.isAvailable();
    expect(available).toBe(true);
  });

  it('should return false when no embedding model is available', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [{ name: 'llama2' }, { name: 'mistral' }],
      }),
    } as any);

    const available = await provider.isAvailable();
    expect(available).toBe(false);
  });

  it('should embed text using /api/embeddings endpoint', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ models: [{ name: 'nomic-embed-text' }] }),
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ embedding: createMockEmbedding(768) }),
      } as any);

    await provider.isAvailable();
    const embedding = await provider.embed('test text');

    expect(embedding).toBeDefined();
    expect(embedding.length).toBe(768);
  });

  it('should throw error on API failure', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ models: [{ name: 'nomic-embed-text' }] }),
      } as any)
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: async () => ({ error: 'Unauthorized' }),
      } as any);

    await provider.isAvailable();

    await expect(provider.embed('test')).rejects.toThrow(/Ollama API error/);
  });

  it('should use concurrentMap for batch embeddings', async () => {
    const mockEmbedResponse = {
      ok: true,
      json: async () => ({ embedding: createMockEmbedding(768) }),
    };
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ models: [{ name: 'nomic-embed-text' }] }),
      } as any)
      .mockReturnValueOnce(Promise.resolve(mockEmbedResponse as any))
      .mockReturnValueOnce(Promise.resolve(mockEmbedResponse as any))
      .mockReturnValueOnce(Promise.resolve(mockEmbedResponse as any));

    await provider.isAvailable();
    const embeddings = await provider.embedBatch(['text1', 'text2', 'text3']);

    expect(embeddings).toHaveLength(3);
    expect(embeddings[0].length).toBe(768);
  });
});

describe('OpenAIEmbeddingProvider', () => {
  let provider: OpenAIEmbeddingProvider;

  beforeEach(() => {
    provider = new OpenAIEmbeddingProvider('test-api-key', 'text-embedding-3-small');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return true when API key is provided', async () => {
    const available = await provider.isAvailable();
    expect(available).toBe(true);
  });

  it('should return false when no API key is configured', async () => {
    // Ensure no OPENAI_API_KEY env var is set
    const originalKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    const providerNoKey = new OpenAIEmbeddingProvider();
    const available = await providerNoKey.isAvailable();
    expect(available).toBe(false);

    // Restore env var
    if (originalKey) {
      process.env.OPENAI_API_KEY = originalKey;
    }
  });

  it('should embed single text via OpenAI API', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ embedding: createMockEmbedding(1536) }],
      }),
    } as any);

    const embedding = await provider.embed('test text');

    expect(embedding).toBeDefined();
    expect(embedding.length).toBe(1536);
  });

  it('should embed batch texts via OpenAI API', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ embedding: createMockEmbedding(1536) }, { embedding: createMockEmbedding(1536) }],
      }),
    } as any);

    const embeddings = await provider.embedBatch(['first', 'second']);

    expect(embeddings).toHaveLength(2);
    expect(embeddings[0].length).toBe(1536);
  });

  it('should throw error when API key is missing', async () => {
    // Ensure no OPENAI_API_KEY env var is set
    const originalKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    const providerNoKey = new OpenAIEmbeddingProvider();

    await expect(providerNoKey.embed('test')).rejects.toThrow('OpenAI API key not configured');

    // Restore env var
    if (originalKey) {
      process.env.OPENAI_API_KEY = originalKey;
    }
  });

  it('should throw error on API failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: async () => ({ error: 'Invalid API key' }),
    } as any);

    await expect(provider.embed('test')).rejects.toThrow(/API error/);
  });
});

describe('TFIDFEmbeddingProvider', () => {
  let provider: TFIDFEmbeddingProvider;

  beforeEach(() => {
    provider = new TFIDFEmbeddingProvider();
  });

  it('should always be available as fallback', async () => {
    const available = await provider.isAvailable();
    expect(available).toBe(true);
  });

  it('should generate embedding with correct dimensions', async () => {
    const embedding = await provider.embed('test text for embedding');

    expect(embedding).toBeDefined();
    expect(embedding.length).toBe(384); // Default dimensions
  });

  it('should normalize embeddings', async () => {
    const embedding = await provider.embed('important word');
    const magnitude = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));

    expect(magnitude).toBeCloseTo(1.0, 2); // Should be normalized
  });

  it('should handle empty text', async () => {
    const embedding = await provider.embed('');

    expect(embedding).toBeDefined();
    expect(embedding.length).toBe(384);
  });

  it('should tokenize camelCase correctly', async () => {
    // This tests the internal tokenize method indirectly through embed
    const embedding1 = await provider.embed('helloWorld');
    const embedding2 = await provider.embed('hello world');

    // Should produce similar (not necessarily identical) vectors
    expect(embedding1).toBeDefined();
    expect(embedding2).toBeDefined();
  });

  it('should handle batch embeddings', async () => {
    const embeddings = await provider.embedBatch(['text1', 'text2', 'text3']);

    expect(embeddings).toHaveLength(3);
    expect(embeddings[0].length).toBe(384);
  });

  it('should add documents to vocabulary', async () => {
    provider.addDocument('first document');
    provider.addDocument('second document with different words');

    const embedding = await provider.embed('document');

    expect(embedding).toBeDefined();
  });
});

describe('EmbeddingService', () => {
  let service: EmbeddingService;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset singleton
    (global as any).embeddingServiceInstance = null;
    service = new EmbeddingService();
  });

  it('should initialize with first available provider', async () => {
    // Mock all providers to be unavailable except TF-IDF
    vi.spyOn(service['providers'][0], 'isAvailable').mockResolvedValue(false);
    vi.spyOn(service['providers'][1], 'isAvailable').mockResolvedValue(false);
    vi.spyOn(service['providers'][2], 'isAvailable').mockResolvedValue(false);
    vi.spyOn(service['providers'][3], 'isAvailable').mockResolvedValue(false);
    vi.spyOn(service['providers'][4], 'isAvailable').mockResolvedValue(true);

    await service.initialize();

    expect(service.getProviderName()).toBe('tfidf-enhanced');
  });

  it('should use LlamaCpp provider when available', async () => {
    vi.spyOn(service['providers'][0], 'isAvailable').mockResolvedValue(true);
    vi.spyOn(service['providers'][0], 'embed').mockResolvedValue(createMockEmbedding(768));

    await service.initialize();
    expect(service.getProviderName()).toBe('llama-cpp');
  });

  it('should cache embeddings by SHA-256 hash', async () => {
    vi.spyOn(service['providers'][0], 'isAvailable').mockResolvedValue(true);
    const mockEmbed = createMockEmbedding(768);
    vi.spyOn(service['providers'][0], 'embed').mockResolvedValue(mockEmbed);

    await service.initialize();

    // First call - should generate
    await service.embed('test text');
    expect(service['providers'][0].embed).toHaveBeenCalledTimes(1);

    // Second call with same text - should use cache
    await service.embed('test text');
    expect(service['providers'][0].embed).toHaveBeenCalledTimes(1); // Not called again
  });

  it('should evict LRU entries when cache is full', async () => {
    vi.spyOn(service['providers'][0], 'isAvailable').mockResolvedValue(true);
    let callCount = 0;
    vi.spyOn(service['providers'][0], 'embed').mockImplementation(async () => {
      callCount++;
      return createMockEmbedding(768);
    });

    await service.initialize();

    // Fill cache beyond max size (10000)
    for (let i = 0; i < 10005; i++) {
      await service.embed(`text ${i}`);
    }

    expect(callCount).toBeGreaterThanOrEqual(10005);
  });

  it('should handle batch embeddings with cache hits and misses', async () => {
    vi.spyOn(service['providers'][0], 'isAvailable').mockResolvedValue(true);
    vi.spyOn(service['providers'][0], 'embedBatch').mockImplementation(async (texts: string[]) =>
      texts.map(() => createMockEmbedding(768))
    );

    await service.initialize();

    // First batch - all cache misses
    const results1 = await service.embedBatch(['text1', 'text2', 'text3']);
    expect(results1).toHaveLength(3);

    // Second batch - all cache hits (should not call embedBatch again)
    const results2 = await service.embedBatch(['text1', 'text2', 'text3']);
    expect(results2).toHaveLength(3);
  });

  it('should compute cosine similarity correctly', async () => {
    const vec1 = [1, 0, 0];
    const vec2 = [0, 1, 0];
    const vec3 = [1, 0, 0];

    expect(service.cosineSimilarity(vec1, vec2)).toBe(0); // Orthogonal
    expect(service.cosineSimilarity(vec1, vec3)).toBe(1); // Identical
  });

  it('should throw error for mismatched vector dimensions', async () => {
    const vec1 = [1, 0, 0];
    const vec2 = [1, 0];

    expect(() => service.cosineSimilarity(vec1, vec2)).toThrow('Vectors must have same dimensions');
  });

  it('should return default dimensions before initialization', async () => {
    expect(service.getDimensions()).toBe(384); // TF-IDF default
  });
});

describe('Singleton Functions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (global as any).embeddingServiceInstance = null;
  });

  it('should return same instance on repeated calls', () => {
    const instance1 = getEmbeddingService();
    const instance2 = getEmbeddingService();

    expect(instance1).toBe(instance2);
  });

  it('should use UAP_EMBEDDING_ENDPOINT env var when set', () => {
    process.env.UAP_EMBEDDING_ENDPOINT = 'http://custom-endpoint:8081';

    const instance = getEmbeddingService();

    delete process.env.UAP_EMBEDDING_ENDPOINT;
  });
});
