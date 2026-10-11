/**
 * C2 — per-leaf model dials: the PRODUCTION phase→task projection (the seam
 * a green runner test once bypassed while dials died two hops upstream), the
 * plan-time lint, and the fail-closed preset lookup (prototype-chain keys
 * must degrade to the mission model, never bind an unpinned one).
 */

import { describe, it, expect } from 'vitest';
import { ModelPresets } from '../../src/models/types.js';
import { projectPhaseToTask, warnUnknownDials, resolveDialOrWarn } from '../../src/cli/deliver.js';
import type { DeliveryPhase } from '../../src/delivery/decompose.js';

const phase = (over: Partial<DeliveryPhase> = {}): DeliveryPhase => ({
  id: 'p',
  title: 'P',
  goal: 'build p',
  ...over,
});

/** Capture console.log; the warnings are the feature's observable surface. */
function captureWarn(fn: () => void): string {
  let out = '';
  const orig = console.log;
  console.log = (s?: unknown) => {
    out += String(s);
  };
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return out;
}

describe('projectPhaseToTask (the production phase→task seam)', () => {
  it('threads the dial — the field the projection once dropped', () => {
    // Architect review blocker: seam-injected runner tests bypass this map,
    // so the runner wiring stayed green while dials died here.
    expect(projectPhaseToTask(phase({ model: 'qwen38-coder390' })).model).toBe('qwen38-coder390');
  });

  it('threads deps and leaves absent fields absent (not undefined-valued)', () => {
    const t = projectPhaseToTask(phase({ deps: ['a'] }));
    expect(t.deps).toEqual(['a']);
    expect('model' in t).toBe(false); // keeps persist round-trips clean
  });
});

describe('resolveDialOrWarn (fail-closed preset lookup)', () => {
  it('resolves a known preset', () => {
    const key = Object.keys(ModelPresets)[0]!;
    expect(resolveDialOrWarn(key, 't1')).toBe(ModelPresets[key]);
  });

  it('degrades unknown keys to undefined — warn, then the mission model', () => {
    const out = captureWarn(() => {
      expect(resolveDialOrWarn('no-such-preset', 't2')).toBeUndefined();
    });
    expect(out).toContain("model dial 'no-such-preset'");
  });

  it('degrades prototype-chain keys — the security review finding', () => {
    // `ModelPresets['constructor']` is truthy (inherited from Object); a bare
    // lookup let planner-emitted text bind an unpinned model with no warning.
    for (const hostile of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(resolveDialOrWarn(hostile, 't3')).toBeUndefined();
    }
  });
});

describe('warnUnknownDials (plan-time lint)', () => {
  const known = Object.keys(ModelPresets)[0]!;

  it('warns at mission start for unknown dials (not hours later at bind time)', () => {
    const out = captureWarn(() => {
      warnUnknownDials([phase({ id: 'a', model: 'typo-key' }), phase({ id: 'b' })], true);
    });
    expect(out).toContain("phase 'a' model dial 'typo-key' is not a known preset");
  });

  it('warns that the phased runner ignores dials entirely', () => {
    const out = captureWarn(() => {
      warnUnknownDials([phase({ id: 'a', model: known })], false);
    });
    expect(out).toContain('ignored by the phased runner');
  });

  it('is silent for known dials on the orchestrated path', () => {
    expect(captureWarn(() => warnUnknownDials([phase({ id: 'a', model: known })], true))).toBe('');
  });
});
