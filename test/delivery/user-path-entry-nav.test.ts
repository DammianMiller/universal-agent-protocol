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
