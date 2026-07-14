/**
 * `uap verify` must never pass VACUOUSLY.
 *
 * The live failure: a single-file web app (`rubiks-cube.html`, no package.json)
 * produced ZERO ladder rungs — findWebEntryDir only recognized `index.html`, so
 * no execution rung was synthesized — and verify's `rungs.length === 0` branch
 * returned exit 0 WITHOUT running the visual, vision or behavioral gates. The
 * completion gate calls `uap verify` unstrict, saw 0, and let the model claim
 * DONE having validated nothing. The two halves of the pipeline disagreed about
 * what a deliverable IS: discoverEntryPages found the page; the execution gate
 * did not.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { findWebEntry, findWebEntryDir, detectArtifactType, synthesizeExecutionRung } from '../../src/delivery/execution-gate.js';
import { runVerify } from '../../src/cli/verify.js';
import { discoverEntryPages } from '../../src/delivery/visual-gate.js';

const PAGE = '<html><body><canvas id="c"></canvas><script>document.title="x";</script></body></html>';

describe('execution gate agrees with the visual gate about what a deliverable is', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'uap-vac-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('a non-index .html at root IS a web artifact (the rubiks-cube.html bug)', () => {
    writeFileSync(join(dir, 'rubiks-cube.html'), PAGE);
    expect(findWebEntry(dir)).toEqual({ dir, entry: 'rubiks-cube.html' });
    expect(detectArtifactType(dir)).toBe('web');
    expect(synthesizeExecutionRung(dir)).not.toBeNull();
    // ...and both halves now name the same page.
    expect(discoverEntryPages(dir)).toContain('rubiks-cube.html');
  });

  it('index.html still wins over a sibling .html', () => {
    writeFileSync(join(dir, 'aaa.html'), PAGE);
    writeFileSync(join(dir, 'index.html'), PAGE);
    expect(findWebEntry(dir)?.entry).toBe('index.html');
  });

  it('a non-index .html in a subdirectory is found too', () => {
    mkdirSync(join(dir, 'app'));
    writeFileSync(join(dir, 'app', 'game.html'), PAGE);
    expect(findWebEntry(dir)).toEqual({ dir: join(dir, 'app'), entry: 'game.html' });
    expect(findWebEntryDir(dir)).toBe(join(dir, 'app'));
  });

  it('an empty project is still not a web artifact', () => {
    expect(findWebEntry(dir)).toBeNull();
    expect(detectArtifactType(dir)).toBeNull();
  });
});

describe('runVerify — a renderable deliverable is never skipped', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'uap-vac2-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

  it('entry pages present + zero build/test rungs → the visual gate STILL runs', async () => {
    // No package.json, no cargo, nothing to build or test: the old code returned
    // `SKIP: no verifiable gates detected` + exit 0 here.
    writeFileSync(join(dir, 'rubiks-cube.html'), PAGE);
    const res = await runVerify({ dir, visual: false });
    expect(res.empty).toBeFalsy();
    expect(res.report).not.toMatch(/no verifiable gates detected/);
    // The execution rung is the deliverable's own proof it runs.
    expect(res.rungs.map((r) => r.id)).toContain('execution');
  });

  it('nothing to look at AND nothing to run → still an honest SKIP (exit 0, unstrict)', async () => {
    writeFileSync(join(dir, 'notes.md'), '# hi');
    const res = await runVerify({ dir });
    expect(res.empty).toBe(true);
    expect(res.exitCode).toBe(0);
    expect(res.report).toMatch(/^SKIP:/);
  });

  it('nothing verifiable at MAX fidelity fails CLOSED — "could not check" is not "verified"', async () => {
    writeFileSync(join(dir, 'notes.md'), '# hi');
    const res = await runVerify({
      dir,
      fidelity: { mode: 'max', max: true, visualBaselines: false, visionMinScore: 7, visionEndpoint: '', visionModel: '' } as never,
    });
    expect(res.passed).toBe(false);
    expect(res.exitCode).toBe(1);
    expect(res.report).toMatch(/^UNVERIFIED:/);
  });

  it('nothing verifiable under --strict fails closed (unchanged)', async () => {
    writeFileSync(join(dir, 'notes.md'), '# hi');
    const res = await runVerify({ dir, strict: true });
    expect(res.passed).toBe(false);
    expect(res.exitCode).toBe(1);
  });
});

describe('vm-dom harness — a CDN script is not a missing file', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'uap-cdn-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('a remote <script src> skip-passes to the browser instead of false-failing', async () => {
    // The live regression: rubiks-cube.html loads three.js from cdnjs. The harness
    // resolved src against the filesystem, so the CDN URL read as "does not exist"
    // and failed a page that renders perfectly (vision judged it 9/10).
    const { runVmDomHarness } = await import('../../src/delivery/execution-gate.js');
    writeFileSync(
      join(dir, 'cube.html'),
      '<html><body><script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>' +
        '<script>const s = new THREE.Scene();</script></body></html>'
    );
    const res = runVmDomHarness(dir, undefined, undefined, 'cube.html');
    expect(res.passed).toBe(true);
    expect(res.failureReason).toMatch(/remote scripts/);
  });

  it('a genuinely missing LOCAL script still fails', async () => {
    const { runVmDomHarness } = await import('../../src/delivery/execution-gate.js');
    writeFileSync(join(dir, 'cube.html'), '<html><body><script src="./app.js"></script></body></html>');
    const res = runVmDomHarness(dir, undefined, undefined, 'cube.html');
    expect(res.passed).toBe(false);
    expect(res.failureReason).toMatch(/script not found/);
  });
});
