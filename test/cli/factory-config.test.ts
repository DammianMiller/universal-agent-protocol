import { describe, it, expect, vi, beforeEach } from 'vitest';
import { initCommand, type InitOptions } from '../../src/cli/init.js';

const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  copyFileSync: vi.fn(),
  chmodSync: vi.fn(),
}));

vi.mock('fs', () => fsMocks);

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
  mergeClaudeMd: vi.fn((existing: string, _next: string) => existing || _next),
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
  isQdrantReachable: vi.fn().mockResolvedValue(false),
}));

describe('factory config defaults', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes .factory/config.json with contextLevel=quiet by default', async () => {
    fsMocks.existsSync.mockImplementation((path: string) => path.endsWith('CLAUDE.md'));

    const options: InitOptions = {
      platform: ['factory'],
      memory: true,
      worktrees: true,
    };

    await initCommand(options);

    const configWrite = fsMocks.writeFileSync.mock.calls.find(([path]) =>
      String(path).endsWith('/.factory/config.json')
    );
    expect(configWrite).toBeTruthy();
    const config = JSON.parse(String(configWrite?.[1]));
    expect(config.contextLevel).toBe('quiet');
  });

  it('preserves existing contextLevel in .factory/config.json', async () => {
    fsMocks.existsSync.mockImplementation((path: string) => {
      if (path.endsWith('/.factory/config.json')) return true;
      return path.endsWith('CLAUDE.md');
    });
    fsMocks.readFileSync.mockImplementation((path: string) => {
      if (String(path).endsWith('/.factory/config.json')) {
        return JSON.stringify({ contextLevel: 'verbose' });
      }
      return '';
    });

    const options: InitOptions = {
      platform: ['factory'],
      memory: true,
      worktrees: true,
    };

    await initCommand(options);

    const configWrite = fsMocks.writeFileSync.mock.calls.find(([path]) =>
      String(path).endsWith('/.factory/config.json')
    );
    expect(configWrite).toBeTruthy();
    const config = JSON.parse(String(configWrite?.[1]));
    expect(config.contextLevel).toBe('verbose');
  });
});
