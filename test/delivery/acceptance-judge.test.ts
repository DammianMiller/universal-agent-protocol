import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  runAcceptanceGate,
  gatherEvidence,
  extractJsonObject,
  createAcceptanceChurnBreaker,
  formatAcceptanceReport,
} from '../../src/delivery/acceptance-judge.js';

const SPEC = 'Build a counter: increment() returns count+1, and reset() sets it to 0.';

describe('extractJsonObject', () => {
  it('extracts a balanced JSON object with nested arrays, tolerating prose/fences', () => {
    const text = 'Here is my verdict:\n```json\n{"criteria":[{"requirement":"a","met":true,"reason":"x"}],"pass":true}\n```\nthanks';
    const o = extractJsonObject(text);
    expect(o).not.toBeNull();
    expect((o!.criteria as unknown[]).length).toBe(1);
    expect(o!.pass).toBe(true);
  });

  it('returns null when there is no JSON object', () => {
    expect(extractJsonObject('no json here')).toBeNull();
  });

  it('handles braces inside strings without truncating early', () => {
    const o = extractJsonObject('{"reason":"uses {x} token","pass":false}');
    expect(o!.reason).toBe('uses {x} token');
    expect(o!.pass).toBe(false);
  });
});

describe('gatherEvidence', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'acc-ev-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('collects source files with path headers and skips node_modules', () => {
    mkdirSync(join(dir, 'js'), { recursive: true });
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(dir, 'js/counter.js'), 'module.exports = { increment: () => 1 };');
    writeFileSync(join(dir, 'node_modules/pkg/index.js'), 'SHOULD_NOT_APPEAR');
    const ev = gatherEvidence(dir);
    expect(ev).toContain('js/counter.js');
    expect(ev).toContain('increment');
    expect(ev).not.toContain('SHOULD_NOT_APPEAR');
  });
});

describe('runAcceptanceGate', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'acc-'));
    writeFileSync(join(dir, 'counter.js'), 'exports.increment = (n) => n + 1; exports.reset = () => 0;');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('passes when the judge marks every criterion met', async () => {
    const executor = async () =>
      '{"criteria":[{"requirement":"increment returns count+1","met":true,"reason":"present"},{"requirement":"reset sets 0","met":true,"reason":"present"}],"pass":true}';
    const r = await runAcceptanceGate({ spec: SPEC, projectRoot: dir, executor });
    expect(r.passed).toBe(true);
    expect(r.score).toBe(1);
    expect(r.criteria).toHaveLength(2);
  });

  it('fails when any criterion is unmet (even if the model claims pass)', async () => {
    const executor = async () =>
      '{"criteria":[{"requirement":"increment","met":true,"reason":"ok"},{"requirement":"reset","met":false,"reason":"missing"}],"pass":true}';
    const r = await runAcceptanceGate({ spec: SPEC, projectRoot: dir, executor });
    expect(r.passed).toBe(false);
    expect(r.score).toBe(0.5);
    expect(formatAcceptanceReport(r)).toMatch(/MISS/);
  });

  it('fails OPEN (passed) on an unparseable verdict — never wedges on judge nondeterminism', async () => {
    const executor = async () => 'I think it looks pretty good overall!';
    const r = await runAcceptanceGate({ spec: SPEC, projectRoot: dir, executor });
    expect(r.passed).toBe(true);
    expect(r.parseError).toBeTruthy();
  });

  it('fails OPEN when the executor throws', async () => {
    const executor = async () => {
      throw new Error('model down');
    };
    const r = await runAcceptanceGate({ spec: SPEC, projectRoot: dir, executor });
    expect(r.passed).toBe(true);
    expect(r.parseError).toMatch(/executor error/);
  });

  it('passes (no-op) when there is no source evidence', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'acc-empty-'));
    const executor = async () => '{}';
    const r = await runAcceptanceGate({ spec: SPEC, projectRoot: empty, executor });
    expect(r.passed).toBe(true);
    expect(r.parseError).toMatch(/no source evidence/);
    rmSync(empty, { recursive: true, force: true });
  });
});

describe('createAcceptanceChurnBreaker', () => {
  const reject = { passed: false, feedback: 'unverifiable gap' };
  const accept = { passed: true, feedback: '' };

  it('lets the judge reject up to limit-1 times, then hands the verdict to the gates', () => {
    const b = createAcceptanceChurnBreaker(2);
    expect(b.check('spec', reject).passed).toBe(false); // flip 1: judge stands
    const second = b.check('spec', reject); // flip 2: breaker fires
    expect(second.passed).toBe(true);
    expect(second.overridden).toBe(true);
    expect(second.feedback).toContain('advisory');
  });

  it('a passing verdict resets the consecutive-flip counter', () => {
    const b = createAcceptanceChurnBreaker(2);
    expect(b.check('spec', reject).passed).toBe(false);
    expect(b.check('spec', accept).passed).toBe(true);
    expect(b.check('spec', reject).passed).toBe(false); // counter restarted
  });

  it('a spec change (new phase/epic) resets the counter', () => {
    const b = createAcceptanceChurnBreaker(2);
    expect(b.check('epic-1', reject).passed).toBe(false);
    expect(b.check('epic-2', reject).passed).toBe(false); // fresh spec, flip 1
    expect(b.check('epic-2', reject).overridden).toBe(true);
  });

  it('clamps a nonsensical limit to at least 1', () => {
    const b = createAcceptanceChurnBreaker(0);
    expect(b.check('spec', reject).overridden).toBe(true); // fires immediately
  });

  it('zero-diff guard: never overrides the judge without change evidence', () => {
    let writes = 0;
    const b = createAcceptanceChurnBreaker(2, () => writes > 0);
    // No files changed: the breaker can never fire, however many rejections.
    for (let i = 0; i < 5; i++) {
      const v = b.check('spec', reject);
      expect(v.passed).toBe(false);
      expect(v.overridden).toBeUndefined();
    }
    // Once the spec's turns produced real changes, the bound applies again.
    writes = 3;
    expect(b.check('spec', reject).overridden).toBe(true);
  });
});

describe('gatherEvidence — priority ordering (data files cannot starve source)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-evidence-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('includes package.json and src even when huge data files walk first', () => {
    // "data" sorts before "package.json"/"src" in the walk; three 26KB files
    // used to consume the whole 60K budget so the judge never saw the code.
    mkdirSync(join(dir, 'data'));
    mkdirSync(join(dir, 'src'));
    for (const n of ['a', 'b', 'c']) writeFileSync(join(dir, 'data', `legacy-${n}.txt`), 'x'.repeat(26_000));
    writeFileSync(join(dir, 'package.json'), '{"name":"demo","scripts":{"test":"node --test"}}');
    writeFileSync(join(dir, 'src', 'slug.js'), 'export function slugify(t) { return t; }');
    const ev = gatherEvidence(dir);
    expect(ev).toContain('=== package.json ===');
    expect(ev).toContain('=== src/slug.js ===');
    expect(ev).toContain('export function slugify');
    // data files are present but head-only (≤ ~1.5K each), never 20K slabs
    const dataSlab = ev.split('=== data/legacy-a.txt ===')[1]?.split('===')[0] ?? '';
    expect(dataSlab.length).toBeLessThan(2_000);
  });

  it('spec-referenced paths reach evidence even when the candidate pool saturates first', () => {
    // Repo-scale failure (2026-07-11 live): candidateCap = maxFiles*10 fills
    // during the alphabetical walk long before late-alphabet dirs, so a
    // mission delivering into web/dash/ was judged "no such file" with every
    // file on disk. Saturate the pool with early-alphabet dirs, then assert a
    // spec that names web/dash/styles.css still gets it into evidence.
    for (const d of ['aaa', 'bbb', 'ccc']) {
      mkdirSync(join(dir, d));
      for (let i = 0; i < 40; i++) writeFileSync(join(dir, d, `f${String(i).padStart(2, '0')}.js`), `// ${d}/${i}\n`);
    }
    mkdirSync(join(dir, 'web', 'dash'), { recursive: true });
    writeFileSync(join(dir, 'web', 'dash', 'styles.css'), '.tabbar { display: flex; }');
    writeFileSync(join(dir, 'web', 'dash', 'tab-overview.js'), "UAP.registerTab('overview', {});");

    const maxFiles = 10; // candidateCap 100 < 120 early-alphabet files → pool saturates
    const without = gatherEvidence(dir, maxFiles);
    expect(without).not.toContain('web/dash/styles.css');

    const spec = 'Create web/dash/styles.css with the tab bar styles, and stub tabs under web/dash/.';
    const withSpec = gatherEvidence(dir, maxFiles, undefined, spec);
    expect(withSpec).toContain('=== web/dash/styles.css ===');
    expect(withSpec).toContain('.tabbar');
    // The spec-named DIRECTORY was walked too, so its other files made the pool.
    expect(withSpec).toContain('web/dash/tab-overview.js');
  });

  it('a directory of many data files cannot exhaust the file-count cap before source is walked', () => {
    mkdirSync(join(dir, 'assets'));
    mkdirSync(join(dir, 'src'));
    for (let i = 0; i < 60; i++) writeFileSync(join(dir, 'assets', `note-${String(i).padStart(2, '0')}.txt`), `note ${i}`);
    writeFileSync(join(dir, 'src', 'main.js'), 'export const main = 1;');
    const ev = gatherEvidence(dir, 40);
    expect(ev).toContain('=== src/main.js ===');
  });
});
