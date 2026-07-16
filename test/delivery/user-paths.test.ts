import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  deriveUserPaths,
  sanitizeCanvasTextAssertions,
  loadUserPaths,
  mergeUserPaths,
  parseManifestFromModel,
  USER_PATHS_FILE,
  validateManifest,
  type UserPathsManifest,
} from '../../src/delivery/user-paths.js';

const VALID: UserPathsManifest = {
  version: 1,
  paths: [
    {
      id: 'cli-help',
      rule: 'binary prints usage',
      client: 'cli',
      steps: [{ run: { argv: ['node', '--help'] } }, { expect_exit: 0 }],
    },
  ],
};

describe('validateManifest', () => {
  it('accepts a valid manifest', () => {
    const v = validateManifest(VALID);
    expect(v.ok).toBe(true);
    expect(v.manifest?.paths).toHaveLength(1);
  });

  it('rejects unknown step actions (typo safety)', () => {
    const v = validateManifest({
      version: 1,
      paths: [{ id: 'x', rule: 'r', client: 'cli', steps: [{ expect_exitt: 0 }] }],
    });
    expect(v.ok).toBe(false);
    expect(v.errors.join()).toContain("unknown action 'expect_exitt'");
  });

  it('rejects multi-action steps, duplicate ids, bad client, empty steps', () => {
    const v = validateManifest({
      version: 1,
      paths: [
        { id: 'a', rule: 'r', client: 'cli', steps: [{ expect_exit: 0, expect_stdout_matches: 'x' }] },
        { id: 'a', rule: 'r', client: 'ftp', steps: [] },
      ],
    });
    expect(v.ok).toBe(false);
    expect(v.errors.join()).toContain('exactly one action');
    expect(v.errors.join()).toContain('duplicate id');
    expect(v.errors.join()).toContain('client must be');
    expect(v.errors.join()).toContain('non-empty');
  });

  it('rejects wrong version and missing server fields', () => {
    expect(validateManifest({ version: 2, paths: [] }).ok).toBe(false);
    const v = validateManifest({ ...VALID, server: { command: '' } });
    expect(v.ok).toBe(false);
    expect(v.errors.join()).toContain('server.command');
    expect(v.errors.join()).toContain('server.port');
  });
});

describe('parseManifestFromModel', () => {
  it('parses a fenced JSON object', () => {
    const m = parseManifestFromModel('Here you go:\n```json\n' + JSON.stringify(VALID) + '\n```\nDone.');
    expect(m?.paths[0].id).toBe('cli-help');
  });

  it('parses a bare JSON array as paths', () => {
    const m = parseManifestFromModel(JSON.stringify(VALID.paths));
    expect(m?.version).toBe(1);
    expect(m?.paths).toHaveLength(1);
  });

  it('returns null on garbage and on invalid manifests', () => {
    expect(parseManifestFromModel('no json here')).toBeNull();
    expect(parseManifestFromModel('{"version":1,"paths":[{"id":"x"}]}')).toBeNull();
  });
});

describe('mergeUserPaths / loadUserPaths', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-userpaths-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a new manifest and loads it back', () => {
    mergeUserPaths(dir, VALID);
    const loaded = loadUserPaths(dir);
    expect(loaded?.ok).toBe(true);
    expect(loaded?.manifest?.paths[0].id).toBe('cli-help');
  });

  it('merge-appends: existing ids win, new ids append', () => {
    mergeUserPaths(dir, VALID);
    const curated = loadUserPaths(dir)!.manifest!;
    curated.paths[0].rule = 'USER EDITED';
    writeFileSync(join(dir, USER_PATHS_FILE), JSON.stringify(curated, null, 2));

    mergeUserPaths(dir, {
      version: 1,
      paths: [
        { ...VALID.paths[0], rule: 'derived overwrite attempt' },
        { id: 'new-path', rule: 'r2', client: 'cli', steps: [{ expect_exit: 0 }] },
      ],
    });
    const merged = loadUserPaths(dir)!.manifest!;
    expect(merged.paths).toHaveLength(2);
    expect(merged.paths.find((p) => p.id === 'cli-help')?.rule).toBe('USER EDITED');
    expect(merged.paths.find((p) => p.id === 'new-path')).toBeTruthy();
  });

  it('returns null when absent and an error validation when corrupt', () => {
    expect(loadUserPaths(dir)).toBeNull();
    mkdirSync(join(dir, '.uap'), { recursive: true });
    writeFileSync(join(dir, USER_PATHS_FILE), '{not json');
    expect(loadUserPaths(dir)?.ok).toBe(false);
  });
});

describe('deriveUserPaths: canvas-aware mining prompt', () => {
  it('instructs the miner that canvas-drawn content is not DOM text (no expect_text on canvas UIs)', async () => {
    let captured = '';
    await deriveUserPaths('Build a canvas space shooter', async (prompt) => {
      captured = prompt;
      return 'not json';
    });
    // Canvas games render scores/menus via fillText — DOM expect_text can never
    // match them, which made auto-mined journeys unsatisfiable by construction.
    expect(captured).toContain('CANVAS-rendered UIs');
    expect(captured).toContain('expect_text can NEVER match');
  });
});

describe('sanitizeCanvasTextAssertions', () => {
  const canvasMission = 'Build a space shooter with vanilla JavaScript and Canvas';
  const manifest = (steps: object[]): never =>
    ({ version: 1, paths: [{ id: 'p', rule: 'r', client: 'browser', steps }] }) as never;

  it('strips body/html expect_text on canvas missions but keeps real assertions (miner disobeyed the prompt rule)', () => {
    const out = sanitizeCanvasTextAssertions(
      manifest([
        { goto: '/' },
        { expect_visible: '#game' },
        { expect_text: { selector: 'body', contains: 'OCTOPUS INVADERS' } },
        { expect_no_console_errors: true },
      ]),
      canvasMission
    );
    const steps = out.paths[0].steps;
    expect(steps.some((s) => 'expect_text' in s)).toBe(false);
    expect(steps.some((s) => 'expect_visible' in s)).toBe(true);
    expect(steps.some((s) => 'expect_no_console_errors' in s)).toBe(true);
    // Targeted DOM text (a real selector, not the body shell) is preserved.
    const targeted = sanitizeCanvasTextAssertions(
      manifest([{ expect_text: { selector: '#score-label', contains: 'Score' } }]),
      canvasMission
    );
    expect(targeted.paths[0].steps.some((s) => 'expect_text' in s)).toBe(true);
  });

  it('non-canvas missions pass through untouched; a path whose only assert was doomed gets a console-errors check; deriveUserPaths applies it', async () => {
    const domSteps = [{ goto: '/' }, { expect_text: { selector: 'body', contains: 'Welcome' } }];
    const untouched = sanitizeCanvasTextAssertions(manifest(domSteps), 'Build a REST API docs site');
    expect(untouched.paths[0].steps).toEqual(domSteps);

    const onlyDoomed = sanitizeCanvasTextAssertions(manifest(domSteps), canvasMission);
    expect(onlyDoomed.paths[0].steps.some((s) => 'expect_text' in s)).toBe(false);
    expect(onlyDoomed.paths[0].steps.some((s) => 'expect_no_console_errors' in s)).toBe(true);

    const mined = await deriveUserPaths(canvasMission, async () =>
      JSON.stringify({
        version: 1,
        paths: [{ id: 'p', rule: 'r', client: 'browser', steps: [
          { goto: '/' },
          { expect_visible: '#game' },
          { expect_text: { selector: 'body', contains: 'TITLE' } },
        ] }],
      })
    );
    expect(mined).not.toBeNull();
    expect(mined!.paths[0].steps.some((s) => 'expect_text' in s)).toBe(false);
  });
});
