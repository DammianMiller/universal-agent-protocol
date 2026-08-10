/**
 * Integrity manifest for the materialized enforcers.
 *
 * WHY THIS EXISTS. The policy gate executes `.policy-tools/<policyId>_<tool>.py`
 * — copies, not the source. Nothing verified those copies, so the enforcement
 * surface had two failure modes that both looked like success:
 *
 *   1. STALE. A merged fix stayed inert because the copy was never re-made.
 *      This repo shipped that for over a week (the H1-vs-slug installer bug),
 *      and it happened again in the session that produced this module: tests
 *      green on `src/`, gate running last month's code.
 *   2. TAMPERED/DELETED. Deleting one file — `_common.py`, which every enforcer
 *      imports — broke all 29 enforcers at import and turned the gate into a
 *      no-op. Verified live.
 *
 * A text scan over shell commands cannot prevent (2): `python3 -c` can write any
 * file, and that is allowed by design. So refusal is the wrong control here.
 * REPAIR is the right one — make the surface restore itself on the next tool
 * call, so destroying it buys an attacker one call rather than permanent
 * silence, and so ordinary staleness self-corrects.
 *
 * HONEST BOUND: this is integrity against accident and against an agent working
 * through the tool surface — not against an attacker with arbitrary local write
 * access, who can rewrite the manifest as easily as the enforcers. Same trust
 * root as the package itself. What it buys is that every cheap path to a silent
 * no-op now heals, loudly.
 */
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** sha256sum(1) format so the gate can verify with one coreutils call. */
export const MANIFEST_NAME = '.integrity.sha256';
/** Absolute path of the enforcer sources the copies came from. */
export const SOURCE_NAME = '.integrity.source';

export interface IntegrityReport {
  /** Files whose content no longer matches the manifest. */
  changed: string[];
  /** Files in the manifest that are gone. */
  missing: string[];
  /** Files present but absent from the manifest (never materialized by us). */
  unknown: string[];
  /**
   * Files that match the manifest but NOT the current source — intact copies of
   * a superseded version.
   *
   * Separate from `changed` because the two mean opposite things. A changed file
   * was tampered with. A stale file is exactly what was recorded, and that is
   * the problem: the manifest agrees with it, so integrity passes while the gate
   * executes code that a later release replaced.
   */
  stale: string[];
  /** True when there is no manifest to check against. */
  unmanaged: boolean;
}

export interface RepairReport extends IntegrityReport {
  restored: string[];
  /** Entries that could not be restored — no source file to copy from. */
  unrecoverable: string[];
}

export function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Where the enforcer sources live. Mirrors the ladder PolicyToolRegistry uses:
 * the installed package first, the repo second. A plain `process.cwd()` base
 * finds nothing when `uap` runs from any project other than this one.
 */
export function resolveEnforcerSourceDir(cwd: string = process.cwd()): string | null {
  const candidates = [
    join(__dirname, '..', '..', 'src', 'policies', 'enforcers'), // dist -> pkg root
    join(__dirname, '..', 'policies', 'enforcers'), // src layout
    join(cwd, 'src', 'policies', 'enforcers'), // running in the repo
  ];
  return candidates.find((c) => existsSync(join(c, '_common.py'))) ?? null;
}

/**
 * The source file a materialized copy came from.
 * Copies are `<policyId>_<toolName>.py`; sources are `<toolName>.py`. The id is
 * a UUID, so split on the FIRST underscore after it rather than the last —
 * tool names themselves contain underscores (`enforcement_self_protect`).
 */
export function sourceNameFor(materialized: string): string {
  if (materialized === '_common.py') return '_common.py';
  const m = materialized.match(/^[0-9a-fA-F-]{8,}_(.+\.py)$/);
  return m ? m[1] : materialized;
}

function pyFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.py'))
      .sort();
  } catch {
    return [];
  }
}

/** Record the hash of every materialized enforcer, plus where they came from. */
export function writeIntegrityManifest(
  toolDir: string,
  sourceDir: string | null = resolveEnforcerSourceDir()
): string[] {
  mkdirSync(toolDir, { recursive: true });
  const files = pyFiles(toolDir);
  const lines = files.map((f) => `${sha256(readFileSync(join(toolDir, f)))}  ${f}`);
  writeFileSync(join(toolDir, MANIFEST_NAME), lines.join('\n') + (lines.length ? '\n' : ''));
  if (sourceDir) writeFileSync(join(toolDir, SOURCE_NAME), sourceDir + '\n');
  return files;
}

export function readManifest(toolDir: string): Map<string, string> | null {
  const p = join(toolDir, MANIFEST_NAME);
  if (!existsSync(p)) return null;
  const map = new Map<string, string>();
  for (const line of readFileSync(p, 'utf-8').split('\n')) {
    const m = line.match(/^([0-9a-f]{64})\s+(.+)$/);
    if (m) map.set(m[2], m[1]);
  }
  return map;
}

/**
 * Materialized copies that match the manifest but no longer match SOURCE.
 *
 * `changed` and `stale` are different failures with different remedies, and
 * collapsing them is what let this go unnoticed. A CHANGED file was tampered
 * with: the copy drifted from what was recorded. A STALE file is intact and
 * faithfully records an OLD version — the manifest agrees with it, so integrity
 * verification passes while the gate runs code that was superseded.
 *
 * That is the shape of nearly every enforcer fix in this repo: merged, green,
 * and inert. `uap policy verify` printed "Enforcers match their manifest" on a
 * tree whose source had moved two releases ahead of the running copy.
 *
 * Source is resolved from the INSTALLED package first, so this works in any
 * project, not only in this repo.
 */
function staleAgainstSource(
  toolDir: string,
  manifest: Map<string, string>,
  sourceDir: string | null
): string[] {
  if (!sourceDir) return []; // no source to compare against — unknowable, not stale
  const stale: string[] = [];
  for (const file of manifest.keys()) {
    const copy = join(toolDir, file);
    const src = join(sourceDir, sourceNameFor(file));
    if (!existsSync(copy) || !existsSync(src)) continue; // missing is a separate verdict
    if (sha256(readFileSync(copy)) !== sha256(readFileSync(src))) stale.push(file);
  }
  return stale;
}

/** The source dir a manifest recorded, falling back to the installed package. */
function sourceDirFor(toolDir: string, cwd: string = process.cwd()): string | null {
  const recorded = existsSync(join(toolDir, SOURCE_NAME))
    ? readFileSync(join(toolDir, SOURCE_NAME), 'utf-8').trim()
    : null;
  return recorded && existsSync(recorded) ? recorded : resolveEnforcerSourceDir(cwd);
}

export function verifyIntegrity(toolDir: string, cwd: string = process.cwd()): IntegrityReport {
  const manifest = readManifest(toolDir);
  if (!manifest) {
    return { changed: [], missing: [], unknown: [], stale: [], unmanaged: true };
  }
  const changed: string[] = [];
  const missing: string[] = [];
  for (const [file, hash] of manifest) {
    const p = join(toolDir, file);
    if (!existsSync(p)) {
      missing.push(file);
      continue;
    }
    if (sha256(readFileSync(p)) !== hash) changed.push(file);
  }
  const unknown = pyFiles(toolDir).filter((f) => !manifest.has(f));
  // Only files that are otherwise intact can be stale; a tampered or missing
  // copy already has a louder verdict and the same remedy.
  const intact = new Map([...manifest].filter(([f]) => !changed.includes(f) && !missing.includes(f)));
  const stale = staleAgainstSource(toolDir, intact, sourceDirFor(toolDir, cwd));
  return { changed, missing, unknown, stale, unmanaged: false };
}

/**
 * Restore anything changed or missing from the recorded source directory.
 *
 * Deliberately does NOT touch `unknown` files: an operator may have added an
 * enforcer by hand, and deleting someone's work to satisfy a checksum is a
 * worse failure than the drift it fixes. They are reported instead.
 */
export function repairIntegrity(toolDir: string, cwd: string = process.cwd()): RepairReport {
  const report = verifyIntegrity(toolDir);
  const restored: string[] = [];
  const unrecoverable: string[] = [];
  if (report.unmanaged) return { ...report, restored, unrecoverable };

  const sourceDir = sourceDirFor(toolDir, cwd);

  // Stale copies are refreshed alongside tampered ones: both end with the
  // materialized file equal to source, and a repair that left the gate running
  // superseded code would be repairing the wrong thing.
  for (const file of [...report.missing, ...report.changed, ...report.stale]) {
    const src = sourceDir ? join(sourceDir, sourceNameFor(file)) : null;
    if (src && existsSync(src)) {
      copyFileSync(src, join(toolDir, file));
      restored.push(file);
    } else {
      unrecoverable.push(file);
    }
  }
  // Re-record, or the refreshed copies would read as TAMPERED on the next
  // verify — the manifest still holds the superseded hashes.
  if (restored.length) {
    try {
      writeIntegrityManifest(toolDir, sourceDir);
    } catch {
      /* the copies are already correct; a manifest write failure is reported
         by the next verify rather than losing the repair */
    }
  }
  return { ...report, restored, unrecoverable };
}
