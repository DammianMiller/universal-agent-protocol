import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, writeFileSync } from 'fs';
import {
  SELF_GATE_REL_PATH,
  SELF_GATE_TIMEOUT_ENV,
  resolveSelfGateTimeout,
  detectExtractionMiss,
  detectBrokenGate,
  repairedGateIsSound,
} from '../../src/delivery/self-gate.js';

describe('self-gate uplifts (U3/U4)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-selfgate-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env[SELF_GATE_TIMEOUT_ENV];
  });

  describe('SELF_GATE_REL_PATH', () => {
    it('points into the protected .uap-deliver segment the gate-repair allowlist must sanction', () => {
      expect(SELF_GATE_REL_PATH).toBe('.uap-deliver/verify.sh');
    });
  });

  describe('resolveSelfGateTimeout (U4: was a hardcoded unreachable 120s)', () => {
    it('defaults to 300000 (cold cargo/npm builds routinely exceed 120s)', () => {
      expect(resolveSelfGateTimeout(undefined)).toBe(300_000);
    });

    it('an explicit option wins over the environment', () => {
      process.env[SELF_GATE_TIMEOUT_ENV] = '45000';
      expect(resolveSelfGateTimeout(120_000)).toBe(120_000);
    });

    it('the environment is honored when no option is passed', () => {
      process.env[SELF_GATE_TIMEOUT_ENV] = '45000';
      expect(resolveSelfGateTimeout(undefined)).toBe(45_000);
    });

    it('garbage environment values fall back to the default', () => {
      process.env[SELF_GATE_TIMEOUT_ENV] = 'not-a-number';
      expect(resolveSelfGateTimeout(undefined)).toBe(300_000);
    });
  });

  describe('detectExtractionMiss (U3: the gate cannot parse real output)', () => {
    it('fires on explicit extraction-failure wording', () => {
      expect(detectExtractionMiss('FAIL: p50 tick time not extractable from bench output')).not.toBeNull();
      expect(detectExtractionMiss('FAIL: could not extract throughput from report')).not.toBeNull();
    });

    it('fires on the metric-not-reported shape (the live rust-pg-ext wording)', () => {
      expect(detectExtractionMiss('GATE 4 FAIL: p50 tick time not reported by m1-bench')).not.toBeNull();
      expect(detectExtractionMiss('error: throughput not reported in the profile output')).not.toBeNull();
    });

    it('fires on missing-from-output wording', () => {
      expect(detectExtractionMiss('zone rows missing from program output')).not.toBeNull();
    });

    it('does NOT fire on an ordinary build/test failure (that is real "work not done")', () => {
      expect(detectExtractionMiss('error[E0432]: unresolved import `CandidateSlot`\n  --> src/bench.rs:21:5')).toBeNull();
      expect(detectExtractionMiss('test result: FAILED. 3 passed; 2 failed')).toBeNull();
    });

    it('does not collide with detectBrokenGate signals', () => {
      // Malformed tooling is a regenerate-the-gate case, not an extraction miss.
      expect(detectBrokenGate('grep: Unmatched [ or [')).not.toBeNull();
      expect(detectExtractionMiss('grep: Unmatched [ or [')).toBeNull();
    });
  });
});

describe('repairedGateIsSound (U3, review X2/arch F2 — a rigged repair reverts the pass)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-selfgate-'));
    mkdirSync(join(dir, '.uap-deliver'), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('flags a missing repaired script', () => {
    expect(repairedGateIsSound(dir)).toContain('missing');
  });

  it('flags a trivially-passing (exit 0) repaired gate as vacuous', () => {
    writeFileSync(join(dir, '.uap-deliver', 'verify.sh'), 'exit 0\n');
    const reason = repairedGateIsSound(dir);
    expect(reason).not.toBeNull();
    expect(reason).toContain('trivially passing');
  });

  it('accepts a repaired gate that still executes the artifact', () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'main.js'), "console.log('ok');\n");
    writeFileSync(
      join(dir, '.uap-deliver', 'verify.sh'),
      '#!/bin/bash\nnode src/main.js\nexit $?\n'
    );
    expect(repairedGateIsSound(dir)).toBeNull();
  });
});

describe('deliver.ts wiring (U1-U4 plumbing, source-anchored)', () => {
  const deliverSrc = readFileSync(join(__dirname, '..', '..', 'src', 'cli', 'deliver.ts'), 'utf-8');
  const selfGateSrc = readFileSync(join(__dirname, '..', '..', 'src', 'delivery', 'self-gate.ts'), 'utf-8');

  it('passes the self-gate timeout option to authorAcceptanceGate (U4)', () => {
    expect(deliverSrc).toContain('timeoutMs: options.selfGateTimeoutMs');
  });

  it('calls the prescribed-replay preflight on the final instruction (U2)', () => {
    expect(deliverSrc).toContain('prescribedReplayPreflight(projectRoot, instruction');
  });

  it('threads the shared write-allowlist ref into both executors and the loop config (U1/U3)', () => {
    expect((deliverSrc.match(/writeAllowlistRef: sharedWriteAllowlistRef/g) ?? []).length).toBe(2); // main + repair executors
    expect(deliverSrc).toContain('writeAllowlistRef: agentic ? sharedWriteAllowlistRef : undefined'); // loopConfig
  });

  it('the authoring path notes gate timeouts distinctly and asks for a leaner script (U4)', () => {
    expect(selfGateSrc).toContain('TIMED OUT');
    expect(selfGateSrc).toContain('leaner script');
  });
});
