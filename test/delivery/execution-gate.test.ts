import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { symlinkSync, writeFileSync as wf } from 'fs';
import {
  detectArtifactType,
  findWebEntryDir,
  runExecutionGate,
  runVmDomHarness,
  startStaticServer,
  synthesizeExecutionRung,
  type BrowserDriver,
} from '../../src/delivery/execution-gate.js';
import { detectRungs } from '../../src/delivery/verifier-ladder.js';

/** A fake browser that records no errors (or the ones provided) and returns a status. */
function fakeBrowser(opts: { errors?: Array<{ kind: string; message: string }>; status?: string } = {}): () => BrowserDriver {
  return () => ({
    async launch() {
      return undefined;
    },
    async goto() {
      return opts.status ?? '200';
    },
    async waitForLoadState() {
      return undefined;
    },
    getErrors() {
      return opts.errors ?? [];
    },
    async close() {
      return undefined;
    },
  });
}

function writeWebGame(dir: string, gameJs: string): void {
  mkdirSync(join(dir, 'js'), { recursive: true });
  writeFileSync(
    join(dir, 'index.html'),
    '<!DOCTYPE html><html><body><canvas id="c"></canvas><script src="js/game.js"></script></body></html>'
  );
  writeFileSync(join(dir, 'js/game.js'), gameJs);
}

describe('detectArtifactType / findWebEntryDir', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'exec-detect-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('detects web from a root index.html', () => {
    writeFileSync(join(dir, 'index.html'), '<html></html>');
    expect(detectArtifactType(dir)).toBe('web');
    expect(findWebEntryDir(dir)).toBe(dir);
  });

  it('detects web from a nested index.html (e.g. space-shooter/)', () => {
    mkdirSync(join(dir, 'space-shooter'));
    writeFileSync(join(dir, 'space-shooter/index.html'), '<html></html>');
    expect(detectArtifactType(dir)).toBe('web');
    expect(findWebEntryDir(dir)).toBe(join(dir, 'space-shooter'));
  });

  it('detects cli (bin), lib (main), node (bare), and null (empty)', () => {
    const cli = mkdtempSync(join(tmpdir(), 'exec-cli-'));
    writeFileSync(join(cli, 'package.json'), JSON.stringify({ bin: { x: 'cli.js' } }));
    expect(detectArtifactType(cli)).toBe('cli');

    const lib = mkdtempSync(join(tmpdir(), 'exec-lib-'));
    writeFileSync(join(lib, 'package.json'), JSON.stringify({ main: 'index.js' }));
    expect(detectArtifactType(lib)).toBe('lib');

    const bare = mkdtempSync(join(tmpdir(), 'exec-bare-'));
    writeFileSync(join(bare, 'package.json'), JSON.stringify({ name: 'x', scripts: { build: 'tsc' } }));
    // scripts-only / bare package.json has no runnable entry → not gated here
    expect(detectArtifactType(bare)).toBeNull();

    expect(detectArtifactType(dir)).toBeNull();
    for (const d of [cli, lib, bare]) rmSync(d, { recursive: true, force: true });
  });
});

describe('runExecutionGate — web (injected browser)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'exec-web-'));
    writeWebGame(dir, 'const x = 1;');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('passes when the page loads with no runtime errors', async () => {
    const r = await runExecutionGate(dir, { browserFactory: fakeBrowser(), settleMs: 1 });
    expect(r.passed).toBe(true);
    expect(r.via).toBe('browser');
  });

  it('fails when the page reports a pageerror', async () => {
    const r = await runExecutionGate(dir, {
      browserFactory: fakeBrowser({ errors: [{ kind: 'pageerror', message: 'ReferenceError: boom' }] }),
      settleMs: 1,
    });
    expect(r.passed).toBe(false);
    expect(r.outputTail).toContain('ReferenceError: boom');
  });

  it('fails when the entry does not return HTTP 200', async () => {
    const r = await runExecutionGate(dir, { browserFactory: fakeBrowser({ status: '404' }), settleMs: 1 });
    expect(r.passed).toBe(false);
    expect(r.failureReason).toMatch(/did not load/);
  });

  it('accepts any 2xx status (not just exact 200)', async () => {
    const r = await runExecutionGate(dir, { browserFactory: fakeBrowser({ status: '204' }), settleMs: 1 });
    expect(r.passed).toBe(true);
  });

  it('does NOT fail on console.error / requestfailed (advisory only)', async () => {
    const r = await runExecutionGate(dir, {
      browserFactory: fakeBrowser({
        errors: [
          { kind: 'console', message: 'handled: optional fetch failed' },
          { kind: 'requestfailed', message: '/sprite.png net::ERR' },
        ],
      }),
      settleMs: 1,
    });
    expect(r.passed).toBe(true);
    expect(r.outputTail).toMatch(/advisory/);
  });

  it('fails on pageerror even when advisory errors are also present', async () => {
    const r = await runExecutionGate(dir, {
      browserFactory: fakeBrowser({
        errors: [
          { kind: 'console', message: 'noise' },
          { kind: 'pageerror', message: 'TypeError: x is not a function' },
        ],
      }),
      settleMs: 1,
    });
    expect(r.passed).toBe(false);
    expect(r.outputTail).toContain('x is not a function');
  });

  it('falls back to the vm-dom harness when the browser cannot launch', async () => {
    const r = await runExecutionGate(dir, {
      browserFactory: () => {
        throw new Error('no chromium');
      },
      settleMs: 1,
    });
    expect(r.via).toBe('vm-dom');
    expect(r.passed).toBe(true);
  });
});

describe('runExecutionGate — classic web uses vm-dom by default (reliable crash detection)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'exec-classic-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('passes a clean classic-script page WITHOUT a browser (via vm-dom)', async () => {
    writeWebGame(dir, "document.getElementById('c').getContext('2d').fillRect(0,0,1,1);");
    const r = await runExecutionGate(dir); // no browserFactory → vm-dom path
    expect(r.via).toBe('vm-dom');
    expect(r.passed).toBe(true);
  });

  it('FAILS a classic-script page with a TDZ ReferenceError (the octopus bug)', async () => {
    writeWebGame(dir, '(function(){ function r(){ return s.x; } r(); let s = { x: 1 }; })();');
    const r = await runExecutionGate(dir);
    expect(r.via).toBe('vm-dom');
    expect(r.passed).toBe(false);
    expect(r.outputTail).toMatch(/before initialization|is not defined/);
  });

  it('RUNS an app that uses localStorage / new Image() / fetch (broadened stubs)', async () => {
    writeWebGame(
      dir,
      "const h=localStorage.getItem('h')||0; localStorage.setItem('h','1'); const i=new Image(); i.src='x.png'; fetch('/x').then(()=>{}); document.getElementById('c').getContext('2d').fillRect(0,0,1,1);"
    );
    const r = await runExecutionGate(dir);
    expect(r.passed).toBe(true);
  });

  it('fail-OPEN on an unmodelled browser global (PascalCase) — never wedges working code', async () => {
    writeWebGame(dir, 'const x = SpeechRecognition;');
    const r = await runExecutionGate(dir);
    expect(r.passed).toBe(true);
    expect(r.failureReason).toMatch(/SpeechRecognition/);
  });

  it('FAILS on the app\'s own missing symbol (lowercase) — a real bug', async () => {
    writeWebGame(dir, 'frobnicate();');
    const r = await runExecutionGate(dir);
    expect(r.passed).toBe(false);
    expect(r.outputTail).toMatch(/frobnicate is not defined/);
  });

  it('executes inline <script> bodies (not just src files)', async () => {
    writeFileSync(
      join(dir, 'index.html'),
      '<canvas id="c"></canvas><script>(function(){ function r(){return s.x;} r(); let s={x:1}; })();</script>'
    );
    const r = await runExecutionGate(dir);
    expect(r.passed).toBe(false);
    expect(r.outputTail).toMatch(/before initialization/);
  });
});

describe('runVmDomHarness — classic-script execution', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'exec-vm-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('passes a clean canvas boot', () => {
    writeWebGame(
      dir,
      "(function(){const c=document.getElementById('c');const ctx=c.getContext('2d');function loop(){ctx.fillRect(0,0,1,1);requestAnimationFrame(loop);}requestAnimationFrame(loop);})();"
    );
    const r = runVmDomHarness(dir);
    expect(r.passed).toBe(true);
    expect(r.via).toBe('vm-dom');
  });

  it('fails on a temporal-dead-zone ReferenceError (the octopus bug class)', () => {
    writeWebGame(
      dir,
      '(function(){\n  function resize(){ return state.x; }\n  resize();\n  let state = { x: 1 };\n})();'
    );
    const r = runVmDomHarness(dir);
    expect(r.passed).toBe(false);
    expect(r.outputTail).toMatch(/before initialization|is not defined|Cannot access/);
  });

  it('fails when index.html references a missing script', () => {
    mkdirSync(join(dir, 'js'), { recursive: true });
    writeFileSync(join(dir, 'index.html'), '<script src="js/missing.js"></script>');
    const r = runVmDomHarness(dir);
    expect(r.passed).toBe(false);
    expect(r.failureReason).toMatch(/not found/);
  });

  it('skips (pass) ES-module pages it cannot run', () => {
    writeFileSync(join(dir, 'index.html'), '<script type="module" src="m.js"></script>');
    const r = runVmDomHarness(dir);
    expect(r.passed).toBe(true);
    expect(r.failureReason).toMatch(/ES modules/);
  });
});

describe('runExecutionGate — node/cli/lib (real child process)', () => {
  it('passes a lib whose entry imports cleanly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'exec-libok-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ main: 'index.js' }));
    writeFileSync(join(dir, 'index.js'), 'module.exports = { ok: true };');
    const r = await runExecutionGate(dir);
    expect(r.passed).toBe(true);
    expect(r.via).toBe('child-process');
    rmSync(dir, { recursive: true, force: true });
  });

  it('fails a lib whose entry throws at import time', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'exec-libbad-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ main: 'index.js' }));
    writeFileSync(join(dir, 'index.js'), 'throw new Error("import boom");');
    const r = await runExecutionGate(dir);
    expect(r.passed).toBe(false);
    expect(r.outputTail).toContain('import boom');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('startStaticServer — security + serving', () => {
  let dir: string;
  let srv: { url: string; close: () => void } | null = null;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'exec-srv-'));
    wf(join(dir, 'index.html'), '<html>ok</html>');
  });
  afterEach(() => {
    srv?.close();
    srv = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves index.html, 204s favicon, 404s missing, 403s traversal and out-of-tree symlinks', async () => {
    srv = await startStaticServer(dir);
    const base = srv.url.replace(/\/index\.html$/, '');
    expect((await fetch(`${base}/index.html`)).status).toBe(200);
    expect((await fetch(`${base}/favicon.ico`)).status).toBe(204);
    expect((await fetch(`${base}/missing.js`)).status).toBe(404);
    // Encoded traversal must not escape the root.
    expect((await fetch(`${base}/%2e%2e/%2e%2e/etc/hostname`)).status).toBe(404);

    // A symlink pointing outside the served dir must be refused (F2).
    const secret = mkdtempSync(join(tmpdir(), 'exec-secret-'));
    wf(join(secret, 'creds'), 'TOPSECRET');
    symlinkSync(join(secret, 'creds'), join(dir, 'leak'));
    const res = await fetch(`${base}/leak`);
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).not.toContain('TOPSECRET');
    rmSync(secret, { recursive: true, force: true });
  });
});

describe('node execution gate strips secrets from the child env', () => {
  it('does not leak API_KEY/TOKEN/SECRET to the spawned entrypoint', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'exec-secret-env-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ main: 'index.js' }));
    // Entry throws (failing) iff it can see the secret env var — so a pass proves stripping.
    writeFileSync(
      join(dir, 'index.js'),
      'if (process.env.MY_FAKE_API_KEY) throw new Error("LEAKED:" + process.env.MY_FAKE_API_KEY);'
    );
    process.env.MY_FAKE_API_KEY = 'sk-should-be-stripped';
    try {
      const r = await runExecutionGate(dir);
      expect(r.passed).toBe(true);
      expect(r.outputTail).not.toContain('LEAKED');
    } finally {
      delete process.env.MY_FAKE_API_KEY;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('synthesizeExecutionRung + detectRungs wiring', () => {
  it('synthesizes a runtime-tier execution rung for a web project', () => {
    const dir = mkdtempSync(join(tmpdir(), 'exec-syn-'));
    writeFileSync(join(dir, 'index.html'), '<html></html>');
    const rung = synthesizeExecutionRung(dir);
    expect(rung).not.toBeNull();
    expect(rung!.id).toBe('execution');
    expect(rung!.tier).toBe('runtime');
    expect(rung!.command).toBe('node');
    expect(rung!.required).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when there is no runnable artifact', () => {
    const dir = mkdtempSync(join(tmpdir(), 'exec-none-'));
    expect(synthesizeExecutionRung(dir)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it('detectRungs appends the execution rung for a vanilla-JS web project (no package.json)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'exec-detrungs-'));
    writeFileSync(join(dir, 'index.html'), '<html></html>');
    const rungs = detectRungs(dir);
    expect(rungs.some((r) => r.id === 'execution' && r.tier === 'runtime')).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('vm-dom missing-script deferral on non-final epics (run W, 2026-07-18)', () => {
  it('defers a missing script reference when UAP_EPIC_NONFINAL=1, naming the file', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'vmdom-nf-'));
    const prev = process.env.UAP_EPIC_NONFINAL;
    try {
      writeFileSync(join(dir, 'index.html'), '<canvas></canvas><script src="game.js"></script>');
      process.env.UAP_EPIC_NONFINAL = '1';
      const res = runVmDomHarness(dir);
      expect(res.passed).toBe(true);
      expect(res.outputTail).toContain('non-final epic');
      expect(res.outputTail).toContain('game.js');
    } finally {
      if (prev === undefined) delete process.env.UAP_EPIC_NONFINAL;
      else process.env.UAP_EPIC_NONFINAL = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still hard-fails the missing script on the final epic (flag unset)', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'vmdom-final-'));
    const prev = process.env.UAP_EPIC_NONFINAL;
    try {
      delete process.env.UAP_EPIC_NONFINAL;
      writeFileSync(join(dir, 'index.html'), '<canvas></canvas><script src="game.js"></script>');
      const res = runVmDomHarness(dir);
      expect(res.passed).toBe(false);
      expect(res.failureReason).toContain('script not found: game.js');
    } finally {
      if (prev !== undefined) process.env.UAP_EPIC_NONFINAL = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
