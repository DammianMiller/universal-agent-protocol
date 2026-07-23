/**
 * Deliver complexity-tier routing: the task's classified complexity picks the
 * executor model from a named routing preset (cost/speed), with explicit
 * --model always winning.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { resolveTierModel } from '../../src/cli/deliver.js';

describe('resolveTierModel', () => {
  const savedEnv = process.env.UAP_DELIVER_ROUTING;
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.UAP_DELIVER_ROUTING;
    else process.env.UAP_DELIVER_ROUTING = savedEnv;
  });

  it('routes a trivial task to the cheapest tier model (cost-tiered)', () => {
    const r = resolveTierModel('cost-tiered', 'fix a typo');
    expect(r).not.toBeNull();
    expect(r!.tier).toBe('low');
    expect(r!.model).toBe('qwen36-a3b');
  });

  it('escalates a security-sensitive task to the critical tier (auth keyword)', () => {
    // S2: the unified classifier preserves `critical` — an auth/security task
    // now escalates past `high` (the old COMPLEXITY_TO_TIER bridge dropped it).
    const r = resolveTierModel(
      'cost-tiered',
      'implement a distributed rate limiter with redis, refactor the auth middleware, and add integration tests across services'
    );
    expect(r!.tier).toBe('critical');
    expect(r!.model).toBe('opus-4.8'); // cost-tiered: critical → opus-4.8
  });

  it('routes a hard non-security multi-part task to the high tier model', () => {
    const r = resolveTierModel(
      'cost-tiered',
      'implement a distributed rate limiter with redis and add integration tests across many services and rendering modules'
    );
    expect(r!.tier).toBe('high');
    expect(r!.model).toBe('opus-4.8');
  });

  it('speed-tiered routes trivial tasks to the fast cloud model', () => {
    const r = resolveTierModel('speed-tiered', 'rename a variable');
    expect(r!.model).toBe('haiku-4.5');
  });

  it('returns null when no routing preset is given', () => {
    delete process.env.UAP_DELIVER_ROUTING;
    expect(resolveTierModel(undefined, 'anything')).toBeNull();
  });

  it('returns null for an unknown preset id (falls through to defaults)', () => {
    expect(resolveTierModel('no-such-preset', 'anything')).toBeNull();
  });

  it('reads UAP_DELIVER_ROUTING when the flag is absent', () => {
    process.env.UAP_DELIVER_ROUTING = 'cost-tiered';
    const r = resolveTierModel(undefined, 'fix a typo');
    expect(r!.preset).toBe('cost-tiered');
    expect(r!.model).toBe('qwen36-a3b');
  });
});
