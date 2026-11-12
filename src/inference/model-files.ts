/**
 * Model file integrity + recovery for the local inference engines.
 *
 * The placement registry (config/model-registry.json) declares, per config,
 * the weight files the engine needs on disk together with their source and
 * integrity facts. This module answers the operational failure the units
 * kept hitting one way or another: a file deleted or truncated after
 * installation ("accidentally deleted"), which used to kill the server at
 * start with nothing but an ERROR line.
 *
 * Two checks, deliberately split by cost:
 *   - presence + size: a stat() call, run on every ensure (unit preflight
 *     budget: milliseconds, no hashing of a 15 GiB GGUF at boot);
 *   - sha256: a full read, run only after a download or with --verify.
 *
 * Downloads are curl, resumable (-C - against the .part file), never
 * huggingface-cli (broken on this box: deprecated shim + typer/click
 * TypeError — see the strata bench log of 2026-10-28), and land only inside
 * $HOME: a repo-supplied manifest must not let a cloned repo write outside
 * the operator's home. A file with no recorded repo is check-only — a
 * deletion is reported, not guessed at.
 */
import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { createReadStream, existsSync, mkdirSync, renameSync, statSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, isAbsolute, resolve } from 'path';

/** One declared model file: where it must live, and how to recognize it. */
export interface ModelFileManifest {
  /** Absolute destination path on this machine. */
  path: string;
  /** Hugging Face repo id (e.g. "jakeatx/Qwen3.8-27B-ATX-IQ4_XS-M-GGUF"). */
  repo?: string;
  /** Filename inside the repo; defaults to the destination basename. */
  file?: string;
  /** Repo revision to fetch from; defaults to main. Pin it when the file was
   * removed from main (unsloth deleted Qwen3.8-27B-Q4_K_M.gguf 2026-08-19). */
  rev?: string;
  /** Expected size in bytes (truncation detector). */
  bytes?: number;
  /** Expected sha256, lowercase hex. Verified after download and on demand. */
  sha256?: string;
}

/** Result of checking one manifest entry without repairing it. */
export type FileState =
  | { status: 'ok'; path: string; bytes: number; note?: string }
  | { status: 'unchecked'; path: string; bytes: number; note: 'no expected size or sha256 recorded' | string }
  | { status: 'missing'; path: string }
  | { status: 'size-mismatch'; path: string; bytes: number; expectedBytes: number }
  | { status: 'sha-mismatch'; path: string; bytes: number; expectedSha256: string };

/** curl runner, injectable so tests never touch the network. */
export type RunCurl = (args: string[]) => Promise<{ code: number; stderr: string }>;

export const defaultRunCurl: RunCurl = (args) =>
  new Promise((resolvePromise) => {
    execFile('curl', args, { maxBuffer: 1 << 20, timeout: 0 }, (err, _stdout, stderr) => {
      resolvePromise({ code: err && typeof err.code === 'number' ? err.code : 0, stderr: String(stderr ?? '') });
    });
  });

/** Filename inside the repo for a manifest entry. */
export function manifestRepoFile(entry: ModelFileManifest): string {
  return entry.file ?? basename(entry.path);
}

/** Hugging Face resolve URL for a manifest entry. */
export function hfResolveUrl(entry: ModelFileManifest): string {
  if (!entry.repo) throw new Error(`no repo recorded for ${entry.path}`);
  const rev = entry.rev ?? 'main';
  return `https://huggingface.co/${entry.repo}/resolve/${rev}/${encodeURIComponent(manifestRepoFile(entry))}`;
}

/** sha256 of a file, streamed — the only full-read check we ever do. */
export function sha256File(path: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', rejectPromise);
    stream.on('end', () => resolvePromise(hash.digest('hex')));
  });
}

/**
 * Check one declared file. Cheap by default (stat only); with `verifySha`
 * also hashes (minutes for tens of GiB — opt-in, never a unit preflight).
 */
export async function fileState(
  entry: ModelFileManifest,
  opts: { verifySha?: boolean } = {},
): Promise<FileState> {
  if (!existsSync(entry.path)) return { status: 'missing', path: entry.path };
  const bytes = statSync(entry.path).size;
  if (entry.bytes !== undefined && bytes !== entry.bytes) {
    return { status: 'size-mismatch', path: entry.path, bytes, expectedBytes: entry.bytes };
  }
  if (opts.verifySha === true && entry.sha256) {
    const got = await sha256File(entry.path);
    if (got !== entry.sha256) {
      return { status: 'sha-mismatch', path: entry.path, bytes, expectedSha256: entry.sha256 };
    }
    return { status: 'ok', path: entry.path, bytes };
  }
  if (entry.bytes === undefined && !entry.sha256) {
    return {
      status: 'unchecked',
      path: entry.path,
      bytes,
      note: 'no expected size or sha256 recorded',
    };
  }
  return { status: 'ok', path: entry.path, bytes };
}

/** A download may only ever target a path inside the operator's home. */
export function downloadTargetSafe(path: string): boolean {
  if (!isAbsolute(path)) return false;
  const home = homedir();
  const target = resolve(path);
  return target === home || target.startsWith(`${home}/`);
}

/** Whether a missing file can be repaired (a source is recorded). */
export function isRepairable(entry: ModelFileManifest): boolean {
  return typeof entry.repo === 'string' && entry.repo.length > 0;
}

/**
 * Download (or resume) one declared file into place.
 * - downloads to `<path>.part` with curl -C -, then verifies and renames;
 * - an existing file that already matches `bytes` is left untouched;
 * - refuses targets outside $HOME (repo-supplied manifests are not trusted
 *   with the rest of the filesystem).
 */
export async function downloadModelFile(
  entry: ModelFileManifest,
  opts: { runCurl?: RunCurl } = {},
): Promise<{ ok: true; bytes: number } | { ok: false; error: string }> {
  if (!isRepairable(entry)) return { ok: false, error: `no repo recorded for ${entry.path}` };
  if (!downloadTargetSafe(entry.path)) {
    return { ok: false, error: `refusing to download outside $HOME: ${entry.path}` };
  }
  if (existsSync(entry.path)) {
    const bytes = statSync(entry.path).size;
    if (entry.bytes === undefined || bytes === entry.bytes) {
      return { ok: true, bytes };
    }
  }
  const runCurl = opts.runCurl ?? defaultRunCurl;
  const part = `${entry.path}.part`;
  const url = hfResolveUrl(entry);
  mkdirSync(dirname(entry.path), { recursive: true });
  const authArgs = process.env.HF_TOKEN
    ? ['-H', `Authorization: Bearer ${process.env.HF_TOKEN}`]
    : [];
  const baseArgs = ['-fL', '-sS', '--retry', '3', '--retry-delay', '2', ...authArgs, '-o', part, url];
  // -C - resumes a leftover .part; curl exit 33 means "cannot resume" (no
  // ranges, or the .part is already complete) — retry once from scratch.
  const resumed = await runCurl(['-C', '-', ...baseArgs]);
  if (resumed.code !== 0) {
    const fresh = await runCurl(baseArgs);
    if (fresh.code !== 0) {
      return { ok: false, error: `curl exit ${resumed.code}/${fresh.code} for ${url}: ${fresh.stderr.slice(0, 200)}` };
    }
  }
  if (!existsSync(part)) return { ok: false, error: `curl left no .part file for ${url}` };
  const partBytes = statSync(part).size;
  if (entry.bytes !== undefined && partBytes !== entry.bytes) {
    return { ok: false, error: `downloaded ${partBytes} bytes, expected ${entry.bytes} (${url}); .part kept for resume` };
  }
  if (entry.sha256) {
    const got = await sha256File(part);
    if (got !== entry.sha256) {
      return { ok: false, error: `sha256 mismatch after download (${url}); .part kept for resume` };
    }
  }
  renameSync(part, entry.path);
  return { ok: true, bytes: statSync(entry.path).size };
}

/** What `ensure` did, in one printable summary. */
export interface EnsureResult {
  /** Manifest entries inspected. */
  checked: number;
  /** Entries already present and (if recorded) sized right. */
  present: number;
  /** Entries missing or truncated, whether or not a repair was attempted. */
  broken: Array<{ entry: ModelFileManifest; state: FileState }>;
  /** Entries repaired by download this run. */
  repaired: ModelFileManifest[];
  /** Repairs attempted and failed (last error kept). */
  failed: Array<{ entry: ModelFileManifest; error: string }>;
}

/**
 * Verify every declared file; repair what is missing or truncated.
 * `dryRun` reports without downloading; `download: false` forces that too.
 * Returns a structured result — the CLI decides how loud to be.
 */
export async function ensureFiles(
  entries: ModelFileManifest[],
  opts: { dryRun?: boolean; download?: boolean; verifySha?: boolean; runCurl?: RunCurl } = {},
): Promise<EnsureResult> {
  const out: EnsureResult = { checked: 0, present: 0, broken: [], repaired: [], failed: [] };
  for (const entry of entries) {
    out.checked += 1;
    const state = await fileState(entry, { verifySha: opts.verifySha === true });
    if (state.status === 'ok' || state.status === 'unchecked') {
      out.present += 1;
      continue;
    }
    out.broken.push({ entry, state });
    if (opts.dryRun === true || opts.download === false) continue;
    if (!isRepairable(entry)) continue;
    const res = await downloadModelFile(entry, { runCurl: opts.runCurl });
    if (res.ok) out.repaired.push(entry);
    else out.failed.push({ entry, error: res.error });
  }
  return out;
}
