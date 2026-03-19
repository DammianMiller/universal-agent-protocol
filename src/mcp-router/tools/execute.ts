/**
 * execute_tool - Meta-tool for executing MCP tools
 *
 * This is one of the 2 tools exposed by the router (the other being discover_tools).
 * Routes tool calls to the appropriate MCP server.
 */

import type { ExecuteToolArgs, OutputCompressionStats } from '../types.js';
import type { ToolSearchIndex } from '../search/fuzzy.js';
import type { McpClientPool } from '../executor/client.js';
import { compressToolOutput } from '../output-compressor.js';
import { globalSessionStats } from '../session-stats.js';
import { getPolicyGate, PolicyViolationError } from '../../policies/policy-gate.js';
import { CoordinationService } from '../../coordination/service.js';
import { isPathInsideWorktree, isExemptFromWorktree } from '../../cli/worktree.js';

export const EXECUTE_TOOL_DEFINITION = {
  name: 'execute_tool',
  description: `Execute an MCP tool by its path. Use discover_tools first to find the correct path.

Path format: "server.tool_name" (e.g., "github.create_issue", "filesystem.read_file")

Example:
1. First: discover_tools({ query: "github issues" })
   → Returns: [{ path: "github.create_issue", ... }]
2. Then: execute_tool({ path: "github.create_issue", args: { title: "Bug", body: "..." } })

The args object should match the tool's expected input schema.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      path: {
        type: 'string',
        description: 'Tool path in format "server.tool_name" (from discover_tools results)',
      },
      args: {
        type: 'object',
        description: 'Arguments to pass to the tool (schema depends on the specific tool)',
        additionalProperties: true,
      },
      intent: {
        type: 'string',
        description:
          'Optional: describe what you are looking for in the output. For large results (>10KB), only matching sections are returned instead of the full output.',
      },
    },
    required: ['path'],
  },
};

export interface ExecuteResult {
  success: boolean;
  result?: unknown;
  error?: string;
  toolPath: string;
  executionTimeMs: number;
  compressionStats?: OutputCompressionStats;
}

// !! REGRESSION GUARD — DO NOT UNWRAP MCP CONTENT ENVELOPES !!
//
// The raw { content: [{ type, text }] } structure returned by callTool() MUST flow
// through compression and into ExecuteResult.result WITHOUT being flattened to text.
//
// History of this regression (it has been attempted and reverted TWICE):
//
//   v1.4.0 — Added unwrapping inside callTool() (client.ts). Broke Qwen3.5: the
//            model received flattened text instead of structured results, causing
//            misinterpretation and infinite retry loops. Reverted in v1.4.1.
//
//   v1.4.2 — Added unwrapMcpContent() here in execute.ts. Same logical result:
//            the model still received flattened text (just unwrapped one layer up).
//            Caught during validation and reverted before release.
//
// The triple-nesting (downstream MCP envelope inside ExecuteResult inside router
// MCP envelope) is intentional. Qwen3.5 and similar small MoE models rely on the
// structured envelope to correctly parse tool outputs.
//
// @see commit 5941768f "fix: v1.4.1 - revert callTool content unwrapping"

// Lazy singleton for coordination — avoid creating a new instance per tool call
let _coordService: CoordinationService | null = null;
function getCoordinationService(): CoordinationService {
  if (!_coordService) {
    _coordService = new CoordinationService();
  }
  return _coordService;
}

export async function handleExecuteTool(
  args: ExecuteToolArgs,
  searchIndex: ToolSearchIndex,
  clientPool: McpClientPool
): Promise<ExecuteResult> {
  const startTime = Date.now();
  const { path, args: toolArgs = {}, intent } = args;

  // Parse path
  const dotIndex = path.indexOf('.');
  if (dotIndex === -1) {
    return {
      success: false,
      error: `Invalid tool path "${path}". Expected format: "server.tool_name"`,
      toolPath: path,
      executionTimeMs: Date.now() - startTime,
    };
  }

  const serverName = path.slice(0, dotIndex);
  const toolName = path.slice(dotIndex + 1);

  // Find tool definition
  const tool = searchIndex.getToolByPath(path);
  if (!tool) {
    // Try fuzzy match suggestion
    const suggestions = searchIndex.search(toolName, 3);
    const suggestionText =
      suggestions.length > 0 ? ` Did you mean: ${suggestions.map((s) => s.path).join(', ')}?` : '';

    return {
      success: false,
      error: `Tool "${path}" not found.${suggestionText}`,
      toolPath: path,
      executionTimeMs: Date.now() - startTime,
    };
  }

  // Get or create client for this server
  const client = clientPool.getClient(serverName, tool.serverConfig);

  try {
    // Worktree File Guard — block file-mutating tool calls targeting paths outside worktrees
    const isFileModifying =
      toolName.includes('write') ||
      toolName.includes('edit') ||
      toolName.includes('create') ||
      toolName.includes('delete') ||
      toolName.includes('rename');
    if (isFileModifying) {
      const rawFilePath =
        (toolArgs as Record<string, unknown>)?.filePath ||
        (toolArgs as Record<string, unknown>)?.path;
      const targetPath = rawFilePath != null ? String(rawFilePath) : '';
      if (targetPath && !isPathInsideWorktree(targetPath) && !isExemptFromWorktree(targetPath)) {
        return {
          success: false,
          error: `[WORKTREE GUARD] File operation blocked: "${targetPath}" is not inside a worktree (.worktrees/). ` +
            `Create a worktree first: uap worktree create <slug>, then edit files in .worktrees/<id>-<slug>/. ` +
            `See policies/worktree-file-guard.md`,
          toolPath: path,
          executionTimeMs: Date.now() - startTime,
        };
      }
    }

    // Run through PolicyGate - all tool calls are policy-checked and audit-logged
    // Pass only the user's args to the gate; inject metadata separately for audit
    const gate = getPolicyGate();

    const rawResult = await gate.executeWithGates(
      path,
      (toolArgs as Record<string, unknown>) ?? {},
      async () => {
        await client.connect();
        return client.callTool(toolName, toolArgs as Record<string, unknown>);
      }
    );

    // Pass raw MCP result directly to compression — do NOT unwrap content envelopes.
    // See v1.4.1 revert notes: Qwen3.5 needs the structured envelope preserved.
    const compressed = compressToolOutput(rawResult, { intent });

    // Record stats
    globalSessionStats.record(
      path,
      compressed.stats.originalBytes,
      compressed.stats.compressedBytes
    );

    // Auto-announce file-modifying tool calls to coordination service
    // This enables overlap detection for multi-agent workflows
    try {
      const isFileWrite =
        toolName.includes('write') ||
        toolName.includes('edit') ||
        toolName.includes('create') ||
        toolName.includes('delete') ||
        toolName.includes('rename');
      if (isFileWrite) {
        const agentId = process.env.UAP_AGENT_ID || `mcp-${process.pid}`;
        const rawPath =
          (toolArgs as Record<string, unknown>)?.path ||
          (toolArgs as Record<string, unknown>)?.filePath;
        // Guard against null/undefined producing "null"/"undefined" strings
        const filePath = rawPath != null ? String(rawPath) : path;
        const coord = getCoordinationService();
        coord.announceWork(agentId, filePath, 'editing', {
          description: `${toolName} via MCP router`,
          filesAffected: [filePath],
        });
      }
    } catch {
      // Coordination is best-effort -- never block tool execution
    }

    // compressionStats are already recorded to session-stats (line 149-153).
    // Omit from the return value to save ~50 tokens per call — server.ts
    // no longer needs stripDiagnostics.
    return {
      success: true,
      result: compressed.output,
      toolPath: path,
      executionTimeMs: Date.now() - startTime,
    };
  } catch (error) {
    // Surface policy violations distinctly from tool errors
    if (error instanceof PolicyViolationError) {
      return {
        success: false,
        error: `[POLICY BLOCKED] ${error.message}`,
        toolPath: path,
        executionTimeMs: Date.now() - startTime,
      };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      toolPath: path,
      executionTimeMs: Date.now() - startTime,
    };
  }
}

// Token estimation for the execute_tool definition
export function estimateExecuteToolTokens(): number {
  const json = JSON.stringify(EXECUTE_TOOL_DEFINITION);
  // Rough estimate: ~4 chars per token
  return Math.ceil(json.length / 4);
}
