import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  discoverFiles,
  discoverFilesFromSubdirs,
  clearFileCache,
  clearAllFileCaches,
} from '../../src/utils/file-discovery.js';
import { mkdir, writeFile, rm, readdir } from 'fs/promises';
import { join } from 'path';

const TEST_DIR = join(process.cwd(), 'test', 'tmp', 'file-discovery');

async function setupTestDir(): Promise<void> {
  await mkdir(TEST_DIR, { recursive: true });

  // Create test files
  await writeFile(
    join(TEST_DIR, 'droid1.md'),
    `---
name: Test Droid 1
type: main
---
Test content 1`
  );

  await writeFile(
    join(TEST_DIR, 'droid2.md'),
    `---
name: Test Droid 2
type: subagent
---
Test content 2`
  );

  await writeFile(join(TEST_DIR, 'readme.txt'), 'This should be ignored');

  // Create subdirectory with files
  const subdir = join(TEST_DIR, 'subdir1');
  await mkdir(subdir, { recursive: true });

  await writeFile(
    join(subdir, 'skill1.md'),
    `---
name: Skill One
---
Skill content`
  );
}

async function cleanupTestDir(): Promise<void> {
  try {
    await rm(TEST_DIR, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

describe('File Discovery Utilities', () => {
  beforeEach(async () => {
    await setupTestDir();
    clearAllFileCaches();
  });

  afterEach(async () => {
    await cleanupTestDir();
    clearAllFileCaches();
  });

  describe('discoverFiles', () => {
    it('should discover and parse .md files matching pattern', async () => {
      const files = await discoverFiles(
        TEST_DIR,
        (name) => name.endsWith('.md'),
        (content) => {
          const yamlMatch = content.match(/^---\n([\s\S]*?)\n---/);
          if (!yamlMatch) return null;
          const metadata: Record<string, unknown> = {};
          yamlMatch[1].split('\n').forEach((line) => {
            const [key, ...valueParts] = line.split(': ');
            if (key && valueParts.length > 0) {
              metadata[key.trim()] = valueParts.join(': ').trim();
            }
          });
          return metadata;
        }
      );

      expect(files).toHaveLength(2);
      expect(files.map((f) => f.name)).toContain('droid1.md');
      expect(files.map((f) => f.name)).toContain('droid2.md');
    });

    it('should exclude files not matching pattern', async () => {
      const files = await discoverFiles(
        TEST_DIR,
        (name) => name.endsWith('.md'),
        () => ({}) as Record<string, unknown>
      );

      expect(files).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'readme.txt' })])
      );
    });

    it('should cache results and return cached data on second call', async () => {
      const parser = vi.fn((content: string) => ({ parsed: true }));

      const files1 = await discoverFiles(TEST_DIR, (name) => name.endsWith('.md'), parser);

      expect(files1).toHaveLength(2);
      expect(parser).toHaveBeenCalledTimes(2);

      // Second call should use cache
      const files2 = await discoverFiles(TEST_DIR, (name) => name.endsWith('.md'), parser);

      expect(files2).toBe(files1); // Same reference from cache
      expect(parser).toHaveBeenCalledTimes(2); // Not called again
    });

    it('should respect cache TTL', async () => {
      const testParser = vi.fn((content: string) => ({ parsed: true }));

      await discoverFiles(TEST_DIR, (name) => name.endsWith('.md'), testParser, { cacheTTL: 100 });

      expect(testParser).toHaveBeenCalledTimes(2); // 2 files

      // Clear cache manually to simulate TTL expiry
      clearFileCache(TEST_DIR);

      // Call again - should re-parse
      const files = await discoverFiles(TEST_DIR, (name) => name.endsWith('.md'), testParser);

      expect(files).toHaveLength(2);
      expect(testParser).toHaveBeenCalledTimes(4); // 2 files * 2 calls
    });

    it('should handle parse errors gracefully', async () => {
      const onError = vi.fn();

      const files = await discoverFiles(
        TEST_DIR,
        (name) => name.endsWith('.md'),
        (content) => {
          // Force error on second file
          if (content.includes('Test content 2')) {
            throw new Error('Parse error');
          }
          return { parsed: true };
        },
        { onError }
      );

      expect(files).toHaveLength(1);
      expect(onError).toHaveBeenCalled();
    });

    it('should return empty array for non-existent directory', async () => {
      const files = await discoverFiles(
        '/non/existent/path',
        () => true,
        () => ({}) as Record<string, unknown>
      );

      expect(files).toEqual([]);
    });

    it('should include source path in file entry', async () => {
      const files = await discoverFiles(
        TEST_DIR,
        (name) => name.endsWith('.md'),
        () => ({})
      );

      expect(files[0].source).toBe(TEST_DIR);
    });
  });

  describe('discoverFilesFromSubdirs', () => {
    it('should discover files from subdirectories', async () => {
      const files = await discoverFilesFromSubdirs(
        TEST_DIR,
        (name) => name.startsWith('subdir'),
        (name) => name.endsWith('.md'),
        (content) => ({ parsed: true })
      );

      expect(files).toHaveLength(1);
      expect(files[0].name).toBe('skill1.md');
      expect(files[0].source).toContain('subdir1');
    });

    it('should handle multiple subdirectories', async () => {
      const subdir2 = join(TEST_DIR, 'subdir2');
      await mkdir(subdir2, { recursive: true });
      await writeFile(
        join(subdir2, 'skill2.md'),
        `---
name: Skill Two
---
Content`
      );

      const files = await discoverFilesFromSubdirs(
        TEST_DIR,
        (name) => name.startsWith('subdir'),
        (name) => name.endsWith('.md'),
        (content) => ({ parsed: true })
      );

      expect(files).toHaveLength(2);
    });
  });

  describe('clearFileCache', () => {
    it('should clear cache for specific directory', async () => {
      await discoverFiles(
        TEST_DIR,
        (name) => name.endsWith('.md'),
        () => ({})
      );

      clearFileCache(TEST_DIR);

      // Should force re-parse on next call
      const files = await discoverFiles(
        TEST_DIR,
        (name) => name.endsWith('.md'),
        () => ({ fresh: true })
      );

      expect(files).toHaveLength(2);
    });
  });

  describe('clearAllFileCaches', () => {
    it('should clear all cached file discoveries', async () => {
      await discoverFiles(
        TEST_DIR,
        (name) => name.endsWith('.md'),
        () => ({})
      );

      clearAllFileCaches();

      // Should force re-parse
      const files = await discoverFiles(
        TEST_DIR,
        (name) => name.endsWith('.md'),
        () => ({ fresh: true })
      );

      expect(files).toHaveLength(2);
    });
  });
});
