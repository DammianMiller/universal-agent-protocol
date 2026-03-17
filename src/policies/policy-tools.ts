import { PolicyMemoryManager, getPolicyMemoryManager } from './policy-memory.js';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

export class PolicyToolRegistry {
  private _memory: PolicyMemoryManager | null = null;
  private _toolDir: string | null = null;

  private get memory(): PolicyMemoryManager {
    if (!this._memory) {
      this._memory = getPolicyMemoryManager();
    }
    return this._memory;
  }

  private get toolDir(): string {
    if (!this._toolDir) {
      this._toolDir = join(process.cwd(), '.policy-tools');
      mkdirSync(this._toolDir, { recursive: true });
    }
    return this._toolDir;
  }

  async getExecutableTool(policyId: string): Promise<string | null> {
    const policy = await this.memory.getPolicy(policyId);

    if (!policy?.executableTools || policy.executableTools.length === 0) {
      return null;
    }

    for (const toolName of policy.executableTools) {
      const toolPath = join(this.toolDir, `${policyId}_${toolName}.py`);
      if (existsSync(toolPath)) {
        return toolPath;
      }
    }

    return null;
  }

  async storeToolCode(policyId: string, toolName: string, pythonCode: string): Promise<string> {
    await this.memory.storeExecutablePolicy(policyId, pythonCode, toolName);

    const filePath = join(this.toolDir, `${policyId}_${toolName}.py`);
    writeFileSync(filePath, pythonCode);

    return filePath;
  }

  async callPolicyTool(
    policyId: string,
    operation: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    const toolPath = await this.getExecutableTool(policyId);

    if (!toolPath) {
      throw new Error(`No executable tool found for policy ${policyId}`);
    }

    // Use execFileSync with argument array to prevent shell injection
    const result = execFileSync(
      'python3',
      [toolPath, '--operation', operation, '--args', JSON.stringify(args)],
      {
        encoding: 'utf-8',
        timeout: 30000,
      }
    );

    try {
      return JSON.parse(result);
    } catch {
      return { raw: result.trim() };
    }
  }
}

// Lazy singleton
let _instance: PolicyToolRegistry | null = null;
export function getPolicyToolRegistry(): PolicyToolRegistry {
  if (!_instance) {
    _instance = new PolicyToolRegistry();
  }
  return _instance;
}
