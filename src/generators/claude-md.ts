import Handlebars from 'handlebars';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { ProjectAnalysis, AgentContextConfig } from '../types/index.js';
import { prepopulateMemory, type DiscoveredSkill } from '../memory/prepopulate.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export async function generateClaudeMd(
  analysis: ProjectAnalysis,
  config: AgentContextConfig
): Promise<string> {
  // Determine platform mode
  const hasWebDatabase = !!config.memory?.shortTerm?.webDatabase;
  const forceDesktop = config.memory?.shortTerm?.forceDesktop;
  const isWebPlatform = hasWebDatabase && !forceDesktop;
  
  // Use appropriate template
  const template = isWebPlatform ? getWebTemplate() : getDesktopTemplate();
  
  // Register PROJECT partial if PROJECT.md exists
  const projectContent = getProjectTemplate();
  if (projectContent) {
    Handlebars.registerPartial('PROJECT', projectContent);
  }
  
  const compiled = Handlebars.compile(template);

  // Build comprehensive context from analysis + auto-population
  const context = await buildContext(analysis, config);
  return compiled(context);
}

/**
 * Get project-specific template content.
 * 
 * PROJECT.md contains all project-specific configuration, making template
 * upgrades seamless - no merge conflicts between universal patterns and
 * project-specific content.
 * 
 * Search order:
 * 1. .factory/PROJECT.md (preferred location)
 * 2. templates/PROJECT.md (fallback)
 * 3. PROJECT.md (root fallback)
 */
function getProjectTemplate(): string | null {
  const cwd = process.cwd();
  const locations = [
    join(cwd, '.factory/PROJECT.md'),           // Preferred: Factory config dir
    join(cwd, 'templates/PROJECT.md'),          // Fallback: templates dir
    join(cwd, 'templates/PROJECT.template.md'), // Template version
    join(cwd, 'PROJECT.md'),                    // Root fallback
  ];
  
  for (const path of locations) {
    if (existsSync(path)) {
      try {
        return readFileSync(path, 'utf-8');
      } catch (e) {
        console.warn(`Warning: Found PROJECT.md at ${path} but couldn't read it: ${e}`);
      }
    }
  }
  
  return null;
}

async function buildContext(
  analysis: ProjectAnalysis,
  config: AgentContextConfig
): Promise<Record<string, unknown>> {
  const cwd = process.cwd();
  
  // Detect web vs desktop
  const hasWebDatabase = !!config.memory?.shortTerm?.webDatabase;
  const forceDesktop = config.memory?.shortTerm?.forceDesktop;
  const isWebPlatform = hasWebDatabase && !forceDesktop;

  // Long-term memory config
  let longTermBackend = 'Qdrant';
  let longTermEndpoint = config.memory?.longTerm?.endpoint || 'localhost:6333';
  const longTermCollection = config.memory?.longTerm?.collection || 'agent_memory';
  
  if (config.memory?.longTerm?.provider === 'github') {
    longTermBackend = 'GitHub';
    longTermEndpoint = `${config.memory?.longTerm?.github?.repo || 'owner/repo'}/${config.memory?.longTerm?.github?.path || '.uam/memory'}`;
  } else if (config.memory?.longTerm?.provider === 'qdrant-cloud') {
    longTermBackend = 'Qdrant Cloud';
    longTermEndpoint = config.memory?.longTerm?.qdrantCloud?.url || 'https://xxxxxx.aws.cloud.qdrant.io:6333';
  }

  // Prepopulate memory from project
  let prepopulated: Awaited<ReturnType<typeof prepopulateMemory>> | null = null;
  try {
    prepopulated = await prepopulateMemory(cwd, { docs: true, git: true, skills: true, limit: 200 });
  } catch (e) {
    console.warn('Failed to prepopulate memory:', e);
  }

  // Build repository structure
  const repoStructure = buildRepositoryStructure(cwd, analysis);
  
  // Discover skills, droids, commands
  const discoveredSkills = prepopulated?.skills || [];
  const skills = discoveredSkills.filter(s => s.type === 'skill');
  const droids = discoveredSkills.filter(s => s.type === 'droid');
  // Commands discovered from prepopulate (unused currently but kept for reference)
  // const commands = discoveredSkills.filter(s => s.type === 'command');

  // Build skill mappings table
  const skillMappings = buildSkillMappings(skills);
  
  // Build language droids table
  const languageDroids = buildLanguageDroidsTable(droids, analysis.languages);
  
  // Build file type routing
  const fileTypeRouting = buildFileTypeRouting(analysis.languages);
  
  // Build discovered skills table
  const discoveredSkillsTable = buildDiscoveredSkillsTable(skills);

  // Extract troubleshooting from git history
  const troubleshooting = buildTroubleshootingSection(prepopulated?.longTerm || []);
  
  // Build architecture overview
  const architectureOverview = buildArchitectureOverview(analysis);
  
  // Build core components section
  const coreComponents = buildCoreComponentsSection(analysis);
  
  // Build key config files
  const keyConfigFiles = buildKeyConfigFiles(analysis);

  // Build essential commands
  const essentialCommands = buildEssentialCommands(analysis);

  // Build prepopulated knowledge section
  const prepopulatedKnowledge = buildPrepopulatedKnowledge(prepopulated);

  // Build cluster contexts
  const clusterContexts = buildClusterContexts(analysis);

  // Build project URLs
  const projectUrls = buildProjectUrls(analysis);

  // Build key workflows
  const keyWorkflows = buildKeyWorkflows(analysis);

  // Build infrastructure workflow
  const infraWorkflow = buildInfraWorkflow(analysis);

  // Build MCP plugins
  const mcpPlugins = buildMcpPlugins(cwd);

  // Build primary skills for decision loop
  const primarySkills = buildPrimarySkills(skills);

  // Build language examples
  const languageExamples = buildLanguageExamples(analysis.languages);

  // Build relevant patterns (pruned by project type to save tokens)
  const relevantPatterns = buildRelevantPatterns(analysis);

  // Template version for reproducibility
  const TEMPLATE_VERSION = '10.16-opt';

  return {
    // Project basics
    PROJECT_NAME: analysis.projectName || config.project.name,
    DESCRIPTION: analysis.description || config.project.description || '',
    DEFAULT_BRANCH: analysis.defaultBranch || config.project.defaultBranch || 'main',
    TEMPLATE_VERSION,
    
    // Issue tracker
    ISSUE_TRACKER: analysis.issueTracker ? 
      `Use [${analysis.issueTracker.name}](${analysis.issueTracker.url || '#'}) for issue tracking.` : 
      null,

    // Memory config
    MEMORY_DB_PATH: config.memory?.shortTerm?.path || 'agents/data/memory/short_term.db',
    MEMORY_QUERY_CMD: 'uam memory query',
    MEMORY_STORE_CMD: 'uam memory store',
    MEMORY_START_CMD: 'uam memory start',
    MEMORY_STATUS_CMD: 'uam memory status',
    MEMORY_STOP_CMD: 'uam memory stop',
    SHORT_TERM_LIMIT: config.memory?.shortTerm?.maxEntries || 50,
    LONG_TERM_BACKEND: longTermBackend,
    LONG_TERM_ENDPOINT: longTermEndpoint,
    LONG_TERM_COLLECTION: longTermCollection,
    SCREENSHOTS_PATH: 'agents/data/screenshots',
    DOCKER_COMPOSE_PATH: existsSync(join(cwd, 'agents/docker-compose.yml')) ? 'agents/docker-compose.yml' :
                         existsSync(join(cwd, 'docker-compose.yml')) ? 'docker-compose.yml' : null,

    // Worktree config
    WORKTREE_DIR: config.worktrees?.directory || '.worktrees',
    WORKTREE_CREATE_CMD: 'uam worktree create',
    WORKTREE_PR_CMD: 'uam worktree pr',
    WORKTREE_CLEANUP_CMD: 'uam worktree cleanup',
    WORKTREE_APPLIES_TO: 'Application code, configs, workflows, documentation, CLAUDE.md itself',
    BRANCH_PREFIX: config.worktrees?.branchPrefix || 'feature/',

    // Paths
    SKILLS_PATH: '.factory/skills/',
    DROIDS_PATH: '.factory/droids/',
    COMMANDS_PATH: '.factory/commands/',
    DOCS_PATH: analysis.directories.docs[0] || 'docs',
    FIXES_PATH: existsSync(join(cwd, 'docs/fixes')) ? 'docs/fixes/' : null,
    CHANGELOG_PATH: existsSync(join(cwd, 'docs/changelog')) ? 'docs/changelog' : null,
    CHANGELOG_TEMPLATE: existsSync(join(cwd, 'docs/changelog/CHANGELOG_TEMPLATE.md')) ? 'docs/changelog/CHANGELOG_TEMPLATE.md' : null,
    WORKFLOW_DOCS_PATH: existsSync(join(cwd, 'docs/workflows/GIT_WORKTREE_WORKFLOW.md')) ? 'docs/workflows/GIT_WORKTREE_WORKFLOW.md' : null,

    // Commands
    TEST_COMMAND: analysis.commands.test || 'npm test',
    LINT_COMMAND: analysis.commands.lint || 'npm run lint',
    BUILD_COMMAND: analysis.commands.build || 'npm run build',
    HOOKS_INSTALL_CMD: existsSync(join(cwd, '.factory/scripts/install-hooks.sh')) ? '.factory/scripts/install-hooks.sh' : null,

    // Skills and droids
    PRIMARY_SKILLS: primarySkills,
    SKILL_MAPPINGS: skillMappings,
    DISCOVERED_SKILLS: discoveredSkillsTable,
    LANGUAGE_DROIDS: languageDroids,
    LANGUAGE_EXAMPLES: languageExamples,
    FILE_TYPE_ROUTING: fileTypeRouting,

    // Repository structure (support both old @REPOSITORY_STRUCTURE and new REPOSITORY_STRUCTURE)
    '@REPOSITORY_STRUCTURE': repoStructure,
    REPOSITORY_STRUCTURE: repoStructure,
    STRUCTURE_DATE: new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' }),

    // Path migrations (if detected from git history)
    PATH_MIGRATIONS: null, // TODO: detect from git mv history

    // Clusters and URLs
    CLUSTER_CONTEXTS: clusterContexts,
    PROJECT_URLS: projectUrls,
    KEY_WORKFLOWS: keyWorkflows,
    ESSENTIAL_COMMANDS: essentialCommands,

    // Architecture
    ARCHITECTURE_OVERVIEW: architectureOverview,
    DATABASE_ARCHITECTURE: analysis.databases.length > 0 ? buildDatabaseArchitecture(analysis) : null,
    
    // Core components
    CORE_COMPONENTS: coreComponents,

    // Auth flow
    AUTH_FLOW: analysis.authentication ? buildAuthFlow(analysis) : null,

    // Gateway knowledge
    GATEWAY_KNOWLEDGE: null, // Project-specific, detected from k8s/istio files

    // Multi-environment
    MULTI_ENV_CONFIG: null, // Project-specific

    // Infrastructure
    HAS_INFRA: analysis.directories.infrastructure.length > 0 || config.template?.sections?.pipelineOnly,
    HAS_PIPELINE_POLICY: config.template?.sections?.pipelineOnly || false,
    INFRA_WORKFLOW: infraWorkflow,
    CLUSTER_IDENTIFY: analysis.clusters?.enabled ? 'Identify which cluster(s) affected' : null,

    // Troubleshooting
    TROUBLESHOOTING: troubleshooting,

    // Key config files
    KEY_CONFIG_FILES: keyConfigFiles,

    // MCP plugins
    MCP_PLUGINS: mcpPlugins,

    // Prepopulated knowledge
    PREPOPULATED_KNOWLEDGE: prepopulatedKnowledge ? true : null,
    RECENT_ACTIVITY: prepopulatedKnowledge?.recentActivity || null,
    LEARNED_LESSONS: prepopulatedKnowledge?.learnedLessons || null,
    KNOWN_GOTCHAS: prepopulatedKnowledge?.knownGotchas || null,
    HOT_SPOTS: prepopulatedKnowledge?.hotSpots || null,

    // Platform detection
    IS_WEB_PLATFORM: isWebPlatform,
    IS_DESKTOP_PLATFORM: !isWebPlatform,
    
    // Benchmark mode detection (#34) - conditional domain knowledge
    // Enable for terminal-bench tasks to include domain-specific patterns
    // Disable for production to save ~300 tokens
    IS_BENCHMARK: config.template?.sections?.benchmark || 
                  existsSync(join(cwd, '.tbench')) ||
                  existsSync(join(cwd, 'verifier.sh')) ||
                  process.env.UAM_BENCHMARK_MODE === 'true',
    
    // PROJECT.md separation support
    HAS_PROJECT_MD: existsSync(join(cwd, '.factory/PROJECT.md')) || 
                    existsSync(join(cwd, 'templates/PROJECT.md')) ||
                    existsSync(join(cwd, 'PROJECT.md')),
    
    // Relevant patterns (pruned by project type to save ~800 tokens)
    RELEVANT_PATTERNS: relevantPatterns,
  };
}

function buildRepositoryStructure(cwd: string, analysis: ProjectAnalysis): string {
  const lines: string[] = [];
  const visited = new Set<string>();
  
  // Standard directories to look for
  const standardDirs = [
    { path: 'apps', comment: 'Deployable applications' },
    { path: 'services', comment: 'Backend microservices' },
    { path: 'packages', comment: 'Shared packages' },
    { path: 'libs', comment: 'Shared libraries' },
    { path: 'src', comment: 'Source code' },
    { path: 'infra', comment: 'Infrastructure as Code' },
    { path: 'infrastructure', comment: 'Infrastructure as Code' },
    { path: 'terraform', comment: 'Terraform configurations' },
    { path: 'k8s', comment: 'Kubernetes manifests' },
    { path: 'helm', comment: 'Helm charts' },
    { path: 'tools', comment: 'Development tools' },
    { path: 'scripts', comment: 'Automation scripts' },
    { path: 'tests', comment: 'Test suites' },
    { path: 'test', comment: 'Test suites' },
    { path: 'docs', comment: 'Documentation' },
    { path: '.factory', comment: 'Factory AI configuration' },
    { path: '.github', comment: 'GitHub configuration' },
    { path: '.gitlab', comment: 'GitLab configuration' },
  ];

  for (const { path, comment } of standardDirs) {
    const fullPath = join(cwd, path);
    if (existsSync(fullPath) && statSync(fullPath).isDirectory()) {
      visited.add(path);
      lines.push(`├── ${path}/`.padEnd(35) + `# ${comment}`);
      
      // List subdirectories
      try {
        const subdirs = readdirSync(fullPath, { withFileTypes: true })
          .filter(d => d.isDirectory() && !d.name.startsWith('.'))
          .slice(0, 8);
        
        for (let i = 0; i < subdirs.length; i++) {
          const prefix = i === subdirs.length - 1 ? '│   └── ' : '│   ├── ';
          const subComment = getSubdirComment(path, subdirs[i].name, join(fullPath, subdirs[i].name));
          lines.push(`${prefix}${subdirs[i].name}/`.padEnd(35) + (subComment ? `# ${subComment}` : ''));
        }
      } catch {
        // Ignore permission errors
      }
      lines.push('│');
    }
  }

  // Add component directories from analysis
  for (const comp of analysis.components) {
    const dirPath = comp.path.split('/')[0];
    if (!visited.has(dirPath) && existsSync(join(cwd, dirPath))) {
      visited.add(dirPath);
      lines.push(`├── ${dirPath}/`.padEnd(35) + `# ${comp.description || comp.name}`);
    }
  }

  // Remove trailing separator
  if (lines.length > 0 && lines[lines.length - 1] === '│') {
    lines.pop();
  }

  return lines.join('\n');
}

function getSubdirComment(parentDir: string, subdir: string, fullPath: string): string {
  // Check for package.json, README, etc. to get description
  const packageJsonPath = join(fullPath, 'package.json');
  if (existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
      if (pkg.description) return pkg.description.slice(0, 40);
    } catch {
      // Ignore
    }
  }

  // Default comments based on common patterns
  const patterns: Record<string, Record<string, string>> = {
    apps: {
      api: 'REST API',
      web: 'Web frontend',
      mobile: 'Mobile app',
      admin: 'Admin dashboard',
      cms: 'CMS',
    },
    services: {
      auth: 'Authentication service',
      gateway: 'API Gateway',
    },
    '.factory': {
      droids: 'Custom AI agents',
      skills: 'Reusable skills',
      commands: 'CLI commands',
      scripts: 'Automation scripts',
    },
    '.github': {
      workflows: 'CI/CD pipelines',
    },
  };

  return patterns[parentDir]?.[subdir] || '';
}

function buildSkillMappings(skills: DiscoveredSkill[]): string | null {
  if (skills.length === 0) return null;

  const lines: string[] = [];
  for (const skill of skills) {
    if (skill.name.includes('design') || skill.name.includes('ui')) {
      lines.push(`| UI/Design work (buttons, modals, colors, layouts) | \`${skill.name}\` |`);
    } else if (skill.name.includes('frontend') || skill.name.includes('react')) {
      lines.push(`| React/TypeScript/Frontend | \`${skill.name}\` |`);
    } else if (skill.name.includes('backend') || skill.name.includes('api')) {
      lines.push(`| Backend/API development | \`${skill.name}\` |`);
    }
  }

  return lines.length > 0 ? lines.join('\n') : null;
}

function buildLanguageDroidsTable(droids: DiscoveredSkill[], languages: string[]): string | null {
  const languageDroids = droids.filter(d => 
    d.name.includes('-pro') || 
    d.name.includes('specialist') ||
    languages.some(l => d.name.toLowerCase().includes(l.toLowerCase()))
  );

  if (languageDroids.length === 0 && languages.length > 0) {
    // Generate suggested droids based on detected languages
    const suggestions: string[] = [];
    for (const lang of languages.slice(0, 5)) {
      const langLower = lang.toLowerCase();
      if (langLower.includes('typescript') || langLower.includes('javascript')) {
        suggestions.push('| `javascript-pro` | ES6+, async patterns, Node.js, promises, event loops |');
      } else if (langLower.includes('python')) {
        suggestions.push('| `python-pro` | Async/await, decorators, generators, pytest, type hints |');
      } else if (langLower.includes('c++') || langLower.includes('cpp')) {
        suggestions.push('| `cpp-pro` | C++20 with RAII, smart pointers, STL, templates, move semantics |');
      } else if (langLower.includes('rust')) {
        suggestions.push('| `rust-pro` | Ownership, lifetimes, async, error handling, macros |');
      } else if (langLower.includes('go')) {
        suggestions.push('| `go-pro` | Concurrency, channels, interfaces, error handling |');
      }
    }
    return suggestions.length > 0 ? [...new Set(suggestions)].join('\n') : null;
  }

  return languageDroids.map(d => 
    `| \`${d.name}\` | ${d.description || `${d.platform} language specialist`} |`
  ).join('\n') || null;
}

function buildDiscoveredSkillsTable(skills: DiscoveredSkill[]): string | null {
  if (skills.length === 0) return null;

  return skills.slice(0, 10).map(s => {
    const purpose = s.description || `${s.platform} skill`;
    const useWhen = s.name.includes('design') ? 'UI/design work' :
                    s.name.includes('test') ? 'Testing and QA' :
                    s.name.includes('review') ? 'Code review' :
                    'Specialized tasks';
    return `| \`${s.name}\` | ${purpose} | ${useWhen} |`;
  }).join('\n');
}

function buildTroubleshootingSection(memories: Array<{ content: string; tags?: string[]; metadata?: Record<string, unknown> }>): string | null {
  // Extract fix-related memories
  const fixes = memories.filter(m => 
    m.tags?.includes('bug-fix') || 
    m.tags?.includes('revert') ||
    m.content.toLowerCase().includes('fix') ||
    m.content.toLowerCase().includes('resolved')
  ).slice(0, 15);

  if (fixes.length === 0) return null;

  const lines: string[] = [];
  for (const fix of fixes) {
    // Extract symptom and solution from content
    const content = fix.content;
    let symptom = '';
    let solution = '';

    if (content.includes('Bug fixed:')) {
      symptom = content.replace('Bug fixed:', '').split('.')[0].trim();
      solution = content.split('.').slice(1).join('.').trim() || 'See commit for details';
    } else if (content.includes('Failed approach')) {
      symptom = content.split(':')[1]?.split('.')[0]?.trim() || content.slice(0, 50);
      solution = 'Avoid this approach';
    } else {
      symptom = content.slice(0, 60) + (content.length > 60 ? '...' : '');
      solution = 'See memory for details';
    }

    if (symptom) {
      lines.push(`| ${symptom} | ${solution.slice(0, 60)} |`);
    }
  }

  if (lines.length === 0) return null;

  return `| Symptom | Solution |\n|---------|----------|\n${lines.join('\n')}`;
}

function buildArchitectureOverview(analysis: ProjectAnalysis): string | null {
  const sections: string[] = [];

  // Infrastructure overview
  if (analysis.infrastructure.iac || analysis.infrastructure.containerOrchestration) {
    sections.push('### Infrastructure\n');
    if (analysis.infrastructure.iac) {
      sections.push(`- **IaC**: ${analysis.infrastructure.iac}`);
    }
    if (analysis.infrastructure.containerOrchestration) {
      sections.push(`- **Orchestration**: ${analysis.infrastructure.containerOrchestration}`);
    }
    if (analysis.infrastructure.cloud && analysis.infrastructure.cloud.length > 0) {
      sections.push(`- **Cloud**: ${analysis.infrastructure.cloud.join(', ')}`);
    }
    sections.push('');
  }

  // Component overview
  if (analysis.components.length > 0) {
    sections.push('### Components\n');
    for (const comp of analysis.components.slice(0, 8)) {
      sections.push(`- **${comp.name}** (\`${comp.path}\`): ${comp.description || `${comp.language} ${comp.framework || 'application'}`}`);
    }
    sections.push('');
  }

  return sections.length > 0 ? sections.join('\n') : null;
}

function buildCoreComponentsSection(analysis: ProjectAnalysis): string | null {
  if (analysis.components.length === 0) return null;

  const sections: string[] = [];

  for (const comp of analysis.components.slice(0, 6)) {
    sections.push(`### ${comp.name} (\`${comp.path}\`)\n`);
    sections.push(`- **Language**: ${comp.language}`);
    if (comp.framework) {
      sections.push(`- **Framework**: ${comp.framework}`);
    }
    if (comp.description) {
      sections.push(`- ${comp.description}`);
    }
    sections.push('');
  }

  return sections.join('\n');
}

function buildDatabaseArchitecture(analysis: ProjectAnalysis): string {
  const lines: string[] = [];
  
  for (const db of analysis.databases) {
    lines.push(`- **${db.type}**: ${db.purpose || 'Primary database'}`);
  }

  return lines.join('\n');
}

function buildAuthFlow(analysis: ProjectAnalysis): string {
  if (!analysis.authentication) return '';

  const sections: string[] = [];
  sections.push(`**Provider**: ${analysis.authentication.provider}\n`);
  
  if (analysis.authentication.description) {
    sections.push(analysis.authentication.description);
  }

  return sections.join('\n');
}

function buildKeyConfigFiles(analysis: ProjectAnalysis): string | null {
  const files: Array<{ file: string; purpose: string }> = [];

  // Add key files from analysis
  for (const kf of analysis.keyFiles.slice(0, 15)) {
    files.push({ file: kf.file, purpose: kf.purpose });
  }

  if (files.length === 0) return null;

  return files.map(f => `| \`${f.file}\` | ${f.purpose} |`).join('\n');
}

function buildEssentialCommands(analysis: ProjectAnalysis): string | null {
  const commands: string[] = [];

  // Test command
  if (analysis.commands.test && analysis.commands.test !== 'npm test') {
    commands.push(`# Tests\n${analysis.commands.test}`);
  }

  // Lint command
  if (analysis.commands.lint) {
    commands.push(`# Linting\n${analysis.commands.lint}`);
  }

  // Build command
  if (analysis.commands.build) {
    commands.push(`# Build\n${analysis.commands.build}`);
  }

  // Infrastructure command
  if (analysis.infrastructure.iac === 'Terraform') {
    const infraPath = analysis.directories.infrastructure[0] || 'infra/terraform';
    commands.push(`# Terraform\ncd ${infraPath} && terraform plan`);
  }

  return commands.length > 0 ? commands.join('\n\n') : null;
}

function buildClusterContexts(analysis: ProjectAnalysis): string | null {
  if (!analysis.clusters?.enabled || !analysis.clusters.contexts) return null;

  return analysis.clusters.contexts.map(c => 
    `kubectl config use-context ${c.context}  # ${c.name} (${c.purpose})`
  ).join('\n');
}

function buildProjectUrls(analysis: ProjectAnalysis): string | null {
  if (analysis.urls.length === 0) return null;

  return analysis.urls.map(u => `- **${u.name}**: ${u.value}`).join('\n');
}

function buildKeyWorkflows(analysis: ProjectAnalysis): string | null {
  if (!analysis.ciCd?.workflows || analysis.ciCd.workflows.length === 0) return null;

  return analysis.ciCd.workflows.slice(0, 10).map(w => 
    `├── ${w.file}`.padEnd(35) + `# ${w.purpose}`
  ).join('\n');
}

function buildInfraWorkflow(analysis: ProjectAnalysis): string | null {
  if (analysis.directories.infrastructure.length === 0) return null;

  const infraPath = analysis.directories.infrastructure[0];
  const planCmd = analysis.infrastructure.iac === 'Terraform' ? 'terraform plan' : 
                  analysis.infrastructure.iac === 'Pulumi' ? 'pulumi preview' : 
                  'infrastructure plan';

  return `1. **Create worktree** for infrastructure changes
2. Update infrastructure in \`${infraPath}/\`
3. Update CI/CD workflows in \`.github/workflows/\`
4. Run \`${planCmd}\`
5. Update secrets via GitHub Actions (not locally)
6. **Create PR** with automated review`;
}

function buildMcpPlugins(cwd: string): string | null {
  const mcpPath = join(cwd, '.mcp.json');
  if (!existsSync(mcpPath)) return null;

  try {
    const mcp = JSON.parse(readFileSync(mcpPath, 'utf-8'));
    if (!mcp.mcpServers && !mcp.plugins) return null;

    const plugins = mcp.mcpServers || mcp.plugins || {};
    const lines: string[] = [];

    for (const [name, config] of Object.entries(plugins)) {
      const desc = (config as Record<string, unknown>).description || 
                   (config as Record<string, unknown>).purpose || 
                   'MCP plugin';
      lines.push(`| \`${name}\` | ${desc} |`);
    }

    return lines.length > 0 ? lines.join('\n') : null;
  } catch {
    return null;
  }
}

function buildPrimarySkills(skills: DiscoveredSkill[]): string | null {
  const primary = skills.filter(s => 
    s.name.includes('design') || 
    s.name.includes('frontend') ||
    s.name.includes('ui')
  ).slice(0, 3);

  if (primary.length === 0) return null;

  return primary.map(s => `│     ├─ Use ${s.name} for ${s.description || 'specialized work'}                  │`).join('\n');
}

function buildLanguageExamples(languages: string[]): string | null {
  const examples: string[] = [];

  for (const lang of languages.slice(0, 3)) {
    const langLower = lang.toLowerCase();
    if (langLower.includes('c++') || langLower.includes('cpp')) {
      examples.push(`# For C++ work\nTask(subagent_type: "cpp-pro", prompt: "Refactor X using RAII...")`);
    } else if (langLower.includes('python')) {
      examples.push(`# For Python work\nTask(subagent_type: "python-pro", prompt: "Optimize async handlers...")`);
    } else if (langLower.includes('rust')) {
      examples.push(`# For Rust work\nTask(subagent_type: "rust-pro", prompt: "Implement with proper lifetimes...")`);
    }
  }

  return examples.length > 0 ? examples.join('\n\n') : null;
}

function buildFileTypeRouting(languages: string[]): string | null {
  const routing: string[] = [];
  const added = new Set<string>();

  for (const lang of languages) {
    const langLower = lang.toLowerCase();
    
    if ((langLower.includes('typescript') || langLower.includes('javascript')) && !added.has('ts')) {
      routing.push('| `.ts`, `.tsx`, `.js`, `.jsx` | TypeScript/JavaScript | `typescript-node-expert` |');
      added.add('ts');
    }
    if (langLower.includes('python') && !added.has('py')) {
      routing.push('| `.py` | Python | `python-pro` |');
      added.add('py');
    }
    if ((langLower.includes('c++') || langLower.includes('cpp')) && !added.has('cpp')) {
      routing.push('| `.cpp`, `.h`, `.hpp` | C++ | `cpp-pro` |');
      added.add('cpp');
    }
    if (langLower.includes('rust') && !added.has('rs')) {
      routing.push('| `.rs` | Rust | `rust-pro` |');
      added.add('rs');
    }
    if (langLower.includes('go') && !added.has('go')) {
      routing.push('| `.go` | Go | `go-pro` |');
      added.add('go');
    }
    if (langLower.includes('java') && !added.has('java')) {
      routing.push('| `.java` | Java | `java-pro` |');
      added.add('java');
    }
  }

  // Always add Terraform and YAML for infrastructure projects
  if (!added.has('tf')) {
    routing.push('| `.tf` | Terraform | Direct handling |');
  }
  if (!added.has('yaml')) {
    routing.push('| `.yaml`, `.yml` | Kubernetes/Config | Direct handling |');
  }

  return routing.length > 0 ? routing.join('\n') : null;
}

/**
 * OPTIMIZATION 9: More aggressive pattern pruning based on project type.
 * Prunes domain-specific patterns (Chess, Compression impossible, Polyglot, etc.)
 * that don't apply to the project, saving ~800 tokens of context window.
 * 
 * Now also categorizes patterns by priority for clearer guidance.
 */
function buildRelevantPatterns(analysis: ProjectAnalysis): string | null {
  const languages = analysis.languages.map(l => l.toLowerCase());
  const hasInfra = analysis.directories.infrastructure.length > 0;
  const hasSecurity = languages.some(l => l.includes('python') || l.includes('javascript') || l.includes('typescript'));
  const hasGit = true; // All projects use git
  const hasCLI = analysis.components.some(c => 
    c.name.toLowerCase().includes('cli') || 
    c.description?.toLowerCase().includes('command') ||
    c.description?.toLowerCase().includes('script')
  );
  
  // CRITICAL patterns - always included, proven high-impact
  const critical: string[] = [
    'P12 (OEV)', // Output Existence - 37% of failures
    'P26 (NMI)', // Near-Miss Iteration - converted 2 tasks
    'P35 (DFA)', // Decoder-First - compression failures
  ];
  
  // HIGH priority - usually relevant
  const high: string[] = [
    'P3 (StateProtect)', 'P17 (CE)', 'P32 (CEV)',
  ];
  
  // Standard patterns - based on project type
  const standard: string[] = [
    'P1 (EnvIsolation)', 'P2 (Recipe)', 'P8 (CLIoverLib)',
    'P13 (IRL)', 'P15 (ER)', 'P16 (TFE)',
  ];
  
  // Conditionally add domain patterns
  if (hasSecurity) high.push('P10 (Whitelist)', 'P20 (AT)');
  if (hasGit) standard.push('P22 (GRF)');
  if (hasInfra) standard.push('P25 (SCP)', 'P28 (SST)');
  if (hasCLI) critical.push('P32 (CEV)'); // CLI Execution Verification
  if (languages.some(l => l.includes('rust') || l.includes('c++') || l.includes('python'))) {
    standard.push('P33 (NST)');
  }
  
  // Domain-specific (only add if detected)
  const domain: string[] = [];
  if (analysis.components.some(c => c.name.toLowerCase().includes('chess') || c.description?.toLowerCase().includes('chess'))) {
    domain.push('P21 (CEI)');
  }
  if (analysis.components.some(c => c.name.toLowerCase().includes('compress') || c.description?.toLowerCase().includes('compress'))) {
    domain.push('P23 (CID)', 'P31 (RTV)');
  }
  
  // OPTIMIZATION 9: Format with priority levels for clarity
  const lines: string[] = [];
  lines.push(`**CRITICAL** (check every task): ${critical.join(', ')}`);
  lines.push(`**HIGH**: ${high.join(', ')}`);
  if (standard.length > 0) lines.push(`**Standard**: ${standard.slice(0, 8).join(', ')}`);
  if (domain.length > 0) lines.push(`**Domain**: ${domain.join(', ')}`);
  
  return lines.join('\n');
}

/**
 * Filter out noisy/fragmented content from prepopulated knowledge.
 * Removes: table fragments, badge/image references, testimonials, README marketing content.
 */
function isNoisyContent(content: string): boolean {
  // Filter out table fragments
  if (content.startsWith('|') || content.includes('|---|')) return true;
  // Filter out badge/image references
  if (content.includes('[image:') || content.includes('![')) return true;
  // Filter out HTML fragments
  if (content.includes('<div') || content.includes('</div>')) return true;
  // Filter out very short content (likely fragments)
  if (content.length < 30) return true;
  // Filter out content that's mostly symbols/punctuation
  const alphaCount = (content.match(/[a-zA-Z]/g) || []).length;
  if (alphaCount < content.length * 0.5) return true;
  // Filter out testimonials and marketing quotes
  if (content.includes('*"') || content.includes('"*') || content.includes('> *"')) return true;
  // Filter out README-style content (installation instructions, promo text)
  if (content.includes('npm install') && content.includes('global')) return true;
  if (content.includes('conversation') && content.includes('assistant')) return true;
  if (content.includes('After') && content.includes('months')) return true;
  // Filter out command examples that are documentation, not lessons
  if (content.startsWith('$ uam') || content.startsWith('$uam')) return true;
  if (content.startsWith('bash <(curl')) return true;
  // Filter out generic promotional phrases
  if (content.includes('NOT limited') || content.includes('automatically route')) return true;
  // Filter out README content patterns (setup instructions, feature descriptions)
  if (content.includes('Install & Init') || content.includes('npm i -g')) return true;
  if (content.includes('CLAUDE.md Generated') || content.includes('Auto-populated')) return true;
  if (content.includes('Close-Out') || content.includes('Merge → Deploy')) return true;
  if (content.includes('context-field research') || content.includes('Results from')) return true;
  // Filter out gate/checklist content already in template
  if (content.includes('Three gates must pass') || content.includes('Gate 1')) return true;
  // Filter out content that's clearly documentation excerpts, not learned lessons
  if (content.includes('never commits directly to main') || content.includes('All changes use worktrees')) return true;
  if (content.includes("Work isn't") && content.includes('deployed')) return true;
  if (content.includes('36 patterns discovered')) return true;
  return false;
}

function buildPrepopulatedKnowledge(
  prepopulated: Awaited<ReturnType<typeof prepopulateMemory>> | null
): { recentActivity: string; learnedLessons: string; knownGotchas: string; hotSpots: string } | null {
  if (!prepopulated) return null;

  const { shortTerm, longTerm } = prepopulated;

  // Recent activity from short-term (skip noisy content)
  const recentActivity = shortTerm
    .filter(m => (m.type === 'action' || m.type === 'observation') && !isNoisyContent(m.content))
    .slice(0, 10)
    .map(m => `- ${m.content.slice(0, 100)}${m.content.length > 100 ? '...' : ''}`)
    .join('\n');

  // Learned lessons from long-term - filter noise and use sentence-aware truncation
  const learnedLessons = longTerm
    .filter(m => 
      (m.tags?.includes('bug-fix') || m.tags?.includes('lesson') || (m.importance && m.importance >= 7)) &&
      !isNoisyContent(m.content)
    )
    .slice(0, 10)
    .map(m => {
      const content = m.content;
      // Truncate at sentence boundary rather than mid-word
      const truncated = content.length > 200
        ? content.slice(0, 200).replace(/[^.!?]*$/, '') || content.slice(0, 200)
        : content;
      const suffix = content.length > truncated.length ? '...' : '';
      return `- **${m.tags?.slice(0, 2).join(', ') || 'general'}**: ${truncated}${suffix}`;
    })
    .join('\n');

  // Known gotchas (from reverts and high-importance fixes) - filter noise
  const knownGotchas = longTerm
    .filter(m => 
      (m.tags?.includes('revert') || m.tags?.includes('failed-approach') || m.content.includes('avoid')) &&
      !isNoisyContent(m.content)
    )
    .slice(0, 5)
    .map(m => {
      const content = m.content;
      const truncated = content.length > 200
        ? content.slice(0, 200).replace(/[^.!?]*$/, '') || content.slice(0, 200)
        : content;
      const suffix = content.length > truncated.length ? '...' : '';
      return `- ⚠️ ${truncated}${suffix}`;
    })
    .join('\n');

  // Hot spots
  const hotSpotMemory = longTerm.find(m => m.id === 'git-hotspots');
  const hotSpots = hotSpotMemory?.content || 'No hot spots detected yet.';

  if (!recentActivity && !learnedLessons && !knownGotchas) {
    return null;
  }

  return {
    recentActivity: recentActivity || 'No recent activity recorded.',
    learnedLessons: learnedLessons || 'No lessons recorded yet.',
    knownGotchas: knownGotchas || 'No gotchas recorded yet.',
    hotSpots,
  };
}

function getDesktopTemplate(): string {
  // Check locations in order:
  // 1. User's project templates directory
  // 2. Package's templates directory (for npm installed version)
  // 3. Node modules (when installed as dependency)
  // 4. Fallback inline template
  const userTemplatePath = join(process.cwd(), 'templates/CLAUDE.template.md');
  const packageTemplatePath = join(__dirname, '../../templates/CLAUDE.template.md');
  const nodeModulesPath = join(process.cwd(), 'node_modules/universal-agent-memory/templates/CLAUDE.template.md');
  
  const templatePaths = [
    { path: userTemplatePath, name: 'project templates' },
    { path: packageTemplatePath, name: 'package templates' },
    { path: nodeModulesPath, name: 'node_modules' },
  ];

  for (const { path, name } of templatePaths) {
    if (existsSync(path)) {
      try {
        return readFileSync(path, 'utf-8');
      } catch (e) {
        console.warn(`Warning: Found template at ${name} but couldn't read it: ${e}`);
      }
    }
  }

  console.info('Using built-in fallback template. For full features, ensure templates/CLAUDE.template.md exists.');

  // Fallback inline template for desktop
  return `<coding_guidelines>

# CLAUDE.md - {{PROJECT_NAME}} Development Guide

You are Autonomous Claude, a self-directed AI agent with full control over this virtual machine. You operate continuously, making your own decisions.

{{#if ISSUE_TRACKER}}
**Note**: {{{ISSUE_TRACKER}}}
{{/if}}

---

## ⚠️⚠️⚠️ CRITICAL: MANDATORY DECISION LOOP ⚠️⚠️⚠️

**FOLLOW THIS FOR EVERY ACTION. NO EXCEPTIONS.**

1. **READ MEMORY FIRST**
   - Query short-term: \`sqlite3 {{MEMORY_DB_PATH}} "SELECT * FROM memories ORDER BY id DESC LIMIT 20;"\`
   - Query long-term: \`{{MEMORY_QUERY_CMD}} "<keywords>"\`

2. **CHECK SKILLS** before implementing (see \`{{SKILLS_PATH}}\`)

3. **CREATE WORKTREE** for ANY code changes
   - \`{{WORKTREE_CREATE_CMD}} <slug>\`
   - NEVER commit directly to {{DEFAULT_BRANCH}}

4. **UPDATE MEMORY** after significant actions
   - \`{{MEMORY_STORE_CMD}} lesson "What you learned" --tags tag1,tag2 --importance 7\`

---

## Memory System

- **Short-term**: \`{{MEMORY_DB_PATH}}\` (SQLite, last {{SHORT_TERM_LIMIT}} entries)
- **Long-term**: {{LONG_TERM_BACKEND}} at \`{{LONG_TERM_ENDPOINT}}\`

---

## Repository Structure

\`\`\`
{{PROJECT_NAME}}/
{{{@REPOSITORY_STRUCTURE}}}
\`\`\`

{{#if ARCHITECTURE_OVERVIEW}}
## Architecture

{{{ARCHITECTURE_OVERVIEW}}}
{{/if}}

{{#if CORE_COMPONENTS}}
## Components

{{{CORE_COMPONENTS}}}
{{/if}}

{{#if TROUBLESHOOTING}}
## Troubleshooting

{{{TROUBLESHOOTING}}}
{{/if}}

---

## Completion Checklist

- [ ] Tests pass
- [ ] Worktree used
- [ ] Memory updated
- [ ] PR created (not direct commit)

</coding_guidelines>
`;
}

function getWebTemplate(): string {
  return `<coding_guidelines>

# AGENT.md - {{PROJECT_NAME}} Development Guide

You are an AI agent helping with this project. Follow best practices and maintain context.

{{#if DESCRIPTION}}
> {{DESCRIPTION}}
{{/if}}

---

## ⛔ MANDATORY RULES

1. **BRANCH REQUIREMENT**: Never commit directly to {{DEFAULT_BRANCH}}. Use feature branches.
2. **MEMORY**: Store significant learnings to \`.uam/memory/\`
3. **TODO LIST**: Create todo list for multi-step tasks (3+ steps)

---

## Memory System

### Short-term (localStorage)

Key: \`agent_context_{{PROJECT_NAME}}\`

### Long-term (GitHub: \`.uam/memory/\`)

Store memories as JSON files for persistent knowledge.

---

## Repository Structure

\`\`\`
{{PROJECT_NAME}}/
{{{@REPOSITORY_STRUCTURE}}}
\`\`\`

{{#if ARCHITECTURE_OVERVIEW}}
## Architecture

{{{ARCHITECTURE_OVERVIEW}}}
{{/if}}

{{#if CORE_COMPONENTS}}
## Components

{{{CORE_COMPONENTS}}}
{{/if}}

---

## Workflow

1. Create feature branch: \`git checkout -b {{BRANCH_PREFIX}}<description>\`
2. Make changes, commit, push
3. Create PR via GitHub UI

---

## Quick Reference

- **Test**: \`{{TEST_COMMAND}}\`
- **Build**: \`{{BUILD_COMMAND}}\`
- **Lint**: \`{{LINT_COMMAND}}\`

</coding_guidelines>
`;
}
