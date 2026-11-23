import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { approveCmd } from '../../src/cli/quality.js';
import { pngPath } from './png-fixture.js';

let root: string;
let runDir: string;
let logs: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'uap-approve-'));
  runDir = join(root, 'run-outputs');
  mkdirSync(runDir, { recursive: true });
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  rmSync(root, { recursive: true, force: true });
});

const out = (): string => logs.join('\n');

/** Two distinct solid-color PNGs + one non-artifact file, as a run dir holds. */
function seedRunOutputs(): void {
  pngPath(runDir, 'capture-a.png', 16, 16, () => [255, 40, 10]);
  pngPath(runDir, 'capture-b.png', 16, 16, () => [40, 90, 255]);
  writeFileSync(join(runDir, 'report.json'), '{"note":"not an artifact"}');
}

describe('E.2 uap quality approve — the run-harvest anchoring surface', () => {
  it('harvests a run dir: readable artifacts become anchors, non-artifacts skip, tier re-derives', () => {
    seedRunOutputs();
    approveCmd(root, { target: 'visual-scene', fromDir: 'run-outputs' });

    expect(process.exitCode).toBeUndefined();
    // 2 PNGs anchored, 1 non-artifact skipped — the counts surface in the report.
    expect(out()).toContain('approved: 2 anchor(s) added (1 skipped)');
    expect(out()).toContain('skipped');
    expect(out()).toContain('not a readable');
    // Anchors persisted for the class (project-local, gitignored by policy).
    const anchorDir = join(root, '.uap', 'quality', 'anchors', 'visual-scene');
    expect(existsSync(anchorDir)).toBe(true);
    // The tier re-derived from the approved anchors — the "raises the bar" half.
    const tiers = JSON.parse(readFileSync(join(root, '.uap', 'quality', 'tiers.json'), 'utf-8'));
    expect(tiers.tiers['visual-scene/default']).toBeDefined();
  });

  it('leaves dotfiles alone — hidden editor scratch never anchors', () => {
    seedRunOutputs();
    writeFileSync(join(runDir, '.DS_Store'), 'junk');
    approveCmd(root, { target: 'visual-scene', fromDir: 'run-outputs' });
    expect(out()).toContain('approved: 2 anchor(s) added (1 skipped)');
    const anchorDir = join(root, '.uap', 'quality', 'anchors', 'visual-scene');
    // Only the two PNGs (+ their profiles) landed — the dotfile was not read.
    expect(readdirSync(anchorDir).some((f) => f.includes('DS_Store'))).toBe(false);
  });

  it('fails closed when the directory is missing', () => {
    approveCmd(root, { target: 'visual-scene', fromDir: 'no-such-dir' });
    expect(process.exitCode).toBe(2);
    expect(out()).toContain('not a directory');
    // Nothing was written.
    expect(existsSync(join(root, '.uap', 'quality', 'anchors'))).toBe(false);
  });

  it('fails closed when nothing in the dir is readable for the class', () => {
    writeFileSync(join(runDir, 'report.json'), '{}');
    writeFileSync(join(runDir, 'notes.txt'), 'words');
    approveCmd(root, { target: 'visual-scene', fromDir: 'run-outputs' });
    expect(process.exitCode).toBe(2);
    expect(out()).toContain('nothing anchored');
    // No tier invented from nothing (the fail-closed rule).
    expect(existsSync(join(root, '.uap', 'quality', 'tiers.json'))).toBe(false);
  });

  it('requires both the class and the dir', () => {
    approveCmd(root, { target: 'visual-scene' });
    expect(process.exitCode).toBe(2);
    expect(out()).toContain('Usage: uap quality approve');
    approveCmd(root, { fromDir: 'run-outputs' });
    expect(out()).toContain('Usage: uap quality approve');
  });

  it('works through the real CLI flag path (--from maps to the harvest dir)', () => {
    // The unit tests call approveCmd directly with fromDir; this one exercises
    // the commander wiring that caught a real bug: --from lands on options.from.
    const cliRoot = mkdtempSync(join(tmpdir(), 'uap-approve-cli-'));
    const runOut = join(cliRoot, 'shots');
    mkdirSync(runOut, { recursive: true });
    pngPath(runOut, 'hero.png', 16, 16, () => [255, 60, 20]);
    pngPath(runOut, 'wide.png', 16, 16, () => [30, 80, 255]);
    const cli = join(__dirname, '..', '..', 'dist', 'bin', 'cli.js');
    if (!existsSync(cli)) {
      rmSync(cliRoot, { recursive: true, force: true });
      throw new Error(`built CLI missing at ${cli} — run npm run build first`);
    }
    const res = spawnSync(process.execPath, [cli, 'quality', 'approve', 'visual-scene', '--from', runOut], {
      encoding: 'utf-8',
      timeout: 60_000,
      // Hermetic: the CLI's project dir IS the tmp root, so anchors + tiers
      // land in cliRoot and the rmSync below cleans everything.
      cwd: cliRoot,
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('approved: 2 anchor(s) added');
    rmSync(cliRoot, { recursive: true, force: true });
  });
});
