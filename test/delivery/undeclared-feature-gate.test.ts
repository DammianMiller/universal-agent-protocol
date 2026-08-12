/**
 * `#[cfg(feature = "x")]` where the crate declares no feature "x".
 *
 * The existing blind-spot notice covers a feature that EXISTS but is off by
 * default — real code the plain gate skips. This is the worse cousin: a gate on
 * a feature the manifest never declares can be enabled by NOTHING. `cargo check
 * --features pgrx` errors with "unknown feature", so that module is not merely
 * unchecked, it is permanently dead, and `cargo check` reports a serene zero.
 *
 * Measured live 2026-08-12 on worktree 001-optimize-motivation-system: all NINE
 * `#[pg_extern]` functions sat inside `#[cfg(feature = "pgrx")] mod pgrx_funcs`,
 * the manifest had no `[features]` table and no pgrx dependency at all, and
 * `cargo check --workspace` returned 0 errors. A whole mission's work, wholly
 * uncompiled, behind a green gate. `featureGatedModules` returned nothing —
 * it bails when there is no `[features]` block, which is exactly this case.
 *
 * The false-positive to avoid: an OPTIONAL DEPENDENCY implicitly declares a
 * feature of the same name in Cargo, so `serde = { optional = true }` makes
 * `#[cfg(feature = "serde")]` perfectly legitimate with no `[features]` table.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { undeclaredFeatureGates, detectCargoRungs } from '../../src/delivery/verifier-ladder.js';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function crate(manifest: string, lib: string): string {
  const root = mkdtempSync(join(tmpdir(), 'uap-undecl-'));
  roots.push(root);
  writeFileSync(join(root, 'Cargo.toml'), manifest);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'lib.rs'), lib);
  return root;
}

const GATED = '#[cfg(feature = "pgrx")]\nmod pgrx_funcs {\n    pub fn a() {}\n}\n';

describe('a cfg gate on a feature the manifest never declares', () => {
  it('is reported — no [features] table at all (the live shape)', () => {
    const root = crate('[package]\nname = "x"\nversion = "0.1.0"\n', GATED);
    expect(undeclaredFeatureGates(root)).toEqual(['pgrx']);
  });

  it('is reported when a [features] table exists but omits it', () => {
    const root = crate('[package]\nname = "x"\n\n[features]\ndefault = []\nother = []\n', GATED);
    expect(undeclaredFeatureGates(root)).toEqual(['pgrx']);
  });

  it('surfaces as a ladder rung that names the feature and the consequence', () => {
    const root = crate('[package]\nname = "x"\n', GATED);
    const rung = detectCargoRungs(root).find((r) => r.id === 'cargo-feature-undeclared');
    expect(rung, 'the operator and the acceptance judge both read the ladder').toBeTruthy();
    const said = String(rung!.args.at(-1));
    expect(said).toContain('pgrx');
    expect(said, 'it must say the code can NEVER be built, not merely that it is skipped').toMatch(
      /never be compiled|cannot be compiled/i
    );
    expect(said, 'and why: cargo will reject the flag').toMatch(/unknown feature/i);
  });

  it('leaves cargo-check required and untouched', () => {
    const root = crate('[package]\nname = "x"\n', GATED);
    const check = detectCargoRungs(root).find((r) => r.id === 'cargo-check')!;
    expect(check.required).toBe(true);
    expect(check.args).toEqual(['check', '--workspace']);
  });
});

describe('what it must NOT flag', () => {
  it('a feature declared in [features]', () => {
    const root = crate('[package]\nname = "x"\n\n[features]\ndefault = []\npgrx = ["dep:pgrx"]\n', GATED);
    expect(undeclaredFeatureGates(root)).toEqual([]);
  });

  it('a feature declared and reachable from default', () => {
    const root = crate('[package]\nname = "x"\n\n[features]\ndefault = ["pgrx"]\npgrx = []\n', GATED);
    expect(undeclaredFeatureGates(root)).toEqual([]);
  });

  it('an OPTIONAL DEPENDENCY, which declares a feature implicitly', () => {
    // The false positive that would make this rule unusable in the wild.
    const root = crate(
      '[package]\nname = "x"\n\n[dependencies]\npgrx = { version = "0.13", optional = true }\n',
      GATED
    );
    expect(undeclaredFeatureGates(root)).toEqual([]);
  });

  it('an optional dependency declared across several lines', () => {
    const root = crate(
      '[package]\nname = "x"\n\n[dependencies.pgrx]\nversion = "0.13"\noptional = true\n',
      GATED
    );
    expect(undeclaredFeatureGates(root)).toEqual([]);
  });

  it('a NON-optional dependency of the same name — that is not a feature', () => {
    const root = crate('[package]\nname = "x"\n\n[dependencies]\npgrx = "0.13"\n', GATED);
    expect(undeclaredFeatureGates(root)).toEqual(['pgrx']);
  });

  it('a non-optional dependency written in TABLE form is still not a feature', () => {
    // The distinguishing case: same braces as an optional dep, no `optional`.
    // Only a rule that reads optionality — not merely "is a dependency" — gets
    // this right.
    const root = crate('[package]\nname = "x"\n\n[dependencies]\npgrx = { version = "0.13" }\n', GATED);
    expect(undeclaredFeatureGates(root)).toEqual(['pgrx']);
  });

  it('a crate with no cfg-gated modules at all', () => {
    const root = crate('[package]\nname = "x"\n', 'pub fn a() {}\n');
    expect(undeclaredFeatureGates(root)).toEqual([]);
    expect(detectCargoRungs(root).some((r) => r.id === 'cargo-feature-undeclared')).toBe(false);
  });

  it('cfg on something that is not a feature (target_os, test)', () => {
    const root = crate('[package]\nname = "x"\n', '#[cfg(target_os = "linux")]\nmod l { pub fn a() {} }\n');
    expect(undeclaredFeatureGates(root)).toEqual([]);
  });
});
