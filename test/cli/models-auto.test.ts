/**
 * `uap models auto` (phase 4): the operator surface for the auto-load
 * policy — enable/disable, and the displacement allowlist which is the
 * STANDING consent that lets an auto load evict a resident.
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { modelsAutoCommand } from '../../src/cli/models.js';
import { loadAutoPolicy } from '../../src/placement/auto.js';

let dir: string;
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function freshPolicy(): string {
  dir = mkdtempSync(join(tmpdir(), 'models-auto-'));
  return join(dir, 'placement-auto.json');
}

describe('uap models auto', () => {
  it('status only: no flags reads and prints, never writes', () => {
    const policyPath = freshPolicy();
    expect(modelsAutoCommand({ policyPath })).toBe(0);
    expect(loadAutoPolicy(policyPath).enabled).toBe(false); // untouched
  });

  it('--enable writes enabled=true; --disable writes it back off', () => {
    const policyPath = freshPolicy();
    expect(modelsAutoCommand({ policyPath, enable: true })).toBe(0);
    expect(loadAutoPolicy(policyPath)).toEqual({ enabled: true, allow_displace: [] });
    expect(modelsAutoCommand({ policyPath, disable: true })).toBe(0);
    expect(loadAutoPolicy(policyPath).enabled).toBe(false);
  });

  it('--allow-displace refuses without --yes (displacement evicts a resident unattended)', () => {
    const policyPath = freshPolicy();
    expect(modelsAutoCommand({ policyPath, enable: true, allowDisplace: 'qwen3.8-27b' })).toBe(1);
    expect(loadAutoPolicy(policyPath).allow_displace).toEqual([]); // nothing recorded
  });

  it('--allow-displace --yes records the standing consent; --disallow-displace removes it', () => {
    const policyPath = freshPolicy();
    expect(modelsAutoCommand({ policyPath, allowDisplace: 'qwen3.8-27b, victim-27b', yes: true })).toBe(0);
    expect(loadAutoPolicy(policyPath).allow_displace).toEqual(['qwen3.8-27b', 'victim-27b']);
    expect(modelsAutoCommand({ policyPath, disallowDisplace: 'victim-27b' })).toBe(0);
    expect(loadAutoPolicy(policyPath).allow_displace).toEqual(['qwen3.8-27b']);
  });

  it('re-allowing an already-allowed model does not duplicate the consent record', () => {
    const policyPath = freshPolicy();
    expect(modelsAutoCommand({ policyPath, allowDisplace: 'qwen3.8-27b', yes: true })).toBe(0);
    expect(modelsAutoCommand({ policyPath, allowDisplace: 'qwen3.8-27b', yes: true })).toBe(0);
    expect(loadAutoPolicy(policyPath).allow_displace).toEqual(['qwen3.8-27b']);
  });

  it('disallowing a model that was never allowed is a harmless no-op', () => {
    const policyPath = freshPolicy();
    expect(modelsAutoCommand({ policyPath, disallowDisplace: 'never-allowed' })).toBe(0);
    expect(loadAutoPolicy(policyPath).allow_displace).toEqual([]);
  });

  it('--enable and --disable together are rejected, not silently resolved', () => {
    const policyPath = freshPolicy();
    expect(modelsAutoCommand({ policyPath, enable: true, disable: true })).toBe(1);
    // And nothing was written.
    expect(loadAutoPolicy(policyPath).enabled).toBe(false);
  });
});
