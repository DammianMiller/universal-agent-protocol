import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebBrowser } from '../../src/browser/web-browser.js';

describe('WebBrowser', () => {
  let browser: WebBrowser;

  beforeEach(async () => {
    browser = new WebBrowser();
  });

  afterEach(async () => {
    await browser.close();
  });

  it('should initialize browser instance', async () => {
    const result = await browser.launch({ headless: true });
    expect(result).toBeInstanceOf(WebBrowser);
  });

  it('should navigate to a URL', async () => {
    await browser.launch({ headless: true });
    const status = await browser.goto('https://example.com');
    expect(status).toBe('200');
  });

  it('should get page content', async () => {
    await browser.launch({ headless: true });
    await browser.goto('https://example.com');
    const content = await browser.getContent();
    expect(content).toContain('<!DOCTYPE html>');
  });

  it('should execute JavaScript evaluation', async () => {
    await browser.launch({ headless: true });
    const result = await browser.evaluate<number>('() => window.innerWidth');
    expect(typeof result).toBe('number');
  });
});
