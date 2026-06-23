import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  MemoryTransferStore,
  JsonTransferStore,
  makeTransferProposer,
  makeEntry,
  dedupeMods,
  modKey,
} from '../src/self-harness/transfer.js';
import { heuristicProposer } from '../src/self-harness/propose.js';
import { signatureHash } from '../src/self-harness/weakness.js';
import type { Mod } from '../src/self-harness/mods.js';
import type { WeaknessReport } from '../src/self-harness/weakness.js';
import type { HarnessProfile } from '../src/self-harness/profile.js';

const NORMALIZER_MOD: Mod = { kind: 'middleware', id: 'toolcall-path-normalizer', params: { enabled: true } };
const EMPTY_PROFILE: HarnessProfile = { env: {}, scaffold: {}, middleware: {} };

function pathGarbleWeakness(model: string): WeaknessReport {
  return {
    signature: signatureHash({ kind: 'toolcall.path.garbled', model }),
    kind: 'toolcall.path.garbled',
    model,
    frequency: 56,
    affectedTasks: ['js-title-case'],
    hypothesis: 'path garbling',
    evidence: [],
  };
}

describe('transfer — modKey + dedupe', () => {
  it('de-dupes structurally identical Mods', () => {
    const a: Mod = { kind: 'env', key: 'LLAMA_N_PREDICT', from: '8192', to: '4096' };
    const b: Mod = { kind: 'env', key: 'LLAMA_N_PREDICT', from: '0', to: '4096' };
    expect(modKey(a)).toBe(modKey(b)); // keyed by target, not prior
    expect(dedupeMods([a, b, NORMALIZER_MOD])).toHaveLength(2);
  });
});

describe('transfer store — cross-model query', () => {
  it('returns accepted Mods for the kind on OTHER models, ranked by delta', () => {
    const store = new MemoryTransferStore();
    store.record(makeEntry({
      signature: 's1', kind: 'toolcall.path.garbled', model: 'qwen3.6-35b-a3b',
      mod: NORMALIZER_MOD, delta: 0.05, accepted: true, validatedAt: 't', provenance: 'A/B net+1',
    }));
    // query for a DIFFERENT model family → transfer hit
    const hits = store.query('toolcall.path.garbled', { excludeModel: 'qwen3.7-40b-a4b' });
    expect(hits).toHaveLength(1);
    expect(hits[0].mod).toEqual(NORMALIZER_MOD);
    // query excluding the SAME model → no hit (already validated there)
    expect(store.query('toolcall.path.garbled', { excludeModel: 'Qwen3.6-35B-A3B-IQ4_XS' })).toHaveLength(0);
  });

  it('excludes rejected Mods by default (known-bad not re-proposed)', () => {
    const store = new MemoryTransferStore();
    store.record(makeEntry({
      signature: 's', kind: 'verify.fail', model: 'm1',
      mod: { kind: 'scaffold', component: 'gates', op: 'append', text: 'x' },
      delta: -0.1, accepted: false, validatedAt: 't', provenance: 'rejected',
    }));
    expect(store.query('verify.fail', { excludeModel: 'm2' })).toHaveLength(0);
    expect(store.query('verify.fail', { excludeModel: 'm2', acceptedOnly: false })).toHaveLength(1);
  });
});

describe('transfer proposer — seeds a fix mined on another model', () => {
  it('proposes the normalizer for a NEW model from a prior Qwen3.6 acceptance', () => {
    const store = new MemoryTransferStore();
    // Accepted on Qwen3.6 (as in the real P2 A/B).
    store.record(makeEntry({
      signature: 's', kind: 'toolcall.path.garbled', model: 'qwen3.6-35b-a3b',
      mod: NORMALIZER_MOD, delta: 0.05, accepted: true, validatedAt: 't', provenance: 'A/B',
    }));
    const proposer = makeTransferProposer(store, heuristicProposer);
    // New model hits the same kind → transferred prior seeded first.
    const mods = proposer.propose([pathGarbleWeakness('glm-5')], EMPTY_PROFILE);
    expect(mods[0]).toEqual(NORMALIZER_MOD);
    expect(proposer.id).toBe('transfer+heuristic');
  });

  it('does not double-propose when base would emit the same Mod', () => {
    const store = new MemoryTransferStore();
    store.record(makeEntry({
      signature: 's', kind: 'toolcall.path.garbled', model: 'qwen3.6-35b-a3b',
      mod: NORMALIZER_MOD, delta: 0.05, accepted: true, validatedAt: 't', provenance: 'A/B',
    }));
    const proposer = makeTransferProposer(store, heuristicProposer);
    // Same model family as the stored entry: transfer excludes it, base emits it → exactly one.
    const mods = proposer.propose([pathGarbleWeakness('qwen3.6-35b-a3b')], EMPTY_PROFILE);
    expect(mods.filter((m) => m.kind === 'middleware')).toHaveLength(1);
  });
});

describe('transfer store — JSON persistence', () => {
  it('round-trips entries to disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sh-tx-'));
    const path = join(dir, 'transfer.json');
    const s1 = new JsonTransferStore(path);
    s1.record(makeEntry({
      signature: 's', kind: 'toolcall.path.garbled', model: 'qwen3.6-35b-a3b',
      mod: NORMALIZER_MOD, delta: 0.05, accepted: true, validatedAt: 't', provenance: 'A/B',
    }));
    const s2 = new JsonTransferStore(path); // reload
    expect(s2.all()).toHaveLength(1);
    expect(s2.query('toolcall.path.garbled', { excludeModel: 'other' })[0].mod).toEqual(NORMALIZER_MOD);
    rmSync(dir, { recursive: true, force: true });
  });
});
