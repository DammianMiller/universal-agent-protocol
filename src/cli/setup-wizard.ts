import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

// ── Types ──────────────────────────────────────────────────────────────

interface HarnessSelection {
  harnesses: string[];
}

interface MemoryFeatures {
  shortTermMemory: boolean;
  longTermMemory: boolean;
  knowledgeGraph: boolean;
  prepopDocs: boolean;
  prepopGit: boolean;
}

interface MultiAgentFeatures {
  coordinationDb: boolean;
  worktreeIsolation: boolean;
  deployBatching: boolean;
  agentMessaging: boolean;
}

interface PatternFeatures {
  patternLibrary: boolean;
  patternRag: boolean;
  reinforcementLearning: boolean;
}

interface PolicyFeatures {
  policyEngine: boolean;
  imageAssetVerification: boolean;
  iacStateParity: boolean;
  iacPipelineEnforcement: boolean;
  kubectlVerifyBackport: boolean;
  definitionOfDoneIac: boolean;
  customPoliciesDir: boolean;
}

interface ModelConfig {
  provider: 'openai' | 'anthropic' | 'local' | 'custom';
  qwenOptimizations: boolean;
  toolCallProfile: string;
  costTracking: boolean;
  modelRouting: boolean;
}

interface HooksConfig {
  sessionStart: boolean;
  preCompact: boolean;
  taskCompletion: boolean;
  autoApproveTools: boolean;
}

interface BrowserConfig {
  cloakBrowser: boolean;
}

interface WizardSelections {
  harnesses: string[];
  memory: MemoryFeatures;
  multiAgent: MultiAgentFeatures;
  patterns: PatternFeatures;
  policy: PolicyFeatures;
  model: ModelConfig;
  hooks: HooksConfig;
  browser: BrowserConfig;
}

// ── Harness ID mapping ────────────────────────────────────────────────

const HARNESS_TO_HOOK_TARGET: Record<string, string> = {
  'Claude Code': 'claude',
  'Factory.AI': 'factory',
  OpenCode: 'opencode',
  ForgeCode: 'forgecode',
  Cursor: 'cursor',
  VSCode: 'vscode',
  Cline: 'vscode',
  'Codex CLI': 'codex',
  Aider: 'claude',
  Continue: 'vscode',
  Windsurf: 'cursor',
  'Zed AI': 'claude',
  'GitHub Copilot': 'vscode',
  'JetBrains AI': 'vscode',
  'SWE-agent': 'claude',
  'Oh-My-Pi': 'omp',
};

const HARNESS_TO_PLATFORM: Record<string, string> = {
  'Claude Code': 'claude',
  'Factory.AI': 'factory',
  OpenCode: 'opencode',
  ForgeCode: 'opencode',
  Cursor: 'vscode',
  VSCode: 'vscode',
  Cline: 'vscode',
  'Codex CLI': 'codex',
  Aider: 'claude',
  Continue: 'vscode',
  Windsurf: 'vscode',
  'Zed AI': 'claude',
  'GitHub Copilot': 'vscode',
  'JetBrains AI': 'vscode',
  'SWE-agent': 'claude',
  'Oh-My-Pi': 'omp',
};

// ── Banner ─────────────────────────────────────────────────────────────

function printBanner(): void {
  console.log('');
  console.log(chalk.bold.cyan('  Universal Agent Protocol (UAP) - Interactive Setup Wizard'));
  console.log(chalk.dim('  ─'.repeat(30)));
  console.log('');
  console.log(
    chalk.white('  UAP gives AI coding agents persistent memory, multi-agent coordination,')
  );
  console.log(chalk.white('  pattern libraries, and policy enforcement - across every session.'));
  console.log('');
  console.log(
    chalk.dim('  This wizard will walk you through each feature and configure your project.')
  );
  console.log(
    chalk.dim('  Defaults are sensible - press Enter to accept, or customize as needed.')
  );
  console.log('');
}

// ── Section 1: Harness Selection ──────────────────────────────────────

async function promptHarnesses(): Promise<HarnessSelection> {
  console.log(chalk.bold.yellow('\n  Section 1: Harness Selection\n'));

  const { harnesses } = await inquirer.prompt<HarnessSelection>([
    {
      type: 'checkbox',
      name: 'harnesses',
      message: 'Which AI coding tools do you use?',
      choices: [
        { name: 'Claude Code (recommended)', value: 'Claude Code', checked: true },
        { name: 'Factory.AI', value: 'Factory.AI' },
        { name: 'OpenCode', value: 'OpenCode' },
        { name: 'ForgeCode', value: 'ForgeCode' },
        new inquirer.Separator(),
        { name: 'Cursor', value: 'Cursor' },
        { name: 'VSCode', value: 'VSCode' },
        { name: 'Cline', value: 'Cline' },
        new inquirer.Separator(),
        { name: 'Codex CLI', value: 'Codex CLI' },
        { name: 'Aider', value: 'Aider' },
        { name: 'Continue', value: 'Continue' },
        { name: 'Windsurf', value: 'Windsurf' },
        { name: 'Zed AI', value: 'Zed AI' },
        new inquirer.Separator(),
        { name: 'GitHub Copilot', value: 'GitHub Copilot' },
        { name: 'JetBrains AI', value: 'JetBrains AI' },
        { name: 'SWE-agent', value: 'SWE-agent' },
        new inquirer.Separator(),
        { name: 'Oh-My-Pi (omp)', value: 'Oh-My-Pi' },
      ],
    },
  ]);

  if (harnesses.length === 0) {
    console.log(chalk.yellow('  No harnesses selected - defaulting to Claude Code'));
    return { harnesses: ['Claude Code'] };
  }

  return { harnesses };
}

// ── Section 2: Memory Features ────────────────────────────────────────

async function promptMemoryFeatures(): Promise<MemoryFeatures> {
  console.log(chalk.bold.yellow('\n  Section 2: Memory Features\n'));

  const answers = await inquirer.prompt<MemoryFeatures>([
    {
      type: 'confirm',
      name: 'shortTermMemory',
      message: 'Short-term memory (SQLite)',
      default: true,
    },
    {
      type: 'confirm',
      name: 'longTermMemory',
      message: 'Long-term memory (Qdrant vectors) - requires Docker',
      default: false,
    },
    {
      type: 'confirm',
      name: 'knowledgeGraph',
      message: 'Knowledge graph',
      default: false,
    },
    {
      type: 'confirm',
      name: 'prepopDocs',
      message: 'Memory prepopulation from docs',
      default: false,
    },
    {
      type: 'confirm',
      name: 'prepopGit',
      message: 'Memory prepopulation from git history',
      default: false,
    },
  ]);

  return answers;
}

// ── Section 3: Multi-Agent Coordination ───────────────────────────────

async function promptMultiAgent(): Promise<MultiAgentFeatures> {
  console.log(chalk.bold.yellow('\n  Section 3: Multi-Agent Coordination\n'));

  const answers = await inquirer.prompt<MultiAgentFeatures>([
    {
      type: 'confirm',
      name: 'coordinationDb',
      message: 'Agent coordination database',
      default: true,
    },
    {
      type: 'confirm',
      name: 'worktreeIsolation',
      message: 'Worktree isolation',
      default: true,
    },
    {
      type: 'confirm',
      name: 'deployBatching',
      message: 'Deploy batching',
      default: false,
    },
    {
      type: 'confirm',
      name: 'agentMessaging',
      message: 'Agent messaging',
      default: false,
    },
  ]);

  return answers;
}

// ── Section 4: Pattern System ─────────────────────────────────────────

async function promptPatterns(qdrantEnabled: boolean): Promise<PatternFeatures> {
  console.log(chalk.bold.yellow('\n  Section 4: Pattern System\n'));

  const answers = await inquirer.prompt<PatternFeatures>([
    {
      type: 'confirm',
      name: 'patternLibrary',
      message: 'Pattern library (22 patterns)',
      default: true,
    },
    {
      type: 'confirm',
      name: 'patternRag',
      message: `Pattern RAG${qdrantEnabled ? '' : ' (requires Qdrant - enable long-term memory first)'}`,
      default: qdrantEnabled,
    },
    {
      type: 'confirm',
      name: 'reinforcementLearning',
      message: 'Reinforcement learning on patterns',
      default: false,
    },
  ]);

  return answers;
}

// ── Section 5: Policy Enforcement ─────────────────────────────────────

async function promptPolicy(): Promise<PolicyFeatures> {
  console.log(chalk.bold.yellow('\n  Section 5: Policy Enforcement\n'));

  const answers = await inquirer.prompt<PolicyFeatures>([
    {
      type: 'confirm',
      name: 'policyEngine',
      message: 'Policy engine',
      default: true,
    },
    {
      type: 'confirm',
      name: 'imageAssetVerification',
      message: 'Image & Asset Verification policy',
      default: false,
    },
    {
      type: 'confirm',
      name: 'iacStateParity',
      message: 'IaC State Parity policy',
      default: true,
    },
    {
      type: 'confirm',
      name: 'iacPipelineEnforcement',
      message: 'IaC Pipeline Enforcement policy (Terraform via CI/CD only)',
      default: true,
    },
    {
      type: 'confirm',
      name: 'kubectlVerifyBackport',
      message: 'kubectl Verify & Backport policy (backport kubectl changes to IaC)',
      default: true,
    },
    {
      type: 'confirm',
      name: 'definitionOfDoneIac',
      message: 'Definition of Done (IaC) policy (pipeline apply + kubectl verify)',
      default: true,
    },
    {
      type: 'confirm',
      name: 'customPoliciesDir',
      message: 'Custom policies directory',
      default: false,
    },
  ]);

  return answers;
}

// ── Section 6: Model Configuration ────────────────────────────────────

async function promptModelConfig(): Promise<ModelConfig> {
  console.log(chalk.bold.yellow('\n  Section 6: Model Configuration\n'));

  const { provider } = await inquirer.prompt<{ provider: ModelConfig['provider'] }>([
    {
      type: 'list',
      name: 'provider',
      message: 'Default model provider',
      choices: [
        { name: 'Anthropic (Claude)', value: 'anthropic' },
        { name: 'OpenAI', value: 'openai' },
        { name: 'Local (llama.cpp, Ollama, etc.)', value: 'local' },
        { name: 'Custom endpoint', value: 'custom' },
      ],
      default: 'anthropic',
    },
  ]);

  let qwenOptimizations = false;
  let toolCallProfile = 'generic';

  // Build profile choices based on provider
  type ProfileChoice = { name: string; value: string; short: string };
  const profileChoices: ProfileChoice[] = [];

  if (provider === 'anthropic') {
    profileChoices.push(
      {
        name: `${chalk.bold('claude-sonnet-4.6')} - Claude Sonnet 4.6 (recommended)\n    ${chalk.dim('Best speed/cost/quality balance. 200K ctx, extended thinking, parallel tools. $3/$15 per 1M tokens.')}`,
        value: 'claude-sonnet-4.6',
        short: 'claude-sonnet-4.6',
      },
      {
        name: `${chalk.bold('claude-opus-4.6')} - Claude Opus 4.6\n    ${chalk.dim('Most capable Claude. Deep reasoning, 200K ctx, extended thinking. Best for complex agentic workflows. $15/$75.')}`,
        value: 'claude-opus-4.6',
        short: 'claude-opus-4.6',
      },
      {
        name: `${chalk.bold('claude-haiku-3.5')} - Claude 3.5 Haiku\n    ${chalk.dim('Fastest and cheapest Claude. Sub-second latency, 200K ctx. Great for high-throughput tasks. $0.80/$4.')}`,
        value: 'claude-haiku-3.5',
        short: 'claude-haiku-3.5',
      }
    );
  } else if (provider === 'openai') {
    profileChoices.push(
      {
        name: `${chalk.bold('gpt-4.1')} - GPT-4.1 (recommended for coding)\n    ${chalk.dim('Purpose-built for coding and agentic use. 1M ctx, structured outputs, parallel function calling. $2/$8.')}`,
        value: 'gpt-4.1',
        short: 'gpt-4.1',
      },
      {
        name: `${chalk.bold('gpt-4o')} - GPT-4o\n    ${chalk.dim('Multimodal flagship. 128K ctx, JSON mode, parallel function calling. Fast and cost-effective. $2.50/$10.')}`,
        value: 'gpt-4o',
        short: 'gpt-4o',
      },
      {
        name: `${chalk.bold('gpt-o3')} - o3 (reasoning)\n    ${chalk.dim('Chain-of-thought reasoning model. 200K ctx, configurable reasoning effort. Best for complex analysis. $2/$8.')}`,
        value: 'gpt-o3',
        short: 'gpt-o3',
      }
    );
  } else if (provider === 'local') {
    profileChoices.push(
      {
        name: `${chalk.bold('generic')} - Any OpenAI-compatible model\n    ${chalk.dim('Conservative defaults. Works with llama.cpp, vLLM, Ollama, or any /v1/chat/completions server.')}`,
        value: 'generic',
        short: 'generic',
      },
      {
        name: `${chalk.bold('qwen35')} - Qwen 3 / Qwen 3.5 (recommended for local)\n    ${chalk.dim('Thinking-mode suppression, tool call batching, speculative decoding, 262K context. Tuned for 16-48GB VRAM.')}`,
        value: 'qwen35',
        short: 'qwen35',
      },
      {
        name: `${chalk.bold('llama')} - Meta Llama 3.x / Llama 4\n    ${chalk.dim('Flash attention, KV cache optimization, 131K context. Works with 8B through 405B at any quantization.')}`,
        value: 'llama',
        short: 'llama',
      },
      {
        name: `${chalk.bold('kimi-k2.5')} - Moonshot Kimi K2.5\n    ${chalk.dim('Open-weight MoE (1T/32B active). 128K ctx, strong coding. Runs via vLLM or Moonshot API.')}`,
        value: 'kimi-k2.5',
        short: 'kimi-k2.5',
      },
      {
        name: `${chalk.bold('glm-5')} - Zhipu GLM-5\n    ${chalk.dim('Chinese-English bilingual reasoning model. 128K ctx, deep thinking, tool calling. Via Zhipu API.')}`,
        value: 'glm-5',
        short: 'glm-5',
      }
    );
  } else {
    // Custom provider - show all profiles
    profileChoices.push({
      name: `${chalk.bold('generic')} - Generic defaults\n    ${chalk.dim('Works with any OpenAI-compatible endpoint.')}`,
      value: 'generic',
      short: 'generic',
    });
  }

  if (profileChoices.length > 0) {
    const defaultProfile = profileChoices[0].value;
    const profileAnswer = await inquirer.prompt<{ toolCallProfile: string }>([
      {
        type: 'list',
        name: 'toolCallProfile',
        message: 'Select model profile',
        choices: profileChoices,
        default: defaultProfile,
        pageSize: 15,
      },
    ]);
    toolCallProfile = profileAnswer.toolCallProfile;
    qwenOptimizations = toolCallProfile === 'qwen35';

    console.log('');
    console.log(chalk.cyan(`  Profile "${toolCallProfile}" will be saved to .uap.json.`));
    if (provider === 'local') {
      console.log(
        chalk.white('  Run ') +
          chalk.bold('uap-tool-calls setup') +
          chalk.white(' to apply profile-specific fixes after setup.')
      );
    }
    console.log('');
  }

  const extras = await inquirer.prompt<{
    costTracking: boolean;
    modelRouting: boolean;
  }>([
    {
      type: 'confirm',
      name: 'costTracking',
      message: 'Cost tracking',
      default: false,
    },
    {
      type: 'confirm',
      name: 'modelRouting',
      message: 'Model routing (multi-model)',
      default: false,
    },
  ]);

  return {
    provider,
    qwenOptimizations,
    toolCallProfile,
    costTracking: extras.costTracking,
    modelRouting: extras.modelRouting,
  };
}

// ── Section 7: Hooks & Automation ─────────────────────────────────────

async function promptHooks(): Promise<HooksConfig> {
  console.log(chalk.bold.yellow('\n  Section 7: Hooks & Automation\n'));

  const answers = await inquirer.prompt<HooksConfig>([
    {
      type: 'confirm',
      name: 'sessionStart',
      message: 'Session start hooks',
      default: true,
    },
    {
      type: 'confirm',
      name: 'preCompact',
      message: 'Pre-compact hooks',
      default: true,
    },
    {
      type: 'confirm',
      name: 'taskCompletion',
      message: 'Task completion hooks',
      default: false,
    },
    {
      type: 'confirm',
      name: 'autoApproveTools',
      message: 'Auto-approve tool calls',
      default: false,
    },
  ]);

  return answers;
}

// ── Section 8: Browser Automation ─────────────────────────────────────

async function promptBrowser(): Promise<BrowserConfig> {
  console.log(chalk.bold.yellow('\n  Section 8: Browser Automation\n'));

  const answers = await inquirer.prompt<BrowserConfig>([
    {
      type: 'confirm',
      name: 'cloakBrowser',
      message: 'CloakBrowser integration',
      default: false,
    },
  ]);

  if (answers.cloakBrowser) {
    console.log('');
    console.log(
      chalk.cyan('  Run ') +
        chalk.bold('npm run install:cloakbrowser') +
        chalk.cyan(' to install after setup.')
    );
    console.log('');
  }

  return answers;
}

// ── Summary ────────────────────────────────────────────────────────────

function printSummary(selections: WizardSelections): void {
  console.log('');
  console.log(chalk.bold.cyan('  Configuration Summary'));
  console.log(chalk.dim('  ─'.repeat(30)));
  console.log('');

  // Harnesses
  console.log(chalk.bold('  Harnesses:'));
  for (const h of selections.harnesses) {
    console.log(chalk.green(`    + ${h}`));
  }

  // Memory
  console.log('');
  console.log(chalk.bold('  Memory:'));
  printToggle('Short-term (SQLite)', selections.memory.shortTermMemory);
  printToggle('Long-term (Qdrant)', selections.memory.longTermMemory);
  printToggle('Knowledge graph', selections.memory.knowledgeGraph);
  printToggle('Prepopulate from docs', selections.memory.prepopDocs);
  printToggle('Prepopulate from git', selections.memory.prepopGit);

  // Multi-agent
  console.log('');
  console.log(chalk.bold('  Multi-Agent:'));
  printToggle('Coordination DB', selections.multiAgent.coordinationDb);
  printToggle('Worktree isolation', selections.multiAgent.worktreeIsolation);
  printToggle('Deploy batching', selections.multiAgent.deployBatching);
  printToggle('Agent messaging', selections.multiAgent.agentMessaging);

  // Patterns
  console.log('');
  console.log(chalk.bold('  Patterns:'));
  printToggle('Pattern library', selections.patterns.patternLibrary);
  printToggle('Pattern RAG', selections.patterns.patternRag);
  printToggle('Reinforcement learning', selections.patterns.reinforcementLearning);

  // Policy
  console.log('');
  console.log(chalk.bold('  Policy:'));
  printToggle('Policy engine', selections.policy.policyEngine);
  printToggle('Image & Asset Verification', selections.policy.imageAssetVerification);
  printToggle('IaC State Parity', selections.policy.iacStateParity);
  printToggle('IaC Pipeline Enforcement', selections.policy.iacPipelineEnforcement);
  printToggle('kubectl Verify & Backport', selections.policy.kubectlVerifyBackport);
  printToggle('Definition of Done (IaC)', selections.policy.definitionOfDoneIac);
  printToggle('Custom policies dir', selections.policy.customPoliciesDir);

  // Model
  console.log('');
  console.log(chalk.bold('  Model:'));
  console.log(`    Provider: ${chalk.white(selections.model.provider)}`);
  if (selections.model.toolCallProfile) {
    console.log(`    Tool call profile: ${chalk.white(selections.model.toolCallProfile)}`);
  }
  if (selections.model.provider === 'local' && selections.model.qwenOptimizations) {
    printToggle('Qwen3.5 optimizations', selections.model.qwenOptimizations);
  }
  printToggle('Cost tracking', selections.model.costTracking);
  printToggle('Model routing', selections.model.modelRouting);

  // Hooks
  console.log('');
  console.log(chalk.bold('  Hooks:'));
  printToggle('Session start', selections.hooks.sessionStart);
  printToggle('Pre-compact', selections.hooks.preCompact);
  printToggle('Task completion', selections.hooks.taskCompletion);
  printToggle('Auto-approve tools', selections.hooks.autoApproveTools);

  // Browser
  console.log('');
  console.log(chalk.bold('  Browser:'));
  printToggle('CloakBrowser', selections.browser.cloakBrowser);

  console.log('');
}

function printToggle(label: string, enabled: boolean): void {
  const icon = enabled ? chalk.green('ON ') : chalk.dim('OFF');
  console.log(`    [${icon}] ${label}`);
}

// ── What will be installed ─────────────────────────────────────────────

function printInstallPlan(selections: WizardSelections): void {
  console.log(chalk.bold('  What will be installed/configured:\n'));

  const steps: string[] = [];

  steps.push('Create .uap.json configuration');
  steps.push('Create directory structure (agents/data/memory, agents/scripts)');

  const platforms = [
    ...new Set(selections.harnesses.map((h) => HARNESS_TO_PLATFORM[h] || 'claude')),
  ];
  steps.push(`Initialize platforms: ${platforms.join(', ')}`);

  if (selections.memory.shortTermMemory) {
    steps.push('Initialize SQLite memory database');
  }
  if (selections.memory.longTermMemory) {
    steps.push('Start Qdrant (Docker) and wait for healthcheck');
  }
  if (selections.patterns.patternLibrary) {
    steps.push('Set up Python venv and generate pattern scripts');
  }
  if (selections.patterns.patternRag && selections.memory.longTermMemory) {
    steps.push('Index patterns into Qdrant');
  }

  const hookTargets = [
    ...new Set(selections.harnesses.map((h) => HARNESS_TO_HOOK_TARGET[h] || 'claude')),
  ];
  if (selections.hooks.sessionStart || selections.hooks.preCompact) {
    steps.push(`Install hooks for: ${hookTargets.join(', ')}`);
  }

  steps.push('Configure MCP Router');
  steps.push('Generate/update CLAUDE.md');

  if (selections.browser.cloakBrowser) {
    steps.push('Flag CloakBrowser for post-install');
  }
  if (selections.model.toolCallProfile && selections.model.toolCallProfile !== 'generic') {
    steps.push(`Apply tool-call profile: ${selections.model.toolCallProfile}`);
  }

  for (let i = 0; i < steps.length; i++) {
    console.log(chalk.white(`    ${i + 1}. ${steps[i]}`));
  }

  console.log('');
}

// ── Execute setup ──────────────────────────────────────────────────────

async function executeSetup(selections: WizardSelections): Promise<void> {
  const cwd = process.cwd();
  const { execa } = await import('execa');

  // Resolve the `uap` binary path. Prefer the locally-installed bin so that
  // the wizard works both from a global install and from `npx`.
  const localBin = join(cwd, 'node_modules', '.bin', 'uap');
  const uap = existsSync(localBin) ? localBin : 'uap';

  // ── Step 1: Run init ────────────────────────────────────────────────
  const platforms = [
    ...new Set(selections.harnesses.map((h) => HARNESS_TO_PLATFORM[h] || 'claude')),
  ];
  const platformArg = platforms.length > 0 ? platforms.join(',') : 'all';

  const initSpinner = ora('Running init (config, dirs, CLAUDE.md)...').start();
  try {
    const initArgs = ['init', '-p', platformArg];
    if (!selections.memory.shortTermMemory && !selections.memory.longTermMemory) {
      initArgs.push('--no-memory');
    }
    if (!selections.patterns.patternLibrary && !selections.patterns.patternRag) {
      initArgs.push('--no-patterns');
    }
    if (!selections.multiAgent.worktreeIsolation) {
      initArgs.push('--no-worktrees');
    }

    await execa(uap, initArgs, { cwd, stdio: 'pipe' });
    initSpinner.succeed('Initialized project');
  } catch (err) {
    initSpinner.warn(
      `Init had warnings: ${err instanceof Error ? err.message.slice(0, 80) : String(err).slice(0, 80)}`
    );
  }

  // ── Step 2: Patch .uap.json with wizard-specific settings ──────────
  const configSpinner = ora('Applying wizard configuration...').start();
  try {
    const configPath = join(cwd, '.uap.json');
    let config: Record<string, unknown> = {};
    if (existsSync(configPath)) {
      config = JSON.parse(readFileSync(configPath, 'utf-8'));
    }

    // Memory settings
    const memory = (config.memory || {}) as Record<string, unknown>;
    if (selections.memory.longTermMemory) {
      memory.longTerm = {
        enabled: true,
        provider: 'qdrant',
        endpoint: 'localhost:6333',
        collection: 'agent_memory',
        embeddingModel: 'all-MiniLM-L6-v2',
        ...((memory.longTerm as Record<string, unknown>) || {}),
      };
    } else {
      const lt = (memory.longTerm || {}) as Record<string, unknown>;
      lt.enabled = false;
      memory.longTerm = lt;
    }

    if (selections.memory.knowledgeGraph) {
      memory.knowledgeGraph = { enabled: true };
    }
    if (selections.memory.prepopDocs) {
      memory.prepopulation = {
        ...((memory.prepopulation as Record<string, unknown>) || {}),
        docs: true,
      };
    }
    if (selections.memory.prepopGit) {
      memory.prepopulation = {
        ...((memory.prepopulation as Record<string, unknown>) || {}),
        gitHistory: true,
      };
    }
    config.memory = memory;

    // Multi-agent settings
    config.coordination = {
      database: selections.multiAgent.coordinationDb,
      deployBatching: selections.multiAgent.deployBatching,
      agentMessaging: selections.multiAgent.agentMessaging,
    };

    // Worktree settings
    if (selections.multiAgent.worktreeIsolation) {
      config.worktrees = {
        enabled: true,
        directory: '.worktrees',
        branchPrefix: 'feature/',
        autoCleanup: true,
        ...((config.worktrees as Record<string, unknown>) || {}),
      };
    }

    // Pattern settings
    if (selections.patterns.patternRag) {
      const memObj = config.memory as Record<string, unknown>;
      memObj.patternRag = {
        enabled: true,
        collection: 'agent_patterns',
        embeddingModel: 'all-MiniLM-L6-v2',
        vectorSize: 384,
        scoreThreshold: 0.35,
        topK: 2,
        ...((memObj.patternRag as Record<string, unknown>) || {}),
      };
    }
    if (selections.patterns.reinforcementLearning) {
      config.patternRL = { enabled: true };
    }

    // Policy settings
    config.policy = {
      enabled: selections.policy.policyEngine,
      imageAssetVerification: selections.policy.imageAssetVerification,
      iacStateParity: selections.policy.iacStateParity,
      iacPipelineEnforcement: selections.policy.iacPipelineEnforcement,
      kubectlVerifyBackport: selections.policy.kubectlVerifyBackport,
      definitionOfDoneIac: selections.policy.definitionOfDoneIac,
      customDir: selections.policy.customPoliciesDir ? './policies' : undefined,
    };

    // Model settings
    config.model = {
      provider: selections.model.provider,
      costTracking: selections.model.costTracking,
      routing: selections.model.modelRouting,
      ...(selections.model.provider === 'local'
        ? { qwenOptimizations: selections.model.qwenOptimizations }
        : {}),
    };

    // Tool call profile (persisted for uap-tool-calls to read)
    if (selections.model.toolCallProfile) {
      const toolCalls = (config.toolCalls as Record<string, unknown>) || {};
      toolCalls.modelProfile = selections.model.toolCallProfile;
      config.toolCalls = toolCalls;
    }

    // Hooks settings
    config.hooks = {
      sessionStart: selections.hooks.sessionStart,
      preCompact: selections.hooks.preCompact,
      taskCompletion: selections.hooks.taskCompletion,
      autoApproveTools: selections.hooks.autoApproveTools,
    };

    // Browser settings
    if (selections.browser.cloakBrowser) {
      config.browser = { cloakBrowser: true };
    }

    writeFileSync(configPath, JSON.stringify(config, null, 2));
    configSpinner.succeed('Applied wizard configuration to .uap.json');
  } catch (err) {
    configSpinner.fail(
      `Config patch failed: ${err instanceof Error ? err.message.slice(0, 80) : String(err).slice(0, 80)}`
    );
  }

  // ── Step 3: Start Qdrant if long-term memory enabled ───────────────
  if (selections.memory.longTermMemory) {
    const qdrantSpinner = ora('Starting Qdrant (Docker)...').start();
    try {
      await execa(uap, ['memory', 'start'], { cwd, stdio: 'pipe' });
      qdrantSpinner.succeed('Qdrant started');
    } catch {
      qdrantSpinner.warn('Could not start Qdrant (Docker may not be available)');
    }
  }

  // ── Step 4: Install hooks for selected harnesses ────────────────────
  if (selections.hooks.sessionStart || selections.hooks.preCompact) {
    const hookTargets = [
      ...new Set(selections.harnesses.map((h) => HARNESS_TO_HOOK_TARGET[h] || 'claude')),
    ];

    for (const target of hookTargets) {
      const hookSpinner = ora(`Installing hooks for ${target}...`).start();
      try {
        await execa(uap, ['hooks', 'install', '--target', target], {
          cwd,
          stdio: 'pipe',
        });
        hookSpinner.succeed(`Hooks installed for ${target}`);
      } catch {
        hookSpinner.warn(`Could not install hooks for ${target}`);
      }
    }
  }

  // ── Step 5: Index patterns if Qdrant + patterns enabled ─────────────
  if (selections.patterns.patternRag && selections.memory.longTermMemory) {
    const patternSpinner = ora('Indexing patterns into Qdrant...').start();
    try {
      await execa(uap, ['patterns', 'index'], { cwd, stdio: 'pipe' });
      patternSpinner.succeed('Patterns indexed');
    } catch {
      patternSpinner.warn('Pattern indexing failed (non-fatal)');
    }
  }

  // ── Step 6: Setup MCP Router ────────────────────────────────────────
  const mcpSpinner = ora('Configuring MCP Router...').start();
  try {
    await execa(uap, ['setup', '--no-patterns', '--no-memory', '-p', platformArg], {
      cwd,
      stdio: 'pipe',
    });
    mcpSpinner.succeed('MCP Router configured');
  } catch {
    mcpSpinner.warn('MCP Router setup skipped');
  }

  // ── Step 7: Auto-setup tool call profile (chat template, scripts) ──
  if (selections.model.toolCallProfile && selections.model.toolCallProfile !== 'generic') {
    const toolCallSpinner = ora(
      `Applying tool call profile: ${selections.model.toolCallProfile}...`
    ).start();
    try {
      // Run uap-tool-calls setup non-interactively
      await execa('node', [join(cwd, 'dist', 'bin', 'tool-calls.js'), 'setup'], {
        cwd,
        stdio: 'pipe',
        env: { ...process.env, UAP_MODEL_PROFILE: selections.model.toolCallProfile },
      });
      toolCallSpinner.succeed(
        `Tool call profile "${selections.model.toolCallProfile}" applied (template + scripts)`
      );
    } catch {
      // Fall back to global binary
      try {
        await execa('uap-tool-calls', ['setup'], {
          cwd,
          stdio: 'pipe',
          env: { ...process.env, UAP_MODEL_PROFILE: selections.model.toolCallProfile },
        });
        toolCallSpinner.succeed(`Tool call profile "${selections.model.toolCallProfile}" applied`);
      } catch {
        toolCallSpinner.warn(
          `Tool call setup skipped (run manually: UAP_MODEL_PROFILE=${selections.model.toolCallProfile} uap-tool-calls setup)`
        );
      }
    }
  }
}

// ── Final instructions ─────────────────────────────────────────────────

function printFinalInstructions(selections: WizardSelections): void {
  console.log('');
  console.log(chalk.bold.green('  Setup complete!'));
  console.log(chalk.dim('  ─'.repeat(30)));
  console.log('');

  console.log(chalk.bold('  Your AI assistant will now:'));
  console.log('    - Query memory before starting work');
  console.log('    - Store learnings for future sessions');
  if (selections.patterns.patternLibrary) {
    console.log('    - Apply patterns from the 22-pattern library');
  }
  if (selections.patterns.patternRag && selections.memory.longTermMemory) {
    console.log('    - Retrieve relevant patterns via RAG (~12K tokens saved)');
  }
  if (selections.multiAgent.worktreeIsolation) {
    console.log('    - Use worktrees for safe git workflow');
  }
  if (selections.policy.policyEngine) {
    console.log('    - Enforce configured policies');
  }

  // Post-install actions (only items that couldn't be automated)
  const postSteps: string[] = [];
  if (selections.browser.cloakBrowser) {
    postSteps.push('Run `npm run install:cloakbrowser` to install CloakBrowser');
  }
  if (selections.memory.longTermMemory && !selections.patterns.patternRag) {
    postSteps.push('Run `uap patterns index` to index patterns into Qdrant later');
  }

  if (postSteps.length > 0) {
    console.log('');
    console.log(chalk.bold('  Post-install steps:'));
    for (const step of postSteps) {
      console.log(chalk.yellow(`    - ${step}`));
    }
  }

  console.log('');
}

// ── Main entry point ───────────────────────────────────────────────────

export async function runSetupWizard(): Promise<void> {
  printBanner();

  // Walk through each section
  const harnesseResult = await promptHarnesses();
  const memory = await promptMemoryFeatures();
  const multiAgent = await promptMultiAgent();
  const patterns = await promptPatterns(memory.longTermMemory);
  const policy = await promptPolicy();
  const model = await promptModelConfig();
  const hooks = await promptHooks();
  const browser = await promptBrowser();

  const selections: WizardSelections = {
    harnesses: harnesseResult.harnesses,
    memory,
    multiAgent,
    patterns,
    policy,
    model,
    hooks,
    browser,
  };

  // Print summary and install plan
  printSummary(selections);
  printInstallPlan(selections);

  // Confirm
  const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
    {
      type: 'confirm',
      name: 'confirmed',
      message: 'Proceed with setup?',
      default: true,
    },
  ]);

  if (!confirmed) {
    console.log(chalk.yellow('\n  Setup cancelled.\n'));
    return;
  }

  console.log('');

  // Execute
  await executeSetup(selections);

  // Final instructions
  printFinalInstructions(selections);
}
