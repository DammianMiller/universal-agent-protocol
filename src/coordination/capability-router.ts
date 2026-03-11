import type { AgentRegistryEntry } from '../types/coordination.js';
import type { Task, TaskType } from '../tasks/types.js';

/**
 * Agent capability definitions for intelligent task routing.
 */
export type AgentCapability =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'rust'
  | 'go'
  | 'cpp'
  | 'java'
  | 'cli'
  | 'frontend'
  | 'backend'
  | 'database'
  | 'security'
  | 'performance'
  | 'documentation'
  | 'testing'
  | 'devops'
  | 'infrastructure'
  | 'code-review'
  | 'refactoring';

/**
 * Droid/skill mapping for capability routing.
 */
export interface CapabilityMapping {
  capability: AgentCapability;
  droids: string[];
  skills: string[];
  filePatterns: string[];
  taskTypes: TaskType[];
  priority: number; // Higher = more specialized
}

/**
 * Default capability mappings for UAM droids and skills.
 */
export const DEFAULT_CAPABILITY_MAPPINGS: CapabilityMapping[] = [
  {
    capability: 'typescript',
    droids: ['typescript-node-expert', 'javascript-pro'],
    skills: ['typescript-node-expert'],
    filePatterns: ['*.ts', '*.tsx', '*.mts', '*.cts'],
    taskTypes: ['task', 'feature', 'bug'],
    priority: 10,
  },
  {
    capability: 'javascript',
    droids: ['javascript-pro'],
    skills: [],
    filePatterns: ['*.js', '*.jsx', '*.mjs', '*.cjs'],
    taskTypes: ['task', 'feature', 'bug'],
    priority: 8,
  },
  {
    capability: 'cli',
    droids: ['cli-design-expert'],
    skills: ['cli-design-expert'],
    filePatterns: ['**/cli/**', '**/bin/**', '**/commands/**'],
    taskTypes: ['task', 'feature'],
    priority: 9,
  },
  {
    capability: 'security',
    droids: ['security-auditor', 'security-code-reviewer'],
    skills: [],
    filePatterns: ['**/auth/**', '**/security/**', '*.key', '*.pem'],
    taskTypes: ['bug', 'task'],
    priority: 10,
  },
  {
    capability: 'performance',
    droids: ['performance-optimizer', 'performance-reviewer'],
    skills: [],
    filePatterns: ['**/perf/**', '**/benchmark/**'],
    taskTypes: ['task', 'chore'],
    priority: 8,
  },
  {
    capability: 'documentation',
    droids: ['documentation-expert', 'documentation-accuracy-reviewer'],
    skills: [],
    filePatterns: ['*.md', '**/docs/**', 'README*', 'CHANGELOG*'],
    taskTypes: ['task', 'chore'],
    priority: 6,
  },
  {
    capability: 'code-review',
    droids: ['code-quality-guardian', 'code-quality-reviewer'],
    skills: [],
    filePatterns: ['*'],
    taskTypes: ['task', 'chore'],
    priority: 7,
  },
  {
    capability: 'testing',
    droids: ['test-coverage-reviewer', 'test-plan-writer'],
    skills: [],
    filePatterns: ['*.test.*', '*.spec.*', '**/tests/**', '**/__tests__/**'],
    taskTypes: ['task', 'bug'],
    priority: 8,
  },
  {
    capability: 'infrastructure',
    droids: [],
    skills: [],
    filePatterns: ['*.tf', '**/terraform/**', '**/k8s/**', '**/helm/**', 'Dockerfile*', 'docker-compose*'],
    taskTypes: ['task', 'chore'],
    priority: 9,
  },
  {
    capability: 'python',
    droids: ['python-pro'],
    skills: [],
    filePatterns: ['*.py', '**/python/**'],
    taskTypes: ['task', 'feature', 'bug'],
    priority: 10,
  },
  {
    capability: 'rust',
    droids: ['rust-pro'],
    skills: [],
    filePatterns: ['*.rs', 'Cargo.toml'],
    taskTypes: ['task', 'feature', 'bug'],
    priority: 10,
  },
  {
    capability: 'go',
    droids: ['go-pro'],
    skills: [],
    filePatterns: ['*.go', 'go.mod', 'go.sum'],
    taskTypes: ['task', 'feature', 'bug'],
    priority: 10,
  },
];

export interface RoutingResult {
  recommendedDroids: string[];
  recommendedSkills: string[];
  matchedCapabilities: AgentCapability[];
  confidence: number; // 0-1
  reasoning: string;
}

export interface AgentMatch {
  agent: AgentRegistryEntry;
  matchedCapabilities: AgentCapability[];
  score: number;
}

/**
 * Capability-based router for intelligent task and agent routing.
 */
export class CapabilityRouter {
  private mappings: CapabilityMapping[];

  constructor(customMappings?: CapabilityMapping[]) {
    this.mappings = customMappings || DEFAULT_CAPABILITY_MAPPINGS;
  }

  /**
   * Route a task to the best droids/skills based on task content and affected files.
   */
  routeTask(
    task: Task,
    affectedFiles?: string[]
  ): RoutingResult {
    const matchedCapabilities: AgentCapability[] = [];
    const droidScores = new Map<string, number>();
    const skillScores = new Map<string, number>();
    const reasons: string[] = [];

    // Match by file patterns
    if (affectedFiles && affectedFiles.length > 0) {
      for (const mapping of this.mappings) {
        for (const pattern of mapping.filePatterns) {
          const matches = this.matchesPattern(affectedFiles, pattern);
          if (matches.length > 0) {
            matchedCapabilities.push(mapping.capability);
            
            for (const droid of mapping.droids) {
              const current = droidScores.get(droid) || 0;
              droidScores.set(droid, current + mapping.priority);
            }
            
            for (const skill of mapping.skills) {
              const current = skillScores.get(skill) || 0;
              skillScores.set(skill, current + mapping.priority);
            }
            
            reasons.push(`Files ${matches.slice(0, 2).join(', ')} match ${mapping.capability}`);
            break; // Only count each mapping once per task
          }
        }
      }
    }

    // Match by task type
    for (const mapping of this.mappings) {
      if (mapping.taskTypes.includes(task.type)) {
        // Boost score slightly for type match
        for (const droid of mapping.droids) {
          const current = droidScores.get(droid) || 0;
          droidScores.set(droid, current + 1);
        }
      }
    }

    // Match by task title/labels keywords
    const keywords = this.extractKeywords(task);
    for (const mapping of this.mappings) {
      if (keywords.some(kw => kw.includes(mapping.capability) || mapping.capability.includes(kw))) {
        if (!matchedCapabilities.includes(mapping.capability)) {
          matchedCapabilities.push(mapping.capability);
        }
        
        for (const droid of mapping.droids) {
          const current = droidScores.get(droid) || 0;
          droidScores.set(droid, current + mapping.priority / 2);
        }
        
        reasons.push(`Keywords match ${mapping.capability}`);
      }
    }

    // Sort by score and take top recommendations
    const sortedDroids = [...droidScores.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([droid]) => droid);
    
    const sortedSkills = [...skillScores.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([skill]) => skill);

    // Calculate confidence
    const maxPossibleScore = this.mappings.reduce((sum, m) => sum + m.priority, 0);
    const actualScore = [...droidScores.values()].reduce((sum, s) => sum + s, 0);
    const confidence = Math.min(1, actualScore / (maxPossibleScore / 2));

    return {
      recommendedDroids: sortedDroids.slice(0, 3),
      recommendedSkills: sortedSkills.slice(0, 2),
      matchedCapabilities: [...new Set(matchedCapabilities)],
      confidence,
      reasoning: reasons.length > 0 ? reasons.join('; ') : 'No specific matches, using general routing',
    };
  }

  /**
   * Find the best agent for a task based on capabilities.
   */
  findBestAgent(
    task: Task,
    availableAgents: AgentRegistryEntry[],
    affectedFiles?: string[]
  ): AgentMatch | null {
    if (availableAgents.length === 0) return null;

    const routing = this.routeTask(task, affectedFiles);
    const agentMatches: AgentMatch[] = [];

    for (const agent of availableAgents) {
      const agentCapabilities = (agent.capabilities || []) as AgentCapability[];
      const matchedCapabilities = agentCapabilities.filter(cap => 
        routing.matchedCapabilities.includes(cap)
      );

      let score = matchedCapabilities.length * 10;
      
      // Boost for agents with recommended droids in their name
      if (routing.recommendedDroids.some(d => agent.name.includes(d))) {
        score += 20;
      }

      // Boost for idle agents
      if (agent.status === 'idle') {
        score += 5;
      }

      // Penalty for agents with current tasks
      if (agent.currentTask) {
        score -= 10;
      }

      agentMatches.push({
        agent,
        matchedCapabilities,
        score,
      });
    }

    // Sort by score descending
    agentMatches.sort((a, b) => b.score - a.score);

    return agentMatches[0] || null;
  }

  /**
   * Route files to appropriate capabilities.
   */
  routeFiles(files: string[]): Map<AgentCapability, string[]> {
    const result = new Map<AgentCapability, string[]>();

    for (const mapping of this.mappings) {
      for (const pattern of mapping.filePatterns) {
        const matches = this.matchesPattern(files, pattern);
        if (matches.length > 0) {
          const existing = result.get(mapping.capability) || [];
          result.set(mapping.capability, [...new Set([...existing, ...matches])]);
        }
      }
    }

    return result;
  }

  /**
   * Get recommended parallel review droids for a set of files.
   */
  getParallelReviewDroids(files: string[]): string[] {
    const routing = this.routeFiles(files);
    const droids = new Set<string>();

    // Always include quality and security for any code change
    droids.add('code-quality-guardian');
    droids.add('security-auditor');

    // Add capability-specific droids
    for (const [capability] of routing) {
      const mapping = this.mappings.find(m => m.capability === capability);
      if (mapping) {
        for (const droid of mapping.droids) {
          droids.add(droid);
        }
      }
    }

    // Add documentation reviewer if docs changed
    if (routing.has('documentation')) {
      droids.add('documentation-expert');
    }

    // Add performance reviewer for performance-critical areas
    if (routing.has('performance') || routing.has('database')) {
      droids.add('performance-optimizer');
    }

    return [...droids];
  }

  /**
   * Match files against a glob-like pattern.
   */
  private matchesPattern(files: string[], pattern: string): string[] {
    const regex = this.patternToRegex(pattern);
    return files.filter(f => regex.test(f));
  }

  /**
   * Convert glob pattern to regex.
   */
  private patternToRegex(pattern: string): RegExp {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '{{GLOBSTAR}}')
      .replace(/\*/g, '[^/]*')
      .replace(/{{GLOBSTAR}}/g, '.*')
      .replace(/\?/g, '.');
    
    return new RegExp(`(^|/)${escaped}$`, 'i');
  }

  /**
   * Extract keywords from task for matching.
   */
  private extractKeywords(task: Task): string[] {
    const keywords: string[] = [];
    
    // From title
    keywords.push(...task.title.toLowerCase().split(/\W+/).filter(w => w.length > 2));
    
    // From labels
    keywords.push(...task.labels.map(l => l.toLowerCase()));
    
    // From type
    keywords.push(task.type);
    
    return keywords;
  }

  /**
   * Add or update a capability mapping.
   */
  addMapping(mapping: CapabilityMapping): void {
    const existingIndex = this.mappings.findIndex(m => m.capability === mapping.capability);
    if (existingIndex >= 0) {
      this.mappings[existingIndex] = mapping;
    } else {
      this.mappings.push(mapping);
    }
  }

  /**
   * Get all registered mappings.
   */
  getMappings(): CapabilityMapping[] {
    return [...this.mappings];
  }
}

/**
 * Singleton instance for global capability routing.
 */
let globalRouter: CapabilityRouter | null = null;

export function getCapabilityRouter(): CapabilityRouter {
  if (!globalRouter) {
    globalRouter = new CapabilityRouter();
  }
  return globalRouter;
}

export function setCapabilityRouter(router: CapabilityRouter): void {
  globalRouter = router;
}
