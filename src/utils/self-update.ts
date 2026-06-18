/**
 * Self-update: keep the globally-installed UAP CLI at the latest published npm
 * version. Wired into `uap setup` so every project setup automatically ensures
 * the CLI is current (the published OSS package), non-fatally.
 *
 * Safe by construction:
 *  - only updates when a NEWER version is published (semver compare);
 *  - only when running as an installed package (a source checkout is left
 *    alone so dev builds aren't clobbered);
 *  - opt-out via `--no-self-update` / UAP_NO_SELF_UPDATE=1;
 *  - every failure path degrades to "skipped" — setup never fails on this.
 */

import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

export const UAP_PACKAGE_NAME = '@miller-tech/uap';

/**
 * Compare two semver strings (pre-release suffixes ignored). Returns -1 when
 * a < b, 0 when equal, 1 when a > b.
 */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string): number[] =>
    v
      .trim()
      .replace(/^v/, '')
      .split('-')[0]
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Read this CLI's own version from its package.json. */
export function getCurrentCliVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/utils/self-update.js → ../../package.json
  const pkg = JSON.parse(readFileSync(join(here, '../../package.json'), 'utf-8')) as { version: string };
  return pkg.version;
}

/** Latest version published to the npm registry, or null when unreachable. */
export function getLatestPublishedVersion(
  pkg: string = UAP_PACKAGE_NAME,
  timeoutMs = 8_000
): string | null {
  try {
    const out = execFileSync('npm', ['view', pkg, 'version'], {
      encoding: 'utf-8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const v = out.trim();
    // Fully anchored: reject anything but a clean semver token so a malformed
    // registry response can never flow into the install spec.
    return /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * True when this module is the GLOBALLY-installed CLI eligible for self-update:
 * it lives under a node_modules/@miller-tech/uap tree (not a source checkout)
 * AND is not rooted inside the project being set up (so a local/monorepo
 * dependency copy is never clobbered by a `npm install -g`).
 */
export function isInstalledPackage(): boolean {
  const here = dirname(fileURLToPath(import.meta.url));
  if (!here.includes(join('node_modules', '@miller-tech', 'uap'))) return false;
  return !here.startsWith(resolve(process.cwd()));
}

function defaultInstall(versionedPkg: string): void {
  execFileSync('npm', ['install', '-g', versionedPkg], { stdio: 'ignore', timeout: 180_000 });
}

export interface SelfUpdateResult {
  /** Whether the registry was actually queried. */
  checked: boolean;
  current: string;
  latest: string | null;
  updated: boolean;
  skipped: boolean;
  reason?: string;
}

export interface SelfUpdateOptions {
  /** Master switch; false (or UAP_NO_SELF_UPDATE=1) disables the check. */
  enabled?: boolean;
  packageName?: string;
  // Injectable seams for tests:
  current?: string;
  isInstalled?: () => boolean;
  fetchLatest?: () => string | null;
  install?: (versionedPkg: string) => void;
}

/**
 * Ensure the global UAP CLI is at the latest published version, updating it when
 * behind. Pure-ish and fully injectable for tests; never throws.
 */
export function selfUpdateCli(options: SelfUpdateOptions = {}): SelfUpdateResult {
  const pkg = options.packageName ?? UAP_PACKAGE_NAME;

  // Resolving the current version reads package.json — guard it so the whole
  // function honors its "never throws / setup never fails on this" contract.
  let current: string;
  try {
    current = options.current ?? getCurrentCliVersion();
  } catch {
    return { checked: false, current: 'unknown', latest: null, updated: false, skipped: true, reason: 'could not read current version' };
  }

  try {
    const enabled = options.enabled !== false && process.env.UAP_NO_SELF_UPDATE !== '1';
    if (!enabled) {
      return { checked: false, current, latest: null, updated: false, skipped: true, reason: 'self-update disabled' };
    }

    // Skip in CI unless explicitly forced: auto-mutating the global toolchain
    // mid-pipeline breaks reproducibility (pin versions in IaC instead).
    if (process.env.CI && process.env.UAP_SELF_UPDATE !== '1') {
      return { checked: false, current, latest: null, updated: false, skipped: true, reason: 'CI environment — skipping (set UAP_SELF_UPDATE=1 to force)' };
    }

    const installed = (options.isInstalled ?? isInstalledPackage)();
    if (!installed) {
      return {
        checked: false,
        current,
        latest: null,
        updated: false,
        skipped: true,
        reason: 'running from a source checkout — not self-updating',
      };
    }

    const latest = (options.fetchLatest ?? (() => getLatestPublishedVersion(pkg)))();
    if (!latest) {
      return { checked: true, current, latest: null, updated: false, skipped: true, reason: 'npm registry unreachable' };
    }

    if (compareSemver(current, latest) >= 0) {
      return { checked: true, current, latest, updated: false, skipped: false, reason: 'already up to date' };
    }

    (options.install ?? defaultInstall)(`${pkg}@${latest}`);
    return { checked: true, current, latest, updated: true, skipped: false };
  } catch (err) {
    return {
      checked: true,
      current,
      latest: null,
      updated: false,
      skipped: true,
      reason: `update failed: ${String(err).slice(0, 160)}`,
    };
  }
}
