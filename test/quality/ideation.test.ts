/**
 * ideation-outcome class tests — frontier-parity plan F: the extractor's
 * four axes, the degenerate guards (single candidate, no stance), the
 * registry entry, the anchor round-trip, the novelty ranking, and the
 * curated-ideas → measurable-Markdown render bridge.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  extractIdeationVector,
  rankIdeasByNovelty,
  sectionsOf,
} from '../../src/quality/ideation.js';
import { resolveClass, storeArtifactAnchor } from '../../src/quality/classes.js';
import { renderIdeasMarkdown } from '../../src/cli/ideate.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'uap-ideation-'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

/** Three candidates, distinct domains, committed language, sub-structure. */
const GOOD_DOC = `# Framing preamble — not a candidate

## Candidate 1: gradient routing

We choose gradient routing because it wins on long sessions.

- mechanism: per-file staleness counters
- failure mode: counter drift under concurrent writes

## Candidate 2: acoustic localization

This design must place the sensor array before calibration; it never
calibrates against a synthetic fixture.

- mechanism: time-difference-of-arrival
- surface: three-meter baseline triangle

## Candidate 3: lattice fermentation

The fermentation controller will commit to a fixed temperature schedule.

1. mechanism: thermal mass buffering
2. surface: stacked ceramic trays
`;

/** Three candidates, hedged to death — no stance anywhere. */
const HEDGED_DOC = `# Preamble

## Candidate 1: maybe routing

This might perhaps improve things; it could be somewhat viable.

## Candidate 2: possibly localization

It seems likely that sensors might help, potentially.

## Candidate 3: perhaps fermentation

Maybe this could arguably work in some contexts.
`;

/** Three candidates that all say the same thing with the same vocabulary. */
const CLUSTERED_DOC = `# Preamble

## Candidate 1: routing cache layer

The routing cache layer will improve the routing cache layer latency.

- routing cache layer mechanism
- routing cache layer surface

## Candidate 2: routing cache store

The routing cache store will improve the routing cache store latency.

- routing cache store mechanism
- routing cache store surface

## Candidate 3: routing cache index

The routing cache index will improve the routing cache index latency.

- routing cache index mechanism
- routing cache index surface
`;

function writeDoc(name: string, text: string): string {
  const p = join(tmp, name);
  writeFileSync(p, text, 'utf8');
  return p;
}

describe('extractIdeationVector (plan F axes)', () => {
  it('measures stance, composition, diversity and distance on a healthy set', () => {
    const v = extractIdeationVector(writeDoc('good.md', GOOD_DOC));
    expect(v).not.toBeNull();
    expect(v?.scalars.candidateCount).toBe(3);
    expect(v?.scalars.stanceShare).toBeGreaterThan(0.5);
    expect(v?.scalars.compositionDepth).toBeGreaterThanOrEqual(2);
    expect(v?.scalars.topicDiversity).toBeGreaterThan(0.3);
    // Distinct domains: every candidate's nearest neighbour is far.
    expect(v?.scalars.ideaDistance).toBeGreaterThan(0.8);
  });

  it('separates a clustered set from a distinct one (the hivemind guard)', () => {
    const clustered = extractIdeationVector(writeDoc('clustered.md', CLUSTERED_DOC));
    const distinct = extractIdeationVector(writeDoc('distinct.md', GOOD_DOC));
    expect(clustered?.scalars.ideaDistance ?? 1).toBeLessThan(
      distinct?.scalars.ideaDistance ?? 0,
    );
    expect(clustered?.scalars.ideaDistance).toBeLessThan(0.4);
  });

  it('counts no-stance documents as stanceShare 0', () => {
    const v = extractIdeationVector(writeDoc('hedged.md', HEDGED_DOC));
    expect(v?.scalars.stanceShare).toBe(0);
  });

  it('excludes the preamble from the candidate set', () => {
    const secs = sectionsOf(GOOD_DOC);
    expect(secs.length).toBe(3);
    // The preamble's vocabulary (framing) must not leak into candidates.
    const allWords = [...secs.flatMap((s) => [...s.sigWords])];
    expect(allWords).not.toContain('preamble');
  });

  it('returns null on an unreadable path', () => {
    expect(extractIdeationVector(join(tmp, 'nope.md'))).toBeNull();
  });
});

describe('ideation-outcome registry entry (plan F)', () => {
  const spec = resolveClass('ideation-outcome');

  it('registers the four axes with their fail directions', () => {
    expect(spec.cls).toBe('ideation-outcome');
    expect(spec.artifact).toMatch(/ideation document/);
    expect(Object.keys(spec.axes).sort()).toEqual([
      'compositionDepth',
      'ideaDistance',
      'stanceShare',
      'topicDiversity',
    ]);
    expect(spec.axes.stanceShare.direction).toBe('min');
    expect(spec.axes.ideaDistance.direction).toBe('min');
  });

  it('declares a warm sampling profile — exploration IS the outcome', () => {
    expect(spec.sampling?.temperature).toBeGreaterThanOrEqual(0.8);
  });

  it('guards degenerate evidence: fewer than two candidates', () => {
    const one = extractIdeationVector(
      writeDoc('one.md', '## Only candidate\n\nWe choose this and it wins.\n'),
    );
    expect(one?.scalars.candidateCount).toBe(1);
    expect(spec.degenerate?.(one!)).toMatch(/fewer than 2 candidates/);
  });

  it('guards degenerate evidence: a set of maybes carries no stance', () => {
    const hedged = extractIdeationVector(writeDoc('hedged2.md', HEDGED_DOC));
    expect(spec.degenerate?.(hedged!)).toMatch(/no candidate carries a stance/);
    const good = extractIdeationVector(writeDoc('good2.md', GOOD_DOC));
    expect(spec.degenerate?.(good!)).toBeNull();
  });

  it('anchors through the class-generic path', () => {
    const anchor = storeArtifactAnchor(tmp, 'ideation-outcome', writeDoc('anchor.md', GOOD_DOC));
    expect(anchor).not.toBeNull();
  });
});

describe('rankIdeasByNovelty + renderIdeasMarkdown (plan F CLI bridge)', () => {
  it('ranks the distinct idea first, deterministically', () => {
    const ideas = [
      'The routing cache layer will improve routing cache layer latency with routing cache layer mechanisms.',
      'The routing cache store will improve routing cache store latency with routing cache store surfaces.',
      'Acoustic sensor arrays must calibrate against fermented ceramic trays before the monsoon season.',
    ];
    const ranked = rankIdeasByNovelty(ideas);
    expect(ranked[0].index).toBe(2);
    expect(ranked[0].novelty).toBeGreaterThan(ranked[1].novelty);
    // Deterministic: same input, same order.
    expect(rankIdeasByNovelty(ideas).map((r) => r.index)).toEqual(
      ranked.map((r) => r.index),
    );
  });

  it('renders curated ideas into the measurable one-section-per-candidate artifact', () => {
    const ideas = [
      'We choose X.\n\n## inner heading that must not split the candidate',
      'This design must ship Y.',
    ];
    const md = renderIdeasMarkdown(ideas);
    expect(md).toContain('## Candidate 1');
    expect(md).toContain('## Candidate 2');
    // Inner headings demoted — a candidate stays ONE section.
    expect(md).not.toMatch(/^## inner/m);

    // Round trip: the extractor sees exactly the curated count.
    const p = writeDoc('rendered.md', md);
    const v = extractIdeationVector(p);
    expect(v?.scalars.candidateCount).toBe(2);
  });
});
