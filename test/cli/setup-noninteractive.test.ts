import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveInteractive } from '../../src/cli/setup.js';

describe('resolveInteractive', () => {
  const savedCi = process.env.CI;
  const savedTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

  function setTty(v: boolean | undefined): void {
    Object.defineProperty(process.stdout, 'isTTY', { value: v, configurable: true });
  }

  beforeEach(() => {
    delete process.env.CI;
    setTty(true); // pretend we're on a terminal
  });
  afterEach(() => {
    if (savedCi === undefined) delete process.env.CI;
    else process.env.CI = savedCi;
    if (savedTty) Object.defineProperty(process.stdout, 'isTTY', savedTty);
  });

  it('defaults to interactive on a TTY with no flags', () => {
    expect(resolveInteractive({})).toBe(true);
  });

  it('--non-interactive and -y force scripted', () => {
    expect(resolveInteractive({ nonInteractive: true })).toBe(false);
    expect(resolveInteractive({ yes: true })).toBe(false);
  });

  it('non-TTY is never interactive (pipes/redirects never hang)', () => {
    setTty(undefined);
    expect(resolveInteractive({})).toBe(false);
  });

  it('CI is never interactive', () => {
    process.env.CI = 'true';
    expect(resolveInteractive({})).toBe(false);
  });
});
