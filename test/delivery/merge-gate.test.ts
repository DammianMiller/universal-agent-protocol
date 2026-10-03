/**
 * Deterministic merge gate (Choir-uplift PR 2): provenance / statement
 * immutability, green recompute (evidence-artifact tier + run-state history
 * tier), sorry-delta (stub + apology markers with test/docs exemptions),
 * axiom-honesty (gate-infra tampering INCLUDING deletions and renames),
 * marker extraction, unified-diff parsing (deletion/rename/binary/header
 * collisions), and the end-to-end gatePr path the merge queue calls.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { MissionDatabase, getMissionDbPath } from '../../src/mission/database.js';
import { createMission, linkRun, proposeSalvage, replanAcceptance } from '../../src/mission/ledger.js';
import { saveRunState, type DeliverRunState } from '../../src/delivery/run-state.js';
import {
  evaluateMergeGate,
  missionMarkerOf,
  parseUnifiedDiff,
  type GateEvidenceCheck,
  type MergeGateInputs,
} from '../../src/delivery/merge-gate.js';
import { gatePr, readEvidenceArtifact, validateBaseRef } from '../../src/cli/merge-gate.js';

// ── pure decision core ──────────────────────────────────────────────────

const GREEN_ARTIFACT: GateEvidenceCheck = {
  present: true,
  gatesAllZero: true,
  hatchesEmpty: true,
  shaMatches: true,
  expectedSha: 'c0ffee1234567890abcd',
};

/** Production delivered shape: checkpoint cleared on success, so the
 *  evidence artifact is the recorded evidence. */
function greenInputs(overrides: Partial<MergeGateInputs> = {}): MergeGateInputs {
  return {
    missionId: 1,
    acceptanceHash8: 'abcd1234',
    markerHash8: 'abcd1234',
    ledgerIntact: true,
    runState: { status: 'delivered', history: [], phaseSummaries: ['all criteria verified'] },
    evidence: GREEN_ARTIFACT,
    openSalvageCount: 0,
    changedFiles: [{ path: 'src/widget.ts', addedText: 'export function widget() { return 1; }\n' }],
    ...overrides,
  };
}

describe('evaluateMergeGate — provenance / statement immutability', () => {
  it('passes a fully green mission with all four findings ok', () => {
    const r = evaluateMergeGate(greenInputs());
    expect(r.pass).toBe(true);
    expect(r.findings).toHaveLength(4);
    expect(r.findings.every((f) => f.ok)).toBe(true);
    expect(r.findings.find((f) => f.check === 'green-recompute')?.detail).toContain('evidence artifact');
  });

  it('fails when no marker ties the work to frozen acceptance', () => {
    const r = evaluateMergeGate(greenInputs({ markerHash8: undefined }));
    expect(r.pass).toBe(false);
    expect(r.findings.find((f) => f.check === 'provenance')?.ok).toBe(false);
  });

  it('fails a marker hash superseded by a replan', () => {
    const r = evaluateMergeGate(greenInputs({ markerHash8: 'feedface' }));
    const p = r.findings.find((f) => f.check === 'provenance');
    expect(p?.ok).toBe(false);
    expect(p?.detail).toContain('superseded');
  });

  it('fails when the ledger itself was hand-edited (hash mismatch)', () => {
    const r = evaluateMergeGate(greenInputs({ ledgerIntact: false }));
    const p = r.findings.find((f) => f.check === 'provenance');
    expect(p?.ok).toBe(false);
    expect(p?.detail).toContain('tampered');
  });
});

describe('evaluateMergeGate — green recompute (evidence-artifact tier)', () => {
  it('fails when the artifact is missing and there is no recorded history', () => {
    const r = evaluateMergeGate(
      greenInputs({ evidence: { ...GREEN_ARTIFACT, present: false } })
    );
    const g = r.findings.find((f) => f.check === 'green-recompute');
    expect(g?.ok).toBe(false);
    expect(g?.detail).toContain('no gate-evidence artifact');
    expect(g?.detail).toContain('beyond the delivered status');
  });

  it('fails when the artifact is bound to a different candidate sha', () => {
    const r = evaluateMergeGate(greenInputs({ evidence: { ...GREEN_ARTIFACT, shaMatches: false } }));
    expect(r.findings.find((f) => f.check === 'green-recompute')?.detail).toContain('different candidate sha');
    expect(r.pass).toBe(false);
  });

  it('fails when the artifact records gate-affecting hatches', () => {
    const r = evaluateMergeGate(greenInputs({ evidence: { ...GREEN_ARTIFACT, hatchesEmpty: false } }));
    expect(r.findings.find((f) => f.check === 'green-recompute')?.detail).toContain('hatches');
    expect(r.pass).toBe(false);
  });

  it('fails when the artifact records a non-zero gate exit', () => {
    const r = evaluateMergeGate(greenInputs({ evidence: { ...GREEN_ARTIFACT, gatesAllZero: false } }));
    expect(r.findings.find((f) => f.check === 'green-recompute')?.detail).toContain('non-zero gate exit');
    expect(r.pass).toBe(false);
  });

  it('passes on the history tier when the caller did not check the artifact', () => {
    const r = evaluateMergeGate(
      greenInputs({
        evidence: null,
        runState: { status: 'delivered', history: [{ passed: true }] },
      })
    );
    expect(r.findings.find((f) => f.check === 'green-recompute')?.ok).toBe(true);
  });

  it('fails when the final recorded iteration failed its gates', () => {
    const r = evaluateMergeGate(
      greenInputs({
        evidence: null,
        runState: { status: 'delivered', history: [{ passed: true }, { passed: false }] },
      })
    );
    expect(r.findings.find((f) => f.check === 'green-recompute')?.ok).toBe(false);
  });

  it('fails when the final acceptance judge met less than all criteria', () => {
    const r = evaluateMergeGate(
      greenInputs({
        evidence: null,
        runState: { status: 'delivered', history: [{ passed: true, acceptanceMet: 0.8 }] },
      })
    );
    const g = r.findings.find((f) => f.check === 'green-recompute');
    expect(g?.ok).toBe(false);
    expect(g?.detail).toContain('80%');
  });

  it('fails when the fresh run state is not delivered', () => {
    const r = evaluateMergeGate(greenInputs({ runState: { status: 'failed' } }));
    const g = r.findings.find((f) => f.check === 'green-recompute');
    expect(g?.ok).toBe(false);
    expect(g?.detail).toContain("'failed'");
  });

  it('strips terminal escapes from the untrusted status string', () => {
    const r = evaluateMergeGate(
      greenInputs({ runState: { status: 'failed\u001b]2;pwned' as never, history: [] } })
    );
    const g = r.findings.find((f) => f.check === 'green-recompute');
    expect(g?.ok).toBe(false);
    expect(g?.detail).toContain("run state is 'failed]2;pwned'");
    expect(g?.detail).not.toContain('\u001b');
  });

  it('fails on a run pid that does not match the pid the orchestrator spawned', () => {
    const r = evaluateMergeGate(greenInputs({ pidCorroborated: false }));
    expect(r.findings.find((f) => f.check === 'green-recompute')?.detail).toContain('pid');
    expect(r.pass).toBe(false);
  });

  it('fails when there is no linked run', () => {
    const r = evaluateMergeGate(greenInputs({ runState: null }));
    expect(r.findings.find((f) => f.check === 'green-recompute')?.ok).toBe(false);
  });

  it('fails while a salvage proposal awaits its ruling', () => {
    const r = evaluateMergeGate(greenInputs({ openSalvageCount: 2 }));
    const g = r.findings.find((f) => f.check === 'green-recompute');
    expect(g?.ok).toBe(false);
    expect(g?.detail).toContain('salvage');
  });
});

describe('evaluateMergeGate — sorry-delta', () => {
  it('flags a TODO marker added to a production file', () => {
    const r = evaluateMergeGate(
      greenInputs({ changedFiles: [{ path: 'src/feature.ts', addedText: '+ // TODO: finish this\n' }] })
    );
    const s = r.findings.find((f) => f.check === 'sorry-delta');
    expect(s?.ok).toBe(false);
    expect(s?.detail).toContain('src/feature.ts');
  });

  it('ignores stub markers in test files (seams are stubbed by design)', () => {
    const r = evaluateMergeGate(
      greenInputs({
        changedFiles: [{ path: 'test/feature.test.ts', addedText: 'const stub = stubSeams(); // TODO\n' }],
      })
    );
    expect(r.findings.find((f) => f.check === 'sorry-delta')?.ok).toBe(true);
  });

  it('ignores stub markers in docs files (they quote the markers they describe)', () => {
    const r = evaluateMergeGate(
      greenInputs({ changedFiles: [{ path: 'docs/guide.md', addedText: 'Never ship a TODO marker.\n' }] })
    );
    expect(r.findings.find((f) => f.check === 'sorry-delta')?.ok).toBe(true);
  });

  it('skips adversarial long lines instead of scanning them (ReDoS cap)', () => {
    const longLine = '+ ' + 'a'.repeat(9000) + ' TODO ship it';
    const r = evaluateMergeGate(
      greenInputs({ changedFiles: [{ path: 'src/blob.ts', addedText: longLine + '\n+ TODO normal line\n' }] })
    );
    const s = r.findings.find((f) => f.check === 'sorry-delta');
    expect(s?.ok).toBe(false); // the normal line still trips
    expect(s?.detail).toContain('TODO marker');
  });

  it('ignores markers on removed lines (deleting a TODO is progress)', () => {
    const r = evaluateMergeGate(
      greenInputs({ changedFiles: [{ path: 'src/feature.ts', addedText: '' }] })
    );
    expect(r.findings.find((f) => f.check === 'sorry-delta')?.ok).toBe(true);
  });

  it('flags apology phrasing in the run summaries', () => {
    const r = evaluateMergeGate(
      greenInputs({ runState: { status: 'delivered', history: [], phaseSummaries: ['sorry, I could not finish phase 2'] } })
    );
    const s = r.findings.find((f) => f.check === 'sorry-delta');
    expect(s?.ok).toBe(false);
    expect(s?.detail).toContain('run summaries');
  });

  it('flags apology text added to a file', () => {
    const r = evaluateMergeGate(
      greenInputs({
        changedFiles: [{ path: 'docs/report.md', addedText: 'I was unable to complete the migration\n' }],
      })
    );
    expect(r.findings.find((f) => f.check === 'sorry-delta')?.ok).toBe(false);
  });
});

describe('evaluateMergeGate — axiom-honesty (gate-infra tampering)', () => {
  it('flags a diff touching enforcer hooks', () => {
    const r = evaluateMergeGate(
      greenInputs({ changedFiles: [{ path: '.codex/hooks/session-start.sh', addedText: 'echo hi\n' }] })
    );
    const a = r.findings.find((f) => f.check === 'axiom-honesty');
    expect(a?.ok).toBe(false);
    expect(a?.detail).toContain('.codex/hooks/session-start.sh');
  });

  it('flags a diff touching the merge gate itself, its evidence gatherer, or the ledger', () => {
    for (const path of [
      'src/delivery/merge-gate.ts',
      'src/cli/merge-gate.ts',
      'src/mission/ledger.ts',
      'src/delivery/gate-evidence.ts',
    ]) {
      const r = evaluateMergeGate(greenInputs({ changedFiles: [{ path, addedText: 'return true;\n' }] }));
      expect(r.findings.find((f) => f.check === 'axiom-honesty')?.ok, path).toBe(false);
    }
  });

  it('flags a DELETED gate-infra file (path captured with no added lines)', () => {
    const r = evaluateMergeGate(
      greenInputs({ changedFiles: [{ path: '.uap/quality-baseline.json', addedText: '' }] })
    );
    expect(r.findings.find((f) => f.check === 'axiom-honesty')?.ok).toBe(false);
  });

  it('flags the quality baseline and the version-bump script', () => {
    for (const path of ['.uap/quality-baseline.json', 'scripts/version-bump.sh']) {
      const r = evaluateMergeGate(greenInputs({ changedFiles: [{ path, addedText: '{}' }] }));
      expect(r.findings.find((f) => f.check === 'axiom-honesty')?.ok).toBe(false);
    }
  });

  it('allows acknowledged gate-infra changes', () => {
    const r = evaluateMergeGate(
      greenInputs({
        changedFiles: [{ path: '.codex/hooks/session-start.sh', addedText: 'echo hi\n' }],
        allowGateInfra: true,
      })
    );
    const a = r.findings.find((f) => f.check === 'axiom-honesty');
    expect(a?.ok).toBe(true);
    expect(a?.detail).toContain('acknowledged');
  });

  it('reports every failed check together, not first-fail only', () => {
    const r = evaluateMergeGate(
      greenInputs({
        markerHash8: 'deadbeef',
        runState: null,
        changedFiles: [{ path: '.codex/hooks/x.sh', addedText: 'x\n' }],
      })
    );
    const failed = r.findings.filter((f) => !f.ok);
    expect(failed.map((f) => f.check)).toEqual(['provenance', 'green-recompute', 'axiom-honesty']);
  });
});

// ── marker extraction ───────────────────────────────────────────────────

describe('missionMarkerOf', () => {
  it('extracts the prefix-pinned marker from title or body text', () => {
    expect(missionMarkerOf('feat: thing [mission:#3:abcd1234] done')).toEqual({
      missionId: 3,
      hash8: 'abcd1234',
    });
  });

  it('rejects absent, malformed, and non-hex markers', () => {
    expect(missionMarkerOf('no marker here')).toBeNull();
    expect(missionMarkerOf('[mission:#3:abcd123]')).toBeNull(); // 7 chars
    expect(missionMarkerOf('[mission:#3:zzzzzzzz]')).toBeNull(); // non-hex
    expect(missionMarkerOf('mission:#3:abcd1234')).toBeNull(); // no brackets
  });
});

// ── diff parsing ────────────────────────────────────────────────────────

describe('parseUnifiedDiff', () => {
  it('captures only the ADDED lines of each changed file', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,3 @@',
      ' context line',
      '-removed TODO line',
      '+added line one',
      '+added line two',
      'diff --git a/src/b.ts b/src/b.ts',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -1 +1 @@',
      '+only in b',
    ].join('\n');
    const files = parseUnifiedDiff(diff);
    expect(files.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(files[0].addedText).toBe('added line one\nadded line two\n');
    expect(files[1].addedText).toBe('only in b\n');
  });

  it('captures the path of a DELETED file (axiom-honesty evidence)', () => {
    const diff = [
      'diff --git a/.uap/quality-baseline.json b/.uap/quality-baseline.json',
      'deleted file mode 100644',
      '--- a/.uap/quality-baseline.json',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-{}',
    ].join('\n');
    const files = parseUnifiedDiff(diff);
    expect(files.map((f) => f.path)).toContain('.uap/quality-baseline.json');
    expect(files.find((f) => f.path === '.uap/quality-baseline.json')?.addedText).toBe('');
    expect(files.some((f) => f.path === '/dev/null')).toBe(false);
  });

  it('captures BOTH sides of a pure rename (no +++ header at all)', () => {
    const diff = [
      'diff --git a/src/delivery/merge-gate.ts b/src/moved/gate.ts',
      'similarity index 100%',
      'rename from src/delivery/merge-gate.ts',
      'rename to src/moved/gate.ts',
    ].join('\n');
    const paths = parseUnifiedDiff(diff).map((f) => f.path).sort();
    expect(paths).toEqual(['src/delivery/merge-gate.ts', 'src/moved/gate.ts']);
  });

  it('registers binary files from the diff --git header', () => {
    const diff = [
      'diff --git a/.codex/hooks/enforce.bin b/.codex/hooks/enforce.bin',
      'Binary files a/.codex/hooks/enforce.bin and b/.codex/hooks/enforce.bin differ',
    ].join('\n');
    expect(parseUnifiedDiff(diff).map((f) => f.path)).toEqual(['.codex/hooks/enforce.bin']);
  });

  it('does not misread an added content line that looks like a +++ header', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1,2 @@',
      '+first added',
      '+++ b/.codex/hooks/fake.sh',
      '+second added',
    ].join('\n');
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('src/a.ts');
    // The line survives as CONTENT (its raw form minus one `+`).
    expect(files[0].addedText).toContain('++ b/.codex/hooks/fake.sh');
    expect(files[0].addedText).toContain('second added');
  });

  it('handles diffs that only delete lines', () => {
    const diff = ['--- a/src/gone.ts', '+++ b/src/gone.ts', '@@ -1 +0,0 @@', '-removed'].join('\n');
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].addedText).toBe('');
  });
});

// ── base ref validation ──────────────────────────────────────────────────

describe('validateBaseRef', () => {
  it('accepts plain refs and rejects option-shaped or metacharacter refs', () => {
    expect(validateBaseRef('master')).toBe('master');
    expect(validateBaseRef('origin/master')).toBe('origin/master');
    expect(validateBaseRef('release/1.2')).toBe('release/1.2');
    expect(validateBaseRef('--output=/tmp/x')).toBeNull();
    expect(validateBaseRef('a;rm')).toBeNull();
    expect(validateBaseRef('')).toBeNull();
  });
});

// ── gatePr — the path the merge queue calls ─────────────────────────────

let root: string;
let db: Database.Database;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'uap-merge-gate-'));
  MissionDatabase.resetInstance();
  db = MissionDatabase.getInstance(getMissionDbPath(root)).getDatabase();
});

afterEach(() => {
  MissionDatabase.resetInstance();
  rmSync(root, { recursive: true, force: true });
});

function deliveredState(overrides: Partial<DeliverRunState> = {}): DeliverRunState {
  const runId = 'run-20260917t000000-abcdef';
  return {
    runId,
    instruction: '[mission:#1:marker] do the thing',
    presetId: 'default',
    projectRoot: root,
    status: 'delivered',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    // Production delivered shape: deliver CLEARS the checkpoint on success,
    // so the evidence artifact (not run history) is the recorded evidence.
    ...overrides,
  };
}

function writeArtifact(sha: string, gates: Array<{ name: string; exitCode: number }> = [{ name: 'build', exitCode: 0 }]): void {
  mkdirSync(join(root, '.uap', 'evidence'), { recursive: true });
  writeFileSync(
    join(root, '.uap', 'evidence', `${sha}.json`),
    JSON.stringify({
      version: 1,
      candidateSha: sha,
      recordedAt: new Date().toISOString(),
      hatches: [],
      gates: gates.map((g) => ({ name: g.name, command: g.name, exitCode: g.exitCode, outputTail: '', at: new Date().toISOString() })),
    }),
    'utf-8'
  );
}

const CLEAN_DIFF = [
  'diff --git a/src/x.ts b/src/x.ts',
  '--- a/src/x.ts',
  '+++ b/src/x.ts',
  '@@ -1 +1 @@',
  '+export const done = true;',
].join('\n');

const HEAD = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

describe('gatePr (integration)', () => {
  it('returns gate:none without fetching the diff when no marker', () => {
    let fetched = 0;
    const r = gatePr(root, 'feat: unrelated work', () => { fetched++; return CLEAN_DIFF; }, false);
    expect(r).toEqual({ gate: 'none' });
    expect(fetched).toBe(0);
  });

  it('passes a delivered mission with matching marker, artifact, and clean diff', () => {
    const m = createMission(db, { goal: 'g', acceptance: 'all criteria' });
    const state = deliveredState();
    saveRunState(state);
    linkRun(db, m.id, state.runId);
    writeArtifact(HEAD);
    const body = `Closes the work [mission:#${m.id}:${m.acceptanceHash.slice(0, 8)}]`;
    expect(gatePr(root, body, () => CLEAN_DIFF, false, HEAD)).toEqual({ gate: 'pass' });
  });

  it('fails green-recompute when no artifact exists for the PR head and no history was recorded', () => {
    const m = createMission(db, { goal: 'g', acceptance: 'all criteria' });
    const state = deliveredState();
    saveRunState(state);
    linkRun(db, m.id, state.runId);
    const body = `[mission:#${m.id}:${m.acceptanceHash.slice(0, 8)}]`;
    const r = gatePr(root, body, () => CLEAN_DIFF, false, HEAD);
    expect(r.gate).toBe('fail');
    if (r.gate === 'fail') {
      expect(r.reasons.some((x) => x.startsWith('green-recompute:'))).toBe(true);
      expect(r.reasons.some((x) => x.includes('gate-evidence artifact'))).toBe(true);
    }
  });

  it('fails when the artifact records a red gate exit', () => {
    const m = createMission(db, { goal: 'g', acceptance: 'a' });
    const state = deliveredState();
    saveRunState(state);
    linkRun(db, m.id, state.runId);
    writeArtifact(HEAD, [{ name: 'build', exitCode: 1 }]);
    const body = `[mission:#${m.id}:${m.acceptanceHash.slice(0, 8)}]`;
    const r = gatePr(root, body, () => CLEAN_DIFF, false, HEAD);
    expect(r.gate).toBe('fail');
    if (r.gate === 'fail') {
      expect(r.reasons.some((x) => x.includes('non-zero gate exit'))).toBe(true);
    }
  });

  it('fails closed on a malformed evidence artifact', () => {
    mkdirSync(join(root, '.uap', 'evidence'), { recursive: true });
    writeFileSync(join(root, '.uap', 'evidence', `${HEAD}.json`), '{not json', 'utf-8');
    const check = readEvidenceArtifact(root, HEAD);
    expect(check.present).toBe(true);
    expect(check.gatesAllZero).toBe(false);
  });

  it('fails provenance when the PR predates a replan (superseded marker)', () => {
    const m = createMission(db, { goal: 'g', acceptance: 'old criteria' });
    const state = deliveredState();
    saveRunState(state);
    linkRun(db, m.id, state.runId);
    writeArtifact(HEAD);
    const staleMarker = `[mission:#${m.id}:${m.acceptanceHash.slice(0, 8)}]`;
    replanAcceptance(db, m.id, 'new criteria', 'scope changed');
    const r = gatePr(root, `work ${staleMarker}`, () => CLEAN_DIFF, false, HEAD);
    expect(r.gate).toBe('fail');
    if (r.gate === 'fail') {
      expect(r.reasons.some((x) => x.startsWith('provenance:'))).toBe(true);
    }
  });

  it('fails green-recompute when the fresh run state is not delivered', () => {
    const m = createMission(db, { goal: 'g', acceptance: 'a' });
    const state = deliveredState({ status: 'running' });
    saveRunState(state);
    linkRun(db, m.id, state.runId);
    const body = `[mission:#${m.id}:${m.acceptanceHash.slice(0, 8)}]`;
    const r = gatePr(root, body, () => CLEAN_DIFF, false);
    expect(r.gate).toBe('fail');
    if (r.gate === 'fail') {
      expect(r.reasons.some((x) => x.startsWith('green-recompute:'))).toBe(true);
    }
  });

  it('fails green-recompute while salvage awaits a ruling', () => {
    const m = createMission(db, { goal: 'g', acceptance: 'a' });
    const state = deliveredState();
    saveRunState(state);
    linkRun(db, m.id, state.runId);
    proposeSalvage(db, { missionId: m.id, proposal: 'retry with different preset' });
    const body = `[mission:#${m.id}:${m.acceptanceHash.slice(0, 8)}]`;
    const r = gatePr(root, body, () => CLEAN_DIFF, false);
    expect(r.gate).toBe('fail');
    if (r.gate === 'fail') {
      expect(r.reasons.some((x) => x.includes('salvage'))).toBe(true);
    }
  });

  it('fails sorry-delta on a TODO added by the diff', () => {
    const m = createMission(db, { goal: 'g', acceptance: 'a' });
    const state = deliveredState();
    saveRunState(state);
    linkRun(db, m.id, state.runId);
    const body = `[mission:#${m.id}:${m.acceptanceHash.slice(0, 8)}]`;
    const stubDiff = [
      'diff --git a/src/half.ts b/src/half.ts',
      '--- a/src/half.ts',
      '+++ b/src/half.ts',
      '@@ -0,0 +1 @@',
      '+// TODO: implement',
    ].join('\n');
    const r = gatePr(root, body, () => stubDiff, false);
    expect(r.gate).toBe('fail');
    if (r.gate === 'fail') {
      expect(r.reasons.some((x) => x.startsWith('sorry-delta:'))).toBe(true);
    }
  });

  it('fails axiom-honesty on gate-infra changes without the label, passes with it', () => {
    const m = createMission(db, { goal: 'g', acceptance: 'a' });
    const state = deliveredState();
    saveRunState(state);
    linkRun(db, m.id, state.runId);
    const body = `[mission:#${m.id}:${m.acceptanceHash.slice(0, 8)}]`;
    const infraDiff = [
      'diff --git a/.codex/hooks/session-start.sh b/.codex/hooks/session-start.sh',
      '--- a/.codex/hooks/session-start.sh',
      '+++ b/.codex/hooks/session-start.sh',
      '@@ -1 +1 @@',
      '+echo gated',
    ].join('\n');
    const blocked = gatePr(root, body, () => infraDiff, false);
    expect(blocked.gate).toBe('fail');
    if (blocked.gate === 'fail') {
      expect(blocked.reasons.some((x) => x.startsWith('axiom-honesty:'))).toBe(true);
    }
    expect(gatePr(root, body, () => infraDiff, true)).toEqual({ gate: 'pass' });
  });

  it('maps a diff-fetch transport failure to gate:error (never a queue crash)', () => {
    const m = createMission(db, { goal: 'g', acceptance: 'a' });
    const body = `[mission:#${m.id}:${m.acceptanceHash.slice(0, 8)}]`;
    const r = gatePr(root, body, () => { throw new Error('gh failed: rate limit'); }, false);
    expect(r.gate).toBe('error');
    if (r.gate === 'error') {
      expect(r.reason).toContain('diff fetch failed');
    }
  });

  it('returns gate:error when the marker names a mission that does not exist', () => {
    const r = gatePr(root, '[mission:#99:abcd1234]', () => CLEAN_DIFF, false);
    expect(r.gate).toBe('error');
    if (r.gate === 'error') {
      expect(r.reason).toContain('#99');
    }
  });

  it('returns gate:error when no mission ledger exists in the repo at all', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'uap-merge-gate-nolegger-'));
    try {
      const r = gatePr(fresh, '[mission:#1:abcd1234]', () => CLEAN_DIFF, false);
      expect(r.gate).toBe('error');
      if (r.gate === 'error') {
        expect(r.reason).toContain('no mission ledger');
      }
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});
