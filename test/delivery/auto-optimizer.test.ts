import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { planAutoOptimization } from '../../src/delivery/auto-optimizer.js';
import { measureQueryComplexity } from '../../src/utils/query-complexity.js';
import {
  deliverCommand,
  hasExplicitAidFlags,
  applyAutoPlan,
  effectiveCandidates,
} from '../../src/cli/deliver.js';
import type { DeliverOptions } from '../../src/cli/deliver.js';

describe('planAutoOptimization', () => {
  it('keeps simple tasks on the plain single-shot loop', () => {
    const plan = planAutoOptimization('x', () => 'simple');
    expect(plan.complexity).toBe('simple');
    expect(plan.candidates).toBeUndefined();
    expect(plan.critic).toBe(false);
    expect(plan.ideate).toBe(false);
    expect(plan.escalate).toBe(false);
  });

  it('gives moderate tasks exploration, critic, practices, ideation, acceptance, HALO, coordination', () => {
    const plan = planAutoOptimization('x', () => 'moderate');
    expect(plan).toMatchObject({
      complexity: 'moderate',
      candidates: 3,
      critic: true,
      practices: true,
      escalate: false,
      ideate: true,
      acceptance: true,
      halo: true,
      coordinate: true,
    });
  });

  it('gives complex tasks the full convergence stack', () => {
    const plan = planAutoOptimization('x', () => 'complex');
    expect(plan).toMatchObject({
      complexity: 'complex',
      candidates: 4,
      critic: true,
      practices: true,
      escalate: true,
      ideate: true,
      acceptance: true,
      halo: true,
      coordinate: true,
    });
  });

  // Characterization tests: these pin the cost-tier boundary for real
  // instructions. If classifier tuning moves them, that is a deliberate
  // delivery-cost decision — update with intent.
  it('classifies a real non-trivial coding instruction as non-simple by default', () => {
    const plan = planAutoOptimization(
      'Implement src/duration.mjs exporting parseDuration(str) and formatDuration(seconds); ' +
        'parse compound duration strings, throw TypeError on invalid input, and also add ' +
        'round-trip tests so the build and test gates pass'
    );
    expect(['moderate', 'complex']).toContain(plan.complexity);
    expect(plan.candidates).toBeGreaterThanOrEqual(3);
    expect(plan.critic).toBe(true);
  });

  it('classifies a one-liner as simple by default', () => {
    const plan = planAutoOptimization('bump the copyright year');
    expect(plan.complexity).toBe('simple');
    expect(plan.candidates).toBeUndefined();
  });
});

describe('measureQueryComplexity thresholds', () => {
  it('respects caller-supplied thresholds independently of defaults', () => {
    const q = 'implement and fix the parser, then add tests'; // scores ≥ 1 (tech terms + multiple actions)
    expect(measureQueryComplexity(q)).not.toBe('simple');
    expect(measureQueryComplexity(q, { moderate: 50, complex: 100 })).toBe('simple');
  });
});

describe('hasExplicitAidFlags', () => {
  it('is false when no aid flags are set', () => {
    expect(hasExplicitAidFlags({})).toBe(false);
  });

  it('treats an explicit false as steering (commander leaves unset as undefined)', () => {
    expect(hasExplicitAidFlags({ critic: false })).toBe(true);
  });

  it.each([
    ['candidates', { candidates: '3' }],
    ['critic', { critic: true }],
    ['practices', { practices: true }],
    ['escalate', { escalate: true }],
    ['escalateModel', { escalateModel: 'opus-4.6' }],
    ['ideate', { ideate: true }],
    ['ideateProject', { ideateProject: 'p' }],
    ['halo', { halo: true }],
    ['coordinate', { coordinate: true }],
    ['optimize', { optimize: true }],
  ] as Array<[string, DeliverOptions]>)('is true when %s is set', (_name, options) => {
    expect(hasExplicitAidFlags(options)).toBe(true);
  });
});

describe('applyAutoPlan', () => {
  it('applies a complex plan onto empty options', () => {
    const options: DeliverOptions = {};
    applyAutoPlan(options, planAutoOptimization('x', () => 'complex'));
    expect(options).toEqual({
      candidates: '4',
      critic: true,
      practices: true,
      escalate: true,
      ideate: true,
      halo: true,
      coordinate: true,
      acceptance: true,
      integration: true,
      deployDev: true,
    });
  });

  it('never overwrites explicitly-set values, including explicit false', () => {
    const options: DeliverOptions = { candidates: '6', critic: false };
    applyAutoPlan(options, planAutoOptimization('x', () => 'complex'));
    expect(options.candidates).toBe('6');
    expect(options.critic).toBe(false);
  });

  it('leaves options untouched for a simple plan', () => {
    const options: DeliverOptions = {};
    applyAutoPlan(options, planAutoOptimization('x', () => 'simple'));
    expect(options).toEqual({});
  });
});

describe('runDeliver auto gating (dry-run integration)', () => {
  let dir: string;
  const savedAuto = process.env.UAP_DELIVER_AUTO;

  function makeProject(): string {
    dir = mkdtempSync(join(tmpdir(), 'auto-gate-'));
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 't', version: '1.0.0', scripts: { test: 'node -e ""' } })
    );
    return dir;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    if (savedAuto === undefined) delete process.env.UAP_DELIVER_AUTO;
    else process.env.UAP_DELIVER_AUTO = savedAuto;
    rmSync(dir, { recursive: true, force: true });
  });

  async function dryRunAuto(extra: Partial<DeliverOptions> = {}): Promise<string | null> {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => {
      logs.push(String(msg));
    });
    await deliverCommand(
      'Implement src/duration.mjs and fix the parser so tests pass with TypeError validation',
      { dryRun: true, json: true, projectRoot: makeProject(), ...extra }
    );
    const parsed = JSON.parse(logs.join('\n'));
    return parsed.auto;
  }

  it('reports the auto plan by default', async () => {
    const auto = await dryRunAuto();
    expect(auto).toMatch(/task → /);
  });

  it('is null with --no-auto', async () => {
    expect(await dryRunAuto({ auto: false })).toBeNull();
  });

  it('is null when UAP_DELIVER_AUTO=0', async () => {
    process.env.UAP_DELIVER_AUTO = '0';
    expect(await dryRunAuto()).toBeNull();
  });

  it('is null when any aid flag is explicit', async () => {
    expect(await dryRunAuto({ critic: true })).toBeNull();
  });
});

describe('effectiveCandidates (explorer × agentic guard)', () => {
  it('forces single-candidate turns for the agentic executor', () => {
    expect(effectiveCandidates(true, 4)).toBeUndefined();
    expect(effectiveCandidates(true, undefined)).toBeUndefined();
  });

  it('leaves blind-executor exploration untouched', () => {
    expect(effectiveCandidates(false, 4)).toBe(4);
    expect(effectiveCandidates(false, undefined)).toBeUndefined();
  });
});

