/**
 * A model must not switch off the thing that is measuring it.
 *
 * `cargo check --workspace` compiles DEFAULT features only. So when a crate's
 * API lives behind `#[cfg(feature = "pgrx")]`, deleting "pgrx" from
 * `default` makes the required gate compile nothing and report a triumphant
 * zero errors. Observed three times on one live run: each time the gate went
 * red, `default = ["pgrx"]` came back as `default = []`, and the next turn
 * "passed".
 *
 * That is not the same failure as writing bad code — it is worse, because it
 * is invisible. The blind-spot rung added in #696 reports the condition; this
 * refuses to create it in the first place.
 *
 * Narrow on purpose: only a SHRINKING default list is refused. Adding
 * features, reordering them, renaming the crate, editing dependencies and
 * every other Cargo.toml change stay untouched.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { featureDowngradeRefusal } from '../../src/delivery/agentic-executor.js';

const CRATE = (def: string) => `[package]
name = "x"
version = "0.1.0"

[dependencies]
pgrx = { version = "0.13.0", optional = true }

[features]
default = ${def}
pgrx = ["dep:pgrx", "pgrx/pg14"]
extra = []
`;

afterEach(() => {
  delete process.env.UAP_DELIVER_ALLOW_FEATURE_DOWNGRADE;
});

describe('refusing to make the compile gate vacuous', () => {
  it('refuses emptying the default feature list', () => {
    const msg = featureDowngradeRefusal('Cargo.toml', CRATE('["pgrx"]'), CRATE('[]'));
    expect(msg).toBeTruthy();
    expect(msg).toContain('pgrx');
  });

  it('names the file, what was removed, and why it matters', () => {
    const msg = featureDowngradeRefusal('crates/ext/Cargo.toml', CRATE('["pgrx", "extra"]'), CRATE('["extra"]')) ?? '';
    expect(msg).toContain('pgrx');
    expect(msg, 'a refusal that does not say WHICH file cannot be acted on').toContain('crates/ext/Cargo.toml');
    expect(msg, 'the model must be told the gate goes blind, not just "no"').toMatch(/default|compile|check/i);
    expect(msg, 'and that nothing landed, or it will re-read and get confused').toMatch(/nothing was written/i);
  });

  it('allows a change of quote style — same features, different spelling', () => {
    // Without stripping the quotes, "pgrx" and 'pgrx' compare unequal and a
    // cosmetic edit would be refused as a downgrade.
    expect(featureDowngradeRefusal('Cargo.toml', CRATE('["pgrx"]'), CRATE("['pgrx']"))).toBeNull();
  });

  it('allows whitespace and trailing-comma reformatting', () => {
    expect(featureDowngradeRefusal('Cargo.toml', CRATE('["pgrx"]'), CRATE('[ "pgrx", ]'))).toBeNull();
  });

  it('refuses dropping the default key entirely', () => {
    const after = CRATE('["pgrx"]').replace('default = ["pgrx"]\n', '');
    expect(featureDowngradeRefusal('Cargo.toml', CRATE('["pgrx"]'), after)).toBeTruthy();
  });

  it('refuses deleting the whole [features] section', () => {
    const after = CRATE('["pgrx"]').split('[features]')[0];
    expect(featureDowngradeRefusal('Cargo.toml', CRATE('["pgrx"]'), after)).toBeTruthy();
  });

  it('reads a multi-line default list', () => {
    const before = CRATE('[\n  "pgrx",\n  "extra",\n]');
    const after = CRATE('[\n  "extra",\n]');
    expect(featureDowngradeRefusal('Cargo.toml', before, after)).toBeTruthy();
  });
});

describe('what it must NOT interfere with', () => {
  it('allows adding a feature', () => {
    expect(featureDowngradeRefusal('Cargo.toml', CRATE('["pgrx"]'), CRATE('["pgrx", "extra"]'))).toBeNull();
  });

  it('allows reordering', () => {
    expect(featureDowngradeRefusal('Cargo.toml', CRATE('["pgrx", "extra"]'), CRATE('["extra", "pgrx"]'))).toBeNull();
  });

  it('allows an unrelated edit elsewhere in the file', () => {
    const after = CRATE('["pgrx"]').replace('version = "0.1.0"', 'version = "0.2.0"');
    expect(featureDowngradeRefusal('Cargo.toml', CRATE('["pgrx"]'), after)).toBeNull();
  });

  it('says nothing about a crate that never had default features', () => {
    expect(featureDowngradeRefusal('Cargo.toml', CRATE('[]'), CRATE('[]'))).toBeNull();
  });

  it('ignores files that are not Cargo.toml', () => {
    expect(featureDowngradeRefusal('src/lib.rs', CRATE('["pgrx"]'), CRATE('[]'))).toBeNull();
    expect(featureDowngradeRefusal('deps/Cargo.lock', CRATE('["pgrx"]'), CRATE('[]'))).toBeNull();
  });

  it('still guards a Cargo.toml nested in a workspace member', () => {
    expect(featureDowngradeRefusal('crates/ext/Cargo.toml', CRATE('["pgrx"]'), CRATE('[]'))).toBeTruthy();
  });

  it('yields to the operator escape hatch', () => {
    process.env.UAP_DELIVER_ALLOW_FEATURE_DOWNGRADE = '1';
    expect(featureDowngradeRefusal('Cargo.toml', CRATE('["pgrx"]'), CRATE('[]'))).toBeNull();
  });

  it('does not choke on a Cargo.toml it cannot parse', () => {
    // A guard that throws would break every write to a malformed manifest.
    expect(() => featureDowngradeRefusal('Cargo.toml', 'not [ toml at "all', 'still not toml')).not.toThrow();
  });
});
