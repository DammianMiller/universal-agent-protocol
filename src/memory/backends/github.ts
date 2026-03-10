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
    const filename = `${entry.timestamp.replace(/:/g, '-')}_${entry.id}.json`;
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
      throw new Error(`Failed to store memory in GitHub: ${error}`);
    }
  }

  async query(query: string, limit = 10): Promise<MemoryEntry[]> {
    const memories = await this.getRecent(50);
    return memories
      .filter((m) => m.content.toLowerCase().includes(query.toLowerCase()))
      .slice(0, limit);
  }

  async getRecent(limit = 50): Promise<MemoryEntry[]> {
    try {
      const { data: files } = await this.octokit.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        path: this.path,
        ref: this.branch,
      });

      if (!Array.isArray(files)) return [];

      const sortedFiles = files
        .filter((f) => f.type === 'file' && f.name.endsWith('.json'))
        .sort((a, b) => b.name.localeCompare(a.name))
        .slice(0, limit);

      const memories: MemoryEntry[] = [];
      for (const file of sortedFiles) {
        const { data } = await this.octokit.repos.getContent({
          owner: this.owner,
          repo: this.repo,
          path: file.path,
          ref: this.branch,
        });

        if ('content' in data) {
          const content = Buffer.from(data.content, 'base64').toString();
          memories.push(JSON.parse(content));
        }
      }
      return memories;
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
          const timestamp = file.name.split('_')[0].replace(/-/g, ':');
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
