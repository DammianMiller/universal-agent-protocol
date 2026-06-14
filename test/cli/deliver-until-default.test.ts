import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { deliverCommand } from '../../src/cli/deliver.js';
import type { DeliverOptions } from '../../src/cli/deliver.js';

// Drives the deliver CLI in --dry-run --json and reads the plan's
// until-delivered fields to lock in the default-ON behavior + opt-outs.
describe('until-delivered default (CLI)', () => {
  let dir: string;
  const saved = process.env.UAP_DELIVER_UNTIL_DELIVERED;

  function project(): string {
    dir = mkdtempSync(join(tmpdir(), 'until-default-'));
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 't', version: '1.0.0', scripts: { test: 'node -e ""' } })
    );
    return dir;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    if (saved === undefined) delete process.env.UAP_DELIVER_UNTIL_DELIVERED;
    else process.env.UAP_DELIVER_UNTIL_DELIVERED = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  async function plan(extra: Partial<DeliverOptions> = {}): Promise<{ untilDelivered: boolean; ceiling: number | null }> {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((m?: unknown) => void logs.push(String(m)));
    await deliverCommand('do the thing', { dryRun: true, json: true, projectRoot: project(), ...extra });
    const parsed = JSON.parse(logs.join('\n'));
    return { untilDelivered: parsed.untilDelivered, ceiling: parsed.ceiling };
  }

  it('is ON by default with the default ceiling', async () => {
    const p = await plan();
    expect(p.untilDelivered).toBe(true);
    expect(p.ceiling).toBe(30);
  });

  it('is OFF when --no-until-delivered (options.untilDelivered === false)', async () => {
    const p = await plan({ untilDelivered: false });
    expect(p.untilDelivered).toBe(false);
    expect(p.ceiling).toBeNull();
  });

  it('is OFF when UAP_DELIVER_UNTIL_DELIVERED=0', async () => {
    process.env.UAP_DELIVER_UNTIL_DELIVERED = '0';
    expect((await plan()).untilDelivered).toBe(false);
  });

  it('honors an explicit --ceiling while default-on', async () => {
    expect((await plan({ ceiling: '12' })).ceiling).toBe(12);
  });
});
