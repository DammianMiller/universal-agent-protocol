/**
 * The rule reaching the actual authoring loop.
 *
 * Testing `neverExecutesReason` alone leaves the whole decision unpinned: five
 * mutants survived that way — the rule unwired, regenerating forever instead of
 * once, the manifest and source-file conditions each dropped, and the feedback
 * no longer naming the remedy. These drive `authorAcceptanceGate`, which is
 * what a real delivery calls.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { authorAcceptanceGate } from '../../src/delivery/self-gate.js';

describe('a grep-only gate is regenerated once, in a project that can run', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'selfgate-run-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** A project whose only signal is a source FILE — no manifest, the fresh-scaffold shape. */
  function scaffold(): void {
    mkdirSync(join(dir, 'lib'), { recursive: true });
    writeFileSync(join(dir, 'lib', 'parse.py'), '# TODO\n');
  }

  it('asks again when the gate only greps, then accepts the one that runs', async () => {
    scaffold();
    const prompts: string[] = [];
    const executor = async (prompt: string) => {
      prompts.push(prompt);
      return prompts.length === 1
        ? '```bash\ngrep -q "def parse_line" lib/parse.py || exit 1\n```'
        // Runs AND fails on the unsolved repo: parse_line does not exist yet.
        : '```bash\npython3 -c "import lib.parse as p; assert p.parse_line(\'a=1\') == {\'a\':\'1\'}" || exit 1\n```';
    };
    const res = await authorAcceptanceGate({ instruction: 'implement lib/parse.py', projectRoot: dir, executor });
    expect(res.attempts, 'exactly one extra attempt').toBe(2);
    expect(res.notes.some((n) => /never runs/i.test(n))).toBe(true);
    expect(prompts[1], 'the feedback must name the remedy').toMatch(/run|execute/i);
    expect(prompts[1]).toMatch(/output|exit status/i);
  });

  it('accepts a grep-only gate rather than looping when the model will not change', async () => {
    // One nudge, then take what it gives. Regenerating forever would burn every
    // attempt on a task whose gate the model simply will not rewrite.
    scaffold();
    let calls = 0;
    const executor = async () => {
      calls++;
      return '```bash\ngrep -q "def parse_line" lib/parse.py || exit 1\n```';
    };
    const res = await authorAcceptanceGate({ instruction: 'implement lib/parse.py', projectRoot: dir, executor });
    expect(res.rung, 'a gate is still installed').not.toBeNull();
    expect(res.vacuous).toBe(false);
    expect(calls).toBeLessThanOrEqual(3);
  });

  it('fires on a manifest-only project too', async () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }));
    writeFileSync(join(dir, 'notes.txt'), 'nothing runnable by extension\n');
    const prompts: string[] = [];
    const executor = async (prompt: string) => {
      prompts.push(prompt);
      return prompts.length === 1
        ? '```bash\ngrep -q TODO notes.txt || exit 1\n```'
        : '```bash\nnpm test --silent || exit 1\n```';
    };
    const res = await authorAcceptanceGate({ instruction: 'do the thing', projectRoot: dir, executor });
    expect(res.attempts).toBe(2);
  });

  it('does NOT fire on a project with nothing to run', async () => {
    // Docs only: no manifest, no source. Demanding execution here would burn an
    // attempt to arrive back at the same script.
    writeFileSync(join(dir, 'README.md'), '# docs\n');
    let calls = 0;
    const executor = async () => {
      calls++;
      return '```bash\ngrep -q "Installation" README.md || exit 1\n```';
    };
    const res = await authorAcceptanceGate({ instruction: 'document installation', projectRoot: dir, executor });
    expect(calls, 'accepted first time').toBe(1);
    expect(res.attempts).toBe(1);
  });
});
