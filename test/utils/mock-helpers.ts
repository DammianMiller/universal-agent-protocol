/**
 * Test Utilities for UAP
 *
 * Provides mock implementations and test helpers for external dependencies.
 */

import { createHash } from 'crypto';

/**
 * Mock HTTP server response helper
 */
export class MockResponse {
  constructor(
    public status: number = 200,
    public body: unknown,
    public headers: Record<string, string> = {}
  ) {}

  ok: boolean = true;
  statusText: string = 'OK';

  async json() {
    return this.body;
  }

  async text() {
    return JSON.stringify(this.body);
  }
}

/**
 * Mock fetch implementation for testing HTTP-dependent code
 */
export class MockFetch {
  private routes: Array<{
    path: string;
    method?: string;
    handler: (req: Request) => Promise<MockResponse>;
  }> = [];

  private defaultHandler?: (req: Request) => Promise<MockResponse>;

  route(
    path: string,
    method: string = 'GET',
    handler: (req: Request) => Promise<MockResponse>
  ): this {
    this.routes.push({ path, method, handler });
    return this;
  }

  default(handler: (req: Request) => Promise<MockResponse>): this {
    this.defaultHandler = handler;
    return this;
  }

  async fetch(url: string | URL, init?: RequestInit): Promise<MockResponse> {
    const urlStr = url.toString();
    const method = init?.method || 'GET';

    // Check specific routes first (exact match or path contains)
    for (const route of this.routes) {
      const pathMatch =
        urlStr === route.path ||
        urlStr.includes(route.path) ||
        route.path.includes(urlStr.replace(/^https?:\/\//, ''));
      const methodMatch = !route.method || route.method === method;
      if (pathMatch && methodMatch) {
        return route.handler(new Request(url, init));
      }
    }

    // Fall back to default handler
    if (this.defaultHandler) {
      return this.defaultHandler(new Request(url, init));
    }

    // Default 404
    return new MockResponse(404, { error: 'Not Found' });
  }
}

/**
 * Create a mock embedding response
 */
export function createMockEmbedding(dimensions: number = 768): number[] {
  return Array.from({ length: dimensions }, () => Math.random() * 2 - 1);
}

/**
 * Create mock embedding batch responses
 */
export function createMockEmbeddingBatch(count: number, dimensions: number = 768): number[][] {
  return Array.from({ length: count }, () => createMockEmbedding(dimensions));
}

/**
 * Mock LlamaCpp embedding provider response
 */
export function createLlamaCppEmbeddingResponse(
  texts: string[],
  dimensions: number = 768
): {
  data: Array<{ embedding: number[]; index: number }>;
} {
  return {
    data: texts.map((text, i) => ({
      embedding: createMockEmbedding(dimensions),
      index: i,
    })),
  };
}

/**
 * Mock Ollama embedding response
 */
export function createOllamaEmbeddingResponse(
  text: string,
  dimensions: number = 768
): { embedding: number[] } {
  return { embedding: createMockEmbedding(dimensions) };
}

/**
 * Mock OpenAI embedding response
 */
export function createOpenAIEmbeddingResponse(
  texts: string[],
  dimensions: number = 1536
): {
  data: Array<{ embedding: number[] }>;
} {
  return {
    data: texts.map(() => ({ embedding: createMockEmbedding(dimensions) })),
  };
}

/**
 * Mock file system for testing
 */
export class MockFileSystem {
  private files: Map<string, string> = new Map();
  private dirs: Set<string> = new Set();

  constructor(initialFiles: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(initialFiles)) {
      this.files.set(path, content);
      // Auto-create parent directories
      const dir = path.slice(0, path.lastIndexOf('/'));
      if (dir) this.dirs.add(dir);
    }
  }

  exists(path: string): boolean {
    return this.files.has(path) || this.dirs.has(path);
  }

  read(path: string): string | null {
    return this.files.get(path) ?? null;
  }

  write(path: string, content: string): void {
    this.files.set(path, content);
    const dir = path.slice(0, path.lastIndexOf('/'));
    if (dir) this.dirs.add(dir);
  }

  listDir(path: string): string[] {
    const prefix = path.endsWith('/') ? path : path + '/';
    return Array.from(this.files.keys())
      .filter((f) => f.startsWith(prefix))
      .map((f) => f.slice(prefix.length).split('/')[0])
      .filter((f, i, arr) => arr.indexOf(f) === i);
  }

  delete(path: string): void {
    this.files.delete(path);
  }
}

/**
 * Mock database for testing
 */
export class MockDatabase {
  private tables: Map<string, Map<string | number, unknown>> = new Map();

  constructor() {}

  createTable<T extends Record<string, unknown>>(name: string): void {
    if (!this.tables.has(name)) {
      this.tables.set(name, new Map());
    }
  }

  insert<T extends Record<string, unknown>>(table: string, row: T): void {
    if (!this.tables.has(table)) {
      this.createTable(table);
    }
    const id = (row as any).id || this.tables.get(table)!.size;
    (row as any).id = id;
    this.tables.get(table)!.set(id, row);
  }

  query<T>(table: string): T[] {
    const tableData = this.tables.get(table);
    return (Array.from(tableData?.values() ?? []) as T[]) || [];
  }

  find<T>(table: string, id: string | number): T | null {
    return (this.tables.get(table)?.get(id) as T) ?? null;
  }

  clear(): void {
    this.tables.clear();
  }
}

/**
 * Mock environment variables
 */
export class MockEnv {
  private original: Map<string, string | undefined> = new Map();

  set(key: string, value: string): void {
    this.original.set(key, process.env[key]);
    process.env[key] = value;
  }

  unset(key: string): void {
    this.original.set(key, process.env[key]);
    delete process.env[key];
  }

  restore(): void {
    for (const [key, value] of this.original) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

/**
 * Mock time for testing time-dependent code
 */
export class MockTime {
  private originalDate: typeof Date;
  private mockTime: Date;

  constructor(initialTime: Date = new Date()) {
    this.originalDate = global.Date;
    this.mockTime = initialTime;
    const self = this;
    global.Date = class extends Date {
      constructor() {
        super(self.mockTime);
      }

      static now() {
        return self.mockTime.getTime();
      }
    } as any;
  }

  set(time: Date): void {
    this.mockTime = time;
  }

  advance(ms: number): void {
    this.mockTime = new Date(this.mockTime.getTime() + ms);
  }

  restore(): void {
    global.Date = this.originalDate;
  }
}

/**
 * Mock console output for testing
 */
export class MockConsole {
  private logs: Array<{ level: string; args: unknown[] }> = [];
  private originalMethods: Map<string, Function> = new Map();

  constructor() {
    const levels: Array<'log' | 'error' | 'warn' | 'info'> = ['log', 'error', 'warn', 'info'];
    for (const level of levels) {
      this.originalMethods.set(level, console[level]);
      console[level] = (...args: unknown[]) => {
        this.logs.push({ level, args });
      };
    }
  }

  getLogs(): Array<{ level: string; args: unknown[] }> {
    return [...this.logs];
  }

  clear(): void {
    this.logs = [];
  }

  restore(): void {
    for (const [level, original] of this.originalMethods) {
      console[level] = original;
    }
  }
}

/**
 * Cache key generator for testing
 */
export function createCacheKey(text: string): string {
  return createHash('sha256').update(text.toLowerCase().trim()).digest('hex');
}

/**
 * Retry helper for flaky tests
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: { maxRetries?: number; delayMs?: number } = {}
): Promise<T> {
  const { maxRetries = 3, delayMs = 100 } = options;
  let lastError: Error | undefined;

  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      if (i < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * (i + 1)));
      }
    }
  }

  if (lastError) throw lastError;
  throw new Error('Unexpected retry failure');
}
