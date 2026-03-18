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
  private _executionCount = 0;
  private static readonly PRUNE_INTERVAL = 100; // Prune audit log every N executions

  // Cache parsed policies + extracted rules to avoid re-querying SQLite,
  // re-running Zod validation, and re-extracting rules via regex on every
  // tool call. Policies change extremely rarely (only on explicit user action).
  private _cachedPolicies: Policy[] | null = null;
  private _cachedRules = new Map<
    string,
    Array<{ title: string; keywords: string[]; antiPatterns: string[] }>
  >();
  private _cacheTimestamp = 0;
  private static readonly CACHE_TTL_MS = 30_000; // 30s TTL

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

  /** Invalidate the policy cache (call after policy upsert/update/toggle) */
  invalidateCache(): void {
    this._cachedPolicies = null;
    this._cachedRules.clear();
    this._cacheTimestamp = 0;
  }

  /** Get policies from cache or reload from DB */
  private async getCachedPolicies(): Promise<Policy[]> {
    const now = Date.now();
    if (this._cachedPolicies && now - this._cacheTimestamp < PolicyGate.CACHE_TTL_MS) {
      return this._cachedPolicies;
    }
    this._cachedPolicies = await this.memory.getAllPolicies();
    this._cacheTimestamp = now;
    return this._cachedPolicies;
  }

  /** Get extracted rules for a policy, cached by policy ID */
  private getCachedRules(
    policy: Policy
  ): Array<{ title: string; keywords: string[]; antiPatterns: string[] }> {
    const cached = this._cachedRules.get(policy.id);
    if (cached) return cached;
    const rules = this.extractRules(policy.rawMarkdown);
    this._cachedRules.set(policy.id, rules);
    return rules;
  }

  /**
   * Detect if an operation is related to task completion.
   */
  private isTaskCompletionOperation(operation: string, args: Record<string, unknown>): boolean {
    const opLower = operation.toLowerCase();
    // Check operation name
    if (
      opLower.includes('complete') ||
      opLower.includes('done') ||
      opLower.includes('finish') ||
      opLower.includes('close') ||
      opLower.includes('resolve') ||
      opLower.includes('merge') ||
      opLower.includes('deploy') ||
      opLower.includes('release')
    ) {
      return true;
    }
    // Check args for completion status changes
    if (args && typeof args === 'object') {
      const argsStr = JSON.stringify(args).toLowerCase();
      if (
        argsStr.includes('status') &&
        (argsStr.includes('done') ||
          argsStr.includes('complete') ||
          argsStr.includes('closed') ||
          argsStr.includes('resolved'))
      ) {
        return true;
      }
    }
    return false;
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
    // Auto-detect task completion operations and enforce review-stage policies
    const isTaskCompletion = this.isTaskCompletionOperation(operation, args);
    if (isTaskCompletion && stage !== 'review') {
      // Force review stage for task completion to ensure testing/deployment checks
      const reviewResult = await this.checkPolicies(operation, args, 'review');
      if (!reviewResult.allowed) {
        const blockedNames = reviewResult.blockedBy.map((b) => b.policyName).join(', ');
        const reasons = reviewResult.blockedBy
          .map((b) => `[${b.policyName}] ${b.reason}`)
          .join('; ');
        throw new PolicyViolationError(
          `Task completion blocked by policy: ${blockedNames}. Reasons: ${reasons}`,
          reviewResult.blockedBy
        );
      }
    }

    const gateResult = await this.checkPolicies(operation, args, stage);

    // Log all checks to audit trail (pre-execution, result not yet available)
    for (const check of gateResult.checks) {
      this.db.logExecution({
        policyId: check.policyId,
        toolName: operation,
        operation,
        args,
        result: 'pending',
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
    const startTime = Date.now();
    let executionResult: T;
    let executionError: Error | null = null;

    try {
      executionResult = await executor();
    } catch (error) {
      executionError = error instanceof Error ? error : new Error(String(error));
      // Log post-execution failure to audit trail
      for (const check of gateResult.checks) {
        this.db.logExecution({
          policyId: check.policyId,
          toolName: operation,
          operation,
          args,
          result: `error: ${executionError.message}`,
          allowed: check.allowed,
          reason: `Post-exec (${Date.now() - startTime}ms): ${executionError.message}`,
        });
      }
      throw executionError;
    }

    // Log post-execution success to audit trail
    for (const check of gateResult.checks) {
      this.db.logExecution({
        policyId: check.policyId,
        toolName: operation,
        operation,
        args,
        result: 'completed',
        allowed: check.allowed,
        reason: `Post-exec (${Date.now() - startTime}ms): success`,
      });
    }

    // Periodically prune old audit log entries to prevent unbounded growth
    this._executionCount++;
    if (this._executionCount % PolicyGate.PRUNE_INTERVAL === 0) {
      try {
        this.db.pruneExecutionLog(1000);
      } catch {
        // Best-effort cleanup
      }
    }

    return executionResult;
  }

  /**
   * Check policies without executing. Returns the gate result.
   */
  async checkPolicies(
    operation: string,
    args: Record<string, unknown>,
    stage: 'pre-exec' | 'post-exec' | 'review' | 'always' = 'pre-exec'
  ): Promise<GateResult> {
    const allPolicies = await this.getCachedPolicies();
    // Filter to policies matching this stage or 'always'
    const stagePolicies = allPolicies.filter(
      (p: Policy) =>
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
   * Serializes args ONCE and passes the cached string to each rule check
   * to avoid redundant JSON.stringify calls per-rule.
   */
  private evaluatePolicy(
    policy: Policy,
    operation: string,
    args: Record<string, unknown>
  ): PolicyCheckResult {
    const rules = this.getCachedRules(policy);
    const violations: string[] = [];

    // Cache serialized args once per policy evaluation (not per rule)
    const opLower = operation.toLowerCase();
    let argsStr: string;
    try {
      argsStr = JSON.stringify(args ?? {}).toLowerCase();
    } catch {
      argsStr = '';
    }

    for (const rule of rules) {
      const violation = this.checkRule(rule, opLower, argsStr);
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
   * Accepts pre-computed lowercase strings to avoid redundant serialization.
   */
  private checkRule(
    rule: { title: string; keywords: string[]; antiPatterns: string[] },
    opLower: string,
    argsStr: string
  ): string | null {
    // Check if this rule is relevant to the operation
    const isRelevant = rule.keywords.some((kw) => opLower.includes(kw) || argsStr.includes(kw));

    if (!isRelevant) return null;

    // Check for anti-patterns
    const ruleTitle = rule.title || 'Untitled rule';
    for (const antiPattern of rule.antiPatterns) {
      if (opLower.includes(antiPattern) || argsStr.includes(antiPattern)) {
        return `Rule "${ruleTitle}" violated: detected anti-pattern "${antiPattern}"`;
      }
    }

    return null;
  }

  /**
   * Extract structured rules from policy content.
   * Supports two formats:
   * 1. Structured YAML/JSON rules block (preferred, extensible):
   *    ```rules
   *    - title: "Rule name"
   *      keywords: [keyword1, keyword2]
   *      antiPatterns: [pattern1, pattern2]
   *    ```
   * 2. Legacy markdown numbered rules with bold titles (auto-extracted)
   */
  private extractRules(
    markdown: string
  ): Array<{ title: string; keywords: string[]; antiPatterns: string[] }> {
    const rules: Array<{ title: string; keywords: string[]; antiPatterns: string[] }> = [];

    // Try structured rules block first (```rules ... ```)
    const structuredMatch = markdown.match(/```rules\n([\s\S]*?)```/);
    if (structuredMatch) {
      try {
        const structuredRules = this.parseStructuredRules(structuredMatch[1]);
        if (structuredRules.length > 0) return structuredRules;
      } catch {
        // Fall through to legacy extraction
      }
    }

    // Try JSON rules block (```json ... ```) with "rules" key
    const jsonMatch = markdown.match(/```json\n([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        if (Array.isArray(parsed?.rules)) {
          for (const rule of parsed.rules) {
            if (rule.title && (Array.isArray(rule.keywords) || Array.isArray(rule.antiPatterns))) {
              rules.push({
                title: String(rule.title ?? 'Untitled rule'),
                keywords: (rule.keywords || []).map(String),
                antiPatterns: (rule.antiPatterns || []).map(String),
              });
            }
          }
          if (rules.length > 0) return rules;
        }
      } catch {
        // Fall through to legacy extraction
      }
    }

    // Legacy: match numbered rules with bold titles
    const ruleRegex = /\d+\.\s+\*\*(.+?)\*\*[^]*?(?=\d+\.\s+\*\*|## |$)/g;
    let match;

    while ((match = ruleRegex.exec(markdown)) !== null) {
      const title = match[1];
      const body = match[0].toLowerCase();

      const keywords: string[] = [];
      const antiPatterns: string[] = [];

      // Auto-extract keywords from rule body content
      if (body.includes('vision') || body.includes('image') || body.includes('visual')) {
        keywords.push('image', 'vision', 'screenshot', 'view');
      }
      if (body.includes('count') || body.includes('measure')) {
        keywords.push('count', 'measure', 'pixel');
      }
      if (body.includes('file') || body.includes('write') || body.includes('edit')) {
        keywords.push('file', 'write', 'edit', 'create', 'delete');
      }
      if (body.includes('secret') || body.includes('credential') || body.includes('password')) {
        keywords.push('secret', 'credential', 'password', 'token', 'key');
      }
      if (body.includes('deploy') || body.includes('production') || body.includes('release')) {
        keywords.push('deploy', 'production', 'release', 'push');
      }
      if (body.includes('test') || body.includes('coverage') || body.includes('spec')) {
        keywords.push('test', 'coverage', 'spec', 'assert');
      }
      if (body.includes('never') || body.includes('do not') || body.includes('must not')) {
        const neverMatch = body.match(/(?:never|must not|do not)\s+(?:use\s+)?(\w+(?:\s+\w+)?)/g);
        if (neverMatch) {
          antiPatterns.push(
            ...neverMatch.map((n) => n.replace(/^(?:never|must not|do not)\s+(?:use\s+)?/, ''))
          );
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
   * Parse structured YAML-like rules from a ```rules block.
   * Format: lines starting with "- title:" followed by "  keywords:" and "  antiPatterns:"
   */
  private parseStructuredRules(
    content: string
  ): Array<{ title: string; keywords: string[]; antiPatterns: string[] }> {
    const rules: Array<{ title: string; keywords: string[]; antiPatterns: string[] }> = [];
    const entries = content.split(/^- /m).filter(Boolean);

    for (const entry of entries) {
      const titleMatch = entry.match(/title:\s*"?([^"\n]+)"?/);
      const keywordsMatch = entry.match(/keywords:\s*\[([^\]]*)\]/);
      const antiPatternsMatch = entry.match(/antiPatterns:\s*\[([^\]]*)\]/);

      if (titleMatch) {
        rules.push({
          title: titleMatch[1].trim(),
          keywords: keywordsMatch
            ? keywordsMatch[1]
                .split(',')
                .map((k) => k.trim().replace(/['"]/g, ''))
                .filter(Boolean)
            : [],
          antiPatterns: antiPatternsMatch
            ? antiPatternsMatch[1]
                .split(',')
                .map((k) => k.trim().replace(/['"]/g, ''))
                .filter(Boolean)
            : [],
        });
      }
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
