import { describe, it, expect } from 'vitest';
import { lintSourceContracts } from '../../src/delivery/contract-lint.js';

describe('lintSourceContracts (structural contract lint)', () => {
  it('flags `new X()` where X is an ARROW-IIFE singleton (the octopus Background bug)', () => {
    const v = lintSourceContracts([
      { path: 'js/background.js', content: 'const Background = (() => { return { draw() {} }; })();\nwindow.Background = Background;' },
      { path: 'js/game.js', content: 'function init() { const bg = new Background(canvas); }' },
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('js/game.js');
    expect(v[0]).toContain('new Background()');
    expect(v[0]).toContain('singleton');
  });

  it('flags `new X()` where X is a FUNCTION-IIFE singleton (the octopus Audio bug)', () => {
    const v = lintSourceContracts([
      { path: 'js/audio.js', content: 'var Audio = (function () { return { play() {} }; })();' },
      { path: 'js/game.js', content: 'audio = new Audio();' },
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('new Audio()');
  });

  it('does NOT flag `new X()` on a real class', () => {
    const v = lintSourceContracts([
      { path: 'js/player.js', content: 'class Player { constructor(x) { this.x = x; } }' },
      { path: 'js/game.js', content: 'const p = new Player(10);' },
    ]);
    expect(v).toEqual([]);
  });

  it('does NOT flag `new X()` on a constructor function', () => {
    const v = lintSourceContracts([
      { path: 'js/enemy.js', content: 'function Enemy(type) { this.type = type; }' },
      { path: 'js/game.js', content: 'const e = new Enemy("boss");' },
    ]);
    expect(v).toEqual([]);
  });

  it('constructor wins on ambiguous dual definition (class + IIFE) — no false positive', () => {
    const v = lintSourceContracts([
      { path: 'a.js', content: 'const Thing = (() => ({}))();' },
      { path: 'b.js', content: 'class Thing { m() {} }' }, // also a class somewhere
      { path: 'c.js', content: 'const t = new Thing();' },
    ]);
    expect(v).toEqual([]);
  });

  it('with changedFiles, only flags a `new`-site the current epic wrote (not a downstream innocent epic)', () => {
    const files = [
      { path: 'js/background.js', content: 'const Background = (() => ({ draw() {} }))();' },
      { path: 'js/game.js', content: 'const bg = new Background(canvas);' }, // the offending new-site
      { path: 'js/ui.js', content: 'const x = 1;' }, // a later, innocent epic
    ];
    // Epic that only changed ui.js must NOT be blamed for game.js's mismatch.
    expect(lintSourceContracts(files, new Set(['js/ui.js']))).toEqual([]);
    // The epic that changed game.js IS flagged.
    expect(lintSourceContracts(files, new Set(['js/game.js']))).toHaveLength(1);
  });

  it('does NOT flag an IIFE that RETURNS a constructor (anonymous-class factory)', () => {
    const v = lintSourceContracts([
      { path: 'js/ship.js', content: 'const Ship = (() => { return class { fly() {} }; })();' },
      { path: 'js/game.js', content: 'const s = new Ship();' },
    ]);
    expect(v).toEqual([]); // Ship is new-able (IIFE returns a class)
  });

  it('returns no violations for structurally consistent code', () => {
    const v = lintSourceContracts([
      { path: 'js/config.js', content: 'const Config = { WIDTH: 800 }; window.Config = Config;' },
      { path: 'js/game.js', content: 'const w = Config.WIDTH;' },
    ]);
    expect(v).toEqual([]);
  });
});
