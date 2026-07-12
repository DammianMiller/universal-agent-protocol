import { Policy, PolicySchema } from './schemas/policy.js';
import { DatabaseManager } from './database-manager.js';

/** One deduplication decision: which row to keep for a name and which to drop. */
export interface DedupGroup {
  name: string;
  keep: string;
  remove: string[];
}

/**
 * PURE dedup planner: group policies by name and, for any name with more than
 * one row, choose the survivor (active first, then highest version, then newest
 * updatedAt, then stable id order) and mark the rest for removal. Only returns
 * groups that actually have duplicates. No DB access — trivially testable.
 */
export function planDedup(
  policies: Array<{ id: string; name: string; isActive: boolean; version: number; updatedAt: string }>
): DedupGroup[] {
  const byName = new Map<string, typeof policies>();
  for (const p of policies) {
    const list = byName.get(p.name) ?? [];
    list.push(p);
    byName.set(p.name, list);
  }
  const groups: DedupGroup[] = [];
  for (const [name, list] of byName) {
    if (list.length < 2) continue;
    const ranked = [...list].sort((a, b) => {
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
      if (a.version !== b.version) return b.version - a.version;
      if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
      return a.id < b.id ? -1 : 1;
    });
    groups.push({ name, keep: ranked[0].id, remove: ranked.slice(1).map((r) => r.id) });
  }
  return groups;
}

export class PolicyMemoryManager {
  private _db: DatabaseManager | null = null;

  /** Optional explicit DB path — used by tests to point at a temp policies.db.
   * Production callers use the no-arg singleton (default cwd-relative path). */
  constructor(private readonly dbPath?: string) {}

  private get db(): DatabaseManager {
    if (!this._db) {
      this._db = new DatabaseManager(this.dbPath);
    }
    return this._db;
  }

  async storeRawPolicy(rawMarkdown: string, metadata: Partial<Policy> = {}): Promise<string> {
    const name = this.extractPolicyName(rawMarkdown);
    const extractedMetadata = this.extractPolicyMetadata(rawMarkdown);

    // Upsert by NAME, not a fresh UUID: re-installing/re-selecting the same
    // policy must UPDATE the existing row in place, never insert a duplicate.
    // An existing same-named policy keeps its id + enabled state + createdAt and
    // has its version bumped; only a genuinely new name mints a new id.
    const existing = this.db.findOnePolicy({ name }) as { id?: string; isActive?: unknown; createdAt?: string; version?: number } | null;
    const policyId = existing?.id ?? crypto.randomUUID();
    const now = new Date().toISOString();

    const policy: Policy = {
      id: policyId,
      name,
      category: (metadata.category ?? extractedMetadata.category ?? 'custom') as Policy['category'],
      level: (metadata.level ?? extractedMetadata.level ?? 'RECOMMENDED') as Policy['level'],
      enforcementStage:
        metadata.enforcementStage || extractedMetadata.enforcementStage || 'pre-exec',
      rawMarkdown,
      tags: metadata.tags || extractedMetadata.tags || [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      version: existing ? (Number(existing.version) || 1) + 1 : 1,
      // Preserve an operator's enable/disable choice across re-install; default on.
      isActive: existing ? existing.isActive === true || existing.isActive === 1 : true,
      priority: metadata.priority ?? 50,
    };

    this.db.upsertPolicy(policy as unknown as Record<string, unknown>);
    return policyId;
  }

  /**
   * Remove duplicate policy rows that share a name (legacy rows created before
   * storeRawPolicy upserted by name). Keeps one canonical row per name — an
   * ACTIVE row wins, then the highest version, then the newest updatedAt — and
   * deletes the rest. Returns what changed. Pure planning lives in planDedup().
   */
  async dedupePolicies(): Promise<{ removed: number; kept: number; groups: DedupGroup[] }> {
    const rows = this.db.getAllPolicyRows() as Array<{ id: string; name: string; isActive: unknown; version?: number; updatedAt?: string }>;
    const groups = planDedup(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        isActive: r.isActive === true || r.isActive === 1,
        version: Number(r.version) || 0,
        updatedAt: r.updatedAt ?? '',
      }))
    );
    let removed = 0;
    for (const g of groups) {
      for (const id of g.remove) {
        this.db.deletePolicyById(id);
        removed++;
      }
    }
    return { removed, kept: groups.length, groups };
  }

  /** Duplicate a policy under a unique "<name> (copy)" name (new id, active). */
  async duplicatePolicy(id: string): Promise<string | null> {
    const src = await this.getPolicy(id);
    if (!src) return null;
    const existing = new Set(this.db.getAllPolicyRows().map((r) => String((r as { name?: string }).name)));
    const baseName = src.name.replace(/ \(copy(?: \d+)?\)$/, '');
    let name = `${baseName} (copy)`;
    let n = 2;
    while (existing.has(name)) name = `${baseName} (copy ${n++})`;
    const newId = crypto.randomUUID();
    const now = new Date().toISOString();
    // Rewrite the H1 title so extractPolicyName stays consistent with the row name.
    const rawMarkdown = src.rawMarkdown.replace(/^#\s+.+/m, `# ${name}`);
    this.db.upsertPolicy({
      ...(src as unknown as Record<string, unknown>),
      id: newId,
      name,
      rawMarkdown,
      createdAt: now,
      updatedAt: now,
      version: 1,
      isActive: true,
    });
    return newId;
  }

  /** Set a single policy's priority (higher = fires earlier). */
  async setPolicyPriority(id: string, priority: number): Promise<void> {
    this.db.updatePolicy({ id }, { priority, updatedAt: new Date().toISOString() });
  }

  /** Assign descending priorities from an ordered id list (first = highest). */
  async reorderPolicies(orderedIds: string[], base = 1000, step = 10): Promise<void> {
    const now = new Date().toISOString();
    orderedIds.forEach((id, i) => {
      this.db.updatePolicy({ id }, { priority: Math.max(0, base - i * step), updatedAt: now });
    });
  }

  /** Export every policy as a portable bundle (round-trips through importPolicies). */
  exportPolicies(): {
    version: number;
    policies: Array<{ name: string; category: string; level: string; enforcementStage: string; priority: number; isActive: boolean; rawMarkdown: string }>;
  } {
    const rows = this.db.getAllPolicyRows() as unknown as Array<Record<string, unknown>>;
    return {
      version: 1,
      policies: rows.map((r) => ({
        name: String(r.name),
        category: String(r.category ?? 'custom'),
        level: String(r.level ?? 'OPTIONAL'),
        enforcementStage: String(r.enforcementStage ?? 'pre-exec'),
        priority: Number(r.priority) || 50,
        isActive: r.isActive === true || r.isActive === 1,
        rawMarkdown: String(r.rawMarkdown ?? ''),
      })),
    };
  }

  /** Install policies from an exported bundle. Upserts by name (no duplicates);
   * preserves each entry's priority + active state. Returns what was imported. */
  async importPolicies(bundle: { policies?: Array<Record<string, unknown>> }): Promise<{ imported: number; names: string[] }> {
    const list = Array.isArray(bundle?.policies) ? bundle.policies : [];
    const names: string[] = [];
    for (const p of list) {
      const raw = typeof p.rawMarkdown === 'string' ? p.rawMarkdown : '';
      if (!raw) continue;
      const id = await this.storeRawPolicy(raw, {
        category: p.category as never,
        level: p.level as never,
        enforcementStage: p.enforcementStage as never,
        priority: typeof p.priority === 'number' ? p.priority : undefined,
      });
      if (typeof p.priority === 'number') this.db.updatePolicy({ id }, { priority: p.priority });
      if (p.isActive === false) this.db.updatePolicy({ id }, { isActive: false });
      names.push(this.extractPolicyName(raw));
    }
    return { imported: names.length, names };
  }

  private extractPolicyMetadata(markdown: string): {
    category?: string;
    level?: 'REQUIRED' | 'RECOMMENDED' | 'OPTIONAL';
    enforcementStage?: 'pre-exec' | 'post-exec' | 'review' | 'always';
    tags?: string[];
  } {
    const metadata: {
      category?: string;
      level?: 'REQUIRED' | 'RECOMMENDED' | 'OPTIONAL';
      enforcementStage?: 'pre-exec' | 'post-exec' | 'review' | 'always';
      tags?: string[];
    } = {};

    // Extract from YAML-style header at the top of the file
    const categoryMatch = markdown.match(/\*\*Category\*\*:\s*(\w+)/);
    if (categoryMatch) {
      metadata.category = categoryMatch[1];
    }

    const levelMatch = markdown.match(/\*\*Level\*\*:\s*(REQUIRED|RECOMMENDED|OPTIONAL)/i);
    if (levelMatch) {
      metadata.level = levelMatch[1].toUpperCase() as 'REQUIRED' | 'RECOMMENDED' | 'OPTIONAL';
    }

    const stageMatch = markdown.match(/\*\*Enforcement Stage\*\*:\s*(\w+)/);
    if (stageMatch) {
      const stage = stageMatch[1] as 'pre-exec' | 'post-exec' | 'review' | 'always';
      if (['pre-exec', 'post-exec', 'review', 'always'].includes(stage)) {
        metadata.enforcementStage = stage;
      }
    }

    // Extract tags from line like: **Tags**: tag1, tag2, tag3
    const tagsMatch = markdown.match(/\*\*Tags\*\*:\s*(.+)/);
    if (tagsMatch) {
      metadata.tags = tagsMatch[1]
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
    }

    return metadata;
  }

  async storeExecutablePolicy(
    policyId: string,
    pythonCode: string,
    toolName: string
  ): Promise<void> {
    const policy = await this.getPolicy(policyId);
    if (!policy) throw new Error(`Policy ${policyId} not found`);

    // Store the actual code in executable_tools table
    this.db.upsertExecutableTool({
      id: `${policyId}_${toolName}`,
      policyId,
      toolName,
      code: pythonCode,
      language: 'python',
      createdAt: new Date().toISOString(),
    });

    // Update policy's tool list
    const tools = [...(policy.executableTools || [])];
    if (!tools.includes(toolName)) {
      tools.push(toolName);
    }

    this.db.updatePolicy(
      { id: policyId },
      {
        executableTools: tools,
        updatedAt: new Date().toISOString(),
        version: policy.version + 1,
      }
    );
  }

  /** Coerce a stored row's `level` to the enum so legacy/hand-edited values
   * (e.g. "mandatory") don't fail validation. Unknown non-empty levels default
   * to RECOMMENDED so the policy is kept, not dropped. */
  private normalizePolicyRow(r: unknown): Record<string, unknown> {
    const row = { ...(r as Record<string, unknown>) };
    const lvl = String(row.level ?? '').toUpperCase();
    if (lvl === 'MANDATORY' || lvl === 'REQUIRED') row.level = 'REQUIRED';
    else if (lvl === 'OPTIONAL') row.level = 'OPTIONAL';
    else if (lvl === 'RECOMMENDED') row.level = 'RECOMMENDED';
    else if (row.level != null && row.level !== '') row.level = 'RECOMMENDED';
    return row;
  }

  /** Parse DB rows into Policies, TOLERATING malformed rows: a single bad row
   * (e.g. an invalid `level`) is skipped instead of throwing out the whole list
   * — which used to 500 the dashboard's policy panel. */
  private parsePolicyRows(rows: unknown[]): Policy[] {
    const out: Policy[] = [];
    for (const r of rows) {
      const res = PolicySchema.safeParse(this.normalizePolicyRow(r));
      if (res.success) out.push(res.data);
    }
    return out;
  }

  async getPolicy(id: string): Promise<Policy | null> {
    const result = this.db.findOnePolicy({ id });
    if (!result) return null;
    const res = PolicySchema.safeParse(this.normalizePolicyRow(result));
    return res.success ? res.data : null;
  }

  async getAllPolicies(): Promise<Policy[]> {
    const results = this.db.getAllActivePolicies();
    return this.parsePolicyRows(results);
  }

  /** ALL policies including inactive (dashboard management needs disabled rows). */
  async getAllPoliciesUnfiltered(): Promise<Policy[]> {
    return this.parsePolicyRows(this.db.getAllPolicyRows());
  }

  async getRequiredPolicies(): Promise<Policy[]> {
    const results = this.db.findPolicies({ level: 'REQUIRED', isActive: true });
    return this.parsePolicyRows(results);
  }

  async getCategoriesPolicies(category: string): Promise<Policy[]> {
    const results = this.db.findPolicies({ category, isActive: true });
    return this.parsePolicyRows(results);
  }

  async togglePolicy(id: string, active: boolean): Promise<void> {
    this.db.updatePolicy({ id }, { isActive: active });
  }

  async setEnforcementStage(
    id: string,
    stage: 'pre-exec' | 'post-exec' | 'review' | 'always'
  ): Promise<void> {
    this.db.updatePolicy({ id }, { enforcementStage: stage, updatedAt: new Date().toISOString() });
  }

  async setLevel(id: string, level: 'REQUIRED' | 'RECOMMENDED' | 'OPTIONAL'): Promise<void> {
    this.db.updatePolicy({ id }, { level, updatedAt: new Date().toISOString() });
  }

  async getPoliciesByStage(
    stage: 'pre-exec' | 'post-exec' | 'review' | 'always'
  ): Promise<Policy[]> {
    const results = this.db.findPolicies({ enforcementStage: stage, isActive: true });
    return this.parsePolicyRows(results);
  }

  async searchByTags(tags: string[]): Promise<Policy[]> {
    const results = this.db.getAllActivePolicies();
    return this.parsePolicyRows(
      results.filter((r) => {
        const policyTags = r.tags as string[];
        return policyTags && tags.some((t) => policyTags.includes(t));
      })
    );
  }

  async getRelevantPolicies(context: string, topK: number = 3): Promise<Policy[]> {
    const allPolicies = await this.getAllPolicies();
    const contextLower = context.toLowerCase();

    const scored = allPolicies.map((policy) => {
      let score = 0;
      // REQUIRED policies always score higher
      if (policy.level === 'REQUIRED') score += 10;
      // Tag matches
      score += policy.tags.filter((t) => contextLower.includes(t.toLowerCase())).length * 3;
      // Name match
      if (contextLower.includes(policy.name.toLowerCase())) score += 5;
      // Category match
      if (contextLower.includes(policy.category)) score += 2;
      // Priority boost
      score += policy.priority / 100;
      return { policy, score };
    });

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((item) => item.policy);
  }

  async getExecutableToolCode(policyId: string, toolName: string): Promise<string | null> {
    const tool = this.db.findExecutableTool(policyId, toolName);
    return tool ? (tool.code as string) : null;
  }

  private extractPolicyName(markdown: string): string {
    const match = markdown.match(/^#\s+(.+)/m);
    return match ? match[1].trim() : 'Untitled Policy';
  }
}

// Lazy singleton - does NOT create DB connection on import
let _instance: PolicyMemoryManager | null = null;
export function getPolicyMemoryManager(): PolicyMemoryManager {
  if (!_instance) {
    _instance = new PolicyMemoryManager();
  }
  return _instance;
}
