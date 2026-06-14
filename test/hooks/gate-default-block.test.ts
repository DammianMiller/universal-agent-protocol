/**
 * Verifies the policy-gate hook template defaults delivery enforcement to BLOCK
 * for UAP-managed projects, while preserving any explicit operator/CI override.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const GATE = join(process.cwd(), 'templates', 'hooks', 'uap-policy-gate.sh');

describe('policy-gate template: delivery enforcement default', () => {
  const src = readFileSync(GATE, 'utf-8');

  it('exports UAP_ENFORCE_DELIVERY defaulting to block', () => {
    expect(src).toMatch(/export\s+UAP_ENFORCE_DELIVERY="\$\{UAP_ENFORCE_DELIVERY:-block\}"/);
  });

  it('uses :- so an explicit override is preserved (not forced)', () => {
    // The `:-` form only supplies "block" when the var is unset/empty, so
    // UAP_ENFORCE_DELIVERY=advisory set by an operator/CI survives.
    expect(src).toContain('${UAP_ENFORCE_DELIVERY:-block}');
    expect(src).not.toMatch(/export\s+UAP_ENFORCE_DELIVERY=block\s*$/m);
  });

  it('sets the default before enforcers are executed', () => {
    const exportIdx = src.indexOf('UAP_ENFORCE_DELIVERY:-block');
    const execIdx = src.indexOf('python3 "$enforcer"');
    expect(exportIdx).toBeGreaterThan(-1);
    expect(execIdx).toBeGreaterThan(-1);
    expect(exportIdx).toBeLessThan(execIdx);
  });
});
