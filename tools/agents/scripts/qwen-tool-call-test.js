#!/usr/bin/env node
/**
 * Qwen3.5 Tool Call Test - Node.js Wrapper
 *
 * Cross-platform shim that finds Python and delegates to the
 * Python test suite script in the same directory.
 */

import { execFileSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { platform } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));

function getPythonExecutable() {
  if (platform() === 'win32') {
    return 'python';
  }
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' });
    return 'python3';
  } catch {
    return 'python';
  }
}

const pythonScript = join(__dirname, 'qwen_tool_call_test.py');
const args = process.argv.slice(2);

try {
  execFileSync(getPythonExecutable(), [pythonScript, ...args], {
    stdio: 'inherit',
    cwd: process.cwd(),
  });
} catch (error) {
  process.exit(error.status || 1);
}
