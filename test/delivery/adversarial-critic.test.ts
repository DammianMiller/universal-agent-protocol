import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createBoundedCriticController,
  formatAdversarialFeedback,
  formatAdversarialReport,
  parseAdversarialCritique,
  runAdversarialCritic,
  type AdversarialCritiqueVerdict,
} from '../../src/delivery/adversarial-critic.js';
import { buildMissionAcceptanceGate } from '../../src/delivery/mission-acceptance.js';
import { createSpecRegistry } from '../../src/delivery/spec-registry.js';
import { createStructuredDefectCritic, parseDefectTickets } from '../../src/delivery/critic.js';
import { runVerify } from '../../src/cli/verify.js';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

describe('adversarial-critic (Option C1) & structured defect critic (Option B4)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'uap-adv-critic-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(
      join(root, 'src', 'app.js'),
      `export const PAL = { stone: '#888' };\nexport const water = PAL.water;\n`,
      'utf-8'
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('parses 5-axis rubric, sorts blocker > major > polish, and strips polish when blocker/major remain', () => {
    const raw = JSON.stringify({
      axes: {
        completeness: 5,
        craftDensity: 4,
        cohesionPolish: 7,
        framingErgonomics: 6,
        runtimeIntegrity: 3,
      },
      tickets: [
        { severity: 'polish', axis: 'cohesionPolish', target: 'footer', defect: 'margin 2px off', fix: 'adjust padding' },
        { severity: 'major', axis: 'craftDensity', target: 'cards', defect: 'sparse placeholders', fix: 'render full data' },
        { severity: 'blocker', axis: 'runtimeIntegrity', target: 'src/app.js', defect: 'PAL.water undefined', fix: 'define PAL.water' },
      ],
      nextFocus: 'Fix PAL.water undefined and populate missing subsystem content.',
    });

    const verdict = parseAdversarialCritique(raw, 8);
    expect(verdict).not.toBeNull();
    expect(verdict!.pass).toBe(false);
    expect(verdict!.minAxisScore).toBe(3);
    expect(verdict!.overallScore).toBe(5);
    expect(verdict!.tickets.map((t) => t.severity)).toEqual(['blocker', 'major']);
    expect(verdict!.tickets[0].target).toBe('src/app.js');

    const fb = formatAdversarialFeedback(verdict!, 8);
    expect(fb).toContain('ADVERSARIAL CRITIC');
    expect(fb).toContain('[BLOCKER/runtimeIntegrity]');
    expect(fb).not.toContain('[POLISH');

    const rep = formatAdversarialReport(verdict!);
    expect(rep).toContain('ADVERSARIAL CRITIC ✗');
  });

  it('passes only when every axis >= minScore and no blocker/major tickets exist', () => {
    const raw = JSON.stringify({
      axes: {
        completeness: 9,
        craftDensity: 8,
        cohesionPolish: 9,
        framingErgonomics: 8,
        runtimeIntegrity: 9,
      },
      tickets: [
        { severity: 'polish', axis: 'cohesionPolish', target: 'badge', defect: 'optional shadow', fix: 'subtle shadow' },
      ],
      nextFocus: 'None — all criteria met.',
    });

    const verdict = parseAdversarialCritique(raw, 8);
    expect(verdict).not.toBeNull();
    expect(verdict!.pass).toBe(true);
    expect(verdict!.minAxisScore).toBe(8);
    expect(verdict!.tickets).toHaveLength(1);
    expect(verdict!.tickets[0].severity).toBe('polish');
  });

  it('runAdversarialCritic calls fresh-context executor with hollowness note and screenshot data URLs', async () => {
    const shotPath = join(root, 'shot.png');
    writeFileSync(shotPath, PNG_1X1);

    let receivedPrompt = '';
    let receivedImages: string[] | undefined;
    const verdict = await runAdversarialCritic({
      spec: 'Build a complete multi-panel app with valid palette lookups',
      projectRoot: root,
      screenshotPaths: [shotPath],
      executor: async (prompt, images) => {
        receivedPrompt = prompt;
        receivedImages = images;
        return JSON.stringify({
          axes: {
            completeness: 6,
            craftDensity: 5,
            cohesionPolish: 7,
            framingErgonomics: 7,
            runtimeIntegrity: 4,
          },
          tickets: [
            {
              severity: 'blocker',
              axis: 'runtimeIntegrity',
              target: 'src/app.js',
              defect: 'PAL.water is undefined',
              fix: 'Add water key to PAL',
            },
          ],
          nextFocus: 'Fix PAL.water',
        });
      },
    });

    expect(receivedPrompt).toContain('PAL.water');
    expect(receivedPrompt).toContain('STATIC HOLLOWNESS');
    expect(receivedImages).toHaveLength(1);
    expect(receivedImages![0]).toMatch(/^data:image\/png;base64,/);
    expect(verdict.pass).toBe(false);
    expect(verdict.tickets[0].severity).toBe('blocker');
  });

  it('fails open when critic executor throws or emits unparseable output', async () => {
    const errVerdict = await runAdversarialCritic({
      spec: 'Build app',
      projectRoot: root,
      executor: async () => {
        throw new Error('connection refused');
      },
    });
    expect(errVerdict.pass).toBe(true);
    expect(errVerdict.parseError).toContain('connection refused');

    const badVerdict = await runAdversarialCritic({
      spec: 'Build app',
      projectRoot: root,
      executor: async () => 'not valid json',
    });
    expect(badVerdict.pass).toBe(true);
    expect(badVerdict.parseError).toBe('unparseable adversarial critique verdict');
  });

  it('enforces bounded 2-pass upgrade convergence inside buildMissionAcceptanceGate', async () => {
    const ctrl = createBoundedCriticController(2);
    expect(ctrl.canRequestUpgrade(root)).toBe(true);
    expect(ctrl.recordUpgrade(root)).toBe(1);
    expect(ctrl.recordUpgrade(root)).toBe(2);
    expect(ctrl.canRequestUpgrade(root)).toBe(false);

    const criticCalls = vi.fn(
      async (): Promise<AdversarialCritiqueVerdict> => ({
        axes: {
          completeness: 6,
          craftDensity: 5,
          cohesionPolish: 7,
          framingErgonomics: 7,
          runtimeIntegrity: 6,
        },
        overallScore: 6.2,
        minAxisScore: 5,
        pass: false,
        tickets: [
          {
            severity: 'major',
            axis: 'craftDensity',
            target: 'src/app.js',
            defect: 'Shallow implementation',
            fix: 'Flesh out full module',
          },
        ],
        nextFocus: 'Raise craftDensity',
      })
    );

    const gate = buildMissionAcceptanceGate({
      primary: false,
      specs: createSpecRegistry({ initialSpec: 'Build feature', sharedRoot: root, flipLimit: 2 }),
      judgeExecutor: async () =>
        JSON.stringify({
          criteria: [{ requirement: 'Build feature', met: true, reason: 'ok' }],
          pass: true,
        }),
      visualGate: async () => ({ skipped: true, passed: true, structural: false, pages: [], feedback: '' }),
      adversarialCriticExecutor: async () => '{}',
      adversarialCritic: criticCalls,
      criticMaxPasses: 2,
      criticMinScore: 8,
      note: () => {},
    });

    // Pass 1: objective & acceptance pass, adversarial critic requests upgrade #1
    const r1 = await gate(root, { ladderPassed: true });
    expect(r1.passed).toBe(false);
    expect(r1.feedback).toContain('ADVERSARIAL CRITIC');
    expect(criticCalls).toHaveBeenCalledTimes(1);

    // Pass 2: requests upgrade #2
    const r2 = await gate(root, { ladderPassed: true });
    expect(r2.passed).toBe(false);
    expect(criticCalls).toHaveBeenCalledTimes(2);

    // Pass 3: budget exhausted (2/2) -> accepts cleanly without calling critic again
    const r3 = await gate(root, { ladderPassed: true });
    expect(r3.passed).toBe(true);
    expect(criticCalls).toHaveBeenCalledTimes(2);
  });

  it('createStructuredDefectCritic ranks blocker > major, suppresses polish, and falls back to numbered text', async () => {
    const parsed = parseDefectTickets(
      JSON.stringify({
        tickets: [
          { severity: 'polish', axis: 'cohesionPolish', target: 'css', defect: 'minor tweak', fix: 'tweak' },
          { severity: 'blocker', axis: 'runtimeIntegrity', target: 'src/a.ts', defect: 'crash', fix: 'null guard' },
          { severity: 'major', axis: 'completeness', target: 'src/b.ts', defect: 'missing export', fix: 'export fn' },
        ],
      })
    );
    expect(parsed.map((t) => t.severity)).toEqual(['blocker', 'major']);

    const critic = createStructuredDefectCritic(async () =>
      JSON.stringify({
        tickets: [
          { severity: 'major', axis: 'completeness', target: 'src/x.ts', defect: 'missing handler', fix: 'add handler' },
        ],
      })
    );
    const out = await critic({
      instruction: 'Build CLI',
      record: {
        turn: 1,
        passed: false,
        score: 0.5,
        filesApplied: ['src/x.ts'],
        gateResults: [{ id: 'test', name: 'test', passed: false, skipped: false, exitCode: 1, durationMs: 10, output: '' }],
        durationMs: 100,
      },
      feedback: 'test failed',
      attemptOutput: '',
    });
    expect(out.focusGate).toBe('test');
    expect(out.fixList[0]).toContain('[MAJOR/completeness] src/x.ts');
  });

  it('runVerify({ critic: true }) blocks on failing adversarial critique and fails open on unreachable model', async () => {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'critic-demo', scripts: { test: 'node -e "process.exit(0)"' } }),
      'utf-8'
    );

    const blocked = await runVerify({
      dir: root,
      visual: false,
      interaction: false,
      critic: true,
      criticExecutor: async () =>
        JSON.stringify({
          axes: {
            completeness: 6,
            craftDensity: 5,
            cohesionPolish: 7,
            framingErgonomics: 7,
            runtimeIntegrity: 3,
          },
          tickets: [
            {
              severity: 'blocker',
              axis: 'runtimeIntegrity',
              target: 'src/app.js',
              defect: 'PAL.water undefined',
              fix: 'Add water key to PAL',
            },
          ],
          nextFocus: 'Define PAL.water',
        }),
    });
    expect(blocked.passed).toBe(false);
    expect(blocked.exitCode).toBe(1);
    expect(blocked.blockedBy).toContain('adversarial critic');
    expect(blocked.report).toContain('STATIC HOLLOWNESS');
    expect(blocked.report).toContain('ADVERSARIAL CRITIC ✗');
    expect(blocked.hollownessFindings?.some((f) => f.symbol === 'PAL.water')).toBe(true);

    const failOpen = await runVerify({
      dir: root,
      visual: false,
      interaction: false,
      critic: true,
      criticExecutor: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(failOpen.passed).toBe(true);
    expect(failOpen.exitCode).toBe(0);
  });
});
