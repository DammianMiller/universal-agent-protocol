/**
 * react - First-class MCP tool exposing the UAP Reactor resolver in-process.
 *
 * For harnesses WITHOUT a per-prompt hook (notably Codex, which only speaks
 * MCP), the agent calls this at the start of a task to auto-apply UAP routing:
 * which expert droids/skills to use and which enforcement patterns apply,
 * confidence-gated, with optional expert auto-spawn suggestions.
 */
import {
  resolve as resolveReactor,
  type ReactorContext,
  type ReactorOptions,
} from '../../coordination/reactor.js';

export interface ReactArgs {
  promptText: string;
  changedFiles?: string[];
  event?: ReactorContext['event'];
  surfaced?: string[];
  injectThreshold?: number;
  autoSpawnThreshold?: number;
  autoSpawnTaskTypes?: string[];
  maxInjectChars?: number;
}

export const REACT_TOOL_DEFINITION = {
  name: 'react',
  description: `Resolve the UAP capabilities (expert droids, skills, enforcement patterns) relevant to the current task — call this at the START of any substantive coding task to auto-apply UAP's dynamic routing.

Returns a context card (inject) recommending which expert droids and skills to use and which patterns apply, plus structured actions including confidence-gated expert auto-spawn suggestions. Harnesses with per-prompt hooks get this automatically; for harnesses without them (e.g. Codex), invoke this yourself each task instead of editing blind.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      promptText: { type: 'string', description: 'The task/prompt text to route' },
      changedFiles: {
        type: 'array',
        items: { type: 'string' },
        description: 'Files in play — refines routing',
      },
      event: { type: 'string', description: "Lifecycle event (default 'user-prompt')" },
      surfaced: {
        type: 'array',
        items: { type: 'string' },
        description: 'Keys already surfaced this session (droid:/skill:/pattern:) for dedup',
      },
    },
    required: ['promptText'],
  },
};

export interface ReactToolResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

export function handleReact(args: ReactArgs): ReactToolResult {
  try {
    if (!args || typeof args.promptText !== 'string' || !args.promptText.trim()) {
      return { ok: false, error: 'promptText is required' };
    }
    const ctx: ReactorContext = {
      event: args.event ?? 'user-prompt',
      promptText: args.promptText,
      changedFiles: args.changedFiles,
      surfaced: args.surfaced,
    };
    const opts: ReactorOptions = {
      injectThreshold: args.injectThreshold,
      autoSpawnThreshold: args.autoSpawnThreshold,
      autoSpawnTaskTypes: args.autoSpawnTaskTypes,
      maxInjectChars: args.maxInjectChars,
    };
    return { ok: true, result: resolveReactor(ctx, opts) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
