/**
 * Tests for the rtk-wrap policy enforcer's package-manager handling.
 * `rtk npm` maps to `npm run`, so npm/pnpm/yarn *builtins* (view, install,
 * publish, …) must be routed via `rtk proxy`, not `rtk npm` (which would mangle
 * `npm view` -> `npm run view`). Script runners (run/test) stay on `rtk npm`.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { join } from 'path';

// The SOURCE enforcer — see iac-parity.test.ts for why the materialised copy
// under `.policy-tools/` is the wrong thing to point a test at.
const ENF = join(__dirname, '../src/policies/enforcers/rtk_wrap.py');

// The enforcer exits 2 on a block (valid JSON still on stdout), so use
// spawnSync which does not throw on a non-zero exit.
function reason(cmd: string): string {
  const r = spawnSync(
    'python3',
    [ENF, '--operation', 'Bash', '--args', JSON.stringify({ command: cmd })],
    { encoding: 'utf-8' }
  );
  return (JSON.parse(r.stdout || '{}').reason as string) || '';
}

describe('rtk-wrap enforcer: package-manager builtins', () => {
  it('routes npm builtins through rtk proxy (no `npm run` mangling)', () => {
    expect(reason('npm view pkg version')).toContain('Use: rtk proxy npm view');
    expect(reason('npm install lodash')).toContain('Use: rtk proxy npm install');
    expect(reason('npm publish')).toContain('Use: rtk proxy npm publish');
    expect(reason('pnpm add left-pad')).toContain('Use: rtk proxy pnpm add');
  });

  it('keeps script runners on rtk <pm> (run/test)', () => {
    expect(reason('npm run build')).toContain('Use: rtk npm run build');
    expect(reason('npm test')).toContain('Use: rtk npm test');
  });

  it('leaves non-package-manager wrapped CLIs unchanged', () => {
    expect(reason('git status')).toContain('Use: rtk git status');
  });
});
