/**
 * CLI Init Command Tests
 *
 * Unit tests for the uap init command.
 * Focuses on configuration generation and flow logic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initCommand, type InitOptions } from '../../src/cli/init.js';
import type { AgentContextConfig } from '../../src/types/index.js';
import { analyzeProject } from '../../src/analyzers/index.js';
import { generateClaudeMd } from '../../src/generators/claude-md.js';
import { mergeClaudeMd } from '../../src/utils/merge-claude-md.js';
import { isQdrantReachable } from '../../src/cli/memory.js';

// Mock console output.
//
// Installed per test, not once at module scope: afterEach calls
// vi.restoreAllMocks(), which removed these spies after the first test and
// left every later assertion on them unable to fail. Silencing the command's
// output is the job that remains -- the tests below assert on the files it
// writes, not on what it printed.
const mockConsoleLog = vi.fn();
const mockConsoleError = vi.fn();

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
  // Hermetic: run init against a throwaway dir so policy/MCP/hook writes never
  // touch the repo working tree.
  let testDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    // Re-arm the module-factory mocks EVERY test. The afterEach below calls
    // vi.restoreAllMocks(), which wipes the implementations of the vi.fn()s
    // declared inside the vi.mock factories (restore treats them as spies and
    // clears mockResolvedValue). In isolation the wipe happened to land
    // harmlessly, but under full-suite worker scheduling the last test
    // ('pipeline-only') ran with analyzeProject() returning undefined and threw
    // `Cannot read properties of undefined (reading 'projectName')`. Re-setting
    // the return values here makes each test independent of prior restore state.
    vi.mocked(analyzeProject).mockResolvedValue({
      projectName: 'test-project',
      description: 'Test project',
      defaultBranch: 'main',
      languages: ['typescript'],
      frameworks: [],
      databases: [],
    } as Awaited<ReturnType<typeof analyzeProject>>);
    vi.mocked(generateClaudeMd).mockResolvedValue('# Test CLAUDE.md');
    vi.mocked(mergeClaudeMd).mockImplementation((existing: string, _new: string) => existing || _new);
    vi.mocked(isQdrantReachable).mockResolvedValue(true);
    vi.spyOn(console, 'log').mockImplementation(mockConsoleLog);
    vi.spyOn(console, 'error').mockImplementation(mockConsoleError);
    testDir = mkdtempSync(join(tmpdir(), 'uap-init-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(testDir, { recursive: true, force: true });
  });

  /**
   * The config initCommand actually wrote.
   *
   * Asserting on the artefact rather than on "did anything print an error"
   * keeps these tests about the flag under test. initCommand also initialises
   * a memory DB, probes Qdrant, builds a venv, runs git and indexes patterns;
   * any of those logging on a loaded machine used to fail a test nominally
   * about --no-memory.
   */
  function writtenConfig(dir: string): AgentContextConfig {
    const path = join(dir, '.uap.json');
    expect(existsSync(path), `initCommand wrote no .uap.json in ${dir}`).toBe(true);
    return JSON.parse(readFileSync(path, 'utf-8')) as AgentContextConfig;
  }

  it('should accept platform options', async () => {
    await initCommand({
      platform: ['claude', 'vscode'],
      memory: true,
      worktrees: true,
      projectDir: testDir,
    } satisfies InitOptions);

    const config = writtenConfig(testDir);
    expect(config.template?.sections?.memorySystem).toBe(true);
    expect(existsSync(join(testDir, 'CLAUDE.md'))).toBe(true);
  });

  it('should handle --no-memory flag', async () => {
    await initCommand({
      platform: ['all'],
      memory: false,
      worktrees: true,
      projectDir: testDir,
    } satisfies InitOptions);

    expect(writtenConfig(testDir).template?.sections?.memorySystem).toBe(false);
  });

  it('should handle --no-worktrees flag', async () => {
    await initCommand({
      platform: ['all'],
      memory: true,
      worktrees: false,
      projectDir: testDir,
    } satisfies InitOptions);

    expect(writtenConfig(testDir).template?.sections?.worktreeWorkflow).toBe(false);
  });

  it('should handle --force flag', async () => {
    await initCommand({
      platform: ['all'],
      memory: true,
      worktrees: true,
      force: true,
      projectDir: testDir,
    } satisfies InitOptions);

    expect(writtenConfig(testDir).template?.sections?.memorySystem).toBe(true);
  });

  it('should handle project directory override', async () => {
    // A real directory, and one that is NOT testDir, so "the override was
    // honoured" is something the test can actually observe. It used to pass
    // '/custom/path', which does not exist: the write failed, the command
    // logged the ENOENT, and the assertion passed anyway because the console
    // spy had already been restored. The error still reached the terminal on
    // every run and, when vitest attributed it to a file, failed the suite.
    const otherDir = mkdtempSync(join(tmpdir(), 'uap-init-override-'));
    try {
      await initCommand({
        platform: ['all'],
        memory: true,
        worktrees: true,
        projectDir: otherDir,
      } satisfies InitOptions);

      expect(writtenConfig(otherDir).template?.sections?.memorySystem).toBe(true);
      expect(existsSync(join(testDir, '.uap.json'))).toBe(false);
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it('should handle pipeline-only flag', async () => {
    await initCommand({
      platform: ['all'],
      memory: true,
      worktrees: true,
      pipelineOnly: true,
      projectDir: testDir,
    } satisfies InitOptions);

    expect(writtenConfig(testDir).template?.sections?.pipelineOnly).toBe(true);
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
