import { describe, it, expect } from 'vitest';
import {
  validateMod,
  describeMod,
  invertMod,
  isKnownKnob,
  KNOB_ALLOWLIST,
  type Mod,
} from '../src/self-harness/mods.js';
import {
  signatureHash,
  normalizeModel,
  rankWeaknesses,
  isFailureKind,
  type WeaknessReport,
} from '../src/self-harness/weakness.js';

describe('Mod DSL — env knob validation', () => {
  it('accepts an in-range allow-listed knob', () => {
    const m: Mod = { kind: 'env', key: 'LLAMA_N_PREDICT', from: '8192', to: '4096' };
    expect(validateMod(m)).toEqual({ ok: true });
  });

  it('rejects an out-of-range value', () => {
    const m: Mod = { kind: 'env', key: 'LLAMA_N_PREDICT', from: '8192', to: '999999' };
    const r = validateMod(m);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/out of safe range/);
  });

  it('rejects a non-integer for an integer knob', () => {
    const m: Mod = { kind: 'env', key: 'PROXY_HARD_FINALIZE_TURNS', from: '40', to: '40.5' };
    expect(validateMod(m).ok).toBe(false);
  });

  it('rejects a non-allow-listed (dangerous) knob', () => {
    // LLAMA_CTX_SIZE must never be reachable by the autonomous loop.
    const m = { kind: 'env', key: 'LLAMA_CTX_SIZE', from: '184320', to: '262144' } as unknown as Mod;
    const r = validateMod(m);
    expect(r.ok).toBe(false);
    expect(isKnownKnob('LLAMA_CTX_SIZE')).toBe(false);
    expect(isKnownKnob('LLAMA_N_PREDICT')).toBe(true);
  });

  it('every allow-listed knob excludes model/ctx/KV/spec', () => {
    for (const k of Object.keys(KNOB_ALLOWLIST)) {
      expect(k).not.toMatch(/MODEL|CTX_SIZE|CACHE_TYPE|SPEC_TYPE|GPU_LAYERS/);
    }
  });
});

describe('Mod DSL — scaffold + middleware validation', () => {
  it('accepts a scaffold replace on a real component', () => {
    const m: Mod = { kind: 'scaffold', component: 'gates', op: 'replace', text: 'do X then stop' };
    expect(validateMod(m)).toEqual({ ok: true });
  });
  it('rejects an unknown component', () => {
    const m = { kind: 'scaffold', component: 'nope', op: 'append', text: 'x' } as unknown as Mod;
    expect(validateMod(m).ok).toBe(false);
  });
  it('accepts the path-normalizer middleware, rejects unknown ids', () => {
    expect(validateMod({ kind: 'middleware', id: 'toolcall-path-normalizer', params: {} }).ok).toBe(true);
    expect(validateMod({ kind: 'middleware', id: 'rm-rf', params: {} } as unknown as Mod).ok).toBe(false);
  });
});

describe('Mod DSL — describe + invert (reversibility)', () => {
  it('inverts an env mod by swapping from/to', () => {
    const m: Mod = { kind: 'env', key: 'LLAMA_N_PREDICT', from: '8192', to: '4096' };
    expect(invertMod(m)).toEqual({ kind: 'env', key: 'LLAMA_N_PREDICT', from: '4096', to: '8192' });
  });
  it('describes each kind on one line', () => {
    expect(describeMod({ kind: 'env', key: 'LLAMA_N_PREDICT', from: '8192', to: '4096' })).toContain('->');
    expect(describeMod({ kind: 'middleware', id: 'toolcall-path-normalizer', params: { strict: true } })).toContain('toolcall-path-normalizer');
  });
});

describe('Weakness — stable signature hashing', () => {
  it('is deterministic and stable for the same failure', () => {
    const a = signatureHash({ kind: 'toolcall.path.garbled', model: 'Qwen3.6-35B-A3B-UD-IQ4_XS' });
    const b = signatureHash({ kind: 'toolcall.path.garbled', model: 'qwen3.6-35b-a3b' });
    expect(a).toBe(b); // quant/format suffixes normalized away
    expect(a).toHaveLength(16);
  });
  it('differs by kind and by detail', () => {
    const base = signatureHash({ kind: 'toolcall.path.garbled', model: 'qwen3.6-35b-a3b' });
    const otherKind = signatureHash({ kind: 'gen.runaway.npredict', model: 'qwen3.6-35b-a3b' });
    const withDetail = signatureHash({ kind: 'toolcall.path.garbled', model: 'qwen3.6-35b-a3b', detail: 'Write' });
    expect(otherKind).not.toBe(base);
    expect(withDetail).not.toBe(base);
  });
  it('normalizes model id to a family key', () => {
    expect(normalizeModel('Qwen3.6-35B-A3B-UD-IQ4_XS')).toBe(normalizeModel('Qwen3.6-35B-A3B-MTP'));
  });
  it('validates failure kinds', () => {
    expect(isFailureKind('toolcall.path.garbled')).toBe(true);
    expect(isFailureKind('made.up')).toBe(false);
  });
});

describe('Weakness — ranking by frequency x impact', () => {
  it('ranks higher frequency*affected first', () => {
    const mk = (sig: string, freq: number, tasks: number): WeaknessReport => ({
      signature: sig, kind: 'verify.fail', model: 'm', frequency: freq,
      affectedTasks: Array.from({ length: tasks }, (_, i) => `t${i}`),
      hypothesis: '', evidence: [],
    });
    const ranked = rankWeaknesses([mk('a', 2, 1), mk('b', 5, 3), mk('c', 1, 10)]);
    expect(ranked[0].signature).toBe('b'); // 5*3=15 > 1*10=10 > 2*1=2
    expect(ranked[1].signature).toBe('c');
  });
});
