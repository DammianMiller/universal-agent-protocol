import type { AgentContextConfig } from '../../types/index.js';
import type { MemoryBackend } from './base.js';
import { GitHubMemoryBackend } from './github.js';
import { QdrantCloudBackend } from './qdrant-cloud.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('memory-backends');

export async function createMemoryBackend(
  config: AgentContextConfig
): Promise<MemoryBackend | null> {
  if (!config.memory?.longTerm?.enabled) {
    return null;
  }

  const longTerm = config.memory.longTerm;

  // Check GitHub backend (opt-in via config or env vars)
  if (longTerm.github?.enabled) {
    const token = longTerm.github.token || process.env.GITHUB_TOKEN;
    const repo = longTerm.github.repo;

    if (token && repo) {
      try {
        const backend = new GitHubMemoryBackend({
          token,
          repo,
          path: longTerm.github.path || '.uap/memory',
          branch: longTerm.github.branch || 'main',
        });

        if (await backend.isConfigured()) {
          return backend;
        }
      } catch (error) {
        log.warn(
          `GitHub backend not available: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  // Check Qdrant Cloud backend (opt-in via config or env vars)
  if (longTerm.qdrantCloud?.enabled) {
    const apiKey = longTerm.qdrantCloud.apiKey || process.env.QDRANT_API_KEY;
    const url = longTerm.qdrantCloud.url || process.env.QDRANT_URL;

    if (apiKey && url) {
      try {
        const backend = new QdrantCloudBackend({
          url,
          apiKey,
          collection: longTerm.qdrantCloud.collection || 'agent_memory',
          projectId: config.project?.name || process.cwd(),
        });

        if (await backend.isConfigured()) {
          return backend;
        }
      } catch (error) {
        log.warn(
          `Qdrant Cloud backend not available: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  // No configured backend found - gracefully return null
  return null;
}
