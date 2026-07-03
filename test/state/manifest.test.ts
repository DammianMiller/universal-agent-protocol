/**
 * Implementation-state manifest: machine-derived project identity/state for
 * per-session injection.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  generateStateManifest,
  writeStateManifest,
  readOrRefreshManifest,
  manifestDigest,
  manifestPath,
} from '../../src/state/manifest.js';

describe('state manifest', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-manifest-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo', version: '2.3.4' }));
    writeFileSync(
      join(dir, 'CHANGELOG.md'),
      ['# Changelog', '', '## v2.3.4 (2026-07-01) — fix the widget', '', '## v2.3.3 — add the widget', ''].join('\n')
    );
    mkdirSync(join(dir, '.factory', 'skills'), { recursive: true });
    writeFileSync(join(dir, '.factory', 'skills', 'a.md'), 'x');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('derives name/version/changes/counts from ground truth', () => {
    const m = generateStateManifest(dir);
    expect(m).not.toBeNull();
    expect(m!.name).toBe('demo');
    expect(m!.version).toBe('2.3.4');
    expect(m!.recentChanges[0]).toContain('v2.3.4');
    expect(m!.counts?.skills).toBe(1);
  });

  it('returns null for a directory without package.json', () => {
    const empty = mkdtempSync(join(tmpdir(), 'uap-empty-'));
    try {
      expect(generateStateManifest(empty)).toBeNull();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('persists to .uap/state-manifest.json when the project already has .uap/', () => {
    mkdirSync(join(dir, '.uap'), { recursive: true });
    const written = writeStateManifest(dir);
    expect(written).not.toBeNull();
    expect(existsSync(manifestPath(dir))).toBe(true);
    const read = readOrRefreshManifest(dir);
    expect(read!.version).toBe('2.3.4');
  });

  it('never scaffolds .uap/ into a repo that does not carry UAP state', () => {
    const manifest = writeStateManifest(dir);
    // Digest still available in-memory for injection…
    expect(manifest!.version).toBe('2.3.4');
    // …but nothing written to disk.
    expect(existsSync(join(dir, '.uap'))).toBe(false);
  });

  it('renders a compact digest with version and recent changes', () => {
    const digest = manifestDigest(generateStateManifest(dir)!);
    expect(digest).toContain('demo v2.3.4');
    expect(digest).toContain('Recently shipped');
    expect(digest.length).toBeLessThan(500);
  });
});
