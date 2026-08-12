/**
 * A green compile gate on a crate that does not compile.
 *
 * `cargo check --workspace` builds DEFAULT features only. A crate can put its
 * entire public surface behind `#[cfg(feature = "x")]` with `default = []`, and
 * the gate then passes without ever looking at it — the same hazard the
 * workspace-membership guard already documents, where code outside
 * `[workspace] members` "passes" because cargo never sees it.
 *
 * Measured 2026-08-12 on a pgrx Postgres extension: every `#[pg_extern]` lived
 * in `#[cfg(feature = "pgrx")] mod pgrx_funcs`. The gate reported ZERO errors.
 * Enabling the feature revealed 52 — invented pgrx APIs (`CompositeType`,
 * `sql_inline`, `pgrx::Datum`), `SetOfIterator` returns with no item type. No
 * judge caught any of it, because a green compile gate is the evidence a judge
 * trusts most.
 *
 * Why this is ADVISORY and compiles nothing — both measured, not assumed:
 *   - `cargo check --features x` as a required rung fires on 32% of 681 real
 *     registry crates: a third of all Rust projects paying an extra full
 *     compile per gated feature.
 *   - worse, the feature may not be buildable here at all (this one needs a
 *     source-built Postgres via `cargo pgrx init`), so a required rung would
 *     fail every gate for a reason unrelated to the mission.
 *   - narrowing by share of gated code does not rescue it: the crate that
 *     motivated this scores 19%, below any threshold with a sane
 *     false-positive rate, because the module is small in lines while holding
 *     100% of the crate's API.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { featureGatedModules, detectCargoRungs } from '../../src/delivery/verifier-ladder.js';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function crate(manifest: string, sources: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'uap-cargo-'));
  roots.push(root);
  writeFileSync(join(root, 'Cargo.toml'), manifest);
  mkdirSync(join(root, 'src'), { recursive: true });
  for (const [name, body] of Object.entries(sources)) {
    const p = join(root, 'src', name);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, body);
  }
  return root;
}

const PGRX_MANIFEST = `[package]
name = "x"

[features]
default = []
pgrx = ["dep:pgrx", "pgrx/pg14"]
`;

describe('featureGatedModules', () => {
  it('finds the module the default build will never compile', () => {
    const root = crate(PGRX_MANIFEST, {
      'lib.rs': 'pub mod helper;\n\n#[cfg(feature = "pgrx")]\nmod pgrx_funcs {\n  fn a() {}\n}\n',
    });
    expect(featureGatedModules(root)).toEqual(['pgrx']);
  });

  it('says nothing when the feature IS in default — the gate can see it', () => {
    const root = crate(PGRX_MANIFEST.replace('default = []', 'default = ["pgrx"]'), {
      'lib.rs': '#[cfg(feature = "pgrx")]\nmod pgrx_funcs { fn a() {} }\n',
    });
    expect(featureGatedModules(root)).toEqual([]);
  });

  it('ignores a cfg that gates something other than a module', () => {
    // A crate gating a few serde impls is ordinary, and its default build still
    // covers the crate. Firing there would make this noise on half of crates.io.
    const root = crate(PGRX_MANIFEST.replace('pgrx =', 'serde ='), {
      'lib.rs': '#[cfg(feature = "serde")]\nimpl Serialize for X {}\n#[cfg(feature = "serde")]\nfn helper() {}\n',
    });
    expect(featureGatedModules(root)).toEqual([]);
  });

  it('catches a gated `pub mod` file declaration, not just an inline block', () => {
    const root = crate(PGRX_MANIFEST, {
      'lib.rs': '#[cfg(feature = "pgrx")]\npub mod pgrx_funcs;\n',
      'pgrx_funcs.rs': 'fn a() {}\n',
    });
    expect(featureGatedModules(root)).toEqual(['pgrx']);
  });

  it('ignores a cfg naming a feature the manifest does not declare', () => {
    // `#[cfg(feature = "nightly")]` with no such feature is dead code, not a
    // blind spot — reporting it would send someone chasing a feature that
    // cannot be enabled.
    const root = crate(PGRX_MANIFEST, {
      'lib.rs': '#[cfg(feature = "nightly")]\nmod fast { fn a() {} }\n',
    });
    expect(featureGatedModules(root)).toEqual([]);
  });

  it('reports several gated features, sorted and deduped', () => {
    const root = crate(
      '[package]\nname = "x"\n\n[features]\ndefault = []\na = []\nb = []\n',
      {
        'lib.rs': '#[cfg(feature = "b")]\nmod b1 {}\n#[cfg(feature = "a")]\nmod a1 {}\n',
        'other.rs': '#[cfg(feature = "b")]\nmod b2 {}\n',
      }
    );
    expect(featureGatedModules(root)).toEqual(['a', 'b']);
  });

  it('returns nothing for a crate with no [features] block at all', () => {
    const root = crate('[package]\nname = "x"\n', { 'lib.rs': 'fn a() {}\n' });
    expect(featureGatedModules(root)).toEqual([]);
  });

  it('survives an unreadable manifest instead of throwing', () => {
    expect(() => featureGatedModules('/definitely/not/here')).not.toThrow();
    expect(featureGatedModules('/definitely/not/here')).toEqual([]);
  });
});

describe('the ladder rung', () => {
  it('adds an ADVISORY notice that names the feature and how to verify it', () => {
    const root = crate(PGRX_MANIFEST, {
      'lib.rs': '#[cfg(feature = "pgrx")]\nmod pgrx_funcs { fn a() {} }\n',
    });
    const rung = detectCargoRungs(root).find((r) => r.id === 'cargo-feature-blind-spot');
    expect(rung).toBeTruthy();
    expect(rung!.required, 'must not block: the feature may not be buildable here').toBe(false);
    const script = rung!.args.join(' ');
    // The features must be named in the BLIND-SPOT clause, not merely present
    // somewhere in the string — they also appear in the verify command, so a
    // looser assertion passes even when the notice stops saying what is hidden.
    expect(script).toContain('never sees: pgrx');
    expect(script, 'the reply has to name the command that actually checks it')
      .toContain('--features pgrx');
  });

  it('compiles NOTHING — the rung must stay cheap', () => {
    const root = crate(PGRX_MANIFEST, {
      'lib.rs': '#[cfg(feature = "pgrx")]\nmod pgrx_funcs { fn a() {} }\n',
    });
    const rung = detectCargoRungs(root).find((r) => r.id === 'cargo-feature-blind-spot')!;
    expect(rung.command).toBe('bash');
    expect(rung.args.join(' ')).not.toMatch(/\bcargo (check|build|test)\b(?![^"]*")/);
  });

  it('is absent for an ordinary crate, so the ladder is unchanged', () => {
    const root = crate('[package]\nname = "x"\n', { 'lib.rs': 'fn a() {}\n' });
    const ids = detectCargoRungs(root).map((r) => r.id);
    expect(ids).not.toContain('cargo-feature-blind-spot');
    expect(ids, 'the real gates must still be there').toContain('cargo-check');
  });

  it('leaves cargo-check itself required and untouched', () => {
    const root = crate(PGRX_MANIFEST, {
      'lib.rs': '#[cfg(feature = "pgrx")]\nmod pgrx_funcs { fn a() {} }\n',
    });
    const check = detectCargoRungs(root).find((r) => r.id === 'cargo-check')!;
    expect(check.required).toBe(true);
    expect(check.args).toEqual(['check', '--workspace']);
  });
});
