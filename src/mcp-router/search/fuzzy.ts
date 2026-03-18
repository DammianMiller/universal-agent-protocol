/**
 * Fuzzy Search for MCP Tools
 * Uses Fuse.js for semantic-like matching
 */

import type { ToolDefinition, ToolSearchResult } from '../types.js';

// Lightweight fuzzy search implementation (no external deps)
// For production, consider using Fuse.js

interface FuzzyOptions {
  threshold?: number;
  keys?: string[];
}

function tokenize(str: string): string[] {
  return str
    .toLowerCase()
    .split(/[\s_\-./]+/)
    .filter(Boolean);
}

function calculateScore(query: string, target: string): number {
  const queryTokens = tokenize(query);
  const targetTokens = tokenize(target);

  if (queryTokens.length === 0 || targetTokens.length === 0) return 0;

  let matchCount = 0;
  let partialMatches = 0;

  for (const qToken of queryTokens) {
    for (const tToken of targetTokens) {
      if (tToken === qToken) {
        matchCount++;
        break;
      } else if (tToken.includes(qToken) || qToken.includes(tToken)) {
        partialMatches += 0.5;
        break;
      }
    }
  }

  const totalMatches = matchCount + partialMatches;
  return totalMatches / queryTokens.length;
}

export class ToolSearchIndex {
  private tools: ToolDefinition[] = [];
  private options: FuzzyOptions;
  // O(1) lookup index for getToolByPath - avoids O(n) linear scan per execute_tool call
  private pathIndex = new Map<string, ToolDefinition>();

  constructor(options: FuzzyOptions = {}) {
    this.options = {
      threshold: options.threshold ?? 0.3,
      keys: options.keys ?? ['name', 'description'],
    };
  }

  addTools(tools: ToolDefinition[]): void {
    this.tools.push(...tools);
    // Rebuild path index
    for (const tool of tools) {
      this.pathIndex.set(`${tool.serverName}.${tool.name}`, tool);
    }
  }

  clear(): void {
    this.tools = [];
    this.pathIndex.clear();
  }

  search(query: string, limit = 10): ToolSearchResult[] {
    const results: Array<{ tool: ToolDefinition; score: number }> = [];

    for (const tool of this.tools) {
      // Calculate score across all searchable fields
      const nameScore = calculateScore(query, tool.name) * 1.5; // Weight name higher
      const descScore = calculateScore(query, tool.description);
      const serverScore = calculateScore(query, tool.serverName) * 0.5;

      const score = Math.max(nameScore, descScore, serverScore);

      if (score >= this.options.threshold!) {
        results.push({ tool, score });
      }
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);

    return results.slice(0, limit).map(({ tool, score }) => ({
      path: `${tool.serverName}.${tool.name}`,
      name: tool.name,
      description: tool.description,
      server: tool.serverName,
      score: Math.round(score * 100) / 100,
    }));
  }

  searchByServer(serverName: string, limit = 50): ToolSearchResult[] {
    return this.tools
      .filter((t) => t.serverName === serverName)
      .slice(0, limit)
      .map((tool) => ({
        path: `${tool.serverName}.${tool.name}`,
        name: tool.name,
        description: tool.description,
        server: tool.serverName,
        score: 1.0,
      }));
  }

  getAllTools(): ToolDefinition[] {
    return [...this.tools];
  }

  getToolByPath(path: string): ToolDefinition | undefined {
    // O(1) lookup via Map index instead of O(n) linear scan
    return this.pathIndex.get(path);
  }

  getStats(): { servers: number; tools: number } {
    const servers = new Set(this.tools.map((t) => t.serverName));
    return {
      servers: servers.size,
      tools: this.tools.length,
    };
  }
}
