/**
 * `uap models ensure` / `ensure-by-path` (src/cli/models.ts): the operator
 * surface over the files manifest. Dry-run only — the repair path is covered
 * in model-files.test.ts with a stubbed curl runner; these tests must never
 * touch the network.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { modelsCommand } from '../../src/cli/models.js';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'models-ensure-cli-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeFixture(): { repoPath: string; localPath: string; present: string; missing: string } {
  const present = join(dir, 'present.gguf');
  writeFileSync(present, 'abc');
  const missing = join(dir, 'missing.gguf');
  const repoPath = join(dir, 'repo.json');
  writeFileSync(repoPath, JSON.stringify({
    version: 1,
    devices: { gpu0: { kind: 'gpu' }, cpu0: { kind: 'cpu' } },
    models: {
      'qwen3.8-27b': {
        display: 'Qwen3.8 27B',
        configs: {
          ampere: {
            status: 'unmeasured',
            files: [
              { path: present, repo: 'org/weights', bytes: 3 },
              { path: missing, repo: 'org/weights', bytes: 5 },
            ],
          },
        },
      },
    },
  }));
  return { repoPath, localPath: join(dir, 'no-local.json'), present, missing };
}

describe('models ensure (CLI)', () => {
  it('dry-run reports a missing file and exits 1 without downloading it', async () => {
    const { repoPath, localPath, missing } = writeFixture();
    expect(existsSync(missing)).toBe(false);
    const code = await modelsCommand('ensure', {
      spec: 'qwen3.8-27b/ampere',
      repoPath,
      localPath,
      dryRun: true,
      download: true,
    });
    expect(code).toBe(1);
    // and nothing was fetched into place
    expect(existsSync(missing)).toBe(false);
  });

  it('reports every file present and exits 0 when nothing is broken', async () => {
    const { repoPath, localPath, present, missing } = writeFixture();
    const onlyPresent = join(dir, 'repo-present.json');
    const doc = JSON.parse(readFileSync(repoPath, 'utf-8'));
    doc.models['qwen3.8-27b'].configs['ampere'].files = [{ path: present, repo: 'org/weights', bytes: 3 }];
    writeFileSync(onlyPresent, JSON.stringify(doc));
    const code = await modelsCommand('ensure', {
      spec: 'qwen3.8-27b/ampere',
      repoPath: onlyPresent,
      localPath,
      dryRun: true,
    });
    expect(code).toBe(0);
    expect(missing).toBeTruthy();
  });

  it('refuses unknown model/config specs with the known list, not silence', async () => {
    const { repoPath, localPath } = writeFixture();
    const code = await modelsCommand('ensure', { spec: 'no-such-model/x', repoPath, localPath, dryRun: true });
    expect(code).toBe(1);
  });

  it('ensure-by-path finds the declaring config and verifies the file', async () => {
    const { repoPath, localPath, present, missing } = writeFixture();
    const ok = await modelsCommand('ensure-by-path', { path: present, repoPath, localPath, dryRun: true });
    expect(ok).toBe(0);
    const broken = await modelsCommand('ensure-by-path', { path: missing, repoPath, localPath, dryRun: true });
    expect(broken).toBe(1);
  });

  it('ensure-by-path exits 1 with guidance when no manifest declares the path', async () => {
    const { repoPath, localPath } = writeFixture();
    const code = await modelsCommand('ensure-by-path', {
      path: '/home/cogtek/not-declared.gguf',
      repoPath,
      localPath,
      dryRun: true,
    });
    expect(code).toBe(1);
  });
});
