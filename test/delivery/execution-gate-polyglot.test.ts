/**
 * B2 (deliver-hardening 2026-07-13): the execution gate recognizes polyglot
 * artifacts, not just npm/web.
 *
 * Defect 6: `detectArtifactType` read package.json and index.html only, so a
 * pyproject/Cargo/CMake repo got NO execution rung — its build/test rungs
 * passed while the artifact crashed on import or on startup. The gate now
 * classifies a python package (import smoke) and a native binary (run each
 * built executable; fail only on death-by-signal — exit codes are not a
 * portable health signal across arg conventions).
 *
 * Heuristic, fail-open by design: an unreadable manifest or an unbuilt binary
 * is "no artifact", never a guess. B1 declared gates remain the trustworthy
 * path for anything more specific.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  detectArtifactType,
  runExecutionGate,
  synthesizeExecutionRung,
} from '../../src/delivery/execution-gate.js';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'uap-execpoly-'));
  roots.push(root);
  return root;
}

function writePyproject(root: string, name = 'mytool'): void {
  writeFileSync(
    join(root, 'pyproject.toml'),
    `[project]\nname = "${name}"\nversion = "0.1.0"\n\n[project.scripts]\n${name} = "${name.replace(/-/g, '_')}.cli:main"\n`
  );
}

describe('polyglot artifact detection (B2)', () => {
  it('classifies a src-layout pyproject package as python', () => {
    const root = project();
    writePyproject(root);
    mkdirSync(join(root, 'src', 'mytool'), { recursive: true });
    writeFileSync(join(root, 'src', 'mytool', '__init__.py'), '');
    expect(detectArtifactType(root)).toBe('python');
  });

  it('classifies a flat-layout pyproject package as python', () => {
    const root = project();
    writePyproject(root, 'flat-tool');
    mkdirSync(join(root, 'flat_tool'), { recursive: true });
    writeFileSync(join(root, 'flat_tool', '__init__.py'), '');
    expect(detectArtifactType(root)).toBe('python');
  });

  it('classifies a cargo binary project as native-bin once a binary is built', () => {
    const root = project();
    writeFileSync(join(root, 'Cargo.toml'), '[package]\nname = "mybin"\n');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'main.rs'), 'fn main() {}\n');
    // No built binary yet → no runnable artifact → no (vacuous) rung.
    expect(detectArtifactType(root)).toBeNull();
    mkdirSync(join(root, 'target', 'debug'), { recursive: true });
    writeFileSync(join(root, 'target', 'debug', 'mybin'), '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(join(root, 'target', 'debug', 'mybin'), 0o755);
    expect(detectArtifactType(root)).toBe('native-bin');
  });

  it('a cargo LIBRARY (no bin target) never gets a native rung', () => {
    const root = project();
    writeFileSync(join(root, 'Cargo.toml'), '[package]\nname = "mylib"\n');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'lib.rs'), 'pub fn f() {}\n');
    expect(detectArtifactType(root)).toBeNull();
  });

  it('classifies a CMake project as native-bin when the build tree has an executable', () => {
    const root = project();
    writeFileSync(join(root, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.20)\n');
    expect(detectArtifactType(root), 'nothing built → nothing to execute').toBeNull();
    mkdirSync(join(root, 'build'), { recursive: true });
    writeFileSync(join(root, 'build', 'app'), '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(join(root, 'build', 'app'), 0o755);
    expect(detectArtifactType(root)).toBe('native-bin');
  });

  it('a scripts-only package.json falls through to the polyglot checks', () => {
    const root = project();
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', scripts: { build: 'tsc' } }));
    writePyproject(root);
    mkdirSync(join(root, 'src', 'mytool'), { recursive: true });
    writeFileSync(join(root, 'src', 'mytool', '__init__.py'), '');
    // Before B2 this returned null (npm-centric), leaving the python artifact ungated.
    expect(detectArtifactType(root)).toBe('python');
  });

  it('still returns null when there is genuinely no artifact', () => {
    const root = project();
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', scripts: { build: 'tsc' } }));
    expect(detectArtifactType(root)).toBeNull();
  });

  it('synthesizes a runtime-tier execution rung for a python artifact', () => {
    const root = project();
    writePyproject(root);
    mkdirSync(join(root, 'src', 'mytool'), { recursive: true });
    writeFileSync(join(root, 'src', 'mytool', '__init__.py'), '');
    const rung = synthesizeExecutionRung(root);
    expect(rung).not.toBeNull();
    expect(rung?.tier).toBe('runtime');
    expect(rung?.name).toContain('python');
  });
});

describe('polyglot execution (B2)', () => {
  it('passes a clean python import', async () => {
    const root = project();
    writePyproject(root);
    mkdirSync(join(root, 'src', 'mytool'), { recursive: true });
    writeFileSync(join(root, 'src', 'mytool', '__init__.py'), 'VALUE = 1\n');
    const r = await runExecutionGate(root);
    expect(r.passed, r.outputTail).toBe(true);
    expect(r.via).toBe('child-process');
  });

  it('FAILS when the package crashes at import time', async () => {
    const root = project();
    writePyproject(root);
    mkdirSync(join(root, 'src', 'mytool'), { recursive: true });
    // Import-time side effect that blows up: the class of bug build/test rungs miss.
    writeFileSync(join(root, 'src', 'mytool', '__init__.py'), 'raise RuntimeError("boom at import")\n');
    const r = await runExecutionGate(root);
    expect(r.passed).toBe(false);
    expect(r.outputTail).toMatch(/boom at import/);
  });

  it('imports with the project VENV python when one exists', async () => {
    // Review should-fix (2026-07-13): deps live in .venv; ambient python3
    // would fail the import on a missing third-party dep and hard-fail a repo
    // that is actually fine. A stub .venv/bin/python that can import a module
    // the AMBIENT python cannot proves the venv interpreter was used.
    const root = project();
    writePyproject(root);
    mkdirSync(join(root, 'src', 'mytool'), { recursive: true });
    writeFileSync(join(root, 'src', 'mytool', '__init__.py'), 'import venv_only_dep\n');
    mkdirSync(join(root, '.venv', 'bin'), { recursive: true });
    // The "venv" provides the dependency; the ambient interpreter does not.
    mkdirSync(join(root, '.venv', 'lib'), { recursive: true });
    writeFileSync(join(root, '.venv', 'lib', 'venv_only_dep.py'), 'VALUE = 1\n');
    writeFileSync(
      join(root, '.venv', 'bin', 'python'),
      '#!/usr/bin/env bash\nDIR="$(cd "$(dirname "$0")/.." && pwd)"\nPYTHONPATH="$DIR/lib${PYTHONPATH:+:$PYTHONPATH}" exec python3 "$@"\n'
    );
    chmodSync(join(root, '.venv', 'bin', 'python'), 0o755);
    const r = await runExecutionGate(root);
    expect(r.passed, r.outputTail).toBe(true);
  });

  it('skip-passes a native project with nothing built yet', async () => {
    const root = project();
    writeFileSync(join(root, 'Cargo.toml'), '[package]\nname = "mybin"\n');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'main.rs'), 'fn main() {}\n');
    const r = await runExecutionGate(root);
    expect(r.passed).toBe(true);
    expect(r.failureReason).toMatch(/no detectable artifact/);
  });

  it('FAILS when a built binary dies by signal; passes one that exits deliberately', async () => {
    const root = project();
    writeFileSync(join(root, 'Cargo.toml'), '[package]\nname = "mybin"\n');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'main.rs'), 'fn main() {}\n');
    mkdirSync(join(root, 'target', 'debug'), { recursive: true });
    const bin = join(root, 'target', 'debug', 'mybin');
    // A stand-in "binary" that aborts: the gate must read death-by-signal as a crash
    // whatever the exit-code convention would have said.
    writeFileSync(bin, '#!/usr/bin/env bash\nkill -ABRT $$\n');
    chmodSync(bin, 0o755);
    const r = await runExecutionGate(root);
    expect(r.passed).toBe(false);
    expect(r.failureReason).toMatch(/SIGABRT/);

    writeFileSync(bin, '#!/usr/bin/env bash\nexit 3\n');
    const r2 = await runExecutionGate(root);
    expect(r2.passed, 'a deliberate non-zero exit is not a crash').toBe(true);
  });
});
