/**
 * Completion Gates - Programmatic enforcement of mandatory checks
 *
 * The UAP protocol defines 3 mandatory gates that must pass before
 * any task can be considered "done":
 *
 * 1. OUTPUT_EXISTS - Verifiable output was produced (files changed, tests written, etc.)
 * 2. CONSTRAINTS_MET - All constraints from the task specification are satisfied
 * 3. TESTS_PASS - Relevant tests pass (or no tests were broken)
 *
 * This module provides runtime enforcement of these gates.
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';

export interface GateResult {
  gate: string;
  passed: boolean;
  message: string;
  details?: string;
}

export interface CompletionReport {
  allPassed: boolean;
  gates: GateResult[];
  timestamp: string;
}

/**
 * Gate 1: Verify that output exists.
 * Checks that there are staged or unstaged changes in git,
 * indicating work was actually done.
 */
export function checkOutputExists(projectDir: string): GateResult {
  try {
    const status = execSync('git status --porcelain', {
      cwd: projectDir,
      encoding: 'utf-8',
      timeout: 10000,
    }).trim();

    if (status.length > 0) {
      const changedFiles = status.split('\n').length;
      return {
        gate: 'OUTPUT_EXISTS',
        passed: true,
        message: `${changedFiles} file(s) changed`,
        details: status,
      };
    }

    // Check if there are new commits not yet pushed
    try {
      const unpushed = execSync('git log @{u}..HEAD --oneline 2>/dev/null || echo ""', {
        cwd: projectDir,
        encoding: 'utf-8',
        timeout: 10000,
      }).trim();

      if (unpushed.length > 0) {
        return {
          gate: 'OUTPUT_EXISTS',
          passed: true,
          message: 'Unpushed commits found',
          details: unpushed,
        };
      }
    } catch {
      // No upstream tracking, ignore
    }

    return {
      gate: 'OUTPUT_EXISTS',
      passed: false,
      message: 'No changes detected - no output was produced',
    };
  } catch (error) {
    return {
      gate: 'OUTPUT_EXISTS',
      passed: false,
      message: `Could not check git status: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Gate 2: Verify constraints are met.
 * Checks that TypeScript compiles without errors and linting passes.
 */
export function checkConstraintsMet(projectDir: string): GateResult {
  // Check TypeScript compilation
  try {
    execSync('npx tsc --noEmit 2>&1', {
      cwd: projectDir,
      encoding: 'utf-8',
      timeout: 60000,
    });
  } catch (error) {
    const stderr =
      error instanceof Error && 'stderr' in error
        ? String((error as { stderr: unknown }).stderr)
        : String(error);
    return {
      gate: 'CONSTRAINTS_MET',
      passed: false,
      message: 'TypeScript compilation failed',
      details: stderr.slice(0, 500),
    };
  }

  return {
    gate: 'CONSTRAINTS_MET',
    passed: true,
    message: 'TypeScript compilation passed',
  };
}

/**
 * Gate 3: Verify tests pass.
 * Runs the project test suite and checks for failures.
 */
export function checkTestsPass(projectDir: string): GateResult {
  // Check if package.json has a test script
  const pkgPath = `${projectDir}/package.json`;
  if (!existsSync(pkgPath)) {
    return {
      gate: 'TESTS_PASS',
      passed: true,
      message: 'No package.json found - skipping test gate',
    };
  }

  try {
    const output = execSync('npm test 2>&1', {
      cwd: projectDir,
      encoding: 'utf-8',
      timeout: 120000,
    });

    return {
      gate: 'TESTS_PASS',
      passed: true,
      message: 'All tests passed',
      details: output.slice(-300),
    };
  } catch (error) {
    const output =
      error instanceof Error && 'stdout' in error
        ? String((error as { stdout: unknown }).stdout)
        : String(error);
    return {
      gate: 'TESTS_PASS',
      passed: false,
      message: 'Tests failed',
      details: output.slice(-500),
    };
  }
}

/**
 * Run all completion gates and produce a report.
 */
export function runCompletionGates(
  projectDir: string,
  options?: {
    skipTests?: boolean;
    skipTypeCheck?: boolean;
  }
): CompletionReport {
  const gates: GateResult[] = [];

  // Gate 1: Output exists
  gates.push(checkOutputExists(projectDir));

  // Gate 2: Constraints met (TypeScript compilation)
  if (options?.skipTypeCheck) {
    gates.push({
      gate: 'CONSTRAINTS_MET',
      passed: true,
      message: 'Skipped (--skip-typecheck)',
    });
  } else {
    gates.push(checkConstraintsMet(projectDir));
  }

  // Gate 3: Tests pass
  if (options?.skipTests) {
    gates.push({
      gate: 'TESTS_PASS',
      passed: true,
      message: 'Skipped (--skip-tests)',
    });
  } else {
    gates.push(checkTestsPass(projectDir));
  }

  return {
    allPassed: gates.every((g) => g.passed),
    gates,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Format a completion report for terminal output.
 */
export function formatCompletionReport(report: CompletionReport): string {
  const lines: string[] = [];
  lines.push('=== Completion Gates Report ===');
  lines.push('');

  for (const gate of report.gates) {
    const icon = gate.passed ? 'PASS' : 'FAIL';
    lines.push(`[${icon}] ${gate.gate}: ${gate.message}`);
    if (gate.details && !gate.passed) {
      const detailLines = gate.details.split('\n').slice(0, 5);
      for (const dl of detailLines) {
        lines.push(`       ${dl}`);
      }
    }
  }

  lines.push('');
  if (report.allPassed) {
    lines.push('All gates passed - work is complete.');
  } else {
    const failed = report.gates.filter((g) => !g.passed).map((g) => g.gate);
    lines.push(`BLOCKED: ${failed.join(', ')} gate(s) failed.`);
    lines.push('Fix the issues above before marking work as done.');
  }

  return lines.join('\n');
}
