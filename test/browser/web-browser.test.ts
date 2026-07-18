import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebBrowser } from '../../src/browser/web-browser.js';
import { execSync } from 'child_process';

// Skip browser tests in CI — Playwright requires a browser binary that
// may not be installed or may hit ETXTBSY race conditions in CI runners.
function canLaunchBrowser(): boolean {
  try {
    execSync('npx playwright install --dry-run chromium 2>/dev/null', { stdio: 'ignore', timeout: 5000 });
    return !process.env.CI;
  } catch {
    return false;
  }
}

const RUN_BROWSER = canLaunchBrowser();

describe('WebBrowser', () => {
  let browser: WebBrowser;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    browser = new WebBrowser();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    await browser.close();
  });

  it.skipIf(!RUN_BROWSER)('should initialize browser instance', async () => {
    const result = await browser.launch({ headless: true });
    expect(result).toBeInstanceOf(WebBrowser);
  });

  it.skipIf(!RUN_BROWSER)('should navigate to a URL', async () => {
    await browser.launch({ headless: true });
    const status = await browser.goto('https://example.com');
    expect(status).toBe('200');
  });

  it.skipIf(!RUN_BROWSER)('should get page content', async () => {
    await browser.launch({ headless: true });
    const html = '<!DOCTYPE html><html><body><h1>Example Domain</h1></body></html>';
    globalThis.fetch = vi.fn(async () => new Response(html, {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    })) as typeof fetch;
    await browser.goto('data:text/html,' + encodeURIComponent(html));
    const content = await browser.getContent();
    expect(content).toContain('<!DOCTYPE html>');
  });

  it.skipIf(!RUN_BROWSER)('should execute JavaScript evaluation', async () => {
    await browser.launch({ headless: true });
    const result = await browser.evaluate<number>('() => window.innerWidth');
    expect(typeof result).toBe('number');
  });
});

describe('WebBrowser.formatConsoleError (anonymous-404 fix, 2026-07-18)', () => {
  it('appends the resource URL when the text omits it', () => {
    const out = WebBrowser.formatConsoleError(
      'Failed to load resource: the server responded with a status of 404 (Not Found)',
      'http://127.0.0.1:8123/styles.css'
    );
    expect(out).toContain('(resource: http://127.0.0.1:8123/styles.css)');
  });

  it('leaves the text alone when the URL is absent or already present', () => {
    expect(WebBrowser.formatConsoleError('boom', undefined)).toBe('boom');
    expect(WebBrowser.formatConsoleError('404 at http://x/y.js', 'http://x/y.js')).toBe('404 at http://x/y.js');
  });
});
