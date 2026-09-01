/**
 * B1 (deliver-hardening 2026-07-13): project-declared gates from
 * `.uap.json → delivery.gates[]` merge with — and outrank — detected rungs.
 *
 * Defect 6: gate detection is heuristic (package.json, Cargo.toml, …), so a
 * polyglot repo's real contract — a docker buildx target for apps/api, an
 * OpenAPI generator check for handler files — was never a gate: no detector
 * knew it existed, and the heuristic rungs that DID fire verified nothing
 * about the mission. Declared gates give the project the authoritative say;
 * `scope` globs are the metadata A3's mission-scoped relevance builds on.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  detectRungs,
  detectDeclaredRungs,
  mergeDeclaredRungs,
  runRung,
} from '../../src/delivery/verifier-ladder.js';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function project(uapJson?: object): string {
  const root = mkdtempSync(join(tmpdir(), 'uap-declgates-'));
  roots.push(root);
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'fixture', scripts: { build: 'true', test: 'true' } })
  );
  if (uapJson) writeFileSync(join(root, '.uap.json'), JSON.stringify(uapJson));
  return root;
}

describe('declared gates (B1)', () => {
  it('turns delivery.gates[] into rungs with declared fields', () => {
    const root = project({
      delivery: {
        gates: [
          {
            id: 'openapi-check',
            name: 'OpenAPI parity',
            cmd: 'python3 gen_openapi.py --check',
            cwd: 'apps/api',
            scope: ['apps/api/**'],
            required: true,
            tier: 'integration',
            timeoutSec: 120,
          },
        ],
      },
    });
    const rungs = detectDeclaredRungs(root);
    expect(rungs).toHaveLength(1);
    const r = rungs[0];
    expect(r.id).toBe('openapi-check');
    expect(r.command).toBe('python3');
    expect(r.args).toEqual(['gen_openapi.py', '--check']);
    expect(r.cwd).toBe('apps/api');
    expect(r.scope).toEqual(['apps/api/**']);
    expect(r.required).toBe(true);
    expect(r.tier).toBe('integration');
    expect(r.timeoutMs).toBe(120_000);
  });

  it('a declared gate OUTRANKS a detected rung with the same id', () => {
    const root = project({
      delivery: { gates: [{ id: 'build', cmd: 'make release-build', required: true }] },
    });
    const rungs = detectRungs(root);
    const build = rungs.find((r) => r.id === 'build');
    expect(build?.command, 'detection must not veto a declaration').toBe('make');
    expect(build?.args).toEqual(['release-build']);
  });

  it('appends new declared gates without disturbing detected ones', () => {
    const root = project({ delivery: { gates: [{ id: 'docker-builder', cmd: 'docker buildx build --target builder .' }] } });
    const rungs = detectRungs(root);
    expect(rungs.some((r) => r.id === 'docker-builder')).toBe(true);
    expect(rungs.some((r) => r.id === 'build'), 'detected npm build survives').toBe(true);
    expect(rungs.some((r) => r.id === 'test'), 'detected npm test survives').toBe(true);
  });

  it('mergeDeclaredRungs replaces in place and appends new ids', () => {
    const detected = [
      { id: 'a', name: 'A', command: 'true', args: [], required: true, timeoutMs: 1000 },
      { id: 'b', name: 'B', command: 'true', args: [], required: true, timeoutMs: 1000 },
    ];
    const declared = [
      { id: 'b', name: 'B-declared', command: 'false', args: [], required: false, timeoutMs: 5 },
      { id: 'c', name: 'C', command: 'true', args: [], required: true, timeoutMs: 1000 },
    ];
    const merged = mergeDeclaredRungs(detected, declared);
    expect(merged.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(merged[1].name).toBe('B-declared');
    expect(merged[1].required).toBe(false);
  });

  it('runRung honors a declared cwd', () => {
    const root = project({
      delivery: { gates: [{ id: 'sub', cmd: 'true', cwd: 'apps/api' }] },
    });
    mkdirSync(join(root, 'apps', 'api'), { recursive: true });
    // A rung that only passes inside the subdirectory proves cwd was honored.
    const probe = {
      id: 'cwd-probe',
      name: 'cwd probe',
      command: 'test',
      args: ['-f', 'marker.txt'],
      required: true,
      timeoutMs: 10_000,
      cwd: 'apps/api',
    };
    writeFileSync(join(root, 'apps', 'api', 'marker.txt'), 'here\n');
    expect(runRung(probe, root).passed, 'marker only exists under apps/api').toBe(true);
    expect(runRung({ ...probe, cwd: undefined }, root).passed, 'root has no marker').toBe(false);
  });

  it('runRung REFUSES a declared cwd that escapes the project root', () => {
    // Review fix (2026-07-13): `../../elsewhere` would run the gate against a
    // different project while reporting against this one.
    const root = project();
    const escape = {
      id: 'escape',
      name: 'escape probe',
      command: 'true',
      args: [] as string[],
      required: true,
      timeoutMs: 10_000,
      cwd: '../../',
    };
    const r = runRung(escape, root);
    expect(r.passed).toBe(false);
    expect(r.outputTail).toMatch(/escapes the project root/);
  });

  it('a malformed .uap.json degrades to detected rungs only', () => {
    const root = project();
    writeFileSync(join(root, '.uap.json'), '{not json');
    const rungs = detectRungs(root);
    expect(rungs.some((r) => r.id === 'build')).toBe(true);
  });

  it('skips declared entries without id or cmd', () => {
    const root = project({
      delivery: { gates: [{ id: '', cmd: 'true' }, { id: 'nocmd' }, { id: 'ok', cmd: 'true' }] },
    });
    const rungs = detectDeclaredRungs(root);
    expect(rungs.map((r) => r.id)).toEqual(['ok']);
  });

  it('an unknown declared tier falls back to fast', () => {
    const root = project({ delivery: { gates: [{ id: 'g', cmd: 'true', tier: 'platinum' }] } });
    expect(detectDeclaredRungs(root)[0].tier).toBe('fast');
  });
});
