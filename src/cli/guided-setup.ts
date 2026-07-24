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
import { profileForRouting, profileForProvider } from '../models/profile-map.js';
import { createClackUI, type PromptUI } from './prompt-ui.js';
import {
  applyWizardConfig,
  maxSelections,
  minSelections,
  defaultSelections,
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

export function dockerAvailable(): boolean {
  try {
    return spawnSync('docker', ['--version'], { timeout: 4000, stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

/** Probe a couple of conventional local OpenAI-compatible endpoints. */
export async function detectLocalModel(): Promise<string | null> {
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

  // ── Setup profile ───────────────────────────────────────────────────
  // An explicit --profile skips the prompt (also drives non-interactive runs).
  const profile: 'recommended' | 'maximum' | 'minimal' | 'custom' = options.profile
    ? (options.profile as 'recommended' | 'maximum' | 'minimal' | 'custom')
    : await ui.select<'recommended' | 'maximum' | 'minimal' | 'custom'>({
        message: 'Setup profile:',
        options: [
          { label: 'Recommended - smart defaults, customize each option', value: 'recommended' },
          { label: 'Maximum - every feature on for peak performance (routing, gates, recipes, handsfree, proxy autostart)', value: 'maximum' },
          { label: 'Minimal - core only (short-term memory, coordination, patterns)', value: 'minimal' },
          { label: 'Custom - baseline, then tune EVERY setting yourself + pick policies (expert)', value: 'custom' },
        ],
        initialValue: 'recommended',
      });

  // Custom: lay down a minimal working baseline, then hand off to the expert
  // configurator that exposes every setting + scenario-based policy selection.
  if (profile === 'custom') {
    const ctx = { platforms: platform, localModel, hasDocker };
    ui.note('Custom profile: a working baseline, then tune every setting yourself.', 'Profile');
    await finalizeGuidedSetup(cwd, ui, options, minSelections(ctx));
    const { runConfigWizard } = await import('./config-wizard.js');
    await runConfigWizard(cwd, {});
    return;
  }

  if (profile !== 'recommended') {
    const ctx = { platforms: platform, localModel, hasDocker };
    const presetSelections = profile === 'maximum' ? maxSelections(ctx) : minSelections(ctx);
    ui.note(
      profile === 'maximum'
        ? 'Maximum profile: all features enabled at their most capable settings' +
            (hasDocker ? '' : ' (Qdrant tiers skipped - Docker not detected)') +
            (localModel ? '' : ' (routing left on single-model - no local endpoint)') +
            '.'
        : 'Minimal profile: core essentials only.',
      'Profile'
    );
    await finalizeGuidedSetup(cwd, ui, options, presetSelections);
    return;
  }

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
        { label: 'pay2u policy pack (advisory architecture/reference example)', value: 'pay2uPolicies' },
      ],
      initialValues: ['iacStateParity', 'iacPipelineEnforcement', 'kubectlVerifyBackport', 'definitionOfDoneIac'],
      required: false,
    });
  }
  // Per-policy picker over the real policy universe (the same list `uap policy
  // select` uses). Opt-in so the wizard stays short; REQUIRED policies always on.
  let selectedPolicies: string[] | undefined;
  if (policyEngine) {
    const { listPolicyChoices } = await import('./policy-select.js');
    const choices = await listPolicyChoices();
    const customize = await ui.confirm({
      message: `Customize which of the ${choices.length} policies to enforce? (default: ALL, each with its level)`,
      initialValue: false,
    });
    if (customize) {
      selectedPolicies = await ui.multiselect<string>({
        message: 'Policies to enforce (space toggles, enter confirms; REQUIRED stay on):',
        options: choices.map((c) => ({
          value: c.name,
          label: `${c.name}${c.protected ? ' (required)' : ''}`,
          hint: `${c.category} · ${c.level}${c.description ? ` — ${c.description}` : ''}`,
        })),
        // Default ALL policies checked (each installs with its schema level); the
        // pay2u example pack stays unchecked unless the user opts in.
        initialValues: choices.filter((c) => !c.name.startsWith('pay2u')).map((c) => c.name),
        required: false,
      });
    }
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
  const modelExtras = await ui.multiselect<string>({
    message: 'Model extras:',
    options: [
      { label: 'Cost tracking', value: 'costTracking' },
      { label: 'Model routing (multi-model)', value: 'modelRouting' },
    ],
    // Auto-activate routing when a local model is present: the local-first
    // presets keep execution free/local and send only plan/review to the cloud,
    // so routing is the sensible default exactly when a local endpoint exists.
    initialValues: localModel ? ['modelRouting'] : [],
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
      // With a local model detected, default to the local-first preset so setup
      // auto-activates a sensible routing table (free local execution, Fable
      // planning, Opus review) instead of leaving routing on 'none'.
      initialValue: localModel ? 'fable-local-opus' : 'none',
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

  // Derive the effective tool-call profile automatically. It AUTO-SWITCHES to
  // match the routed executor model (or the provider default for single-model
  // setups). Nothing is pinned to .uap.json, so changing the routing later
  // re-derives it at runtime (see src/models/profile-map.ts + tool-calls.ts).
  const effectiveProfile =
    routingPreset !== 'none'
      ? profileForRouting({ enabled: true, roles: RoutingPresets[routingPreset]?.roles }) ??
        profileForProvider(provider)
      : profileForProvider(provider);

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

  // ── Maximum fidelity ────────────────────────────────────────────────
  // Default ON: correctness + visual correctness are the point. `max` raises
  // every verification gate and turns on always-on visual/vision review + the
  // commit-time visual enforcer. Users can drop to `standard` for fast
  // exploratory iteration.
  const maxFidelity = await ui.confirm({
    message:
      'Maximum fidelity — raise all verification gates and visually verify every UI (render + aesthetic review + regression baselines + commit gate)?',
    initialValue: true,
  });

  // ── Proxy autostart ─────────────────────────────────────────────────
  const proxyAutostart = await ui.confirm({
    message:
      'Auto-start the local proxy with your agent session? (reference-counted: reuses an existing proxy, stops only when the last agent leaves)',
    initialValue: Boolean(localModel),
  });

  // ── Ride-along dashboard ────────────────────────────────────────────
  // Only worth asking when the proxy actually autostarts: the hooks pass
  // `--if-enabled`, so with autostart off nothing rides along either way.
  const proxyDashboard = proxyAutostart
    ? await ui.confirm({
        message:
          'Start the operational dashboard with the proxy? (http://localhost:3847 — monitor UAP without running `uap dash serve` yourself)',
        initialValue: true,
      })
    : undefined;

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
      pay2uPolicies: pol.includes('pay2uPolicies'),
      ...(selectedPolicies ? { selectedPolicies } : {}),
    },
    model: {
      provider,
      qwenOptimizations: effectiveProfile.startsWith('qwen'),
      // Left empty on purpose: the runtime auto-switches the profile from the
      // active routing/provider (see profile-map.ts). Pinning here would defeat
      // that. applyWizardConfig only persists toolCalls.modelProfile when set.
      toolCallProfile: '',
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
    proxy: { autostart: proxyAutostart, dashboard: proxyDashboard },
    fidelity: { mode: maxFidelity ? 'max' : 'standard' },
  });

  await finalizeGuidedSetup(cwd, ui, options, selections);
}

export async function finalizeGuidedSetup(
  cwd: string,
  ui: PromptUI,
  options: SetupOptions,
  selections: WizardSelections
): Promise<void> {
  // Display/notes scalars + the effective tool-call profile are ALL derived from
  // `selections` so this runs identically for the detailed (recommended) flow,
  // the interactive preset flow, and the non-interactive `--profile` path.
  const routingId = selections.model.routingPreset;
  const effectiveProfile =
    routingId && routingId !== 'none'
      ? profileForRouting({ enabled: true, roles: RoutingPresets[routingId]?.roles }) ??
        profileForProvider(selections.model.provider)
      : profileForProvider(selections.model.provider);
  const platform = selections.platforms;
  const provider = selections.model.provider;
  const longTerm = selections.memory.longTermMemory;
  const recipesOn = selections.recipes.enabled;
  const recipeMode = selections.recipes.recipe;
  const deliverEnforcement = selections.delivery.enforcement;
  const judgeModel = selections.recipes.judgeModel;
  const allowSelfJudge = selections.recipes.allowSelfJudge;
  const cloakBrowser = selections.browser.cloakBrowser;
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
    message:
      `Apply setup for [${platform.join(', ')}] · provider=${provider}/${effectiveProfile} · ` +
      `long-term mem=${longTerm ? 'on' : 'off'} · patterns=${withPatterns ? 'on' : 'off'} · ` +
      `recipes=${recipesOn ? recipeMode : 'off'} · deliver=${deliverEnforcement} · ` +
      `handsfree=${selections.handsfree.enabled ? (selections.handsfree.intensity ?? 'on') : 'off'} · ` +
      `proxy-autostart=${selections.proxy.autostart ? 'on' : 'off'} · ` +
      (selections.proxy.dashboard === undefined
        ? ''
        : `proxy-dashboard=${selections.proxy.dashboard ? 'on' : 'off'} · `) +
      `auto-approve-tools=${selections.hooks.autoApproveTools ? 'ON' : 'off'} · ` +
      `cloakbrowser=${cloakBrowser ? 'on' : 'off'}?`,
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

  // Apply the per-policy selection. By DEFAULT every setup installs ALL policies
  // with their schema-declared level (REQUIRED/RECOMMENDED/OPTIONAL) — the pay2u
  // example pack stays opt-in behind its own flag. 'all'/'recommended' resolve to
  // concrete names; an explicit list is applied verbatim. Skipped only when the
  // policy engine is off.
  if (selections.policy.policyEngine) {
    try {
      const { listPolicyChoices, applyPolicySelection, recommendedSelection, defaultSetupPolicies } = await import('./policy-select.js');
      const choices = await listPolicyChoices();
      const sel = selections.policy.selectedPolicies ?? 'all';
      let names: string[];
      if (sel === 'all') names = defaultSetupPolicies(choices, selections.policy.pay2uPolicies);
      else if (sel === 'recommended') names = recommendedSelection(choices);
      else names = sel;
      const r = await applyPolicySelection(names);
      const n = r.installed.length + r.enabled.length;
      if (n > 0) ui.note(`Enforcing ${n} selected polic${n === 1 ? 'y' : 'ies'}${r.disabled.length ? `, disabled ${r.disabled.length}` : ''}.`, 'Policies');
    } catch {
      /* policy selection is best-effort — never block setup on it */
    }
  }

  // Install the pay2u example policy pack when selected in the policy matrix
  // (advisory, no enforcer). Idempotent + fail-soft — never blocks setup.
  if (selections.policy.policyEngine && selections.policy.pay2uPolicies) {
    try {
      const { ensurePay2uPolicies } = await import('./deliver-defaults.js');
      const results = await ensurePay2uPolicies();
      const n = results.filter((r) => r.enabled).length;
      ui.note(`Installed the pay2u policy pack (${n} policies) — see \`uap policy matrix\`.`, 'Policy');
    } catch {
      /* pack install is best-effort */
    }
  }

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
  if (effectiveProfile && effectiveProfile !== 'generic') {
    try {
      const { toolCallsCommand } = await import('./tool-calls.js');
      // Pass the derived profile: applies profile-specific tool-call fixes
      // WITHOUT re-prompting or pinning (preserves runtime auto-switch).
      await toolCallsCommand('setup', { profile: effectiveProfile });
    } catch {
      ui.note('Run `uap-tool-calls setup` to apply profile-specific tool-call fixes.', 'Next step');
    }
  }
  if (cloakBrowser) {
    ui.note('Run `npm run install:cloakbrowser` to finish CloakBrowser setup.', 'Next step');
  }

  ui.outro(chalk.green('✅ Setup complete. Your AI assistant is configured.'));
}
