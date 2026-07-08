/**
 * Policy matrix — the pure builder + metadata parser behind `uap policy matrix`
 * (the "all policies listed with settings" surface) and the pay2u pack schemas.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { buildPolicyMatrix, parsePolicyMeta } from '../../src/cli/policy.js';
import { PAY2U_PACK_POLICIES } from '../../src/cli/deliver-defaults.js';

const SCHEMA_DIR = join(__dirname, '..', '..', 'src', 'policies', 'schemas', 'policies');

// Mirror of the Zod enum in src/policies/schemas/policy.ts. A schema whose
// category is outside this set makes getAllPolicies() (and `uap policy matrix`)
// throw at parse time — the exact bug this guards against.
const VALID_CATEGORIES = new Set([
  'image', 'code', 'security', 'testing', 'ui', 'automation',
  'workflow', 'custom', 'quality', 'infrastructure', 'release', 'safety',
]);
const VALID_STAGES = new Set(['pre-exec', 'post-exec', 'review', 'always']);
const VALID_LEVELS = new Set(['REQUIRED', 'RECOMMENDED', 'OPTIONAL']);

describe('parsePolicyMeta', () => {
  it('extracts level, category, and stage from schema frontmatter', () => {
    const md = '# x\n\n**Category**: architecture\n**Level**: REQUIRED\n**Enforcement Stage**: review\n\n## Rule\n';
    expect(parsePolicyMeta(md)).toEqual({ level: 'REQUIRED', category: 'architecture', stage: 'review' });
  });
  it('falls back to safe defaults when fields are missing', () => {
    expect(parsePolicyMeta('# nothing here')).toEqual({ level: 'OPTIONAL', category: 'custom', stage: 'pre-exec' });
  });
});

describe('buildPolicyMatrix', () => {
  const builtins = [
    { name: 'a-policy', level: 'REQUIRED', category: 'infra', stage: 'pre-exec' },
    { name: 'b-policy', level: 'RECOMMENDED', category: 'process', stage: 'review' },
  ];

  it('lists a built-in that is not installed as available (not enabled)', () => {
    const rows = buildPolicyMatrix(builtins, []);
    const a = rows.find((r) => r.name === 'a-policy')!;
    expect(a).toMatchObject({ builtin: true, installed: false, enabled: false, level: 'REQUIRED' });
  });

  it('merges installed status/level onto the built-in row (installed wins)', () => {
    const rows = buildPolicyMatrix(builtins, [
      { id: 'id-a', name: 'a-policy', isActive: true, level: 'OPTIONAL', enforcementStage: 'always' },
    ]);
    const a = rows.find((r) => r.name === 'a-policy')!;
    expect(a).toMatchObject({ builtin: true, installed: true, enabled: true, level: 'OPTIONAL', stage: 'always', id: 'id-a' });
  });

  it('includes an installed custom policy that has no built-in schema', () => {
    const rows = buildPolicyMatrix(builtins, [
      { id: 'id-c', name: 'custom-only', isActive: false },
    ]);
    const c = rows.find((r) => r.name === 'custom-only')!;
    expect(c).toMatchObject({ builtin: false, installed: true, enabled: false });
  });

  it('is sorted by name', () => {
    const rows = buildPolicyMatrix([...builtins].reverse(), []);
    expect(rows.map((r) => r.name)).toEqual(['a-policy', 'b-policy']);
  });
});

describe('pay2u policy pack', () => {
  it('all pack policy schema files exist and are well-formed', () => {
    for (const name of PAY2U_PACK_POLICIES) {
      const p = join(SCHEMA_DIR, `${name}.md`);
      expect(existsSync(p), `${name}.md must exist`).toBe(true);
      const md = readFileSync(p, 'utf-8');
      const meta = parsePolicyMeta(md);
      expect(meta.level).toBe('RECOMMENDED'); // advisory pack
      expect(md).toContain('pay2u'); // tagged
    }
  });

  it('exposes exactly the three pack members', () => {
    expect(PAY2U_PACK_POLICIES).toEqual([
      'pay2u-architecture-rules',
      'pay2u-quick-reference',
      'pay2u-enforcement-hooks',
    ]);
  });
});

describe('every built-in policy schema uses valid enum metadata', () => {
  // A schema with an out-of-enum category/level/stage makes getAllPolicies()
  // throw once installed — so validate the WHOLE built-in set, not just pay2u.
  const files = readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.md') && f !== f.toUpperCase());
  it.each(files)('%s has category/level/stage in the allowed enums', (f) => {
    const meta = parsePolicyMeta(readFileSync(join(SCHEMA_DIR, f), 'utf-8'));
    expect(VALID_CATEGORIES.has(meta.category), `${f}: category '${meta.category}'`).toBe(true);
    expect(VALID_LEVELS.has(meta.level), `${f}: level '${meta.level}'`).toBe(true);
    expect(VALID_STAGES.has(meta.stage), `${f}: stage '${meta.stage}'`).toBe(true);
  });
});
