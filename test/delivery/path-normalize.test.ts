import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import {
  squash,
  fuzzyEq,
  containToWorkdir,
  repairFilename,
  repairLeadingDot,
  normalizeToolPath,
} from '../../src/delivery/path-normalize.js';

const PY_MODULE_DIR = join(process.cwd(), 'tools', 'agents', 'scripts');
const pythonAvailable = (() => {
  const r = spawnSync('python3', ['-c', 'import difflib,os,re'], { encoding: 'utf8' });
  return r.status === 0;
})();

describe('deliver path-normalize', () => {
  let wd: string;

  beforeEach(() => {
    wd = mkdtempSync(join(tmpdir(), 'uap-pathnorm-'));
    writeFileSync(join(wd, '.git'), ''); // project marker
    mkdirSync(join(wd, 'src', 'components'), { recursive: true });
    writeFileSync(join(wd, 'src', 'App.tsx'), 'x');
  });
  afterEach(() => rmSync(wd, { recursive: true, force: true }));

  it('squash + fuzzyEq match the documented garbles', () => {
    expect(squash('octopus_invaders')).toBe('octopusinvaders');
    expect(fuzzyEq('octopus_invaders', 'octopus-invaders')).toBe(true); // squash
    expect(fuzzyEq('space-shooter', 'space-shootr')).toBe(true); // close
    expect(fuzzyEq('components', 'componnets')).toBe(true);
    expect(fuzzyEq('components', 'utils')).toBe(false);
  });

  it('contains a garbled absolute PREFIX back onto the known workdir', () => {
    const wdName = wd.split('/').pop()!;
    const garbled = `/home/nope/${wdName.replace(/.$/, 'x')}/src/App.tsx`; // mangled last char of root name
    const r = containToWorkdir(garbled, wd);
    expect(r.changed).toBe(true);
    expect(r.path).toBe(join(wd, 'src', 'App.tsx'));
  });

  it('fuzzy-corrects a garbled SUBDIR under the workdir against disk', () => {
    const garbled = join(wd, 'src', 'componnets', 'Button.tsx'); // componnets -> components (exists)
    const r = containToWorkdir(garbled, wd);
    expect(r.changed).toBe(true);
    expect(r.path).toBe(join(wd, 'src', 'components', 'Button.tsx'));
  });

  it('leaves a real path elsewhere untouched (fail-safe)', () => {
    const r = containToWorkdir('/etc/hostname', wd);
    expect(r.changed).toBe(false);
    expect(r.path).toBe('/etc/hostname');
  });

  it('repairs a garbled filename to a real sibling (read/edit case)', () => {
    const r = repairFilename(join(wd, 'src', 'app.TSX')); // case garble of App.tsx
    expect(r.changed).toBe(true);
    expect(r.path).toBe(join(wd, 'src', 'App.tsx'));
  });

  it('normalizeToolPath(forWrite) contains; (forRead) also repairs filename', () => {
    expect(normalizeToolPath(wd, join(wd, 'src', 'componnets', 'X.tsx'), { forWrite: true }).path).toBe(
      join(wd, 'src', 'components', 'X.tsx')
    );
    // relative read with a filename garble repairs to the sibling
    const r = normalizeToolPath(wd, 'src/app.tsx', { forWrite: false });
    expect(r.path).toBe('src/App.tsx');
  });

  it.skipIf(!pythonAvailable)('agrees with the python proxy normalizer on shared fixtures', () => {
    const wdName = wd.split('/').pop()!;
    const fixtures = [
      `/home/nope/${wdName.replace(/.$/, 'x')}/src/App.tsx`, // garbled prefix
      join(wd, 'src', 'componnets', 'Button.tsx'), // garbled subdir
      '/etc/hostname', // real elsewhere → unchanged
      join(wd, 'src', 'App.tsx'), // already correct → unchanged
    ];
    const py = spawnSync(
      'python3',
      [
        '-c',
        `import sys,json;sys.path.insert(0,sys.argv[1]);from toolcall_path_normalizer import contain_to_workdir as c;` +
          `wd=sys.argv[2];print(json.dumps([c(p,wd)[0] for p in json.loads(sys.argv[3])]))`,
        PY_MODULE_DIR,
        wd,
        JSON.stringify(fixtures),
      ],
      { encoding: 'utf8' }
    );
    expect(py.status, py.stderr).toBe(0);
    const pyOut: string[] = JSON.parse(py.stdout.trim());
    const tsOut = fixtures.map((f) => containToWorkdir(f, wd).path);
    expect(tsOut).toEqual(pyOut);
  });
});

describe('stray leading dot on a WRITE target', () => {
  // The local model emitted `.fireworks.html` 7 times in one run and 30 in
  // another, for a project whose real file is `fireworks.html`. Reads recovered
  // through repairFilename; writes did not, because that repair is deliberately
  // read-only — it fuzzy-matches a punctuation-squashed basename, and letting
  // THAT redirect a write would drop a new `constants2.js` onto an existing
  // `constants.js`.
  //
  // Left unrepaired, a write_file would have created a dotfile shadowing the
  // real file, and every later read of the real file would miss those edits —
  // the phantom-tree failure this module exists to prevent.
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pn-dot-'));
    writeFileSync(join(root, 'fireworks.html'), '<html></html>');
    writeFileSync(join(root, 'constants.js'), 'const a = 1;');
    writeFileSync(join(root, '.uap.json'), '{}');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const write = (p: string) => normalizeToolPath(root, p, { forWrite: true });

  it('repairs a dotted name whose undotted twin exists', () => {
    expect(write('.fireworks.html').path).toBe('fireworks.html');
    expect(write('.constants.js').path).toBe('constants.js');
    expect(write('.fireworks.html').changed).toBe(true);
  });

  it('leaves a REAL dotfile alone', () => {
    // .uap.json exists and there is no uap.json — nothing to repair, and
    // repairing it would corrupt a legitimate config write.
    const r = write('.uap.json');
    expect(r.path).toBe('.uap.json');
    expect(r.changed).toBe(false);
  });

  it('leaves a NEW dotfile alone', () => {
    expect(write('.gitignore').changed).toBe(false);
    expect(write('.env').changed).toBe(false);
  });

  it('never redirects a genuinely-new file onto a similar existing one', () => {
    // The reason the fuzzy repair stays read-only. An exact leading-dot strip
    // cannot do this; a squash-match could.
    expect(write('constants2.js').changed).toBe(false);
    expect(write('fireworks.htm').changed).toBe(false);
  });

  it('does not fire when the dotted file itself exists', () => {
    writeFileSync(join(root, '.notes.md'), 'x');
    writeFileSync(join(root, 'notes.md'), 'y');
    const r = write('.notes.md');
    expect(r.changed).toBe(false);
    expect(r.path).toBe('.notes.md');
  });

  it('will not point a write at a directory', () => {
    mkdirSync(join(root, 'assets'));
    const r = write('.assets');
    expect(r.changed).toBe(false);
  });

  it('repairLeadingDot ignores relative input', () => {
    expect(repairLeadingDot('.fireworks.html').changed).toBe(false);
  });
});
