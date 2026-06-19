/**
 * Shared lazy-import utilities for heavy optional dependencies.
 * Avoids duplicating the lazy-loading pattern across CLI modules.
 */

// ── QdrantClient ──────────────────────────────────────────────────────
let _QdrantClient: typeof import('@qdrant/js-client-rest').QdrantClient | null = null;

/**
 * Lazy-load QdrantClient class. Saves ~100ms startup when Qdrant operations aren't needed.
 */
export async function getQdrantClientClass(): Promise<
  typeof import('@qdrant/js-client-rest').QdrantClient
> {
  if (!_QdrantClient) {
    const mod = await import('@qdrant/js-client-rest');
    _QdrantClient = mod.QdrantClient;
  }
  return _QdrantClient;
}

// ── inquirer ──────────────────────────────────────────────────────────
let _inquirer: typeof import('inquirer').default;

/**
 * Lazy-load inquirer. Saves ~500ms startup when interactive prompts aren't needed.
 * Must be called (awaited) before any `inquirer.prompt()` usage.
 */
export async function ensureInquirer(): Promise<typeof import('inquirer').default> {
  if (!_inquirer) {
    const mod = await import('inquirer');
    _inquirer = mod.default;
  }
  return _inquirer;
}

/**
 * Get the lazily-loaded inquirer instance. Throws if ensureInquirer() hasn't been called.
 */
export function getInquirer(): typeof import('inquirer').default {
  if (!_inquirer) {
    throw new Error('inquirer not loaded — call ensureInquirer() first');
  }
  return _inquirer;
}

// ── @clack/prompts ────────────────────────────────────────────────────
let _clack: typeof import('@clack/prompts') | null = null;

/**
 * Lazy-load @clack/prompts (the arrow-key TUI behind the setup wizard).
 * Keeps the dependency off the hot path of non-interactive commands like
 * `uap init`. Await before building a clack-backed PromptUI.
 */
export async function ensureClack(): Promise<typeof import('@clack/prompts')> {
  if (!_clack) {
    _clack = await import('@clack/prompts');
  }
  return _clack;
}
