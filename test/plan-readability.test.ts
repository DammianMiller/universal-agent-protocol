/**
 * B1 · Plan comprehension gate — the readability rule engine, its config
 * resolution, and the `uap plan validate` wiring (adjudicated hints by
 * default; deterministic teeth under `plan.readability.strict`).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  analyzePlanReadability,
  resolvePlanReadabilityConfig,
} from '../src/models/plan-readability.js';
import { planCommand } from '../src/cli/plan.js';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'uap-readability-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.UAP_PLAN_READABILITY;
  delete process.env.UAP_PLAN_READABILITY_STRICT;
  delete process.env.UAP_PLAN_REVIEW;
  delete process.env.UAP_PLAN_REVIEW_FORCE;
});

const rules = (report: ReturnType<typeof analyzePlanReadability>) =>
  report.findings.map((f) => f.rule);

const READABLE_PLAN = `# Add passphrase protection to share links

This plan adds optional passphrase protection to existing shareable upload
links, so a link works only for people who know the passphrase. Users add a
passphrase at link creation, the server stores a salted hash, and every fetch
of a protected link checks it before serving any bytes. Links without a
passphrase keep working exactly as before, so nothing changes for existing
users and no data migration is needed.

## Data flow

\`\`\`mermaid
graph LR
  U[User] --> C[Create link]
  C --> P{passphrase?}
  P -->|none| S[Serve as before]
  P -->|set| H[Store salted hash]
  F[Fetch] --> G[Check hash]
\`\`\`

## Server changes

The fetch handler enforces the check using the existing session helper,
returning the same not found response for wrong and missing passes.

## Client changes

The create form gains a passphrase field, posted alongside the expiry field.
`;

describe('plan-readability rules', () => {
  it('passes a plan that opens with a summary and progresses to detail', () => {
    const report = analyzePlanReadability(READABLE_PLAN);
    expect(report.passed).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.disabled).toBe(false);
    expect(report.taskItemCount).toBe(0);
  });

  it('flags detail-before-summary: a code block opens the plan', () => {
    const report = analyzePlanReadability(
      '# Migration\n\n```\nALTER TABLE x ADD y int;\n```\n\nSteps then follow.\n'
    );
    expect(report.passed).toBe(false);
    const summary = report.findings.filter((f) => f.rule === 'summary-first');
    expect(summary.length).toBeGreaterThan(0);
    expect(summary.some((f) => f.message.includes('code block'))).toBe(true);
  });

  it('flags a plan whose preamble is a bare task list (no executive summary)', () => {
    const report = analyzePlanReadability('# Plan\n1. build\n2. test\n3. deploy\n');
    expect(report.passed).toBe(false);
    expect(rules(report)).toContain('summary-first');
  });

  it('accepts the `# Title` + `## Summary` shape (empty preamble, summary section)', () => {
    // Code-review finding: strict mode hard-blocked this legitimate structure.
    const plan = `# Refactor upload\n\n## Summary\n\n${'We reorganize the upload pipeline into stages so each step is tested in isolation. '.repeat(2)}\n\n## Steps\n\n1. build\n2. test\n3. deploy\n`;
    const report = analyzePlanReadability(plan, { strict: true });
    expect(rules(report)).not.toContain('summary-first');
    expect(report.passed).toBe(true);
  });

  it('demotes to a warning when the long opening section is not a summary', () => {
    const plan = `# Plan\n\n## Implementation\n\n${'The parserTokenStream feeds configMapLoader via retryQueueHandler in the uploadSession worker stage. '.repeat(2)}\n\n## Done\n\n1. x\n`;
    const report = analyzePlanReadability(plan);
    const summary = report.findings.find((f) => f.rule === 'summary-first');
    expect(summary?.severity).toBe('warning');
    expect(report.passed).toBe(true);
  });

  it('warns when detail density is front-loaded, not when it progresses', () => {
    const summary = `We reorganize the upload pipeline into stages so each step can be
tested in isolation. This summary is long enough to pass the summary gate with
room to spare, because the point here is the abstraction rule.`;
    const frontLoaded = `# Refactor\n\n${summary}\n\n## Implementation detail\n\nUse \`configKeyReload\` and \`src/upload/pipeline.ts\` with \`runTool()\` calls.\n\n## Goal\n\nA clean split with tests around every stage boundary.\n`;
    const flagged = analyzePlanReadability(frontLoaded);
    const progress = flagged.findings.find((f) => f.rule === 'abstraction-progress');
    expect(progress?.severity).toBe('warning');

    // Same sections, order inverted: detail comes last, so no warning.
    const progressive = `# Refactor\n\n${summary}\n\n## Goal\n\nA clean split with tests around every stage boundary.\n\n## Implementation detail\n\nUse \`configKeyReload\` and \`src/upload/pipeline.ts\` with \`runTool()\` calls.\n`;
    expect(rules(analyzePlanReadability(progressive))).not.toContain('abstraction-progress');
  });

  it('warns on sections over the word budget', () => {
    const long = `# Plan\n\n${'plan '.repeat(25)}\n\n## Overlong section\n\n${'lorem ipsum dolor '.repeat(110)}`;
    const report = analyzePlanReadability(long);
    const budget = report.findings.find((f) => f.rule === 'section-budget');
    expect(budget?.severity).toBe('warning');
    expect(budget?.message).toContain('Overlong section');
  });

  it('warns on jargon-dense prose but tolerates ordinary wording', () => {
    const dense = `# Plan

The parserTokenStream feeds configMapLoader via retryQueueHandler and
metadataCache in the uploadSession worker. The parserTokenStream feeds
configMapLoader via retryQueueHandler and metadataCache in the uploadSession
worker. The parserTokenStream feeds configMapLoader again for good measure in
the retryQueueHandler stage now.
`;
    const report = analyzePlanReadability(dense);
    const jargon = report.findings.find((f) => f.rule === 'jargon-density');
    expect(jargon?.severity).toBe('warning');
    expect(jargon?.message).toContain('parserTokenStream');

    const plain = analyzePlanReadability(
      `# Plan\n\n${'We will carefully rewrite the upload flow so every step is plain prose that any reviewer can follow without knowing the codebase internals at all. '.repeat(2)}`
    );
    expect(rules(plain)).not.toContain('jargon-density');
  });

  it('requires a diagram at the task threshold and counts what it saw', () => {
    const sixTasks = '# Plan\n\n1. first\n2. second\n3. third\n4. fourth\n5. fifth\n6. sixth\n';
    const noDiagram = analyzePlanReadability(sixTasks);
    expect(noDiagram.passed).toBe(false);
    expect(noDiagram.taskItemCount).toBe(6);
    expect(rules(noDiagram)).toContain('diagram-required');

    const withDiagram = analyzePlanReadability(
      sixTasks + '\n```mermaid\ngraph LR\n A --> B\n```\n'
    );
    expect(rules(withDiagram)).not.toContain('diagram-required');
    expect(withDiagram.taskItemCount).toBe(6);

    const threeTasks = analyzePlanReadability('# Plan\n\n1. a\n2. b\n3. c\n');
    expect(rules(threeTasks)).not.toContain('diagram-required');

    const disabledRule = analyzePlanReadability(sixTasks, { requireDiagramAtTasks: 0 });
    expect(rules(disabledRule)).not.toContain('diagram-required');
  });

  it('reports disabled without findings when the gate is off', () => {
    const report = analyzePlanReadability('# Plan\n1. x\n', { enabled: false });
    expect(report.disabled).toBe(true);
    expect(report.passed).toBe(true);
    expect(report.findings).toEqual([]);
  });

  it('renders an adjudicated hint block for the judge prompt', () => {
    const report = analyzePlanReadability('# Plan\n1. x\n');
    expect(report.hintBlock.length).toBeGreaterThan(0);
    expect(report.hintBlock.join('\n')).toContain('AUTOMATED READABILITY FINDINGS');
    expect(report.hintBlock.join('\n')).toContain('[error] summary-first');
    // A clean plan renders silence — noise beats nothing.
    expect(analyzePlanReadability(READABLE_PLAN).hintBlock).toEqual([]);
  });

  it('survives crafted jargon input in linear time (ReDoS regression)', () => {
    // The security review hung `uap plan validate` for ~8s at 30 chars with
    // the nested camelCase regex; this 60-char variant would run for hours.
    // The flattened regex must make this a no-op millisecond pass. The test
    // has no timing assertion (flaky) — if the regex regresses to exponential
    // behavior, completion alone blows the vitest timeout.
    const poison = `# Plan\n\n${'a'.repeat(30)} do be ${'xB'.repeat(30)}_ tail\n\n${'word '.repeat(40)}`;
    const report = analyzePlanReadability(poison);
    expect(Array.isArray(report.findings)).toBe(true);
    // Real camelCase is still detected after the fix (≥30 words so the
    // density rule engages; threshold lowered so the fixture stays terse).
    const real = analyzePlanReadability(
      `# Plan\n\n${'The parserTokenStream feeds configMapLoader items here. '.repeat(5)}`,
      { jargonDensityThreshold: 0.1 }
    );
    expect(
      real.findings.some((f) => f.rule === 'jargon-density' && f.message.includes('parserTokenStream'))
    ).toBe(true);
  });

  it('clips plan-authored fragments echoed into finding messages', () => {
    // Heading/jargon fragments ship to the judge endpoint inside hint lines —
    // they must be bounded and control-character-free regardless of input.
    const hostile = `# Plan\n\n${'w '.repeat(30)}\n\n## ${'A'.repeat(5000)}\n\n${'y '.repeat(350)}`;
    const report = analyzePlanReadability(hostile);
    const budget = report.findings.find((f) => f.rule === 'section-budget');
    expect(budget).toBeDefined();
    // The 5000-char hostile heading is clipped to the 80-char budget…
    expect(budget?.message).toContain('…');
    expect(budget?.message.length).toBeLessThan(400);
    for (const f of report.findings) {
      expect(f.message.length).toBeLessThan(400);
      expect(/[\x00-\x08\x0b-\x1f]/.test(f.message)).toBe(false);
    }
  });
});

describe('plan-readability config resolution', () => {
  it('exposes the documented defaults', () => {
    const cfg = resolvePlanReadabilityConfig(undefined, tmp());
    expect(cfg).toMatchObject({
      enabled: true,
      strict: false,
      minSummaryWords: 20,
      maxWordsPerSection: 300,
      jargonDensityThreshold: 0.35,
      requireDiagramAtTasks: 5,
    });
  });

  it('merges .uap.json plan.readability over the defaults', () => {
    const d = tmp();
    writeFileSync(
      join(d, '.uap.json'),
      JSON.stringify({ plan: { readability: { strict: true, minSummaryWords: 5 } } })
    );
    const cfg = resolvePlanReadabilityConfig(undefined, d);
    expect(cfg.strict).toBe(true);
    expect(cfg.minSummaryWords).toBe(5);
    // unrelated sections and malformed configs must not leak in
    expect(cfg.maxWordsPerSection).toBe(300);
  });

  it('ignores a malformed .uap.json (fail-open to defaults)', () => {
    const d = tmp();
    writeFileSync(join(d, '.uap.json'), '{not json');
    const cfg = resolvePlanReadabilityConfig(undefined, d);
    expect(cfg.enabled).toBe(true);
    expect(cfg.minSummaryWords).toBe(20);
  });

  it('honors the env kill switch and strict override', () => {
    const d = tmp();
    process.env.UAP_PLAN_READABILITY = '0';
    expect(resolvePlanReadabilityConfig(undefined, d).enabled).toBe(false);
    process.env.UAP_PLAN_READABILITY = undefined;
    process.env.UAP_PLAN_READABILITY_STRICT = '1';
    expect(resolvePlanReadabilityConfig(undefined, d).strict).toBe(true);
  });
});

describe('uap plan validate — readability wiring', () => {
  const savedExit = () => {
    const prev = process.exitCode;
    process.exitCode = undefined;
    return () => {
      process.exitCode = prev;
    };
  };

  function readState(d: string): Record<string, unknown> {
    try {
      return JSON.parse(readFileSync(join(d, '.uap', 'plan_state.json'), 'utf-8'));
    } catch {
      return {};
    }
  }

  it('feeds the deterministic findings to the judge and records them (advisory by default)', async () => {
    const restore = savedExit();
    try {
      const d = projectWithPlan('# Plan\n1. build\n2. test\n');
      let sawPrompt = '';
      await planCommand('validate', {}, d, {
        reviewExecutor: async (prompt) => {
          sawPrompt = prompt;
          return '{"verdict":"pass","findings":[]}';
        },
      });
      expect(process.exitCode ?? 0).toBe(0);
      expect(sawPrompt).toContain('AUTOMATED READABILITY FINDINGS');
      expect(sawPrompt).toContain('summary-first');
      const state = readState(d);
      const readability = state.readability as { passed: boolean; findings: { rule: string }[] };
      expect(readability.passed).toBe(false);
      expect(readability.findings.map((f) => f.rule)).toContain('summary-first');
    } finally {
      restore();
    }
  });

  it('strict mode refuses the stamp on deterministic errors', async () => {
    const restore = savedExit();
    try {
      const d = projectWithPlan('# Plan\n1. build\n2. test\n', {
        plan: { readability: { strict: true } },
      });
      await planCommand('validate', {}, d, {
        reviewExecutor: async () => '{"verdict":"pass","findings":[]}',
      });
      expect(process.exitCode).toBe(1);
      const validated = (readState(d).validated ?? {}) as Record<string, string>;
      expect(validated).toEqual({});
    } finally {
      restore();
    }
  });

  it('strict mode still blocks when the reviewer is unreachable (local scan, no offline deadlock)', async () => {
    const restore = savedExit();
    process.env.UAP_PLAN_READABILITY_STRICT = '1';
    try {
      const d = projectWithPlan('# Plan\n1. build\n2. test\n');
      await planCommand('validate', {}, d, {
        reviewExecutor: async () => {
          throw new Error('endpoint down');
        },
      });
      expect(process.exitCode).toBe(1);
      const validated = (readState(d).validated ?? {}) as Record<string, string>;
      expect(validated).toEqual({});
    } finally {
      delete process.env.UAP_PLAN_READABILITY_STRICT;
      restore();
    }
  });

  it('UAP_PLAN_REVIEW_FORCE=1 stamps over a strict readability failure', async () => {
    const restore = savedExit();
    process.env.UAP_PLAN_READABILITY_STRICT = '1';
    process.env.UAP_PLAN_REVIEW_FORCE = '1';
    try {
      const d = projectWithPlan('# Plan\n1. build\n2. test\n');
      await planCommand('validate', {}, d, {
        reviewExecutor: async () => '{"verdict":"pass","findings":[]}',
      });
      expect(process.exitCode ?? 0).toBe(0);
      const state = readState(d);
      expect(Object.keys(state.validated as Record<string, string>)).toContain('implementation-plan.md');
      expect((state.readability as { passed: boolean }).passed).toBe(false);
    } finally {
      delete process.env.UAP_PLAN_READABILITY_STRICT;
      delete process.env.UAP_PLAN_REVIEW_FORCE;
      restore();
    }
  });

  it('UAP_PLAN_REVIEW=0 restores stamp-only behavior: no scan, no reviewer call', async () => {
    const restore = savedExit();
    process.env.UAP_PLAN_REVIEW = '0';
    try {
      const d = projectWithPlan('# Plan\n1. build\n2. test\n');
      let called = false;
      await planCommand('validate', {}, d, {
        reviewExecutor: async () => {
          called = true;
          return '{"verdict":"pass"}';
        },
      });
      expect(called).toBe(false);
      const state = readState(d);
      expect(state.readability).toBeUndefined();
      expect(Object.keys(state.validated as Record<string, string>)).toContain('implementation-plan.md');
    } finally {
      delete process.env.UAP_PLAN_REVIEW;
      restore();
    }
  });
});

/** Throwaway project with a plan artifact and an optional .uap.json. */
function projectWithPlan(planText: string, config?: Record<string, unknown>): string {
  const d = tmp();
  writeFileSync(join(d, 'implementation-plan.md'), planText);
  mkdirSync(join(d, '.uap'), { recursive: true });
  if (config) writeFileSync(join(d, '.uap.json'), JSON.stringify(config));
  return d;
}
