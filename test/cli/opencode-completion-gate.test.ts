import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { installOpencodeHooks } from '../../src/cli/hooks.js';

describe('opencode plugin — completion gate (hard-block false "done")', () => {
  let dir: string;
  let plugin: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'uap-oc-gate-'));
    await installOpencodeHooks(dir);
    plugin = readFileSync(join(dir, '.opencode', 'plugin', 'uap-session-hooks.ts'), 'utf8');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('gates the todowrite completion signal', () => {
    expect(plugin).toContain('COMPLETION GATE');
    expect(plugin).toMatch(/input\.tool === "todowrite"/);
    expect(plugin).toMatch(/every\(\(t\) => t && t\.status === "completed"\)/);
  });

  it('runs full validation (uap verify) and blocks only on a real gate failure (exit 1)', () => {
    expect(plugin).toMatch(/uap verify \$\{uvAuto\}/);
    expect(plugin).toMatch(/res2\.exitCode === 1/);
    expect(plugin).toContain('[UAP not done]');
  });

  it('fails OPEN on infra/tooling errors (never wedges) and is opt-out-able', () => {
    // only re-throws the "[UAP not done]" marker; other errors are swallowed
    expect(plugin).toMatch(/message\.indexOf\("\[UAP not done\]"\) === 0\) throw e/);
    expect(plugin).toMatch(/UAP_VERIFY_ON_STOP !== "0"/);
  });

  it('only gates when code actually changed', () => {
    expect(plugin).toMatch(/git diff --name-only HEAD/);
    expect(plugin).toMatch(/\\\.\(ts\|tsx\|js/);
  });
});
