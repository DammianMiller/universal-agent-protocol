import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  attackSurface,
  breachReconvergencePrompt,
  buildAttackPrompt,
  DEFAULT_ADVERSARIAL_ROUNDS,
  MAX_ADVERSARIAL_ROUNDS,
  pickTestRung,
  resolveAdversarialGate,
  runAdversarialGate,
  runAdversarialRound,
  sanctionAttackBlocks,
  type SuiteRun,
} from '../../src/delivery/adversarial-gate.js';
import { parseTestOutcomes, testsActuallyRan } from '../../src/delivery/verifier-ladder.js';
import type { GateRung } from '../../src/delivery/verifier-ladder.js';
import type { DeliveryResult } from '../../src/delivery/convergence-loop.js';

const TEST_RUNG: GateRung = {
  id: 'test',
  name: 'npm test',
  command: 'node',
  args: ['--test'],
  required: true,
  timeoutMs: 60_000,
};

/** A strict-contract file block the way the attack prompt demands it. */
function fileBlock(path: string, body: string): string {
  const terminated = body.endsWith('\n') ? body : `${body}\n`;
  return `\`\`\`file:${path}\n${terminated}\`\`\`\n`;
}

function nodeTestFile(title: string, assertion: string): string {
  return [
    `import { test } from 'node:test';`,
    `import assert from 'node:assert/strict';`,
    `import { add } from '../src/math.js';`,
    ``,
    `test('${title}', () => {`,
    `  ${assertion}`,
    `});`,
    ``,
  ].join('\n');
}

function convergedResult(files: string[]): DeliveryResult {
  return {
    success: true,
    alreadyDelivered: false,
    turns: 1,
    bestScore: 1,
    bestTurn: 1,
    history: [
      { turn: 1, passed: true, score: 1, gateResults: [], filesApplied: files, durationMs: 1 },
    ],
    finalFeedback: '',
    finalOutput: '',
    totalDurationMs: 1,
  };
}

describe('adversarial-gate: resolveAdversarialGate', () => {
  it('is ON by default with the default round budget', () => {
    const s = resolveAdversarialGate(undefined, {});
    expect(s).toEqual({ enabled: true, maxRounds: DEFAULT_ADVERSARIAL_ROUNDS });
  });

  it('env UAP_DELIVER_ADVERSARIAL_GATE=0 disables; a number retunes the budget', () => {
    expect(resolveAdversarialGate(undefined, { UAP_DELIVER_ADVERSARIAL_GATE: '0' })).toEqual({
      enabled: false,
      maxRounds: 0,
    });
    expect(resolveAdversarialGate(undefined, { UAP_DELIVER_ADVERSARIAL_GATE: '3' })).toEqual({
      enabled: true,
      maxRounds: 3,
    });
    // Clamped to the hard ceiling.
    expect(resolveAdversarialGate(undefined, { UAP_DELIVER_ADVERSARIAL_GATE: '99' })).toEqual({
      enabled: true,
      maxRounds: MAX_ADVERSARIAL_ROUNDS,
    });
  });

  it('config deliver.adversarialGate=false/off disables; env wins over config', () => {
    expect(resolveAdversarialGate(false, {})).toEqual({ enabled: false, maxRounds: 0 });
    expect(resolveAdversarialGate('off', {})).toEqual({ enabled: false, maxRounds: 0 });
    expect(resolveAdversarialGate(false, { UAP_DELIVER_ADVERSARIAL_GATE: '1' }).enabled).toBe(true);
    expect(resolveAdversarialGate(4, { UAP_DELIVER_ADVERSARIAL_GATE: '0' }).enabled).toBe(false);
  });

  it('an unparseable value keeps the safe default (on), never silently disables', () => {
    const s = resolveAdversarialGate('banana', {});
    expect(s.enabled).toBe(true);
    expect(s.maxRounds).toBe(DEFAULT_ADVERSARIAL_ROUNDS);
  });

  it('boolean true means "on" with the DEFAULT budget — never Number(true) === 1 round', () => {
    // Config `adversarialGate: true` and env 'true' must agree: the flag form
    // enables the stage, it does not retune it to a single round.
    expect(resolveAdversarialGate(true, {})).toEqual({
      enabled: true,
      maxRounds: DEFAULT_ADVERSARIAL_ROUNDS,
    });
    expect(resolveAdversarialGate(undefined, { UAP_DELIVER_ADVERSARIAL_GATE: 'true' })).toEqual({
      enabled: true,
      maxRounds: DEFAULT_ADVERSARIAL_ROUNDS,
    });
  });
});

describe('adversarial-gate: surface + rung selection', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-adv-surf-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'math.js'), 'export const add = (a, b) => a + b;\n');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('picks the test rung and ignores non-test rungs', () => {
    const build: GateRung = { ...TEST_RUNG, id: 'build', command: 'npm', args: ['run', 'build'] };
    expect(pickTestRung([build, TEST_RUNG])?.id).toBe('test');
    expect(pickTestRung([build])).toBeNull();
  });

  it('attack surface = existing attackable source files, never tests or ghosts', () => {
    const surface = attackSurface(
      ['src/math.js', 'src/math.test.js', 'src/gone.js', 'README.md'],
      dir
    );
    expect(surface).toEqual(['src/math.js']);
  });
});

describe('adversarial-gate: sanctionAttackBlocks (additive oracle channel)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-adv-sanction-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('accepts a NEW test file with recognizable tests', () => {
    const { writes, notes } = sanctionAttackBlocks(
      [{ path: 'test/adversarial.test.js', content: nodeTestFile('t1', 'assert.equal(1, 1);') }],
      dir
    );
    expect(writes.map((w) => w.rel)).toEqual(['test/adversarial.test.js']);
    expect(writes[0].titles).toEqual(['t1']);
    expect(notes).toEqual([]);
  });

  it('refuses non-test paths, escaping paths, and suppressor-laden content', () => {
    const { writes, notes } = sanctionAttackBlocks(
      [
        { path: 'src/math.js', content: 'export const x = 1;' },
        { path: '../evil.test.js', content: "test('x', () => {});" },
        { path: 'test/sneaky.test.js', content: "test.only('x', () => {});" },
      ],
      dir
    );
    expect(writes).toEqual([]);
    expect(notes.join('\n')).toMatch(/not a test file/);
    expect(notes.join('\n')).toMatch(/escapes the project root/);
    expect(notes.join('\n')).toMatch(/suppression modifiers/);

    const killer = sanctionAttackBlocks(
      [{ path: 'test/killer.test.js', content: "process.exit(0);\ntest('x', () => {});" }],
      dir
    );
    expect(killer.writes).toEqual([]);
    expect(killer.notes.join('\n')).toMatch(/process\.exit/);
  });

  it('sanctions a verbatim-prefix APPEND to an existing test file; refuses a rewrite', () => {
    const existingPath = join(dir, 'test', 'existing.test.js');
    mkdirSync(dirname(existingPath), { recursive: true });
    const prior = "import { test } from 'node:test';\ntest('old', () => {});\n";
    writeFileSync(existingPath, prior);
    const appended = prior + "\ntest('new adversarial case', () => {});\n";
    const ok = sanctionAttackBlocks([{ path: 'test/existing.test.js', content: appended }], dir);
    expect(ok.writes).toHaveLength(1);
    expect(ok.writes[0].prior).toBe(prior);
    expect(ok.writes[0].titles).toEqual(['new adversarial case']);

    const rewrite = sanctionAttackBlocks(
      [{ path: 'test/existing.test.js', content: "test('new adversarial case', () => {});\n" }],
      dir
    );
    expect(rewrite.writes).toEqual([]);
    expect(rewrite.notes.join('\n')).toMatch(/not additive/);
  });

  it('allows lifecycle hooks in a NEW file (they cannot reach existing tests)', () => {
    const content =
      "import { test, beforeEach } from 'node:test';\nbeforeEach(() => {});\ntest('hooked', () => {});\n";
    const { writes } = sanctionAttackBlocks([{ path: 'test/hooked.test.js', content }], dir);
    expect(writes).toHaveLength(1);
  });

  it('refuses a write whose parent is a SYMLINK escaping the root (lexical check alone misses it)', () => {
    // test/linkdir points OUTSIDE the project: linkdir/evil.test.js resolves
    // lexically inside the root, but the write would land outside it.
    const outside = mkdtempSync(join(tmpdir(), 'uap-adv-outside-'));
    try {
      mkdirSync(join(dir, 'test'), { recursive: true });
      symlinkSync(outside, join(dir, 'test', 'linkdir'), 'dir');
      const { writes, notes } = sanctionAttackBlocks(
        [{ path: 'test/linkdir/evil.test.js', content: "test('x', () => {});" }],
        dir
      );
      expect(writes).toEqual([]);
      expect(notes.join('\n')).toMatch(/symlink.*escapes the project root/);
      expect(existsSync(join(outside, 'evil.test.js'))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('the content cap counts BYTES, not UTF-16 code units', () => {
    // 60k three-byte characters: .length is 60_000 (under the 100k cap) but
    // the write would be ~180k bytes — a runaway generation must be refused.
    const fat = `test('x', () => {});\n// ${'€'.repeat(60_000)}`;
    const { writes, notes } = sanctionAttackBlocks([{ path: 'test/fat.test.js', content: fat }], dir);
    expect(writes).toEqual([]);
    expect(notes.join('\n')).toMatch(/exceeds 100000 bytes/);
  });

  it('records surplus blocks beyond the file cap instead of silently dropping them', () => {
    const blocks = [1, 2, 3, 4].map((n) => ({
      path: `test/attack-${n}.test.js`,
      content: nodeTestFile(`case ${n}`, 'assert.ok(true);'),
    }));
    const { writes, notes } = sanctionAttackBlocks(blocks, dir);
    expect(writes.map((w) => w.rel)).toEqual([
      'test/attack-1.test.js',
      'test/attack-2.test.js',
      'test/attack-3.test.js',
    ]);
    expect(notes.join('\n')).toMatch(/dropped 1 surplus attack block\(s\).*test\/attack-4\.test\.js/);
  });
});

describe('verifier-ladder: node --test output (TAP + spec reporters)', () => {
  it('parses TAP ok/not ok lines and ignores SKIP/TODO directives', () => {
    const out = [
      'TAP version 13',
      'ok 1 - passes fine',
      'not ok 2 - breaks hard',
      'ok 3 - skipped case # SKIP',
      'not ok 4 - todo case # TODO',
    ].join('\n');
    const parsed = parseTestOutcomes(out, 'test');
    expect(parsed).not.toBeNull();
    expect([...parsed!.passed]).toEqual(['passes fine']);
    expect([...parsed!.failed]).toEqual(['breaks hard']);
  });

  it('parses the spec reporter (node >= 20 default) with decimal durations', () => {
    const out = '✔ passes fine (0.550815ms)\n✖ fails hard (0.649416ms)\nℹ tests 2\n';
    const parsed = parseTestOutcomes(out, 'test');
    expect([...parsed!.passed]).toEqual(['passes fine']);
    expect([...parsed!.failed]).toEqual(['fails hard']);
  });

  it('testsActuallyRan reads node summaries: zero tests is not a pass', () => {
    expect(testsActuallyRan('test', '# tests 0\n# pass 0\n')).toBe(false);
    expect(testsActuallyRan('test', '# tests 3\n# pass 3\n')).toBe(true);
    expect(testsActuallyRan('test', 'ℹ tests 2\nℹ pass 2\n')).toBe(true);
  });
});

describe('adversarial-gate: runAdversarialRound', () => {
  let dir: string;
  let priorAllowStubs: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-adv-round-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'math.js'), 'export function add(a, b) { return a + b; }\n');
    priorAllowStubs = process.env.UAP_DELIVER_ALLOW_STUBS;
    delete process.env.UAP_DELIVER_ALLOW_STUBS;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (priorAllowStubs === undefined) delete process.env.UAP_DELIVER_ALLOW_STUBS;
    else process.env.UAP_DELIVER_ALLOW_STUBS = priorAllowStubs;
  });

  const roundOpts = (
    executor: (prompt: string) => Promise<string>,
    run: SuiteRun
  ) => ({
    instruction: 'implement add()',
    projectRoot: dir,
    filesApplied: ['src/math.js'],
    rungs: [TEST_RUNG],
    executor,
    round: 1,
    runSuite: () => run,
  });

  it('(a) a converged patch that SURVIVES the attack keeps the tests and reports survived', async () => {
    const body = nodeTestFile('adversarial: negative operands', 'assert.equal(add(-1, -2), -3);');
    const executor = async () => fileBlock('test/adversarial-round-1.test.js', body);
    const r = await runAdversarialRound(
      roundOpts(executor, { exitCode: 0, output: '✔ adversarial: negative operands (0.4ms)\nℹ tests 1\n' })
    );
    expect(r.status).toBe('survived');
    expect(r.authored).toBe(1);
    expect(r.ran).toBe(1);
    expect(r.failed).toBe(0);
    // Surviving tests STAY: they are additive regression tests now.
    expect(r.testFiles).toEqual(['test/adversarial-round-1.test.js']);
    expect(readFileSync(join(dir, 'test', 'adversarial-round-1.test.js'), 'utf-8')).toBe(body);
  });

  it('(b) a FAILING adversarial test breaches, stays in the tree, and names the failure', async () => {
    const executor = async () =>
      fileBlock(
        'test/adversarial-round-1.test.js',
        nodeTestFile('adversarial: empty input', 'assert.equal(add(), 0);')
      );
    const r = await runAdversarialRound(
      roundOpts(executor, {
        exitCode: 1,
        output: '✖ adversarial: empty input (0.6ms)\n  AssertionError: NaN !== 0\nℹ tests 1\nℹ fail 1\n',
      })
    );
    expect(r.status).toBe('breached');
    expect(r.failed).toBe(1);
    expect(r.feedback).toContain('adversarial: empty input');
    expect(r.feedback).toContain('AssertionError');
    // The failing test REMAINS: it is the gate evidence the loop must fix.
    expect(existsSync(join(dir, 'test', 'adversarial-round-1.test.js'))).toBe(true);
  });

  it('(c) a round whose tests never RUN is no-surface, recorded distinctly, and rolled back', async () => {
    const executor = async () =>
      fileBlock('test/adversarial-round-1.test.js', nodeTestFile('ghost test', 'assert.ok(true);'));
    const r = await runAdversarialRound(
      // The suite passes but never reports the authored title or file.
      roundOpts(executor, { exitCode: 0, output: '✔ some other test\nℹ tests 1\n' })
    );
    expect(r.status).toBe('no-surface');
    expect(r.ran).toBe(0);
    expect(r.notes.join(' ')).toMatch(/never reported/);
    // A green suite that never saw the tests is genuinely "no surface" — it
    // must NOT be marked inconclusive (that label is for red-but-unparsed).
    expect(r.notes.join(' ')).not.toMatch(/inconclusive/);
    expect(r.testFiles).toEqual([]);
    expect(existsSync(join(dir, 'test', 'adversarial-round-1.test.js'))).toBe(false);
  });

  it('vitest-style per-file summary proves the tests ran (no per-test lines needed)', async () => {
    const executor = async () =>
      fileBlock('test/adversarial-round-1.test.js', nodeTestFile('edge a', 'assert.ok(true);'));
    const r = await runAdversarialRound(
      roundOpts(executor, {
        exitCode: 0,
        output: '✓ test/adversarial-round-1.test.js (1 test) 12ms\n Tests  1 passed (1)\n',
      })
    );
    expect(r.status).toBe('survived');
    expect(r.ran).toBe(1);
  });

  it('deterministic probe: a stub in the patch breaches WITHOUT a model call', async () => {
    const stub =
      'export const a = () => {};\nexport const b = () => {};\nexport const c = () => {};\n' +
      'export const d = () => {};\nexport const e = () => {};\nexport const f = () => {};\n';
    writeFileSync(join(dir, 'src', 'stubby.js'), stub);
    let modelCalls = 0;
    const executor = async () => {
      modelCalls++;
      return '';
    };
    const r = await runAdversarialRound({
      ...roundOpts(executor, { exitCode: 0, output: '' }),
      filesApplied: ['src/math.js', 'src/stubby.js'],
    });
    expect(r.status).toBe('breached');
    expect(r.feedback).toContain('DETERMINISTIC ADVERSARIAL PROBE');
    expect(r.feedback).toContain('src/stubby.js');
    expect(modelCalls).toBe(0);
  });

  it('no attackable surface / no test rung / model error all record no-surface', async () => {
    const executor = async () => '';
    const noFiles = await runAdversarialRound({
      ...roundOpts(executor, { exitCode: 0, output: '' }),
      filesApplied: [],
    });
    expect(noFiles.status).toBe('no-surface');
    expect(noFiles.feedback).toMatch(/no attackable source files/);

    const noRung = await runAdversarialRound({
      ...roundOpts(executor, { exitCode: 0, output: '' }),
      rungs: [{ ...TEST_RUNG, id: 'build' }],
    });
    expect(noRung.status).toBe('no-surface');
    expect(noRung.feedback).toMatch(/no test gate/);

    const modelDown = await runAdversarialRound({
      ...roundOpts(
        async () => {
          throw new Error('endpoint unreachable');
        },
        { exitCode: 0, output: '' }
      ),
    });
    expect(modelDown.status).toBe('no-surface');
    expect(modelDown.notes.join(' ')).toMatch(/authoring errored/);

    const noBlocks = await runAdversarialRound(roundOpts(async () => 'no blocks here', { exitCode: 0, output: '' }));
    expect(noBlocks.status).toBe('no-surface');
    expect(noBlocks.feedback).toMatch(/no adversarial tests/);
  });

  it('a suite that goes red WITHOUT an authored failure rolls back — recorded as INCONCLUSIVE, not "no surface"', async () => {
    const executor = async () =>
      fileBlock('test/adversarial-round-1.test.js', nodeTestFile('never loaded', 'assert.ok(true);'));
    const r = await runAdversarialRound(
      roundOpts(executor, {
        exitCode: 1,
        output: '✖ test/adversarial-round-1.test.js (2.1ms)\n  SyntaxError: unexpected token\nℹ fail 1\n',
      })
    );
    // Fail-open accept (the attack broke, not the patch) — but the audit
    // trail must separate "suite red, reporter unknown" from "no surface".
    expect(r.status).toBe('no-surface');
    expect(r.notes.join(' ')).toMatch(/failed to load|went red/);
    expect(r.notes.join(' ')).toMatch(/inconclusive:/);
    expect(r.feedback).toMatch(/inconclusive/);
    expect(existsSync(join(dir, 'test', 'adversarial-round-1.test.js'))).toBe(false);
  });

  it('a suite that cannot even spawn is no-surface, not a breach', async () => {
    const executor = async () =>
      fileBlock('test/adversarial-round-1.test.js', nodeTestFile('x', 'assert.ok(true);'));
    const r = await runAdversarialRound(
      roundOpts(executor, { exitCode: null, output: '', spawnError: 'ENOENT' })
    );
    expect(r.status).toBe('no-surface');
    expect(r.notes.join(' ')).toMatch(/spawn error/);
    expect(existsSync(join(dir, 'test', 'adversarial-round-1.test.js'))).toBe(false);
  });
});

describe('adversarial-gate: runAdversarialGate (stage driver)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-adv-stage-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'math.js'), 'export function add(a, b) { return a + b; }\n');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('(d) the escape hatch disables the stage entirely — no model call, no reconverge', async () => {
    let modelCalls = 0;
    let reconverges = 0;
    const initial = convergedResult(['src/math.js']);
    const report = await runAdversarialGate({
      instruction: 'implement add()',
      projectRoot: dir,
      rungs: [TEST_RUNG],
      executor: async () => {
        modelCalls++;
        return '';
      },
      settings: { enabled: false, maxRounds: 0 },
      initial,
      reconverge: async () => {
        reconverges++;
        return initial;
      },
    });
    expect(report.status).toBe('disabled');
    expect(report.rounds).toEqual([]);
    expect(modelCalls).toBe(0);
    expect(reconverges).toBe(0);
    expect(report.result).toBe(initial);
  });

  it('(a) a surviving patch is accepted without re-entering the loop', async () => {
    const initial = convergedResult(['src/math.js']);
    let reconverges = 0;
    const report = await runAdversarialGate({
      instruction: 'implement add()',
      projectRoot: dir,
      rungs: [TEST_RUNG],
      executor: async () =>
        fileBlock('test/adversarial-round-1.test.js', nodeTestFile('edge', 'assert.equal(add(0, 0), 0);')),
      settings: { enabled: true, maxRounds: 2 },
      initial,
      reconverge: async () => {
        reconverges++;
        return initial;
      },
      runSuite: () => ({ exitCode: 0, output: '✔ edge (0.3ms)\nℹ tests 1\n' }),
    });
    expect(report.status).toBe('survived');
    expect(report.summary).toMatch(/survived 1 round/);
    expect(reconverges).toBe(0);
    expect(report.result.success).toBe(true);
  });

  it('(b) a breach routes back into the loop with the failure as feedback, then survives', async () => {
    const initial = convergedResult(['src/math.js']);
    const prompts: string[] = [];
    const breaches: string[][] = [];
    let suiteCalls = 0;
    const report = await runAdversarialGate({
      instruction: 'implement add()',
      projectRoot: dir,
      rungs: [TEST_RUNG],
      // Round 1 authors a breaking test; round 2 (post-repair) authors one that passes.
      executor: async () =>
        fileBlock(
          `test/adversarial-round-${suiteCalls + 1}.test.js`,
          nodeTestFile(`edge round ${suiteCalls + 1}`, 'assert.equal(add(1, 1), 2);')
        ),
      settings: { enabled: true, maxRounds: 2 },
      initial,
      reconverge: async (prompt) => {
        prompts.push(prompt);
        return convergedResult(['src/math.js']);
      },
      // The breach hook fires BEFORE reconvergence so the caller can extend
      // the repair executor's protected set with the breaching files.
      onBreach: (breach) => {
        expect(prompts).toHaveLength(0);
        breaches.push(breach.testFiles);
      },
      runSuite: () => {
        suiteCalls++;
        return suiteCalls === 1
          ? { exitCode: 1, output: '✖ edge round 1 (0.5ms)\nℹ fail 1\n' }
          : { exitCode: 0, output: '✔ edge round 2 (0.5ms)\nℹ tests 1\n' };
      },
    });
    expect(report.status).toBe('survived');
    expect(report.rounds).toHaveLength(2);
    expect(report.failed).toBe(1);
    expect(report.authored).toBe(2);
    // The loop received the breach as ordinary feedback.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('implement add()');
    expect(prompts[0]).toContain('ADVERSARIAL GATE BREACH');
    expect(prompts[0]).toContain('edge round 1');
    // onBreach carried the breaching files for protection before the repair ran.
    expect(breaches).toEqual([['test/adversarial-round-1.test.js']]);
    // Repaired-then-accepted KEEPS the breaching tests: they pass now, and
    // are regression tests (only a TERMINAL breach rolls them back).
    expect(existsSync(join(dir, 'test', 'adversarial-round-1.test.js'))).toBe(true);
    expect(readFileSync(join(dir, 'test', 'adversarial-round-1.test.js'), 'utf-8')).toContain(
      'edge round 1'
    );
    // Histories folded: the accepted result carries both the original and the repair turns.
    expect(report.result.turns).toBe(2);
    expect(report.result.history).toHaveLength(2);
  });

  it('an unrepaired breach rejects the run AND rolls the breaching tests back out of the tree', async () => {
    const initial = convergedResult(['src/math.js']);
    const failed: DeliveryResult = { ...convergedResult(['src/math.js']), success: false, finalFeedback: 'gates still red' };
    const report = await runAdversarialGate({
      instruction: 'implement add()',
      projectRoot: dir,
      rungs: [TEST_RUNG],
      executor: async () =>
        fileBlock('test/adversarial-round-1.test.js', nodeTestFile('breaker', 'assert.equal(add(), 0);')),
      settings: { enabled: true, maxRounds: 2 },
      initial,
      reconverge: async () => {
        // The breaching test pinned the repair attempt — it was still there.
        expect(existsSync(join(dir, 'test', 'adversarial-round-1.test.js'))).toBe(true);
        return failed;
      },
      runSuite: () => ({ exitCode: 1, output: '✖ breaker (0.5ms)\nℹ fail 1\n' }),
    });
    expect(report.status).toBe('breached');
    expect(report.result.success).toBe(false);
    expect(report.result.finalFeedback).toContain('adversarial gate');
    expect(report.result.finalFeedback).toContain('gates still red');
    // TERMINAL breach: a rejected run never leaves the user's suite red —
    // the round's authored files come back out (the keep-best rollback rail
    // settled before this stage, so this is the only rail left).
    expect(existsSync(join(dir, 'test', 'adversarial-round-1.test.js'))).toBe(false);
    expect(report.rounds[0].notes.join(' ')).toMatch(/terminal breach.*rolled back/);
  });

  it('a repair that DELETES the breaching test is rejected, not accepted (vacuous-repair check)', async () => {
    const initial = convergedResult(['src/math.js']);
    const report = await runAdversarialGate({
      instruction: 'implement add()',
      projectRoot: dir,
      rungs: [TEST_RUNG],
      executor: async () =>
        fileBlock('test/adversarial-round-1.test.js', nodeTestFile('breaker', 'assert.equal(add(), 0);')),
      settings: { enabled: true, maxRounds: 2 },
      initial,
      reconverge: async () => {
        // The cheating "repair": remove the evidence, report success. Its
        // gates go green trivially — the post-repair verification must not
        // be fooled (the t0 protection snapshot predates the attack file).
        rmSync(join(dir, 'test', 'adversarial-round-1.test.js'), { force: true });
        return convergedResult(['src/math.js']);
      },
      runSuite: () => ({ exitCode: 1, output: '✖ breaker (0.5ms)\nℹ fail 1\n' }),
    });
    expect(report.status).toBe('breached');
    expect(report.result.success).toBe(false);
    expect(report.result.finalFeedback).toMatch(/deleted or weakened/);
    expect(report.rounds[0].notes.join(' ')).toMatch(/gutted.*REJECTED|deleted during repair/);
  });

  it('a repair that GUTS the breaching test titles is rejected (file present, tests gone)', async () => {
    const initial = convergedResult(['src/math.js']);
    const report = await runAdversarialGate({
      instruction: 'implement add()',
      projectRoot: dir,
      rungs: [TEST_RUNG],
      executor: async () =>
        fileBlock('test/adversarial-round-1.test.js', nodeTestFile('breaker', 'assert.equal(add(), 0);')),
      settings: { enabled: true, maxRounds: 2 },
      initial,
      reconverge: async () => {
        // Subtler cheat: keep the file, replace the breaching test with a
        // tautology under a different title.
        writeFileSync(
          join(dir, 'test', 'adversarial-round-1.test.js'),
          "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('tautology', () => { assert.ok(true); });\n"
        );
        return convergedResult(['src/math.js']);
      },
      runSuite: () => ({ exitCode: 1, output: '✖ breaker (0.5ms)\nℹ fail 1\n' }),
    });
    expect(report.status).toBe('breached');
    expect(report.result.success).toBe(false);
    expect(report.result.finalFeedback).toMatch(/deleted or weakened/);
    expect(report.rounds[0].notes.join(' ')).toMatch(/removed or renamed/);
    // Terminal rejection rolled the gutted file back out — no red residue.
    expect(existsSync(join(dir, 'test', 'adversarial-round-1.test.js'))).toBe(false);
  });

  it('gate-time redetection attacks a rung set that had NO test gate at t0', async () => {
    const initial = convergedResult(['src/math.js']);
    let redetections = 0;
    const report = await runAdversarialGate({
      instruction: 'implement add()',
      projectRoot: dir,
      // t0: no test rung (greenfield mission — the suite appeared mid-run).
      rungs: [{ ...TEST_RUNG, id: 'build' }],
      redetectRungs: () => {
        redetections++;
        return [TEST_RUNG];
      },
      executor: async () =>
        fileBlock('test/adversarial-round-1.test.js', nodeTestFile('edge', 'assert.equal(add(0, 0), 0);')),
      settings: { enabled: true, maxRounds: 1 },
      initial,
      reconverge: async () => initial,
      runSuite: () => ({ exitCode: 0, output: '✔ edge (0.3ms)\nℹ tests 1\n' }),
    });
    expect(redetections).toBe(1);
    // Attacked via the redetected rung — not the old silent no-surface.
    expect(report.status).toBe('survived');
    expect(report.ran).toBe(1);
  });

  it('a throwing redetector falls back to the t0 rungs (still no-surface, never a crash)', async () => {
    const initial = convergedResult(['src/math.js']);
    const report = await runAdversarialGate({
      instruction: 'implement add()',
      projectRoot: dir,
      rungs: [{ ...TEST_RUNG, id: 'build' }],
      redetectRungs: () => {
        throw new Error('detection unavailable');
      },
      executor: async () =>
        fileBlock('test/adversarial-round-1.test.js', nodeTestFile('edge', 'assert.ok(true);')),
      settings: { enabled: true, maxRounds: 1 },
      initial,
      reconverge: async () => initial,
    });
    expect(report.status).toBe('no-surface');
    expect(report.rounds[0].feedback).toMatch(/no test gate/);
  });

  it('(c) a no-surface round stops the stage — no reconverge, no second model call', async () => {
    const initial = convergedResult(['src/math.js']);
    let modelCalls = 0;
    let reconverges = 0;
    const report = await runAdversarialGate({
      instruction: 'implement add()',
      projectRoot: dir,
      rungs: [TEST_RUNG],
      executor: async () => {
        modelCalls++;
        return 'no file blocks authored';
      },
      settings: { enabled: true, maxRounds: 2 },
      initial,
      reconverge: async () => {
        reconverges++;
        return initial;
      },
    });
    expect(report.status).toBe('no-surface');
    expect(report.summary).toMatch(/no attack surface/);
    expect(modelCalls).toBe(1);
    expect(reconverges).toBe(0);
    expect(report.result.success).toBe(true);
  });

  it('round budget is a hard bound: a repaired breach inside the budget is accepted', async () => {
    const initial = convergedResult(['src/math.js']);
    let modelCalls = 0;
    const report = await runAdversarialGate({
      instruction: 'implement add()',
      projectRoot: dir,
      rungs: [TEST_RUNG],
      executor: async () => {
        modelCalls++;
        return fileBlock('test/adversarial-round-1.test.js', nodeTestFile('breaker', 'assert.equal(add(), 0);'));
      },
      // Budget of ONE round: breach → repair → accept (the breaching test
      // stayed in the tree, so the repair had to make it green).
      settings: { enabled: true, maxRounds: 1 },
      initial,
      reconverge: async () => convergedResult(['src/math.js']),
      runSuite: () => ({ exitCode: 1, output: '✖ breaker (0.5ms)\nℹ fail 1\n' }),
    });
    expect(report.status).toBe('survived');
    expect(report.rounds).toHaveLength(1);
    expect(modelCalls).toBe(1);
  });
});

describe('adversarial-gate: real runner (node --test end-to-end)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-adv-e2e-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
    mkdirSync(join(dir, 'src'), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const e2eRung: GateRung = { ...TEST_RUNG, command: 'node', args: ['--test'] };

  it('correct implementation survives a real adversarial test run', async () => {
    writeFileSync(join(dir, 'src', 'math.js'), 'export function add(a, b) { return a + b; }\n');
    const r = await runAdversarialRound({
      instruction: 'implement add()',
      projectRoot: dir,
      filesApplied: ['src/math.js'],
      rungs: [e2eRung],
      executor: async () =>
        fileBlock(
          'test/adversarial-round-1.test.js',
          nodeTestFile('adversarial: negative operands', 'assert.equal(add(-1, -2), -3);')
        ),
      round: 1,
    });
    expect(r.status).toBe('survived');
    expect(r.ran).toBe(1);
    expect(existsSync(join(dir, 'test', 'adversarial-round-1.test.js'))).toBe(true);
  });

  it('a genuinely buggy implementation is BREACHED by the real suite', async () => {
    // The "converged" patch: add() that ignores its second operand.
    writeFileSync(join(dir, 'src', 'math.js'), 'export function add(a, b) { return a; }\n');
    const r = await runAdversarialRound({
      instruction: 'implement add()',
      projectRoot: dir,
      filesApplied: ['src/math.js'],
      rungs: [e2eRung],
      executor: async () =>
        fileBlock(
          'test/adversarial-round-1.test.js',
          nodeTestFile('adversarial: uses both operands', 'assert.equal(add(2, 3), 5);')
        ),
      round: 1,
    });
    expect(r.status).toBe('breached');
    expect(r.failed).toBe(1);
    expect(r.feedback).toContain('adversarial: uses both operands');
  });
});

describe('adversarial-gate: prompt + reconvergence text', () => {
  it('breachReconvergencePrompt carries the failure and the do-not-weaken rule', () => {
    const prompt = breachReconvergencePrompt('implement add()', {
      round: 1,
      status: 'breached',
      authored: 1,
      ran: 1,
      failed: 1,
      testFiles: ['test/adversarial-round-1.test.js'],
      feedback: 'ADVERSARIAL TEST FAILURE (round 1): ...',
      notes: [],
    });
    expect(prompt).toContain('implement add()');
    expect(prompt).toContain('ADVERSARIAL TEST FAILURE');
    expect(prompt).toMatch(/never delete, skip, or weaken/i);
  });

  it('buildAttackPrompt names the changed files, the test gate, and the additive rule', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uap-adv-prompt-'));
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'math.js'), 'export const add = (a, b) => a + b;\n');
      const prompt = buildAttackPrompt('implement add()', dir, ['src/math.js'], TEST_RUNG, 1);
      expect(prompt).toContain('implement add()');
      expect(prompt).toContain('src/math.js');
      expect(prompt).toContain('export const add');
      expect(prompt).toContain('node --test');
      expect(prompt).toMatch(/never[\s\S]*weaken existing tests/);
      expect(prompt).toContain('adversarial-round-1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
