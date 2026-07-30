/**
 * Turn-end substance sweep over shell writes.
 *
 * The module-level cases exercise the attribution rules directly; the executor
 * cases run REAL `bash -c` commands through the real tool loop, because the
 * whole point of this change is that the shell path bypasses the tool handlers —
 * a test that fakes the shell would be testing the thing that already worked.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  symlinkSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  BACKUP_DIR,
  DEFAULT_LIMITS,
  beginBashSweep,
  armSweepForCommand,
  disabledSweep,
  finishBashSweep,
  prependSweepNote,
  recordAuthorisedWrite,
} from '../../src/delivery/bash-sweep.js';
import { createAgenticExecutor } from '../../src/delivery/agentic-executor.js';
import type { ModelConfig } from '../../src/models/types.js';

const STUB = `const Player = (function () {
  return { init() {}, update() {}, draw() {}, shoot() {}, reset() {}, onHit() {} };
})();`;

const REAL = `const Player = (function () {
  let x = 0;
  function init(c) { x = c.width / 2; }
  function update(dt) { x += dt; if (x < 0) x = 0; }
  function draw(g) { g.fillRect(x, 10, 8, 8); }
  function shoot(b) { b.push({ x }); }
  function reset() { x = 0; }
  function onHit() { x -= 1; }
  return { init, update, draw, shoot, reset, onHit };
})();`;

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'uap-sweep-'));
  dirs.push(d);
  return d;
}
const priorAllow = process.env.UAP_DELIVER_ALLOW_STUBS;
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (priorAllow === undefined) delete process.env.UAP_DELIVER_ALLOW_STUBS;
  else process.env.UAP_DELIVER_ALLOW_STUBS = priorAllow;
});

describe('bash sweep — attribution', () => {
  it('removes a stub that appeared with no authorisation', () => {
    const dir = tmp();
    const sweep = beginBashSweep(dir, true);
    armSweepForCommand(sweep);
    writeFileSync(join(dir, 'player.js'), STUB); // as if by `cat > player.js`
    const out = finishBashSweep(sweep);
    expect(out.removed).toEqual(['player.js']);
    expect(existsSync(join(dir, 'player.js'))).toBe(false);
    expect(out.note).toMatch(/SKELETON/i);
    expect(out.note).toMatch(/does not bypass/i);
  });

  it('reverts a stub written OVER an existing real file', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'player.js'), REAL);
    const sweep = beginBashSweep(dir, true);
    armSweepForCommand(sweep);
    writeFileSync(join(dir, 'player.js'), STUB);
    const out = finishBashSweep(sweep);
    expect(out.reverted).toEqual(['player.js']);
    expect(readFileSync(join(dir, 'player.js'), 'utf-8')).toBe(REAL);
  });

  it('reverts to what write_file wrote, not to the turn-start content', () => {
    // The hole a plain allow-list would leave: write the real implementation
    // with a guarded tool, then hollow it out with sed. Comparing against the
    // AUTHORISED content is what catches that, and the revert must land on the
    // guarded write rather than throwing away that turn's legitimate work.
    const dir = tmp();
    writeFileSync(join(dir, 'player.js'), '// original\n');
    const sweep = beginBashSweep(dir, true);
    recordAuthorisedWrite(sweep, 'player.js', REAL); // as if by write_file
    writeFileSync(join(dir, 'player.js'), REAL);
    armSweepForCommand(sweep); // first shell command: baseline taken here
    writeFileSync(join(dir, 'player.js'), STUB); // as if by sed -i
    const out = finishBashSweep(sweep);
    expect(out.reverted).toEqual(['player.js']);
    expect(readFileSync(join(dir, 'player.js'), 'utf-8')).toBe(REAL);
  });

  it('leaves a guarded write alone when the shell never touched it', () => {
    const dir = tmp();
    const sweep = beginBashSweep(dir, true);
    // write_file is allowed to land a stub under the monotone-progress rule; the
    // sweep must not second-guess a verdict the handler already made.
    recordAuthorisedWrite(sweep, 'player.js', STUB);
    writeFileSync(join(dir, 'player.js'), STUB);
    armSweepForCommand(sweep);
    const out = finishBashSweep(sweep);
    expect(out.removed).toEqual([]);
    expect(out.reverted).toEqual([]);
    expect(existsSync(join(dir, 'player.js'))).toBe(true);
  });

  it('allows a shell write that IMPLEMENTS more of an existing skeleton', () => {
    // Same monotone-progress rule the write path uses: a FILL step done through
    // the shell must not be reverted just for being incomplete.
    const dir = tmp();
    const skeleton = `const P = {
  init() {}, update() {}, draw() {}, shoot() {}, reset() {},
  onHit() {}, tick() {}, pause() {}, resume() {}, clear() {},
};`;
    writeFileSync(join(dir, 'p.js'), skeleton);
    const sweep = beginBashSweep(dir, true);
    armSweepForCommand(sweep);
    writeFileSync(
      join(dir, 'p.js'),
      skeleton
        .replace('init() {}', 'init(c) { this.x = c.w; }')
        .replace('update() {}', 'update(d) { this.x += d; }')
        .replace('draw() {}', 'draw(g) { g.rect(0, 0, 1, 1); }')
    );
    const out = finishBashSweep(sweep);
    expect(out.reverted).toEqual([]);
    expect(out.removed).toEqual([]);
  });

  it('leaves real shell-written code alone', () => {
    const dir = tmp();
    const sweep = beginBashSweep(dir, true);
    armSweepForCommand(sweep);
    writeFileSync(join(dir, 'player.js'), REAL);
    const out = finishBashSweep(sweep);
    expect(out.removed).toEqual([]);
    expect(readFileSync(join(dir, 'player.js'), 'utf-8')).toBe(REAL);
  });

  it('does nothing when no command ran', () => {
    // Every file that changed came through a guarded tool and was already judged.
    const dir = tmp();
    const sweep = beginBashSweep(dir, true);
    writeFileSync(join(dir, 'player.js'), STUB);
    const out = finishBashSweep(sweep);
    expect(sweep.baselined).toBe(false); // the walk never happened
    expect(out.removed).toEqual([]);
    expect(existsSync(join(dir, 'player.js'))).toBe(true);
  });

  it('does nothing when bash is disabled, and takes no baseline', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'a.js'), REAL);
    const sweep = beginBashSweep(dir, false);
    expect(sweep.enabled).toBe(false);
    armSweepForCommand(sweep);
    expect(sweep.baseline.size).toBe(0); // never walks when disabled
    expect(finishBashSweep(sweep).note).toBe('');
  });

  it('honors the operator override', () => {
    const dir = tmp();
    process.env.UAP_DELIVER_ALLOW_STUBS = '1';
    const sweep = beginBashSweep(dir, true);
    armSweepForCommand(sweep);
    writeFileSync(join(dir, 'player.js'), STUB);
    expect(finishBashSweep(sweep).removed).toEqual([]);
    expect(existsSync(join(dir, 'player.js'))).toBe(true);
  });

  it('skips build output and harness state', () => {
    const dir = tmp();
    const sweep = beginBashSweep(dir, true);
    armSweepForCommand(sweep);
    for (const d of ['node_modules', 'dist', '.uap']) {
      mkdirSync(join(dir, d), { recursive: true });
      writeFileSync(join(dir, d, 'player.js'), STUB);
    }
    const out = finishBashSweep(sweep);
    expect(out.removed).toEqual([]);
    expect(existsSync(join(dir, 'dist/player.js'))).toBe(true);
  });

  it('does not follow symlinks out of the project root', () => {
    const outside = tmp();
    writeFileSync(join(outside, 'player.js'), STUB);
    const dir = tmp();
    const sweep = beginBashSweep(dir, true);
    armSweepForCommand(sweep);
    try {
      symlinkSync(outside, join(dir, 'link'));
    } catch {
      return; // no symlink permission (Windows CI) — nothing to assert
    }
    expect(finishBashSweep(sweep).removed).toEqual([]);
    expect(existsSync(join(outside, 'player.js'))).toBe(true);
  });

  it('does NOT delete a pre-existing file the content baseline skipped', () => {
    // The P0 the first version shipped with, verified before the fix: a file
    // over the read cap has no baseline CONTENT, which was read as "created this
    // turn" and therefore deleted. Existence is tracked separately for exactly
    // this reason.
    const dir = tmp();
    // Over the read cap at baseline time, under it after the shell truncates it —
    // which is what makes the "no content therefore new" inference reachable.
    const big = `${STUB}\n// ${'x'.repeat(600)}\n`;
    writeFileSync(join(dir, 'big.js'), big);
    const sweep = beginBashSweep(dir, true, { ...DEFAULT_LIMITS, maxFileBytes: 400 });
    armSweepForCommand(sweep);
    expect(sweep.known.has('big.js')).toBe(true);
    expect(sweep.baseline.has('big.js')).toBe(false);
    writeFileSync(join(dir, 'big.js'), STUB); // shell truncates it to the skeleton
    const out = finishBashSweep(sweep);
    expect(out.removed).toEqual([]);
    expect(existsSync(join(dir, 'big.js'))).toBe(true);
    expect(out.uncovered).toEqual(['big.js']); // reported, not silently skipped
    expect(out.note).toMatch(/too large to check/i);
  });

  it('does NOT delete files past the baseline file-count cap', () => {
    // The cap must not turn untouched files into deletion candidates: reaching
    // it needs no shell write at all, just a big enough tree.
    const dir = tmp();
    for (let i = 0; i < 6; i++) writeFileSync(join(dir, `s${i}.js`), STUB);
    const sweep = beginBashSweep(dir, true, { ...DEFAULT_LIMITS, maxFiles: 2 });
    armSweepForCommand(sweep);
    expect(sweep.known.size).toBe(6);
    expect(sweep.baseline.size).toBe(2);
    const out = finishBashSweep(sweep);
    expect(out.removed).toEqual([]);
    for (let i = 0; i < 6; i++) expect(existsSync(join(dir, `s${i}.js`))).toBe(true);
    // A capped baseline where NOTHING moved is complete coverage as far as the
    // model is concerned — warning about it on every turn is noise, not honesty.
    expect(sweep.truncated).toBe(true);
    expect(out.uncovered).toEqual([]);
    expect(out.note).toBe('');
  });

  it('backs up before it removes or reverts — nothing is destroyed', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'existing.js'), REAL);
    const sweep = beginBashSweep(dir, true);
    armSweepForCommand(sweep);
    writeFileSync(join(dir, 'existing.js'), STUB); // hollowed
    writeFileSync(join(dir, 'fresh.js'), STUB); // created
    const out = finishBashSweep(sweep);
    expect(out.reverted).toEqual(['existing.js']);
    expect(out.removed).toEqual(['fresh.js']);
    expect(readFileSync(join(dir, BACKUP_DIR, 'existing.js'), 'utf-8')).toBe(STUB);
    expect(readFileSync(join(dir, BACKUP_DIR, 'fresh.js'), 'utf-8')).toBe(STUB);
    // The content is preserved, but the note must NOT name the location: it lives
    // under `.uap/`, the one directory read_file and list_dir refuse, and pointing
    // an agent at a path the harness then hides is a bug this codebase has already
    // had to fix once.
    expect(out.note).not.toMatch(/\.uap/);
  });

  it('leaves a formatter-style rewrite of an already-stubby file alone', () => {
    // Reverting `prettier --write` and telling the model "your shell command
    // wrote SKELETONS" is both wrong and unactionable. Only a change that adds
    // empty bodies is acted on.
    const dir = tmp();
    writeFileSync(join(dir, 'p.js'), STUB);
    const sweep = beginBashSweep(dir, true);
    armSweepForCommand(sweep);
    writeFileSync(join(dir, 'p.js'), STUB.replace(/\n/g, '\n\n')); // reformatted, same bodies
    const out = finishBashSweep(sweep);
    expect(out.reverted).toEqual([]);
  });

  it('acts when a change ADDS empty bodies to an already-stubby file', () => {
    const dir = tmp();
    const partly = `const P = {
  init(c) { this.x = c.w; }, update(d) { this.x += d; }, draw(g) { g.r(); },
  shoot() {}, reset() {}, onHit() {},
};`;
    writeFileSync(join(dir, 'p.js'), partly);
    const sweep = beginBashSweep(dir, true);
    armSweepForCommand(sweep);
    writeFileSync(join(dir, 'p.js'), STUB); // strictly worse
    expect(finishBashSweep(sweep).reverted).toEqual(['p.js']);
  });

  it('leaves a COMPLIANT scaffold written through the shell', () => {
    // Phase fit, and the reason the sweep needs no epic exemption: SCAFFOLD epics
    // are told to emit throw/todo!()/NotImplementedError bodies, and those are not
    // empty. The one shape that IS quarantined is the one the prompt does not ask
    // for — bare `{}`, which is also the only one that fails silently at runtime.
    const dir = tmp();
    const sweep = beginBashSweep(dir, true);
    armSweepForCommand(sweep);
    writeFileSync(
      join(dir, 'm.ts'),
      ['init', 'update', 'draw', 'shoot', 'reset', 'onHit']
        .map((n) => `export function ${n}() { throw new Error("TODO: ${n}"); }`)
        .join('\n')
    );
    expect(finishBashSweep(sweep).removed).toEqual([]);
    expect(existsSync(join(dir, 'm.ts'))).toBe(true);
  });

  it('does not judge binary files', () => {
    // Falsifiable on purpose: the payload is STUB-SHAPED TEXT plus a NUL, so it
    // trips detectStub and is only spared by the binary sniff. A payload with no
    // braces would pass this test with the sniff deleted.
    const dir = tmp();
    const sweep = beginBashSweep(dir, true);
    armSweepForCommand(sweep);
    writeFileSync(join(dir, 'sprite.dat'), Buffer.concat([Buffer.from(STUB), Buffer.from([0])]));
    const out = finishBashSweep(sweep);
    expect(out.removed).toEqual([]);
    expect(out.failed).toEqual([]);
    expect(existsSync(join(dir, 'sprite.dat'))).toBe(true);
  });

  it('does not corrupt a non-UTF-8 file when reverting', () => {
    // The decoded string is what a revert writes BACK, so a lossy decode silently
    // corrupts the file it is meant to restore. Latin-1 bytes must be treated as
    // out of scope, not round-tripped through U+FFFD.
    const dir = tmp();
    const latin1 = Buffer.concat([Buffer.from(`${REAL}\n// `), Buffer.from([0xe9, 0xe8, 0xff])]);
    writeFileSync(join(dir, 'p.js'), latin1);
    const sweep = beginBashSweep(dir, true);
    armSweepForCommand(sweep);
    writeFileSync(join(dir, 'p.js'), STUB);
    const out = finishBashSweep(sweep);
    expect(out.reverted).toEqual([]); // never baselined, so never restored badly
    expect(out.failed).toEqual([]);
  });

  it('reports, and does not act, when it cannot preserve the content', () => {
    // The whole `failed` path was untested: a regression that swept, decided
    // correctly, and then silently failed to act produced empty reverted/removed
    // arrays — indistinguishable from "found nothing" — and every test still passed.
    const dir = tmp();
    mkdirSync(join(dir, '.uap'), { recursive: true });
    writeFileSync(join(dir, BACKUP_DIR), 'not a directory'); // mkdir will ENOTDIR
    const sweep = beginBashSweep(dir, true);
    armSweepForCommand(sweep);
    writeFileSync(join(dir, 'p.js'), STUB);
    const out = finishBashSweep(sweep);
    expect(out.removed).toEqual([]);
    expect(out.failed).toEqual(['p.js']);
    expect(existsSync(join(dir, 'p.js'))).toBe(true); // left in place, not destroyed
    expect(out.note).toMatch(/could not act on 1 file/i);
  });

  it('keeps every turn\u2019s backup — the promise has to hold ACROSS turns', () => {
    // The retry loop is designed to re-attempt the same file, so the same path
    // being quarantined twice is the common case, not an edge one. A fixed
    // destination would have let turn 2 overwrite turn 1's only copy.
    const dir = tmp();
    const first = `${STUB}\n// turn one\n`;
    const second = `${STUB}\n// turn two\n`;
    for (const body of [first, second]) {
      const sweep = beginBashSweep(dir, true);
      armSweepForCommand(sweep);
      writeFileSync(join(dir, 'p.js'), body);
      expect(finishBashSweep(sweep).removed).toEqual(['p.js']);
    }
    const kept = readdirSync(join(dir, BACKUP_DIR)).map((f) =>
      readFileSync(join(dir, BACKUP_DIR, f), 'utf-8')
    );
    expect(kept).toContain(first);
    expect(kept).toContain(second);
  });

  it('never writes or moves outside the project root, whatever the filename', () => {
    // A POSIX filename may contain backslashes. Translating them to separators —
    // correct on Windows — manufactured `..` segments from a single directory
    // entry, and the sweep wrote and RENAMED outside the project root.
    const outsideParent = tmp();
    const dir = join(outsideParent, 'proj');
    mkdirSync(dir);
    const sweep = beginBashSweep(dir, true);
    armSweepForCommand(sweep);
    writeFileSync(join(dir, '..\\..\\..\\..\\escaped.js'), STUB);
    const out = finishBashSweep(sweep);
    expect(out.failed).toEqual([]);
    // Everything the sweep touched stayed under the project root.
    expect(readdirSync(outsideParent)).toEqual(['proj']);
    expect(existsSync(join(tmpdir(), 'escaped.js'))).toBe(false);
    expect(out.removed).toHaveLength(1);
  });

  it('leaves an UNMOVED file alone even when it is stub-shaped', () => {
    // The sweep skips files whose size and mtime are unchanged, rather than
    // re-reading the whole content baseline on every bash turn. The observable
    // consequence: a pre-existing skeleton the shell never touched is not the
    // sweep's business — it was there before the command and is judged by the
    // write path, not by this one.
    const dir = tmp();
    writeFileSync(join(dir, 'old.js'), STUB);
    for (let i = 0; i < 4; i++) writeFileSync(join(dir, `f${i}.js`), REAL);
    const sweep = beginBashSweep(dir, true);
    armSweepForCommand(sweep);
    writeFileSync(join(dir, 'f0.js'), STUB); // only this one moves
    const out = finishBashSweep(sweep);
    expect(out.reverted).toEqual(['f0.js']);
    expect(out.removed).toEqual([]);
    expect(readFileSync(join(dir, 'old.js'), 'utf-8')).toBe(STUB); // untouched
  });

  it('walks nested build/ and out/ — only the ROOT ones are skipped', () => {
    // Matching those names at any depth made src/build/ a permanent blind spot,
    // and for some web missions the deliverable lives there.
    const dir = tmp();
    const sweep = beginBashSweep(dir, true);
    armSweepForCommand(sweep);
    mkdirSync(join(dir, 'build'), { recursive: true });
    mkdirSync(join(dir, 'src', 'build'), { recursive: true });
    writeFileSync(join(dir, 'build', 'a.js'), STUB);
    writeFileSync(join(dir, 'src', 'build', 'a.js'), STUB);
    const out = finishBashSweep(sweep);
    expect(out.removed).toEqual(['src/build/a.js']);
    expect(existsSync(join(dir, 'build/a.js'))).toBe(true);
  });

  it('refuses to mutate when the backup root cannot be proven inside the project', () => {
    // `.uap` is never WALKED, but it is where backups are WRITTEN, and a shell
    // can replace it with a link. Measured before the check existed: the sweep's
    // own backups landed outside the project root. No trusted backup location
    // means no mutation at all — an unbacked-up destructive action is the one
    // thing this module must never take.
    const outside = tmp();
    const dir = tmp();
    try {
      symlinkSync(outside, join(dir, '.uap'));
    } catch {
      return; // no symlink permission — nothing to assert
    }
    const sweep = beginBashSweep(dir, true);
    armSweepForCommand(sweep);
    writeFileSync(join(dir, 'p.js'), STUB);
    const out = finishBashSweep(sweep);
    expect(out.removed).toEqual([]);
    expect(existsSync(join(dir, 'p.js'))).toBe(true); // left alone, not deleted
    expect(readdirSync(outside)).toEqual([]); // nothing written outside the root
    expect(out.note).toMatch(/could not act/i); // and it SAYS it could not act
  });

  it('disables a second concurrent sweep over the same tree', () => {
    // Two live sweeps cross-attribute: the first one's baseline predates the
    // second's guarded writes, so it can revert a file the other legitimately
    // created. Degrade rather than trust the wiring.
    const dir = tmp();
    const first = beginBashSweep(dir, true);
    const second = beginBashSweep(dir, true);
    expect(first.enabled).toBe(true);
    expect(second.enabled).toBe(false);
    finishBashSweep(first); // releases the root
    expect(beginBashSweep(dir, true).enabled).toBe(true);
  });

  it('is idempotent — a second call does not re-walk or double-report', () => {
    const dir = tmp();
    const sweep = beginBashSweep(dir, true);
    armSweepForCommand(sweep);
    writeFileSync(join(dir, 'p.js'), STUB);
    expect(finishBashSweep(sweep).removed).toEqual(['p.js']);
    expect(finishBashSweep(sweep).removed).toEqual([]);
  });
});

describe('prependSweepNote', () => {
  it('puts the note FIRST so head-truncation cannot drop it', () => {
    // The retry prompt keeps the leading 3000 chars of the previous output, so a
    // note appended after a long summary is exactly what gets cut.
    const out = prependSweepNote('x'.repeat(50), { reverted: [], removed: ['a.js'], uncovered: [], note: '[blocked: …]' });
    expect(out.startsWith('[blocked:')).toBe(true);
  });

  it('is a no-op when there is nothing to say', () => {
    expect(prependSweepNote('done', { reverted: [], removed: [], uncovered: [], note: '' })).toBe('done');
  });

  it('disabledSweep never fires', () => {
    expect(finishBashSweep(disabledSweep()).note).toBe('');
  });
});

// ─── through the real executor, with real shell commands ─────────────────────

const MODEL: ModelConfig = { provider: 'openai-compat', model: 'test', apiKey: 'k' } as ModelConfig;

function chatResponse(msg: unknown): unknown {
  return { ok: true, json: async () => ({ choices: [{ message: msg }] }) };
}
function mockChatSequence(msgs: unknown[]): void {
  let i = 0;
  vi.spyOn(global, 'fetch').mockImplementation(
    async () => chatResponse(msgs[Math.min(i++, msgs.length - 1)]) as unknown as Response
  );
}
const bashCall = (cmd: string): unknown => ({
  content: null,
  tool_calls: [{ id: 'b1', type: 'function', function: { name: 'run_bash', arguments: JSON.stringify({ command: cmd }) } }],
});
const finishCall = {
  content: null,
  tool_calls: [{ id: 'f1', type: 'function', function: { name: 'finish', arguments: '{"summary":"done"}' } }],
};

describe('agentic executor: the shell cannot land a skeleton', () => {
  const bashEnv = ['UAP_SANDBOX_ACTIVE', 'UAP_DELIVER_ALLOW_BASH'] as const;
  const priorBash = bashEnv.map((k) => [k, process.env[k]] as const);
  beforeEach(() => {
    vi.restoreAllMocks();
    // Both of these enable run_bash globally. Under `uap sandbox` —
    // UAP_SANDBOX_ACTIVE=1, the documented way to run this harness — the
    // "bash disabled" case below would otherwise flip red for reasons that have
    // nothing to do with the code under test.
    for (const k of bashEnv) delete process.env[k];
  });
  afterEach(() => {
    for (const [k, v] of priorBash) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  afterEach(() => vi.restoreAllMocks());

  it('removes a heredoc-written stub and tells the model', async () => {
    const dir = tmp();
    mockChatSequence([bashCall(`cat > player.js <<'EOF'\n${STUB}\nEOF`), finishCall]);
    const exec = createAgenticExecutor(MODEL, {
      projectRoot: dir,
      endpoint: 'http://localhost:9/v1',
      allowBash: true,
    });
    const out = await exec('build the player');
    expect(existsSync(join(dir, 'player.js'))).toBe(false);
    expect(out).toMatch(/SKELETON/i);
    expect(out.startsWith('[blocked:')).toBe(true);
  });

  it('leaves a real implementation written through the shell', async () => {
    const dir = tmp();
    mockChatSequence([bashCall(`cat > player.js <<'EOF'\n${REAL}\nEOF`), finishCall]);
    const exec = createAgenticExecutor(MODEL, {
      projectRoot: dir,
      endpoint: 'http://localhost:9/v1',
      allowBash: true,
    });
    const out = await exec('build the player');
    expect(readFileSync(join(dir, 'player.js'), 'utf-8').trim()).toBe(REAL);
    expect(out).not.toMatch(/SKELETON/i);
  });

  it('reverts a sed that hollows out a file write_file just wrote', async () => {
    const dir = tmp();
    mockChatSequence([
      {
        content: null,
        tool_calls: [
          {
            id: 'w1',
            type: 'function',
            function: { name: 'write_file', arguments: JSON.stringify({ path: 'player.js', content: REAL }) },
          },
        ],
      },
      bashCall(`cat > player.js <<'EOF'\n${STUB}\nEOF`),
      finishCall,
    ]);
    const exec = createAgenticExecutor(MODEL, {
      projectRoot: dir,
      endpoint: 'http://localhost:9/v1',
      allowBash: true,
    });
    await exec('build then wreck');
    expect(readFileSync(join(dir, 'player.js'), 'utf-8')).toBe(REAL);
  });

  it('does not sweep when bash is disabled — write_file already guards that path', async () => {
    const dir = tmp();
    mockChatSequence([bashCall(`cat > player.js <<'EOF'\n${STUB}\nEOF`), finishCall]);
    const exec = createAgenticExecutor(MODEL, { projectRoot: dir, endpoint: 'http://localhost:9/v1' });
    const out = await exec('go');
    expect(existsSync(join(dir, 'player.js'))).toBe(false); // the command never ran
    expect(out).not.toMatch(/SKELETON/i);
  });

  it('one edit_file cannot launder a shell-written skeleton', async () => {
    // The mirror of the write_file->sed hole. The shell writes a skeleton; the
    // model then fills ONE body. edit_file's monotone-progress rule measures
    // against the skeleton itself, so the edit is legitimately allowed and the
    // file is stamped as authorised — after which a content-only comparison
    // would skip it forever. Files CREATED this turn are therefore judged on
    // their own content, whatever authorised them.
    const dir = tmp();
    mockChatSequence([
      bashCall(`cat > player.js <<'EOF'\n${STUB}\nEOF`),
      {
        content: null,
        tool_calls: [
          {
            id: 'e1',
            type: 'function',
            function: {
              name: 'edit_file',
              arguments: JSON.stringify({
                path: 'player.js',
                old_string: 'init() {}',
                new_string: 'init(c) { this.x = c.width; }',
              }),
            },
          },
        ],
      },
      finishCall,
    ]);
    const exec = createAgenticExecutor(MODEL, {
      projectRoot: dir,
      endpoint: 'http://localhost:9/v1',
      allowBash: true,
    });
    const out = await exec('scaffold then tweak');
    expect(existsSync(join(dir, 'player.js'))).toBe(false);
    expect(out).toMatch(/SKELETON/i);
  });

  it('sweeps on the round-budget exit', async () => {
    // Six ways out of a turn; a guard at one is a guard the next escapes. This is
    // the exit a weak local model actually takes — it never calls finish.
    const dir = tmp();
    mockChatSequence([bashCall(`cat > player.js <<'EOF'\n${STUB}\nEOF`)]);
    const exec = createAgenticExecutor(MODEL, {
      projectRoot: dir,
      endpoint: 'http://localhost:9/v1',
      allowBash: true,
      maxToolRounds: 1,
    });
    const out = await exec('go');
    expect(out).toMatch(/round budget/i);
    expect(existsSync(join(dir, 'player.js'))).toBe(false);
    expect(out.startsWith('[blocked:')).toBe(true);
  });

  it('sweeps on the throw path, and still lets the error propagate', async () => {
    // The convergence loop routes a thrown executor to its executorError channel
    // and skips the applier and the gate ladder; swallowing the throw into a
    // returned string would silently turn a failed turn into a productive one.
    // The sweep must still run, because a command that wrote a skeleton and then
    // died is exactly when the tree must not be left holding it.
    const dir = tmp();
    mockChatSequence([bashCall(`cat > player.js <<'EOF'\n${STUB}\nEOF`), finishCall]);
    const exec = createAgenticExecutor(MODEL, {
      projectRoot: dir,
      endpoint: 'http://localhost:9/v1',
      allowBash: true,
      onToolProgress: () => {
        throw new Error('progress sink blew up');
      },
    });
    await expect(exec('go')).rejects.toThrow(/progress sink blew up/);
    expect(existsSync(join(dir, 'player.js'))).toBe(false); // swept anyway
  });

  it('sweeps even when the command fails after writing', async () => {
    // A command that writes a skeleton and then exits non-zero is precisely when
    // the tree must not be left holding it.
    const dir = tmp();
    mockChatSequence([bashCall(`cat > player.js <<'EOF'\n${STUB}\nEOF\nexit 1`), finishCall]);
    const exec = createAgenticExecutor(MODEL, {
      projectRoot: dir,
      endpoint: 'http://localhost:9/v1',
      allowBash: true,
    });
    await exec('go');
    expect(existsSync(join(dir, 'player.js'))).toBe(false);
  });
});
