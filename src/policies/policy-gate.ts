import { Policy } from './schemas/policy.js';
import { PolicyMemoryManager, getPolicyMemoryManager } from './policy-memory.js';
import { DatabaseManager } from './database-manager.js';

export interface PolicyCheckResult {
  allowed: boolean;
  policyId: string;
  policyName: string;
  level: string;
  reason: string;
}

export interface GateResult {
  allowed: boolean;
  checks: PolicyCheckResult[];
  blockedBy: PolicyCheckResult[];
}

export class PolicyViolationError extends Error {
  public checks: PolicyCheckResult[];
  constructor(message: string, checks: PolicyCheckResult[]) {
    super(message);
    this.name = 'PolicyViolationError';
    this.checks = checks;
  }
}

/**
 * PolicyGate is the enforcement middleware.
 * Every tool call passes through executeWithGates() which:
 * 1. Retrieves all REQUIRED policies relevant to the operation
 * 2. Evaluates each policy's rules against the operation
 * 3. Blocks execution if any REQUIRED policy denies it
 * 4. Logs every check to the audit trail
 */
export class PolicyGate {
  private _memory: PolicyMemoryManager | null = null;
  private _db: DatabaseManager | null = null;

  private get memory(): PolicyMemoryManager {
    if (!this._memory) {
      this._memory = getPolicyMemoryManager();
    }
    return this._memory;
  }

  private get db(): DatabaseManager {
    if (!this._db) {
      this._db = new DatabaseManager();
    }
    return this._db;
  }

  /**
   * Check all policies before allowing an operation.
   * Throws PolicyViolationError if any REQUIRED policy blocks it.
   */
  async executeWithGates<T>(
    operation: string,
    args: Record<string, unknown>,
    executor: () => Promise<T>,
    stage: 'pre-exec' | 'post-exec' | 'review' | 'always' = 'pre-exec'
  ): Promise<T> {
    const gateResult = await this.checkPolicies(operation, args, stage);

    // Log all checks to audit trail
    for (const check of gateResult.checks) {
      this.db.logExecution({
        policyId: check.policyId,
        toolName: operation,
        operation,
        args,
        result: null,
        allowed: check.allowed,
        reason: check.reason,
      });
    }

    if (!gateResult.allowed) {
      const blockedNames = gateResult.blockedBy.map((b) => b.policyName).join(', ');
      const reasons = gateResult.blockedBy.map((b) => `[${b.policyName}] ${b.reason}`).join('; ');
      throw new PolicyViolationError(
        `Operation "${operation}" blocked by policies: ${blockedNames}. Reasons: ${reasons}`,
        gateResult.blockedBy
      );
    }

    // All gates passed - execute
    const result = await executor();

    return result;
  }

  /**
   * Check policies without executing. Returns the gate result.
   */
  async checkPolicies(
    operation: string,
    args: Record<string, unknown>,
    stage: 'pre-exec' | 'post-exec' | 'review' | 'always' = 'pre-exec'
  ): Promise<GateResult> {
    const allPolicies = await this.memory.getAllPolicies();
    // Filter to policies matching this stage or 'always'
    const stagePolicies = allPolicies.filter(
      (p: any) =>
        !p.enforcementStage || p.enforcementStage === stage || p.enforcementStage === 'always'
    );
    const checks: PolicyCheckResult[] = [];

    for (const policy of stagePolicies) {
      const check = this.evaluatePolicy(policy, operation, args);
      checks.push(check);
    }

    const blockedBy = checks.filter((c) => !c.allowed && c.level === 'REQUIRED');

    return {
      allowed: blockedBy.length === 0,
      checks,
      blockedBy,
    };
  }

  /**
   * Evaluate a single policy against an operation.
   * Parses the policy's rawMarkdown for rules and checks them.
   */
  private evaluatePolicy(
    policy: Policy,
    operation: string,
    args: Record<string, unknown>
  ): PolicyCheckResult {
    const rules = this.extractRules(policy.rawMarkdown);
    const violations: string[] = [];

    for (const rule of rules) {
      const violation = this.checkRule(rule, operation, args);
      if (violation) {
        violations.push(violation);
      }
    }

    return {
      allowed: violations.length === 0,
      policyId: policy.id,
      policyName: policy.name,
      level: policy.level,
      reason: violations.length > 0 ? violations.join('; ') : `Passed all ${rules.length} rules`,
    };
  }

  /**
   * Check a single rule against an operation.
   * Returns a violation message if the rule is violated, null otherwise.
   */
  private checkRule(
    rule: { title: string; keywords: string[]; antiPatterns: string[] },
    operation: string,
    args: Record<string, unknown>
  ): string | null {
    const opLower = operation.toLowerCase();
    const argsStr = JSON.stringify(args).toLowerCase();

    // Check if this rule is relevant to the operation
    const isRelevant = rule.keywords.some((kw) => opLower.includes(kw) || argsStr.includes(kw));

    if (!isRelevant) return null;

    // Check for anti-patterns
    for (const antiPattern of rule.antiPatterns) {
      if (opLower.includes(antiPattern) || argsStr.includes(antiPattern)) {
        return `Rule "${rule.title}" violated: detected anti-pattern "${antiPattern}"`;
      }
    }

    return null;
  }

  /**
   * Extract structured rules from policy markdown.
   */
  private extractRules(
    markdown: string
  ): Array<{ title: string; keywords: string[]; antiPatterns: string[] }> {
    const rules: Array<{ title: string; keywords: string[]; antiPatterns: string[] }> = [];

    // Match numbered rules with bold titles
    const ruleRegex = /\d+\.\s+\*\*(.+?)\*\*[^]*?(?=\d+\.\s+\*\*|## |$)/g;
    let match;

    while ((match = ruleRegex.exec(markdown)) !== null) {
      const title = match[1];
      const body = match[0].toLowerCase();

      // Extract keywords from the rule body
      const keywords: string[] = [];
      const antiPatterns: string[] = [];

      // Common keyword patterns
      if (body.includes('vision') || body.includes('image') || body.includes('visual')) {
        keywords.push('image', 'vision', 'screenshot', 'view');
      }
      if (body.includes('count') || body.includes('measure')) {
        keywords.push('count', 'measure', 'pixel');
      }
      if (body.includes('never') || body.includes('do not')) {
        // Extract what should never be done
        const neverMatch = body.match(/never\s+(?:use\s+)?(\w+(?:\s+\w+)?)/g);
        if (neverMatch) {
          antiPatterns.push(...neverMatch.map((n) => n.replace(/^never\s+(?:use\s+)?/, '')));
        }
      }
      if (body.includes('iterative') || body.includes('loop')) {
        antiPatterns.push('iterative', 'loop', 'retry');
      }
      if (body.includes('one-shot') || body.includes('single pass')) {
        antiPatterns.push('multiple_passes', 'retry_edit');
      }

      rules.push({ title, keywords, antiPatterns });
    }

    return rules;
  }

  /**
   * Get the audit trail for a policy or all policies.
   */
  async getAuditTrail(policyId?: string, limit: number = 50): Promise<Record<string, unknown>[]> {
    return this.db.getExecutionLog(policyId, limit);
  }
}

// Lazy singleton
let _instance: PolicyGate | null = null;
export function getPolicyGate(): PolicyGate {
  if (!_instance) {
    _instance = new PolicyGate();
  }
  return _instance;
}
