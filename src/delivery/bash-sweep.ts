/**
 * Turn-end substance sweep for files written through `run_bash`.
 *
 * The stub guard covers `write_file` and `edit_file`. `run_bash` bypasses both:
 * `cat > f <<'EOF' … EOF`, `sed -i` and `python -c "open(...).write(...)"` all
 * land content without passing through a tool handler. That was recorded as a
 * known limit when the guard shipped (PR #611) rather than papered over, and
 * this closes it.
 *
 * WHY A SWEEP AND NOT A CHECK IN THE HANDLER
 * The other run_bash protections work by SNAPSHOTTING a known set — protected
 * tests, locked contracts, gate configs — and restoring whatever the command
 * touched. That works because those sets are enumerable up front. The set of
 * files a shell command might write is not, so there is nothing to snapshot by
 * name. The sweep instead takes a baseline of the tree at the first command and
 * compares at turn end, which is the only way to attribute an arbitrary write.
 *
 * THE COST MODEL IS INVERTED FROM THE WRITE PATH, AND THAT DRIVES EVERYTHING
 * On the write path a false positive costs one retry: the write is refused and
 * the model tries again. Here a false positive touches a file that already
 * exists, so it costs WORK. Four consequences, each of which an earlier version
 * of this file got wrong and each of which now has a test:
 *
 *  1. Absence of baseline CONTENT never implies absence of the FILE. Existence
 *     is recorded for every path with no read and no byte budget, so a file the
 *     content baseline skipped — capped, oversized, unreadable — is still known
 *     to have existed. Only a path absent from `known` may be treated as created
 *     this turn. Without that split, a file the baseline had skipped was DELETED
 *     when the shell shrank it, and on a tree past the cap files the shell never
 *     touched became deletion candidates.
 *  2. Nothing the harness has SEEN is destroyed, and nothing leaves the project.
 *     Every removal and every revert preserves the current content under
 *     `.uap/bash-sweep-backup/` first, a failed preserve aborts the action, and
 *     every destination is proven to resolve inside that directory. The limit is
 *     worth stating precisely, because a broader claim would be false: a revert
 *     restores the last content the harness AUTHORISED, so if one shell command
 *     writes real code and a later command in the SAME turn hollows it, the
 *     intermediate version — which no tool handler ever saw — is not recovered.
 *     The rejected content is preserved; the unobserved good version is not. `relative()` used to be run through
 *     `.split('\\')`, which is correct on Windows and WRONG on POSIX where a
 *     backslash is a legal filename character: one directory entry named
 *     `..\..\..\..\x.js` produced a traversing key and the sweep wrote and
 *     RENAMED outside the project root. (Reproduced; test below. The harness
 *     already documents that the small model mangles paths, so this needed no
 *     adversary.)
 *  3. An existing file is only reverted when the change made it STRICTLY WORSE —
 *     more empty bodies than the content we authorised. A formatter or codemod
 *     that rewrites an already-stubby file without emptying anything further is
 *     left alone, because reverting it would be both wrong and unexplainable
 *     ("your shell command wrote SKELETONS" about `prettier --write`).
 *  4. Silence must mean "nothing changed", not "we could not look". Coverage
 *     gaps are reported — but ONLY for files that actually changed. Reporting
 *     every unreadable path made a single `logo.png` emit a coverage warning on
 *     every bash turn of every asset-bearing project, into a prompt slot that is
 *     head-truncated.
 *
 * WHAT COUNTS AS THE BASELINE
 * Per file, the last content this harness knows it authorised: what a guarded
 * tool wrote this turn if one did, otherwise the content at the first command.
 * Using "was it written by a guarded tool" as a plain skip would leave a hole —
 * write the real implementation with write_file, then hollow it out with sed,
 * and the path is on the allow-list. Comparing against the authorised CONTENT
 * closes it. A file CREATED this turn is judged on its own content regardless of
 * authorisation, which closes the mirror hole: the shell writes a skeleton, then
 * a single edit_file fills one body and the monotone-progress rule — measuring
 * against the skeleton itself — stamps the rest as authorised.
 *
 * SCOPE, STATED PLAINLY
 * This is a correctness guard against confused generation, not a security
 * boundary. A model holding a shell can do anything a shell can do, including
 * removing this check; run_bash is gated on kernel containment for that reason.
 * The sweep judges SUBSTANCE only — a command that deletes a real file is a
 * different failure and is not restored here. And a quarantine can leave the
 * tree in a state neither the model nor the gates have seen: a `main.js` written
 * by write_file may import a `player.js` the sweep removed. The gates see that
 * and the note names the repair, which is the intended outcome, but it is a real
 * intermediate state rather than a clean rollback.
 */

import {
  readdirSync,
  statSync,
  fstatSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  realpathSync,
  lstatSync,
  existsSync,
  openSync,
  readSync,
  closeSync,
  constants as fsConstants,
} from 'fs';
import { join, relative, resolve, dirname, sep } from 'path';
import { detectStub, stubGuardDisabled, type StubVerdict } from './stub-detector.js';
import { CONTEXT_BUDGET_MARKER } from './context-budget.js';

/**
 * Never walked at any depth: version control, dependencies, harness state,
 * language caches and vendored third-party trees. `.git` and `node_modules` also
 * hold code that would be judged as if the model had authored it — and the
 * harness actively steers models to vendor dependencies locally when a CDN fetch
 * fails, so `vendor`/`third_party` are the same case by another name.
 */
const ALWAYS_SKIP = new Set([
  '.git',
  'node_modules',
  '.uap',
  '.uap-deliver',
  '.uap-backups',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  '.venv',
  'venv',
  '.cache',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  'vendor',
  'third_party',
  // Every other tree-walk in this package excludes these; this one omitted them.
  // A sweep rooted at a repo that follows the worktree workflow would otherwise
  // walk N full checkouts, and `agents/` holds the memory/coordination SQLite
  // stores and the vector index.
  '.worktrees',
  'agents',
]);

/**
 * Build output — skipped only at the PROJECT ROOT. Matching these at any depth
 * made `src/build/`, `app/out/` and `pkg/target/` permanent blind spots, and for
 * a web mission the deliverable itself sometimes lives in `build/` or `out/`.
 */
const ROOT_ONLY_SKIP = new Set(['dist', 'build', 'out', 'coverage', 'target']);

export interface SweepLimits {
  /** Max files whose CONTENT is baselined. Existence is never capped. */
  maxFiles: number;
  /** Max total bytes of baselined content. */
  maxTotalBytes: number;
  /** Per-file read ceiling; matches the detector's own scan cap. */
  maxFileBytes: number;
}

/**
 * A delivery target is an application, not a monorepo, so these sit far above
 * any real project — they exist so a mission pointed at something huge degrades
 * predictably instead of reading gigabytes inside a turn boundary. Injectable so
 * tests exercise the capped paths for real rather than setting a flag by hand.
 */
export const DEFAULT_LIMITS: SweepLimits = {
  maxFiles: 3000,
  maxTotalBytes: 16 * 1024 * 1024,
  maxFileBytes: 200_000,
};

/** Where displaced content goes. Inside `.uap`, so the sweep never re-walks it. */
export const BACKUP_DIR = join('.uap', 'bash-sweep-backup');

export interface BashSweep {
  /** False when bash is disabled for the session: no baseline, no sweep. */
  readonly enabled: boolean;
  /** Root of both walks. */
  readonly projectRoot: string;
  /** Set true once a command has run — the sweep is a no-op until then. */
  bashRan: boolean;
  /** Whether the baseline walk has happened (it is lazy). */
  baselined: boolean;
  /**
   * Whether the sweep has already run for this turn. The wrapper calls
   * finishBashSweep on the success path and again from `finally`; making the
   * second call a no-op here — rather than relying on the caller to track it —
   * keeps the double walk out of every bash turn no matter who calls.
   */
  swept: boolean;
  /** Project-relative path -> content a guarded tool wrote this turn. */
  readonly authorised: Map<string, string>;
  /** Project-relative path -> content at the first command. May be partial. */
  readonly baseline: Map<string, string>;
  /** EVERY path that existed at the first command. Never capped — see doc. */
  readonly known: Set<string>;
  /**
   * Size and mtime of every known path. Two jobs: an unbaselined file's CHANGE
   * stays visible (so coverage warnings name files that actually moved), and the
   * sweep can skip re-reading a file that demonstrably did not move — otherwise
   * it re-reads the entire content baseline on a turn where the shell touched
   * one file.
   */
  readonly statAt: Map<string, { size: number; mtimeMs: number }>;
  /** True when the file-count/byte budget cut the content baseline short. */
  truncated: boolean;
  readonly limits: SweepLimits;
}

export interface SweepOutcome {
  /** Paths reverted to their authorised content (backed up first). */
  reverted: string[];
  /** Paths moved into the backup — they did not exist before the turn. */
  removed: string[];
  /** Paths that CHANGED but could not be attributed; left untouched. */
  uncovered: string[];
  /** Paths the sweep decided to act on but could not. */
  failed: string[];
  /** Model-facing note, '' when there is nothing to say. */
  note: string;
}

/** Fresh on every call: a shared singleton lets one caller's mutation leak. */
function emptyOutcome(): SweepOutcome {
  return { reverted: [], removed: [], uncovered: [], failed: [], note: '' };
}

/** A sweep that never fires — for callers with bash disabled. */
export function disabledSweep(): BashSweep {
  return {
    enabled: false,
    projectRoot: '',
    bashRan: false,
    baselined: false,
    swept: false,
    authorised: new Map(),
    baseline: new Map(),
    known: new Set(),
    statAt: new Map(),
    truncated: false,
    limits: DEFAULT_LIMITS,
  };
}

/**
 * Project-relative key for a walked path.
 *
 * Separator translation happens ONLY on Windows. Doing it unconditionally is the
 * bug described in the header: on POSIX a backslash is a legal filename
 * character, so translating it manufactures `..` segments out of a single
 * directory entry.
 */
function relKey(projectRoot: string, abs: string): string {
  const rel = relative(projectRoot, abs);
  return sep === '\\' ? rel.split('\\').join('/') : rel;
}

/**
 * Read a file as text, or null when it is binary, unreadable, or not a regular
 * file by the time it is opened.
 *
 * Opened non-blocking and re-checked through `fstat` on the open descriptor: a
 * background process left running by the command can swap a file for a FIFO
 * between the directory read and this open, and a blocking open on a FIFO with
 * no writer hangs forever — inside the turn boundary, which stops the deliver
 * heartbeat and invites the lock's wedge-reclaim to kill a run that is merely
 * blocked.
 */
function readText(abs: string, maxBytes: number): string | null {
  let fd = -1;
  try {
    fd = openSync(abs, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > maxBytes) return null;
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n <= 0) break;
      off += n;
    }
    // Binary sniff. The detector exempts a fixed list of extensions and scans
    // everything else — right for a write path (the model writes source) and wrong
    // for a whole-tree walk, where a .png/.wasm/.db under the read cap would be
    // decoded as UTF-8, held in the baseline, and fed to a brace scanner.
    if (buf.subarray(0, Math.min(off, 8192)).includes(0)) return null;
    const text = buf.subarray(0, off).toString('utf-8');
    // The decoded string is what gets written BACK on a revert, so a lossy decode
    // would silently corrupt the file it is meant to restore. Latin-1 source, or a
    // NUL past the 8 KB sniff window, round-trips through U+FFFD; a byte-length
    // mismatch is the cheap, exact test for that. Treat it as out of scope.
    if (Buffer.byteLength(text, 'utf-8') !== off) return null;
    return text;
  } catch {
    return null;
  } finally {
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/** Walk project files, calling `onFile` for each. Continues past unreadable dirs. */
function walk(
  projectRoot: string,
  onFile: (rel: string, abs: string, size: number, mtimeMs: number) => void
): void {
  const stack: string[] = [projectRoot];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable directory — not a reason to fail the turn
    }
    const atRoot = dir === projectRoot;
    for (const e of entries) {
      if (e.isSymbolicLink()) continue; // never follow: a link can leave the root
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (ALWAYS_SKIP.has(e.name)) continue;
        if (atRoot && ROOT_ONLY_SKIP.has(e.name)) continue;
        stack.push(abs);
        continue;
      }
      if (!e.isFile()) continue;
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      onFile(relKey(projectRoot, abs), abs, st.size, st.mtimeMs);
    }
  }
}

const ACTIVE_ROOTS = new Set<string>();

/**
 * Arm the sweep for a turn. Deliberately does NOT walk anything.
 *
 * The baseline is captured lazily, at the first command, so a bash-enabled
 * session that does not actually shell out in a given turn pays nothing.
 * Deferring is safe because of what `authorised` holds: anything that changed
 * BEFORE the first command can only have come from a guarded tool, and those
 * writes are recorded by content as they happen.
 */
export function beginBashSweep(
  projectRoot: string,
  enabled: boolean,
  limits: SweepLimits = DEFAULT_LIMITS
): BashSweep {
  if (!enabled || stubGuardDisabled()) return disabledSweep();
  // Two live sweeps over ONE tree would cross-attribute: A's baseline predates
  // B's guarded writes, so A can revert or quarantine a file B legitimately
  // created, and both would write the same backup paths. Nothing in the current
  // wiring runs concurrent agentic executors on a shared root, but that is a
  // decision in another file and this module is exported. Degrade to no sweep
  // rather than trust it: a missed check is recoverable, a wrong revert is not.
  if (ACTIVE_ROOTS.has(projectRoot)) return disabledSweep();
  ACTIVE_ROOTS.add(projectRoot);
  return {
    enabled: true,
    projectRoot,
    bashRan: false,
    baselined: false,
    swept: false,
    authorised: new Map(),
    baseline: new Map(),
    known: new Set(),
    statAt: new Map(),
    truncated: false,
    limits,
  };
}

/**
 * Arm for a command: mark that the shell ran, and capture the baseline once.
 *
 * Called from the run_bash handler BEFORE the spawn — a command that times out
 * or is killed may still have written files, and a sweep with nothing to compare
 * against would be worse than none, reporting "checked" over the messiest case.
 */
export function armSweepForCommand(sweep: BashSweep): void {
  if (!sweep.enabled) return;
  sweep.bashRan = true;
  if (sweep.baselined) return;
  sweep.baselined = true;
  let bytes = 0;
  walk(sweep.projectRoot, (rel, abs, size, mtimeMs) => {
    // EXISTENCE and STAT are recorded for every file, unconditionally. Existence
    // stops a gap in the content baseline from being read as "this file is new";
    // size is what lets a later change to an unbaselined file still be noticed,
    // so coverage warnings name files that actually moved.
    sweep.known.add(rel);
    sweep.statAt.set(rel, { size, mtimeMs });
    if (size > sweep.limits.maxFileBytes) return; // handled via sizeAt, not a truncation
    if (sweep.baseline.size >= sweep.limits.maxFiles || bytes + size > sweep.limits.maxTotalBytes) {
      sweep.truncated = true;
      return; // keep walking: existence still needs the rest of the tree
    }
    const text = readText(abs, sweep.limits.maxFileBytes);
    if (text === null) return; // binary — out of scope, and not a coverage gap
    sweep.baseline.set(rel, text);
    bytes += size;
  });
}

/** Record what a guarded tool wrote, so a later shell write is distinguishable. */
export function recordAuthorisedWrite(sweep: BashSweep, rel: string, content: string): void {
  if (sweep.enabled) sweep.authorised.set(rel, content);
}

/** Empty bodies in a verdict — the quantity the "strictly worse" test compares. */
function emptyCount(v: StubVerdict): number {
  return Math.round(v.emptyRatio * v.callables);
}

/**
 * Resolve the backup root and prove it is really inside the project.
 *
 * The walk never follows symlinks, so no path it yields can escape — but the
 * backup root is a path this module CONSTRUCTS rather than discovers, and `.uap`
 * is a directory a shell command can replace with a link. Measured before this
 * check existed: `ln -s /elsewhere .uap` and the sweep's own backups landed
 * outside the project root. Returns null when the location cannot be trusted,
 * which disables every mutation rather than performing an unbacked-up one.
 */
function resolveBackupRoot(projectRoot: string): string | null {
  try {
    const holder = join(projectRoot, '.uap');
    // Check the component we create THROUGH before creating anything, so a
    // redirected root does not even leave an empty directory behind.
    try {
      if (lstatSync(holder).isSymbolicLink()) return null;
    } catch {
      /* absent — mkdir below creates it inside the project */
    }
    const dest = join(projectRoot, BACKUP_DIR);
    mkdirSync(dest, { recursive: true });
    const realDest = realpathSync(dest);
    const realRoot = realpathSync(projectRoot);
    return realDest === realRoot || realDest.startsWith(realRoot + sep) ? realDest : null;
  } catch {
    return null;
  }
}

/**
 * Destination inside the backup root for `rel`, or null if it would escape.
 *
 * Belt-and-braces now that `relKey` no longer manufactures `..` segments, but
 * this is the check that actually contains the failure rather than the one that
 * avoids provoking it — and it is two lines.
 */
function backupDest(backupRoot: string, rel: string): string | null {
  const dest = resolve(backupRoot, rel);
  return dest.startsWith(backupRoot + sep) ? dest : null;
}

/**
 * A destination that will not clobber an earlier turn's backup.
 *
 * "Nothing is destroyed" has to hold ACROSS turns, and the retry loop is
 * designed to re-attempt the same file — so the same `rel` being quarantined
 * twice is the common case, not an edge one.
 */
function freeDest(dest: string): string {
  if (!existsSync(dest)) return dest;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${dest}.${i}`;
    if (!existsSync(candidate)) return candidate;
  }
  return `${dest}.overflow`;
}

/** Copy content into the backup root. False means the caller must NOT mutate. */
function backup(backupRoot: string, rel: string, content: string): string | null {
  const dest = backupDest(backupRoot, rel);
  if (dest === null) return null;
  try {
    const target = freeDest(dest);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf-8');
    return target;
  } catch {
    return null;
  }
}

/**
 * Compare the tree against the baseline and undo unattributed stub writes.
 * Returns an empty outcome when bash never ran, so the common path is a boolean.
 */
export function finishBashSweep(sweep: BashSweep): SweepOutcome {
  if (!sweep.enabled) return emptyOutcome();
  // Released here rather than by the caller: the executor's `finally` guarantees
  // this runs, and a root left marked active would silently disable the guard for
  // every later turn.
  ACTIVE_ROOTS.delete(sweep.projectRoot);
  if (!sweep.bashRan || sweep.swept || stubGuardDisabled()) return emptyOutcome();
  sweep.swept = true;

  const reverted: string[] = [];
  const removed: string[] = [];
  const uncovered: string[] = [];
  const failed: string[] = [];
  // Established once, before anything is touched. A backup location that cannot
  // be proven inside the project means no mutation happens at all this turn.
  const backupRoot = resolveBackupRoot(sweep.projectRoot);

  walk(sweep.projectRoot, (rel, abs, size, mtimeMs) => {
    const existedBefore = sweep.known.has(rel);
    const before = sweep.statAt.get(rel);
    const changedStat = before === undefined || before.size !== size || before.mtimeMs !== mtimeMs;
    // Unmoved and not written by a guarded tool this turn: nothing to judge, and
    // no reason to pay a full read. This is most of the tree on most turns.
    if (!changedStat && !sweep.authorised.has(rel)) return;
    // The last content this harness authorised: a guarded write this turn, else
    // whatever was there when the first command ran.
    const authorised = sweep.authorised.get(rel) ?? sweep.baseline.get(rel);

    if (size > sweep.limits.maxFileBytes) {
      // Too big to read now, so it can be neither judged nor reverted. Report it
      // only if it demonstrably moved — otherwise every project with a large
      // lockfile emits a coverage warning on every single bash turn.
      if (existedBefore ? changedStat : true) uncovered.push(rel);
      return;
    }

    const current = readText(abs, sweep.limits.maxFileBytes);
    if (current === null) return; // binary or unreadable — out of scope entirely

    if (existedBefore && authorised === undefined) {
      // Known to have existed, but no content is held for it — the content
      // baseline was capped. Report only a real change; guessing here is what
      // deleted pre-existing files in the first version of this module.
      uncovered.push(rel);
      return;
    }

    if (!existedBefore) {
      // Created this turn. Judged on its own content REGARDLESS of authorisation,
      // and BEFORE the unchanged-since-authorised skip below — that skip is what
      // made the laundering hole real: the shell writes a skeleton, one edit_file
      // fills a single body (legitimately allowed, since monotone progress is
      // measured against the skeleton itself), the file is stamped as authorised,
      // and a content comparison then matches and skips it forever.
      if (!detectStub(rel, current).isStub) return;
      // Rename IS the backup here — the file's own bytes move to the preserved
      // location. Writing a copy first and then renaming over it, as this did
      // originally, paid a full write that the rename immediately discarded and
      // left a stray duplicate whenever the rename failed.
      const dest = backupRoot === null ? null : backupDest(backupRoot, rel);
      if (dest === null) {
        failed.push(rel);
        return;
      }
      try {
        const target = freeDest(dest);
        mkdirSync(dirname(target), { recursive: true });
        renameSync(abs, target);
        removed.push(rel);
      } catch {
        failed.push(rel);
      }
      return;
    }

    if (authorised === current) return; // untouched since we last saw it

    // Pre-existing and changed. Act only when the change made it STRICTLY WORSE:
    // a formatter or codemod that rewrites an already-stubby file without
    // emptying anything further must survive.
    const after = detectStub(rel, current);
    if (!after.isStub) return;
    const beforeVerdict = detectStub(rel, authorised as string);
    // A baseline the detector could not judge (over its scan cap, or an exempt
    // extension) reports zero callables, which would make ANY later content with
    // one empty body read as "strictly worse". No comparison, no action.
    if (beforeVerdict.callables === 0) return;
    if (emptyCount(after) <= emptyCount(beforeVerdict)) return;
    if (backupRoot === null || backup(backupRoot, rel, current) === null) {
      failed.push(rel);
      return;
    }
    try {
      // Temp-then-rename, the pattern this subsystem already uses elsewhere: an
      // in-place truncating write that dies mid-way leaves a mangled file whose
      // good content existed only in a JS string the crash takes with it.
      const tmp = `${abs}.uap-sweep-tmp`;
      writeFileSync(tmp, authorised as string, 'utf-8');
      renameSync(tmp, abs);
      reverted.push(rel);
    } catch {
      failed.push(rel);
    }
  });

  return {
    reverted,
    removed,
    uncovered,
    failed,
    note: buildNote({ reverted, removed, uncovered, failed }),
  };
}

/**
 * Filenames reach the model verbatim, and POSIX allows newlines and brackets in
 * them — which would let a crafted name inject harness-shaped lines into a note
 * that flows into the retry prompt, the acceptance judge and the operator log.
 */
function safeName(rel: string): string {
  return rel.replace(/[\r\n\][]/g, '_').slice(0, 120);
}

function list(paths: string[], max: number): string {
  const shown = paths.slice(0, max).map(safeName).join(', ');
  return paths.length > max ? `${shown}, +${paths.length - max} more` : shown;
}

function buildNote(r: {
  reverted: string[];
  removed: string[];
  uncovered: string[];
  failed: string[];
}): string {
  const parts: string[] = [];
  const touched = [...r.removed, ...r.reverted];
  if (touched.length > 0) {
    const verb =
      r.removed.length > 0 && r.reverted.length > 0
        ? 'removed/reverted'
        : r.removed.length > 0
          ? 'removed'
          : 'reverted';
    // The previous content IS preserved, but the location is deliberately not
    // named: it lives under `.uap/`, the one directory read_file and list_dir
    // refuse, and pointing an agent at a path the harness then hides is a
    // harness bug this codebase has already had to fix once.
    parts.push(
      `[blocked: ${touched.length} file(s) changed outside the write tools were SKELETONS — ` +
        `an API surface with empty function bodies — and have been ${verb}: ${list(touched, 8)}. ` +
        `Writing files through the shell does not bypass this check. Write the REAL ` +
        `implementation with write_file — each function must contain the logic that makes ` +
        `it work. If a file is deliberately a skeleton, give each body an explicit ` +
        `throw new Error('TODO: <what>') instead of an empty block.]`
    );
  }
  if (r.failed.length > 0) {
    // A guard that could not act must never look like a guard that found nothing.
    parts.push(
      `[warning: the substance check could not act on ${r.failed.length} file(s) ` +
        `(${list(r.failed, 4)}) — they were left as-is.]`
    );
  }
  if (r.uncovered.length > 0) {
    // Gated on files that actually CHANGED, not on `truncated`. A capped baseline
    // where nothing moved is complete coverage in every way the model cares
    // about; emitting on the cap alone put a warning on every bash turn of every
    // project with a big lockfile, in a prompt slot that is head-truncated.
    // `truncated` remains on the sweep for callers and tests, as a fact about the
    // baseline rather than a claim about coverage.
    parts.push(`[note: ${r.uncovered.length} changed file(s) were too large to check this turn: ${list(r.uncovered, 4)}.]`);
  }
  return parts.join('\n');
}

/**
 * Put the note FIRST — but never ahead of a protocol marker.
 *
 * The retry prompt includes the previous output through `truncateHead`, which
 * keeps the leading 3000 characters, so a note appended after a long turn summary
 * is exactly the part that gets cut. That argues for prepending.
 *
 * Against it: `decodeBudgetStop` only recognises the context-budget marker within
 * the first 512 characters, and this note routinely exceeds that on its own. A
 * budget-stopped turn that was also swept would therefore stop being recognised
 * as budget-stopped — which silently disables the epic controller's rail-sizing
 * split, on exactly the long shell-using sessions that blow the rail. So when the
 * output carries that marker, the note goes after the marker's own line: the
 * marker keeps position 0, and the note is still near the front.
 */
export function prependSweepNote(output: string, outcome: SweepOutcome): string {
  if (!outcome.note) return output;
  if (output.startsWith(CONTEXT_BUDGET_MARKER)) {
    const nl = output.indexOf('\n');
    return nl === -1
      ? `${output}\n${outcome.note}`
      : `${output.slice(0, nl)}\n${outcome.note}${output.slice(nl)}`;
  }
  return `${outcome.note}\n${output}`;
}
