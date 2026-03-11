/**
 * Task Classification System for UAM
 * 
 * Classifies tasks into categories and routes to appropriate droids/memory.
 * Based on Terminal-Bench 2.0 task categories and Droid's routing strategies.
 */

export type TaskCategory = 
  | 'sysadmin'      // Linux, kernel, QEMU, networking, DNS, cron, systemd
  | 'security'      // CVE, exploits, secrets, hashing, certificates
  | 'ml-training'   // Model training, datasets, MTEB, embeddings
  | 'debugging'     // Conda conflicts, git issues, error fixing
  | 'coding'        // Algorithms, APIs, refactoring, code generation
  | 'file-ops'      // Archives, downloads, conversions
  | 'testing'       // Unit tests, integration tests, test frameworks
  | 'constraint-satisfaction'  // OPTIMIZATION 3: Added for scheduling/optimization tasks
  | 'unknown';

export interface TaskClassification {
  category: TaskCategory;
  confidence: number;
  keywords: string[];
  suggestedDroid: string;
  memoryQueryHints: string[];
  requiredCapabilities: string[];
}

interface CategoryPattern {
  category: TaskCategory;
  patterns: RegExp[];
  keywords: string[];
  droid: string;
  capabilities: string[];
}

const CATEGORY_PATTERNS: CategoryPattern[] = [
  {
    category: 'sysadmin',
    patterns: [
      /kernel|linux|qemu|kvm|virtualization/i,
      /systemd|systemctl|journalctl|service/i,
      /network|dns|firewall|iptables|nftables/i,
      /cron|crontab|scheduling|daemon/i,
      /mount|filesystem|partition|lvm|fdisk/i,
      /docker|container|kubernetes|k8s/i,
      /nginx|apache|web server|reverse proxy/i,
      /ssh|scp|rsync|remote/i,
    ],
    keywords: ['kernel', 'qemu', 'systemd', 'network', 'dns', 'cron', 'docker', 'mount', 'ssh'],
    droid: 'sysadmin-expert',
    capabilities: ['shell', 'root', 'networking', 'services'],
  },
  {
    category: 'security',
    patterns: [
      /cve-?\d{4}-?\d+/i,
      /exploit|vulnerability|attack|injection/i,
      /secret|password|credential|token|api.?key/i,
      /hash|crack|bcrypt|sha|md5/i,
      /ssl|tls|certificate|x509/i,
      /encrypt|decrypt|cipher|aes/i,
      /auth|oauth|jwt|session/i,
      /sanitize|escape|xss|csrf|sqli/i,
    ],
    keywords: ['CVE', 'exploit', 'secret', 'hash', 'certificate', 'encrypt', 'authentication'],
    droid: 'security-auditor',
    capabilities: ['security', 'cryptography', 'vulnerability-analysis'],
  },
  {
    category: 'ml-training',
    patterns: [
      /train|training|model|neural|deep learning/i,
      /pytorch|tensorflow|keras|transformers/i,
      /dataset|dataloader|batch|epoch/i,
      /mteb|embedding|sentence.?transformer/i,
      /classifier|classification|regression/i,
      /reinforcement|rl|reward|agent|gym/i,
      /gpu|cuda|nvidia|tensor/i,
      /hugging.?face|tokenizer|bert|gpt/i,
    ],
    keywords: ['train', 'model', 'pytorch', 'dataset', 'embedding', 'classifier', 'GPU'],
    droid: 'ml-training-expert',
    capabilities: ['python', 'ml-frameworks', 'gpu', 'data-processing'],
  },
  {
    category: 'debugging',
    patterns: [
      /debug|fix|broken|error|exception/i,
      /conda|pip|dependency|conflict|version/i,
      /git|merge|rebase|conflict|reflog/i,
      /stack.?trace|traceback|crash/i,
      /memory.?leak|segfault|core.?dump/i,
      /log|logging|diagnose|troubleshoot/i,
    ],
    keywords: ['debug', 'fix', 'error', 'conda', 'pip', 'git', 'conflict', 'crash'],
    droid: 'debug-expert',
    capabilities: ['debugging', 'profiling', 'version-management'],
  },
  {
    category: 'coding',
    patterns: [
      /implement|function|class|method|algorithm/i,
      /refactor|optimize|improve|clean/i,
      /api|endpoint|rest|graphql|server/i,
      /typescript|javascript|python|rust|go/i,
      /singleton|factory|strategy|pattern/i,
      /async|await|promise|callback/i,
    ],
    keywords: ['implement', 'function', 'class', 'refactor', 'API', 'algorithm', 'pattern'],
    droid: 'code-quality-guardian',
    capabilities: ['coding', 'design-patterns', 'apis'],
  },
  {
    category: 'file-ops',
    patterns: [
      /archive|zip|tar|extract|compress/i,
      /download|fetch|curl|wget/i,
      /convert|transform|parse|format/i,
      /csv|json|xml|yaml|parquet/i,
      /file|directory|path|copy|move/i,
    ],
    keywords: ['archive', 'download', 'convert', 'file', 'extract'],
    droid: 'terminal-bench-optimizer',
    capabilities: ['file-operations', 'data-formats'],
  },
  {
    category: 'testing',
    patterns: [
      /test|spec|unit|integration|e2e/i,
      /vitest|jest|pytest|mocha|cypress/i,
      /coverage|assertion|mock|stub|spy/i,
      /tdd|bdd|test.?driven/i,
    ],
    keywords: ['test', 'spec', 'coverage', 'mock', 'assertion'],
    droid: 'code-quality-guardian',
    capabilities: ['testing', 'test-frameworks', 'coverage'],
  },
  // OPTIMIZATION 3: Added constraint-satisfaction category
  {
    category: 'constraint-satisfaction',
    patterns: [
      /schedul\w+|timetabl\w+|allocat\w+/i,
      /constraint|satisfy|feasible|optimal/i,
      /resource.?alloc|slot|capacity/i,
      /minimize|maximize|objective|cost.?function/i,
      /backtrack|search|pruning|heuristic/i,
    ],
    keywords: ['schedule', 'constraint', 'optimize', 'allocate', 'slot', 'feasible'],
    droid: 'code-quality-guardian',
    capabilities: ['algorithms', 'optimization', 'constraint-solving'],
  },
];

/**
 * Classify a task based on its instruction/prompt
 * OPTIMIZATION 3: Fixed scoring to use actual max possible scores per category
 */
export function classifyTask(instruction: string): TaskClassification {
  const normalizedInstruction = instruction.toLowerCase();
  const scores: Map<TaskCategory, number> = new Map();
  const matchedKeywords: Map<TaskCategory, string[]> = new Map();
  const maxScores: Map<TaskCategory, number> = new Map();

  // Score each category based on pattern matches
  for (const categoryPattern of CATEGORY_PATTERNS) {
    let score = 0;
    const keywords: string[] = [];

    // OPTIMIZATION 3: Calculate actual max possible score for this category
    const maxPossible = categoryPattern.patterns.length * 2 + categoryPattern.keywords.length;
    maxScores.set(categoryPattern.category, maxPossible);

    // Check regex patterns
    for (const pattern of categoryPattern.patterns) {
      if (pattern.test(instruction)) {
        score += 2;
      }
    }

    // Check keywords
    for (const keyword of categoryPattern.keywords) {
      if (normalizedInstruction.includes(keyword.toLowerCase())) {
        score += 1;
        keywords.push(keyword);
      }
    }

    scores.set(categoryPattern.category, score);
    matchedKeywords.set(categoryPattern.category, keywords);
  }

  // Find best match
  let bestCategory: TaskCategory = 'unknown';
  let bestScore = 0;
  
  for (const [category, score] of scores) {
    if (score > bestScore) {
      bestScore = score;
      bestCategory = category;
    }
  }

  // OPTIMIZATION 3: Calculate confidence using actual max score for the matched category
  // This gives more accurate confidence than a hardcoded estimate
  const categoryMaxScore = maxScores.get(bestCategory) || 20;
  const confidence = Math.min(bestScore / categoryMaxScore, 1);

  // Get pattern config for best category
  const patternConfig = CATEGORY_PATTERNS.find(p => p.category === bestCategory);

  return {
    category: bestCategory,
    confidence,
    keywords: matchedKeywords.get(bestCategory) || [],
    suggestedDroid: patternConfig?.droid || 'terminal-bench-optimizer',
    memoryQueryHints: generateMemoryQueryHints(bestCategory, matchedKeywords.get(bestCategory) || []),
    requiredCapabilities: patternConfig?.capabilities || [],
  };
}

/**
 * Generate memory query hints based on task classification
 */
function generateMemoryQueryHints(category: TaskCategory, keywords: string[]): string[] {
  const hints: string[] = [];

  // Add category-specific hints
  switch (category) {
    case 'sysadmin':
      hints.push('linux administration', 'system configuration', 'service management');
      break;
    case 'security':
      hints.push('security vulnerability', 'secret management', 'authentication');
      break;
    case 'ml-training':
      hints.push('model training', 'dataset processing', 'machine learning');
      break;
    case 'debugging':
      hints.push('error fixing', 'dependency resolution', 'debugging techniques');
      break;
    case 'coding':
      hints.push('code implementation', 'design patterns', 'best practices');
      break;
    case 'file-ops':
      hints.push('file operations', 'data conversion', 'archive handling');
      break;
    case 'testing':
      hints.push('unit testing', 'test coverage', 'test patterns');
      break;
    case 'constraint-satisfaction':
      hints.push('constraint solving', 'scheduling algorithms', 'optimization techniques');
      break;
  }

  // Add keyword-based hints
  hints.push(...keywords.slice(0, 3));

  return hints;
}

/**
 * Extract entities from task instruction for memory queries
 */
export function extractTaskEntities(instruction: string): {
  technologies: string[];
  operations: string[];
  files: string[];
  concepts: string[];
} {
  const technologies: string[] = [];
  const operations: string[] = [];
  const files: string[] = [];
  const concepts: string[] = [];

  // Technology patterns
  const techPatterns = [
    /python|typescript|javascript|rust|go|java|c\+\+/gi,
    /pytorch|tensorflow|keras|transformers/gi,
    /docker|kubernetes|nginx|apache/gi,
    /postgres|mysql|mongodb|redis/gi,
    /react|vue|angular|next\.js/gi,
    /git|npm|pip|conda|cargo/gi,
  ];

  for (const pattern of techPatterns) {
    const matches = instruction.match(pattern);
    if (matches) {
      technologies.push(...matches.map(m => m.toLowerCase()));
    }
  }

  // Operation patterns
  const opPatterns = [
    /\b(create|build|implement|configure|setup|install)\b/gi,
    /\b(fix|debug|repair|resolve|troubleshoot)\b/gi,
    /\b(test|verify|validate|check|ensure)\b/gi,
    /\b(deploy|publish|release|ship)\b/gi,
    /\b(refactor|optimize|improve|clean)\b/gi,
  ];

  for (const pattern of opPatterns) {
    const matches = instruction.match(pattern);
    if (matches) {
      operations.push(...matches.map(m => m.toLowerCase()));
    }
  }

  // File path patterns
  const filePattern = /(?:\/[\w.-]+)+(?:\.\w+)?|[\w.-]+\.(ts|js|py|json|yaml|yml|md|txt|sh)/gi;
  const fileMatches = instruction.match(filePattern);
  if (fileMatches) {
    files.push(...fileMatches);
  }

  // Concept patterns
  const conceptPatterns = [
    /\b(authentication|authorization|security)\b/gi,
    /\b(caching|performance|optimization)\b/gi,
    /\b(api|endpoint|service|microservice)\b/gi,
    /\b(database|storage|persistence)\b/gi,
    /\b(testing|coverage|quality)\b/gi,
  ];

  for (const pattern of conceptPatterns) {
    const matches = instruction.match(pattern);
    if (matches) {
      concepts.push(...matches.map(m => m.toLowerCase()));
    }
  }

  return {
    technologies: [...new Set(technologies)],
    operations: [...new Set(operations)],
    files: [...new Set(files)],
    concepts: [...new Set(concepts)],
  };
}

/**
 * Get suggested memory queries based on task classification
 */
export function getSuggestedMemoryQueries(classification: TaskClassification): string[] {
  const queries: string[] = [];

  // Category-based queries
  queries.push(`${classification.category} best practices`);
  queries.push(`${classification.category} common mistakes`);
  queries.push(`${classification.category} patterns`);

  // Keyword-based queries
  for (const keyword of classification.keywords.slice(0, 3)) {
    queries.push(`${keyword} implementation`);
    queries.push(`${keyword} gotchas`);
  }

  // Capability-based queries
  for (const capability of classification.requiredCapabilities.slice(0, 2)) {
    queries.push(`${capability} tips`);
  }

  return queries;
}
