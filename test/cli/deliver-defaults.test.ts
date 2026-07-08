/**
 * deliver-defaults tests — verify uap init/setup wire delivery-enforcement +
 * the deliver MCP tool on by default.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// --- Mock the policy subsystem so ensureDeliveryEnforcement has no DB side effects ---
const storeRawPolicy = vi.fn(async () => 'policy-id-123');
const storeToolCode = vi.fn(async () => 'tool-id');
const togglePolicy = vi.fn(async () => undefined);
const invalidateCache = vi.fn(() => undefined);
let existingPolicies: Array<{ id: string; name: string }> = [];

vi.mock('../../src/policies/policy-memory.js', () => ({
  getPolicyMemoryManager: () => ({
    getAllPolicies: async () => existingPolicies,
    storeRawPolicy,
    togglePolicy,
  }),
}));
vi.mock('../../src/policies/policy-tools.js', () => ({
  getPolicyToolRegistry: () => ({ storeToolCode }),
}));
vi.mock('../../src/policies/policy-gate.js', () => ({
  getPolicyGate: () => ({ invalidateCache }),
}));

import { ensureDeliveryEnforcement, ensureSelfProtect, wireDeliverMcp } from '../../src/cli/deliver-defaults.js';

describe('wireDeliverMcp', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'deliver-mcp-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes .mcp.json with the uap-router server for Claude Code', () => {
    const r = wireDeliverMcp(dir);
    expect(r.claude).toBe(true);
    const cfg = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf-8'));
    expect(cfg.mcpServers['uap-router']).toEqual({ command: 'uap', args: ['mcp-router', 'start'] });
  });

  it('is idempotent and preserves existing MCP servers', () => {
    writeFileSync(
      join(dir, '.mcp.json'),
      JSON.stringify({ mcpServers: { other: { command: 'x', args: [] } } })
    );
    wireDeliverMcp(dir);
    wireDeliverMcp(dir); // second call must not duplicate or clobber
    const cfg = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf-8'));
    expect(cfg.mcpServers.other).toEqual({ command: 'x', args: [] });
    expect(cfg.mcpServers['uap-router']).toBeDefined();
  });

  it('writes opencode.json only when the project uses OpenCode', () => {
    const r1 = wireDeliverMcp(dir);
    expect(r1.opencode).toBe(false);
    expect(existsSync(join(dir, 'opencode.json'))).toBe(false);

    mkdirSync(join(dir, '.opencode'), { recursive: true });
    const r2 = wireDeliverMcp(dir);
    expect(r2.opencode).toBe(true);
    const cfg = JSON.parse(readFileSync(join(dir, 'opencode.json'), 'utf-8'));
    expect(cfg.mcp['uap-router']).toEqual({
      type: 'local',
      command: ['uap', 'mcp-router', 'start'],
      enabled: true,
    });
  });
});

describe('ensureDeliveryEnforcement', () => {
  beforeEach(() => {
    existingPolicies = [];
    storeRawPolicy.mockClear();
    storeToolCode.mockClear();
    togglePolicy.mockClear();
    invalidateCache.mockClear();
  });

  it('installs, attaches the enforcer, and enables the policy by default', async () => {
    const r = await ensureDeliveryEnforcement();
    expect(r.installed).toBe(true);
    expect(r.enabled).toBe(true);
    expect(r.enforcerAttached).toBe(true);
    expect(storeRawPolicy).toHaveBeenCalledTimes(1);
    expect(storeToolCode).toHaveBeenCalledWith('policy-id-123', 'delivery_enforcement', expect.any(String));
    expect(togglePolicy).toHaveBeenCalledWith('policy-id-123', true);
    expect(invalidateCache).toHaveBeenCalled();
  });

  it('is idempotent: re-enables an already-installed policy without re-storing it', async () => {
    existingPolicies = [{ id: 'existing-id', name: 'delivery-enforcement' }];
    const r = await ensureDeliveryEnforcement();
    expect(r.installed).toBe(false);
    expect(r.enabled).toBe(true);
    expect(storeRawPolicy).not.toHaveBeenCalled();
    expect(togglePolicy).toHaveBeenCalledWith('existing-id', true);
  });
});

describe('ensureSelfProtect', () => {
  beforeEach(() => {
    existingPolicies = [];
    storeRawPolicy.mockClear();
    storeToolCode.mockClear();
    togglePolicy.mockClear();
    invalidateCache.mockClear();
  });

  it('installs, ATTACHES the self-protect enforcer, and enables it (closes the inert-gate gap)', async () => {
    const r = await ensureSelfProtect();
    expect(r.enabled).toBe(true);
    expect(r.enforcerAttached).toBe(true);
    // The attach is the whole fix — the policy row existed before but had no
    // executable_tools row, so the runtime hook never ran it.
    expect(storeToolCode).toHaveBeenCalledWith('policy-id-123', 'enforcement_self_protect', expect.any(String));
    expect(togglePolicy).toHaveBeenCalledWith('policy-id-123', true);
  });

  it('is idempotent against the pre-existing (previously-inert) policy rows: attaches without creating a duplicate', async () => {
    // Mirrors the live DB: a self-protect row exists but has no enforcer.
    existingPolicies = [{ id: 'inert-row', name: 'enforcement-self-protect' }];
    const r = await ensureSelfProtect();
    expect(r.installed).toBe(false);
    expect(storeRawPolicy).not.toHaveBeenCalled(); // no new duplicate row
    expect(storeToolCode).toHaveBeenCalledWith('inert-row', 'enforcement_self_protect', expect.any(String));
    expect(togglePolicy).toHaveBeenCalledWith('inert-row', true);
  });
});
