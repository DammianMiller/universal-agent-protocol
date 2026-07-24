import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { projectUsesCanvas } from '../../src/cli/verify.js';

describe('projectUsesCanvas (drives canvas-specific vision guidance)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'canvas-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('detects a <canvas> element in HTML', () => {
    writeFileSync(join(dir, 'index.html'), '<!doctype html><body><canvas id="c"></canvas></body>');
    expect(projectUsesCanvas(dir)).toBe(true);
  });

  it('detects a 2d/webgl context grab in JS (nested dir)', () => {
    mkdirSync(join(dir, 'js'), { recursive: true });
    writeFileSync(join(dir, 'js', 'game.js'), "const ctx = el.getContext('2d');\n");
    expect(projectUsesCanvas(dir)).toBe(true);
  });

  it('returns false for a plain DOM app with no canvas', () => {
    writeFileSync(join(dir, 'index.html'), '<!doctype html><body><div id="app"></div></body>');
    writeFileSync(join(dir, 'app.js'), 'document.getElementById("app").textContent = "hi";');
    expect(projectUsesCanvas(dir)).toBe(false);
  });

  it('fail-soft on an unreadable/missing directory', () => {
    expect(projectUsesCanvas(join(dir, 'does-not-exist'))).toBe(false);
  });
});
