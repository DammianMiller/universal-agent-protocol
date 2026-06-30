/**
 * Recipe signal (cross-process): the reactor writes per-prompt routing signals
 * that the serving-layer proxy consumes for recipe selection. Keyed by a hash
 * of the normalized prompt (identical algorithm to the Python proxy), plus a
 * rolling latest.json for the single-session common case. Fails open.
 */
import { createHash } from 'crypto';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

import { measureQueryComplexity } from '../utils/query-complexity.js';
import { getCapabilityRouter, type CapabilityRouter } from './capability-router.js';

const CODE_CAPS = new Set([
  'typescript', 'javascript', 'python', 'rust', 'go', 'cpp', 'java',
  'frontend', 'backend', 'cli', 'api-design',
]);
const REASONING_CAPS = new Set(['architecture', 'product', 'test-strategy', 'compliance']);

export interface RecipeSignal {
  ts: number;
  promptHash: string;
  complexity: string;
  capabilities: string[];
  shape: string;
  recipe: string;
  confidence: number;
}

export function normalizePrompt(text: string): string {
  return (text || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function promptHash(text: string): string {
  return createHash('sha1').update(normalizePrompt(text)).digest('hex');
}

export function computeRecipeSignal(
  promptText: string,
  router: CapabilityRouter = getCapabilityRouter()
): RecipeSignal {
  const complexity = measureQueryComplexity(promptText); // simple | moderate | complex
  let capabilities: string[] = [];
  let confidence = 0;
  try {
    const r = router.routeTask({
      id: 'react-signal', title: promptText, type: 'task', status: 'open',
      priority: 2, labels: [], createdAt: '1970-01-01T00:00:00.000Z',
      updatedAt: '1970-01-01T00:00:00.000Z',
    } as never);
    capabilities = (r as { matchedCapabilities?: string[] }).matchedCapabilities ?? [];
    confidence = (r as { confidence?: number }).confidence ?? 0;
  } catch {
    /* fall back to text-only shape */
  }
  const shape = capabilities.some((c) => REASONING_CAPS.has(c))
    ? 'reasoning'
    : capabilities.some((c) => CODE_CAPS.has(c))
      ? 'code'
      : /\b(prove|why|explain|derive|which of|true or false)\b/i.test(promptText)
        ? 'reasoning'
        : 'general';
  const recipe = complexity === 'complex' || shape === 'reasoning' ? 'fusion' : 'confidence';
  return {
    ts: Date.now() / 1000,
    promptHash: promptHash(promptText),
    complexity,
    capabilities,
    shape,
    recipe,
    confidence,
  };
}

export function signalDir(dir?: string): string {
  return dir || process.env.UAP_RECIPE_SIGNAL_DIR || join(homedir(), '.cache', 'uap', 'recipe-signals');
}

export function writeRecipeSignal(sig: RecipeSignal, dir?: string): void {
  try {
    const d = signalDir(dir);
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
    const data = JSON.stringify(sig);
    writeFileSync(join(d, `${sig.promptHash}.json`), data);
    writeFileSync(join(d, 'latest.json'), data);
  } catch {
    /* fail open — the proxy falls back to its own signal extraction */
  }
}

/** Best-effort: compute + write the signal for a prompt. Never throws. */
export function maybeWriteRecipeSignal(promptText: string, dir?: string): void {
  if (!promptText || !promptText.trim()) return;
  try {
    writeRecipeSignal(computeRecipeSignal(promptText), dir);
  } catch {
    /* fail open */
  }
}
