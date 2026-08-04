/**
 * A policy's enforcer must be findable however the policy is named.
 *
 * `autoAttachEnforcer` matched the stored policy name against the slug
 * exactly. Policies are stored under their markdown H1, and older catalog
 * entries use a Title Case heading — so `enforcement-self-protect` never
 * matched "Enforcement Self-Protect", no executable_tools row was written, and
 * uap-policy-gate.sh (which finds runnable policies by INNER JOINing policies
 * against executable_tools) could not see the policy at all.
 *
 * The visible symptom was the gate FAILING CLOSED on every edit to the
 * enforcement surface, in every checkout, reporting "self-protect not
 * registered/active". 31 active policies were in that state.
 */
import { describe, it, expect } from 'vitest';
import { policyNameSlug } from '../src/cli/policy.js';

describe('policyNameSlug', () => {
  it('maps a Title Case policy heading onto its slug', () => {
    // The exact case that broke self-protect.
    expect(policyNameSlug('Enforcement Self-Protect')).toBe('enforcement-self-protect');
    expect(policyNameSlug('Worktree Enforcement')).toBe('worktree-enforcement');
    expect(policyNameSlug('Completion Gate')).toBe('completion-gate');
  });

  it('leaves a name that is already a slug unchanged', () => {
    // The policies that DID work all had slug names; they must keep working.
    expect(policyNameSlug('worktree-required')).toBe('worktree-required');
    expect(policyNameSlug('memory-before-plan')).toBe('memory-before-plan');
  });

  it('collapses punctuation and trims the edges', () => {
    expect(policyNameSlug('Policy: Branch Freshness')).toBe('policy-branch-freshness');
    expect(policyNameSlug('  Spaced  Out  ')).toBe('spaced-out');
  });

  it('maps the duplicate spellings of one policy onto the same slug', () => {
    // Both rows exist in the wild, and the gate may pick either — which is why
    // the enforcer is attached to every match, not just the first.
    expect(policyNameSlug('Enforcement Self Protect')).toBe('enforcement-self-protect');
    expect(policyNameSlug('Enforcement Self-Protect')).toBe('enforcement-self-protect');
  });
});
