/**
 * Embedding Service for UAM Memory System
 * 
 * Provides text embedding generation for semantic memory retrieval.
 * Supports multiple backends: Ollama (local), OpenAI, local transformers, or simple TF-IDF fallback.
 * 
 * Priority order:
 * 1. Ollama (if running with nomic-embed-text or similar)
 * 2. OpenAI (if API key available)
 * 3. Local sentence-transformers (if installed)
 * 4. TF-IDF fallback (always available)
 */

import { execSync } from 'child_process';

export interface EmbeddingProvider {
  name: string;
  dimensions: number;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  isAvailable(): Promise<boolean>;
}

/**
 * Ollama Embeddings Provider (LOCAL - NO API COSTS)
 * Uses nomic-embed-text (768 dimensions) or other embedding models
 */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  name = 'ollama';
  dimensions = 768; // nomic-embed-text default
  private endpoint: string;
  private model: string;
  private available: boolean | null = null;

  constructor(endpoint: string = 'http://localhost:11434', model: string = 'nomic-embed-text') {
    this.endpoint = endpoint;
    this.model = model;
  }

  async isAvailable(): Promise<boolean> {
    if (this.available !== null) return this.available;
    
    try {
      const response = await fetch(`${this.endpoint}/api/tags`, {
        method: 'GET',
        signal: AbortSignal.timeout(2000),
      });
      
      if (!response.ok) {
        this.available = false;
        return false;
      }
      
      const data = await response.json() as { models: Array<{ name: string }> };
      const hasEmbedModel = data.models?.some(m => 
        m.name.includes('embed') || 
        m.name.includes('nomic') ||
        m.name === this.model ||
        m.name.startsWith(this.model)
      );
      
      this.available = hasEmbedModel;
      return hasEmbedModel;
    } catch {
      this.available = false;
      return false;
    }
  }

  async embed(text: string): Promise<number[]> {
    const response = await fetch(`${this.endpoint}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        prompt: text,
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as { embedding: number[] };
    this.dimensions = data.embedding.length; // Update dimensions from actual response
    return data.embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    // Ollama doesn't have native batch, but we can parallelize
    const results = await Promise.all(texts.map(t => this.embed(t)));
    return results;
  }
}

/**
 * OpenAI Embeddings Provider
 * Uses text-embedding-3-small (1536 dimensions) or text-embedding-ada-002
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  name = 'openai';
  dimensions = 1536;
  private apiKey: string;
  private model: string;

  constructor(apiKey?: string, model: string = 'text-embedding-3-small') {
    this.apiKey = apiKey || process.env.OPENAI_API_KEY || '';
    this.model = model;
  }

  async isAvailable(): Promise<boolean> {
    return !!this.apiKey;
  }

  async embed(text: string): Promise<number[]> {
    const results = await this.embedBatch([text]);
    return results[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!this.apiKey) {
      throw new Error('OpenAI API key not configured');
    }

    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as { data: Array<{ embedding: number[] }> };
    return data.data.map(d => d.embedding);
  }
}

/**
 * Local Sentence Transformers Provider
 * Uses Python sentence-transformers library for local embedding generation
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  name = 'local';
  dimensions = 384;
  private model: string;
  private pythonPath: string;

  constructor(model: string = 'all-MiniLM-L6-v2', pythonPath: string = 'python3') {
    this.model = model;
    this.pythonPath = pythonPath;
  }

  async isAvailable(): Promise<boolean> {
    try {
      execSync(`${this.pythonPath} -c "from sentence_transformers import SentenceTransformer"`, {
        stdio: 'pipe',
        timeout: 10000,
      });
      return true;
    } catch {
      return false;
    }
  }

  async embed(text: string): Promise<number[]> {
    const results = await this.embedBatch([text]);
    return results[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const escapedTexts = JSON.stringify(texts);
    const script = `
import json
import sys
from sentence_transformers import SentenceTransformer

model = SentenceTransformer('${this.model}')
texts = json.loads('''${escapedTexts}''')
embeddings = model.encode(texts, convert_to_numpy=True)
print(json.dumps(embeddings.tolist()))
`;

    try {
      const result = execSync(`${this.pythonPath} -c "${script.replace(/"/g, '\\"')}"`, {
        encoding: 'utf-8',
        timeout: 60000,
        maxBuffer: 50 * 1024 * 1024,
      });
      return JSON.parse(result.trim());
    } catch (error) {
      throw new Error(`Local embedding generation failed: ${error}`);
    }
  }
}

/**
 * Enhanced TF-IDF Fallback Provider with Word Vectors
 * Improved keyword-based embeddings with semantic awareness
 */
export class TFIDFEmbeddingProvider implements EmbeddingProvider {
  name = 'tfidf-enhanced';
  dimensions = 384;
  private vocabulary: Map<string, number> = new Map();
  private idfScores: Map<string, number> = new Map();
  private documents: string[] = [];
  private wordVectors: Map<string, number[]> = new Map();

  constructor() {
    // Initialize semantic word clusters for better similarity
    this.initializeSemanticClusters();
  }

  async isAvailable(): Promise<boolean> {
    return true; // Always available as fallback
  }

  async embed(text: string): Promise<number[]> {
    const tokens = this.tokenize(text);
    const vector = new Array(this.dimensions).fill(0);
    
    // Combine TF-IDF with semantic clustering
    for (const token of tokens) {
      const idx = this.getTokenIndex(token);
      const tf = tokens.filter(t => t === token).length / tokens.length;
      const idf = this.idfScores.get(token) || Math.log(this.documents.length + 2);
      
      // Base TF-IDF contribution
      vector[idx % this.dimensions] += tf * idf;
      
      // Add semantic cluster contribution
      const wordVec = this.wordVectors.get(token);
      if (wordVec) {
        for (let i = 0; i < wordVec.length; i++) {
          vector[i] += wordVec[i] * tf * 0.3; // Weighted semantic contribution
        }
      }
    }

    // Add n-gram features for better phrase matching
    const bigrams = this.getBigrams(tokens);
    for (const bigram of bigrams) {
      const idx = this.hashString(bigram) % this.dimensions;
      vector[idx] += 0.5;
    }

    return this.normalize(vector);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    // Update IDF scores with new documents
    this.updateIDF(texts);
    return Promise.all(texts.map(t => this.embed(t)));
  }

  addDocument(text: string): void {
    this.documents.push(text);
    this.updateIDF([text]);
  }

  private tokenize(text: string): string[] {
    // Enhanced tokenization that handles code better
    return text.toLowerCase()
      .replace(/([a-z])([A-Z])/g, '$1 $2') // Split camelCase
      .replace(/_/g, ' ') // Split snake_case
      .replace(/[^\w\s-]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1 && !this.isStopWord(t));
  }

  private isStopWord(token: string): boolean {
    const stopWords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
      'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
      'would', 'could', 'should', 'may', 'might', 'must', 'shall',
      'can', 'need', 'dare', 'ought', 'used', 'to', 'of', 'in',
      'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into',
      'through', 'during', 'before', 'after', 'above', 'below',
      'between', 'under', 'again', 'further', 'then', 'once',
      'here', 'there', 'when', 'where', 'why', 'how', 'all',
      'each', 'few', 'more', 'most', 'other', 'some', 'such',
      'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than',
      'too', 'very', 'just', 'and', 'but', 'if', 'or', 'because',
      'until', 'while', 'this', 'that', 'these', 'those', 'it',
    ]);
    return stopWords.has(token);
  }

  private getBigrams(tokens: string[]): string[] {
    const bigrams: string[] = [];
    for (let i = 0; i < tokens.length - 1; i++) {
      bigrams.push(`${tokens[i]}_${tokens[i + 1]}`);
    }
    return bigrams;
  }

  private hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash);
  }

  private getTokenIndex(token: string): number {
    if (!this.vocabulary.has(token)) {
      this.vocabulary.set(token, this.vocabulary.size);
    }
    return this.vocabulary.get(token)!;
  }

  private updateIDF(_newDocs: string[]): void {
    const tokenDocs: Map<string, Set<number>> = new Map();
    
    for (let i = 0; i < this.documents.length; i++) {
      const tokens = new Set(this.tokenize(this.documents[i]));
      for (const token of tokens) {
        if (!tokenDocs.has(token)) {
          tokenDocs.set(token, new Set());
        }
        tokenDocs.get(token)!.add(i);
      }
    }

    for (const [token, docs] of tokenDocs) {
      this.idfScores.set(token, Math.log((this.documents.length + 1) / (docs.size + 1)) + 1);
    }
  }

  private normalize(vector: number[]): number[] {
    const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    if (magnitude === 0) return vector;
    return vector.map(v => v / magnitude);
  }

  /**
   * Initialize semantic word clusters for domain-specific terms
   * Words in the same cluster get similar vector contributions
   */
  private initializeSemanticClusters(): void {
    const clusters: Record<string, string[]> = {
      // Programming concepts
      programming: ['code', 'function', 'class', 'method', 'variable', 'const', 'let', 'var', 'import', 'export', 'async', 'await', 'promise', 'callback'],
      types: ['type', 'interface', 'enum', 'string', 'number', 'boolean', 'array', 'object', 'null', 'undefined'],
      errors: ['error', 'exception', 'throw', 'catch', 'try', 'finally', 'bug', 'fix', 'debug', 'trace', 'stack'],
      testing: ['test', 'spec', 'describe', 'it', 'expect', 'assert', 'mock', 'stub', 'spy', 'coverage'],
      git: ['git', 'commit', 'push', 'pull', 'merge', 'branch', 'checkout', 'rebase', 'stash', 'diff'],
      memory: ['memory', 'cache', 'store', 'retrieve', 'query', 'embed', 'vector', 'semantic', 'context'],
      security: ['security', 'auth', 'token', 'secret', 'password', 'encrypt', 'decrypt', 'hash', 'salt'],
      performance: ['performance', 'optimize', 'fast', 'slow', 'latency', 'throughput', 'cache', 'batch'],
      database: ['database', 'sql', 'query', 'table', 'index', 'schema', 'migration', 'insert', 'update', 'delete'],
      network: ['network', 'http', 'api', 'request', 'response', 'endpoint', 'url', 'fetch', 'axios'],
    };

    // Generate pseudo-random but consistent vectors for each cluster
    for (const [clusterName, words] of Object.entries(clusters)) {
      const clusterVector = this.generateClusterVector(clusterName);
      for (const word of words) {
        // Add slight variation for each word
        const wordVector = clusterVector.map((v, i) => 
          v + (this.hashString(word + i.toString()) % 100 - 50) / 500
        );
        this.wordVectors.set(word, wordVector);
      }
    }
  }

  private generateClusterVector(seed: string): number[] {
    const vector = new Array(this.dimensions).fill(0);
    const hash = this.hashString(seed);
    
    // Create sparse activation pattern for this cluster
    for (let i = 0; i < 20; i++) {
      const idx = (hash + i * 17) % this.dimensions;
      vector[idx] = ((hash + i) % 100) / 100;
    }
    
    return vector;
  }
}

/**
 * Embedding Service - Main interface for UAM memory system
 * Automatically selects best available provider
 * 
 * Priority: Ollama (local, free) > OpenAI > Local transformers > TF-IDF fallback
 */
export class EmbeddingService {
  private provider: EmbeddingProvider | null = null;
  private providers: EmbeddingProvider[];
  private cache: Map<string, number[]> = new Map();
  private cacheMaxSize: number = 10000;

  constructor(ollamaEndpoint?: string, ollamaModel?: string) {
    this.providers = [
      new OllamaEmbeddingProvider(ollamaEndpoint, ollamaModel), // First priority - local, free
      new OpenAIEmbeddingProvider(),
      new LocalEmbeddingProvider(),
      new TFIDFEmbeddingProvider(),
    ];
  }

  async initialize(): Promise<void> {
    for (const provider of this.providers) {
      if (await provider.isAvailable()) {
        this.provider = provider;
        console.log(`[EmbeddingService] Using provider: ${provider.name} (${provider.dimensions} dims)`);
        return;
      }
    }
    // Fallback to TF-IDF which is always available
    this.provider = this.providers[this.providers.length - 1];
    console.log(`[EmbeddingService] Fallback to TF-IDF provider`);
  }

  async embed(text: string): Promise<number[]> {
    if (!this.provider) {
      await this.initialize();
    }

    // Check cache
    const cacheKey = this.getCacheKey(text);
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    const embedding = await this.provider!.embed(text);
    
    // Update cache
    if (this.cache.size >= this.cacheMaxSize) {
      // Remove oldest entry
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(cacheKey, embedding);

    return embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!this.provider) {
      await this.initialize();
    }

    const results: number[][] = [];
    const uncachedTexts: string[] = [];
    const uncachedIndices: number[] = [];

    // Check cache for each text
    for (let i = 0; i < texts.length; i++) {
      const cacheKey = this.getCacheKey(texts[i]);
      if (this.cache.has(cacheKey)) {
        results[i] = this.cache.get(cacheKey)!;
      } else {
        uncachedTexts.push(texts[i]);
        uncachedIndices.push(i);
      }
    }

    // Generate embeddings for uncached texts
    if (uncachedTexts.length > 0) {
      const newEmbeddings = await this.provider!.embedBatch(uncachedTexts);
      for (let i = 0; i < uncachedTexts.length; i++) {
        const idx = uncachedIndices[i];
        results[idx] = newEmbeddings[i];
        
        // Update cache
        const cacheKey = this.getCacheKey(uncachedTexts[i]);
        if (this.cache.size < this.cacheMaxSize) {
          this.cache.set(cacheKey, newEmbeddings[i]);
        }
      }
    }

    return results;
  }

  cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error('Vectors must have same dimensions');
    }
    
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    
    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    if (denominator === 0) return 0;
    
    return dotProduct / denominator;
  }

  getDimensions(): number {
    return this.provider?.dimensions || 384;
  }

  getProviderName(): string {
    return this.provider?.name || 'uninitialized';
  }

  private getCacheKey(text: string): string {
    // Simple hash for cache key
    return text.slice(0, 500).toLowerCase().trim();
  }
}

// Singleton instance
let embeddingServiceInstance: EmbeddingService | null = null;

export function getEmbeddingService(): EmbeddingService {
  if (!embeddingServiceInstance) {
    embeddingServiceInstance = new EmbeddingService();
  }
  return embeddingServiceInstance;
}

export async function generateEmbedding(text: string): Promise<number[]> {
  const service = getEmbeddingService();
  return service.embed(text);
}

export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  const service = getEmbeddingService();
  return service.embedBatch(texts);
}
