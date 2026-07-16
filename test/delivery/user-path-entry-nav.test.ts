/**
 * The user-path runner must navigate to `path.entry` before running steps — the
 * schema documents `entry` as "the entry file or route", but the runner used to
 * ignore it, sitting at about:blank so every assertion failed unless the manifest
 * repeated a `goto`. This verifies entry is honored, and that an explicit leading
 * `goto` still wins (no double-load).
 */
import { describe, expect, it } from 'vitest';
import { runBrowserPath } from '../../src/delivery/user-validation.js';
import type { UserPath } from '../../src/delivery/user-paths.js';

function fakeBrowser() {
  const gotos: string[] = [];
  const browser = {
    gotos,
    goto: async (url: string) => { gotos.push(url); return '200'; },
    getText: async () => 'ok',
    screenshot: async () => {},
    getErrors: () => [],
    clearErrors: () => {},
    click: async () => {},
    fill: async () => {},
    press: async () => {},
    isVisible: async () => true,
    close: async () => {},
  };
  return browser;
}

const ctx = { projectRoot: '/tmp/x', baseUrl: 'http://127.0.0.1:5555', shotsDir: '/tmp/x', timeoutMs: 1000 };

describe('runBrowserPath: entry navigation', () => {
  it('navigates to baseUrl + entry when the path declares entry and no leading goto', async () => {
    const b = fakeBrowser();
    const path: UserPath = {
      id: 'p', rule: 'r', client: 'browser', entry: 'rubiks-cube/index.html',
      steps: [{ expect_visible: '#cube' }],
    };
    const res = await runBrowserPath(path, b as never, ctx as never);
    expect(b.gotos[0]).toBe('http://127.0.0.1:5555/rubiks-cube/index.html');
    expect(res.status).toBe('pass');
  });

  it('normalizes a leading slash / ./ in entry', async () => {
    const b = fakeBrowser();
    const path: UserPath = { id: 'p', rule: 'r', client: 'browser', entry: '/index.html', steps: [{ expect_visible: '#x' }] };
    await runBrowserPath(path, b as never, ctx as never);
    expect(b.gotos[0]).toBe('http://127.0.0.1:5555/index.html');
  });

  it('does NOT double-load when the first step is already an explicit goto', async () => {
    const b = fakeBrowser();
    const path: UserPath = {
      id: 'p', rule: 'r', client: 'browser', entry: 'index.html',
      steps: [{ goto: '/other.html' }, { expect_visible: '#x' }],
    };
    await runBrowserPath(path, b as never, ctx as never);
    expect(b.gotos).toEqual(['http://127.0.0.1:5555/other.html']); // entry NOT auto-loaded
  });

  it('does nothing special when no entry is declared', async () => {
    const b = fakeBrowser();
    const path: UserPath = { id: 'p', rule: 'r', client: 'browser', steps: [{ goto: '/a.html' }] };
    await runBrowserPath(path, b as never, ctx as never);
    expect(b.gotos).toEqual(['http://127.0.0.1:5555/a.html']);
  });
});

describe('runBrowserPath: webRootPrefix normalization (curated-manifest compat)', () => {
  const pctx = { ...ctx, webRootPrefix: 'space-shooter' };

  it('strips the web-root prefix from subdir-relative gotos and entries', async () => {
    const b = fakeBrowser();
    const path: UserPath = {
      id: 'p', rule: 'r', client: 'browser', entry: '/space-shooter/index.html',
      steps: [{ expect_visible: '#game' }],
    };
    await runBrowserPath(path, b as never, pctx as never);
    // Old project-root-docroot convention still resolves under the entry-dir docroot.
    expect(b.gotos[0]).toBe('http://127.0.0.1:5555/index.html');

    const b2 = fakeBrowser();
    const p2: UserPath = { id: 'p2', rule: 'r', client: 'browser', steps: [{ goto: '/space-shooter/game.html' }] };
    await runBrowserPath(p2, b2 as never, pctx as never);
    expect(b2.gotos[0]).toBe('http://127.0.0.1:5555/game.html');
  });

  it('never touches absolute http(s) gotos/entries even with a prefix set', async () => {
    const b = fakeBrowser();
    const path: UserPath = {
      id: 'p', rule: 'r', client: 'browser', entry: 'https://example.com/space-shooter/x.html',
      steps: [{ goto: 'http://example.com/space-shooter/y.html' }],
    };
    await runBrowserPath(path, b as never, pctx as never);
    expect(b.gotos).toEqual(['http://example.com/space-shooter/y.html']); // leading goto wins; verbatim
  });

  it('leaves non-matching and already-normalized paths untouched', async () => {
    const b = fakeBrowser();
    const path: UserPath = { id: 'p', rule: 'r', client: 'browser', steps: [{ goto: '/' }, { goto: '/other/space-shooter.html' }] };
    await runBrowserPath(path, b as never, pctx as never);
    expect(b.gotos).toEqual([
      'http://127.0.0.1:5555/',
      'http://127.0.0.1:5555/other/space-shooter.html',
    ]);
  });
});
