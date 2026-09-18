import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { tokenize, stem, TfIdfIndex } from '../src/evals/tfidf.js';
import {
  loadRoutingCorpus,
  parseFrontmatter,
  bodyFallback,
  type RoutingEntry,
} from '../src/evals/routing-corpus.js';
import {
  runRoutingEval,
  loadEvalCases,
  formatReport,
  DEFAULT_THRESHOLD,
} from '../src/evals/routing-eval.js';

const PROJECT_ROOT = join(__dirname, '..');

describe('tfidf', () => {
  it('tokenizes with stemming and stopword removal', () => {
    expect(tokenize('The interfaces are tweaking the Modules into place')).toEqual([
      'interface', 'tweak', 'module', 'place',
    ]);
  });

  it('stems plurals and -ing forms but leaves short tokens alone', () => {
    expect(stem('interfaces')).toBe('interface');
    expect(stem('tweaking')).toBe('tweak');
    expect(stem('git')).toBe('git');
    expect(stem('class')).toBe('class'); // no 'ss' mangling
  });

  it('ranks the semantically closest document first', () => {
    const index = new TfIdfIndex([
      'git reflog recovery lost commits',
      'chess engine stockfish best move',
      'compress archives zip format',
    ]);
    const { index: top, score } = index.topIndex('recover lost git commits');
    expect(top).toBe(0);
    expect(score).toBeGreaterThan(0);
  });

  it('returns zero similarity for a fully disjoint query', () => {
    const index = new TfIdfIndex(['git reflog recovery']);
    const { index: top, score } = index.topIndex('xylophone quasar');
    expect(top).toBe(-1);
    expect(score).toBe(0);
  });
});

describe('routing corpus', () => {
  it('parses frontmatter name and description', () => {
    const fm = parseFrontmatter('---\nname: foo\ndescription: does bar things\n---\n# Body');
    expect(fm).toEqual({ name: 'foo', description: 'does bar things' });
  });

  it('falls back to the first substantive body paragraph', () => {
    const body = '---\nname: foo\n---\n\n# Title\n\n> quote\n\nThis is the first real paragraph of the body.';
    expect(bodyFallback(body)).toBe('This is the first real paragraph of the body.');
  });

  it('loads patterns, droids, and skills from the project corpus', () => {
    const corpus = loadRoutingCorpus(PROJECT_ROOT);
    const patterns = corpus.filter((e) => e.kind === 'pattern');
    const droids = corpus.filter((e) => e.kind === 'droid');
    const skills = corpus.filter((e) => e.kind === 'skill');
    expect(patterns.length).toBeGreaterThanOrEqual(24);
    expect(droids.length).toBeGreaterThanOrEqual(30);
    expect(skills.length).toBeGreaterThanOrEqual(25);
    // Unique keys across the whole corpus.
    expect(new Set(corpus.map((e) => e.key)).size).toBe(corpus.length);
    // Every entry embeds some text.
    for (const entry of corpus) expect(entry.text.length).toBeGreaterThan(5);
  });
});

describe('routing eval runner', () => {
  const corpus: RoutingEntry[] = [
    { key: 'pattern:1', kind: 'pattern', id: '1', name: 'Alpha', text: 'alpha beta gamma', hasDescription: true, source: 't' },
    { key: 'pattern:2', kind: 'pattern', id: '2', name: 'Beta', text: 'delta epsilon zeta', hasDescription: true, source: 't' },
  ];

  it('passes when fixtures route correctly', () => {
    const report = runRoutingEval(PROJECT_ROOT, {
      corpus,
      cases: [
        { kind: 'pattern', query: 'alpha beta', expect: '1' },
        { kind: 'pattern', query: 'delta epsilon', expect: '2' },
        { kind: 'pattern', query: 'xyzzy nothing matches this', expect: null },
      ],
    });
    expect(report.meetsThreshold).toBe(true);
    expect(report.rank1Accuracy).toBe(1);
    expect(report.failed).toBe(0);
  });

  it('fails below threshold when fixtures route incorrectly', () => {
    const report = runRoutingEval(PROJECT_ROOT, {
      corpus,
      threshold: 0.9,
      cases: [
        { kind: 'pattern', query: 'alpha beta', expect: '2' }, // wrong on purpose
        { kind: 'pattern', query: 'delta epsilon', expect: '2' },
      ],
    });
    expect(report.rank1Accuracy).toBe(0.5);
    expect(report.meetsThreshold).toBe(false);
    expect(report.failures).toHaveLength(1);
    expect(formatReport(report)).toContain('FAIL');
  });

  it('hard-fails when a negative case false-routes, even above threshold', () => {
    const report = runRoutingEval(PROJECT_ROOT, {
      corpus,
      threshold: 0.5,
      negativeMaxScore: 0.01,
      cases: [
        { kind: 'pattern', query: 'alpha beta', expect: '1' },
        { kind: 'pattern', query: 'delta epsilon zeta', expect: null }, // will match
      ],
    });
    expect(report.rank1Accuracy).toBe(1);
    expect(report.negativePassed).toBe(0);
    expect(report.meetsThreshold).toBe(false);
  });

  it('rejects fixtures that reference unknown corpus entries', () => {
    expect(() =>
      runRoutingEval(PROJECT_ROOT, {
        corpus,
        cases: [{ kind: 'pattern', query: 'alpha beta', expect: '99' }],
      }),
    ).toThrow(/fixture integrity/);
  });

  it('rejects malformed case files', () => {
    expect(() => loadEvalCases(join(PROJECT_ROOT, 'evals/routing/does-not-exist.json'))).toThrow(
      /not found/,
    );
  });
});

describe('shipped corpus eval (CI gate)', () => {
  it('every fixture expectation resolves to a real corpus entry', () => {
    const cases = loadEvalCases(join(PROJECT_ROOT, 'evals/routing/cases.json'));
    const corpus = loadRoutingCorpus(PROJECT_ROOT);
    for (const kase of cases) {
      if (kase.expect === null) continue;
      const found = corpus.some((e) => e.kind === kase.kind && e.id === kase.expect);
      expect(found, `${kase.kind}:${kase.expect} referenced by "${kase.query.slice(0, 50)}"`).toBe(true);
    }
  });

  it('fixtures include enough positives, planted traps, and negatives', () => {
    const cases = loadEvalCases(join(PROJECT_ROOT, 'evals/routing/cases.json'));
    // A shrunken positive set would make the accuracy gate vacuous.
    expect(cases.filter((c) => c.expect !== null).length).toBeGreaterThanOrEqual(80);
    expect(cases.filter((c) => c.trap).length).toBeGreaterThanOrEqual(8);
    expect(cases.filter((c) => c.expect === null).length).toBeGreaterThanOrEqual(3);
  });

  it('refuses to pass with zero positive cases', () => {
    const corpus: RoutingEntry[] = [
      { key: 'pattern:1', kind: 'pattern', id: '1', name: 'Alpha', text: 'alpha beta', hasDescription: true, source: 't' },
    ];
    expect(() =>
      runRoutingEval(PROJECT_ROOT, {
        corpus,
        cases: [{ kind: 'pattern', query: 'nothing whatsoever', expect: null }],
      }),
    ).toThrow(/vacuously/);
  });

  it(`rank-1 accuracy stays at or above ${DEFAULT_THRESHOLD * 100}% on the shipped corpus`, () => {
    const report = runRoutingEval(PROJECT_ROOT, {});
    if (!report.meetsThreshold) {
      console.error(formatReport(report));
    }
    expect(report.meetsThreshold).toBe(true);
  });
});
