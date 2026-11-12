/**
 * Model file integrity + recovery (`src/inference/model-files.ts`):
 * presence/size detection, sha256 verification, HF URL building (default
 * main vs pinned rev), resumable curl download with the injectable runner,
 * the $HOME download guard, and the ensure/repair loop the unit preflights
 * and `uap models ensure` are built on. No test touches the network: the
 * curl runner is stubbed.
 */
import { createHash } from 'crypto';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  downloadModelFile,
  ensureFiles,
  fileState,
  hfResolveUrl,
  manifestRepoFile,
  type ModelFileManifest,
  type RunCurl,
} from '../../src/inference/model-files.js';

// Downloads are guarded to $HOME by policy, so the repair-path fixtures must
// live there (removed in afterAll); the pure-check fixtures can stay in /tmp.
let dir: string;
let homeDir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'uap-model-files-'));
  homeDir = mkdtempSync(join(homedir(), '.uap-model-files-test-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

const writePart = (path: string, bytes: number) => {
  writeFileSync(`${path}.part`, 'x'.repeat(bytes));
};

describe('fileState (cheap checks)', () => {
  it('reports ok on present + sized file, and unchecked when no facts are recorded', async () => {
    const okPath = join(dir, 'ok.gguf');
    writeFileSync(okPath, 'abc');
    const ok = await fileState({ path: okPath, bytes: 3 });
    expect(ok.status).toBe('ok');

    const barePath = join(dir, 'bare.gguf');
    writeFileSync(barePath, 'abc');
    const bare = await fileState({ path: barePath });
    expect(bare.status).toBe('unchecked');
  });

  it('reports missing for absent files and size-mismatch for truncated ones', async () => {
    const missing = await fileState({ path: join(dir, 'gone.gguf'), bytes: 10 });
    expect(missing.status).toBe('missing');

    const truncatedPath = join(dir, 'trunc.gguf');
    writeFileSync(truncatedPath, 'abc');
    const truncated = await fileState({ path: truncatedPath, bytes: 10 });
    expect(truncated.status).toBe('size-mismatch');
  });

  it('verifies sha256 only when asked, and reports a mismatch', async () => {
    const path = join(dir, 'sha.gguf');
    writeFileSync(path, 'payload');
    const sha = createHash('sha256').update('payload').digest('hex');
    const good = await fileState({ path, sha256: sha }, { verifySha: true });
    expect(good.status).toBe('ok');
    const bad = await fileState({ path, sha256: '0'.repeat(64) }, { verifySha: true });
    expect(bad.status).toBe('sha-mismatch');
  });
});

describe('hfResolveUrl', () => {
  it('defaults to main and the destination basename, and honours a pinned rev', () => {
    const plain: ModelFileManifest = {
      path: '/home/x/m/Model-Q4.gguf',
      repo: 'org/Model-GGUF',
    };
    expect(hfResolveUrl(plain)).toBe('https://huggingface.co/org/Model-GGUF/resolve/main/Model-Q4.gguf');
    expect(manifestRepoFile(plain)).toBe('Model-Q4.gguf');

    const pinned: ModelFileManifest = {
      path: '/home/x/m/Qwen3.8-27B-Q4_K_M.gguf',
      repo: 'unsloth/Qwen3.8-27B-GGUF',
      rev: '566347e99d832d31f6245a577198d10d5bdd389e',
    };
    expect(hfResolveUrl(pinned)).toBe(
      'https://huggingface.co/unsloth/Qwen3.8-27B-GGUF/resolve/566347e99d832d31f6245a577198d10d5bdd389e/Qwen3.8-27B-Q4_K_M.gguf',
    );
  });
});

describe('downloadModelFile', () => {
  it('downloads to .part, verifies bytes, and renames into place', async () => {
    const path = join(homeDir, 'recovered.gguf');
    const entry: ModelFileManifest = { path, repo: 'org/weights', bytes: 12 };
    const runCurl: RunCurl = async (args) => {
      expect(args).toContain('-C'); // resumable
      writePart(path, 12);
      return { code: 0, stderr: '' };
    };
    const res = await downloadModelFile(entry, { runCurl });
    expect(res.ok).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.part`)).toBe(false);
    expect(readFileSync(path, 'utf-8')).toBe('xxxxxxxxxxxx');
  });

  it('refuses targets outside $HOME and files without a recorded repo', async () => {
    let called = 0;
    const runCurl: RunCurl = async () => {
      called += 1;
      return { code: 0, stderr: '' };
    };
    const outside = await downloadModelFile({ path: '/etc/cron.d/evil.gguf', repo: 'x/y' }, { runCurl });
    expect(outside.ok).toBe(false);
    const noRepo = await downloadModelFile({ path: join(dir, 'any.gguf') }, { runCurl });
    expect(noRepo.ok).toBe(false);
    expect(called).toBe(0);
  });

  it('fails on size mismatch and keeps the .part for resume, then succeeds when the size is right', async () => {
    const path = join(homeDir, 'mismatch.gguf');
    const entry: ModelFileManifest = { path, repo: 'org/weights', bytes: 12 };
    const runCurl: RunCurl = async () => {
      writePart(path, 10); // truncated download
      return { code: 0, stderr: '' };
    };
    const bad = await downloadModelFile(entry, { runCurl });
    expect(bad.ok).toBe(false);
    expect(existsSync(`${path}.part`)).toBe(true);
    expect(existsSync(path)).toBe(false);

    const goodRun: RunCurl = async () => {
      writePart(path, 12);
      return { code: 0, stderr: '' };
    };
    const good = await downloadModelFile(entry, { runCurl: goodRun });
    expect(good.ok).toBe(true);
  });

  it('restarts from scratch when curl cannot resume (exit 33)', async () => {
    const path = join(homeDir, 'restart.gguf');
    const entry: ModelFileManifest = { path, repo: 'org/weights', bytes: 4 };
    const calls: string[][] = [];
    const runCurl: RunCurl = async (args) => {
      calls.push(args);
      if (calls.length === 1) return { code: 33, stderr: 'HTTP server does not support ranges' };
      writePart(path, 4);
      return { code: 0, stderr: '' };
    };
    const res = await downloadModelFile(entry, { runCurl });
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('-C');
    expect(calls[1]).not.toContain('-C');
  });
});

describe('ensureFiles', () => {
  it('dry-run reports broken files without attempting a repair', async () => {
    const path = join(homeDir, 'dry.gguf');
    const entry: ModelFileManifest = { path, repo: 'org/weights', bytes: 5 };
    let called = 0;
    const runCurl: RunCurl = async () => {
      called += 1;
      return { code: 0, stderr: '' };
    };
    const res = await ensureFiles([entry], { dryRun: true, runCurl });
    expect(res.checked).toBe(1);
    expect(res.broken).toHaveLength(1);
    expect(res.broken[0].state.status).toBe('missing');
    expect(called).toBe(0);
  });

  it('repairs what is broken, reports unrepairable files, and counts the present', async () => {
    const presentPath = join(dir, 'have.gguf');
    writeFileSync(presentPath, 'abc');
    const gonePath = join(homeDir, 'gone2.gguf');
    const noSourcePath = join(dir, 'nosource.gguf');
    const entries: ModelFileManifest[] = [
      { path: presentPath, bytes: 3 },
      { path: gonePath, repo: 'org/weights', bytes: 5 },
      { path: noSourcePath },
    ];
    const runCurl: RunCurl = async () => {
      writePart(gonePath, 5);
      return { code: 0, stderr: '' };
    };
    const res = await ensureFiles(entries, { runCurl });
    expect(res.checked).toBe(3);
    expect(res.present).toBe(1);
    expect(res.repaired.map((e) => e.path)).toEqual([gonePath]);
    expect(res.broken.map((b) => b.entry.path)).toEqual([gonePath, noSourcePath]);
    expect(res.failed).toHaveLength(0);
    expect(existsSync(gonePath)).toBe(true);
  });
});
