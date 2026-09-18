/**
 * Capacity doctor (uplift 0.5) — policy validation, the GREEN/RED/DARK
 * health matrix, and the CLI exit-code contract.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  parsePolicy,
  computeHealth,
  PolicyError,
  type ServicePolicy,
} from '../src/capacity/policy.js';
import { runDoctor, worstHealth, type DoctorDeps } from '../src/capacity/probe.js';
import { doctorCommand } from '../src/cli/doctor.js';

const SVC: ServicePolicy = {
  name: 'gsq-rco-server',
  systemd: { unit: 'uap-gsq-rco-server.service', scope: 'user' },
  budget: { vramMiB: 5120 },
  headroom: { gpuMinFreeMiB: 600 },
  restartBudget: { knownRestarts: 0, allowedNew: 0 },
};

function policyWith(...services: ServicePolicy[]) {
  return JSON.stringify({ version: 1, services });
}

describe('parsePolicy', () => {
  it('accepts a valid policy', () => {
    const p = parsePolicy(policyWith(SVC));
    expect(p.services).toHaveLength(1);
    expect(p.services[0].headroom?.gpuMinFreeMiB).toBe(600);
  });

  it('rejects malformed documents loudly', () => {
    expect(() => parsePolicy('{nope', 'p')).toThrow(PolicyError);
    expect(() => parsePolicy('{}', 'p')).toThrow(/version/);
    expect(() => parsePolicy('{"version":1,"services":[]}', 'p')).toThrow(/non-empty/);
    expect(() =>
      parsePolicy(policyWith({ ...SVC, systemd: { unit: 'no-suffix', scope: 'user' } }), 'p'),
    ).toThrow(/\.service/);
    expect(() =>
      parsePolicy(policyWith({ ...SVC, headroom: { gpuMinFreeMiB: -1 } }), 'p'),
    ).toThrow(/non-negative/);
    expect(() => parsePolicy(policyWith(SVC, SVC), 'p')).toThrow(/duplicate/);
  });

  it('rejects unit names that systemctl would parse as flags (CWE-88)', () => {
    for (const unit of ['--host=evil.service', '--machine=x.service', '-p ActiveState.service']) {
      expect(() =>
        parsePolicy(policyWith({ ...SVC, systemd: { unit, scope: 'user' } }), 'p'),
      ).toThrow(PolicyError);
    }
  });

  it('accepts templated and instance unit names', () => {
    expect(() =>
      parsePolicy(
        policyWith({ ...SVC, systemd: { unit: 'uap-gsq@prod-1.service', scope: 'user' } }), 'p',
      ),
    ).not.toThrow();
  });
});

describe('computeHealth — the GREEN/RED/DARK matrix', () => {
  const probes = { systemd: true, gpu: true };

  it('GREEN when active and all budgets inside policy', () => {
    const h = computeHealth(SVC, { activeState: 'active', subState: 'running', nRestarts: 0, gpuFreeMiB: 843 }, probes);
    expect(h.health).toBe('GREEN');
  });

  it('DARK when the unit is failed or inactive — down is absent, not degraded', () => {
    for (const state of ['failed', 'inactive', 'unknown']) {
      expect(computeHealth(SVC, { activeState: state }, probes).health).toBe('DARK');
    }
  });

  it('RED on new restarts beyond the known baseline', () => {
    const h = computeHealth(SVC, { activeState: 'active', nRestarts: 1, gpuFreeMiB: 900 }, probes);
    expect(h.health).toBe('RED');
    expect(h.reasons.join(' ')).toContain('NRestarts=1');
    // the known baseline itself stays GREEN
    const baseline = { ...SVC, restartBudget: { knownRestarts: 4, allowedNew: 0 } };
    expect(
      computeHealth(baseline, { activeState: 'active', nRestarts: 4, gpuFreeMiB: 900 }, probes).health,
    ).toBe('GREEN');
  });

  it('RED when GPU headroom is violated (OOM territory)', () => {
    const h = computeHealth(SVC, { activeState: 'active', nRestarts: 0, gpuFreeMiB: 400 }, probes);
    expect(h.health).toBe('RED');
    expect(h.reasons.join(' ')).toContain('headroom');
  });

  it('UNKNOWN when systemd is unavailable — never a fabricated GREEN', () => {
    expect(computeHealth(SVC, {}, { systemd: false, gpu: false }).health).toBe('UNKNOWN');
  });

  it('RED (not GREEN) when declared GPU headroom cannot be verified', () => {
    const h = computeHealth(SVC, { activeState: 'active', nRestarts: 0 }, { systemd: true, gpu: false });
    expect(h.health).toBe('RED');
    expect(h.reasons.join(' ')).toContain('unverified');
  });

  it('RED when activating/auto-restart — a crash loop is never GREEN', () => {
    // Restart=always crash-loop state: ActiveState=activating, SubState=auto-restart.
    // Without a restartBudget declared it must still not read as healthy.
    const h = computeHealth(
      { ...SVC, restartBudget: undefined },
      { activeState: 'activating', subState: 'auto-restart' },
      probes,
    );
    expect(h.health).toBe('RED');
    expect(h.reasons.join(' ')).toContain('not yet serving');
  });

  it('RED when RSS exceeds the declared budget', () => {
    const svc = { ...SVC, budget: { rssMiB: 256 } };
    const h = computeHealth(svc, { activeState: 'active', memoryCurrentMiB: 900 }, probes);
    expect(h.health).toBe('RED');
    expect(h.reasons.join(' ')).toContain('RSS 900 MiB exceeds declared budget 256 MiB');
  });

  it('RED when an RSS budget is declared but MemoryCurrent is unavailable', () => {
    const svc = { ...SVC, budget: { rssMiB: 256 } };
    const h = computeHealth(svc, { activeState: 'active', nRestarts: 0, gpuFreeMiB: 900 }, probes);
    expect(h.health).toBe('RED');
    expect(h.reasons.join(' ')).toContain('budget unverified');
  });

  it('GREEN when RSS is inside budget; vramMiB is not compared to process footprint', () => {
    // vramMiB declares the service's own allocator limit (--vbr-vram), not its
    // total process VRAM — the doctor owns host headroom, not internal allocation.
    const svc = { ...SVC, budget: { vramMiB: 5120, rssMiB: 256 } };
    const h = computeHealth(
      svc, { activeState: 'active', nRestarts: 0, gpuFreeMiB: 900, memoryCurrentMiB: 200 }, probes,
    );
    expect(h.health).toBe('GREEN');
  });
});

describe('runDoctor + worstHealth', () => {
  const deps = (state: string, restarts: number, gpu: number | null): DoctorDeps => ({
    probeSystemd: () => ({ activeState: state, subState: 'running', nRestarts: restarts }),
    probeGpuFreeMiB: () => gpu,
  });

  it('rolls up the worst health across services', () => {
    const policy = parsePolicy(policyWith(SVC, { ...SVC, name: 'monitor', systemd: { unit: 'm.service', scope: 'user' }, headroom: undefined }));
    const reports = runDoctor(policy, deps('active', 0, 843));
    expect(reports.map((r) => r.health)).toEqual(['GREEN', 'GREEN']);
    expect(worstHealth(reports)).toBe('GREEN');
    const degraded = runDoctor(policy, deps('failed', 0, 843));
    expect(worstHealth(degraded)).toBe('DARK');
  });

  it('worstHealth ordering: DARK > RED > UNKNOWN > GREEN', () => {
    const mk = (health: 'GREEN' | 'RED' | 'DARK' | 'UNKNOWN') =>
      ({ name: health, health, reasons: [] as string[], probed: {} });
    expect(worstHealth([mk('UNKNOWN'), mk('GREEN')])).toBe('UNKNOWN');
    expect(worstHealth([mk('GREEN'), mk('RED'), mk('UNKNOWN')])).toBe('RED');
    expect(worstHealth([mk('RED'), mk('DARK')])).toBe('DARK');
    expect(worstHealth([mk('GREEN')])).toBe('GREEN');
  });

  it('probes the GPU once per run, not per service', () => {
    let gpuCalls = 0;
    const counting: DoctorDeps = {
      probeSystemd: () => ({ activeState: 'active', subState: 'running', nRestarts: 0 }),
      probeGpuFreeMiB: () => {
        gpuCalls++;
        return 900;
      },
    };
    const policy = parsePolicy(policyWith(SVC, { ...SVC, name: 'b', systemd: { unit: 'b.service', scope: 'user' } }));
    runDoctor(policy, counting);
    expect(gpuCalls).toBe(1);
  });
});

describe('doctor CLI contract', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-doctor-'));
    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(join(dir, 'config', 'capacity-policy.json'), policyWith(SVC));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  const greenDeps: DoctorDeps = {
    probeSystemd: () => ({ activeState: 'active', subState: 'running', nRestarts: 0 }),
    probeGpuFreeMiB: () => 900,
  };
  const redDeps: DoctorDeps = {
    probeSystemd: () => ({ activeState: 'active', subState: 'running', nRestarts: 3 }),
    probeGpuFreeMiB: () => 900,
  };

  it('is advisory by default, strict exits 1 on RED', async () => {
    await doctorCommand({ projectDir: dir }, redDeps);
    expect(process.exitCode).toBeUndefined();
    await doctorCommand({ projectDir: dir, strict: true }, redDeps);
    expect(process.exitCode).toBe(1);
  });

  it('exits 1 when no policy is found, on the --json path too', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'uap-doctor-empty-'));
    // Point HOME elsewhere so the user-config fallback cannot resolve either.
    const home = process.env.HOME;
    process.env.HOME = empty;
    try {
      await doctorCommand({ projectDir: empty, json: true }, greenDeps);
      expect(process.exitCode).toBe(1);
    } finally {
      process.env.HOME = home;
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('reports GREEN on a healthy host', async () => {
    await doctorCommand({ projectDir: dir, json: true }, greenDeps);
    expect(process.exitCode).toBeUndefined();
  });
});
