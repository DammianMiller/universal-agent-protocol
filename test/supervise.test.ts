/**
 * Semantic supervisor — policy branch coverage, oscillation + verify budgets,
 * classifier fail-closed blending (SYS1 built-in questions only), config
 * validation, symlink discipline, budget authority, and the seeded
 * stuck/healthy mission fixtures end to end (--once against a fabricated
 * .uap/deliver-runs directory in a tmpdir).
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { assessAll, heuristicAssessAll, type ClassifierLike, type ClassifierQuestion } from '../src/supervise/assess.js';
import { loadSupervisorConfig, validatePolicy, SupervisorError } from '../src/supervise/config.js';
import { collectObservation, newestLogForRun, tailFile } from '../src/supervise/observe.js';
import { decide, effectiveMaxMinutes } from '../src/supervise/policy.js';
import {
  runSupervisor,
  shouldAssess,
  supervisorEventsPath,
  supervisorStatePath,
  loadSupervisorState,
} from '../src/supervise/loop.js';
import { stopFilePath } from '../src/delivery/run-state.js';
import { superviseCommand } from '../src/cli/supervise.js';
import type { Observation, SupervisorConfig } from '../src/supervise/types.js';

const CFG: SupervisorConfig = {
  version: 1,
  stallMinutes: 10,
  maxMinutes: 120,
  maxTurns: 50,
  maxRetries: 2,
  maxFailures: 3,
  debounceMs: 5000,
  intervalMs: 30000,
  classifierConfidenceMin: 0.7,
  classifierTau: 0.6,
  maxVerify: 3,
};

function baseObs(over: Partial<Observation> = {}): Observation {
  return {
    runId: 'run-20260901T000000-abc123',
    status: 'running',
    instruction: 'fix the login bug in the auth module',
    elapsedMinutes: 5,
    minutesSinceUpdate: 1,
    turnsCompleted: 3,
    failures: 0,
    hasCheckpoint: true,
    recentLogTail: 'turn 3 applied\n12 tests passed\n',
    gitDirtyFiles: 1,
    diffStat: ' src/auth/login.ts | 10 +++---\n 1 file changed',
    ...over,
  };
}

const PS = { retries: 0, lastAction: null as never, verifyCount: 0 };

const tmpdirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'uap-supervise-'));
  tmpdirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpdirs.length) rmSync(tmpdirs.pop() as string, { recursive: true, force: true });
});

function seedRun(
  root: string,
  runId: string,
  state: Record<string, unknown>,
  log?: { name: string; content: string }
): void {
  const dir = join(root, '.uap', 'deliver-runs', runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'state.json'),
    JSON.stringify({ runId, projectRoot: root, presetId: 'default', ...state })
  );
  if (log) {
    const ldir = join(root, '.uap', 'deliver-logs');
    mkdirSync(ldir, { recursive: true });
    writeFileSync(join(ldir, log.name), log.content);
  }
}

function isoMinutesAgo(min: number): string {
  return new Date(Date.now() - min * 60_000).toISOString();
}

describe('policy — the fixed safety-first priority chain', () => {
  it('healthy mission → CONTINUE', () => {
    const obs = baseObs();
    const d = decide(obs, assessAll(obs, CFG), { ...PS }, CFG);
    expect(d.action).toBe('CONTINUE');
  });

  it('human-needed → ESCALATE (when inside budget)', () => {
    const obs = baseObs({ recentLogTail: 'confirm the change?' });
    const d = decide(obs, assessAll(obs, CFG), { ...PS }, CFG);
    expect(d.action).toBe('ESCALATE');
    expect(d.reason).toBe('human input required');
  });

  it('over-budget AND human-needed → STOP wins, human-need rides along as alsoEscalate', () => {
    const obs = baseObs({ elapsedMinutes: 999, recentLogTail: 'confirm the change?' });
    const d = decide(obs, assessAll(obs, CFG), { ...PS }, CFG);
    expect(d.action).toBe('STOP');
    expect(d.reason).toBe('iteration bounds exceeded');
    expect(d.evidence.alsoEscalate).toBe('human input required');
  });

  it('turns beyond maxTurns → STOP', () => {
    const obs = baseObs({ turnsCompleted: 51 });
    const d = decide(obs, assessAll(obs, CFG), { ...PS }, CFG);
    expect(d.action).toBe('STOP');
    expect(d.reason).toBe('iteration bounds exceeded');
  });

  it('elapsed beyond maxMinutes → STOP', () => {
    const obs = baseObs({ elapsedMinutes: 121 });
    const d = decide(obs, assessAll(obs, CFG), { ...PS }, CFG);
    expect(d.action).toBe('STOP');
  });

  it('stuck AND over bounds → STOP, not RETRY (bounds outrank stuck)', () => {
    const obs = baseObs({
      elapsedMinutes: 200,
      recentLogTail: 'fatal error: boom\nfatal error: boom\nfatal error: boom\n',
    });
    const dims = assessAll(obs, CFG);
    expect(dims.find((x) => x.name === 'stuck-loop')?.value).toBe(true);
    const d = decide(obs, dims, { ...PS }, CFG);
    expect(d.action).toBe('STOP');
  });

  it('stuck with retry budget → RETRY', () => {
    const obs = baseObs({ recentLogTail: 'fatal error: boom\nfatal error: boom\nfatal error: boom\n' });
    const d = decide(obs, assessAll(obs, CFG), { ...PS }, CFG);
    expect(d.action).toBe('RETRY');
  });

  it('stuck with retries exhausted → ESCALATE', () => {
    const obs = baseObs({ recentLogTail: 'fatal error: boom\nfatal error: boom\nfatal error: boom\n' });
    const d = decide(obs, assessAll(obs, CFG), { ...PS, retries: CFG.maxRetries, lastAction: 'RETRY' }, CFG);
    expect(d.action).toBe('ESCALATE');
    expect(d.reason).toMatch(/retries exhausted/);
  });

  it('delivered status → FINISH (authoritative state), even with a scary tail', () => {
    const obs = baseObs({
      status: 'delivered',
      elapsedMinutes: 9999,
      recentLogTail: 'enter password to continue\nfatal error: boom\n',
    });
    const d = decide(obs, assessAll(obs, CFG), { ...PS }, CFG);
    expect(d.action).toBe('FINISH');
  });

  it('failed/interrupted status → CONTINUE, never STOP/ESCALATE', () => {
    const obs = baseObs({
      status: 'failed',
      elapsedMinutes: 9999,
      recentLogTail: 'enter password to continue\n',
    });
    const d = decide(obs, assessAll(obs, CFG), { ...PS }, CFG);
    expect(d.action).toBe('CONTINUE');
    expect(d.reason).toBe('run is failed — nothing to supervise');
  });

  it('a tail claiming "mission complete" on a RUNNING mission never detaches supervision', () => {
    const obs = baseObs({ recentLogTail: 'mission complete\nall done\n' });
    const dims = assessAll(obs, CFG);
    expect(dims.find((x) => x.name === 'completion-signaled')?.value).toBe(true);
    const d = decide(obs, dims, { ...PS, lastAction: 'CONTINUE' }, CFG);
    expect(d.action).not.toBe('FINISH');
  });

  it('verification-pending → VERIFY (checkpoint without test evidence)', () => {
    const obs = baseObs({ recentLogTail: 'turn 3 applied src/auth/login.ts\n' });
    const dims = assessAll(obs, CFG);
    expect(dims.find((x) => x.name === 'verification-pending')?.value).toBe(true);
    const d = decide(obs, dims, { ...PS, lastAction: 'CONTINUE' }, CFG);
    expect(d.action).toBe('VERIFY');
  });

  it('oscillation guard: VERIFY can never fire twice consecutively', () => {
    const obs = baseObs({ recentLogTail: 'turn 3 applied src/auth/login.ts\n' });
    const dims = assessAll(obs, CFG);
    const first = decide(obs, dims, { ...PS, lastAction: 'CONTINUE' }, CFG);
    expect(first.action).toBe('VERIFY');
    const second = decide(obs, dims, { ...PS, lastAction: first.action, verifyCount: 1 }, CFG);
    expect(second.action).toBe('CONTINUE');
    expect(second.reason).toBe('verify already requested, awaiting result');
    // …and an intervening non-VERIFY action re-arms it.
    const third = decide(obs, dims, { ...PS, lastAction: second.action, verifyCount: 1 }, CFG);
    expect(third.action).toBe('VERIFY');
  });

  it('verify budget: unanswered verification past maxVerify falls into the stuck path', () => {
    const obs = baseObs({ recentLogTail: 'turn 3 applied src/auth/login.ts\n' });
    const dims = assessAll(obs, CFG);
    const retry = decide(obs, dims, { ...PS, lastAction: 'VERIFY', verifyCount: CFG.maxVerify }, CFG);
    expect(retry.action).toBe('RETRY');
    expect(retry.reason).toMatch(/verification unanswered/);
    const esc = decide(
      obs,
      dims,
      { ...PS, lastAction: 'VERIFY', verifyCount: CFG.maxVerify, retries: CFG.maxRetries },
      CFG
    );
    expect(esc.action).toBe('ESCALATE');
    expect(esc.reason).toMatch(/verification unanswered/);
  });
});

describe('assess — heuristic dimensions', () => {
  it('human-needed fires on credential prompts and approve/confirm questions', () => {
    for (const tail of ['enter password to continue', 'confirm the change?', 'approve this action?', 'password:']) {
      const dims = heuristicAssessAll(baseObs({ recentLogTail: tail }), CFG);
      expect(dims.find((d) => d.name === 'human-needed')?.value).toBe(true);
    }
  });

  it('human-needed does NOT fire on declaratives: Permission denied / approved', () => {
    for (const tail of ['Permission denied (publickey)', 'approved the change already', 'access denied']) {
      const dims = heuristicAssessAll(baseObs({ recentLogTail: tail }), CFG);
      expect(dims.find((d) => d.name === 'human-needed')?.value).toBe(false);
    }
  });

  it('stuck-loop: same error signature 3× fires, distinct errors do not', () => {
    const same = heuristicAssessAll(
      baseObs({ recentLogTail: 'Error: flux capacitor 1\nError: flux capacitor 2\nError: flux capacitor 3' }),
      CFG
    );
    expect(same.find((d) => d.name === 'stuck-loop')?.value).toBe(true);
    const distinct = heuristicAssessAll(
      baseObs({ recentLogTail: 'Error: alpha\nTypeError: beta\nfailure: gamma' }),
      CFG
    );
    expect(distinct.find((d) => d.name === 'stuck-loop')?.value).toBe(false);
  });

  it('stuck-loop: failures at maxFailures fires even with a clean tail', () => {
    const dims = heuristicAssessAll(baseObs({ failures: 3 }), CFG);
    expect(dims.find((d) => d.name === 'stuck-loop')?.value).toBe(true);
  });

  it('off-track: diff paths unrelated to instruction keywords fire; related do not', () => {
    const off = heuristicAssessAll(baseObs({ diffStat: ' recipes/soup.md | 3 +++' }), CFG);
    expect(off.find((d) => d.name === 'off-track')?.value).toBe(true);
    const on = heuristicAssessAll(baseObs({ diffStat: ' src/auth/login.ts | 9 +++---' }), CFG);
    expect(on.find((d) => d.name === 'off-track')?.value).toBe(false);
  });

  it('error-density scores 5 on an all-error tail, 1 on a clean one', () => {
    const hot = heuristicAssessAll(baseObs({ recentLogTail: 'error a\nerror b\nfatal c' }), CFG);
    expect(hot.find((d) => d.name === 'error-density')?.value).toBe(5);
    const cool = heuristicAssessAll(baseObs({ recentLogTail: 'all good\nturn applied' }), CFG);
    expect(cool.find((d) => d.name === 'error-density')?.value).toBe(1);
  });

  it('healthy zero-count summaries ("0 failed") do not inflate error-density or stuck-loop', () => {
    const dims = heuristicAssessAll(baseObs({ recentLogTail: 'Tests: 0 failed, 12 passed\n' }), CFG);
    expect(dims.find((d) => d.name === 'error-density')?.value).toBe(1);
    expect(dims.find((d) => d.name === 'stuck-loop')?.value).toBe(false);
  });

  it('progress-stalled fires only past stallMinutes while running', () => {
    const stalled = heuristicAssessAll(baseObs({ minutesSinceUpdate: 11 }), CFG);
    expect(stalled.find((d) => d.name === 'progress-stalled')?.value).toBe(true);
    const fresh = heuristicAssessAll(baseObs({ minutesSinceUpdate: 2 }), CFG);
    expect(fresh.find((d) => d.name === 'progress-stalled')?.value).toBe(false);
  });
});

describe('assess — classifier blending, SYS1 built-ins only, fail closed', () => {
  const throwing: ClassifierLike = {
    name: 'down',
    assess: () => {
      throw new Error('backend down');
    },
  };

  it('a throwing classifier leaves the heuristics fully in charge', () => {
    const obs = baseObs({ recentLogTail: 'enter password to continue' });
    const blended = assessAll(obs, CFG, throwing);
    const pure = heuristicAssessAll(obs, CFG);
    expect(blended.find((d) => d.name === 'human-needed')?.value).toBe(true);
    expect(blended.map((d) => [d.name, d.value, d.source])).toEqual(
      pure.map((d) => [d.name, d.value, d.source])
    );
  });

  it('asks ONLY the built-in questions, with noul/choice kinds and no options payload', () => {
    let seen: ClassifierQuestion[] = [];
    const spy: ClassifierLike = {
      name: 'spy',
      assess: (_state, questions) => {
        seen = questions;
        return {};
      },
    };
    assessAll(baseObs(), CFG, spy);
    expect(seen.map((q) => q.name)).toEqual(['escalation-risk', 'action-class']);
    expect(seen.map((q) => q.kind)).toEqual(['noul', 'choice']);
    expect(seen.every((q) => q.options === undefined)).toBe(true);
  });

  it('escalation-risk=true at/above tau+confidence raises off-track (source: classifier)', () => {
    const confident: ClassifierLike = {
      name: 'fake',
      assess: () => ({ 'escalation-risk': { value: true, probability: 0.9, confidence: 0.95 } }),
    };
    const dims = assessAll(baseObs(), CFG, confident);
    const d = dims.find((x) => x.name === 'off-track');
    expect(d?.value).toBe(true);
    expect(d?.source).toBe('classifier');
  });

  it('escalation-risk below the probability tau is ignored', () => {
    const timid: ClassifierLike = {
      name: 'fake',
      assess: () => ({ 'escalation-risk': { value: true, probability: 0.5, confidence: 0.95 } }),
    };
    const dims = assessAll(baseObs(), CFG, timid);
    expect(dims.find((x) => x.name === 'off-track')?.value).toBe(false);
  });

  it('action-class escalate → stuck-loop, stop → off-track', () => {
    const esc: ClassifierLike = {
      name: 'fake',
      assess: () => ({ 'action-class': { value: 'escalate', probability: 0.9, confidence: 0.9 } }),
    };
    expect(assessAll(baseObs(), CFG, esc).find((x) => x.name === 'stuck-loop')?.value).toBe(true);
    const stop: ClassifierLike = {
      name: 'fake',
      assess: () => ({ 'action-class': { value: 'stop', probability: 0.9, confidence: 0.9 } }),
    };
    const dims = assessAll(baseObs(), CFG, stop);
    expect(dims.find((x) => x.name === 'off-track')?.value).toBe(true);
    expect(dims.find((x) => x.name === 'off-track')?.source).toBe('classifier');
  });

  it('a classifier can NEVER clear a flag the heuristic set (never looser)', () => {
    const clearing: ClassifierLike = {
      name: 'fake',
      assess: () => ({ 'escalation-risk': { value: false, probability: 0.05, confidence: 0.99 } }),
    };
    const obs = baseObs({ diffStat: ' recipes/soup.md | 3 +++' });
    const dims = assessAll(obs, CFG, clearing);
    expect(dims.find((d) => d.name === 'off-track')?.value).toBe(true);
    expect(dims.find((d) => d.name === 'off-track')?.source).toBe('heuristic');
  });
});

describe('config — loud, versioned, range-checked policy', () => {
  it('loads the packaged reviewed policy', () => {
    const cfg = loadSupervisorConfig();
    expect(cfg.version).toBe(1);
    expect(cfg.maxMinutes).toBe(120);
    expect(cfg.debounceMs).toBe(5000);
    expect(cfg.intervalMs).toBe(30000);
    expect(cfg.maxVerify).toBe(3);
    expect(cfg.classifierTau).toBe(0.6);
  });

  it('rejects a wrong version', () => {
    expect(() => validatePolicy({ version: 2, stallMinutes: 10 }, 'test')).toThrow(SupervisorError);
  });

  it('rejects out-of-range thresholds', () => {
    const valid = {
      version: 1, stallMinutes: 10, maxMinutes: 120, maxTurns: 50, maxRetries: 2,
      maxFailures: 3, debounceMs: 5000, intervalMs: 30000, classifierConfidenceMin: 0.7,
      classifierTau: 0.6, maxVerify: 3,
    };
    expect(() => validatePolicy({ ...valid, stallMinutes: 0 }, 'test')).toThrow(/outside reviewed range/);
    expect(() => validatePolicy({ ...valid, classifierTau: 1.5 }, 'test')).toThrow(/outside reviewed range/);
    expect(() => validatePolicy({ ...valid, maxVerify: 0 }, 'test')).toThrow(/outside reviewed range/);
  });

  it('rejects intervalMs below debounceMs', () => {
    const bad = {
      version: 1, stallMinutes: 10, maxMinutes: 120, maxTurns: 50, maxRetries: 2,
      maxFailures: 3, debounceMs: 30000, intervalMs: 5000, classifierConfidenceMin: 0.7,
      classifierTau: 0.6, maxVerify: 3,
    };
    expect(() => validatePolicy(bad, 'test')).toThrow(/intervalMs/);
  });

  it('refuses to run when the policy file is missing (fail closed)', () => {
    expect(() => loadSupervisorConfig(join(tmp(), 'nope.json'))).toThrow(SupervisorError);
  });
});

describe('observe — bounded, fail-soft collection', () => {
  it('rejects invalid run ids and unknown runs (runId validation reused)', () => {
    const root = tmp();
    expect(collectObservation(root, '../evil')).toBeNull();
    expect(collectObservation(root, 'run-20260901T000000-dead99')).toBeNull();
  });

  it('tails only the last bytes of a large log, never the whole file', () => {
    const root = tmp();
    const big = join(root, 'big.log');
    writeFileSync(big, 'x'.repeat(20_000) + '\nLAST LINE\n');
    const tail = tailFile(big);
    expect(tail).toBeDefined();
    expect((tail as string).length).toBeLessThanOrEqual(8192);
    expect(tail).toContain('LAST LINE');
  });

  it('tailFile silently skips a symlinked log', () => {
    const root = tmp();
    const real = join(root, 'real.log');
    writeFileSync(real, 'fatal error: boom\n');
    const link = join(root, 'link.log');
    symlinkSync(real, link);
    expect(tailFile(link)).toBeUndefined();
    expect(tailFile(real)).toContain('boom');
  });

  it('newestLogForRun ignores non-regular files (symlinks)', () => {
    const root = tmp();
    const ldir = join(root, '.uap', 'deliver-logs');
    mkdirSync(ldir, { recursive: true });
    const outside = join(root, 'outside.log');
    writeFileSync(outside, 'planted\n');
    symlinkSync(outside, join(ldir, 'deliver-20260901T000000.log'));
    expect(newestLogForRun(root, 'run-20260901T000000-abc123')).toBeUndefined();
  });

  it('picks the newest log stamped at-or-before the run', () => {
    const root = tmp();
    const ldir = join(root, '.uap', 'deliver-logs');
    mkdirSync(ldir, { recursive: true });
    writeFileSync(join(ldir, 'deliver-20260831T235959.log'), 'before');
    writeFileSync(join(ldir, 'deliver-20260901T000001.log'), 'after');
    const picked = newestLogForRun(root, 'run-20260901T000000-abc123');
    expect(picked).toBe(join(ldir, 'deliver-20260831T235959.log'));
  });
});

describe('cadence — debounced and periodic', () => {
  it('change before the debounce does not trigger; after it does; heartbeat always does', () => {
    expect(shouldAssess({ changed: true, sinceLastMs: 1000, debounceMs: 5000, intervalMs: 30000 })).toBe(false);
    expect(shouldAssess({ changed: true, sinceLastMs: 5000, debounceMs: 5000, intervalMs: 30000 })).toBe(true);
    expect(shouldAssess({ changed: false, sinceLastMs: 30000, debounceMs: 5000, intervalMs: 30000 })).toBe(true);
    expect(shouldAssess({ changed: false, sinceLastMs: 10000, debounceMs: 5000, intervalMs: 30000 })).toBe(false);
  });
});

describe('budget authority — operator deliver budget outranks static policy', () => {
  const envKey = 'UAP_DELIVER_MAX_MINUTES';
  function seedLongRun(root: string): string {
    const runId = 'run-20260901T030000-ff44aa';
    seedRun(
      root,
      runId,
      {
        instruction: 'fix the auth login bug',
        status: 'running',
        createdAt: isoMinutesAgo(200), // over the 120m policy, under a 300m operator budget
        updatedAt: isoMinutesAgo(1),
        checkpoint: {
          turn: 3,
          history: [{ turn: 1, passed: true, score: 1, gateResults: [], filesApplied: [] }],
          prevContext: {},
          bestSoFar: 1,
          bestAcceptance: 1,
          stagnantTurns: 0,
        },
      },
      { name: 'deliver-20260901T025959.log', content: 'turn 3 applied\n12 tests passed\n' }
    );
    return runId;
  }

  it('a .uap.json delivery.maxRunMinutes of 300 keeps a 200m mission at CONTINUE', async () => {
    const saved = process.env[envKey];
    delete process.env[envKey];
    try {
      const root = tmp();
      writeFileSync(join(root, '.uap.json'), JSON.stringify({ delivery: { maxRunMinutes: 300 } }));
      const runId = seedLongRun(root);
      expect(effectiveMaxMinutes(CFG, root)).toBe(300);
      const result = await runSupervisor({ projectRoot: root, runId, once: true, config: CFG, warn: () => {} });
      expect(result.decision.action).toBe('CONTINUE');
      expect(existsSync(stopFilePath(root, runId))).toBe(false);
    } finally {
      if (saved === undefined) delete process.env[envKey];
      else process.env[envKey] = saved;
    }
  });

  it('without an operator budget the static 120m policy STOPs the same mission', async () => {
    const saved = process.env[envKey];
    delete process.env[envKey];
    try {
      const root = tmp();
      const runId = seedLongRun(root);
      expect(effectiveMaxMinutes(CFG, root)).toBe(120);
      const result = await runSupervisor({ projectRoot: root, runId, once: true, config: CFG, warn: () => {} });
      expect(result.decision.action).toBe('STOP');
      expect(existsSync(stopFilePath(root, runId))).toBe(true);
    } finally {
      if (saved === undefined) delete process.env[envKey];
      else process.env[envKey] = saved;
    }
  });
});

describe('supervise --once against seeded mission fixtures', () => {
  it('a stuck, over-budget mission is STOPPED (cooperative STOP file, never a signal)', async () => {
    const root = tmp();
    const runId = 'run-20260901T000000-aa11bb';
    seedRun(
      root,
      runId,
      {
        instruction: 'fix the auth login bug',
        status: 'running',
        createdAt: isoMinutesAgo(200),
        updatedAt: isoMinutesAgo(60),
        checkpoint: { turn: 4, history: [], prevContext: {}, bestSoFar: 0, bestAcceptance: 0, stagnantTurns: 0 },
      },
      { name: 'deliver-20260901T000000.log', content: 'fatal error: boom\n'.repeat(4) }
    );
    const result = await runSupervisor({ projectRoot: root, runId, once: true, config: CFG, warn: () => {} });
    expect(result.decision.action).toBe('STOP');
    expect(existsSync(stopFilePath(root, runId))).toBe(true);
    // persisted state + v-stamped event ledger, mode 0600
    const state = loadSupervisorState(root, runId, new Date().toISOString());
    expect(state.assessments).toBe(1);
    expect(state.lastAction).toBe('STOP');
    const eventsPath = supervisorEventsPath(root, runId);
    const events = readFileSync(eventsPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(events).toHaveLength(1);
    expect(events[0].v).toBe(1);
    expect(events[0].action).toBe('STOP');
    // per-dimension source survives into the ledger
    expect(events[0].dimensions['stuck-loop']).toEqual({ value: true, source: 'heuristic' });
    expect(statSync(eventsPath).mode & 0o777).toBe(0o600);
    expect(statSync(supervisorStatePath(root, runId)).mode & 0o777).toBe(0o600);
    expect(existsSync(supervisorStatePath(root, runId))).toBe(true);
  });

  it('a healthy mission is never interrupted', async () => {
    const root = tmp();
    const runId = 'run-20260901T010000-cc22dd';
    seedRun(
      root,
      runId,
      {
        instruction: 'fix the auth login bug',
        status: 'running',
        createdAt: isoMinutesAgo(5),
        updatedAt: isoMinutesAgo(1),
        checkpoint: {
          turn: 3,
          history: [{ turn: 1, passed: true, score: 1, gateResults: [], filesApplied: [] }],
          prevContext: {},
          bestSoFar: 1,
          bestAcceptance: 1,
          stagnantTurns: 0,
        },
      },
      { name: 'deliver-20260901T005959.log', content: 'turn 3 applied src/auth/login.ts\n12 tests passed\n' }
    );
    const result = await runSupervisor({ projectRoot: root, runId, once: true, config: CFG, warn: () => {} });
    expect(result.decision.action).toBe('CONTINUE');
    expect(existsSync(stopFilePath(root, runId))).toBe(false);
  });

  it('a DELIVERED run is never STOPped/ESCALATEd, however scary the tail', async () => {
    const root = tmp();
    const runId = 'run-20260901T040000-bb77ee';
    seedRun(
      root,
      runId,
      {
        instruction: 'fix the auth login bug',
        status: 'delivered',
        createdAt: isoMinutesAgo(500),
        updatedAt: isoMinutesAgo(400),
      },
      { name: 'deliver-20260901T035959.log', content: 'enter password to continue\nfatal error: boom\n'.repeat(3) }
    );
    const result = await runSupervisor({ projectRoot: root, runId, once: true, config: CFG, warn: () => {} });
    expect(result.decision.action).toBe('FINISH');
    expect(existsSync(stopFilePath(root, runId))).toBe(false);
  });

  it('retry budget persists across processes: RETRY → RETRY → ESCALATE', async () => {
    const root = tmp();
    const runId = 'run-20260901T050000-1234ab';
    seedRun(
      root,
      runId,
      {
        instruction: 'fix the auth login bug',
        status: 'running',
        createdAt: isoMinutesAgo(5),
        updatedAt: isoMinutesAgo(1),
      },
      { name: 'deliver-20260901T045959.log', content: 'fatal error: boom\n'.repeat(3) }
    );
    const run = () => runSupervisor({ projectRoot: root, runId, once: true, config: CFG, warn: () => {} });
    expect((await run()).decision.action).toBe('RETRY');
    expect((await run()).decision.action).toBe('RETRY');
    expect((await run()).decision.action).toBe('ESCALATE');
    const state = loadSupervisorState(root, runId, new Date().toISOString());
    expect(state.retries).toBe(2);
    expect(state.assessments).toBe(3);
  });

  it('the CLI exits 2 on a STOP decision (and never touches a healthy run)', async () => {
    const root = tmp();
    const runId = 'run-20260901T060000-5566cd';
    seedRun(
      root,
      runId,
      {
        instruction: 'fix the auth login bug',
        status: 'running',
        createdAt: isoMinutesAgo(200),
        updatedAt: isoMinutesAgo(60),
      },
      { name: 'deliver-20260901T060000.log', content: 'fatal error: boom\n'.repeat(4) }
    );
    const prevExit = process.exitCode;
    const prevLog = console.log;
    const prevWarn = console.warn;
    console.log = () => {};
    console.warn = () => {};
    try {
      await superviseCommand(runId, { once: true, json: true, projectDir: root });
      expect(process.exitCode).toBe(2);
      expect(existsSync(stopFilePath(root, runId))).toBe(true);
    } finally {
      console.log = prevLog;
      console.warn = prevWarn;
      process.exitCode = prevExit;
    }
  });

  it('a symlinked .uap/supervise dir is refused with SupervisorError', async () => {
    const root = tmp();
    const runId = 'run-20260901T070000-8899ef';
    seedRun(root, runId, {
      instruction: 'fix the auth login bug',
      status: 'running',
      createdAt: isoMinutesAgo(5),
      updatedAt: isoMinutesAgo(1),
    });
    const evil = join(root, 'evil-target');
    mkdirSync(evil, { recursive: true });
    symlinkSync(evil, join(root, '.uap', 'supervise'));
    await expect(
      runSupervisor({ projectRoot: root, runId, once: true, config: CFG, warn: () => {} })
    ).rejects.toThrow(SupervisorError);
    expect(existsSync(join(evil, runId))).toBe(false);
  });

  it('watch mode: a repeated ESCALATE fires its warning once per streak', async () => {
    const root = tmp();
    const runId = 'run-20260901T020000-ee33ff';
    seedRun(
      root,
      runId,
      {
        instruction: 'fix the auth login bug',
        status: 'running',
        createdAt: isoMinutesAgo(5),
        updatedAt: isoMinutesAgo(1),
      },
      { name: 'deliver-20260901T015959.log', content: 'approve this action?\n' }
    );
    let fakeNow = Date.now();
    const warnings: string[] = [];
    const result = await runSupervisor({
      projectRoot: root,
      runId,
      config: CFG,
      maxCycles: 2,
      now: () => fakeNow,
      sleep: (ms) => {
        fakeNow += ms;
        return Promise.resolve();
      },
      warn: (m) => warnings.push(m),
    });
    expect(result.decision.action).toBe('ESCALATE');
    expect(result.cycles).toBe(2);
    expect(warnings.filter((w) => w.includes('ESCALATE'))).toHaveLength(1);
    const events = readFileSync(supervisorEventsPath(root, runId), 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(events[0].action).toBe('ESCALATE');
    expect(events[0].suppressed).toBeUndefined();
    expect(events[1].action).toBe('ESCALATE');
    expect(events[1].suppressed).toBe(true);
  });

  it('watch mode: 20 unanswered ESCALATEs detach the watcher with a final event', async () => {
    const root = tmp();
    const runId = 'run-20260901T080000-aabb00';
    seedRun(
      root,
      runId,
      {
        instruction: 'fix the auth login bug',
        status: 'running',
        createdAt: isoMinutesAgo(5),
        updatedAt: isoMinutesAgo(1),
      },
      { name: 'deliver-20260901T075959.log', content: 'approve this action?\n' }
    );
    let fakeNow = Date.now();
    const result = await runSupervisor({
      projectRoot: root,
      runId,
      config: CFG,
      now: () => fakeNow,
      sleep: (ms) => {
        fakeNow += ms;
        return Promise.resolve();
      },
      warn: () => {},
    });
    expect(result.decision.action).toBe('ESCALATE');
    const events = readFileSync(supervisorEventsPath(root, runId), 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    // 1 live ESCALATE + 20 suppressed + the final 'escalation unanswered'
    expect(events).toHaveLength(22);
    expect(events.at(-1).reason).toBe('escalation unanswered');
    const state = loadSupervisorState(root, runId, new Date().toISOString());
    expect(state.suppressedEscalations).toBe(20);
  });

  it('unknown run → SupervisorError (fail closed)', async () => {
    const root = tmp();
    await expect(
      runSupervisor({ projectRoot: root, runId: 'run-20260901T000000-dead99', once: true, config: CFG })
    ).rejects.toThrow(SupervisorError);
  });
});
