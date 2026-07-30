/**
 * The stub-substance guard end to end: every write path refuses a skeleton, the
 * visual gate separates structural failures from graded richness floors, and the
 * contract extractor stops laundering a stub into a "verified" contract.
 *
 * Each case here is the composition the unit tests could not see. The detector
 * being correct in isolation (stub-detector.test.ts) says nothing about whether a
 * write path actually consults it — the failure this whole change exists to fix
 * was a guard that only ran on the branch the bug avoided.
 *
 * Several tests exist because review found the first cut asserting the right
 * outcome for the wrong reason: exemption tests whose payloads had no callables at
 * all (so the exemption list was doing nothing), and a "skipped never blocks" test
 * whose fixture never set the flag whose precedence it claimed to check.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { applyFileBlocks, applyFileBlocksWithRollback, protectedWritePathReason } from '../../src/delivery/applier.js';
import { structuralProblems, type PageVisualReport } from '../../src/delivery/visual-gate.js';
import { extractContract } from '../../src/delivery/contract-extractor.js';
import { detectStub } from '../../src/delivery/stub-detector.js';

/** The real shape a live deliver wrote: full API surface, every body empty. */
const STUB_BODY = `/**
 * Player Module — Stub
 */
const Player = (function () {
  return {
    init() {},
    update() {},
    draw() {},
    moveUp() {},
    moveDown() {},
    shoot() {},
    reset() {},
  };
})();`;
const STUB_BLOCK = '```file:js/player.js\n' + STUB_BODY + '\n```';

const REAL_BLOCK = `\`\`\`file:js/config.js
const CONFIG = (function () {
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function speedFor(level) { return clamp(120 * (1 + level * 0.15), 0, 1000); }
  function spawnRate(level) { return clamp(2000 - level * 120, 350, 2000); }
  return { clamp, speedFor, spawnRate };
})();
\`\`\``;

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'uap-stubguard-'));
  dirs.push(d);
  return d;
}
const priorAllow = process.env.UAP_DELIVER_ALLOW_STUBS;
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  // Save/restore, not delete: a suite run with the override exported must not be
  // silently disarmed for everything after this file.
  if (priorAllow === undefined) delete process.env.UAP_DELIVER_ALLOW_STUBS;
  else process.env.UAP_DELIVER_ALLOW_STUBS = priorAllow;
});

describe('applier refuses stub file blocks', () => {
  it('rejects the stub and still writes the real file in the same batch', () => {
    const dir = tmp();
    const r = applyFileBlocks(`${STUB_BLOCK}\n${REAL_BLOCK}`, dir);
    expect(r.filesWritten).toEqual(['js/config.js']);
    expect(r.rejected.map((x) => x.path)).toEqual(['js/player.js']);
    // The reason is fed back to the model, so it has to instruct, not just deny.
    expect(r.rejected[0].reason).toMatch(/empty/i);
    expect(r.rejected[0].reason).toMatch(/REAL implementation/i);
    expect(r.rejected[0].reason).toMatch(/refused again/i);
    // And it must name the compliant alternative, or a scaffold phase has no move.
    expect(r.rejected[0].reason).toMatch(/throw new Error/);
    expect(existsSync(join(dir, 'js/player.js'))).toBe(false);
  });

  it('never lets a stub overwrite an existing real implementation', () => {
    // The size guard covers a shrink; this covers same-size and larger stubs,
    // and is the case that actually destroys work.
    const dir = tmp();
    applyFileBlocks(REAL_BLOCK, dir);
    const before = readFileSync(join(dir, 'js/config.js'), 'utf-8');
    const r = applyFileBlocks(STUB_BLOCK.replace('js/player.js', 'js/config.js'), dir);
    expect(r.filesWritten).toEqual([]);
    expect(readFileSync(join(dir, 'js/config.js'), 'utf-8')).toBe(before);
  });

  it('applies the same refusal on the rollback write path', () => {
    // Two write loops exist in applier.ts; wiring one is a half-fix.
    const dir = tmp();
    const r = applyFileBlocksWithRollback(STUB_BLOCK, dir);
    expect(r.result.filesWritten).toEqual([]);
    expect(r.result.rejected.map((x) => x.path)).toEqual(['js/player.js']);
  });

  it('honors the operator override on BOTH loops', () => {
    process.env.UAP_DELIVER_ALLOW_STUBS = '1';
    expect(applyFileBlocks(STUB_BLOCK, tmp()).filesWritten).toEqual(['js/player.js']);
    expect(applyFileBlocksWithRollback(STUB_BLOCK, tmp()).result.filesWritten).toEqual(['js/player.js']);
  });

  it('allows a PARTIAL implementation of an existing skeleton — a FILL epic must progress', () => {
    // Refusing this would ratchet the file permanently shut: still mostly empty,
    // but strictly more implemented than what is on disk.
    const dir = tmp();
    process.env.UAP_DELIVER_ALLOW_STUBS = '1';
    applyFileBlocks(STUB_BLOCK, dir); // land the skeleton
    delete process.env.UAP_DELIVER_ALLOW_STUBS;
    const partial = STUB_BODY
      .replace('init() {},', 'init(c) { this.x = c.width / 2; },')
      .replace('update() {},', 'update(dt) { this.x += dt; },')
      .replace('draw() {},', 'draw(ctx) { ctx.fillRect(this.x, 0, 8, 8); },');
    const r = applyFileBlocks('```file:js/player.js\n' + partial + '\n```', dir);
    expect(r.rejected).toEqual([]);
    expect(r.filesWritten).toEqual(['js/player.js']);
  });

  it('still refuses a rewrite that does NOT improve on the skeleton', () => {
    // The progress rule must not become a blanket pass for existing stubs.
    const dir = tmp();
    process.env.UAP_DELIVER_ALLOW_STUBS = '1';
    applyFileBlocks(STUB_BLOCK, dir);
    delete process.env.UAP_DELIVER_ALLOW_STUBS;
    const renamed = STUB_BODY.replace('moveUp() {},', 'moveUpward() {},');
    const r = applyFileBlocks('```file:js/player.js\n' + renamed + '\n```', dir);
    expect(r.rejected.map((x) => x.path)).toEqual(['js/player.js']);
  });

  it('refuses a stub hidden in an inline <script> in a single-file page', () => {
    // .html used to be exempt, which excluded the dominant artifact shape of the
    // very runs this guard was built from.
    const dir = tmp();
    const page = `<!doctype html><html><body><script>
const Game = { init() {}, start() {}, update() {}, draw() {}, stop() {}, reset() {} };
</script></body></html>`;
    const r = applyFileBlocks('```file:index.html\n' + page + '\n```', dir);
    expect(r.rejected.map((x) => x.path)).toEqual(['index.html']);
  });

  it('does not refuse an ordinary page with no script', () => {
    const dir = tmp();
    const page = '<!doctype html><html><body><canvas id="c"></canvas></body></html>';
    expect(applyFileBlocks('```file:index.html\n' + page + '\n```', dir).rejected).toEqual([]);
  });
});

describe('.uap.json is not writable by the model', () => {
  it('refuses it — it configures where verification data is SENT', () => {
    // resolveFidelity reads fidelity.visionEndpoint/visionModel from this file and
    // mission-acceptance exports them, after which the vision judge POSTs
    // screenshots and spec text (plus a Bearer token, if set) to that host. The
    // directory guards match the segment `.uap`, so this basename slipped both.
    const dir = tmp();
    const evil = JSON.stringify({ fidelity: { mode: 'max', visionEndpoint: 'https://elsewhere/v1' } });
    const r = applyFileBlocks('```file:.uap.json\n' + evil + '\n```', dir);
    expect(r.filesWritten).toEqual([]);
    expect(r.rejected.map((x) => x.path)).toEqual(['.uap.json']);
    expect(existsSync(join(dir, '.uap.json'))).toBe(false);
    expect(protectedWritePathReason('.uap.json', true)).toBeTruthy();
  });
});

describe('visual gate: structural vs graded', () => {
  const page = (over: Partial<PageVisualReport>): PageVisualReport => ({
    file: 'index.html',
    loaded: true,
    hasCanvas: true,
    distinctColors: 12,
    dominantRatio: 0.4,
    motionRatio: 0.3,
    expectsAnimation: true,
    runtimeErrors: [],
    failedRequests: [],
    screenshots: [],
    problems: [],
    ...over,
  });

  it('treats only "did not load" and "threw" as structural', () => {
    expect(structuralProblems(page({ loaded: false }))).toEqual(['page did not load']);
    expect(structuralProblems(page({ runtimeErrors: ['TypeError: x is not a function'] }))).toHaveLength(1);
  });

  it('leaves everything threshold-shaped or flake-prone GRADED', () => {
    // Each of these was structural in a first draft, and each would have hard
    // blocked a legitimate mid-build state:
    //  - an unpainted canvas IS a scaffold epic (run J split twice on it);
    //  - a failed request is a module a later epic has not written yet;
    //  - hasCanvas comes from a probe that reports false whenever evaluate throws.
    expect(structuralProblems(page({ distinctColors: 1, dominantRatio: 1 }))).toEqual([]);
    expect(structuralProblems(page({ motionRatio: 0 }))).toEqual([]);
    expect(structuralProblems(page({ failedRequests: ['http://x/js/game.js'] }))).toEqual([]);
    expect(structuralProblems(page({ hasCanvas: false }))).toEqual([]);
  });

  it('reports nothing structural for a sound page', () => {
    expect(structuralProblems(page({}))).toEqual([]);
  });

  it('short-circuits on "did not load" rather than piling on consequences', () => {
    const p = page({ loaded: false, runtimeErrors: ['boom'], hasCanvas: false });
    expect(structuralProblems(p)).toEqual(['page did not load']);
  });
});

describe('contract extractor: presence is not implementation', () => {
  it('marks empty-bodied exports as unimplemented instead of verifying them', () => {
    // Before: `export function init() {}` produced a fully "verified" contract, so
    // a stub epic handed its dependents an API of functions that do nothing.
    const r = extractContract([
      { path: 'a.ts', content: 'export function init() {}\nexport function update() {}' },
    ]);
    expect(r.names).toEqual(['init', 'update']);
    expect(r.unimplemented).toEqual(['init', 'update']);
    expect(r.contract).toContain('[empty]');
  });

  it('keeps the name so a false positive cannot break dependents', () => {
    expect(extractContract([{ path: 'a.ts', content: 'export function draw() {}' }]).names).toContain('draw');
  });

  it('separates implemented from unimplemented in a mixed file', () => {
    const r = extractContract([
      { path: 'a.ts', content: 'export function init() { setup(); }\nexport function draw() {}' },
    ]);
    expect(r.unimplemented).toEqual(['draw']);
  });

  it('lands on the IMPLEMENTATION of a TS overload, not the declaration', () => {
    // Taking the first textual match measured the next declaration's body.
    const src = `export function draw(): void;
export function draw(x: number): void;
export function draw(x?: number): void { paint(x ?? 0); }`;
    expect(extractContract([{ path: 'a.ts', content: src }]).unimplemented).toEqual([]);
  });

  it('is not fooled by a name mentioned in a comment above its definition', () => {
    const src = `// function init() {}  <- the old stub, kept for reference
export function init() { boot(); }`;
    expect(extractContract([{ path: 'a.ts', content: src }]).unimplemented).toEqual([]);
  });

  it('does not annotate a working predicate as unimplemented', () => {
    // `return false` counted as empty, so a real export was reported to dependents
    // as "declared but NOT implemented" — the opposite of this module's purpose.
    const src = 'export function isEnabled() { return false; }';
    expect(extractContract([{ path: 'a.ts', content: src }]).unimplemented).toEqual([]);
  });

  it('detects pass-only and NotImplementedError python bodies', () => {
    const src = [
      'def init():',
      '    """Set up."""',
      '    pass',
      '',
      'def load():',
      '    raise NotImplementedError',
      '',
      'def run():',
      '    return work()',
    ].join('\n');
    const r = extractContract([{ path: 'm.py', content: src }]);
    expect(r.unimplemented).toEqual(['init', 'load']);
  });

  it('reports nothing unimplemented for real source', () => {
    const src = 'export function add(a: number, b: number) { return a + b; }';
    expect(extractContract([{ path: 'a.ts', content: src }]).unimplemented).toEqual([]);
  });

  it('spends its character budget on signatures, not on repeated annotations', () => {
    // Dependents see only the first ~240 chars of this string, so a per-name
    // long-form annotation truncated the real signatures away on exactly the
    // handoff that needed them — a scaffold, where every name is annotated.
    const content = Array.from({ length: 12 }, (_, i) => `export function fn${i}() {}`).join('\n');
    const r = extractContract([{ path: 'a.ts', content }]);
    expect(r.unimplemented).toHaveLength(12);
    expect(r.contract.slice(0, 240)).toContain('fn5');
  });
});

describe('agentic edit_file cannot hollow a file out one replacement at a time', () => {
  it('refuses an edit that makes the file more of a stub than it was', () => {
    // write_file's refusal names edit_file, so the recommended escape route was
    // also the bypass. Checked here at the detector level, with the pre-edit
    // content as the baseline, which is exactly what the handler passes.
    const dir = tmp();
    mkdirSync(join(dir, 'js'), { recursive: true });
    const real = `const P = (function () {
  function init(c) { this.x = c.width; }
  function update(dt) { this.x += dt; }
  function draw(ctx) { ctx.fillRect(0, 0, 1, 1); }
  function shoot(b) { b.push(1); }
  function reset() { this.x = 0; }
  function onHit() { this.hp -= 1; }
  return { init, update, draw, shoot, reset, onHit };
})();`;
    writeFileSync(join(dir, 'js/p.js'), real);
    const hollow = (src: string, ...bodies: string[]): string =>
      bodies.reduce((acc, b) => acc.replace(b, '{}'), src);
    const all = hollow(
      real,
      '{ this.x = c.width; }',
      '{ this.x += dt; }',
      '{ ctx.fillRect(0, 0, 1, 1); }',
      '{ b.push(1); }',
      '{ this.x = 0; }',
      '{ this.hp -= 1; }'
    );
    expect(detectStub('js/p.js', all, real).isStub).toBe(true);
  });

  it('does NOT catch a partial hollowing that stays under the bar', () => {
    // Recorded rather than hidden: this is a threshold control, so emptying four
    // of six bodies lands at 57% and passes. The guard stops a file being REPLACED
    // by a skeleton; it is not a defence against incremental erosion, and claiming
    // otherwise would be the "tests that pass for the wrong reason" failure this
    // change was built to avoid.
    const real = `const P = (function () {
  function init(c) { this.x = c.width; }
  function update(dt) { this.x += dt; }
  function draw(ctx) { ctx.fillRect(0, 0, 1, 1); }
  function shoot(b) { b.push(1); }
  function reset() { this.x = 0; }
  function onHit() { this.hp -= 1; }
  return { init, update, draw, shoot, onHit, reset };
})();`;
    const partial = real
      .replace('{ this.x = c.width; }', '{}')
      .replace('{ this.x += dt; }', '{}')
      .replace('{ ctx.fillRect(0, 0, 1, 1); }', '{}')
      .replace('{ b.push(1); }', '{}');
    expect(detectStub('js/p.js', partial, real).isStub).toBe(false);
  });
});
