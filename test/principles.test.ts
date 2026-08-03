/**
 * Engineering principles: the rule set, the per-session rule-1 stance, and the
 * two places the rules are injected.
 *
 * The load-bearing behaviour is that rule 1 is never guessed. "Do not preserve
 * backward compatibility" is right for a side project and destructive on a
 * published one, so UNRESOLVED must stay distinguishable from an answer, and an
 * unattended run must fall back to the answer that cannot delete anything.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  COMPAT_CARVE_OUTS,
  compatRule,
  judgeablePrinciples,
  principlesFor,
} from '../src/principles/rules.js';
import { COMPACT_MAX_LINES, renderCompact, renderFull } from '../src/principles/render.js';
import {
  needsAsking,
  recordStance,
  resolveStance,
  sessionId,
  stanceForUnattended,
} from '../src/principles/stance.js';
import { isCodeWork, maybePrinciplesInjection } from '../src/principles/reactor-inject.js';
import { resolvePrinciplesSection } from '../src/principles/index.js';
import { defaultPromptBuilder } from '../src/delivery/convergence-loop.js';
import { CORE, SCENARIOS } from '../src/config/policy-recommendations.js';

const ROOT = process.cwd();
const ENV = { UAP_SESSION_ID: 'test-session' } as NodeJS.ProcessEnv;

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'uap-principles-'));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

function writeConfig(principles: Record<string, unknown>): void {
  writeFileSync(join(work, '.uap.json'), JSON.stringify({ principles }, null, 2));
}

describe('the rule set', () => {
  it('flips rule 1 with the stance and leaves 2-8 alone', () => {
    expect(compatRule('remove').text).toMatch(/Do not preserve backward compatibility/);
    expect(compatRule('preserve').text).toMatch(/Preserve backward compatibility/);

    const removed = principlesFor('remove');
    const preserved = principlesFor('preserve');
    expect(removed).toHaveLength(8);
    expect(removed.slice(1)).toEqual(preserved.slice(1));
  });

  it('names the surfaces that survive a remove stance', () => {
    // Deleting these is a breaking change for callers you cannot update, which
    // is the difference between this rule being useful and destructive.
    expect(COMPAT_CARVE_OUTS.length).toBeGreaterThan(0);
    const joined = COMPAT_CARVE_OUTS.join(' ').toLowerCase();
    expect(joined).toContain('cli');
    expect(joined).toContain('mcp');
    expect(joined).toContain('schema');
  });
});

describe('rendering', () => {
  it('keeps the deliver section inside its line budget', () => {
    // This rides in every deliver prompt; prompt budget is the scarce resource,
    // and truncated completions are the measured failure mode when it runs out.
    for (const compat of ['preserve', 'remove'] as const) {
      const out = renderCompact({ compat, maturity: 'production', assumed: true });
      expect(out.split('\n').length, compat).toBeLessThanOrEqual(COMPACT_MAX_LINES);
    }
  });

  it('mentions the carve-outs only when the stance can actually delete something', () => {
    expect(renderCompact({ compat: 'remove', maturity: 'greenfield' })).toContain('except on');
    expect(renderCompact({ compat: 'preserve', maturity: 'greenfield' })).not.toContain('except on');
  });

  it('says so when the stance was assumed rather than answered', () => {
    expect(renderCompact({ compat: 'preserve', maturity: 'production', assumed: true })).toContain(
      'assuming preserve'
    );
    expect(
      renderCompact({ compat: 'preserve', maturity: 'production', assumed: false })
    ).not.toContain('assuming preserve');
  });

  it('adds the production caveats only on a production project', () => {
    expect(renderFull({ compat: 'remove', maturity: 'production' })).toContain(
      'are requirements, not speculation'
    );
    expect(renderFull({ compat: 'remove', maturity: 'greenfield' })).not.toContain(
      'are requirements, not speculation'
    );
  });
});

describe('stance resolution', () => {
  it('is unresolved when the project has said nothing', () => {
    const stance = resolveStance(work, ENV);
    expect(stance.compat).toBeNull();
    expect(stance.compatSource).toBe('unresolved');
    expect(needsAsking(stance)).toBe(true);
  });

  it("treats 'ask' as still unanswered, not as a value", () => {
    // The schema default is 'ask'. If that ever resolved to a stance, the whole
    // point — never guessing this rule — would be silently lost.
    writeConfig({ compat: 'ask', maturity: 'ask' });
    const stance = resolveStance(work, ENV);
    expect(stance.compat).toBeNull();
    expect(needsAsking(stance)).toBe(true);
  });

  it('reads a project default from config', () => {
    writeConfig({ compat: 'remove', maturity: 'greenfield' });
    const stance = resolveStance(work, ENV);
    expect(stance.compat).toBe('remove');
    expect(stance.compatSource).toBe('config');
    expect(needsAsking(stance)).toBe(false);
  });

  it('prefers this session over the project default, and env over both', () => {
    writeConfig({ compat: 'preserve', maturity: 'production' });

    recordStance(work, { compat: 'remove' }, ENV);
    expect(resolveStance(work, ENV).compat).toBe('remove');
    expect(resolveStance(work, ENV).compatSource).toBe('session');

    const envOverride = { ...ENV, UAP_PRINCIPLES_COMPAT: 'preserve' };
    expect(resolveStance(work, envOverride).compat).toBe('preserve');
    expect(resolveStance(work, envOverride).compatSource).toBe('env');
  });

  it('scopes a recorded answer to its own session', () => {
    recordStance(work, { compat: 'remove', maturity: 'greenfield' }, ENV);
    expect(resolveStance(work, ENV).compat).toBe('remove');
    expect(resolveStance(work, { UAP_SESSION_ID: 'a-different-session' }).compat).toBeNull();
  });

  it('falls back to a day key, not a PID, when no session id is exported', () => {
    // A PID-based key changes between two CLI calls a second apart, so the user
    // would answer and be asked again immediately.
    expect(sessionId({} as NodeJS.ProcessEnv)).toMatch(/^day-\d{4}-\d{2}-\d{2}$/);
    expect(sessionId({ CLAUDE_SESSION_ID: 'abc' } as NodeJS.ProcessEnv)).toBe('abc');
  });

  it('survives a corrupt session store instead of throwing', () => {
    mkdirSync(join(work, '.uap'), { recursive: true });
    writeFileSync(join(work, '.uap/principles-session.json'), '{ not json');
    expect(() => resolveStance(work, ENV)).not.toThrow();
    expect(resolveStance(work, ENV).compat).toBeNull();
  });

  it('ignores a value that is neither of the two answers', () => {
    writeConfig({ compat: 'delete', maturity: 'prod' }); // typos, not answers
    const stance = resolveStance(work, ENV);
    expect(stance.compat).toBeNull();
    expect(stance.maturity).toBeNull();
  });

  it('does not claim compat was assumed when only maturity is missing', () => {
    // `assumed` drives the "assuming preserve" line in the prompt. Keyed off
    // "is anything unanswered", a project that answered compat=remove but not
    // maturity would render "Delete obsolete paths" and "assuming preserve"
    // together — and answering the two separately is a supported flow.
    writeConfig({ compat: 'remove' });
    const resolved = stanceForUnattended(resolveStance(work, ENV));
    expect(resolved.compat).toBe('remove');
    expect(resolved.assumed).toBe(false);
    expect(renderCompact(resolved)).not.toContain('assuming preserve');
  });

  it('accepts an answer recorded just before a UTC day rollover', () => {
    // With no session id exported the key is the UTC day, so a session running
    // across midnight would otherwise lose its answer — and the reactor, having
    // already asked, would never ask again.
    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const key = `day-${yesterday.toISOString().slice(0, 10)}`;
    mkdirSync(join(work, '.uap'), { recursive: true });
    writeFileSync(
      join(work, '.uap/principles-session.json'),
      JSON.stringify({ [key]: { compat: 'remove', maturity: 'greenfield' } })
    );

    expect(resolveStance(work, {} as NodeJS.ProcessEnv).compat).toBe('remove');
  });

  it('assumes preserve for an unattended run, and flags it as assumed', () => {
    const assumed = stanceForUnattended(resolveStance(work, ENV));
    expect(assumed.compat).toBe('preserve'); // the answer that cannot delete anything
    expect(assumed.assumed).toBe(true);

    writeConfig({ compat: 'remove', maturity: 'greenfield' });
    const answered = stanceForUnattended(resolveStance(work, ENV));
    expect(answered.compat).toBe('remove');
    expect(answered.assumed).toBe(false);
  });
});

describe('reactor injection', () => {
  it('asks once while the stance is unresolved, then goes quiet', () => {
    const asked = maybePrinciplesInjection(work, 'implement the parser');
    expect(asked).toContain('once per project per session');
    expect(asked).toContain('uap principles');

    writeConfig({ compat: 'preserve', maturity: 'production' });
    expect(maybePrinciplesInjection(work, 'implement the parser')).toBeNull();
  });

  it('stays silent on work that is not going to write code', () => {
    expect(maybePrinciplesInjection(work, 'what does this repo do?')).toBeNull();
    expect(isCodeWork('refactor the router')).toBe(true);
    expect(isCodeWork(undefined, ['src/a.ts'])).toBe(true);
    expect(isCodeWork('summarise yesterday')).toBe(false);
  });

  it('honours principles.enabled: false', () => {
    writeConfig({ enabled: false });
    expect(maybePrinciplesInjection(work, 'implement the parser')).toBeNull();
  });
});

describe('deliver prompt injection', () => {
  const base = { instruction: 'build a thing', principles: 'ENGINEERING PRINCIPLES — test marker' };

  it('is present on the first turn AND on a retry', () => {
    // A retry is where a model cuts corners to get green, so dropping the
    // principles after turn 1 would remove them exactly when they matter most.
    expect(defaultPromptBuilder({ ...base, turn: 1 })).toContain('test marker');
    expect(
      defaultPromptBuilder({ ...base, turn: 2, feedback: 'tests failed', previousOutput: 'x' })
    ).toContain('test marker');
  });

  it('costs nothing when it is not configured', () => {
    expect(defaultPromptBuilder({ instruction: 'build a thing', turn: 1 })).not.toContain(
      'ENGINEERING PRINCIPLES'
    );
  });

  it('is suppressed by principles.injectDeliver: false', () => {
    writeConfig({ injectDeliver: false });
    expect(resolvePrinciplesSection(work)).toBeUndefined();

    writeConfig({ compat: 'preserve', maturity: 'production' });
    expect(resolvePrinciplesSection(work)).toContain('ENGINEERING PRINCIPLES');
  });

  it('falls back to preserve end-to-end when the project has configured nothing', () => {
    // The full chain the loop calls — resolve -> unattended fallback -> render.
    // An inlined `?? 'preserve'` that forgot to mark it assumed would drop the
    // disclosure and pass every unit test above.
    const section = resolvePrinciplesSection(work)!;
    expect(section).toContain('Keep existing paths working');
    expect(section).toContain('assuming preserve');
    expect(section).not.toContain('Delete obsolete paths');
  });

  it('gives the judge only the rules a diff can actually show', () => {
    // Rule 1 depends on a stance the judge is not told, and rules 3/4 are
    // properties of a codebase over time — scoring those invites confident noise.
    const line = judgeablePrinciples();
    expect(line).toContain('Simplest implementation');
    expect(line).toContain('no stopgaps');
    expect(line).not.toMatch(/backward compatibility/i);
    expect(line).not.toContain('smallest end-to-end');
  });
});

describe('policy catalog wiring', () => {
  it('every recommended slug resolves to a catalog file, or to a staged one', () => {
    // engineering-principles ships staged under patches/policy-catalog/ because
    // self-protect forbids agent writes to src/policies/**. This pins that the
    // staging exists for as long as something recommends the slug — otherwise
    // `uap policy install <slug>` would be advertised and fail.
    const slugs = [...CORE, ...SCENARIOS.flatMap((s) => s.extra ?? [])].map((r) => r.slug);
    for (const slug of new Set(slugs)) {
      const installed = existsSync(join(ROOT, `src/policies/schemas/policies/${slug}.md`));
      const staged = existsSync(join(ROOT, `patches/policy-catalog/${slug}.md`));
      expect(installed || staged, `${slug} has no catalog entry`).toBe(true);
    }
  });

  it('the catalog entry uses its slug as the H1', () => {
    // The installer resolves by id, then name, then slug; an H1 that is a title
    // rather than the slug silently strands the policy. Checks whichever
    // location the file currently lives in, so this keeps passing once an
    // operator moves it out of staging into src/policies/schemas/policies/.
    const staged = join(ROOT, 'patches/policy-catalog/engineering-principles.md');
    const installed = join(ROOT, 'src/policies/schemas/policies/engineering-principles.md');
    const path = existsSync(installed) ? installed : staged;

    const md = readFileSync(path, 'utf-8');
    expect(md.split('\n')[0]).toBe('# engineering-principles');
    expect(md).toContain('**Level**: RECOMMENDED');
  });

  it('registers the prior-art pattern the router can actually match', () => {
    const index = JSON.parse(readFileSync(join(ROOT, '.factory/patterns/index.json'), 'utf-8'));
    const p38 = index.patterns.find((p: { id: number }) => p.id === 38);
    expect(p38?.file).toBe('P38_prior_art_first.md');
    expect(existsSync(join(ROOT, '.factory/patterns', p38.file))).toBe(true);
    // The router matches on these keywords — an entry without them never fires.
    expect(p38.keywords.length).toBeGreaterThan(0);
  });
});
