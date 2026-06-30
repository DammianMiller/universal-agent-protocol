import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  promptHash, normalizePrompt, computeRecipeSignal, writeRecipeSignal, maybeWriteRecipeSignal,
} from '../../src/coordination/recipe-signal';

describe('recipe-signal', () => {
  it('normalizes + hashes deterministically (matches the Python proxy)', () => {
    expect(normalizePrompt('  Build The   Thing  ')).toBe('build the thing');
    // sha1 of "build the thing" — the proxy computes the identical hash.
    expect(promptHash('  Build The   Thing  ')).toBe(promptHash('build the thing'));
    expect(promptHash('a')).toMatch(/^[0-9a-f]{40}$/);
  });

  it('computeRecipeSignal: complex/reasoning -> fusion, simple -> confidence', () => {
    const hard = computeRecipeSignal('fix the bug in src/a.ts and then update the tests');
    expect(hard.complexity).toBe('complex');
    expect(hard.recipe).toBe('fusion');
    const easy = computeRecipeSignal('add a button');
    expect(easy.recipe).toBe('confidence');
    const reasoning = computeRecipeSignal('prove that the sum of two evens is even');
    expect(reasoning.shape).toBe('reasoning');
    expect(reasoning.recipe).toBe('fusion');
  });

  it('writeRecipeSignal writes <hash>.json + latest.json the proxy can read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uap-sig-'));
    const sig = computeRecipeSignal('build the thing');
    writeRecipeSignal(sig, dir);
    const byHash = join(dir, `${sig.promptHash}.json`);
    expect(existsSync(byHash)).toBe(true);
    expect(existsSync(join(dir, 'latest.json'))).toBe(true);
    const loaded = JSON.parse(readFileSync(byHash, 'utf-8'));
    expect(loaded.promptHash).toBe(sig.promptHash);
    expect(loaded.recipe).toBe(sig.recipe);
    expect(typeof loaded.ts).toBe('number');
  });

  it('maybeWriteRecipeSignal is a no-op for empty prompt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uap-sig-'));
    maybeWriteRecipeSignal('', dir);
    expect(existsSync(join(dir, 'latest.json'))).toBe(false);
  });
});
