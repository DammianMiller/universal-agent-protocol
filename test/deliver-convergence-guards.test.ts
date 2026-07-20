import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { buildDecomposePrompt } from '../src/delivery/decompose.js';

// Item 2 — planner file-ownership rule. Behavioral: the decompose prompt must
// tell the planner that every concrete file is created by EXACTLY ONE phase, so
// a contracts/types phase and a later scaffold phase don't both claim the same
// file (octopus run 2026-07-19: duplicate creation across phases confused the
// executor and left js/game.js unowned/unwritten).
describe('decompose prompt — single file-ownership rule', () => {
  it('instructs that every file is created by exactly one phase', () => {
    const prompt = buildDecomposePrompt('Build a multi-module game with js/config.js, js/game.js, js/ui.js');
    expect(prompt).toContain('FILE OWNERSHIP');
    expect(prompt).toContain('EXACTLY ONE phase');
    // a contracts/types phase must not claim another module's file
    expect(prompt).toMatch(/must NOT list another module's file/);
    // and it warns that an unowned file is never delivered
    expect(prompt).toMatch(/no phase creates is never delivered/);
    // scaffold+fill on the same file is explicitly NOT double-ownership
    expect(prompt).toMatch(/one owner across the pair, not two creators/);
  });

  it('keeps the rule present regardless of contracts/scaffold options', () => {
    const withOpts = buildDecomposePrompt('mission', undefined, {
      contractsFirst: true,
      scaffoldFirst: true,
    } as never);
    expect(withOpts).toContain('FILE OWNERSHIP');
    expect(withOpts).toContain('EXACTLY ONE phase');
  });
});

// Planner dependency-ordering rule (option 3): a phase that references a file
// another phase creates (imports / <script src> / <link href>) must dep on it,
// so an index.html linking css/js does not reference not-yet-created files
// (octopus runs kept adding a plan-gap-closure phase for exactly this ordering).
describe('decompose prompt — dependency ordering rule', () => {
  it('requires a phase to dep on phases whose files it references/links', () => {
    const prompt = buildDecomposePrompt('Build a site with index.html linking css/styles.css and js/app.js');
    expect(prompt).toContain('DEPENDENCY ORDERING');
    expect(prompt).toMatch(/MUST (list the other phase in its "deps"|depend on every)/);
    // entry-point/HTML phase must depend on the css + js-module phases it links
    expect(prompt).toMatch(/index.*HTML phase.*MUST depend on/s);
    expect(prompt).toMatch(/not-yet-created file is a broken build/);
  });
});

// Epic sizing: bias toward FEWER, LARGER phases where the context budget permits
// (13-phase one-file-per-phase octopus decompositions were slow + seam-heavy).
describe('decompose prompt — fewer/larger epic sizing', () => {
  it('biases toward consolidating related work up to a fraction of the budget', () => {
    const prompt = buildDecomposePrompt('mission', undefined, {
      sessionTokenBudget: 90000,
    } as never);
    expect(prompt).toContain('PREFER FEWER, LARGER PHASES');
    // packs tightly-coupled sibling files together rather than one-per-phase
    expect(prompt).toMatch(/pack closely-related work into ONE phase/);
    expect(prompt).toMatch(/rather than one file per phase/);
    // but still guards the ceiling
    expect(prompt).toMatch(/[Nn]ever bundle work that would overflow/);
  });

  it('omits the sizing hint when no session budget is provided', () => {
    const prompt = buildDecomposePrompt('mission');
    expect(prompt).not.toContain('PREFER FEWER, LARGER PHASES');
  });
});

// Item 1 — agentic executor write-nudge RE-ARM + escalate. The executor loop is
// coupled to a live chat endpoint (no unit harness), so — like the proxy
// guardrail tests — assert the load-bearing logic at the source level. The
// prior guard fired the write-nudge ONCE (latched `writeNudged`); a stubborn
// read-looping model then burned the whole round budget without writing.
describe('agentic executor — write-nudge re-arm + escalate', () => {
  const execPath = join(process.cwd(), 'src', 'delivery', 'agentic-executor.ts');

  it('re-fires the write-nudge on sustained read-only rounds (not one-time)', () => {
    const src = readFileSync(execPath, 'utf-8');
    // re-fire gate: due again only after WRITE_NUDGE_AFTER more read-only rounds
    expect(src).toContain('dueForWriteNudge');
    expect(src).toContain('round - lastWriteNudgeRound >= WRITE_NUDGE_AFTER');
    expect(src).toContain('writeNudgeCount');
    // the old one-time latch is gone (it caused the read-to-budget failure)
    expect(src).not.toContain('let writeNudged');
  });

  it('escalates the wording on repeat and re-arms after a real write', () => {
    const src = readFileSync(execPath, 'utf-8');
    // second+ firing is harder
    expect(src).toContain('writeNudgeCount >= 2');
    expect(src).toMatch(/Reading again is a failure/);
    // a successful write resets the nudge cycle
    expect(src).toContain('lastWriteNudgeRound = 0');
    expect(src).toContain('writeNudgeCount = 0');
  });
});
