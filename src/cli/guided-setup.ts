/**
 * Guided setup — the default arrow-key flow for `uap setup`.
 *
 * Walks the user through the essential configuration with @clack/prompts (via
 * the PromptUI abstraction), backs up their agent instruction files, offers to
 * extract unique custom content into policies/skills, then runs the same
 * in-process building blocks the scripted path uses (initCommand +
 * runSetupSteps) — no logic duplication. Smart defaults are derived from the
 * environment (docker/Qdrant, a local model endpoint) so the recommended path
 * is one Enter away.
 */

import chalk from 'chalk';
import { spawnSync } from 'child_process';
import { initCommand } from './init.js';
import { runSetupSteps, type SetupOptions } from './setup.js';
import { backupInstructionFiles } from './setup-backup.js';
import { extractInteractive } from './setup-extract.js';
import { isQdrantReachable } from './memory.js';
import { RoutingPresets } from '../models/index.js';
import { createClackUI, type PromptUI } from './prompt-ui.js';
import {
  applyWizardConfig,
  defaultSelections,
  profileChoicesFor,
  writeProxyEnv,
  type ModelFeatures,
  type RecipeFeatures,
  type WizardSelections,
} from './wizard-config.js';

interface HarnessChoice {
  label: string;
  value: string; // init platform token
}

const HARNESSES: HarnessChoice[] = [
  { label: 'Claude Code', value: 'claude' },
  { label: 'Factory.AI (droids)', value: 'factory' },
  { label: 'OpenCode', value: 'opencode' },
  { label: 'VS Code / Copilot', value: 'vscode' },
  { label: 'Codex', value: 'codex' },
];

function dockerAvailable(): boolean {
  try {
    return spawnSync('docker', ['--version'], { timeout: 4000, stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

/** Probe a couple of conventional local OpenAI-compatible endpoints. */
async function detectLocalModel(): Promise<string | null> {
  const candidates = [
    process.env.UAP_INFERENCE_ENDPOINT,
    process.env.OPENAI_BASE_URL,
    'http://localhost:8080/v1',
    'http://localhost:11434/v1',
  ].filter(Boolean) as string[];
  for (const base of candidates) {
    try {
      // Only probe http(s) endpoints, and never follow redirects — a misset
      // env URL shouldn't turn detection into an SSRF/redirect primitive.
      if (!/^https?:\/\//i.test(base)) continue;
      const url = base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`;
      const res = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: 'error' });
      if (res.ok) return base;
    } catch {
      /* not reachable */
    }
  }
  return null;
}

export async function runGuidedSetup(options: SetupOptions, injectedUi?: PromptUI): Promise<void> {
  const cwd = options.projectDir || process.cwd();
  const ui = injectedUi ?? (await createClackUI());

  ui.intro(chalk.bold('UAP guided setup'));

  // ── Environment detection → smart defaults ──────────────────────────
  const hasDocker = dockerAvailable();
  const localModel = await detectLocalModel();
  const qdrantUp = hasDocker ? await isQdrantReachable('http://localhost:6333', 1500) : false;

  if (localModel) ui.note(`Local model endpoint detected at ${localModel}`, 'Detected');

  // ── Harnesses ───────────────────────────────────────────────────────
  const platforms = await ui.multiselect<string>({
    message: 'Which AI coding harnesses should UAP wire up?',
    options: HARNESSES.map((h) => ({ label: h.label, value: h.value })),
    initialValues: ['claude'],
    required: true,
  });
  const platform = platforms.length > 0 ? platforms : ['claude'];

  // ── Memory (short-term always on; pick the richer tiers) ────────────
  const mem = await ui.multiselect<string>({
    message: 'Memory features (short-term SQLite is always on):',
    options: [
      { label: 'Long-term memory (Qdrant vectors)', value: 'longTerm', hint: hasDocker ? (qdrantUp ? 'Qdrant running' : 'Docker detected') : 'needs Docker' },
      { label: 'Knowledge graph', value: 'knowledgeGraph' },
      { label: 'Prepopulate from docs', value: 'prepopDocs' },
      { label: 'Prepopulate from git history', value: 'prepopGit' },
    ],
    initialValues: hasDocker ? ['longTerm'] : [],
    required: false,
  });
  const longTerm = mem.includes('longTerm');

  // ── Multi-agent ─────────────────────────────────────────────────────
  const ma = await ui.multiselect<string>({
    message: 'Multi-agent coordination:',
    options: [
      { label: 'Coordination database', value: 'coordinationDb' },
      { label: 'Worktree isolation', value: 'worktreeIsolation' },
      { label: 'Deploy batching', value: 'deployBatching' },
      { label: 'Agent messaging', value: 'agentMessaging' },
    ],
    initialValues: ['coordinationDb', 'worktreeIsolation'],
    required: false,
  });

  // ── Patterns ────────────────────────────────────────────────────────
  const pat = await ui.multiselect<string>({
    message: 'Pattern system:',
    options: [
      { label: 'Pattern library (22 patterns)', value: 'patternLibrary' },
      { label: 'Pattern RAG', value: 'patternRag', hint: longTerm ? '' : 'needs long-term memory' },
      { label: 'Reinforcement learning on patterns', value: 'reinforcementLearning' },
    ],
    initialValues: longTerm ? ['patternLibrary', 'patternRag'] : ['patternLibrary'],
    required: false,
  });

  // ── Policy ──────────────────────────────────────────────────────────
  const policyEngine = await ui.confirm({ message: 'Enable the policy engine?', initialValue: true });
  let pol: string[] = [];
  if (policyEngine) {
    pol = await ui.multiselect<string>({
      message: 'Policies to enable:',
      options: [
        { label: 'IaC State Parity', value: 'iacStateParity' },
        { label: 'IaC Pipeline Enforcement', value: 'iacPipelineEnforcement' },
        { label: 'kubectl Verify & Backport', value: 'kubectlVerifyBackport' },
        { label: 'Definition of Done (IaC)', value: 'definitionOfDoneIac' },
        { label: 'Image & Asset Verification', value: 'imageAssetVerification' },
        { label: 'Custom policies directory (./policies)', value: 'customPoliciesDir' },
      ],
      initialValues: ['iacStateParity', 'iacPipelineEnforcement', 'kubectlVerifyBackport', 'definitionOfDoneIac'],
      required: false,
    });
  }

  // ── Model ───────────────────────────────────────────────────────────
  const provider = await ui.select<ModelFeatures['provider']>({
    message: 'Default model provider:',
    options: [
      { label: 'Anthropic (Claude)', value: 'anthropic' },
      { label: 'OpenAI', value: 'openai' },
      { label: 'Local (llama.cpp, Ollama, …)', value: 'local' },
      { label: 'Custom endpoint', value: 'custom' },
    ],
    initialValue: localModel ? 'local' : 'anthropic',
  });
  const profiles = profileChoicesFor(provider);
  const toolCallProfile = await ui.select<string>({
    message: 'Model profile:',
    options: profiles,
    initialValue: provider === 'local' && localModel ? 'qwen35-a3b' : profiles[0]?.value,
  });
  const modelExtras = await ui.multiselect<string>({
    message: 'Model extras:',
    options: [
      { label: 'Cost tracking', value: 'costTracking' },
      { label: 'Model routing (multi-model)', value: 'modelRouting' },
    ],
    initialValues: [],
    required: false,
  });

  // ── Multi-model routing option (shown when routing is enabled) ───────
  let routingPreset = 'none';
  if (modelExtras.includes('modelRouting')) {
    routingPreset = await ui.select<string>({
      message: 'Routing option (which model handles each role):',
      options: [
        { label: 'None - use a single model for everything', value: 'none' },
        ...Object.values(RoutingPresets).map((p) => ({
          label: p.name,
          value: p.id,
          hint: `exec=${p.roles.executor} review=${p.roles.reviewer}`,
        })),
      ],
      initialValue: 'none',
    });
    if (routingPreset !== 'none') {
      ui.note(
        'The cloud roles run on Anthropic (Claude). On a Claude Max/Pro subscription these ' +
          "roles route through the proxy's OAuth passthrough; otherwise set ANTHROPIC_API_KEY. " +
          'Execution can stay free on the local model.',
        'Routing'
      );
    }
  }

  // ── Hooks ───────────────────────────────────────────────────────────
  const hk = await ui.multiselect<string>({
    message: 'Hooks & automation:',
    options: [
      { label: 'Session-start hook', value: 'sessionStart' },
      { label: 'Pre-compact hook', value: 'preCompact' },
      { label: 'Task-completion hook', value: 'taskCompletion' },
      { label: 'Auto-approve tools', value: 'autoApproveTools' },
    ],
    initialValues: ['sessionStart', 'preCompact'],
    required: false,
  });

  // ── Browser ─────────────────────────────────────────────────────────
  const cloakBrowser = await ui.confirm({ message: 'Enable CloakBrowser automation?', initialValue: false });

  // ── Serving-layer recipes + escalation judge ────────────────────────
  const recipesOn = await ui.confirm({
    message: 'Enable serving-layer recipes (Fusion/Confidence run behind the proxy)?',
    initialValue: false,
  });
  let recipeMode = 'auto';
  let allowSelfJudge = false;
  let judgeModel = '';
  let judgeEndpoint = '';
  let judgeApiKey = '';
  if (recipesOn) {
    recipeMode = await ui.select<string>({
      message: 'Recipe mode:',
      options: [
        { label: 'auto — pick per task (recommended)', value: 'auto' },
        { label: 'confidence — escalate only low-confidence turns', value: 'confidence' },
        { label: 'fusion — best-of-N + judge', value: 'fusion' },
        { label: 'ratings — rate candidates, pick best', value: 'ratings' },
        { label: 'remom — breadth to quorum to synthesis', value: 'remom' },
      ],
      initialValue: 'auto',
    });
    ui.note(
      'Recipes add quality lift only with a STRONGER, DISTINCT judge model. A same-model\njudge (qwen-judges-qwen) was measured to add no lift, so it is gated off by default.',
      'Escalation judge'
    );
    const wantJudge = await ui.confirm({ message: 'Configure the escalation judge backend now?', initialValue: true });
    if (wantJudge) {
      judgeModel = await ui.text({ message: 'Judge model (stronger than the primary):', placeholder: 'claude-opus-4-8' });
      judgeEndpoint = await ui.text({
        message: 'Judge endpoint (Anthropic /v1/messages base URL):',
        placeholder: 'https://api.anthropic.com',
      });
      judgeApiKey = await ui.text({
        message: 'Judge API key (stored in .uap/proxy.env, chmod 600):',
        placeholder: 'sk-ant-...',
      });
    }
    allowSelfJudge = await ui.confirm({ message: 'Allow a same-model self-judge anyway (not recommended)?', initialValue: false });
  }

  // ── Delivery & runtime gates ────────────────────────────────────────
  const deliverEnforcement = await ui.select<'block' | 'advisory' | 'off'>({
    message: 'Delivery enforcement (route code edits through `uap deliver` + gates):',
    options: [
      { label: 'block — direct edits blocked, must use deliver (recommended)', value: 'block' },
      { label: 'advisory — warn but allow direct edits', value: 'advisory' },
      { label: 'off — no delivery enforcement', value: 'off' },
    ],
    initialValue: 'block',
  });
  const localDeliverMode = await ui.select<'advisory' | 'deliver' | 'block'>({
    message: 'Local-model deliver mode (how local builds are gated):',
    options: [
      { label: 'advisory — record intent only', value: 'advisory' },
      { label: 'deliver — route local builds through deliver + verify', value: 'deliver' },
      { label: 'block — block local edits without deliver', value: 'block' },
    ],
    initialValue: 'advisory',
  });
  const runtimeVerify = await ui.confirm({
    message: 'Install the runtime-verify Stop-hook (`uap verify` proves generated code runs at session end)?',
    initialValue: true,
  });

  // ── Model-slot concurrency ──────────────────────────────────────────
  const concurrencyOn = await ui.confirm({
    message: 'Model-slot concurrency backpressure (do not exhaust inference slots on fan-out)?',
    initialValue: true,
  });

  // ── Agent collaboration ─────────────────────────────────────────────
  const collabMode = await ui.select<'auto' | 'always' | 'off'>({
    message: 'Agent-collaboration guidance (board / coordination / challenge):',
    options: [
      { label: 'auto — surface when a multi-agent context is detected (recommended)', value: 'auto' },
      { label: 'always — always surface', value: 'always' },
      { label: 'off — manual `uap coord` only', value: 'off' },
    ],
    initialValue: 'auto',
  });

  // ── DESIGN.md integration ───────────────────────────────────────────
  const designOn = await ui.confirm({
    message: 'Enable DESIGN.md integration (uap design + reactor design guidance)?',
    initialValue: false,
  });
  let designTokenGate = false;
  if (designOn) {
    designTokenGate = await ui.confirm({
      message: 'Hard token gate (block UI work that uses off-spec design tokens)?',
      initialValue: false,
    });
  }

  // ── Reactor ─────────────────────────────────────────────────────────
  const reactorOn = await ui.confirm({
    message: 'Reactor per-prompt capability/skill/pattern injection?',
    initialValue: true,
  });

  const selections: WizardSelections = defaultSelections({
    platforms: platform,
    memory: {
      shortTermMemory: true,
      longTermMemory: longTerm,
      knowledgeGraph: mem.includes('knowledgeGraph'),
      prepopDocs: mem.includes('prepopDocs'),
      prepopGit: mem.includes('prepopGit'),
    },
    multiAgent: {
      coordinationDb: ma.includes('coordinationDb'),
      worktreeIsolation: ma.includes('worktreeIsolation'),
      deployBatching: ma.includes('deployBatching'),
      agentMessaging: ma.includes('agentMessaging'),
    },
    patterns: {
      patternLibrary: pat.includes('patternLibrary'),
      patternRag: pat.includes('patternRag'),
      reinforcementLearning: pat.includes('reinforcementLearning'),
    },
    policy: {
      policyEngine,
      imageAssetVerification: pol.includes('imageAssetVerification'),
      iacStateParity: pol.includes('iacStateParity'),
      iacPipelineEnforcement: pol.includes('iacPipelineEnforcement'),
      kubectlVerifyBackport: pol.includes('kubectlVerifyBackport'),
      definitionOfDoneIac: pol.includes('definitionOfDoneIac'),
      customPoliciesDir: pol.includes('customPoliciesDir'),
    },
    model: {
      provider,
      qwenOptimizations: toolCallProfile === 'qwen35-a3b',
      toolCallProfile,
      costTracking: modelExtras.includes('costTracking'),
      modelRouting: modelExtras.includes('modelRouting'),
      routingPreset,
    },
    hooks: {
      sessionStart: hk.includes('sessionStart'),
      preCompact: hk.includes('preCompact'),
      taskCompletion: hk.includes('taskCompletion'),
      autoApproveTools: hk.includes('autoApproveTools'),
    },
    browser: { cloakBrowser },
    recipes: {
      enabled: recipesOn,
      recipe: recipeMode as RecipeFeatures['recipe'],
      confidenceThreshold: 0.5,
      fusionN: 3,
      allowSelfJudge,
      ...(judgeModel ? { judgeModel } : {}),
      ...(judgeEndpoint ? { judgeEndpoint } : {}),
      ...(judgeApiKey ? { judgeApiKey } : {}),
    },
    delivery: { enforcement: deliverEnforcement, localMode: localDeliverMode, runtimeVerify },
    concurrency: { enabled: concurrencyOn, ...(localModel ? { endpoint: localModel } : {}) },
    collaboration: { mode: collabMode },
    design: { enabled: designOn, tokenGate: designTokenGate },
    reactor: { enabled: reactorOn },
  });

  const withMemory = true; // short-term is always on
  const withPatterns = selections.patterns.patternLibrary || selections.patterns.patternRag;

  // ── Backup + extraction (operate on the ORIGINAL instruction files) ──
  if (options.backup !== false) {
    const b = backupInstructionFiles(cwd);
    if (b.backedUp.length > 0) {
      ui.note(`Backed up ${b.backedUp.length} file(s) → .uap-backups/${b.date}/`, 'Backup');
    }
  }
  if (options.extract !== false) {
    await extractInteractive(cwd, ui);
  }

  // ── Confirm + apply ─────────────────────────────────────────────────
  const proceed = await ui.confirm({
    message: `Apply setup for [${platform.join(', ')}] · provider=${provider}/${toolCallProfile} · long-term mem=${longTerm ? 'on' : 'off'} · patterns=${withPatterns ? 'on' : 'off'} · recipes=${recipesOn ? recipeMode : 'off'} · deliver=${deliverEnforcement}?`,
    initialValue: true,
  });
  if (!proceed) {
    ui.outro(chalk.yellow('Setup cancelled — no further changes made.'));
    return;
  }

  // init already backed up above (pass backup:false to avoid a redundant pass).
  await initCommand({
    platform,
    memory: withMemory,
    patterns: withPatterns,
    worktrees: selections.multiAgent.worktreeIsolation,
    systemdServices: options.systemdServices,
    projectDir: cwd,
    backup: false,
  });

  // Persist the rich wizard config to .uap.json (memory tiers, coordination,
  // patterns, policy, model/profile, hooks, browser).
  const written = await applyWizardConfig(cwd, selections);
  if (written) ui.note('Wizard configuration written to .uap.json', 'Config');

  // Emit the proxy runtime env (recipes / escalation / delivery) so the running
  // proxy consumes the selections without the user hand-exporting env vars.
  const envPath = writeProxyEnv(cwd, selections);
  if (envPath) {
    ui.note(
      `Proxy runtime env -> ${envPath}\nSource it before starting the proxy (systemd EnvironmentFile-compatible).`,
      selections.recipes.judgeApiKey ? 'Config (contains a secret - chmod 600)' : 'Config'
    );
  }
  if (recipesOn && !judgeModel && !allowSelfJudge) {
    ui.note(
      'Recipes are enabled but no distinct judge is configured, so judge-dependent recipes\nwill run as single (no lift) until you set PROXY_ESCALATE_MODEL/_ENDPOINT/_API_KEY.',
      'Heads up'
    );
  }

  await runSetupSteps(cwd, { ...options, memory: withMemory, patterns: withPatterns });

  // Apply profile-specific tool-call fixes for any non-generic profile (faithful
  // to the legacy wizard). In-process + fail-soft; falls back to a reminder.
  if (selections.model.toolCallProfile && selections.model.toolCallProfile !== 'generic') {
    try {
      const { toolCallsCommand } = await import('./tool-calls.js');
      await toolCallsCommand('setup');
    } catch {
      ui.note('Run `uap-tool-calls setup` to apply profile-specific tool-call fixes.', 'Next step');
    }
  }
  if (cloakBrowser) {
    ui.note('Run `npm run install:cloakbrowser` to finish CloakBrowser setup.', 'Next step');
  }

  ui.outro(chalk.green('✅ Setup complete. Your AI assistant is configured.'));
}
