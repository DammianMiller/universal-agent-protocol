/**
 * The policy installer's name lookup.
 *
 * A policy is STORED under the name in its markdown H1, but callers address it
 * by FILE SLUG. Those coincide only by accident:
 *
 *   enforcement-self-protect.md   →  "# Enforcement Self-Protect"    ✗ no match
 *   delivery-enforcement.md       →  "# delivery-enforcement"        ✓ matches
 *
 * So `p.name === policyName` attached the enforcer for policies whose title
 * happened to be written as a slug, and silently skipped the rest — while still
 * printing "✅ Policy installed successfully!" and exiting 0.
 *
 * The consequence is not cosmetic. When the attach is skipped, the PREVIOUSLY
 * materialised enforcer stays in force: enforcement is stale, not updated. That
 * is how a fix to enforcement-self-protect sat unapplied for over a week, across
 * repeated installs that all reported success — 28 stale copies in
 * .policy-tools/, none carrying changes made the same day.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

const REPO = process.cwd();
const SCRIPT = join(REPO, 'scripts', 'install-policy.ts');
const POLICY_DIR = join(REPO, 'src', 'policies', 'schemas', 'policies');
const ENFORCER_DIR = join(REPO, 'src', 'policies', 'enforcers');

/** Mirrors the installer's own slugify. */
function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

describe('slugify — the comparison the lookup needs', () => {
  it('maps a human title onto its file slug', () => {
    expect(slugify('Enforcement Self-Protect')).toBe('enforcement-self-protect');
    expect(slugify('delivery-enforcement')).toBe('delivery-enforcement');
    expect(slugify('  Policy: Merge, Deploy & Verify  ')).toBe('policy-merge-deploy-verify');
  });

  it('is idempotent, so an already-slug name is unchanged', () => {
    for (const n of ['enforcement-infra-protect', 'worktree-required']) {
      expect(slugify(n)).toBe(n);
      expect(slugify(slugify(n))).toBe(n);
    }
  });
});

describe('install-policy.ts', () => {
  const src = readFileSync(SCRIPT, 'utf-8');

  it('matches a stored policy by slug, not only by exact name', () => {
    // The line that was the bug. Exact-match alone is what skipped the attach.
    expect(src).toContain('slugify(p.name) === wanted');
    expect(src).toMatch(/policies\.find\(\(p\) => p\.name === policyName\)\s*\?\?/);
  });

  it('distinguishes "no enforcer" from "policy not found"', () => {
    // They mean opposite things: no enforcer file is normal (most policies are
    // prose); an enforcer that exists but did not attach leaves stale
    // enforcement running. Collapsing both into `false` produced the message
    // "(no executable enforcer at <path>)" for a file that was present and
    // executable — a report that actively misdirected the reader.
    expect(src).toContain("reason: 'no-enforcer'");
    expect(src).toContain("reason: 'policy-not-found'");
  });

  it('says the enforcement is STALE rather than implying nothing happened', () => {
    expect(src).toMatch(/REMAINS ACTIVE/);
    expect(src).toMatch(/stale/i);
  });

  it('exits non-zero when an enforcer could not be attached', () => {
    // Exit 0 is why this went unnoticed: every automated install reported
    // success while enforcement silently stayed on an old copy.
    expect(src).toContain('installFailures');
    expect(src).toMatch(/installFailures > 0[\s\S]{0,400}process\.exit\(1\)/);
  });

  it('has no un-migrated boolean returns left in attachEnforcer', () => {
    // A `return true` left behind reads as falsy on `.attached` and reports a
    // SUCCESSFUL attach as a failure — which is exactly what happened while
    // writing this fix.
    const start = src.indexOf('async function attachEnforcer');
    const end = src.indexOf('\n}', src.indexOf('return { attached: true }', start));
    const body = src.slice(start, end);
    expect(body).not.toMatch(/\breturn (true|false);/);
  });
});

describe('the repository the installer runs against', () => {
  it('has at least one policy whose H1 is NOT its slug — the case that broke', () => {
    // If this ever becomes false the bug is unobservable, and a future exact-match
    // "simplification" would look safe. Keep the evidence in the suite.
    const mismatched = readdirSync(POLICY_DIR)
      .filter((f) => f.endsWith('.md'))
      .filter((f) => {
        const h1 = (readFileSync(join(POLICY_DIR, f), 'utf-8').match(/^#\s+(.+)$/m) || [])[1];
        return h1 !== undefined && h1.trim() !== f.replace(/\.md$/, '');
      });
    expect(mismatched.length).toBeGreaterThan(0);
  });

  it('every enforcer has a policy markdown beside it', () => {
    // An enforcer with no policy can never attach, and would now fail the build
    // loudly rather than sit unnoticed.
    if (!existsSync(ENFORCER_DIR)) return;
    const orphans = readdirSync(ENFORCER_DIR)
      .filter((f) => f.endsWith('.py') && !f.startsWith('_') && f !== 'test_gate.py')
      // UUID-prefixed files are MATERIALISED copies whose home is .policy-tools/;
      // one has leaked into the source dir (7ebbc721-…_architecture_review.py).
      // Excluded rather than asserted on: it is pre-existing clutter, and folding
      // it into this check would make the check about tidiness instead of about
      // enforcers that can never attach.
      .filter((f) => !/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(f))
      .filter((f) => !existsSync(join(POLICY_DIR, `${f.replace(/\.py$/, '').replace(/_/g, '-')}.md`)));
    expect(orphans).toEqual([]);
  });
});
