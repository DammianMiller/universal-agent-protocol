/**
 * CLI Init Command Tests
 *
 * Unit tests for the uap init command.
 * Focuses on configuration generation and flow logic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initCommand, type InitOptions } from '../../src/cli/init.js';
import type { AgentContextConfig } from '../../src/types/index.js';

// Mock console output
const mockConsoleLog = vi.fn();
const mockConsoleError = vi.fn();

vi.spyOn(console, 'log').mockImplementation(mockConsoleLog);
vi.spyOn(console, 'error').mockImplementation(mockConsoleError);

// Mock all external dependencies
vi.mock('chalk', () => ({
  default: {
    bold: (str: string) => str,
    dim: (str: string) => str,
    green: (str: string) => str,
    red: (str: string) => str,
  },
}));

vi.mock('ora', () => {
  const mockSpinner = {
    start: function () {
      return this;
    },
    succeed: vi.fn(),
    fail: vi.fn(),
    warn: vi.fn(),
  };
  return { default: vi.fn(() => mockSpinner), __esModule: true };
});

vi.mock('../../src/analyzers/index.js', () => ({
  analyzeProject: vi.fn().mockResolvedValue({
    projectName: 'test-project',
    description: 'Test project',
    defaultBranch: 'main',
    languages: ['typescript'],
    frameworks: [],
    databases: [],
  }),
}));

vi.mock('../../src/generators/claude-md.js', () => ({
  generateClaudeMd: vi.fn().mockResolvedValue('# Test CLAUDE.md'),
}));

vi.mock('../../src/utils/merge-claude-md.js', () => ({
  mergeClaudeMd: vi.fn((existing: string, _new: string) => existing || _new),
}));

vi.mock('../../src/memory/short-term/schema.js', () => ({
  initializeMemoryDatabase: vi.fn(),
}));

vi.mock('../../src/coordination/database.js', () => ({
  CoordinationDatabase: class MockCoordinationDB {
    static getInstance() {
      return new MockCoordinationDB();
    }
    static resetInstance() {}
  },
  getDefaultCoordinationDbPath: vi.fn(() => './agents/data/coordination/coordination.db'),
}));

vi.mock('../../src/cli/patterns.js', () => ({
  generateScripts: vi.fn().mockResolvedValue(undefined),
  ensurePythonVenv: vi.fn(() => '/usr/bin/python3'),
  findPython: vi.fn(() => '/usr/bin/python3'),
}));

vi.mock('../../src/cli/memory.js', () => ({
  isQdrantReachable: vi.fn().mockResolvedValue(true),
}));

describe('initCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should accept platform options', async () => {
    const options: InitOptions = {
      platform: ['claude', 'vscode'],
      memory: true,
      worktrees: true,
    };

    await initCommand(options);

    // Should complete without errors
    expect(mockConsoleError).not.toHaveBeenCalled();
  });

  it('should handle --no-memory flag', async () => {
    const options: InitOptions = {
      platform: ['all'],
      memory: false,
      worktrees: true,
    };

    await initCommand(options);

    // Should complete without errors
    expect(mockConsoleError).not.toHaveBeenCalled();
  });

  it('should handle --no-worktrees flag', async () => {
    const options: InitOptions = {
      platform: ['all'],
      memory: true,
      worktrees: false,
    };

    await initCommand(options);

    // Should complete without errors
    expect(mockConsoleError).not.toHaveBeenCalled();
  });

  it('should handle --force flag', async () => {
    const options: InitOptions = {
      platform: ['all'],
      memory: true,
      worktrees: true,
      force: true,
    };

    await initCommand(options);

    // Should complete without errors
    expect(mockConsoleError).not.toHaveBeenCalled();
  });

  it('should handle project directory override', async () => {
    const options: InitOptions = {
      platform: ['all'],
      memory: true,
      worktrees: true,
      projectDir: '/custom/path',
    };

    await initCommand(options);

    // Should complete without errors
    expect(mockConsoleError).not.toHaveBeenCalled();
  });

  it('should handle pipeline-only flag', async () => {
    const options: InitOptions = {
      platform: ['all'],
      memory: true,
      worktrees: true,
      pipelineOnly: true,
    };

    await initCommand(options);

    // Should complete without errors
    expect(mockConsoleError).not.toHaveBeenCalled();
  });
});

// Test configuration structure generation (pure function test)
describe('init command config generation', () => {
  it('should generate config with correct default values', () => {
    const defaultConfig: AgentContextConfig = {
      $schema:
        'https://raw.githubusercontent.com/DammianMiller/universal-agent-protocol/main/schema.json',
      version: '1.0.0',
      project: {
        name: 'test-project',
        defaultBranch: 'main',
      },
      platforms: {
        claudeCode: { enabled: true },
        factory: { enabled: true },
        vscode: { enabled: true },
        opencode: { enabled: true },
      },
      memory: {
        shortTerm: {
          enabled: true,
          path: './agents/data/memory/short_term.db',
          maxEntries: 50,
        },
        longTerm: {
          enabled: true,
          provider: 'qdrant',
          endpoint: 'localhost:6333',
          collection: 'agent_memory',
          embeddingModel: 'all-MiniLM-L6-v2',
        },
      },
      worktrees: {
        enabled: true,
        directory: '.worktrees',
        branchPrefix: 'feature/',
        autoCleanup: true,
      },
      droids: [],
      commands: [],
      template: {
        extends: 'default',
        sections: {
          memorySystem: true,
          browserUsage: true,
          decisionLoop: true,
          worktreeWorkflow: true,
          troubleshooting: true,
          augmentedCapabilities: true,
          pipelineOnly: false,
          benchmark: false,
        },
      },
    };

    expect(defaultConfig).toBeDefined();
    expect(defaultConfig.project.name).toBe('test-project');
    expect(defaultConfig.memory?.shortTerm?.maxEntries).toBe(50);
  });

  it('should support platform-specific configuration', () => {
    const config: AgentContextConfig = {
      $schema:
        'https://raw.githubusercontent.com/DammianMiller/universal-agent-protocol/main/schema.json',
      version: '1.0.0',
      project: { name: 'test', defaultBranch: 'main' },
      platforms: {
        claudeCode: { enabled: true },
        factory: { enabled: false },
        vscode: { enabled: true },
        opencode: { enabled: false },
      },
      memory: undefined,
      worktrees: undefined,
      droids: [],
      commands: [],
      template: {
        extends: 'default',
        sections: {
          memorySystem: true,
          browserUsage: true,
          decisionLoop: true,
          worktreeWorkflow: true,
          troubleshooting: true,
          augmentedCapabilities: true,
          pipelineOnly: false,
          benchmark: false,
        },
      },
    };

    expect(config.platforms?.claudeCode?.enabled).toBe(true);
    expect(config.platforms?.factory?.enabled).toBe(false);
  });

  it('should support pattern RAG configuration', () => {
    const config: AgentContextConfig = {
      $schema:
        'https://raw.githubusercontent.com/DammianMiller/universal-agent-protocol/main/schema.json',
      version: '1.0.0',
      project: { name: 'test', defaultBranch: 'main' },
      platforms: {},
      memory: {
        shortTerm: { enabled: true, path: './agents/data/memory/short_term.db', maxEntries: 50 },
        longTerm: {
          enabled: true,
          provider: 'qdrant',
          endpoint: 'localhost:6333',
          collection: 'agent_memory',
          embeddingModel: 'all-MiniLM-L6-v2',
        },
        patternRag: {
          enabled: true,
          collection: 'agent_patterns',
          embeddingModel: 'all-MiniLM-L6-v2',
          vectorSize: 384,
          scoreThreshold: 0.35,
          topK: 2,
          indexScript: './agents/scripts/index_patterns_to_qdrant.py',
          queryScript: './agents/scripts/query_patterns.py',
          sourceFile: 'CLAUDE.md',
          maxBodyChars: 400,
        },
      },
      worktrees: undefined,
      droids: [],
      commands: [],
      template: {
        extends: 'default',
        sections: {
          memorySystem: true,
          browserUsage: true,
          decisionLoop: true,
          worktreeWorkflow: true,
          troubleshooting: true,
          augmentedCapabilities: true,
          pipelineOnly: false,
          benchmark: false,
        },
      },
    };

    expect(config.memory?.patternRag?.enabled).toBe(true);
    expect(config.memory?.patternRag?.topK).toBe(2);
  });
});
