import { describe, expect, it } from 'vitest';
import {
  coverageOf,
  flattenSteps,
  hashSpec,
  manifestIsStale,
  validateManifest,
} from '../src/delivery/interaction/manifest.js';
import { judgeAssertion, needsBaseline, runProbe } from '../src/delivery/interaction/runner.js';
import { judgeInteraction } from '../src/delivery/interaction/verdict.js';
import {
  judgeWatchdog,
  parseWatchdogSample,
  watchdogFailed,
  watchdogSampleScript,
} from '../src/delivery/interaction/watchdog.js';
import type { InteractionDriver, ReadResult } from '../src/delivery/interaction/driver.js';
import type {
  InteractionManifest,
  ProbeResult,
  Step,
} from '../src/delivery/interaction/types.js';

const manifest = (over: Partial<InteractionManifest> = {}): InteractionManifest => ({
  version: 1,
  kind: 'web',
  entry: 'index.html',
  specHash: 'abc',
  generatedAt: '2026-07-26T00:00:00.000Z',
  requirements: [
    { id: 'R1', text: 'shooting an octopus kills it and awards score' },
    { id: 'R2', text: 'ESC pauses the game' },
  ],
  probes: [
    {
      id: 'P1',
      requirementIds: ['R1'],
      mode: 'core',
      description: 'aimed fire kills and scores',
      steps: [{ do: 'wait', ms: 10 }],
      asserts: [{ expect: 'gte', expr: 'kills', value: 1 }],
    },
  ],
  ...over,
});

describe('interaction manifest', () => {
  it('rejects state injection outside accelerated probes', () => {
    const m = manifest({
      probes: [
        {
          id: 'P-cheat',
          requirementIds: ['R1'],
          mode: 'core',
          description: 'injects the state it then asserts',
          steps: [{ do: 'inject', expr: 'score = 100' }],
          asserts: [{ expect: 'gte', expr: 'score', value: 100 }],
        },
      ],
    });
    const problems = validateManifest(m);
    expect(problems.join(' ')).toContain("only allowed in 'accelerated'");
  });

  it('allows injection in an accelerated probe', () => {
    const m = manifest({
      probes: [
        {
          id: 'P-accel',
          requirementIds: ['R1'],
          mode: 'accelerated',
          description: 'jumps to a late-game path',
          steps: [{ do: 'inject', expr: 'level = 5' }],
          asserts: [{ expect: 'gte', expr: 'level', value: 5 }],
        },
      ],
    });
    expect(validateManifest(m)).toEqual([]);
  });

  it('finds injection nested inside a repeat block', () => {
    const steps: Step[] = [
      { do: 'repeat', times: 2, steps: [{ do: 'inject', expr: 'hp = 999' }] },
    ];
    expect(flattenSteps(steps).filter((s) => s.do === 'inject')).toHaveLength(1);
    const problems = validateManifest(
      manifest({
        probes: [
          {
            id: 'P-nested',
            requirementIds: ['R1'],
            mode: 'core',
            description: 'hides an inject inside a repeat',
            steps,
            asserts: [{ expect: 'gte', expr: 'hp', value: 999 }],
          },
        ],
      })
    );
    expect(problems.join(' ')).toContain("only allowed in 'accelerated'");
  });

  it('rejects a probe that asserts nothing', () => {
    const problems = validateManifest(
      manifest({
        probes: [
          {
            id: 'P-empty',
            requirementIds: ['R1'],
            mode: 'core',
            description: 'drives input and claims a pass',
            steps: [{ do: 'wait', ms: 1 }],
            asserts: [],
          },
        ],
      })
    );
    expect(problems.join(' ')).toContain('cannot fail');
  });

  it('reports requirements with no probe as uncovered', () => {
    const ledger = coverageOf(manifest());
    expect(ledger.total).toBe(2);
    expect(ledger.covered).toBe(1);
    expect(ledger.uncovered.map((r) => r.id)).toEqual(['R2']);
  });

  it('detects a manifest mined from different requirements', () => {
    const m = manifest({ specHash: hashSpec('original text') });
    expect(manifestIsStale(m, 'original text')).toBe(false);
    expect(manifestIsStale(m, 'the requirements changed')).toBe(true);
  });
});

describe('assertion judgement', () => {
  it('marks time-based assertions as needing a baseline', () => {
    expect(needsBaseline({ expect: 'increases', expr: 'score', overMs: 100 })).toBe(true);
    expect(needsBaseline({ expect: 'gte', expr: 'score', value: 1 })).toBe(false);
  });

  it('fails an increase that never happened and shows both readings', () => {
    const r = judgeAssertion({ expect: 'increases', expr: 'kills', overMs: 12_000 }, 0, {
      baseline: 0,
      value: 0,
    });
    expect(r.passed).toBe(false);
    expect(r.observed).toBe('0 → 0');
  });

  it('passes an increase that met the threshold', () => {
    const r = judgeAssertion({ expect: 'increases', expr: 'score', overMs: 1000, by: 10 }, 0, {
      baseline: 5,
      value: 20,
    });
    expect(r.passed).toBe(true);
  });

  it('reports an unresolvable observable as a broken probe, not a failing behaviour', () => {
    const r = judgeAssertion({ expect: 'gte', expr: 'Particles.particles.length', value: 1 }, 0, {
      unresolved: "TypeError: Cannot read properties of undefined (reading 'length')",
    });
    expect(r.passed).toBe(false);
    expect(r.unresolved).toBe(true);
    expect(r.expected).toContain('an observable the artifact exposes');
  });

  it('treats runtime errors as a failure of the noErrors assertion', () => {
    const r = judgeAssertion({ expect: 'noErrors' }, 0, {
      errors: ['uncaught: player.takeDamage is not a function'],
    });
    expect(r.passed).toBe(false);
    expect(r.observed).toContain('takeDamage');
  });
});

describe('watchdog', () => {
  it('calls the loop dead when ticks stop in the final window', () => {
    const r = judgeWatchdog([
      { ticks: 100, errors: [], values: {} },
      { ticks: 240, errors: [], values: {} },
      { ticks: 240, errors: [], values: {} },
    ]);
    expect(r.loopAlive).toBe(false);
    expect(watchdogFailed(r)).toBe(true);
  });

  it('does not claim a dead loop for a page that never animated', () => {
    const r = judgeWatchdog([
      { ticks: 0, errors: [], values: {} },
      { ticks: 0, errors: [], values: {} },
    ]);
    expect(r.loopAlive).toBe(true);
    expect(watchdogFailed(r)).toBe(false);
  });

  it('reports NaN in tracked state', () => {
    const r = judgeWatchdog([
      { ticks: 1, errors: [], values: { 'player.x': 100 } },
      { ticks: 2, errors: [], values: { 'player.x': Number.NaN } },
    ]);
    expect(r.nanFields).toEqual(['player.x']);
  });

  it('reports unbounded collection growth', () => {
    const r = judgeWatchdog([
      { ticks: 1, errors: [], values: { 'Particles.list.length': 10 } },
      { ticks: 2, errors: [], values: { 'Particles.list.length': 9000 } },
    ]);
    expect(r.unboundedGrowth.join()).toContain('Particles.list.length');
  });

  it('merges driver-observed errors into the report', () => {
    const r = judgeWatchdog([{ ticks: 5, errors: ['uncaught: boom'], values: {} }], [
      'console: 404 missing.js',
    ]);
    expect(r.errors).toContain('uncaught: boom');
    expect(r.errors).toContain('console: 404 missing.js');
  });

  it('builds a sample script that captures each watched expression', () => {
    const script = watchdogSampleScript(['Enemies.enemies.length']);
    expect(script).toContain('Enemies.enemies.length');
    expect(script).toContain('__uapWatch');
  });

  it('parses a sample and tolerates junk', () => {
    expect(parseWatchdogSample('{"ticks":3,"errors":[],"values":{}}')?.ticks).toBe(3);
    expect(parseWatchdogSample('not json')).toBeNull();
  });
});

describe('interaction verdict', () => {
  const result = (over: Partial<ProbeResult> = {}): ProbeResult => ({
    probeId: 'P1',
    description: 'aimed fire kills and scores',
    mode: 'core',
    requirementIds: ['R1'],
    passed: true,
    assertions: [],
    errors: [],
    durationMs: 10,
    ...over,
  });

  it('quotes the requirement in its own words on a behavioural failure', () => {
    const v = judgeInteraction(
      manifest(),
      [
        result({
          passed: false,
          assertions: [
            { label: 'kills rise', passed: false, expected: 'rise of >= 1', observed: '0 → 0' },
          ],
        }),
      ],
      coverageOf(manifest()),
      undefined
    );
    expect(v.passed).toBe(false);
    expect(v.feedback).toContain('shooting an octopus kills it and awards score');
    expect(v.feedback).toContain('0 → 0');
  });

  it('separates a broken probe from an artifact defect', () => {
    const v = judgeInteraction(
      manifest(),
      [
        result({
          passed: false,
          assertions: [
            {
              label: 'particles exist',
              passed: false,
              unresolved: true,
              expected: 'an observable the artifact exposes',
              observed: 'TypeError: undefined',
            },
          ],
        }),
      ],
      coverageOf(manifest()),
      undefined
    );
    expect(v.feedback).toContain('MANIFEST defects');
    expect(v.feedback).toContain('Do NOT change working code');
  });

  it('labels an accelerated failure as state-injected', () => {
    const v = judgeInteraction(
      manifest(),
      [
        result({
          mode: 'accelerated',
          passed: false,
          assertions: [
            { label: 'gameover reached', passed: false, expected: '"gameover"', observed: '"playing"' },
          ],
        }),
      ],
      coverageOf(manifest()),
      undefined
    );
    expect(v.feedback).toContain('state was injected');
  });

  it('blocks on uncovered requirements only under strict coverage', () => {
    const lenient = judgeInteraction(manifest(), [result()], coverageOf(manifest()), undefined);
    expect(lenient.passed).toBe(true);
    const strict = judgeInteraction(manifest(), [result()], coverageOf(manifest()), undefined, {
      strictCoverage: true,
    });
    expect(strict.passed).toBe(false);
    expect(strict.feedback).toContain('ESC pauses the game');
  });

  it('fails when the watchdog saw the loop die even though every probe passed', () => {
    const v = judgeInteraction(manifest(), [result()], coverageOf(manifest()), {
      errors: [],
      loopAlive: false,
      ticksObserved: 0,
      nanFields: [],
      unboundedGrowth: [],
    });
    expect(v.passed).toBe(false);
    expect(v.feedback).toContain('main loop STOPPED');
  });
});

describe('probe runner', () => {
  class FakeDriver implements InteractionDriver {
    steps: Step[] = [];
    private values: Record<string, unknown>;
    private errs: string[];
    constructor(values: Record<string, unknown> = {}, errs: string[] = []) {
      this.values = values;
      this.errs = errs;
    }
    async start(): Promise<void> {}
    async runStep(step: Step): Promise<void> {
      this.steps.push(step);
      // Firing raises the score, so an `increases` assertion has something real
      // to observe rather than being satisfied by the baseline read alone.
      if (step.do === 'down') this.values.score = Number(this.values.score ?? 0) + 5;
    }
    async read(expr: string): Promise<unknown> {
      return this.values[expr];
    }
    async readDetailed(expr: string): Promise<ReadResult> {
      if (!(expr in this.values)) return { ok: false, error: `${expr} is undefined` };
      return { ok: true, value: this.values[expr] };
    }
    async inject(): Promise<void> {}
    errors(): string[] {
      return this.errs;
    }
    async stop(): Promise<void> {}
  }

  it('captures the baseline before input and passes a real increase', async () => {
    const driver = new FakeDriver({ score: 0 });
    const r = await runProbe(driver, {
      id: 'P-fire',
      requirementIds: ['R1'],
      mode: 'core',
      description: 'firing raises the score',
      steps: [{ do: 'down' }, { do: 'up' }],
      asserts: [{ expect: 'increases', expr: 'score', overMs: 5 }],
    });
    expect(r.passed).toBe(true);
    expect(r.assertions[0].observed).toBe('0 → 5');
  });

  it('refuses to run a non-accelerated probe that injects state', async () => {
    const driver = new FakeDriver({ score: 100 });
    const r = await runProbe(driver, {
      id: 'P-cheat',
      requirementIds: ['R1'],
      mode: 'core',
      description: 'injects then asserts',
      steps: [{ do: 'inject', expr: 'score = 100' }],
      asserts: [{ expect: 'gte', expr: 'score', value: 100 }],
    });
    expect(r.passed).toBe(false);
    expect(r.assertions[0].observed).toContain('injects the state it then asserts');
  });

  it('expands repeat blocks into real input', async () => {
    const driver = new FakeDriver({ score: 0 });
    await runProbe(driver, {
      id: 'P-repeat',
      requirementIds: ['R1'],
      mode: 'core',
      description: 'repeated fire',
      steps: [{ do: 'repeat', times: 3, steps: [{ do: 'down' }, { do: 'up' }] }],
      asserts: [{ expect: 'gte', expr: 'score', value: 15 }],
    });
    expect(driver.steps.filter((s) => s.do === 'down')).toHaveLength(3);
  });

  it('turns a driver failure into a failing result rather than an exception', async () => {
    const broken: InteractionDriver = {
      start: async () => {},
      runStep: async () => {
        throw new Error('browser died');
      },
      read: async () => undefined,
      inject: async () => {},
      errors: () => [],
      stop: async () => {},
    };
    const r = await runProbe(broken, {
      id: 'P-boom',
      requirementIds: ['R1'],
      mode: 'core',
      description: 'driver explodes',
      steps: [{ do: 'wait', ms: 1 }],
      asserts: [{ expect: 'truthy', expr: 'anything' }],
    });
    expect(r.passed).toBe(false);
    expect(r.errors.join()).toContain('browser died');
  });
});
