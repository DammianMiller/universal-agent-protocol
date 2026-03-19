import { Policy, PolicySchema } from './schemas/policy.js';
import { DatabaseManager } from './database-manager.js';

export class PolicyMemoryManager {
  private _db: DatabaseManager | null = null;

  private get db(): DatabaseManager {
    if (!this._db) {
      this._db = new DatabaseManager();
    }
    return this._db;
  }

  async storeRawPolicy(rawMarkdown: string, metadata: Partial<Policy> = {}): Promise<string> {
    const policyId = crypto.randomUUID();
    const name = this.extractPolicyName(rawMarkdown);
    const extractedMetadata = this.extractPolicyMetadata(rawMarkdown);

    const policy: Policy = {
      id: policyId,
      name,
      category: (metadata.category ?? extractedMetadata.category ?? 'custom') as Policy['category'],
      level: (metadata.level ?? extractedMetadata.level ?? 'RECOMMENDED') as Policy['level'],
      enforcementStage:
        metadata.enforcementStage || extractedMetadata.enforcementStage || 'pre-exec',
      rawMarkdown,
      tags: metadata.tags || extractedMetadata.tags || [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
      isActive: true,
      priority: metadata.priority ?? 50,
    };

    this.db.upsertPolicy(policy as unknown as Record<string, unknown>);
    return policyId;
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

  async getPolicy(id: string): Promise<Policy | null> {
    const result = this.db.findOnePolicy({ id });
    if (!result) return null;
    return PolicySchema.parse(result);
  }

  async getAllPolicies(): Promise<Policy[]> {
    const results = this.db.getAllActivePolicies();
    return results.map((r) => PolicySchema.parse(r));
  }

  async getRequiredPolicies(): Promise<Policy[]> {
    const results = this.db.findPolicies({ level: 'REQUIRED', isActive: true });
    return results.map((r) => PolicySchema.parse(r));
  }

  async getCategoriesPolicies(category: string): Promise<Policy[]> {
    const results = this.db.findPolicies({ category, isActive: true });
    return results.map((r) => PolicySchema.parse(r));
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
    return results.map((r) => PolicySchema.parse(r));
  }

  async searchByTags(tags: string[]): Promise<Policy[]> {
    const results = this.db.getAllActivePolicies();
    return results
      .filter((r) => {
        const policyTags = r.tags as string[];
        return policyTags && tags.some((t) => policyTags.includes(t));
      })
      .map((r) => PolicySchema.parse(r));
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
