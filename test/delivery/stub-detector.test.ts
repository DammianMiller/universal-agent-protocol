/**
 * Stub detector, validated against the REAL files that motivated it plus the
 * shapes a first implementation got wrong.
 *
 * The positive corpus is the six modules a live deliver run wrote as stubs
 * (octopus_invaders_v3, 2026-07-30). The negative corpus matters more: if the
 * guard cannot tell those from config.js — real code from the SAME directory and
 * the same run — it is useless, because that is precisely the discrimination it
 * has to make in production. Content is inlined rather than read from that
 * project: the deliver logs which first evidenced this had already rotated away
 * once mid-investigation, and a test depending on another checkout's working
 * tree is a test that rots.
 *
 * Several negatives here exist because review found the first cut refusing real
 * code — control flow counted as API surface, a `}` inside a comment emptying its
 * function, `return true` counted as vacuous. Each has a test so the calibration
 * cannot silently drift back.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  detectStub,
  extractFunctionBodies,
  isEmptyBody,
  stripNonCode,
} from '../../src/delivery/stub-detector.js';

// ─── the real stubs, verbatim ────────────────────────────────────────────────
const PLAYER_STUB = `/**
 * Player Module — Stub
 */
const Player = (function () {
  return {
    init() {},
    update() {},
    draw() {},
    moveUp() {},
    moveDown() {},
    moveLeft() {},
    moveRight() {},
    shoot() {},
    reset() {},
  };
})();
if (typeof window !== 'undefined') { window.Player = Player; }
if (typeof module !== 'undefined' && module.exports) { module.exports = Player; }`;

const GAME_STUB = `/**
 * Game Module — Stub
 */
const Game = (function () {
  return {
    init() {},
    start() {},
    pause() {},
    resume() {},
    stop() {},
    update() {},
    draw() {},
    reset() {},
  };
})();
if (typeof window !== 'undefined') { window.Game = Game; }`;

/** Same shape with the self-label REMOVED — the next model will not say "Stub". */
const UNLABELLED_STUB = `const Enemies = (function () {
  return {
    init() {},
    spawn() {},
    update() {},
    draw() {},
    clear() {},
    reset() {},
    onHit() {},
  };
})();`;

// ─── real implementations ────────────────────────────────────────────────────
/** Trimmed from the real config.js in that same directory. */
const REAL_CONFIG = `const CONFIG = (function () {
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function scale(v, f) { return clamp(v * f, 0, 1000); }
  function speedFor(level) { return scale(120, 1 + level * 0.15); }
  function spawnRate(level) { return clamp(2000 - level * 120, 350, 2000); }
  return { clamp, scale, speedFor, spawnRate };
})();`;

const REAL_MODULE = `const Player = (function () {
  let x = 0, y = 0, vx = 0;
  function init(canvas) { x = canvas.width / 2; y = canvas.height - 40; }
  function update(dt) { x += vx * dt; if (x < 0) x = 0; }
  function draw(ctx) { ctx.fillRect(x, y, 20, 20); }
  function moveLeft() { vx = -200; }
  function moveRight() { vx = 200; }
  function shoot(bullets) { bullets.push({ x, y }); }
  return { init, update, draw, moveLeft, moveRight, shoot };
})();`;

describe('stripNonCode', () => {
  it('blanks comments and strings while preserving every index', () => {
    // Length preservation is load-bearing: bodies are sliced by index afterwards.
    const src = 'a("}"); // }\nb();';
    const out = stripNonCode(src);
    expect(out.length).toBe(src.length);
    expect(out).not.toContain('}');
    expect(out).toContain('a(');
    expect(out).toContain('b();');
  });

  it('does not let an unterminated quote consume the rest of the file', () => {
    const out = stripNonCode("const s = 'oops\nfunction f() { real(); }");
    expect(out).toContain('real();');
  });
});

describe('extractFunctionBodies', () => {
  it('brace-matches nested bodies instead of only innermost braces', () => {
    // The naive /\{[^{}]*\}/ approach found 1-2 callables in 1000-line modules,
    // which made the ratio meaningless for exactly the real files that must pass.
    const bodies = extractFunctionBodies('function outer() { if (a) { while (b) { c(); } } }');
    expect(bodies.length).toBeGreaterThanOrEqual(1);
    expect(bodies[0]).toContain('while');
  });

  it('finds arrow-assigned functions', () => {
    // `export const init = () => {}` matched NOTHING in the first cut, so the
    // dominant modern stub idiom scored zero callables and bypassed the guard.
    expect(extractFunctionBodies('export const init = () => {};').length).toBe(1);
    expect(extractFunctionBodies('const f = async (a, b) => { go(a); };').length).toBe(1);
  });

  it('finds class methods and typed/generic signatures', () => {
    expect(extractFunctionBodies('class A { m() { x(); } }').length).toBe(1);
    expect(extractFunctionBodies('function f(a: number): Map<string, number> { return m; }').length).toBe(1);
    expect(extractFunctionBodies('function make<T extends X>(v: T): T[] { return [v]; }').length).toBe(1);
  });

  it('handles nested parens in a parameter list', () => {
    expect(extractFunctionBodies('function draw(ctx = getCtx()) { ctx.a(); }').length).toBe(1);
  });

  it('does NOT count control flow as a callable', () => {
    // if/while/for/switch/catch all match "identifier, parens, brace". Counting
    // them inflated the denominator and, for ignore-catches, the numerator too.
    const src = `function only(a) {
      if (a) { go(); }
      while (a) { go(); }
      for (const x of a) { go(x); }
      switch (a) { case 1: break; }
      try { go(); } catch (e) { /* ignore */ }
    }`;
    expect(extractFunctionBodies(src).length).toBe(1);
  });

  it('does not crash on unbalanced braces', () => {
    expect(() => extractFunctionBodies('function broken() { if (x) {')).not.toThrow();
  });
});

describe('isEmptyBody', () => {
  it('treats whitespace and comments as empty — comments are not substance', () => {
    expect(isEmptyBody('')).toBe(true);
    expect(isEmptyBody('   \n  ')).toBe(true);
    expect(isEmptyBody('// TODO later')).toBe(true);
    expect(isEmptyBody('/* nothing yet */')).toBe(true);
  });

  it('treats a vacuous return as empty — it type-checks while implementing nothing', () => {
    expect(isEmptyBody('return;')).toBe(true);
    expect(isEmptyBody('return {};')).toBe(true);
    expect(isEmptyBody('return null;')).toBe(true);
  });

  it('treats a VALUE return as substance', () => {
    // `canShoot() { return true; }` is a predicate, not a stub. Counting it as
    // empty put a real module three points from a false refusal, and made
    // contract-extractor annotate real exports as "NOT implemented".
    expect(isEmptyBody('return true;')).toBe(false);
    expect(isEmptyBody('return false;')).toBe(false);
    expect(isEmptyBody('return 0;')).toBe(false);
    expect(isEmptyBody("return '';")).toBe(false);
    expect(isEmptyBody('x += 1;')).toBe(false);
    expect(isEmptyBody('return computeThing(a, b);')).toBe(false);
  });
});

describe('detectStub — the real corpus', () => {
  it('flags player.js, the worst real case', () => {
    const v = detectStub('js/player.js', PLAYER_STUB);
    expect(v.isStub).toBe(true);
    expect(v.marker).toBe(true);
    expect(v.emptyRatio).toBeGreaterThan(0.6);
  });

  it('flags game.js', () => {
    expect(detectStub('js/game.js', GAME_STUB).isStub).toBe(true);
  });

  it('flags a stub that does NOT label itself — the durable signal is semantic', () => {
    // The whole reason this is not a grep for "Stub": the next model omits it.
    const v = detectStub('js/enemies.js', UNLABELLED_STUB);
    expect(v.marker).toBe(false);
    expect(v.isStub).toBe(true);
  });

  it('flags the arrow-export and class rewrites of the same skeleton', () => {
    // What a model reaches for after one refusal. Both bypassed the first cut.
    const arrow = `export const init = () => {};
export const update = () => {};
export const draw = () => {};
export const shoot = () => {};
export const reset = () => {};
export const onHit = () => {};`;
    const klass = `export class Player {
  init() {}
  update() {}
  draw() {}
  shoot() {}
  reset() {}
  onHit() {}
}`;
    expect(detectStub('js/player.js', arrow).isStub).toBe(true);
    expect(detectStub('js/player.js', klass).isStub).toBe(true);
  });
});

describe('detectStub — negatives that must pass', () => {
  it('passes config.js, real code from the SAME directory as the stubs', () => {
    const v = detectStub('js/config.js', REAL_CONFIG);
    expect(v.isStub).toBe(false);
    expect(v.emptyRatio).toBe(0);
  });

  it('passes a real implementation of the same module that was stubbed', () => {
    expect(detectStub('js/player.js', REAL_MODULE).isStub).toBe(false);
  });

  it('passes a SCAFFOLD epic deliverable — throw/todo bodies are honest', () => {
    // epic-mission.ts instructs scaffold epics to emit exactly this. Such a body
    // announces itself at runtime instead of silently succeeding, which is the
    // whole problem with `{}`.
    const scaffold = `export function init() { throw new Error("TODO: init"); }
export function update() { throw new Error("TODO: update"); }
export function draw() { throw new Error("TODO: draw"); }
export function shoot() { throw new Error("TODO: shoot"); }
export function reset() { throw new Error("TODO: reset"); }
export function onHit() { throw new Error("TODO: onHit"); }`;
    expect(detectStub('js/player.js', scaffold).isStub).toBe(false);
  });

  it('passes a predicate-heavy module', () => {
    const src = `const M = (function () {
  function canShoot() { return true; }
  function isDead() { return false; }
  function score() { return 0; }
  function lives() { return 3; }
  function name() { return 'p'; }
  function ready() { return true; }
  return { canShoot, isDead, score, lives, name, ready };
})();`;
    expect(detectStub('m.js', src).isStub).toBe(false);
  });

  it('passes a defensive module of ignore-catches, even when labelled', () => {
    // The case that was a LIVE false positive: three real functions, three
    // ignore-catches, and the word "placeholder" in the header.
    const src = `/** placeholder art pending */
function load(a) { try { go(a); } catch (e) { /* ignore */ } }
function save(b) { try { put(b); } catch (e) { /* ignore */ } }
function send(c) { try { tx(c); } catch (e) { /* ignore */ } }`;
    expect(detectStub('io.js', src).isStub).toBe(false);
  });

  it('passes code whose comments and strings contain braces', () => {
    const src = `function tick(dt) {
  // clamp to } of the arena
  step(dt);
}
function draw(ctx) {
  const t = "}}}";
  ctx.fillText(t, 0, 0);
}
function upd(a) { a.x += 1; }
function b(a) { a.y += 1; }
function c(a) { a.z += 1; }
function d(a) { a.w += 1; }`;
    expect(detectStub('t.js', src).isStub).toBe(false);
  });

  it('does not flag one or two no-op handlers', () => {
    // No-op defaults are ordinary. At that size there is no evidence separating
    // them from a stub, so the guard must stay out of the way.
    expect(detectStub('a.js', 'const A = { onIdle() {}, onTick() { doWork(); } };').isStub).toBe(false);
  });

  it('never flags a .d.ts — all signature and no body by definition', () => {
    const dts = `export declare function a(): void;
export declare function b(): void;
export interface I { m(): void; n(): void; o(): void; p(): void; q(): void; r(): void; }`;
    expect(detectStub('types/x.d.ts', dts).isStub).toBe(false);
    expect(detectStub('types/x.d.mts', dts).isStub).toBe(false);
  });

  it('never flags data or docs', () => {
    expect(detectStub('a.json', '{"a":1}').isStub).toBe(false);
    expect(detectStub('README.md', '# stub placeholder not implemented').isStub).toBe(false);
  });

  it('does not flag prose that merely discusses stubs', () => {
    const src = `// This module used to be a stub; it is now implemented.
function a() { return 1; }
function b() { return 2; }`;
    expect(detectStub('a.js', src).isStub).toBe(false);
  });
});

describe('detectStub — the two bars are each load-bearing', () => {
  /** n callables, `empty` of them empty. Optionally self-labelled. */
  const build = (n: number, empty: number, label = false): string =>
    (label ? '/** Widget Module — Stub */\n' : '') +
    Array.from({ length: n }, (_, i) =>
      i < empty ? `function f${i}() {}` : `function f${i}() { work(${i}); }`
    ).join('\n');

  it('the LABELLED bar catches what the unlabelled bar misses (the background.js case)', () => {
    // 6 callables at 50% is under the 60% bar, so a single-bar version let a file
    // whose own header said "Stub" straight through — 6 of 7 blocked.
    expect(detectStub('w.js', build(6, 3, true)).isStub).toBe(true);
    // Deleting the labelled clause must fail a test, so here is its twin: the
    // identical ratio WITHOUT the label stays allowed. The label moved the line.
    expect(detectStub('w.js', build(6, 3, false)).isStub).toBe(false);
  });

  it('holds the "one or two empty bodies is never flagged" promise on both bars', () => {
    expect(detectStub('w.js', build(3, 2, true)).isStub).toBe(false);
    expect(detectStub('w.js', build(4, 2, true)).isStub).toBe(false);
    expect(detectStub('w.js', build(3, 3, true)).isStub).toBe(true);
  });

  it('does not lower the bar for a LARGE labelled file', () => {
    // Measured: the worst real file in this repo is 50% empty across 72 callables.
    // A self-label says something about a small module that declares an API and
    // implements none of it; it says nothing about an implementation file.
    expect(detectStub('big.js', build(40, 20, true)).isStub).toBe(false);
    expect(detectStub('big.js', build(40, 30, true)).isStub).toBe(true); // 75% ≥ 60%
  });

  it('holds the unlabelled bar at its stated thresholds', () => {
    expect(detectStub('w.js', build(5, 5)).isStub).toBe(false); // under the surface floor
    expect(detectStub('w.js', build(6, 4)).isStub).toBe(true); // 67% ≥ 60%
    expect(detectStub('w.js', build(10, 5)).isStub).toBe(false); // 50% < 60%
  });

  it('flags prose-labelled code only when the bodies back it up', () => {
    // MARKER_RE matches "used to be a stub", so `marker` is true here. The earlier
    // version of this test passed only because its fixture had 2 callables; with 3
    // real bodies the verdict must still be "allowed", and for the right reason.
    const src = `// This module used to be a stub; it is now implemented.
function a() { return 1; }
function b() { return 2; }
function c() { return 3; }`;
    const v = detectStub('a.js', src);
    expect(v.marker).toBe(true);
    expect(v.emptyRatio).toBe(0);
    expect(v.isStub).toBe(false);
  });
});

describe('detectStub — exemptions are load-bearing', () => {
  it('exempts by EXTENSION, not because the payload happens to have no bodies', () => {
    // The earlier exemption tests used payloads with zero callables, so removing
    // .d.ts/.json/.md from the set broke nothing. Same content, two extensions.
    expect(detectStub('js/player.js', PLAYER_STUB).isStub).toBe(true);
    expect(detectStub('types/player.d.ts', PLAYER_STUB).isStub).toBe(false);
    expect(detectStub('data/player.json', PLAYER_STUB).isStub).toBe(false);
  });

  it('skips detection entirely above the scan cap', () => {
    // Bundled/minified output: the shape argument does not apply, and scanning
    // megabytes inside a write handler stalls the event loop.
    const huge = PLAYER_STUB + '\n' + '// pad\n'.repeat(40_000);
    expect(huge.length).toBeGreaterThan(200_000);
    expect(detectStub('js/player.js', huge).isStub).toBe(false);
  });
});

describe('detectStub — monotone progress', () => {
  // Ten methods, so that implementing three leaves 70% empty — still over the
  // unlabelled bar, which is what makes the progress rule the deciding factor
  // rather than the threshold. (A seven-method version lands at 57% and is allowed
  // outright, so it would have exercised nothing.)
  const skeleton = `const P = {
  init() {}, update() {}, draw() {}, shoot() {}, reset() {},
  onHit() {}, tick() {}, pause() {}, resume() {}, clear() {},
};`;

  it('allows a partial implementation of an existing skeleton', () => {
    const partial = skeleton
      .replace('init() {}', 'init(c) { this.x = c.w; }')
      .replace('update() {}', 'update(d) { this.x += d; }')
      .replace('draw() {}', 'draw(g) { g.rect(0, 0, 1, 1); }');
    expect(detectStub('p.js', partial).isStub).toBe(true); // still a stub on its own
    expect(detectStub('p.js', partial, skeleton).isStub).toBe(false); // but progress
  });

  it('refuses a lateral rewrite of the same skeleton', () => {
    expect(detectStub('p.js', skeleton.replace('tick', 'step'), skeleton).isStub).toBe(true);
  });

  it('ignores prior content that was not itself a stub', () => {
    // Replacing a real file with a skeleton is the destructive case; `prior` must
    // not excuse it.
    expect(detectStub('p.js', skeleton, REAL_MODULE).isStub).toBe(true);
  });
});

describe('extractFunctionBodies — bounded work', () => {
  it('returns promptly on deeply unbalanced input', () => {
    // Rescanning per candidate was quadratic here: each unclosed body scanned to
    // EOF, which at the scan cap is a multi-second synchronous stall.
    const pathological = 'a(){'.repeat(20_000);
    const started = Date.now();
    expect(() => extractFunctionBodies(pathological)).not.toThrow();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('returns promptly on unbalanced parens', () => {
    const started = Date.now();
    expect(() => extractFunctionBodies('){'.repeat(20_000))).not.toThrow();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
describe('detectStub — negative control over this repo', () => {
  it('flags none of src/delivery/*.ts', () => {
    // The entire safety argument is "the two populations do not overlap". That
    // deserves re-checking on every run against a few hundred real files rather
    // than being asserted in a comment — and it is what would have caught the
    // control-flow, brace-in-comment and return-value miscounts immediately.
    const dir = join(process.cwd(), 'src', 'delivery');
    const flagged: string[] = [];
    let worst = { file: '', ratio: 0 };
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts') && !n.endsWith('.d.ts'))) {
      const v = detectStub(f, readFileSync(join(dir, f), 'utf-8'));
      if (v.isStub) flagged.push(`${f} (${v.callables} callables, ${Math.round(v.emptyRatio * 100)}% empty)`);
      if (v.callables >= 6 && v.emptyRatio > worst.ratio) worst = { file: f, ratio: v.emptyRatio };
    }
    expect(flagged).toEqual([]);
    // The valuable half: how much headroom is left. Measured at 50%
    // (execution-gate.ts) against a 60% bar. If a refactor walks a real file up to
    // the bar, this fails HERE rather than the day it blocks a delivery.
    expect(`${worst.file} ${worst.ratio.toFixed(2)}`).toBe(`${worst.file} ${worst.ratio.toFixed(2)}`);
    expect(worst.ratio).toBeLessThan(0.55);
  });
});
