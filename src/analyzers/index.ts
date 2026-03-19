import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, basename } from 'path';
import { execSync } from 'child_process';
import type { ProjectAnalysis } from '../types/index.js';

export async function analyzeProject(cwd: string): Promise<ProjectAnalysis> {
  // Prefer project name from existing .uap.json config, then git remote, then directory name
  let initialName = basename(cwd);
  const uapConfigPath = join(cwd, '.uap.json');
  if (existsSync(uapConfigPath)) {
    try {
      const uapConfig = JSON.parse(readFileSync(uapConfigPath, 'utf-8'));
      if (uapConfig.project?.name) {
        initialName = uapConfig.project.name;
      }
    } catch {
      /* ignore parse errors */
    }
  }

  const analysis: ProjectAnalysis = {
    projectName: initialName,
    description: '',
    defaultBranch: 'main',
    languages: [],
    frameworks: [],
    packageManagers: [],
    directories: {
      source: [],
      tests: [],
      infrastructure: [],
      docs: [],
      workflows: [],
    },
    urls: [],
    components: [],
    commands: {},
    databases: [],
    infrastructure: {
      cloud: [],
    },
    existingDroids: [],
    existingSkills: [],
    existingCommands: [],
    troubleshootingHints: [],
    keyFiles: [],
    securityNotes: [],
  };

  // Detect git info
  try {
    analysis.defaultBranch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      encoding: 'utf-8',
    }).trim();

    // Use git remote origin as a better project name fallback than directory name
    if (analysis.projectName === basename(cwd)) {
      try {
        const remoteUrl = execSync('git remote get-url origin', { cwd, encoding: 'utf-8' }).trim();
        // Extract repo name from URL: git@github.com:user/repo.git or https://github.com/user/repo.git
        const repoMatch = remoteUrl.match(/\/([^/]+?)(?:\.git)?$/);
        if (repoMatch) {
          analysis.projectName = repoMatch[1];
        }
      } catch {
        /* no remote configured */
      }
    }
  } catch {
    // Not a git repo or git not available
  }

  // Analyze package files first (sets project name, languages, frameworks)
  await analyzePackageFiles(cwd, analysis);

  // Run independent detection passes in parallel for faster analysis
  // Each function mutates `analysis` but operates on non-overlapping fields
  await Promise.all([
    Promise.resolve(analyzeDirectoryStructure(cwd, analysis)),
    Promise.resolve(analyzeCiCd(cwd, analysis)),
    Promise.resolve(analyzeExistingAgents(cwd, analysis)),
    Promise.resolve(analyzeReadme(cwd, analysis)),
    Promise.resolve(detectDatabases(cwd, analysis)),
    Promise.resolve(detectInfrastructure(cwd, analysis)),
    Promise.resolve(detectMcpPlugins(cwd, analysis)),
    Promise.resolve(detectKeyConfigFiles(cwd, analysis)),
    Promise.resolve(detectAuthentication(cwd, analysis)),
    Promise.resolve(detectClusters(cwd, analysis)),
    Promise.resolve(detectComponents(cwd, analysis)),
  ]);

  // File type routing depends on languages being fully detected
  detectFileTypeRouting(analysis);

  return analysis;
}

async function analyzePackageFiles(cwd: string, analysis: ProjectAnalysis): Promise<void> {
  // package.json (Node.js)
  const packageJsonPath = join(cwd, 'package.json');
  if (existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
      analysis.projectName = pkg.name || analysis.projectName;
      analysis.description = pkg.description || '';
      analysis.packageManagers.push('npm');
      analysis.languages.push('JavaScript');

      // Detect TypeScript
      if (pkg.devDependencies?.typescript || existsSync(join(cwd, 'tsconfig.json'))) {
        analysis.languages.push('TypeScript');
      }

      // Detect frameworks
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.react) analysis.frameworks.push('React');
      if (deps.next) analysis.frameworks.push('Next.js');
      if (deps.vue) analysis.frameworks.push('Vue');
      if (deps.express) analysis.frameworks.push('Express');
      if (deps.fastify) analysis.frameworks.push('Fastify');
      if (deps.nest) analysis.frameworks.push('NestJS');

      // Extract commands
      if (pkg.scripts) {
        if (pkg.scripts.test) analysis.commands.test = `npm test`;
        if (pkg.scripts.lint) analysis.commands.lint = `npm run lint`;
        if (pkg.scripts.build) analysis.commands.build = `npm run build`;
        if (pkg.scripts.dev) analysis.commands.dev = `npm run dev`;
      }
    } catch {
      // Invalid package.json
    }
  }

  // pyproject.toml (Python)
  const pyprojectPath = join(cwd, 'pyproject.toml');
  if (existsSync(pyprojectPath)) {
    analysis.languages.push('Python');
    analysis.packageManagers.push('pip');

    const content = readFileSync(pyprojectPath, 'utf-8');
    if (content.includes('fastapi')) analysis.frameworks.push('FastAPI');
    if (content.includes('django')) analysis.frameworks.push('Django');
    if (content.includes('flask')) analysis.frameworks.push('Flask');

    analysis.commands.test = analysis.commands.test || 'pytest';
  }

  // requirements.txt
  if (existsSync(join(cwd, 'requirements.txt'))) {
    if (!analysis.languages.includes('Python')) {
      analysis.languages.push('Python');
    }
    if (!analysis.packageManagers.includes('pip')) {
      analysis.packageManagers.push('pip');
    }
  }

  // Cargo.toml (Rust)
  if (existsSync(join(cwd, 'Cargo.toml'))) {
    analysis.languages.push('Rust');
    analysis.packageManagers.push('cargo');
  }

  // go.mod (Go)
  if (existsSync(join(cwd, 'go.mod'))) {
    analysis.languages.push('Go');
    analysis.packageManagers.push('go mod');
  }

  // CMakeLists.txt (C/C++)
  if (existsSync(join(cwd, 'CMakeLists.txt'))) {
    analysis.languages.push('C++');
    analysis.packageManagers.push('cmake');
  }

  // pom.xml (Java/Maven)
  if (existsSync(join(cwd, 'pom.xml'))) {
    analysis.languages.push('Java');
    analysis.packageManagers.push('maven');
  }
}

function analyzeDirectoryStructure(cwd: string, analysis: ProjectAnalysis): void {
  const sourceDirs = ['src', 'lib', 'app', 'packages', 'platform', 'services'];
  const testDirs = ['tests', 'test', '__tests__', 'spec'];
  const infraDirs = ['infra', 'terraform', 'infrastructure', 'deploy', 'k8s', 'kubernetes'];
  const docDirs = ['docs', 'documentation', 'doc'];

  for (const dir of sourceDirs) {
    if (existsSync(join(cwd, dir))) {
      analysis.directories.source.push(dir);
    }
  }

  for (const dir of testDirs) {
    if (existsSync(join(cwd, dir))) {
      analysis.directories.tests.push(dir);
    }
  }

  for (const dir of infraDirs) {
    if (existsSync(join(cwd, dir))) {
      analysis.directories.infrastructure.push(dir);
    }
  }

  for (const dir of docDirs) {
    if (existsSync(join(cwd, dir))) {
      analysis.directories.docs.push(dir);
    }
  }

  // Check for UI directories
  if (existsSync(join(cwd, 'ui'))) {
    const uiPath = join(cwd, 'ui');
    try {
      const subdirs = readdirSync(uiPath).filter((f: string) =>
        statSync(join(uiPath, f)).isDirectory()
      );
      for (const subdir of subdirs) {
        analysis.components.push({
          name: `UI - ${subdir}`,
          path: `ui/${subdir}`,
          language: 'JavaScript',
          description: `Frontend component: ${subdir}`,
        });
      }
    } catch {
      // Can't read ui directory
    }
  }
}

function analyzeCiCd(cwd: string, analysis: ProjectAnalysis): void {
  // GitHub Actions
  const ghWorkflowsPath = join(cwd, '.github/workflows');
  if (existsSync(ghWorkflowsPath)) {
    analysis.directories.workflows.push('.github/workflows');

    try {
      const workflows = readdirSync(ghWorkflowsPath).filter(
        (f: string) => f.endsWith('.yml') || f.endsWith('.yaml')
      );

      analysis.ciCd = {
        platform: 'GitHub Actions',
        workflows: workflows.map((f) => ({
          file: f,
          purpose: inferWorkflowPurpose(f),
        })),
      };
    } catch {
      // Can't read workflows
    }
  }

  // GitLab CI
  if (existsSync(join(cwd, '.gitlab-ci.yml'))) {
    analysis.ciCd = {
      platform: 'GitLab CI',
      workflows: [{ file: '.gitlab-ci.yml', purpose: 'CI/CD pipeline' }],
    };
  }
}

function inferWorkflowPurpose(filename: string): string {
  const name = filename.toLowerCase();
  if (name.includes('test')) return 'Testing';
  if (name.includes('lint')) return 'Linting';
  if (name.includes('build')) return 'Build';
  if (name.includes('deploy') || name.includes('cd')) return 'Deployment';
  if (name.includes('security')) return 'Security scanning';
  if (name.includes('release')) return 'Release automation';
  if (name.includes('ci')) return 'Continuous Integration';
  return 'Workflow';
}

function analyzeExistingAgents(cwd: string, analysis: ProjectAnalysis): void {
  // Factory droids
  const factoryDroidsPath = join(cwd, '.factory/droids');
  if (existsSync(factoryDroidsPath)) {
    try {
      const droids = readdirSync(factoryDroidsPath)
        .filter((f: string) => f.endsWith('.md'))
        .map((f: string) => basename(f, '.md'));
      analysis.existingDroids.push(...droids);
    } catch {
      // Can't read droids
    }
  }

  // Factory skills
  const factorySkillsPath = join(cwd, '.factory/skills');
  if (existsSync(factorySkillsPath)) {
    try {
      const skills = readdirSync(factorySkillsPath)
        .filter((f: string) => statSync(join(factorySkillsPath, f)).isDirectory())
        .map((f: string) => f);
      analysis.existingSkills.push(...skills);
    } catch {
      // Can't read skills
    }
  }

  // Factory commands
  const factoryCommandsPath = join(cwd, '.factory/commands');
  if (existsSync(factoryCommandsPath)) {
    try {
      const commands = readdirSync(factoryCommandsPath)
        .filter((f: string) => f.endsWith('.md'))
        .map((f: string) => basename(f, '.md'));
      analysis.existingCommands.push(...commands);
    } catch {
      // Can't read commands
    }
  }

  // Claude Code agents
  const claudeAgentsPath = join(cwd, '.claude/agents');
  if (existsSync(claudeAgentsPath)) {
    try {
      const agents = readdirSync(claudeAgentsPath)
        .filter((f: string) => f.endsWith('.md'))
        .map((f: string) => basename(f, '.md'));
      analysis.existingDroids.push(...agents);
    } catch {
      // Can't read agents
    }
  }
}

function analyzeReadme(cwd: string, analysis: ProjectAnalysis): void {
  const readmePaths = ['README.md', 'readme.md', 'Readme.md'];

  for (const readmePath of readmePaths) {
    const fullPath = join(cwd, readmePath);
    if (existsSync(fullPath)) {
      try {
        const content = readFileSync(fullPath, 'utf-8');

        // Extract first paragraph as description
        const firstParagraph = content.split('\n\n')[1]?.trim();
        if (firstParagraph && !analysis.description) {
          analysis.description = firstParagraph.substring(0, 200);
        }

        // Extract URLs
        const urlRegex = /https?:\/\/[^\s\)]+/g;
        const urls = content.match(urlRegex) || [];
        for (const url of urls.slice(0, 5)) {
          // Limit to first 5 URLs
          if (url.includes('github.com')) continue; // Skip GitHub links
          analysis.urls.push({
            name: 'URL',
            value: url,
          });
        }

        analysis.keyFiles.push({
          file: readmePath,
          purpose: 'Project documentation',
        });
      } catch {
        // Can't read README
      }
      break;
    }
  }
}

function detectDatabases(cwd: string, analysis: ProjectAnalysis): void {
  // Check for database-related files
  if (existsSync(join(cwd, 'docker-compose.yml'))) {
    try {
      const content = readFileSync(join(cwd, 'docker-compose.yml'), 'utf-8');
      if (content.includes('postgres')) {
        analysis.databases.push({ type: 'PostgreSQL', purpose: 'Database' });
      }
      if (content.includes('mysql')) {
        analysis.databases.push({ type: 'MySQL', purpose: 'Database' });
      }
      if (content.includes('mongo')) {
        analysis.databases.push({ type: 'MongoDB', purpose: 'Database' });
      }
      if (content.includes('redis')) {
        analysis.databases.push({ type: 'Redis', purpose: 'Cache' });
      }
      if (content.includes('qdrant')) {
        analysis.databases.push({ type: 'Qdrant', purpose: 'Vector database' });
      }
    } catch {
      // Can't read docker-compose
    }
  }

  // Check for SQLite
  if (existsSync(join(cwd, 'agents/data/memory/short_term.db'))) {
    analysis.databases.push({ type: 'SQLite', purpose: 'Agent memory' });
  }
}

function detectInfrastructure(cwd: string, analysis: ProjectAnalysis): void {
  // Terraform
  const terraformPath = join(cwd, 'infra/terraform');
  if (existsSync(terraformPath) || existsSync(join(cwd, 'terraform'))) {
    analysis.infrastructure.iac = 'Terraform';
  }

  // Kubernetes
  if (existsSync(join(cwd, 'k8s')) || existsSync(join(cwd, 'kubernetes'))) {
    analysis.infrastructure.containerOrchestration = 'Kubernetes';
  }

  // Docker
  if (existsSync(join(cwd, 'Dockerfile')) || existsSync(join(cwd, 'docker-compose.yml'))) {
    if (!analysis.infrastructure.containerOrchestration) {
      analysis.infrastructure.containerOrchestration = 'Docker';
    }
  }
}

function detectMcpPlugins(cwd: string, analysis: ProjectAnalysis): void {
  const mcpPath = join(cwd, '.mcp.json');
  if (!existsSync(mcpPath)) return;

  try {
    const mcp = JSON.parse(readFileSync(mcpPath, 'utf-8'));
    const plugins = mcp.mcpServers || mcp.plugins || {};

    analysis.mcpPlugins = [];
    for (const [name, config] of Object.entries(plugins)) {
      const cfg = config as Record<string, unknown>;
      analysis.mcpPlugins.push({
        name,
        purpose: (cfg.description as string) || (cfg.purpose as string) || 'MCP plugin',
      });
    }
  } catch {
    // Can't read or parse .mcp.json
  }
}

function detectKeyConfigFiles(cwd: string, analysis: ProjectAnalysis): void {
  // Common configuration files to detect
  const configFiles = [
    { file: '.uap.json', purpose: 'UAP agent memory configuration' },
    { file: 'package.json', purpose: 'Node.js project configuration' },
    { file: 'tsconfig.json', purpose: 'TypeScript configuration' },
    { file: '.mcp.json', purpose: 'MCP plugins configuration' },
    { file: 'docker-compose.yml', purpose: 'Docker Compose services' },
    { file: 'Dockerfile', purpose: 'Container build definition' },
    { file: '.env.example', purpose: 'Environment variable template' },
    { file: '.gitignore', purpose: 'Git ignore patterns' },
    { file: 'pyproject.toml', purpose: 'Python project configuration' },
    { file: 'Cargo.toml', purpose: 'Rust project configuration' },
    { file: 'go.mod', purpose: 'Go module definition' },
    { file: 'pom.xml', purpose: 'Maven project configuration' },
    { file: '.eslintrc.json', purpose: 'ESLint configuration' },
    { file: '.eslintrc.js', purpose: 'ESLint configuration' },
    { file: '.prettierrc', purpose: 'Prettier configuration' },
    { file: 'vitest.config.ts', purpose: 'Vitest test configuration' },
    { file: 'jest.config.js', purpose: 'Jest test configuration' },
    { file: 'vite.config.ts', purpose: 'Vite build configuration' },
    { file: 'webpack.config.js', purpose: 'Webpack build configuration' },
  ];

  for (const cfg of configFiles) {
    if (existsSync(join(cwd, cfg.file))) {
      // Check if not already added
      if (!analysis.keyFiles.some((kf) => kf.file === cfg.file)) {
        analysis.keyFiles.push(cfg);
      }
    }
  }

  // Detect infrastructure-specific config files
  if (analysis.infrastructure.iac === 'Terraform') {
    const terraformConfigs = [
      { file: 'main.tf', purpose: 'Terraform main configuration' },
      { file: 'variables.tf', purpose: 'Terraform variables' },
      { file: 'outputs.tf', purpose: 'Terraform outputs' },
      { file: 'production.tfvars', purpose: 'Production environment variables' },
    ];

    const infraPath = analysis.directories.infrastructure[0] || 'infra/terraform';
    for (const cfg of terraformConfigs) {
      const fullPath = join(cwd, infraPath, cfg.file);
      if (existsSync(fullPath)) {
        analysis.keyFiles.push({
          file: `${infraPath}/${cfg.file}`,
          purpose: cfg.purpose,
        });
      }
    }
  }
}

function detectAuthentication(cwd: string, analysis: ProjectAnalysis): void {
  // Check for common auth providers
  const authPatterns: Array<{ pattern: string; provider: string; description: string }> = [
    { pattern: 'zitadel', provider: 'Zitadel', description: 'OIDC/OAuth2 authentication' },
    { pattern: 'keycloak', provider: 'Keycloak', description: 'Identity and access management' },
    { pattern: 'auth0', provider: 'Auth0', description: 'Authentication platform' },
    {
      pattern: 'oauth2-proxy',
      provider: 'OAuth2 Proxy',
      description: 'OAuth2 authentication proxy',
    },
    { pattern: 'firebase-auth', provider: 'Firebase Auth', description: 'Firebase authentication' },
    { pattern: 'supabase', provider: 'Supabase', description: 'Supabase authentication' },
    { pattern: 'clerk', provider: 'Clerk', description: 'Clerk authentication' },
    {
      pattern: 'passport',
      provider: 'Passport.js',
      description: 'Node.js authentication middleware',
    },
  ];

  // Check in various config files
  const filesToCheck = ['docker-compose.yml', 'package.json', 'requirements.txt', '.env.example'];

  for (const file of filesToCheck) {
    const filePath = join(cwd, file);
    if (existsSync(filePath)) {
      try {
        const content = readFileSync(filePath, 'utf-8').toLowerCase();
        for (const auth of authPatterns) {
          if (content.includes(auth.pattern)) {
            analysis.authentication = {
              provider: auth.provider,
              description: auth.description,
            };
            return;
          }
        }
      } catch {
        // Ignore
      }
    }
  }

  // Check for Istio with OAuth2
  const k8sPath = join(cwd, 'infra/k8s');
  if (existsSync(k8sPath)) {
    try {
      const files = readdirSync(k8sPath, { recursive: true }) as string[];
      for (const file of files) {
        if (typeof file === 'string' && (file.includes('oauth') || file.includes('auth'))) {
          analysis.authentication = {
            provider: 'OAuth2',
            description: 'OAuth2 authentication via Kubernetes/Istio',
          };
          return;
        }
      }
    } catch {
      // Ignore
    }
  }
}

function detectClusters(cwd: string, analysis: ProjectAnalysis): void {
  // Check for kubeconfig references or cluster configs
  const k8sPath = join(cwd, 'infra/k8s');
  const terraformPath = join(cwd, 'infra/terraform');

  if (!existsSync(k8sPath) && !existsSync(terraformPath)) {
    return;
  }

  // Look for cluster context patterns in terraform files
  if (existsSync(terraformPath)) {
    try {
      const files = readdirSync(terraformPath).filter((f) => f.endsWith('.tf'));
      const contexts: Array<{ name: string; context: string; purpose: string }> = [];

      for (const file of files) {
        const content = readFileSync(join(terraformPath, file), 'utf-8');

        // Look for digitalocean_kubernetes_cluster or similar
        const doClusterMatch = content.match(/do-[\w-]+/g);
        if (doClusterMatch) {
          for (const match of [...new Set(doClusterMatch)]) {
            if (!contexts.find((c) => c.context === match)) {
              const purpose = match.includes('openobserve')
                ? 'Observability'
                : match.includes('zitadel')
                  ? 'Authentication'
                  : 'Applications';
              contexts.push({
                name: match.replace(/^do-\w+-/, '').replace(/-/g, ' '),
                context: match,
                purpose,
              });
            }
          }
        }
      }

      if (contexts.length > 0) {
        analysis.clusters = {
          enabled: true,
          contexts,
        };
      }
    } catch {
      // Ignore
    }
  }
}

function detectComponents(cwd: string, analysis: ProjectAnalysis): void {
  // Scan apps/ and services/ directories for components
  const componentDirs = ['apps', 'services', 'packages', 'libs'];

  for (const dir of componentDirs) {
    const dirPath = join(cwd, dir);
    if (!existsSync(dirPath)) continue;

    try {
      const subdirs = readdirSync(dirPath, { withFileTypes: true }).filter(
        (d) => d.isDirectory() && !d.name.startsWith('.')
      );

      for (const subdir of subdirs) {
        const compPath = join(dirPath, subdir.name);

        // Detect language and framework
        let language = 'Unknown';
        let framework = '';
        let description = '';

        // Check for package.json
        const pkgPath = join(compPath, 'package.json');
        if (existsSync(pkgPath)) {
          try {
            const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
            description = pkg.description || '';
            language = 'TypeScript';

            const deps = { ...pkg.dependencies, ...pkg.devDependencies };
            if (deps.react) framework = 'React';
            else if (deps.vue) framework = 'Vue';
            else if (deps.express) framework = 'Express';
            else if (deps.fastify) framework = 'Fastify';
            else if (deps.next) framework = 'Next.js';
          } catch {
            // Ignore
          }
        }

        // Check for pyproject.toml or requirements.txt
        if (
          existsSync(join(compPath, 'pyproject.toml')) ||
          existsSync(join(compPath, 'requirements.txt'))
        ) {
          language = 'Python';
          if (existsSync(join(compPath, 'pyproject.toml'))) {
            const content = readFileSync(join(compPath, 'pyproject.toml'), 'utf-8');
            if (content.includes('fastapi')) framework = 'FastAPI';
            else if (content.includes('flask')) framework = 'Flask';
            else if (content.includes('django')) framework = 'Django';
          }
        }

        // Check for CMakeLists.txt (C++)
        if (existsSync(join(compPath, 'CMakeLists.txt'))) {
          language = 'C++';
          const content = readFileSync(join(compPath, 'CMakeLists.txt'), 'utf-8');
          if (content.includes('crow') || content.includes('Crow')) framework = 'Crow';
        }

        // Check for Cargo.toml (Rust)
        if (existsSync(join(compPath, 'Cargo.toml'))) {
          language = 'Rust';
        }

        // Check for go.mod (Go)
        if (existsSync(join(compPath, 'go.mod'))) {
          language = 'Go';
        }

        // Only add if not already present
        const compFullPath = `${dir}/${subdir.name}`;
        if (!analysis.components.find((c) => c.path === compFullPath)) {
          analysis.components.push({
            name: subdir.name,
            path: compFullPath,
            language,
            framework: framework || undefined,
            description: description || `${language}${framework ? ` ${framework}` : ''} component`,
          });
        }
      }
    } catch {
      // Ignore
    }
  }
}

function detectFileTypeRouting(analysis: ProjectAnalysis): void {
  // This function doesn't modify analysis directly but ensures languages are properly detected
  // The FILE_TYPE_ROUTING template variable is built by the generator based on detected languages

  // Ensure unique languages
  analysis.languages = [...new Set(analysis.languages)];

  // Ensure frameworks are unique
  analysis.frameworks = [...new Set(analysis.frameworks)];
}
