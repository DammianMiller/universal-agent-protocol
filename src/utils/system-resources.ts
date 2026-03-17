/**
 * System Resource Detection
 *
 * Provides vCPU, VRAM, and memory detection with caching.
 * Used to auto-tune parallelism across the UAP system.
 *
 * Env override: UAP_MAX_PARALLEL always takes precedence.
 * Precedence: env var → config → auto-detect → hardcoded default
 */

import { cpus, totalmem } from 'os';
import { execSync } from 'child_process';

export interface SystemResources {
  /** Number of logical CPUs (vCPUs / hardware threads) */
  vCPUs: number;
  /** GPU VRAM in GB (0 if no GPU detected) */
  vramGB: number;
  /** System RAM in GB */
  memoryGB: number;
}

let _cached: SystemResources | null = null;

/**
 * Detect system resources (cached after first call).
 */
export function detectSystemResources(): SystemResources {
  if (_cached) return _cached;

  const vCPUs = cpus().length;
  const memoryGB = Math.round(totalmem() / 1024 ** 3);

  let vramGB = 0;
  try {
    // NVIDIA GPU
    const out = execSync('nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits', {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    vramGB = Math.round(parseInt(out.trim().split('\n')[0], 10) / 1024);
  } catch {
    try {
      // macOS unified memory (report as VRAM since GPU shares it)
      const out = execSync('sysctl -n hw.memsize', {
        encoding: 'utf-8',
        timeout: 3000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      vramGB = Math.min(Math.round(parseInt(out.trim(), 10) / 1024 ** 3), 48);
    } catch {
      // No GPU detected
    }
  }

  _cached = { vCPUs, vramGB, memoryGB };
  return _cached;
}

/**
 * Compute safe parallelism ceiling.
 *
 * @param mode - 'cpu' for compute-bound work (reserves cores for OS + inference),
 *               'io' for IO-bound work like API calls (higher concurrency safe)
 * @returns Maximum number of concurrent operations
 *
 * Precedence:
 *   1. UAP_MAX_PARALLEL env var (always wins)
 *   2. Auto-detected from os.cpus()
 *   3. Hardcoded fallback (3)
 */
export function getMaxParallel(mode: 'cpu' | 'io' = 'io'): number {
  const envOverride = process.env.UAP_MAX_PARALLEL;
  if (envOverride) {
    const parsed = parseInt(envOverride, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }

  const { vCPUs } = detectSystemResources();

  if (mode === 'cpu') {
    // Reserve 2 cores for OS + inference server
    return Math.max(1, vCPUs - 2);
  }

  // IO-bound: safe to use more concurrency, cap at 8 to avoid
  // overwhelming local inference endpoints
  return Math.max(1, Math.min(vCPUs, 8));
}

/**
 * Check if parallelism is globally enabled.
 *
 * Precedence:
 *   1. UAP_PARALLEL env var ('false' disables)
 *   2. Default: true
 */
export function isParallelEnabled(): boolean {
  return process.env.UAP_PARALLEL !== 'false';
}

/**
 * Reset cached resources (for testing).
 */
export function resetResourceCache(): void {
  _cached = null;
}
