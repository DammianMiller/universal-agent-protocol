import { Octokit } from '@octokit/rest';
import type { MemoryBackend, MemoryEntry } from './base.js';

interface GitHubMemoryBackendConfig {
  token: string;
  repo: string;
  path: string;
  branch: string;
}

export class GitHubMemoryBackend implements MemoryBackend {
  private octokit: Octokit;
  private repo: string;
  private owner: string;
  private path: string;
  private branch: string;

  constructor(config: GitHubMemoryBackendConfig) {
    const token = config.token || process.env.GITHUB_TOKEN;
    if (!token) {
      throw new Error('GitHub token required (GITHUB_TOKEN env var or config)');
    }
    this.octokit = new Octokit({ auth: token });
    [this.owner, this.repo] = config.repo.split('/');
    this.path = config.path;
    this.branch = config.branch;
  }

  async isConfigured(): Promise<boolean> {
    try {
      await this.octokit.repos.get({ owner: this.owner, repo: this.repo });
      return true;
    } catch {
      return false;
    }
  }

  async store(entry: MemoryEntry): Promise<void> {
    // Use double-underscore separator to avoid collision with underscores in entry.id
    const filename = `${entry.timestamp.replace(/:/g, '-')}__${entry.id}.json`;
    const filePath = `${this.path}/${filename}`;
    const content = Buffer.from(JSON.stringify(entry, null, 2)).toString('base64');

    try {
      await this.octokit.repos.createOrUpdateFileContents({
        owner: this.owner,
        repo: this.repo,
        path: filePath,
        message: `Add memory: ${entry.type} - ${entry.content.substring(0, 50)}`,
        content,
        branch: this.branch,
      });
    } catch (error) {
      throw new Error(
        `Failed to store memory in GitHub: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Query memories by substring match (case-insensitive).
   * Note: This is NOT semantic search — it uses simple string containment.
   * For semantic search, use QdrantCloudBackend instead.
   */
  async query(query: string, limit = 10): Promise<MemoryEntry[]> {
    const memories = await this.getRecent(50);
    return memories
      .filter((m) => m.content.toLowerCase().includes(query.toLowerCase()))
      .slice(0, limit);
  }

  async getRecent(limit = 50): Promise<MemoryEntry[]> {
    try {
      // Use directory listing to get file names, then fetch contents in parallel
      // (replaces sequential N+1 API calls with concurrent batch)
      const { data: files } = await this.octokit.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        path: this.path,
        ref: this.branch,
      });

      if (!Array.isArray(files)) return [];

      const sortedFiles = files
        .filter(
          (f: { type: string; name: string }) => f.type === 'file' && f.name.endsWith('.json')
        )
        .sort((a: { name: string }, b: { name: string }) => b.name.localeCompare(a.name))
        .slice(0, limit);

      // Fetch all file contents in parallel instead of sequentially
      const results = await Promise.all(
        sortedFiles.map(async (file: { path: string }) => {
          try {
            const { data } = await this.octokit.repos.getContent({
              owner: this.owner,
              repo: this.repo,
              path: file.path,
              ref: this.branch,
            });
            if ('content' in data) {
              const content = Buffer.from(
                (data as { content: string }).content,
                'base64'
              ).toString();
              return JSON.parse(content) as MemoryEntry;
            }
          } catch {
            // Skip individual file failures
          }
          return null;
        })
      );

      return results.filter((m): m is MemoryEntry => m !== null);
    } catch {
      return [];
    }
  }

  async prune(olderThan: Date): Promise<number> {
    try {
      const { data: files } = await this.octokit.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        path: this.path,
        ref: this.branch,
      });

      if (!Array.isArray(files)) return 0;

      let deleted = 0;
      for (const file of files) {
        if (file.type === 'file' && file.name.endsWith('.json')) {
          // Split on double-underscore to get timestamp portion, then restore colons in time part only
          // Handles both new format (double-underscore) and legacy (single underscore)
          // Filename format: "2026-03-13T10-30-00.000Z__<id>.json" — colons in time were replaced with hyphens
          const parts = file.name.split('__');
          const rawTimestamp = parts.length > 1 ? parts[0] : file.name.split('_')[0];
          // Only restore colons after the 'T' (time portion) to preserve date hyphens (YYYY-MM-DD)
          const tIndex = rawTimestamp.indexOf('T');
          const timestamp =
            tIndex >= 0
              ? rawTimestamp.slice(0, tIndex + 1) +
                rawTimestamp.slice(tIndex + 1).replace(/-/g, ':')
              : rawTimestamp;
          if (new Date(timestamp) < olderThan) {
            await this.octokit.repos.deleteFile({
              owner: this.owner,
              repo: this.repo,
              path: file.path,
              message: `Prune old memory: ${file.name}`,
              sha: file.sha,
              branch: this.branch,
            });
            deleted++;
          }
        }
      }
      return deleted;
    } catch {
      return 0;
    }
  }
}
