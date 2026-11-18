/**
 * P39 fixed-form critic tests — the fresh critic's output contract (0.3):
 * verdict yes/no, at most five ranked faults, one line each, blocking-or-minor.
 * Parsing is fail-soft (advisory above the deterministic tier gate).
 */
import { describe, it, expect } from 'vitest';
import {
  CRITIC_FORM_SECTION,
  CRITIC_MAX_FAULTS,
  formatCriticReport,
  parseCriticReport,
} from '../../src/delivery/critic-form.js';

describe('CRITIC_FORM_SECTION', () => {
  it('states the fixed form: verdict, ranked faults, severity marks', () => {
    expect(CRITIC_FORM_SECTION).toContain('"verdict":"yes|no"');
    expect(CRITIC_FORM_SECTION).toContain('"severity":"blocking|minor"');
    expect(CRITIC_FORM_SECTION).toContain('rank 1 = the single biggest gap');
  });
});

describe('parseCriticReport', () => {
  it('parses a clean yes verdict with no faults', () => {
    const r = parseCriticReport({ critic: { verdict: 'yes', faults: [] } });
    expect(r).toEqual({ verdict: 'yes', faults: [] });
  });

  it('parses ranked faults in the fixed form', () => {
    const r = parseCriticReport({
      critic: {
        verdict: 'no',
        faults: [
          { rank: 1, note: 'darkFrac 0.24 vs tier 0.07 — lift hemisphere fill', severity: 'blocking' },
          { rank: 2, note: 'palette is 662 colors vs 744 — widen tone ramps', severity: 'minor' },
        ],
      },
    });
    expect(r?.verdict).toBe('no');
    expect(r?.faults).toHaveLength(2);
    expect(r?.faults[0].severity).toBe('blocking');
  });

  it('drops faults that are not the fixed form instead of failing the report', () => {
    const r = parseCriticReport({
      critic: {
        verdict: 'no',
        faults: [
          { rank: 1, note: 'valid fault', severity: 'blocking' },
          { rank: 2, note: 'no severity mark' }, // not the form — dropped
          { rank: 3, note: '', severity: 'minor' }, // empty note — dropped
        ],
      },
    });
    expect(r?.faults).toHaveLength(1);
    expect(r?.faults[0].note).toBe('valid fault');
  });

  it('caps at five faults and defaults a missing rank to position', () => {
    const r = parseCriticReport({
      critic: {
        verdict: 'no',
        faults: [
          { note: 'f1', severity: 'minor' }, // no rank → position 1
          ...Array.from({ length: 6 }, (_, i) => ({ rank: i + 2, note: `f${i + 2}`, severity: 'minor' as const })),
        ],
      },
    });
    expect(r?.faults).toHaveLength(CRITIC_MAX_FAULTS);
    expect(r?.faults[0].rank).toBe(1);
  });

  it('returns null for anything that is not the fixed form (advisory, never blocking)', () => {
    expect(parseCriticReport(null)).toBeNull();
    expect(parseCriticReport({})).toBeNull();
    expect(parseCriticReport({ critic: { verdict: 'maybe' } })).toBeNull();
    expect(parseCriticReport({ critic: 'not an object' })).toBeNull();
  });
});

describe('formatCriticReport', () => {
  it('renders rank 1 first with the severity mark', () => {
    const s = formatCriticReport({
      verdict: 'no',
      faults: [
        { rank: 2, note: 'second', severity: 'minor' },
        { rank: 1, note: 'first', severity: 'blocking' },
      ],
    });
    expect(s).toContain('CRITIC ✗');
    expect(s.indexOf('1) first [blocking]')).toBeLessThan(s.indexOf('2) second [minor]'));
  });

  it('renders a clean yes verdict', () => {
    expect(formatCriticReport({ verdict: 'yes', faults: [] })).toContain('CRITIC ✓');
  });
});
