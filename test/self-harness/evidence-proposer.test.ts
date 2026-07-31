import { describe, it, expect } from 'vitest';
import {
  proposeFromEvidence,
  evidenceProposer,
  combineProposers,
} from '../../src/self-harness/evidence-proposer.js';
import type { EvidenceSummary } from '../../src/telemetry/tool-calls.js';
import type { HarnessProfile } from '../../src/self-harness/profile.js';
import type { Proposer } from '../../src/self-harness/propose.js';

const PROFILE: HarnessProfile = {
  env: {},
  scaffold: {},
  middleware: {},
  tool: { UAP_READ_WINDOW_BYTES: '8000', UAP_EDIT_TOLERANT: '1', UAP_EDIT_DIAGNOSTICS: '1' },
};

function summary(edit: Partial<EvidenceSummary['editHealth']>, extra: Partial<EvidenceSummary> = {}): EvidenceSummary {
  const editHealth = {
    attempts: 0, exact: 0, tolerant: 0, misses: 0, ambiguous: 0, successRate: 1,
    ...edit,
  };
  return {
    totalCalls: editHealth.attempts,
    failedCalls: editHealth.misses,
    failureRate: 0,
    byComponent: [],
    topFailures: [],
    editHealth,
    ...extra,
  };
}

describe('proposeFromEvidence — the D→B connection', () => {
  it('stays silent below the evidence threshold', () => {
    // Acting on 3 edits would burn a full paired bench on noise.
    const mods = proposeFromEvidence(summary({ attempts: 3, misses: 3, successRate: 0 }), PROFILE);
    expect(mods).toEqual([]);
  });

  it('widens the read window when anchors miss outright', () => {
    const mods = proposeFromEvidence(
      summary({ attempts: 20, exact: 10, misses: 10, successRate: 0.5 }),
      PROFILE,
    );
    expect(mods).toContainEqual({
      kind: 'tool',
      key: 'UAP_READ_WINDOW_BYTES',
      from: '8000',
      to: '16000',
    });
  });

  it('proposes turning diagnostics OFF as the counter-hypothesis when misses dominate', () => {
    // The nearest-region report costs context on every miss; if it is not
    // converting misses into successes it is overhead, and that is measurable.
    const mods = proposeFromEvidence(
      summary({ attempts: 20, exact: 6, misses: 14, successRate: 0.3 }),
      PROFILE,
    );
    expect(mods).toContainEqual({ kind: 'tool', key: 'UAP_EDIT_DIAGNOSTICS', from: '1', to: '0' });
  });

  it('proposes testing tolerance OFF when most edits only land through it', () => {
    const mods = proposeFromEvidence(
      summary({ attempts: 20, exact: 5, tolerant: 15, misses: 0, successRate: 1 }),
      PROFILE,
    );
    expect(mods).toContainEqual({ kind: 'tool', key: 'UAP_EDIT_TOLERANT', from: '1', to: '0' });
  });

  it('proposes nothing when the edit surface is healthy', () => {
    const mods = proposeFromEvidence(
      summary({ attempts: 40, exact: 39, tolerant: 1, misses: 0, successRate: 1 }),
      PROFILE,
    );
    expect(mods).toEqual([]);
  });

  it('raises the round cap when calls are timing out', () => {
    const mods = proposeFromEvidence(
      summary({ attempts: 20, exact: 20, successRate: 1 }, {
        topFailures: [{ component: 'execution', tool: 'run_bash', outcome: 'timeout', count: 5 }],
      }),
      { ...PROFILE, tool: { ...PROFILE.tool, UAP_MAX_TOOL_ROUNDS: '12' } },
    );
    expect(mods).toContainEqual({ kind: 'tool', key: 'UAP_MAX_TOOL_ROUNDS', from: '12', to: '18' });
  });

  it('never emits a knob outside its declared safe range', () => {
    const maxed: HarnessProfile = { ...PROFILE, tool: { UAP_READ_WINDOW_BYTES: '32000' } };
    const mods = proposeFromEvidence(
      summary({ attempts: 20, exact: 5, misses: 15, successRate: 0.25 }),
      maxed,
    );
    // Already at the ceiling — doubling would be out of range, so no Mod at all.
    expect(mods.find((m) => m.kind === 'tool' && m.key === 'UAP_READ_WINDOW_BYTES')).toBeUndefined();
  });
});

describe('evidenceProposer / combineProposers', () => {
  it('reads an injected summary rather than the live database', () => {
    const p = evidenceProposer({
      summary: summary({ attempts: 20, exact: 10, misses: 10, successRate: 0.5 }),
    });
    expect(p.id).toBe('evidence');
    expect(p.propose([], PROFILE).length).toBeGreaterThan(0);
  });

  it('merges proposers and de-duplicates structurally identical Mods', () => {
    const one: Proposer = {
      id: 'a',
      propose: () => [{ kind: 'env', key: 'LLAMA_N_PREDICT', from: '8192', to: '4096' }],
    };
    const two: Proposer = {
      id: 'b',
      propose: () => [
        { kind: 'env', key: 'LLAMA_N_PREDICT', from: '8192', to: '4096' },
        { kind: 'tool', key: 'UAP_EDIT_TOLERANT', from: '1', to: '0' },
      ],
    };
    const merged = combineProposers('merged', [one, two]);
    expect(merged.propose([], PROFILE)).toHaveLength(2);
  });
});
