/**
 * Nothing watched a file grow by repetition.
 *
 * The write guards all watch a file get SMALLER — anti-gutting (bytes),
 * stub-substance (empty bodies), byte-identical NO-OP. The damage measured on
 * 2026-08-11 went the other way: setup.sql in cognition-engine ended the day
 * holding 65 copies of `CREATE FUNCTION cognition.join_by_i_sql`, 63 of
 * `join_by_i_time_sql` and 40+ each of six more objects — 246 KB / 8,025 lines
 * grown to 361 KB / 11,785, with 8,604 duplicate non-comment lines.
 *
 * And every cheap check read as SUCCESS: the six lateral joins the mission
 * targeted really were gone. A client relaunching the same "add X" mission
 * dozens of times, against a file the agent could see 3% of, re-added X every
 * time.
 *
 * The rule keys on the whole definition HEADER rather than the name, because
 * overloading is legal — Postgres `f(int)` beside `f(text)` — and an overload
 * has a different header while an appended copy has an identical one.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  duplicateDefinitionRefusal,
  topLevelDefinitionHeaders,
} from '../../src/delivery/agentic-executor.js';

const FN = (body = 'SELECT 1;') =>
  `CREATE OR REPLACE FUNCTION cognition.join_by_i_sql(a int)\nRETURNS int AS $$\n${body}\n$$ LANGUAGE plpgsql;`;

afterEach(() => {
  delete process.env.UAP_DELIVER_ALLOW_DUPLICATE_DEFS;
});

describe('duplicateDefinitionRefusal', () => {
  it('refuses the write that made 65 copies of one function', () => {
    const before = `-- schema\n${FN()}\n`;
    const after = `${before}\n${FN()}\n`;
    const refusal = duplicateDefinitionRefusal('setup.sql', before, after);
    expect(refusal).toBeTruthy();
    expect(refusal).toContain('join_by_i_sql');
    expect(refusal, 'must name the existing copy so the model can edit it').toMatch(/line \d+/);
    expect(refusal).toContain('edit_file');
  });

  it('allows ADDING a definition the file does not have', () => {
    const before = '-- schema\n';
    expect(duplicateDefinitionRefusal('setup.sql', before, before + FN())).toBeNull();
  });

  it('allows EDITING an existing definition in place', () => {
    const before = FN('SELECT 1;');
    const after = FN('SELECT 2;');
    expect(duplicateDefinitionRefusal('setup.sql', before, after)).toBeNull();
  });

  it('allows a real SQL overload — different signature, different header', () => {
    // Postgres overloading is legal and common. Keying on the NAME would refuse
    // this; keying on the header does not.
    const before = 'CREATE FUNCTION f(a int) RETURNS int AS $$ SELECT 1 $$;\n';
    const after = before + 'CREATE FUNCTION f(a text) RETURNS int AS $$ SELECT 2 $$;\n';
    expect(duplicateDefinitionRefusal('schema.sql', before, after)).toBeNull();
  });

  it('does not fire on a file that already repeated a header before this write', () => {
    // The guard stops it getting WORSE; it does not refuse every future write to
    // an already-damaged file, which would ratchet the file permanently shut.
    const before = `${FN()}\n${FN()}\n`;
    const after = `${before}-- a comment\n`;
    expect(duplicateDefinitionRefusal('setup.sql', before, after)).toBeNull();
  });

  it('names only the FIRST duplicate, not a wall of sixty', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      `CREATE FUNCTION f_${i}(a int) RETURNS int AS $$ SELECT ${i} $$;`
    ).join('\n');
    const refusal = duplicateDefinitionRefusal('s.sql', many, `${many}\n${many}`);
    expect(refusal).toBeTruthy();
    expect(refusal!.split('CREATE FUNCTION').length - 1, 'one header, not twenty').toBe(1);
  });

  it('honours the escape hatch', () => {
    process.env.UAP_DELIVER_ALLOW_DUPLICATE_DEFS = '1';
    const before = FN();
    expect(duplicateDefinitionRefusal('setup.sql', before, `${before}\n${FN()}`)).toBeNull();
  });

  it('is inert for a language it does not know', () => {
    const before = 'alpha\n';
    expect(duplicateDefinitionRefusal('notes.txt', before, before + before)).toBeNull();
  });
});

describe('topLevelDefinitionHeaders', () => {
  it('ignores INDENTED definitions — two classes may both define run()', () => {
    const py = 'class A:\n    def run(self):\n        pass\n\nclass B:\n    def run(self):\n        pass\n';
    const heads = topLevelDefinitionHeaders(py, 'x.py');
    expect([...heads.keys()].some((k) => k.startsWith('def run'))).toBe(false);
    expect(heads.get('class A:')).toBe(1);
    expect(heads.get('class B:')).toBe(1);
  });

  it('does not count a definition inside a comment', () => {
    const sql = '-- CREATE FUNCTION f() RETURNS int\nCREATE FUNCTION f() RETURNS int AS $$ SELECT 1 $$;\n';
    expect([...topLevelDefinitionHeaders(sql, 's.sql').values()].reduce((a, b) => a + b, 0)).toBe(1);
  });

  it('treats reformatting as the same header, not a new one', () => {
    const a = topLevelDefinitionHeaders('export function go(x: number) {', 'a.ts');
    const b = topLevelDefinitionHeaders('export   function   go(x: number)', 'a.ts');
    expect([...a.keys()][0]).toBe([...b.keys()][0]);
  });

  it('recognises the languages this repo actually delivers', () => {
    expect(topLevelDefinitionHeaders('export class Foo {', 'a.ts').size).toBe(1);
    expect(topLevelDefinitionHeaders('export const go = async () => {', 'a.ts').size).toBe(1);
    expect(topLevelDefinitionHeaders('pub async fn run(x: u8) {', 'a.rs').size).toBe(1);
    expect(topLevelDefinitionHeaders('def run(x):', 'a.py').size).toBe(1);
    expect(topLevelDefinitionHeaders('func Run(x int) {', 'a.go').size).toBe(1);
    expect(topLevelDefinitionHeaders('CREATE MATERIALIZED VIEW v AS SELECT 1;', 'a.sql').size).toBe(1);
  });

  it('tells WRAPPED overloads apart — found by scanning this repo', () => {
    // src/benchmarks/model-integration.ts declares runModelBenchmark three
    // times (a legitimate TypeScript overload set) and two of them start with
    // the identical line, because the parameters wrap. Keying on that first
    // line alone called a real overload a duplicate. The parameters are what
    // distinguishes overloads, so the key has to reach them.
    const overloads =
      'export async function runModelBenchmark(\n  apiKey?: string,\n  modelIds?: string[]\n): Promise<R>;\n' +
      'export async function runModelBenchmark(\n  options: BenchmarkOptions\n): Promise<R> {\n  return go();\n}\n';
    const heads = topLevelDefinitionHeaders(overloads, 'benchmarks.ts');
    expect([...heads.values()].every((n) => n === 1), [...heads.keys()].join(' || ')).toBe(true);
    expect(duplicateDefinitionRefusal('benchmarks.ts', overloads.split('export async function runModelBenchmark(\n  options')[0], overloads)).toBeNull();
  });

  it('still catches an appended copy whose signature also wraps', () => {
    const fn = 'export function go(\n  a: number,\n  b: string\n): void {\n  return;\n}\n';
    expect(duplicateDefinitionRefusal('a.ts', fn, fn + fn)).toBeTruthy();
  });

  it('gives up on a signature that never closes instead of swallowing the file', () => {
    // A malformed signature must not eat everything after it. Unbounded
    // gathering would absorb the REAL definition below into the broken key,
    // and that definition would then be invisible to the guard forever.
    const broken =
      'export function oops(\n' + 'x,\n'.repeat(100) + 'export function real(a: number) {\n  return a;\n}\n';
    const heads = topLevelDefinitionHeaders(broken, 'a.ts');
    const brokenKey = [...heads.keys()].find((k) => k.startsWith('export function oops'))!;
    expect(brokenKey).toBeTruthy();
    // The decisive assertion: gathering must STOP, so the unclosed signature
    // does not absorb the real definition a hundred lines below it into its
    // key. (The outer scan finds that definition either way, which is why a
    // "is `real` present" check cannot tell bounded from unbounded.)
    expect(brokenKey).not.toContain('export function real');
    expect(brokenKey.split(' ').length).toBeLessThan(60);
  });

  it('does not mistake a call or an import for a definition', () => {
    expect(topLevelDefinitionHeaders('const x = go(1);\nimport { go } from "./go.js";\n', 'a.ts').size).toBe(0);
  });
});
