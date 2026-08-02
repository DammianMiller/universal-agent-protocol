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
const HOOK_TEMPLATE = join(process.cwd(), 'templates', 'hooks', 'deliver_autoroute.py');

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

describe('heartbeat wedge threshold: the TEMPLATE must not re-introduce the bug', () => {
  /**
   * The installed hook and the template it is installed FROM are two files, and
   * fixing one fixed only one. The 1800 correction landed in .claude/hooks on
   * 2026-07-31 but never reached templates/hooks, so `uap worktree create`
   * rewrote the fixed hook back to `return 600` in every new worktree — the
   * shipped fix reverted itself on contact. Found because the parity test above
   * reads process.cwd(), so it passed on master and failed in the worktree.
   */
  it('templates/hooks/deliver_autoroute.py carries the same default', () => {
    const src = readFileSync(HOOK_TEMPLATE, 'utf8');
    const fn = src.slice(src.indexOf('def _deliver_wedge_timeout'));
    const body = fn.slice(0, fn.indexOf('\ndef ', 1));
    const returns = [...body.matchAll(/^\s*return\s+(\d+)\s*$/gm)].map((m) => Number(m[1]));
    expect(returns.length, 'expected a literal default return in the template').toBe(1);
    expect(returns[0]).toBe(DEFAULT_WEDGE_TIMEOUT_S);
  });

  it('the template and the installed hook agree byte-for-byte on that function', () => {
    const grab = (p: string) => {
      const s = readFileSync(p, 'utf8');
      const i = s.indexOf('def _deliver_wedge_timeout');
      return s.slice(i, s.indexOf('\ndef ', i + 1));
    };
    expect(grab(HOOK_TEMPLATE)).toBe(grab(HOOK));
  });
});
