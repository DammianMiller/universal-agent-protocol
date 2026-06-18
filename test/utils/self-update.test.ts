import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { compareSemver, selfUpdateCli } from '../../src/utils/self-update.js';

describe('compareSemver', () => {
  it('orders versions correctly', () => {
    expect(compareSemver('1.46.7', '1.47.0')).toBe(-1);
    expect(compareSemver('1.47.0', '1.46.7')).toBe(1);
    expect(compareSemver('1.47.0', '1.47.0')).toBe(0);
    expect(compareSemver('2.0.0', '1.99.99')).toBe(1);
  });

  it('handles different-length and non-numeric segments', () => {
    expect(compareSemver('1.47', '1.47.0')).toBe(0); // missing patch ⇒ 0
    expect(compareSemver('1.47.1', '1.47')).toBe(1);
    expect(compareSemver('1.x.0', '1.0.0')).toBe(0); // NaN segment ⇒ 0
  });

  it('ignores pre-release suffixes and a leading v', () => {
    expect(compareSemver('v1.47.0', '1.47.0')).toBe(0);
    expect(compareSemver('1.47.0-rc.1', '1.47.0')).toBe(0);
  });
});

describe('selfUpdateCli', () => {
  const savedCi = process.env.CI;
  beforeEach(() => {
    // Neutralize ambient CI so the update-path tests are deterministic (the
    // function skips in CI by design); CI-specific behavior is tested explicitly.
    delete process.env.CI;
    delete process.env.UAP_NO_SELF_UPDATE;
    delete process.env.UAP_SELF_UPDATE;
  });
  afterEach(() => {
    delete process.env.UAP_NO_SELF_UPDATE;
    delete process.env.UAP_SELF_UPDATE;
    if (savedCi === undefined) delete process.env.CI;
    else process.env.CI = savedCi;
  });

  const installed = () => true;

  it('updates when the installed CLI is behind the latest published version', () => {
    let installedArg: string | null = null;
    const res = selfUpdateCli({
      current: '1.46.7',
      isInstalled: installed,
      fetchLatest: () => '1.47.0',
      install: (v) => {
        installedArg = v;
      },
    });
    expect(res.updated).toBe(true);
    expect(res.latest).toBe('1.47.0');
    expect(installedArg).toBe('@miller-tech/uap@1.47.0');
  });

  it('does nothing when already at the latest version', () => {
    let called = false;
    const res = selfUpdateCli({
      current: '1.47.0',
      isInstalled: installed,
      fetchLatest: () => '1.47.0',
      install: () => {
        called = true;
      },
    });
    expect(res.updated).toBe(false);
    expect(res.skipped).toBe(false);
    expect(res.reason).toMatch(/up to date/);
    expect(called).toBe(false);
  });

  it('skips (never installs) when running from a source checkout', () => {
    let called = false;
    const res = selfUpdateCli({
      current: '1.0.0',
      isInstalled: () => false,
      fetchLatest: () => '9.9.9',
      install: () => {
        called = true;
      },
    });
    expect(res.skipped).toBe(true);
    expect(res.updated).toBe(false);
    expect(called).toBe(false);
    expect(res.reason).toMatch(/source checkout/);
  });

  it('skips when disabled via UAP_NO_SELF_UPDATE=1 or enabled:false', () => {
    process.env.UAP_NO_SELF_UPDATE = '1';
    let called = false;
    const mk = (extra: Record<string, unknown>) =>
      selfUpdateCli({ current: '1.0.0', isInstalled: installed, fetchLatest: () => '9.9.9', install: () => { called = true; }, ...extra });
    expect(mk({}).skipped).toBe(true);
    delete process.env.UAP_NO_SELF_UPDATE;
    expect(mk({ enabled: false }).skipped).toBe(true);
    expect(called).toBe(false);
  });

  it('skips in CI unless UAP_SELF_UPDATE=1 forces it', () => {
    process.env.CI = 'true';
    let called = false;
    const opts = { current: '1.0.0', isInstalled: installed, fetchLatest: () => '2.0.0', install: () => { called = true; } };
    const skipped = selfUpdateCli(opts);
    expect(skipped.skipped).toBe(true);
    expect(skipped.reason).toMatch(/CI/);
    expect(called).toBe(false);

    process.env.UAP_SELF_UPDATE = '1';
    const forced = selfUpdateCli(opts);
    expect(forced.updated).toBe(true);
    expect(called).toBe(true);
  });

  it('does not update when the installed version is newer than published', () => {
    let called = false;
    const res = selfUpdateCli({
      current: '2.0.0',
      isInstalled: installed,
      fetchLatest: () => '1.47.0',
      install: () => { called = true; },
    });
    expect(res.updated).toBe(false);
    expect(res.skipped).toBe(false);
    expect(called).toBe(false);
  });

  it('skips gracefully when the registry is unreachable', () => {
    const res = selfUpdateCli({
      current: '1.0.0',
      isInstalled: installed,
      fetchLatest: () => null,
    });
    expect(res.skipped).toBe(true);
    expect(res.reason).toMatch(/unreachable/);
  });

  it('degrades to skipped (never throws) when the install command fails', () => {
    const res = selfUpdateCli({
      current: '1.0.0',
      isInstalled: installed,
      fetchLatest: () => '2.0.0',
      install: () => {
        throw new Error('npm exploded');
      },
    });
    expect(res.updated).toBe(false);
    expect(res.skipped).toBe(true);
    expect(res.reason).toMatch(/update failed/);
  });
});
