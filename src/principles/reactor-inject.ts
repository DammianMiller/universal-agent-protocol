/**
 * Reactor hook for the engineering principles.
 *
 * Two jobs, and it stays silent otherwise — an injection that fires on every
 * prompt is a tax on every prompt:
 *
 *   1. Stance UNRESOLVED + the work looks like code -> tell the agent to ask the
 *      user once, and how to record the answer. This is the "query per project
 *      per session" behaviour; it fires once because recording resolves it.
 *   2. Stance resolved -> nothing. The principles reach the model through the
 *      deliver prompt and the policy block; repeating them per turn buys
 *      nothing and costs context.
 *
 * Mirrors `src/design/reactor-inject.ts`, which solves the same shape of
 * problem for DESIGN.md.
 */
import { extname } from 'path';
import { readPrinciplesConfig } from './config.js';
import { needsAsking, resolveStance } from './stance.js';

const CODE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rs', '.go', '.java',
  '.rb', '.php', '.cs', '.cpp', '.c', '.h', '.swift', '.kt', '.sh', '.sql',
]);

const CODE_PROMPT_RE =
  /\b(implement|refactor|rewrite|migrat\w*|build|add|remove|delete|deprecat\w*|redesign|architect\w*|port|upgrade|replace|extract|consolidat\w*)\b/i;

/** True when the work is likely to write or restructure code. */
export function isCodeWork(promptText?: string, changedFiles?: string[]): boolean {
  if (changedFiles?.some((f) => CODE_EXT.has(extname(f).toLowerCase()))) return true;
  if (promptText && CODE_PROMPT_RE.test(promptText)) return true;
  return false;
}

/**
 * Build the injection, or null when there is nothing worth saying.
 *
 * `cwd` is the project root the reactor is operating in. `sessionId` scopes
 * "asked once per session" to the CALLING conversation — without it the stance
 * falls back to ambient `process.env`, which in a long-lived process serving
 * several sessions (the MCP handler, the proxy) is not the caller's session.
 */
export function maybePrinciplesInjection(
  cwd: string,
  promptText?: string,
  changedFiles?: string[],
  sessionId?: string
): string | null {
  // Cheap predicate first, filesystem second — the same ordering as
  // maybeDesignInjection. This runs on every reactor turn, and most turns are
  // not code work, so a config read before this check is a read for nothing.
  if (!isCodeWork(promptText, changedFiles)) return null;
  if (!readPrinciplesConfig(cwd).enabled) return null;

  let stance: ReturnType<typeof resolveStance>;
  try {
    stance = resolveStance(cwd, sessionId ? { ...process.env, UAP_SESSION_ID: sessionId } : process.env);
  } catch {
    return null;
  }
  if (!needsAsking(stance)) return null;

  return [
    'ENGINEERING PRINCIPLES — one question before you write code (asked once per project per session):',
    'Ask the user, in their next reply:',
    '  1. Backward compatibility — should obsolete paths be REMOVED outright, or PRESERVED and migrated?',
    '  2. Is this project GREENFIELD or PRODUCTION (does breaking a caller cost real money)?',
    'Then record it: `uap principles ask` (interactive), or',
    '`uap principles compat <preserve|remove>` and `uap principles maturity <greenfield|production>`.',
    'Add --save to make it this project\'s default instead of just this session\'s.',
    'Until it is answered, unattended runs assume PRESERVE — the answer that cannot delete anything.',
  ].join('\n');
}
