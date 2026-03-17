/**
 * Decoder-First Gate for UAP Protocol Compliance
 *
 * Implements the Decoder-First validation gate (Compliance Deviation #2).
 * Before any droid/agent executes a task, this gate validates:
 * 1. Droid metadata schema is valid
 * 2. Required tools are available
 * 3. Coordination claims don't conflict
 * 4. Task instruction passes ambiguity threshold
 *
 * This is an explicit pre-execution validator that replaces the
 * implicit validation previously done via memory checks.
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { detectAmbiguity } from '../memory/ambiguity-detector.js';

export interface DroidMeta {
  name: string;
  description: string;
  model?: string;
  coordination?: {
    channels?: string[];
    claims?: string[];
  };
  tools?: string[];
}

export interface TaskContext {
  agentId: string;
  taskInstruction: string;
  worktreePath?: string;
  projectRoot?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  ambiguityCheck?: {
    score: number;
    level: string;
    shouldAsk: boolean;
    questions: string[];
  };
}

export interface ValidationError {
  gate: string;
  message: string;
  severity: 'error' | 'fatal';
}

export interface ValidationWarning {
  gate: string;
  message: string;
  suggestion: string;
}

/**
 * Validate all decoder-first gates before droid execution.
 * Returns a ValidationResult indicating whether execution should proceed.
 */
export async function validateDecoderFirst(
  droidName: string,
  taskContext: TaskContext,
  options: {
    projectRoot?: string;
    requireWorktree?: boolean;
    ambiguityThreshold?: number;
  } = {}
): Promise<ValidationResult> {
  const {
    projectRoot = process.cwd(),
    requireWorktree = false,
    ambiguityThreshold = 0.6,
  } = options;

  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  // Gate 1: Validate droid metadata schema
  const droidMeta = await loadDroidMeta(droidName, projectRoot);
  if (!droidMeta) {
    errors.push({
      gate: 'schema-validation',
      message: `Droid "${droidName}" not found or has invalid metadata`,
      severity: 'fatal',
    });
  } else {
    const schemaErrors = validateDroidSchema(droidMeta);
    errors.push(...schemaErrors);
  }

  // Gate 2: Check required tools availability
  if (droidMeta?.tools) {
    const toolErrors = checkToolAvailability(droidMeta.tools);
    warnings.push(...toolErrors);
  }

  // Gate 3: Validate coordination claims don't conflict
  if (droidMeta?.coordination?.claims) {
    const conflictErrors = await detectCoordinationConflicts(
      droidName,
      taskContext.agentId,
      droidMeta.coordination.claims,
      projectRoot
    );
    errors.push(...conflictErrors);
  }

  // Gate 4: Worktree requirement check
  if (requireWorktree && !taskContext.worktreePath) {
    errors.push({
      gate: 'worktree-requirement',
      message: `Droid "${droidName}" requires an active worktree but none was provided`,
      severity: 'error',
    });
  }

  // Gate 5: Ambiguity check on task instruction
  const ambiguityResult = detectAmbiguity(taskContext.taskInstruction);
  const ambiguityCheck = {
    score: ambiguityResult.score,
    level: ambiguityResult.level,
    shouldAsk: ambiguityResult.score >= ambiguityThreshold,
    questions: ambiguityResult.questions
      .filter((q) => q.priority === 'blocking')
      .map((q) => q.question),
  };

  if (ambiguityResult.score >= ambiguityThreshold) {
    warnings.push({
      gate: 'ambiguity-check',
      message: `Task instruction has high ambiguity (score: ${ambiguityResult.score.toFixed(2)})`,
      suggestion: `Consider asking: ${ambiguityCheck.questions.slice(0, 2).join('; ')}`,
    });
  }

  // Determine overall validity (fatal errors block, regular errors warn)
  const hasFatalErrors = errors.some((e) => e.severity === 'fatal');
  const valid = !hasFatalErrors;

  return {
    valid,
    errors,
    warnings,
    ambiguityCheck,
  };
}

/**
 * Load droid metadata from filesystem
 */
async function loadDroidMeta(droidName: string, projectRoot: string): Promise<DroidMeta | null> {
  // Search in standard droid locations
  const droidPaths = [
    join(projectRoot, '.factory/droids', `${droidName}.md`),
    join(projectRoot, '.claude/agents', `${droidName}.md`),
  ];

  for (const droidPath of droidPaths) {
    if (existsSync(droidPath)) {
      try {
        const content = readFileSync(droidPath, 'utf-8');
        return parseDroidFrontmatter(content, droidName);
      } catch {
        continue;
      }
    }
  }

  // Try to find by partial name match
  const droidDirs = [join(projectRoot, '.factory/droids'), join(projectRoot, '.claude/agents')];

  for (const dir of droidDirs) {
    if (!existsSync(dir)) continue;
    try {
      const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
      for (const file of files) {
        if (file.toLowerCase().includes(droidName.toLowerCase())) {
          const content = readFileSync(join(dir, file), 'utf-8');
          return parseDroidFrontmatter(content, droidName);
        }
      }
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Parse YAML frontmatter from droid markdown file
 */
function parseDroidFrontmatter(content: string, fallbackName: string): DroidMeta {
  const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) {
    return { name: fallbackName, description: 'No frontmatter found' };
  }

  const frontmatter = frontmatterMatch[1];
  const meta: DroidMeta = { name: fallbackName, description: '' };

  // Simple YAML parsing for common fields
  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
  if (nameMatch) meta.name = nameMatch[1].trim();

  const descMatch = frontmatter.match(/^description:\s*(.+)$/m);
  if (descMatch) meta.description = descMatch[1].trim();

  const modelMatch = frontmatter.match(/^model:\s*(.+)$/m);
  if (modelMatch) meta.model = modelMatch[1].trim();

  // Parse coordination block
  const coordMatch = frontmatter.match(/coordination:\s*\n((?:\s+.+\n)*)/);
  if (coordMatch) {
    meta.coordination = {};
    const channelsMatch = coordMatch[1].match(/channels:\s*\[([^\]]*)\]/);
    if (channelsMatch) {
      meta.coordination.channels = channelsMatch[1]
        .split(',')
        .map((s) => s.trim().replace(/['"]/g, ''));
    }
    const claimsMatch = coordMatch[1].match(/claims:\s*\[([^\]]*)\]/);
    if (claimsMatch) {
      meta.coordination.claims = claimsMatch[1]
        .split(',')
        .map((s) => s.trim().replace(/['"]/g, ''));
    }
  }

  return meta;
}

/**
 * Validate droid metadata schema
 */
function validateDroidSchema(meta: DroidMeta): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!meta.name || meta.name.length === 0) {
    errors.push({
      gate: 'schema-validation',
      message: 'Droid name is required',
      severity: 'error',
    });
  }

  if (!meta.description || meta.description.length === 0) {
    errors.push({
      gate: 'schema-validation',
      message: 'Droid description is required',
      severity: 'error',
    });
  }

  // Validate coordination channels are known
  if (meta.coordination?.channels) {
    const validChannels = ['review', 'broadcast', 'direct', 'task', 'alert'];
    for (const channel of meta.coordination.channels) {
      if (!validChannels.includes(channel)) {
        errors.push({
          gate: 'schema-validation',
          message: `Unknown coordination channel: "${channel}"`,
          severity: 'error',
        });
      }
    }
  }

  return errors;
}

/**
 * Check if required tools are available
 */
function checkToolAvailability(tools: string[]): ValidationWarning[] {
  const warnings: ValidationWarning[] = [];

  // Known tool categories
  const knownTools = new Set([
    'read',
    'write',
    'edit',
    'glob',
    'grep',
    'bash',
    'webfetch',
    'task',
    'question',
    'todowrite',
  ]);

  for (const tool of tools) {
    if (!knownTools.has(tool.toLowerCase())) {
      warnings.push({
        gate: 'tool-availability',
        message: `Tool "${tool}" may not be available in all environments`,
        suggestion: `Ensure "${tool}" is configured in the agent's tool set`,
      });
    }
  }

  return warnings;
}

/**
 * Detect coordination claim conflicts with other active agents
 */
async function detectCoordinationConflicts(
  _droidName: string,
  agentId: string,
  claims: string[],
  projectRoot: string
): Promise<ValidationError[]> {
  const errors: ValidationError[] = [];

  // Check coordination database for conflicting claims
  const coordDbPath = join(projectRoot, 'agents/data/coordination/coordination.db');
  if (!existsSync(coordDbPath)) return errors;

  try {
    // Dynamic import to avoid requiring better-sqlite3 at module load
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(coordDbPath, { readonly: true });

    for (const claim of claims) {
      if (claim === 'exclusive') {
        // Check if any other agent has an active exclusive claim
        const existing = db
          .prepare(
            `
          SELECT agent_id, droid_name FROM work_claims
          WHERE claim_type = 'exclusive'
          AND agent_id != ?
          AND status = 'active'
        `
          )
          .all(agentId) as Array<{ agent_id: string; droid_name: string }>;

        if (existing.length > 0) {
          errors.push({
            gate: 'coordination-conflict',
            message: `Exclusive claim conflict: agent "${existing[0].agent_id}" (droid: ${existing[0].droid_name}) already holds an exclusive claim`,
            severity: 'error',
          });
        }
      }
    }

    db.close();
  } catch {
    // Coordination DB not available or schema mismatch — not a fatal error
  }

  return errors;
}

export default {
  validateDecoderFirst,
};
