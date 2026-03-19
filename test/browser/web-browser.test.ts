import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

  beforeEach(async () => {
    browser = new WebBrowser();
  });

  afterEach(async () => {
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
    await browser.goto('https://example.com');
    const content = await browser.getContent();
    expect(content).toContain('<!DOCTYPE html>');
  });

  it.skipIf(!RUN_BROWSER)('should execute JavaScript evaluation', async () => {
    await browser.launch({ headless: true });
    const result = await browser.evaluate<number>('() => window.innerWidth');
    expect(typeof result).toBe('number');
  });
});
