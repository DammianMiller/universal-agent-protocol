import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { maybeJsSyntaxCheck } from '../../src/delivery/agentic-executor.js';

describe('maybeJsSyntaxCheck (per-write JS syntax feedback)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jscheck-'));
    mkdirSync(join(dir, 'js'), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('flags a corrupted write with the file and line (the }st level regression)', () => {
    writeFileSync(join(dir, 'js/enemies.js'), 'function f(){\n  const e=1;\n}\n}st level = x || 1;\n');
    const note = maybeJsSyntaxCheck(dir, 'js/enemies.js');
    expect(note).toContain('SYNTAX ERROR');
    expect(note).toContain('js/enemies.js');
    expect(note).toMatch(/next tool call/i);
  });

  it('returns empty string for valid JS (no noise on clean writes)', () => {
    writeFileSync(join(dir, 'js/ok.js'), 'const x = 1;\nfunction f(){ return x + 1; }\n');
    expect(maybeJsSyntaxCheck(dir, 'js/ok.js')).toBe('');
  });

  it('ignores non-JS extensions (TS/JSX handled by the turn-end gate)', () => {
    writeFileSync(join(dir, 'x.ts'), 'const x: number = ;\n'); // TS syntax node cannot parse
    expect(maybeJsSyntaxCheck(dir, 'x.ts')).toBe('');
  });

  it('is disabled by UAP_DELIVER_JS_WRITE_CHECK=0', () => {
    writeFileSync(join(dir, 'js/bad.js'), '}st level = 1;\n');
    const prev = process.env.UAP_DELIVER_JS_WRITE_CHECK;
    process.env.UAP_DELIVER_JS_WRITE_CHECK = '0';
    try {
      expect(maybeJsSyntaxCheck(dir, 'js/bad.js')).toBe('');
    } finally {
      if (prev === undefined) delete process.env.UAP_DELIVER_JS_WRITE_CHECK;
      else process.env.UAP_DELIVER_JS_WRITE_CHECK = prev;
    }
  });

  it('fail-soft on a missing file', () => {
    expect(maybeJsSyntaxCheck(dir, 'js/nope.js')).toBe('');
  });
});
