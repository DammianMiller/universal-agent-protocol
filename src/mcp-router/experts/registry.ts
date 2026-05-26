/**
 * Expert Consultation Registry
 *
 * Surfaces UAP droids as virtual MCP tools so that `discover_tools` can find
 * the right expert by description, and `execute_tool` can dispatch a
 * consultation request to that droid. Keeps the 2-tool meta-router shape —
 * droids reuse the existing token-savings discovery surface.
 *
 * Virtual tool path: `experts.<droid-name>`
 * Virtual server name: `experts`
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import yaml from 'js-yaml';
import type { ToolDefinition } from '../types.js';

export const EXPERT_SERVER_NAME = 'experts';

export interface ExpertConsultArgs {
  /** The context, task, or question to pass to the expert. */
  context: string;
  /** Optional explicit stage: pre-exec, post-exec, review, always. */
  stage?: 'pre-exec' | 'post-exec' | 'review' | 'always';
}

const EXPERT_INPUT_SCHEMA: ToolDefinition['inputSchema'] = {
  type: 'object',
  properties: {
    context: {
      type: 'string',
      description: 'The task, code, or question to pass to the expert droid.',
    },
    stage: {
      type: 'string',
      enum: ['pre-exec', 'post-exec', 'review', 'always'],
      description: 'Policy enforcement stage; defaults to pre-exec.',
    },
  },
  required: ['context'],
};

interface DroidFrontmatter {
  name?: string;
  description?: string;
  model?: string;
  coordination?: Record<string, unknown>;
}

/**
 * Parse a droid markdown file's frontmatter without erroring on malformed
 * files — they are skipped (the validator surfaces those separately).
 */
function parseFrontmatter(content: string): DroidFrontmatter | null {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  try {
    const parsed = yaml.load(m[1]);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as DroidFrontmatter;
  } catch {
    return null;
  }
}

/**
 * Load every droid under `.factory/droids/` and convert each to a virtual
 * ToolDefinition that can be added to the MCP router's search index.
 *
 * Skips `test-droid-*` fixtures and any file with malformed frontmatter.
 */
export function loadExpertTools(cwd: string): ToolDefinition[] {
  const droidDir = join(cwd, '.factory', 'droids');
  if (!existsSync(droidDir)) return [];

  const tools: ToolDefinition[] = [];

  const files = readdirSync(droidDir).filter(
    (f) => f.endsWith('.md') && !f.startsWith('test-droid-')
  );

  for (const file of files) {
    const path = join(droidDir, file);
    const content = readFileSync(path, 'utf-8');
    const meta = parseFrontmatter(content);

    if (!meta || !meta.name || !meta.description) continue;

    tools.push({
      name: meta.name,
      description: meta.description,
      inputSchema: EXPERT_INPUT_SCHEMA,
      serverName: EXPERT_SERVER_NAME,
      serverConfig: {
        // Experts are dispatched in-process via the droid invocation pathway,
        // not via an external MCP server. The empty serverConfig keeps the
        // ToolDefinition shape uniform; the dispatcher detects EXPERT_SERVER_NAME
        // and routes accordingly.
        disabled: false,
      },
    });
  }

  return tools;
}

/**
 * True when a tool path resolves to an expert consultation rather than an
 * external MCP server tool. Used by execute_tool to switch dispatch.
 */
export function isExpertToolPath(path: string): boolean {
  return path.startsWith(`${EXPERT_SERVER_NAME}.`);
}

/**
 * Extract the droid name from a full expert tool path.
 *
 *   "experts.security-auditor" → "security-auditor"
 */
export function expertNameFromPath(path: string): string | null {
  if (!isExpertToolPath(path)) return null;
  return path.slice(EXPERT_SERVER_NAME.length + 1) || null;
}
