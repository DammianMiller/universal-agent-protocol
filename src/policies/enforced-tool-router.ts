import { PolicyGate, getPolicyGate, PolicyViolationError } from './policy-gate.js';

export interface PolicyToolDefinition {
  name: string;
  category: string;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

/** @deprecated Use PolicyToolDefinition instead */
export type ToolDefinition = PolicyToolDefinition;

/**
 * EnforcedToolRouter is the single entry point for all tool execution.
 * Tools registered here are automatically gated by the PolicyGate.
 *
 * Usage:
 *   const router = getEnforcedToolRouter();
 *   router.registerTool({
 *     name: 'web_browser',
 *     category: 'automation',
 *     execute: async (args) => { ... }
 *   });
 *
 *   // This will check all REQUIRED policies before executing
 *   const result = await router.executeTool('web_browser', { url: '...' });
 */
export class EnforcedToolRouter {
  private tools: Map<string, ToolDefinition> = new Map();
  private _gate: PolicyGate | null = null;

  private get gate(): PolicyGate {
    if (!this._gate) {
      this._gate = getPolicyGate();
    }
    return this._gate;
  }

  /**
   * Register a tool. All registered tools are policy-gated.
   */
  registerTool(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  /**
   * Execute a tool through the policy gate.
   * Throws PolicyViolationError if any REQUIRED policy blocks it.
   */
  async executeTool(
    name: string,
    args: Record<string, unknown> = {},
    stage: 'pre-exec' | 'post-exec' | 'review' | 'always' = 'pre-exec'
  ): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(
        `Tool "${name}" not registered. Available: ${[...this.tools.keys()].join(', ')}`
      );
    }

    return this.gate.executeWithGates(
      name,
      { ...args, _toolCategory: tool.category },
      () => tool.execute(args),
      stage
    );
  }

  /**
   * Check if a tool call would be allowed without executing it.
   */
  async wouldAllow(
    name: string,
    args: Record<string, unknown> = {},
    stage: 'pre-exec' | 'post-exec' | 'review' | 'always' = 'pre-exec'
  ): Promise<{
    allowed: boolean;
    reasons: string[];
  }> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { allowed: false, reasons: [`Tool "${name}" not registered`] };
    }

    const result = await this.gate.checkPolicies(
      name,
      { ...args, _toolCategory: tool.category },
      stage
    );
    return {
      allowed: result.allowed,
      reasons: result.blockedBy.map((b) => `[${b.policyName}] ${b.reason}`),
    };
  }

  /**
   * List all registered tools.
   */
  listTools(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  /**
   * Check if a tool is registered.
   */
  hasTool(name: string): boolean {
    return this.tools.has(name);
  }
}

// Lazy singleton
let _instance: EnforcedToolRouter | null = null;
export function getEnforcedToolRouter(): EnforcedToolRouter {
  if (!_instance) {
    _instance = new EnforcedToolRouter();
  }
  return _instance;
}

// Re-export for convenience
export { PolicyViolationError };
