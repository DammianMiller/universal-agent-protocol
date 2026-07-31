/**
 * `.uap/deliver.heartbeat` has readers in two languages. They must agree.
 *
 * They did not. `deliver_autoroute.py` defaulted its wedge threshold to 600s
 * while `heartbeat.ts` used 1800s — the same env var, the same file, opposite
 * conclusions for any heartbeat aged 600-1800s: the hook treating the holder as
 * dead (and so eligible for a duplicate autoroute spawn) at the very moment the
 * TypeScript lock path still deferred to it as live.
 *
 * That is the divergent-readers bug heartbeat.ts was created to stop, and it
 * does not stop at the language boundary. A comment asking the two to stay in
 * step is not a mechanism; this is. The Python suite is not run by `npm test`
 * (package.json runs vitest), so the assertion lives here, where it gates.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DEFAULT_WEDGE_TIMEOUT_S } from '../../src/delivery/heartbeat.js';

const HOOK = join(process.cwd(), '.claude', 'hooks', 'deliver_autoroute.py');

describe('heartbeat wedge threshold: cross-language parity', () => {
  it('deliver_autoroute.py defaults to the same wedge timeout as heartbeat.ts', () => {
    const src = readFileSync(HOOK, 'utf8');
    // The default is the trailing `return <n>` of _deliver_wedge_timeout().
    const fn = src.slice(src.indexOf('def _deliver_wedge_timeout'));
    const body = fn.slice(0, fn.indexOf('\ndef ', 1));
    const returns = [...body.matchAll(/^\s*return\s+(\d+)\s*$/gm)].map((m) => Number(m[1]));
    expect(returns.length, 'expected a literal default return in _deliver_wedge_timeout').toBe(1);
    expect(returns[0]).toBe(DEFAULT_WEDGE_TIMEOUT_S);
  });

  it('both readers key off the same environment variable', () => {
    const src = readFileSync(HOOK, 'utf8');
    expect(src).toContain('UAP_DELIVER_WEDGE_TIMEOUT');
    const ts = readFileSync(
      join(process.cwd(), 'src', 'delivery', 'heartbeat.ts'),
      'utf8'
    );
    expect(ts).toContain('UAP_DELIVER_WEDGE_TIMEOUT');
  });
});
