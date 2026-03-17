import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GitHubMemoryBackend } from '../../../src/memory/backends/github.js';
import type { MemoryEntry } from '../../../src/memory/backends/base.js';

// Mock Octokit
vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn().mockImplementation(() => ({
    repos: {
      get: vi.fn(),
      getContent: vi.fn(),
      createOrUpdateFileContents: vi.fn(),
      deleteFile: vi.fn(),
    },
  })),
}));

describe('GitHubMemoryBackend', () => {
  let backend: GitHubMemoryBackend;
  let mockOctokit: any;

  beforeEach(() => {
    // Set env var for token
    process.env.GITHUB_TOKEN = 'test-token';

    backend = new GitHubMemoryBackend({
      token: 'test-token',
      repo: 'owner/repo',
      path: '.uap/memory',
      branch: 'main',
    });

    mockOctokit = (backend as any).octokit;
  });

  it('should store memory entry', async () => {
    mockOctokit.repos.createOrUpdateFileContents.mockResolvedValueOnce({
      data: { content: { sha: 'new-sha' } },
    });

    const entry: MemoryEntry = {
      id: 'test-id',
      timestamp: new Date().toISOString(),
      type: 'action',
      content: 'Test memory content',
      tags: ['tag1', 'tag2'],
      importance: 8,
    };

    await backend.store(entry);

    expect(mockOctokit.repos.createOrUpdateFileContents).toHaveBeenCalled();

    const call = mockOctokit.repos.createOrUpdateFileContents.mock.calls[0][0];
    expect(call.owner).toBe('owner');
    expect(call.repo).toBe('repo');
    expect(call.path).toContain('.uap/memory');
    expect(call.message).toContain('Add memory');
  });

  it('should query memories by keyword', async () => {
    const mockMemories = [
      {
        id: '1',
        type: 'action' as const,
        content: 'Test memory with keyword',
        tags: ['test'],
        importance: 5,
        timestamp: new Date().toISOString(),
      },
      {
        id: '2',
        type: 'action' as const,
        content: 'Another memory',
        tags: ['test'],
        importance: 7,
        timestamp: new Date().toISOString(),
      },
    ];

    mockOctokit.repos.getContent.mockResolvedValueOnce({
      data: mockMemories.map((m, i) => ({
        name: `${m.timestamp.replace(/:/g, '-')}_${m.id}.json`,
        path: `.uap/memory/${m.timestamp.replace(/:/g, '-')}_${m.id}.json`,
        type: 'file',
        sha: 'sha',
      })),
    });

    for (const memory of mockMemories) {
      mockOctokit.repos.getContent.mockResolvedValueOnce({
        data: {
          content: Buffer.from(JSON.stringify(memory)).toString('base64'),
        },
      });
    }

    const results = await backend.query('keyword', 10);

    expect(results).toHaveLength(1);
    expect(results[0].content).toContain('keyword');
  });

  it('should parse owner and repo from repo string', () => {
    const backend1 = new GitHubMemoryBackend({
      token: 'test',
      repo: 'owner/repo',
      path: 'memory',
      branch: 'main',
    });

    expect((backend1 as any).owner).toBe('owner');
    expect((backend1 as any).repo).toBe('repo');
  });

  it('should check if configured', async () => {
    mockOctokit.repos.get.mockResolvedValueOnce({ data: { name: 'repo' } });

    const isConfigured = await backend.isConfigured();

    expect(isConfigured).toBe(true);
    expect(mockOctokit.repos.get).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('should return empty array when no memories exist', async () => {
    mockOctokit.repos.getContent.mockRejectedValueOnce({ status: 404 });

    const results = await backend.getRecent(10);

    expect(results).toEqual([]);
  });

  it('should prune old memories', async () => {
    // Prune correctly parses timestamps from filenames, restoring colons only in the time portion
    const oldDate = new Date(Date.now() - 1000000);
    const oldTimestamp = oldDate.toISOString();
    const fileName = `${oldTimestamp.replace(/:/g, '-')}_old.json`;

    const mockFiles = [
      {
        name: fileName,
        path: `.uap/memory/${fileName}`,
        type: 'file' as const,
        sha: 'old-sha',
      },
    ];

    mockOctokit.repos.getContent.mockResolvedValueOnce({ data: mockFiles });
    mockOctokit.repos.deleteFile.mockResolvedValueOnce({ data: {} });

    const deleted = await backend.prune(new Date());

    // Old memory should be pruned successfully
    expect(deleted).toBe(1);
    expect(mockOctokit.repos.getContent).toHaveBeenCalled();
    expect(mockOctokit.repos.deleteFile).toHaveBeenCalledWith(
      expect.objectContaining({
        path: `.uap/memory/${fileName}`,
        sha: 'old-sha',
      })
    );
  });
});
