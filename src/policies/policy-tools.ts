import { PolicyMemoryManager, getPolicyMemoryManager } from './policy-memory.js';
import { writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

  /**
   * Materialize the shared `_common.py` module next to the enforcers. Every
   * enforcer does `from _common import ...`, so without this the enforcer
   * crashes with ModuleNotFoundError at runtime and the policy gate silently
   * falls back to "allow". Copied from the bundled package (or the repo in dev).
   */
  private ensureCommonModule(): void {
    const target = join(this.toolDir, '_common.py');
    const candidates = [
      join(__dirname, '..', '..', 'src', 'policies', 'enforcers', '_common.py'), // dist -> pkg root
      join(process.cwd(), 'src', 'policies', 'enforcers', '_common.py'), // running in repo
    ];
    for (const src of candidates) {
      if (existsSync(src)) {
        copyFileSync(src, target);
        return;
      }
    }
  }

  async storeToolCode(policyId: string, toolName: string, pythonCode: string): Promise<string> {
    await this.memory.storeExecutablePolicy(policyId, pythonCode, toolName);

    const filePath = join(this.toolDir, `${policyId}_${toolName}.py`);
    writeFileSync(filePath, pythonCode);
    this.ensureCommonModule();

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
      const parsed = JSON.parse(result);
      return parsed ?? { raw: result.trim() };
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
