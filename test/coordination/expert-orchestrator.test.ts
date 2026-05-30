/**
 * Expert Orchestrator Tests
 *
 * Verifies that the orchestrator composes a coherent droid chain across the
 * canonical SDLC phases for various task shapes, and that adaptive-metrics
 * lookup is plumbed through.
 */

import { describe, it, expect } from 'vitest';
import { ExpertOrchestrator, planFromDescription } from '../../src/coordination/expert-orchestrator.js';

describe('ExpertOrchestrator', () => {
  it('produces an ordered chain through all relevant phases', () => {
    const plan = planFromDescription('Refactor src/policies/policy-gate.ts for clarity', undefined, [
      'src/policies/policy-gate.ts',
    ]);
    expect(plan.steps.length).toBeGreaterThan(0);

    // Phases must appear in canonical order in the emitted steps.
    const order = ['plan', 'design', 'implement', 'review', 'release'];
    let lastIdx = -1;
    for (const step of plan.steps) {
      const idx = order.indexOf(step.phase);
      expect(idx).toBeGreaterThanOrEqual(lastIdx);
      lastIdx = idx;
    }
  });

  it('fans out review experts when task touches security and performance', () => {
    const plan = planFromDescription(
      'Performance and security review of auth endpoint',
      undefined,
      ['src/auth/login.ts', 'src/perf/benchmark-auth.ts']
    );
    const reviewDroids = plan.steps.filter((s) => s.phase === 'review').map((s) => s.droid);
    expect(reviewDroids).toContain('security-code-reviewer');
    expect(reviewDroids).toContain('performance-reviewer');
    expect(reviewDroids).toContain('code-quality-reviewer');
    // All review-phase steps are parallel-safe
    for (const s of plan.steps.filter((x) => x.phase === 'review')) {
      expect(s.parallel).toBe(true);
    }
  });

  it('always includes the release-manager at the end', () => {
    const plan = planFromDescription('Add a comment to README.md', undefined, ['README.md']);
    const last = plan.steps[plan.steps.length - 1];
    expect(last.phase).toBe('release');
    expect(last.droid).toBe('release-manager');
  });

  it('threads adaptive success rates through every step', () => {
    const orch = new ExpertOrchestrator({
      successRateFor: (droid) => (droid === 'security-code-reviewer' ? 0.82 : null),
    });
    const plan = orch.plan(
      {
        id: 't1',
        title: 'security audit',
        description: 'Audit auth code for OWASP issues',
        type: 'task',
        status: 'open',
        priority: 2,
        labels: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      ['src/auth/x.ts']
    );
    const sec = plan.steps.find((s) => s.droid === 'security-code-reviewer');
    expect(sec?.successRate).toBe(0.82);
    const release = plan.steps.find((s) => s.droid === 'release-manager');
    expect(release?.successRate).toBeNull();
  });

  it('does not include api-designer when no API surface is matched', () => {
    const plan = planFromDescription('Tidy whitespace in tests', undefined, [
      'test/cli/init.test.ts',
    ]);
    const droids = plan.steps.map((s) => s.droid);
    expect(droids).not.toContain('api-designer');
  });

  it('layers forward-design experts when the task touches an architecture surface', () => {
    const plan = planFromDescription('Design the billing subsystem types', undefined, [
      'src/types/billing.ts',
    ]);
    const byPhase = (phase: string) =>
      plan.steps.filter((s) => s.phase === phase).map((s) => s.droid);

    // strategic-architect sets direction in the plan phase
    expect(byPhase('plan')).toContain('strategic-architect');
    // tactical-architect + implementation-planner produce the concrete design
    expect(byPhase('design')).toContain('tactical-architect');
    expect(byPhase('design')).toContain('implementation-planner');
    // the existing architecture reviewer is still present
    expect(byPhase('design')).toContain('architect-reviewer');
  });

  it('omits forward-design architects when no architecture/api surface is matched', () => {
    const plan = planFromDescription('Tidy whitespace in tests', undefined, [
      'test/cli/init.test.ts',
    ]);
    const droids = plan.steps.map((s) => s.droid);
    expect(droids).not.toContain('strategic-architect');
    expect(droids).not.toContain('tactical-architect');
  });
});
