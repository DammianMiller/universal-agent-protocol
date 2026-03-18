import { readdir, readFile } from 'fs/promises';
import { join } from 'path';

export interface FileEntry<T> {
  name: string;
  path: string;
  metadata: T;
  source: string;
}

export interface DiscoveryOptions {
  /** TTL for file cache in milliseconds (default: 60s) */
  cacheTTL?: number;
  /** Custom error handler */
  onError?: (error: Error, path: string) => void;
}

export interface CacheEntry<T> {
  data: FileEntry<T>[];
  timestamp: number;
}

// Simple in-memory cache for file discovery
const fileCache = new Map<string, CacheEntry<any>>();

/**
 * Discover and parse files from a directory with caching
 * @param baseDir - Base directory to search
 * @param filePattern - Function to filter files by name
 * @param parser - Function to parse file content and extract metadata
 * @param options - Configuration options
 * @returns Array of file entries with parsed metadata
 */
export async function discoverFiles<T>(
  baseDir: string,
  filePattern: (name: string) => boolean,
  parser: (content: string) => T | null,
  options: DiscoveryOptions = {}
): Promise<FileEntry<T>[]> {
  const {
    cacheTTL = 60000, // 1 minute default
    onError = () => {},
  } = options;

  const cacheKey = `${baseDir}:${filePattern.toString()}`;
  const cached = fileCache.get(cacheKey);

  // Return cached data if still valid
  if (cached && Date.now() - cached.timestamp < cacheTTL) {
    return cached.data;
  }

  try {
    const entries = await readdir(baseDir, { withFileTypes: true });
    const results: FileEntry<T>[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || !filePattern(entry.name)) continue;

      const filePath = join(baseDir, entry.name);
      try {
        const content = await readFile(filePath, 'utf-8');
        const metadata = parser(content);

        if (metadata) {
          results.push({
            name: entry.name,
            path: filePath,
            metadata,
            source: baseDir,
          });
        }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        onError(err, filePath);
      }
    }

    // Update cache
    fileCache.set(cacheKey, {
      data: results,
      timestamp: Date.now(),
    });

    return results;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    onError(err, baseDir);
    return [];
  }
}

/**
 * Discover files from subdirectories (e.g., skills in folders)
 */
export async function discoverFilesFromSubdirs<T>(
  baseDir: string,
  subdirPattern: (name: string) => boolean,
  filePattern: (name: string) => boolean,
  parser: (content: string) => T | null,
  options?: DiscoveryOptions
): Promise<FileEntry<T>[]> {
  const results: FileEntry<T>[] = [];

  try {
    const entries = await readdir(baseDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory() || !subdirPattern(entry.name)) continue;

      const dirPath = join(baseDir, entry.name);
      const subdirResults = await discoverFiles(dirPath, filePattern, parser, options);

      results.push(
        ...subdirResults.map((r) => ({
          ...r,
          source: join(baseDir, entry.name),
        }))
      );
    }
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    options?.onError?.(err, baseDir);
  }

  return results;
}

/**
 * Clear cache for a specific discovery operation
 */
export function clearFileCache(baseDir: string): void {
  const patterns = [...fileCache.keys()];
  patterns.forEach((key) => {
    if (key.startsWith(`${baseDir}:`)) {
      fileCache.delete(key);
    }
  });
}

/**
 * Clear all file discovery caches
 */
export function clearAllFileCaches(): void {
  fileCache.clear();
}
