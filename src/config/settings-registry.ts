/**
 * UAP Settings Registry — the single source of truth for every user-facing
 * setting UAP exposes.
 *
 * This one catalog powers three things so they can never drift:
 *   - `uap config` (list / get / set / explain / doctor)
 *   - the `uap setup --profile custom` expert wizard
 *   - the generated `docs/reference/CONFIGURATION_REFERENCE.md`
 *
 * Two kinds of setting:
 *   - kind 'json' — a field in `.uap.json` (persistent, first-class). `path` is
 *     the dotted location; `uap config set` writes it via modifyUapConfig.
 *   - kind 'env'  — an environment variable. `target: 'proxyEnv'` persists to
 *     `.uap/proxy.env` (loaded by the inference proxy); `target: 'shell'` is a
 *     runtime toggle read from the process env by hooks/CLI, so `set` prints the
 *     export line to add rather than pretending to persist it.
 *
 * Adding a setting here automatically surfaces it in the CLI, the wizard, and
 * the docs. Keep descriptions plain-language (what it does) and recommendations
 * actionable (what to pick and when).
 */

export type SettingKind = 'json' | 'env';
export type SettingType = 'boolean' | 'number' | 'string' | 'enum';
export type EnvTarget = 'proxyEnv' | 'shell';

export type SettingCategoryId =
  | 'delivery'
  | 'verification'
  | 'routing'
  | 'recipes'
  | 'memory'
  | 'concurrency'
  | 'collaboration'
  | 'orchestration'
  | 'reactor'
  | 'design'
  | 'principles'
  | 'worktree'
  | 'proxy'
  | 'dashboard'
  | 'optimization'
  | 'general';

export interface SettingCategory {
  id: SettingCategoryId;
  title: string;
  blurb: string;
}

export interface SettingDef {
  /** Canonical key: a dotted `.uap.json` path (json) or the env var name (env). */
  key: string;
  kind: SettingKind;
  type: SettingType;
  /** Allowed values when type is 'enum'. */
  enumValues?: readonly string[];
  /** For type 'number': require an integer. */
  int?: boolean;
  /** For type 'number': inclusive bounds (must match the schema's zod constraints). */
  min?: number;
  max?: number;
  /** Default value UAP assumes when the setting is absent. */
  default: string | number | boolean | null;
  category: SettingCategoryId;
  /** One or two plain sentences: what this controls. */
  description: string;
  /** Actionable guidance: what to pick and when. */
  recommendation: string;
  /** For kind 'env': where `set` persists it. */
  target?: EnvTarget;
  /** Holds a credential/token — never print the value, never write to .uap.json. */
  secret?: boolean;
}

export const CATEGORIES: readonly SettingCategory[] = [
  { id: 'delivery', title: 'Delivery & enforcement', blurb: 'Whether coding routes through `uap deliver` and how hard the gates block.' },
  { id: 'verification', title: 'Verification gates', blurb: 'Proving generated code actually builds and runs before "done".' },
  { id: 'routing', title: 'Model routing', blurb: 'Which model handles planning, execution, and review.' },
  { id: 'recipes', title: 'Serving recipes & escalation', blurb: 'Confidence/fusion recipes and the judge model that grades a local model.' },
  { id: 'memory', title: 'Memory', blurb: 'Short-term recall, long-term semantic memory, and pattern RAG.' },
  { id: 'concurrency', title: 'Concurrency & model slots', blurb: 'How many agents/inference slots run in parallel before backpressure.' },
  { id: 'collaboration', title: 'Multi-agent collaboration', blurb: 'The shared coordination board and file-overlap protection.' },
  { id: 'orchestration', title: 'Orchestrator & hands-free', blurb: 'Long-task autonomy: decompose, resume, and loop-to-100%.' },
  { id: 'reactor', title: 'Reactor (auto-apply)', blurb: 'Per-prompt injection of the matching experts, skills, and patterns.' },
  { id: 'design', title: 'Design system', blurb: 'DESIGN.md interrogation and the hard token gate for UI work.' },
  { id: 'principles', title: 'Engineering principles', blurb: 'How code should be written, and the backward-compatibility stance.' },
  { id: 'worktree', title: 'Worktree workflow', blurb: 'Branch-per-feature isolation and auto-cleanup.' },
  { id: 'proxy', title: 'Inference proxy tuning', blurb: 'Guardrails and context limits for a local model behind the proxy.' },
  { id: 'dashboard', title: 'Dashboard', blurb: 'The live analytics server and its mutation token.' },
  { id: 'optimization', title: 'Token & time optimization', blurb: 'Context budgets, caching, batching, and parallelism.' },
  { id: 'general', title: 'General', blurb: 'Project metadata and CLI behavior.' },
];

// A tuned local model with real gates is the reference environment for the
// recommendations below; cloud-model users can relax the guardrail-heavy knobs.
export const SETTINGS: readonly SettingDef[] = [
  // ── Delivery & enforcement ────────────────────────────────────────────────
  {
    key: 'delivery.enforcement', kind: 'json', type: 'enum', enumValues: ['block', 'advisory', 'off'],
    default: 'block', category: 'delivery',
    description: 'How the delivery gate treats a direct source edit outside `uap deliver`. `block` refuses it (exit 2), `advisory` warns but allows, `off` disables the gate. (The `UAP_ENFORCE_DELIVERY` env var overrides this at runtime.)',
    recommendation: '`block` for hands-free/local-model work so every change is gated and verified; `advisory` when a capable human/Opus is driving and you want warnings without friction.',
  },
  {
    key: 'delivery.localMode', kind: 'json', type: 'enum', enumValues: ['advisory', 'deliver', 'block'],
    default: 'advisory', category: 'delivery',
    description: 'How local-model sessions are routed through delivery. `deliver` runs builds through the convergence loop; `block` forbids raw edits; `advisory` warns.',
    recommendation: '`deliver` when a local model does the writing (routes it through the verified loop); `advisory` for exploratory work.',
  },
  {
    key: 'deliver.escalateModel', kind: 'json', type: 'string', default: null, category: 'delivery',
    description: 'Stronger model id for deliver escalation ladders: repair passes, the phase-5 escalation tier, and the evaluator fallback. Same role as $UAP_ESCALATE_MODEL but persisted in .uap.json (reproducible).',
    recommendation: 'Point at your strongest available preset/model (e.g. an Opus cloud id) when the executor is a local model — stuck epics then escalate instead of re-splitting into the same wall.',
  },
  {
    key: 'UAP_ENFORCE_DELIVERY', kind: 'env', type: 'enum', enumValues: ['block', 'advisory', 'off'],
    default: 'block', category: 'delivery', target: 'shell',
    description: 'Runtime override of the delivery gate read by the hooks/enforcers from the shell env. Takes precedence over `delivery.enforcement`.',
    recommendation: 'Leave UNSET so it defaults to `block`. Exporting `advisory` globally leaks into every shell and silently disables the gate + the delivery-enforcement tests — set it inline per-command if you must.',
  },
  {
    key: 'UAP_DELIVER_BYPASS', kind: 'env', type: 'boolean', default: false, category: 'delivery', target: 'shell',
    description: 'When set to 1 for a single command, exempts that one sanctioned manual edit from the delivery gate.',
    recommendation: 'Use inline (`UAP_DELIVER_BYPASS=1 <cmd>`) for a one-off edit; never export it.',
  },

  // ── Verification gates ────────────────────────────────────────────────────
  {
    key: 'delivery.runtimeVerify', kind: 'json', type: 'boolean', default: false, category: 'verification',
    description: 'Installs the runtime-verify Stop-hook: at end of turn it actually runs the changed code (headless / vm-dom / child-process) and blocks stopping on a genuine runtime failure.',
    recommendation: 'Enable for any project with a runnable artifact — it catches "declared done but never ran". Safe on empty projects (it skips when nothing is runnable).',
  },
  {
    key: 'delivery.userValidation', kind: 'json', type: 'string', default: 'block', category: 'verification',
    description: 'User-path validation gate: deliver runs the .uap/user-paths.json critical journeys through the real client (headless browser / HTTP / built CLI) as the terminal gate rung. block = DELIVERED requires them green; advisory = report only; off = disabled.',
    recommendation: 'Leave on block — it is the only gate that proves the artifact works for a real user, not just that tests pass.',
  },
  {
    key: 'UAP_USER_VALIDATION', kind: 'env', type: 'boolean', default: true, category: 'verification', target: 'shell',
    description: 'Runtime downgrade for the user-validation gate: `0` demotes block to advisory for this run only. Persisting `0` is blocked by the self-protect enforcer.',
    recommendation: 'Leave unset. Use inline `UAP_USER_VALIDATION=0 uap deliver ...` only to unblock a run where the gate itself misfires.',
  },
  {
    key: 'UAP_VERIFY_ON_STOP', kind: 'env', type: 'boolean', default: true, category: 'verification', target: 'shell',
    description: 'Master switch for the runtime execution gate in the Stop hook. `0` bypasses it.',
    recommendation: 'Leave on (default). Set `0` only to unblock a session where the runtime gate misfires.',
  },
  {
    key: 'fidelity.mode', kind: 'json', type: 'enum', enumValues: ['standard', 'max'],
    default: 'standard', category: 'verification',
    description: 'Maximum-fidelity mode. `max` flips every verification default to its strongest: raised verifier floor (runtime+integration), acceptance judge required, blocking vision review, and a fail-CLOSED visual gate — a delivery is accepted only when it builds, runs, looks right, and matches the spec. (`UAP_FIDELITY` overrides at runtime.)',
    recommendation: '`max` when correctness matters more than speed (UI work, releases, hands-free autonomy). `standard` for fast exploratory iteration.',
  },
  {
    key: 'UAP_FIDELITY', kind: 'env', type: 'enum', enumValues: ['standard', 'max'],
    default: 'standard', category: 'verification', target: 'shell',
    description: 'Runtime override of `fidelity.mode`, read from the shell env by verify/deliver and the Python enforcers. Takes precedence over the config value.',
    recommendation: 'Set inline (`UAP_FIDELITY=max <cmd>`) to force max fidelity for one command without editing config.',
  },
  {
    key: 'fidelity.visionMinScore', kind: 'json', type: 'number', min: 0, max: 10, default: 6, category: 'verification',
    description: 'Minimum aesthetic score (0–10) the vision judge must give a rendered UI before it passes under `max` fidelity.',
    recommendation: '6 is a reasonable "looks like a real, polished app" bar. Raise toward 8 for design-critical surfaces; lower to 4 to only catch broken/blank UIs.',
  },
  {
    key: 'fidelity.visualBaselines', kind: 'json', type: 'boolean', default: true, category: 'verification',
    description: 'Keep approved UI screenshots as regression baselines under `.uap/visual/baseline/` and block on visual drift beyond threshold on later runs.',
    recommendation: 'Leave on so accepted UIs are pinned against regressions. Disable for throwaway prototypes where every render legitimately differs.',
  },
  {
    key: 'UAP_VISION_ENDPOINT', kind: 'env', type: 'string', default: '', category: 'verification', target: 'proxyEnv',
    description: 'Base URL of an OpenAI-compatible, image_url-capable endpoint used for aesthetic screenshot review (e.g. http://127.0.0.1:8080/v1). Defaults to the local model when set by setup.',
    recommendation: 'Point at your local vision-capable model so aesthetic review runs offline with no per-image cost.',
  },
  {
    key: 'UAP_VISION_MODEL', kind: 'env', type: 'string', default: '', category: 'verification', target: 'proxyEnv',
    description: 'Model id sent to the vision endpoint for aesthetic review (e.g. qwen36-35b-a3b-iq4xs).',
    recommendation: 'Set by `uap setup` to your local vision model. Required for blocking vision review under `max` fidelity.',
  },

  // ── Model routing ─────────────────────────────────────────────────────────
  {
    key: 'multiModel.enabled', kind: 'json', type: 'boolean', default: false, category: 'routing',
    description: 'Turns on multi-model routing (distinct planner/executor/reviewer models) instead of a single model for everything.',
    recommendation: 'Enable to pair a cheap local executor with a strong cloud reviewer. Configure via `uap model routing use <preset>`.',
  },
  {
    key: 'multiModel.routingStrategy', kind: 'json', type: 'enum',
    enumValues: ['cost-optimized', 'performance-first', 'balanced', 'adaptive'],
    default: 'balanced', category: 'routing',
    description: 'How the router trades cost against capability when picking a model per task.',
    recommendation: '`cost-optimized` for local-first setups, `performance-first` for all-cloud hot paths, `balanced`/`adaptive` otherwise.',
  },
  {
    key: 'ANTHROPIC_PASSTHROUGH_MODELS', kind: 'env', type: 'string', default: '', category: 'routing', target: 'proxyEnv',
    description: 'Comma-separated model IDs the proxy forwards to Anthropic instead of serving locally. The sentinel `__local_only__` forces every model ID onto the local Qwen.',
    recommendation: 'Set automatically by `uap model routing use`. Use `__local_only__` for a fully offline setup; list cloud IDs for a hybrid local+cloud routing preset.',
  },

  // ── Serving recipes & escalation ──────────────────────────────────────────
  {
    key: 'recipes.enabled', kind: 'json', type: 'boolean', default: false, category: 'recipes',
    description: 'Enables serving-layer recipes (confidence escalation, fusion, ratings) in front of the local model.',
    recommendation: 'Enable for a local model when you have a stronger judge model available — it materially lifts output quality.',
  },
  {
    key: 'recipes.recipe', kind: 'json', type: 'enum',
    enumValues: ['auto', 'single', 'confidence', 'fusion', 'ratings', 'remom'],
    default: 'auto', category: 'recipes',
    description: 'Which recipe to apply. `confidence` escalates only low-confidence turns to the judge; `fusion` samples N and judges; `auto` picks per-signal.',
    recommendation: '`auto` is the safe default; `confidence` for the best cost/quality trade when the judge is expensive.',
  },
  {
    key: 'recipes.confidenceThreshold', kind: 'json', type: 'number', min: 0, max: 1, default: 0.5, category: 'recipes',
    description: 'Below this confidence, a turn is escalated to the judge model.',
    recommendation: '0.5 to start; raise toward 0.7 to escalate more often (higher quality, higher cost).',
  },
  {
    key: 'recipes.fusionN', kind: 'json', type: 'number', int: true, min: 2, max: 6, default: 3, category: 'recipes',
    description: 'How many candidate samples the fusion recipe generates before the judge picks/merges.',
    recommendation: '3 balances quality and cost; 5 for hard tasks if you can afford the samples.',
  },
  {
    key: 'recipes.allowSelfJudge', kind: 'json', type: 'boolean', default: false, category: 'recipes',
    description: 'Allows the generating model to also act as its own judge (generator == evaluator).',
    recommendation: 'Keep `false` — a distinct, stronger judge is what adds the lift. Only allow self-judge if no separate judge is available.',
  },
  {
    key: 'recipes.judge.model', kind: 'json', type: 'string', default: null, category: 'recipes',
    description: 'The model ID used to grade/escalate. Must be distinct from and stronger than the executor to help.',
    recommendation: 'Point at your strongest available model (e.g. an Opus/Sonnet cloud ID) even if the executor is local.',
  },
  {
    key: 'PROXY_ESCALATE_API_KEY', kind: 'env', type: 'string', default: null, category: 'recipes', target: 'proxyEnv', secret: true,
    description: 'API key for the judge/escalation model endpoint.',
    recommendation: 'Store only in `.uap/proxy.env` (chmod 600) — never in `.uap.json`. `uap config set` writes it there.',
  },

  // ── Memory ────────────────────────────────────────────────────────────────
  {
    key: 'memory.longTerm.enabled', kind: 'json', type: 'boolean', default: true, category: 'memory',
    description: 'Enables long-term semantic memory (vector recall across sessions) via Qdrant.',
    recommendation: 'Keep on — cross-session recall is a core value. Requires a running Qdrant (`uap memory start`).',
  },
  {
    key: 'memory.longTerm.provider', kind: 'json', type: 'enum',
    // `serverless` is NOT a provider: the serverless Qdrant manager is gated by
    // its own `memory.longTerm.serverless.enabled` key, so listing it here only
    // ever offered a selection that selected nothing. `chroma`/`pinecone` had no
    // backend at all.
    enumValues: ['qdrant', 'github', 'qdrant-cloud', 'none'],
    default: 'qdrant', category: 'memory',
    description: 'The long-term memory backend.',
    recommendation: '`qdrant` (local) for privacy/speed; `qdrant-cloud` or `github` if you want memory to follow you across machines.',
  },
  {
    key: 'memory.shortTerm.maxEntries', kind: 'json', type: 'number', default: 50, category: 'memory',
    description: 'How many recent short-term entries are retained/injected per session.',
    recommendation: '50 is a good default; raise for long, context-heavy sessions if token budget allows.',
  },
  {
    key: 'memory.patternRag.enabled', kind: 'json', type: 'boolean', default: false, category: 'memory',
    description: 'Enables pattern RAG — semantic retrieval of the 23 execution patterns to steer the agent.',
    recommendation: 'Enable for local models (patterns compensate for weaker planning); optional for frontier models.',
  },
  {
    key: 'QDRANT_URL', kind: 'env', type: 'string', default: 'http://localhost:6333', category: 'memory', target: 'shell',
    description: 'Qdrant endpoint for long-term/pattern memory.',
    recommendation: 'Leave default for local Qdrant; point at your cloud cluster URL for `qdrant-cloud`.',
  },
  {
    key: 'QDRANT_API_KEY', kind: 'env', type: 'string', default: null, category: 'memory', target: 'shell', secret: true,
    description: 'API key for a cloud Qdrant cluster.',
    recommendation: 'Only needed for `qdrant-cloud`. Keep it in your shell env / secret store, not in `.uap.json`.',
  },

  // ── Concurrency & model slots ─────────────────────────────────────────────
  {
    key: 'modelConcurrency.slots', kind: 'json', type: 'number', int: true, min: 1, default: null, category: 'concurrency',
    description: 'How many inference slots the local server exposes; the lease system caps parallel agents to this.',
    recommendation: 'Set to your llama.cpp `--parallel` value so fan-out never exhausts the server. Leave null to auto-probe.',
  },
  {
    key: 'modelConcurrency.headroom', kind: 'json', type: 'number', int: true, min: 0, default: null, category: 'concurrency',
    description: 'Slots to hold back from the budget so the interactive session never starves behind background agents.',
    recommendation: 'Reserve 1 on small servers so foreground work stays responsive.',
  },
  {
    key: 'modelConcurrency.adaptive', kind: 'json', type: 'boolean', default: true, category: 'concurrency',
    description: 'AIMD backpressure: shrinks the effective slot budget on exhaustion signals (429/timeouts) and recovers over time.',
    recommendation: 'Keep on — it prevents overload cascades when many agents run at once.',
  },
  {
    key: 'UAP_MAX_PARALLEL', kind: 'env', type: 'number', default: 4, category: 'concurrency', target: 'shell',
    description: 'Upper bound on parallel agent/tool fan-out regardless of slot budget.',
    recommendation: 'Match to CPU/GPU capacity; 4 is a safe default, lower it on constrained hosts.',
  },

  // ── Multi-agent collaboration ─────────────────────────────────────────────
  {
    key: 'collaboration.mode', kind: 'json', type: 'enum', enumValues: ['auto', 'always', 'off'],
    default: 'auto', category: 'collaboration',
    description: 'The shared coordination board + live file-overlap protection. `always` injects the board every turn; `auto` only when peers are active; `off` disables it.',
    recommendation: '`auto` for solo work, `always` when multiple agents/worktrees run concurrently so they compound instead of colliding.',
  },
  {
    key: 'coordination.deployBatching', kind: 'json', type: 'boolean', default: true, category: 'collaboration',
    description: 'Batches git/deploy actions across agents to avoid conflicting concurrent pushes.',
    recommendation: 'Keep on for multi-agent setups.',
  },

  // ── Orchestrator & hands-free ─────────────────────────────────────────────
  {
    key: 'handsfree.enabled', kind: 'json', type: 'boolean', default: false, category: 'orchestration',
    description: 'Forces any model to keep working until a multi-epic completion ledger is 100% done, instead of stopping early.',
    recommendation: 'Enable for large autonomous builds; leave off for interactive/exploratory sessions.',
  },
  {
    key: 'handsfree.intensity', kind: 'json', type: 'enum', enumValues: ['gentle', 'normal', 'aggressive'],
    default: 'normal', category: 'orchestration',
    description: 'How hard hands-free pushes back against early stops before the ledger is complete.',
    recommendation: '`normal` for most work; `aggressive` for unattended overnight runs; `gentle` if the model over-persists on dead ends.',
  },
  {
    key: 'UAP_HANDSFREE_STAGNATION_LIMIT', kind: 'env', type: 'number', default: 8, category: 'orchestration', target: 'shell',
    description: 'Consecutive no-progress turns before hands-free breaks the loop instead of pushing on.',
    recommendation: 'Lower (e.g. 5) if runs waste turns stuck; raise for genuinely long-horizon tasks.',
  },

  // ── Reactor ───────────────────────────────────────────────────────────────
  {
    key: 'reactor.enabled', kind: 'json', type: 'boolean', default: true, category: 'reactor',
    description: 'Per-prompt injection of the experts, skills, and patterns that match what you just asked — so relevant capability is on the bench before the agent starts.',
    recommendation: 'Keep on. Disable only to debug prompt bloat or measure the reactor\'s own contribution.',
  },

  // ── Design system ─────────────────────────────────────────────────────────
  {
    key: 'design.enabled', kind: 'json', type: 'boolean', default: false, category: 'design',
    description: 'Turns on DESIGN.md: the agent interrogates and lints UI work against your design brief.',
    recommendation: 'Enable for any project with a UI so design work starts from intent, not a guess.',
  },
  {
    key: 'design.tokenGate', kind: 'json', type: 'boolean', default: false, category: 'design',
    description: 'Hard-blocks UI edits that hardcode off-token colors or off-scale spacing.',
    recommendation: 'Enable once your DESIGN.md tokens are stable — it keeps the UI on-system automatically.',
  },

  // ── Engineering principles ────────────────────────────────────────────────
  {
    key: 'principles.enabled', kind: 'json', type: 'boolean', default: true, category: 'principles',
    description: 'Applies the engineering principles (simplest sufficient implementation, reuse over reinvention, no stopgaps, prior art first) to generated code.',
    recommendation: 'Leave on. Turn it off only if your project has its own conflicting house style.',
  },
  {
    key: 'principles.compat', kind: 'json', type: 'enum', enumValues: ['ask', 'preserve', 'remove'],
    default: 'ask', category: 'principles',
    description: 'Backward-compatibility stance. `remove` deletes obsolete paths outright; `preserve` keeps them working and migrates callers; `ask` (default) prompts once per session instead of guessing.',
    recommendation: "Leave on `ask` unless the project's answer is settled. `remove` is for side projects — on anything published it tells the agent to delete migration paths.",
  },
  {
    key: 'principles.maturity', kind: 'json', type: 'enum', enumValues: ['ask', 'greenfield', 'production'],
    default: 'ask', category: 'principles',
    description: 'What breaking a caller costs. `production` adds caveats about existing callers and dependency cost; `greenfield` states the rules absolutely.',
    recommendation: 'Set `production` for anything with real users; `greenfield` for a fresh side project.',
  },
  {
    key: 'principles.injectDeliver', kind: 'json', type: 'boolean', default: true, category: 'principles',
    description: 'Injects the compact principles block into deliver prompts, so generated code follows them rather than only the agent preamble.',
    recommendation: 'Leave on. Disable only if you are tight on prompt budget with a small-context model.',
  },

  // ── Worktree workflow ─────────────────────────────────────────────────────
  {
    key: 'worktrees.enabled', kind: 'json', type: 'boolean', default: true, category: 'worktree',
    description: 'Branch-per-feature isolation: edits happen in `.worktrees/NNN-slug/`, never the working tree, with auto-PR.',
    recommendation: 'Keep on for any team or multi-agent workflow; it is the safety net against clobbering `main`.',
  },
  {
    key: 'worktrees.branchPrefix', kind: 'json', type: 'string', default: 'feature/', category: 'worktree',
    description: 'Prefix for auto-created worktree branches.',
    recommendation: 'Match your team\'s branch convention (e.g. `feat/`, `fix/`).',
  },
  {
    key: 'worktrees.autoCleanup', kind: 'json', type: 'boolean', default: true, category: 'worktree',
    description: 'Removes a worktree automatically once its branch is merged/unchanged.',
    recommendation: 'Keep on to avoid a pile of stale worktrees.',
  },

  // ── Inference proxy tuning (curated high-impact subset) ────────────────────
  {
    key: 'PROXY_CONTEXT_WINDOW', kind: 'env', type: 'number', default: 65536, category: 'proxy', target: 'proxyEnv',
    description: 'The context window the proxy advertises/enforces for the local model. Must match the server\'s KV allocation.',
    recommendation: 'Set to your llama.cpp per-slot context size. Too high overflows KV; too low truncates history.',
  },
  {
    key: 'PROXY_CONCURRENCY_LIMIT', kind: 'env', type: 'number', default: null, category: 'proxy', target: 'proxyEnv',
    description: 'Max concurrent upstream generations the proxy admits before queuing.',
    recommendation: 'Match to the server\'s parallel slots so the proxy queues instead of overloading the model.',
  },
  {
    key: 'PROXY_LOOP_BREAKER', kind: 'env', type: 'boolean', default: true, category: 'proxy', target: 'proxyEnv',
    description: 'Breaks no-progress generation loops by forcing a single non-streaming call.',
    recommendation: 'Keep on for local models — it is a core reliability guardrail.',
  },
  {
    key: 'PROXY_STUCK_BREAK', kind: 'env', type: 'boolean', default: true, category: 'proxy', target: 'proxyEnv',
    description: 'When the model self-reports "stuck" but keeps repeating the same failing tool, releases it to a prose exit.',
    recommendation: 'Keep on for local models; harmless for cloud models (rarely triggers).',
  },
  {
    key: 'PROXY_RECON_CONVERGENCE_THRESHOLD', kind: 'env', type: 'number', default: 40, category: 'proxy', target: 'proxyEnv',
    description: 'After this many read-only (no-write) turns, the proxy forces synthesis/`deliver` so the model stops exploring forever.',
    recommendation: '40 is balanced; lower it (e.g. 20) if local sessions over-explore before writing.',
  },
  {
    key: 'PROXY_RECIPE', kind: 'env', type: 'enum', enumValues: ['auto', 'single', 'confidence', 'fusion', 'ratings', 'remom'],
    default: 'auto', category: 'proxy', target: 'proxyEnv',
    description: 'The serving recipe the proxy applies (mirror of `recipes.recipe`, consumed by the proxy process).',
    recommendation: 'Keep in sync with `recipes.recipe`; `uap setup`/`uap config` write both.',
  },
  {
    key: 'realtimeAdapt.enabled', kind: 'json', type: 'boolean', default: true, category: 'proxy',
    description: 'Real-time flag adaptation (LLM Self-Tuning P4): the reactor emits per-session adjustments from live signals (tool-failure/quality/context/RECON) so the proxy can escalate or converge mid-session. This is the effective master switch — off means no signal is emitted.',
    recommendation: 'Leave on. It is conservative (emits only when a live signal breaches a threshold) and is the effective master switch — disabling it turns the whole feature off regardless of the proxy side.',
  },
  {
    key: 'PROXY_REALTIME_ADAPT', kind: 'env', type: 'boolean', default: true, category: 'proxy', target: 'proxyEnv',
    description: 'Proxy side of real-time adaptation: whether the serving proxy honors a fresh adaptation signal per request. Auto-on; harmless when no emitter is running (no signal to honor).',
    recommendation: 'Leave on. Set `false` only to make the proxy ignore adaptation signals even when the reactor emits them.',
  },

  // ── Dashboard ─────────────────────────────────────────────────────────────
  {
    key: 'UAP_DASHBOARD_TOKEN', kind: 'env', type: 'string', default: null, category: 'dashboard', target: 'shell', secret: true,
    description: 'The token required for dashboard policy-mutation routes (enable/disable/stage/level). Read routes stay open.',
    recommendation: 'Set a strong token if the dashboard binds beyond localhost (`--host 0.0.0.0`); otherwise a generated per-session token is used.',
  },
  {
    key: 'UAP_DASH_REFRESH_MS', kind: 'env', type: 'number', default: 2000, category: 'dashboard', target: 'shell',
    description: 'Dashboard data refresh interval in milliseconds (floor 250).',
    recommendation: '2000 is fine; lower for a more live feel at higher CPU cost.',
  },
  {
    key: 'proxy.dashboard', kind: 'json', type: 'boolean', default: true, category: 'dashboard',
    description: 'Ride-along dashboard: `uap proxy ensure|start` also starts (or adopts) `uap dashboard serve`, and release/stop tears it down under the same ownership rules — so a session gets monitoring without running a second command. Only takes effect where the proxy itself runs (hooks gate on proxy.autostart).',
    recommendation: 'Leave on. Turn off if you prefer to run `uap dash serve` yourself, or the port is spoken for.',
  },
  {
    key: 'UAP_PROXY_DASHBOARD', kind: 'env', type: 'boolean', default: true, category: 'dashboard', target: 'shell',
    description: 'Force the ride-along dashboard on (1/on/true) or off (0/off/false). Wins over .uap.json proxy.dashboard.',
    recommendation: 'Use for one-off overrides; prefer `uap proxy dashboard on|off` for a durable project setting.',
  },
  {
    key: 'UAP_DASH_PORT', kind: 'env', type: 'number', default: 3847, category: 'dashboard', target: 'shell',
    description: 'Port the ride-along dashboard binds and is probed on (1-65535). Does not change `uap dash serve --port`.',
    recommendation: 'Change only on a port clash; keep it consistent across sessions so adoption works.',
  },
  {
    key: 'UAP_DASH_HOST', kind: 'env', type: 'string', default: 'localhost', category: 'dashboard', target: 'shell',
    description: 'Interface the ride-along dashboard binds. `0.0.0.0` exposes it beyond this machine.',
    recommendation: 'Keep localhost. Bind wider only behind a trusted network, and set UAP_DASHBOARD_TOKEN when you do.',
  },
  {
    key: 'UAP_DASH_HEALTH_WAIT_MS', kind: 'env', type: 'number', default: 10000, category: 'dashboard', target: 'shell',
    description: 'How long `uap proxy ensure` waits for the ride-along dashboard to serve before giving up.',
    recommendation: 'Lower it if session start feels slow on a cold dashboard; the proxy is unaffected either way.',
  },

  // ── Token & time optimization ─────────────────────────────────────────────
  {
    key: 'costOptimization.enabled', kind: 'json', type: 'boolean', default: true, category: 'optimization',
    description: 'Enables token budgets, response caching, and embedding batching to cut token spend.',
    recommendation: 'Keep on — it is free savings with no quality cost.',
  },
  {
    key: 'timeOptimization.parallelExecution.maxParallelDroids', kind: 'json', type: 'number', default: 4, category: 'optimization',
    description: 'Max expert droids run in parallel during a task.',
    recommendation: 'Match to host capacity; 4 is a safe default.',
  },

  // ── General ───────────────────────────────────────────────────────────────
  {
    key: 'project.defaultBranch', kind: 'json', type: 'string', default: 'main', category: 'general',
    description: 'The branch PRs target and worktrees branch from.',
    recommendation: 'Set to your repo\'s default branch (`main` or `master`).',
  },
  {
    key: 'UAP_NO_SELF_UPDATE', kind: 'env', type: 'boolean', default: false, category: 'general', target: 'shell',
    description: 'Disables the automatic global-CLI version check/self-update on `uap setup`.',
    recommendation: 'Set in CI or pinned environments where you manage the UAP version yourself.',
  },
];

// ── Lookup helpers ──────────────────────────────────────────────────────────

const BY_KEY = new Map(SETTINGS.map((s) => [s.key.toLowerCase(), s]));

/** Case-insensitive exact lookup by key. */
export function getSetting(key: string): SettingDef | undefined {
  return BY_KEY.get(key.toLowerCase());
}

/** All settings in a category, in registry order. */
export function settingsByCategory(id: SettingCategoryId): SettingDef[] {
  return SETTINGS.filter((s) => s.category === id);
}

/** Fuzzy match for `config get/set/explain` when the key isn't exact. */
export function findSettings(query: string): SettingDef[] {
  const q = query.toLowerCase();
  return SETTINGS.filter((s) => s.key.toLowerCase().includes(q));
}

/** The category metadata for an id. */
export function category(id: SettingCategoryId): SettingCategory | undefined {
  return CATEGORIES.find((c) => c.id === id);
}
