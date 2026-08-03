/**
 * Policy recommendations — a curated map from "what kind of work is this?" to
 * the built-in policies worth enabling, with a one-line rationale each.
 *
 * Shared by `uap policy recommend`, the `uap config wizard` policy step, and the
 * generated docs/guides/POLICY_SELECTION.md, so the guidance stays consistent.
 *
 * Slugs match the built-in catalog under src/policies/schemas/policies/*.md
 * (installed via `uap policy install <slug>`, which also attaches the Python
 * enforcer at src/policies/enforcers/<slug>.py when one exists).
 */

export interface PolicyRec {
  slug: string;
  why: string;
}

export interface Scenario {
  id: string;
  title: string;
  blurb: string;
  /** Policies to add ON TOP of the always-recommended core set. */
  extra: PolicyRec[];
}

/** Recommended for every project — the safety floor. */
export const CORE: readonly PolicyRec[] = [
  { slug: 'worktree-required', why: 'edits land in an isolated worktree, never the working tree' },
  { slug: 'delivery-enforcement', why: 'source changes route through the verified deliver loop' },
  { slug: 'enforcement-self-protect', why: 'agents cannot disable the gates that constrain them' },
  { slug: 'task-required', why: 'work is tied to a tracked task, not ad-hoc' },
  { slug: 'test-gate', why: 'changed code must pass tests before "done"' },
  { slug: 'memory-before-plan', why: 'the agent recalls prior decisions before re-deriving them' },
  { slug: 'workdir-scope', why: 'writes are contained to the project directory' },
];

export const SCENARIOS: readonly Scenario[] = [
  {
    id: 'solo-local',
    title: 'Solo dev, local model',
    blurb: 'One person driving a local (llama.cpp/Qwen) model that needs strong guardrails.',
    extra: [
      { slug: 'codebase-read-before-plan', why: 'weaker models must read before proposing' },
      { slug: 'validate-plan-on-change', why: 'catch a bad plan before it writes code' },
      { slug: 'mcp-router-first', why: 'keeps the context window lean for a small model' },
      { slug: 'local-build-before-push', why: 'never push code that fails to build locally' },
      { slug: 'ship-loop-gate', why: 'converge to green before shipping' },
      { slug: 'doc-live-over-report', why: "trust the live system, not the agent's self-report" },
      {
        slug: 'engineering-principles',
        why: 'a small model reaches for reinvention and stopgaps unless told not to',
      },
    ],
  },
  {
    id: 'team',
    title: 'Team / multi-agent',
    blurb: 'Multiple people or agents working the same repo concurrently.',
    extra: [
      { slug: 'coord-overlap', why: 'blocks two agents editing the same file at once' },
      {
        slug: 'branch-freshness',
        why: 'stops a stale branch silently reverting work that already landed',
      },
      { slug: 'expert-review-required', why: 'non-trivial changes get a review pass' },
      { slug: 'schema-diff-gate', why: 'surfaces API/schema contract changes for review' },
      { slug: 'session-memory-write', why: 'learnings are captured so peers compound them' },
      { slug: 'artifact-hygiene', why: 'no stray build artifacts / debug code in commits' },
    ],
  },
  {
    id: 'ci-gated',
    title: 'CI-gated delivery',
    blurb: 'Changes must survive a CI pipeline and controlled deploys.',
    extra: [
      { slug: 'local-build-before-push', why: 'fail fast locally before burning CI minutes' },
      { slug: 'ship-loop-gate', why: 'PRs re-converge on red CI' },
      { slug: 'merge-deploy-monitor-verify', why: 'deploys are monitored and verified, not fire-and-forget' },
      { slug: 'schema-diff-gate', why: 'contract changes are flagged before merge' },
    ],
  },
  {
    id: 'high-autonomy',
    title: 'High autonomy / hands-free',
    blurb: 'Long unattended builds where the model must not cut corners.',
    extra: [
      { slug: 'validate-plan-on-change', why: 'a wrong plan wastes an entire autonomous run' },
      { slug: 'ship-loop-gate', why: 'the run only ends when the work is genuinely done' },
      { slug: 'artifact-hygiene', why: 'unattended runs must not leave debris' },
      { slug: 'doc-live-over-report', why: "grade the real system, not the model's optimism" },
      { slug: 'codebase-read-before-plan', why: 'read the code before acting on it, every time' },
    ],
  },
  {
    id: 'security',
    title: 'Security-sensitive',
    blurb: 'Handling secrets, infrastructure, or regulated code.',
    extra: [
      { slug: 'bearer-lockdown', why: 'blocks leaking bearer tokens / credentials' },
      { slug: 'schema-diff-gate', why: 'no silent API/permission surface changes' },
      { slug: 'iac-parity', why: 'infra changes stay in sync with declared IaC' },
      { slug: 'iac-plan-destruction-check', why: 'flags destructive infra plans before apply' },
    ],
  },
  {
    id: 'ui',
    title: 'UI / design work',
    blurb: 'Projects with a front-end and a design system.',
    extra: [
      { slug: 'design-token-gate', why: 'UI edits stay on your design tokens/spacing' },
      { slug: 'visual-verification', why: 'UI changes are verified visually, not just by tests' },
    ],
  },
  {
    id: 'greenfield',
    title: 'Greenfield / side project',
    blurb: 'Nothing depends on it yet — optimise for simplicity over compatibility.',
    extra: [
      {
        slug: 'engineering-principles',
        why: 'simplest-thing-that-works, reuse over reinvention, no stopgaps',
      },
      { slug: 'codebase-read-before-plan', why: 'read what exists before adding to it' },
      { slug: 'test-gate', why: 'the smallest end-to-end version still has to pass' },
    ],
  },
];

export function getScenario(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}

/** Core + a scenario's extras, de-duplicated by slug (core wins the rationale). */
export function recommendedFor(scenarioId: string): PolicyRec[] {
  const scenario = getScenario(scenarioId);
  const seen = new Set<string>();
  const out: PolicyRec[] = [];
  for (const rec of [...CORE, ...(scenario?.extra ?? [])]) {
    if (seen.has(rec.slug)) continue;
    seen.add(rec.slug);
    out.push(rec);
  }
  return out;
}
