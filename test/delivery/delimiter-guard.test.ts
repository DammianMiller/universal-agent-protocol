/**
 * A write that leaves the file unparseable was accepted, then reported.
 *
 * Every other write guard REFUSES — anti-gutting, stub-substance, duplicate
 * definitions. A broken delimiter was only ever reported, after the write had
 * landed. That difference is the whole problem: the tree is left in a state no
 * compiler can read, so the next edit is authored against a file whose
 * structure the model can no longer see, and it digs deeper.
 *
 * Measured 2026-08-12 on a live pgrx mission. Compile errors across 8 turns:
 *
 *     52 → 22 → 45 → 2 → 27 → 23
 *
 * Every "2" was `unclosed delimiter` — a parse failure truncating compilation
 * and HIDING the real errors behind it, so the count looked like near-success
 * at its worst moments. Three of eight turns were spent with the crate
 * unparseable. Per-write `cargo check` was running fine (1s) and reporting it;
 * being told afterwards did not help, because the damage was already on disk.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { delimiterImbalance, delimiterRefusal } from '../../src/delivery/agentic-executor.js';

afterEach(() => {
  delete process.env.UAP_DELIVER_ALLOW_UNBALANCED;
});

const OK_RUST = 'fn a() {\n  let x = (1 + 2);\n}\n';

describe('delimiterImbalance', () => {
  it('accepts balanced code', () => {
    expect(delimiterImbalance(OK_RUST, 'a.rs')).toBeNull();
  });

  it('names an unclosed brace and where it was opened', () => {
    const msg = delimiterImbalance('fn a() {\n  let x = 1;\n', 'a.rs');
    expect(msg).toContain('unclosed');
    expect(msg).toContain('line 1');
  });

  it('names an unexpected closing brace — the exact live failure', () => {
    const msg = delimiterImbalance('fn a() {\n}\n}\n', 'a.rs');
    expect(msg).toContain('unexpected closing');
    expect(msg).toContain('line 3');
  });

  it('catches a mismatched pair', () => {
    expect(delimiterImbalance('fn a( ] {}\n', 'a.rs')).toContain('mismatched');
  });

  it('ignores brackets inside strings', () => {
    expect(delimiterImbalance('let s = "a { b ( c";\n', 'a.rs')).toBeNull();
  });

  it('ignores brackets inside line and block comments', () => {
    expect(delimiterImbalance('// }}}\n/* ((( */\nfn a() {}\n', 'a.rs')).toBeNull();
  });

  it('handles NESTED block comments, which Rust allows', () => {
    expect(delimiterImbalance('/* outer /* inner } */ still */\nfn a() {}\n', 'a.rs')).toBeNull();
  });

  it('handles Rust raw strings, including hashed ones', () => {
    expect(delimiterImbalance('let s = r#"a { b " c"#;\nfn a() {}\n', 'a.rs')).toBeNull();
    expect(delimiterImbalance('let s = r"{{{";\nfn a() {}\n', 'a.rs')).toBeNull();
    // A raw string containing a QUOTE is what actually distinguishes raw
    // handling from ordinary string handling: parsed as a normal string, the
    // inner quote closes early and the `{` that follows is counted as real
    // code, so the file is reported unbalanced when it is fine.
    expect(delimiterImbalance('let s = r#"a " { "#;\nfn a() {}\n', 'a.rs')).toBeNull();
  });

  it('does not mistake a Rust LIFETIME for an unterminated char literal', () => {
    // `'a` has no closing quote. Treating it as a string would swallow the rest
    // of the file and report every later brace as inside a literal.
    expect(delimiterImbalance("fn a<'a>(x: &'a str) {\n  let c = '}';\n}\n", 'a.rs')).toBeNull();
  });

  it('ignores escaped quotes', () => {
    expect(delimiterImbalance('let s = "he said \\\\"hi\\\\" {";\nfn a() {}\n', 'a.rs')).toBeNull();
  });

  it('says nothing about languages it cannot check', () => {
    expect(delimiterImbalance('{{{ unbalanced', 'notes.md')).toBeNull();
    expect(delimiterImbalance('{{{ unbalanced', 'query.sql')).toBeNull();
  });

  it('checks JSON, the other language measured clean', () => {
    expect(delimiterImbalance('{"a": [1, 2', 'a.json')).toContain('unclosed');
  });

  it('stays OFF for JS/TS, where regex literals defeat a parser-free scan', () => {
    // Measured: 14.3% of 350 real .ts files and 6 of 7 .js files were flagged,
    // every one a regex literal like /[^)]/ pushing a bracket that never
    // closes. Refusing one healthy TypeScript file in seven would be worse
    // than the problem this fixes.
    expect(delimiterImbalance('const re = /[^)]/;\nfunction a() {', 'a.ts')).toBeNull();
    expect(delimiterImbalance('function a() {', 'a.js')).toBeNull();
    expect(delimiterRefusal('a.ts', 'const a = 1;', 'function a() {')).toBeNull();
  });
});

describe('delimiterRefusal', () => {
  it('refuses a write that breaks a healthy file', () => {
    const refusal = delimiterRefusal('lib.rs', OK_RUST, 'fn a() {\n  let x = 1;\n');
    expect(refusal).toBeTruthy();
    expect(refusal).toContain('does not parse');
    expect(refusal, 'the model must know the file was NOT changed').toContain('still the version you read');
  });

  it('explains WHY it matters — a parse error hides every other error', () => {
    const refusal = delimiterRefusal('lib.rs', OK_RUST, 'fn a() {\n')!;
    expect(refusal).toMatch(/hides every other error/i);
  });

  it('allows a write that FIXES an already-broken file', () => {
    expect(delimiterRefusal('lib.rs', 'fn a() {\n', OK_RUST)).toBeNull();
  });

  it('does not ratchet an already-broken file shut', () => {
    // Still broken after the edit, but it was broken before: refusing here
    // would make a damaged file uneditable, which is how a guard becomes a trap.
    expect(delimiterRefusal('lib.rs', 'fn a() {\n', 'fn a() {\n  let x = 1;\n')).toBeNull();
  });

  it('allows a balanced write', () => {
    expect(delimiterRefusal('lib.rs', OK_RUST, `${OK_RUST}fn b() {}\n`)).toBeNull();
  });

  it('honours the escape hatch', () => {
    process.env.UAP_DELIVER_ALLOW_UNBALANCED = '1';
    expect(delimiterRefusal('lib.rs', OK_RUST, 'fn a() {\n')).toBeNull();
  });

  it('is inert for unchecked file types', () => {
    expect(delimiterRefusal('setup.sql', 'select 1;', 'select ((( 1;')).toBeNull();
  });
});

describe('the real file that motivated this', () => {
  it('would have refused the write that produced "unexpected closing `}`"', () => {
    // Shape taken from the live failure: a block was removed but its closing
    // brace was left behind, so the file gained a stray `}` at the end.
    const before = 'mod m {\n  fn a() {\n    let x = 1;\n  }\n}\n';
    const after = 'mod m {\n  fn a() {\n    let x = 1;\n  }\n}\n}\n';
    const refusal = delimiterRefusal('lib.rs', before, after);
    expect(refusal).toBeTruthy();
    expect(refusal).toContain('unexpected closing');
  });

  it('scans a large file fast enough to run on every write', () => {
    const big = 'fn a() {\n  let x = (1 + 2);\n}\n'.repeat(4000); // ~120 KB
    const t0 = Date.now();
    expect(delimiterImbalance(big, 'lib.rs')).toBeNull();
    expect(Date.now() - t0, 'must be cheap enough to gate every write').toBeLessThan(250);
  });
});
