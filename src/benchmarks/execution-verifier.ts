/**
 * Execution Verification System for UAP Benchmarks
 *
 * Provides real code execution and verification instead of just pattern matching.
 * Runs generated code in isolated environments and validates output.
 */

import { execSync, spawn } from 'child_process';
import { writeFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

export interface TestCase {
  input: string;
  expectedOutput: string;
  description?: string;
}

export interface VerificationResult {
  success: boolean;
  executionSucceeded: boolean;
  testsRun: number;
  testsPassed: number;
  errors: string[];
  output: string;
  executionTimeMs: number;
}

export interface TaskVerificationConfig {
  language: 'typescript' | 'javascript' | 'python' | 'shell';
  setupCommands?: string[];
  testCases: TestCase[];
  expectedPatterns?: string[];
  timeout?: number;
  requiresExecution?: boolean;
}

const SANDBOX_DIR = '/tmp/uap-sandbox';

/**
 * Extract code from markdown code blocks
 * Models often wrap code in ```typescript ... ``` or ```ts ... ```
 */
function extractCodeFromMarkdown(response: string): string {
  // Try to extract code from markdown code blocks
  const codeBlockPatterns = [
    /```(?:typescript|ts)\n([\s\S]*?)```/gi,
    /```(?:javascript|js)\n([\s\S]*?)```/gi,
    /```(?:python|py)\n([\s\S]*?)```/gi,
    /```(?:bash|sh|shell)\n([\s\S]*?)```/gi,
    /```\n([\s\S]*?)```/gi, // Generic code block
  ];

  for (const pattern of codeBlockPatterns) {
    const matches = [...response.matchAll(pattern)];
    if (matches.length > 0) {
      // Return all code blocks concatenated (some responses have multiple blocks)
      return matches.map((m) => m[1].trim()).join('\n\n');
    }
  }

  // No code blocks found - check if response looks like raw code
  const trimmed = response.trim();

  // If it starts with typical code patterns, use as-is
  const codeIndicators = [
    /^(import|export|function|class|interface|type|const|let|var|async|def )/,
    /^#!\//, // Shebang
    /^\/\*\*/, // JSDoc
    /^\/\//, // Comment
    /^#[^!]/, // Python/shell comment (not shebang)
  ];

  for (const indicator of codeIndicators) {
    if (indicator.test(trimmed)) {
      return trimmed;
    }
  }

  // Last resort: return as-is, let the compiler/interpreter fail with a clear error
  return trimmed;
}

/**
 * Create an isolated sandbox for code execution
 */
function createSandbox(): string {
  const sandboxId = randomUUID().slice(0, 8);
  const sandboxPath = join(SANDBOX_DIR, sandboxId);

  if (!existsSync(SANDBOX_DIR)) {
    mkdirSync(SANDBOX_DIR, { recursive: true });
  }

  mkdirSync(sandboxPath, { recursive: true });
  return sandboxPath;
}

/**
 * Clean up sandbox after execution
 */
function cleanupSandbox(sandboxPath: string): void {
  try {
    rmSync(sandboxPath, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Verify generated code by executing it
 */
export async function verifyCodeExecution(
  code: string,
  config: TaskVerificationConfig
): Promise<VerificationResult> {
  const startTime = Date.now();
  const result: VerificationResult = {
    success: false,
    executionSucceeded: false,
    testsRun: 0,
    testsPassed: 0,
    errors: [],
    output: '',
    executionTimeMs: 0,
  };

  // Extract code from markdown if wrapped
  const cleanCode = extractCodeFromMarkdown(code);

  // If execution not required, just do pattern matching
  if (!config.requiresExecution) {
    return verifyPatterns(cleanCode, config.expectedPatterns || []);
  }

  const sandboxPath = createSandbox();

  try {
    // Write code to file
    const filename = getFilename(config.language);
    const filePath = join(sandboxPath, filename);
    writeFileSync(filePath, cleanCode, 'utf-8');

    // Run setup commands if any
    if (config.setupCommands) {
      for (const cmd of config.setupCommands) {
        try {
          execSync(cmd, {
            cwd: sandboxPath,
            timeout: 30000,
            stdio: 'pipe',
          });
        } catch (error) {
          result.errors.push(`Setup failed: ${cmd}`);
        }
      }
    }

    // Compile if TypeScript
    if (config.language === 'typescript') {
      try {
        execSync(`npx tsc ${filename} --outDir . --esModuleInterop --skipLibCheck 2>&1`, {
          cwd: sandboxPath,
          timeout: 30000,
          encoding: 'utf-8',
        });
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        result.errors.push(`TypeScript compilation failed: ${errMsg}`);
        result.executionTimeMs = Date.now() - startTime;
        cleanupSandbox(sandboxPath);
        return result;
      }
    }

    result.executionSucceeded = true;

    // Run test cases
    for (const testCase of config.testCases) {
      result.testsRun++;

      try {
        const output = await runTestCase(sandboxPath, config.language, testCase, config.timeout);
        const normalizedOutput = output.trim();
        const normalizedExpected = testCase.expectedOutput.trim();

        if (normalizedOutput === normalizedExpected) {
          result.testsPassed++;
        } else {
          result.errors.push(
            `Test "${testCase.description || 'unnamed'}": Expected "${normalizedExpected}", got "${normalizedOutput}"`
          );
        }

        result.output += output + '\n';
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        result.errors.push(`Test execution error: ${errMsg}`);
      }
    }

    // Verify patterns if specified
    if (config.expectedPatterns && config.expectedPatterns.length > 0) {
      const patternResult = verifyPatterns(cleanCode, config.expectedPatterns);
      if (!patternResult.success) {
        result.errors.push(...patternResult.errors);
      }
    }

    result.success = result.testsPassed === result.testsRun && result.errors.length === 0;
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    result.errors.push(`Verification error: ${errMsg}`);
  } finally {
    cleanupSandbox(sandboxPath);
  }

  result.executionTimeMs = Date.now() - startTime;
  return result;
}

/**
 * Run a single test case
 */
async function runTestCase(
  sandboxPath: string,
  language: TaskVerificationConfig['language'],
  testCase: TestCase,
  timeout: number = 10000
): Promise<string> {
  const commands: Record<string, string> = {
    typescript: `node ${getFilename('javascript')}`,
    javascript: `node ${getFilename('javascript')}`,
    python: `python3 ${getFilename('python')}`,
    shell: `bash ${getFilename('shell')}`,
  };

  const command = `${commands[language]} ${testCase.input}`;

  return new Promise((resolve, reject) => {
    const proc = spawn('bash', ['-c', command], {
      cwd: sandboxPath,
      timeout,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('Execution timeout'));
    }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`Exit code ${code}: ${stderr}`));
      }
    });

    proc.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/**
 * Verify code contains expected patterns (fallback verification)
 */
function verifyPatterns(code: string, patterns: string[]): VerificationResult {
  const result: VerificationResult = {
    success: false,
    executionSucceeded: true,
    testsRun: patterns.length,
    testsPassed: 0,
    errors: [],
    output: '',
    executionTimeMs: 0,
  };

  const normalizedCode = code.toLowerCase();

  for (const pattern of patterns) {
    if (normalizedCode.includes(pattern.toLowerCase())) {
      result.testsPassed++;
    } else {
      result.errors.push(`Missing pattern: "${pattern}"`);
    }
  }

  // Success if at least 70% of patterns match (more strict than before)
  const matchRatio = result.testsPassed / result.testsRun;
  result.success = matchRatio >= 0.7;

  return result;
}

/**
 * Get appropriate filename for language
 */
function getFilename(language: TaskVerificationConfig['language']): string {
  const extensions: Record<string, string> = {
    typescript: 'solution.ts',
    javascript: 'solution.js',
    python: 'solution.py',
    shell: 'solution.sh',
  };
  return extensions[language];
}

/**
 * Enhanced task verification configurations for benchmark tasks
 */
export const TASK_VERIFICATION_CONFIGS: Record<string, TaskVerificationConfig> = {
  'task-001-code-generation': {
    language: 'typescript',
    requiresExecution: false, // Pattern matching only - model output won't have test harness
    testCases: [],
    expectedPatterns: ['function calculateAverage', 'number[]', ': number', 'length', 'return'],
  },

  'task-002-bug-fix': {
    language: 'typescript',
    requiresExecution: false,
    testCases: [],
    expectedPatterns: ['i < nums.length', 'function sumPositive', 'return sum'],
  },

  'task-003-pattern-application': {
    language: 'typescript',
    requiresExecution: false,
    testCases: [],
    expectedPatterns: [
      'class ConfigManager',
      'private constructor',
      'static getInstance',
      'private static instance',
      'Map',
    ],
  },

  'task-004-refactoring': {
    language: 'typescript',
    requiresExecution: false,
    testCases: [],
    expectedPatterns: ['interface', 'class', 'implements', 'process'],
  },

  'task-005-memory-context': {
    language: 'typescript',
    requiresExecution: false,
    testCases: [],
    expectedPatterns: ['async', 'zod', 'AppError', '@param', 'validateAndParseJSON'],
  },

  'task-006-complex-algorithm': {
    language: 'typescript',
    requiresExecution: false,
    testCases: [],
    expectedPatterns: ['function findShortestPath', 'Map<string', 'distance', 'path', 'while'],
  },

  'task-007-multi-step-task': {
    language: 'typescript',
    requiresExecution: false,
    testCases: [],
    expectedPatterns: [
      'interface RateLimiterConfig',
      'class RateLimiter',
      'isAllowed',
      'getRemainingRequests',
      'reset',
      'Map',
      'export',
    ],
  },

  'task-008-error-handling': {
    language: 'typescript',
    requiresExecution: false,
    testCases: [],
    expectedPatterns: ['async function fetchWithRetry', 'retry', 'backoff', 'catch', 'throw'],
  },
};

/**
 * Verify a benchmark task result
 */
export async function verifyBenchmarkTask(
  taskId: string,
  generatedCode: string
): Promise<VerificationResult> {
  const config = TASK_VERIFICATION_CONFIGS[taskId];

  if (!config) {
    // Fallback to basic pattern verification
    return {
      success: generatedCode.length > 50,
      executionSucceeded: true,
      testsRun: 1,
      testsPassed: generatedCode.length > 50 ? 1 : 0,
      errors: generatedCode.length <= 50 ? ['Response too short'] : [],
      output: '',
      executionTimeMs: 0,
    };
  }

  return verifyCodeExecution(generatedCode, config);
}
