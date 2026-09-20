import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { computeHealth, parsePolicy, type ServicePolicy } from '../src/capacity/policy.js';

/**
 * The doctor must notice when a unit's FLAGS drift from the policy, not just
 * when the unit dies.
 *
 * On 2026-09-20 `config/capacity-policy.json` still described the GSQ-RCO
 * server as `-np 1` while it had been running `-np 2` for hours, and
 * `uap doctor` reported GREEN throughout — because `probeSystemd` requested
 * only ActiveState/SubState/NRestarts/MainPID/MemoryCurrent and never looked
 * at ExecStart. The declared-vs-probed doctrine the rest of computeHealth
 * already applies to budgets now covers configuration too.
 */

const SERVING = { activeState: 'active', subState: 'running' };
const AVAIL = { systemd: true, gpu: false };

const base: ServicePolicy = {
  name: 'svc',
  systemd: { unit: 'x.service', scope: 'user' },
  budget: { execStartMustContain: ['-c 229376', '-np 2'] },
};

describe('capacity policy — ExecStart drift', () => {
  it('is GREEN when the probed flags match the declaration', () => {
    const r = computeHealth(
      base,
      { ...SERVING, execStart: '{ path=/x ; argv[]=/x -m m.gguf -c 229376 -np 2 -ub 1024 }' },
      AVAIL,
    );
    expect(r.health).toBe('GREEN');
    // GREEN still carries an informational line; what matters is that no
    // drift complaint appears in it.
    expect(r.reasons.join(' ')).not.toMatch(/drifted|unverified/);
  });

  it('is RED when a declared flag is absent — the -np 1 -> -np 2 case', () => {
    const r = computeHealth(
      base,
      { ...SERVING, execStart: '{ path=/x ; argv[]=/x -m m.gguf -c 229376 -np 1 -ub 1024 }' },
      AVAIL,
    );
    expect(r.health).toBe('RED');
    expect(r.reasons.join(' ')).toMatch(/-np 2/);
    expect(r.reasons.join(' ')).toMatch(/drifted/);
  });

  it('names every missing flag, not just the first', () => {
    const r = computeHealth(
      base,
      { ...SERVING, execStart: '{ path=/x ; argv[]=/x -m m.gguf -c 262144 -np 3 }' },
      AVAIL,
    );
    expect(r.reasons.join(' ')).toMatch(/-c 229376/);
    expect(r.reasons.join(' ')).toMatch(/-np 2/);
  });

  it('flags unverifiable rather than passing silently', () => {
    // systemctl gave us no ExecStart: that is not evidence of compliance.
    const r = computeHealth(base, { ...SERVING }, AVAIL);
    expect(r.health).toBe('RED');
    expect(r.reasons.join(' ')).toMatch(/unverified/);
  });

  it('ignores the check entirely when nothing is declared', () => {
    const r = computeHealth(
      { name: 'svc', systemd: { unit: 'x.service', scope: 'user' } },
      { ...SERVING, execStart: 'anything at all' },
      AVAIL,
    );
    expect(r.health).toBe('GREEN');
  });

  it('rejects a malformed declaration at parse time', () => {
    const bad = JSON.stringify({
      version: 1,
      services: [{
        name: 'svc',
        systemd: { unit: 'x.service', scope: 'user' },
        budget: { execStartMustContain: ['ok', ''] },
      }],
    });
    expect(() => parsePolicy(bad)).toThrow(/execStartMustContain/);
  });
});

describe('the shipped policy declares the flags it talks about in prose', () => {
  const policy = parsePolicy(
    readFileSync(resolve(__dirname, '..', 'config/capacity-policy.json'), 'utf8'),
    'capacity-policy.json',
  );
  const gsq = policy.services.find((s) => s.name === 'gsq-rco-server');

  it('has the gsq-rco service', () => {
    expect(gsq).toBeDefined();
  });

  it('pins the rail count and pool size as checkable flags', () => {
    expect(gsq!.budget?.execStartMustContain).toEqual(
      expect.arrayContaining(['-np 2', '-c 229376']),
    );
  });

  it('keeps the prose note consistent with the checkable flags', () => {
    // The note is what a human reads; the flags are what the doctor enforces.
    // They disagreed for hours once — the note said -np 1.
    const note = gsq!.budget?.note ?? '';
    for (const flag of gsq!.budget?.execStartMustContain ?? []) {
      expect(note).toContain(flag.replace(/^--?/, '').split(' ')[0]);
    }
    expect(note).toMatch(/-np 2/);
    expect(note).not.toMatch(/-np 1\b/);
  });
});
