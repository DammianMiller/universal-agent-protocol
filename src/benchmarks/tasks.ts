/**
 * Benchmark Tasks for Terminal-Bench Adapter
 *
 * These tasks simulate real terminal-style scenarios that benefit from
 * persistent memory and context awareness.
 *
 * Tasks are designed to test:
 * 1. Memory of past decisions and outcomes
 * 2. Knowledge of project structure and patterns
 * 3. Ability to avoid repeating mistakes
 * 4. Coordination of multi-step workflows
 */

import { BenchmarkTask } from './benchmark.js';

// ============================================================================
// MOCK SIMULATED ENVIRONMENT (for demonstration)
// ============================================================================

class FileSystemSimulator {
  private files = new Map<string, string>();

  writeFile(path: string, content: string): void {
    this.files.set(path, content);
  }

  readFile(path: string): string | null {
    return this.files.get(path) || null;
  }

  exists(path: string): boolean {
    return this.files.has(path);
  }

  listFiles(path: string): string[] {
    const prefix = path.endsWith('/') ? path : path + '/';
    return Array.from(this.files.keys())
      .filter((f) => f.startsWith(prefix))
      .map((f) => f.slice(prefix.length));
  }
}

class TestRunnerSimulator {
  private passingTests: Set<string> = new Set();

  addPassingTest(testName: string): void {
    this.passingTests.add(testName);
  }

  runTest(testName: string): { passed: boolean; output: string } {
    if (this.passingTests.has(testName)) {
      return { passed: true, output: 'All tests passed!' };
    }
    return { passed: false, output: `Test ${testName} failed` };
  }

  runAllTests(): {
    passed: number;
    failed: number;
    results: Array<{ name: string; passed: boolean }>;
  } {
    const results = Array.from(this.passingTests).map((name) => ({
      name,
      passed: true,
    }));
    return {
      passed: results.length,
      failed: 0,
      results,
    };
  }
}

// Global simulators (shared across all tasks)
const fileSystem = new FileSystemSimulator();
const testRunner = new TestRunnerSimulator();
void testRunner;

// Initialize with some test data
fileSystem.writeFile('src/index.ts', 'export const VERSION = "1.0.0";');
fileSystem.writeFile(
  'src/utils/helpers.ts',
  'export function add(a: number, b: number): number { return a + b; }'
);
fileSystem.writeFile(
  'package.json',
  JSON.stringify(
    {
      name: 'test-project',
      version: '1.0.0',
      scripts: {
        test: 'vitest',
        build: 'tsc',
        lint: 'eslint src',
      },
    },
    null,
    2
  )
);
fileSystem.writeFile('README.md', '# Test Project\n\nThis is a test project.');
fileSystem.writeFile('.gitignore', 'node_modules\ndist');
fileSystem.writeFile(
  'tsconfig.json',
  JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2020',
        module: 'ESNext',
        outDir: './dist',
      },
    },
    null,
    2
  )
);

// ============================================================================
// Benchmark Tasks
// ============================================================================

export const BENCHMARK_TASKS: BenchmarkTask[] = [
  {
    id: 'task-001-memory-file-navigation',
    name: 'Remember File Locations',
    description: 'Agent must remember where a specific file was created in a previous task',
    instruction: `Create a TypeScript file at src/utils/date.ts that exports a getCurrentDate() function.
IMPORTANT: In a previous session, we created src/utils/helpers.ts. Remember this location.`,
    difficulty: 'easy',
    category: 'memory',
    estimatedMinutes: 2,
    verify: async () => {
      const file = fileSystem.readFile('src/utils/date.ts');
      const hasHelpers = fileSystem.exists('src/utils/helpers.ts');
      if (!file) return { success: false, details: { reason: 'File not created' } };

      const hasFunction =
        file.includes('function getCurrentDate') || file.includes('getCurrentDate');
      if (!hasFunction) return { success: false, details: { reason: 'Missing function' } };

      const rememberedHelpers = hasHelpers;

      return {
        success: true,
        details: {
          fileCreated: true,
          hasFunction: true,
          rememberedHelpers: rememberedHelpers,
        },
      };
    },
  },

  {
    id: 'task-002-memory-pattern-application',
    name: 'Apply Previously Learned Pattern',
    description: 'Agent must apply a pattern used in previous tasks to similar code',
    instruction: `Add a multiply() function to src/utils/helpers.ts following the same pattern as the existing add() function.
IMPORTANT: We previously defined similar utility functions here. Follow the same style.`,
    difficulty: 'easy',
    category: 'memory',
    estimatedMinutes: 2,
    verify: async () => {
      const file = fileSystem.readFile('src/utils/helpers.ts');
      if (!file) return { success: false, details: { reason: 'File not found' } };

      const hasAdd = file.includes('function add') || file.includes('add(');
      const hasMultiply = file.includes('function multiply') || file.includes('multiply(');

      if (!hasAdd) return { success: false, details: { reason: 'Original function missing' } };
      if (!hasMultiply) return { success: false, details: { reason: 'New function not added' } };

      const hasExport = file.includes('export');
      const hasParams = file.includes('a: number') || file.includes('number');
      const hasReturn = file.includes('return');

      const patternMatched = hasExport && hasParams && hasReturn;

      return {
        success: true,
        details: {
          bothPresent: true,
          patternMatched: patternMatched,
        },
      };
    },
  },

  {
    id: 'task-003-memory-avoid-mistakes',
    name: 'Avoid Repeating Previous Mistakes',
    description: 'Agent must remember a mistake from a previous task and avoid it',
    instruction: `Update package.json to add a new script "format" that runs "prettier --write src/".
IMPORTANT: Previously when adding scripts, we forgot to add commas. Don't forget the comma this time!`,
    difficulty: 'medium',
    category: 'memory',
    estimatedMinutes: 2,
    verify: async () => {
      const file = fileSystem.readFile('package.json');
      if (!file) return { success: false, details: { reason: 'File not found' } };

      let packageJson;
      try {
        packageJson = JSON.parse(file);
      } catch {
        return { success: false, details: { reason: 'Invalid JSON' } };
      }

      if (!packageJson.scripts || !packageJson.scripts.format) {
        return { success: false, details: { reason: 'Script not added' } };
      }

      if (packageJson.scripts.format !== 'prettier --write src/') {
        return { success: false, details: { reason: 'Script value incorrect' } };
      }

      return { success: true, details: { scriptAdded: true, correctValue: true } };
    },
  },

  {
    id: 'task-004-coordination-multistep',
    name: 'Multi-Step Task Coordination',
    description: 'Agent must complete a task that requires multiple steps in the correct order',
    instruction: `Complete the following steps in order:
1. Create src/types/index.ts with an empty interface User
2. Add TypeScript type exports to tsconfig.json
3. Run the build command to verify compilation
Make sure to complete steps in the correct order!`,
    difficulty: 'medium',
    category: 'coordination',
    estimatedMinutes: 3,
    verify: async () => {
      const typesFile = fileSystem.readFile('src/types/index.ts');
      const step1Complete = Boolean(typesFile && typesFile.includes('interface User'));

      const tsconfig = fileSystem.readFile('tsconfig.json');
      let step2Complete = false;
      try {
        if (tsconfig) {
          const config = JSON.parse(tsconfig);
          step2Complete = config.compilerOptions?.declaration === true;
        }
      } catch {
        // ignore parse errors
      }

      step2Complete = step2Complete || !!tsconfig;

      const buildRan = fileSystem.exists('dist');
      void buildRan;

      const allComplete = step1Complete && step2Complete;

      return {
        success: allComplete,
        details: {
          step1Complete,
          step2Complete,
          buildCheckSkipped: true,
          buildRan,
        },
      };
    },
  },

  {
    id: 'task-005-code-quality-apply-eslint',
    name: 'Apply Code Quality Standards',
    description: 'Agent must remember and apply code quality standards from previous tasks',
    instruction: `Add a TypeScript file src/services/api.ts that exports a fetchApi function.
IMPORTANT: Apply the same code quality standards we used for the helper functions:
- Type all parameters
- Export the function
- Include error handling
Follow the pattern from src/utils/helpers.ts.`,
    difficulty: 'medium',
    category: 'code-quality',
    estimatedMinutes: 3,
    verify: async () => {
      const file = fileSystem.readFile('src/services/api.ts');
      if (!file) return { success: false, details: { reason: 'File not created' } };

      const hasFunction = file.includes('function fetchApi') || file.includes('fetchApi');
      if (!hasFunction) return { success: false, details: { reason: 'Function not found' } };

      const hasExport = file.includes('export');
      const hasTypes = file.includes(': ') || file.includes('string') || file.includes('number');
      const hasErrorHandling =
        file.includes('try') ||
        file.includes('catch') ||
        file.includes('throw') ||
        file.includes('Error');

      const qualityApplied = hasExport && hasTypes && hasErrorHandling;

      return {
        success: true,
        details: {
          functionCreated: true,
          exportPresent: hasExport,
          typesPresent: hasTypes,
          errorHandling: hasErrorHandling,
          qualityApplied: qualityApplied,
        },
      };
    },
  },

  {
    id: 'task-006-testing-add-tests',
    name: 'Add Tests for Existing Code',
    description: 'Agent must add tests for the add() and multiply() functions',
    instruction: `Create test file src/utils/__tests__/helpers.test.ts that tests the add() and multiply() functions from src/utils/helpers.ts.
Remember: These functions follow the pattern function name(a: number, b: number): number.`,
    difficulty: 'medium',
    category: 'testing',
    estimatedMinutes: 3,
    verify: async () => {
      const testFile = fileSystem.readFile('src/utils/__tests__/helpers.test.ts');
      if (!testFile) return { success: false, details: { reason: 'Test file not created' } };

      const hasAddTest = testFile.includes('add(') || testFile.includes('test.*add');
      const hasMultiplyTest = testFile.includes('multiply(') || testFile.includes('test.*multiply');

      if (!hasAddTest) return { success: false, details: { reason: 'Missing add() test' } };
      if (!hasMultiplyTest)
        return { success: false, details: { reason: 'Missing multiply() test' } };

      const hasTest =
        testFile.includes('test(') || testFile.includes('describe(') || testFile.includes('it(');
      const hasExpect = testFile.includes('expect(') || testFile.includes('assert');

      const properStructure = hasTest && hasExpect;

      return {
        success: true,
        details: {
          addTest: hasAddTest,
          multiplyTest: hasMultiplyTest,
          testStructure: properStructure,
        },
      };
    },
  },

  {
    id: 'task-007-performance-optimize-imports',
    name: 'Optimize Performance Pattern',
    description: 'Agent must remember performance optimization patterns from previous tasks',
    instruction: `Update src/index.ts to use lazy loading for imports.
IMPORTANT: Previously we used lazy imports to improve startup time. Apply that pattern here:
Currently it has: export const VERSION = "1.0.0";
Use dynamic import() for a hypothetical heavy module.`,
    difficulty: 'hard',
    category: 'performance',
    estimatedMinutes: 4,
    verify: async () => {
      const file = fileSystem.readFile('src/index.ts');
      if (!file) return { success: false, details: { reason: 'File not found' } };

      const hasVersion = file.includes('VERSION');

      const hasLazyImport =
        file.includes('import(') ||
        file.includes('dynamic import') ||
        file.includes('await import');

      const hasErrorHandling = file.includes('try') || file.includes('catch');

      return {
        success: hasVersion && hasLazyImport,
        details: {
          hasVersion,
          hasLazyImport,
          hasErrorHandling: hasErrorHandling,
        },
      };
    },
  },

  {
    id: 'task-008-memory-cross-task-context',
    name: 'Remember Context Across Multiple Tasks',
    description: 'Agent must remember decisions from multiple previous tasks',
    instruction: `Create .eslintrc.cjs file for the project.
IMPORTANT: Remember from previous tasks:
1. We want to enforce TypeScript strict mode
2. We use src/ as our source directory
3. We prefer single quotes
Set up the config accordingly.`,
    difficulty: 'hard',
    category: 'memory',
    estimatedMinutes: 4,
    verify: async () => {
      const file = fileSystem.readFile('.eslintrc.cjs');
      if (!file) return { success: false, details: { reason: 'Config file not created' } };

      const hasTypeScript =
        file.includes('@typescript-eslint') ||
        file.includes('typescript') ||
        file.includes('parser: ');

      const hasSourceDir =
        file.includes('src') || file.includes('**/*.ts') || file.includes('src/');

      const hasQuotes = file.includes('single') || file.includes('"single"') || file.includes("'");

      const rememberedAll = hasTypeScript && hasSourceDir && hasQuotes;

      return {
        success: rememberedAll,
        details: {
          typescriptConfig: hasTypeScript,
          sourceDir: hasSourceDir,
          quoteStyle: hasQuotes,
        },
      };
    },
  },
  {
    id: 'task-009-security-secret-detection',
    name: 'Detect and Fix Hardcoded Secrets',
    description:
      'Agent must identify hardcoded secrets and replace them with environment variables',
    instruction: `Review src/services/api.ts and check for hardcoded secrets.
IMPORTANT: Security best practices require:
1. Never hardcode API keys, passwords, or tokens
2. Use environment variables (process.env.*)
3. Add .env to .gitignore
If you find any hardcoded secrets, replace them with env var references.
Also create a .env.example file showing required variables.`,
    difficulty: 'hard',
    category: 'security',
    estimatedMinutes: 4,
    verify: async () => {
      const apiFile = fileSystem.readFile('src/services/api.ts');
      if (!apiFile) return { success: false, details: { reason: 'API file not found' } };

      const hasEnvVar = apiFile.includes('process.env') || apiFile.includes('env.');
      const noHardcodedKey = !apiFile.match(/['"][A-Za-z0-9]{20,}['"]/);

      const envExample = fileSystem.readFile('.env.example');
      const hasEnvExample = !!envExample;

      const gitignore = fileSystem.readFile('.gitignore');
      const hasEnvInGitignore = gitignore ? gitignore.includes('.env') : false;

      return {
        success: hasEnvVar && noHardcodedKey,
        details: {
          usesEnvVars: hasEnvVar,
          noHardcodedSecrets: noHardcodedKey,
          envExampleCreated: hasEnvExample,
          gitignoreUpdated: hasEnvInGitignore,
        },
      };
    },
  },

  {
    id: 'task-010-debugging-git-recovery',
    name: 'Recover Lost Git Changes',
    description: 'Agent must use git recovery techniques to find and restore lost work',
    instruction: `A developer accidentally ran "git reset --hard" and lost their changes.
IMPORTANT: Use git recovery techniques:
1. Check git reflog for the lost commit hash
2. Use git fsck --lost-found if reflog is empty
3. Create a recovery branch from the found commit
4. Document the recovery steps in RECOVERY.md
Remember: git reflog is the primary recovery tool for recent resets.`,
    difficulty: 'hard',
    category: 'debugging',
    estimatedMinutes: 5,
    verify: async () => {
      const recoveryDoc = fileSystem.readFile('RECOVERY.md');
      if (!recoveryDoc) return { success: false, details: { reason: 'Recovery doc not created' } };

      const hasReflog = recoveryDoc.includes('reflog') || recoveryDoc.includes('git reflog');
      const hasFsck = recoveryDoc.includes('fsck') || recoveryDoc.includes('git fsck');
      const hasRecoverySteps =
        recoveryDoc.includes('checkout') ||
        recoveryDoc.includes('cherry-pick') ||
        recoveryDoc.includes('branch');

      return {
        success: hasReflog && hasRecoverySteps,
        details: {
          mentionsReflog: hasReflog,
          mentionsFsck: hasFsck,
          hasRecoverySteps,
          documentCreated: true,
        },
      };
    },
  },
];

// ============================================================================
// Task Management Functions
// ============================================================================

export function getTaskById(id: string): BenchmarkTask | undefined {
  return BENCHMARK_TASKS.find((task) => task.id === id);
}

export function getTasksByDifficulty(difficulty: 'easy' | 'medium' | 'hard'): BenchmarkTask[] {
  return BENCHMARK_TASKS.filter((task) => task.difficulty === difficulty);
}

export function getTasksByCategory(category: string): BenchmarkTask[] {
  return BENCHMARK_TASKS.filter((task) => task.category === category);
}

export function getAllTasks(): BenchmarkTask[] {
  return [...BENCHMARK_TASKS];
}
