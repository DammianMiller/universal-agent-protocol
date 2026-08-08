/**
 * Two deliver runs on NESTED project roots edit one source tree.
 *
 * The lock lives at `<projectRoot>/.uap/deliver.lock`, so it can only ever see
 * a run that named the SAME root. On 2026-08-08 two runs took their own locks
 * and ran for ~2h against one tree:
 *
 *   root A: .../cognition-engine/src/rust-pg-ext   (started 20:51)
 *   root B: .../cognition-engine                   (started 20:57)
 *
 * Both edited `src/rust-pg-ext/src/cooccurrence.rs`. Each turn's gate scored
 * damage the other run had just written — the file flipped between compiling
 * and "unclosed delimiter" for two hours and neither run could converge.
 *
 * Overlap is a property of the SUBTREE, not of the lock path, so the guard has
 * to be keyed across projects.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'fs';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import {
  deliverRootsOverlap,
  findOverlappingDeliverRun,
  acquireDeliverLock,
  lastOverlapBlocker,
} from '../../src/cli/deliver.js';

let registry: string;
let base: string;

beforeEach(() => {
  registry = mkdtempSync(join(tmpdir(), 'uap-active-runs-'));
  base = mkdtempSync(join(tmpdir(), 'uap-nested-root-'));
  process.env.UAP_ACTIVE_RUNS_DIR = registry;
});

afterEach(() => {
  delete process.env.UAP_ACTIVE_RUNS_DIR;
  rmSync(registry, { recursive: true, force: true });
  rmSync(base, { recursive: true, force: true });
});

/**
 * Register a live run at `root`, started `agoS` ago, owned by `pid`.
 *
 * The filename must match the guard's allow-list (16 hex + `.run`) or the
 * entry is ignored — that allow-list is what stops the sweep from unlinking
 * files it did not write.
 */
function registerRun(pid: number, root: string, agoS: number): void {
  const iso = new Date(Date.now() - agoS * 1000).toISOString();
  writeFileSync(entryNameFor(root), `${pid}|${iso}|${root}`);
  // A holder is only believed if it still looks live at its OWN root, so give
  // it the lock + heartbeat a real run would have stamped.
  mkdirSync(join(root, '.uap'), { recursive: true });
  writeFileSync(join(root, '.uap', 'deliver.lock'), `${pid}|${iso}`);
  writeFileSync(join(root, '.uap', 'deliver.heartbeat'), String(Math.floor(Date.now() / 1000)));
}

function entryNameFor(root: string): string {
  const key = createHash('sha1').update(resolve(root)).digest('hex').slice(0, 16);
  return join(registry, `${key}.run`);
}

describe('deliverRootsOverlap', () => {
  it('treats a parent and its nested child root as overlapping', () => {
    expect(deliverRootsOverlap('/srv/app', '/srv/app/src/ext')).toBe(true);
    expect(deliverRootsOverlap('/srv/app/src/ext', '/srv/app')).toBe(true);
  });

  it('treats the identical root as overlapping', () => {
    expect(deliverRootsOverlap('/srv/app', '/srv/app/')).toBe(true);
  });

  it('does NOT collide sibling roots that merely share a name prefix', () => {
    // The bug this guards: a naive startsWith makes /srv/app "contain"
    // /srv/app-two, which would serialise two unrelated projects forever.
    expect(deliverRootsOverlap('/srv/app', '/srv/app-two')).toBe(false);
    expect(deliverRootsOverlap('/srv/app', '/srv/other')).toBe(false);
  });
});

describe('findOverlappingDeliverRun', () => {
  const alivePid = () => process.ppid || 1;

  it('finds an OLDER live run on an ancestor root', () => {
    const parent = join(base, 'app');
    const child = join(parent, 'src', 'ext');
    mkdirSync(child, { recursive: true });
    registerRun(alivePid(), parent, 600);
    const found = findOverlappingDeliverRun(child, 999_999, Date.now());
    expect(found).not.toBeNull();
    expect(found?.root).toBe(parent);
  });

  it('finds an OLDER live run on a descendant root', () => {
    // The live incident's direction: the PARENT started second.
    const parent = join(base, 'app');
    const child = join(parent, 'src', 'ext');
    mkdirSync(child, { recursive: true });
    registerRun(alivePid(), child, 600);
    const found = findOverlappingDeliverRun(parent, 999_999, Date.now());
    expect(found?.root).toBe(child);
  });

  it('ignores a live run on a non-overlapping root', () => {
    const a = join(base, 'app');
    const b = join(base, 'other');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    registerRun(alivePid(), b, 600);
    expect(findOverlappingDeliverRun(a, 999_999, Date.now())).toBeNull();
  });

  it('ignores — and sweeps — an entry whose PID is dead', () => {
    const parent = join(base, 'app');
    const child = join(parent, 'src', 'ext');
    mkdirSync(child, { recursive: true });
    registerRun(0x7ffffff0, parent, 600); // implausible pid, not alive
    expect(findOverlappingDeliverRun(child, 999_999, Date.now())).toBeNull();
    // Without the sweep the registry grows forever and every acquire re-reads it.
    expect(readdirSync(registry)).toHaveLength(0);
  });

  it('yields to the earlier run only — the older one keeps the subtree', () => {
    const parent = join(base, 'app');
    const child = join(parent, 'src', 'ext');
    mkdirSync(child, { recursive: true });
    // Registered run started LATER than us, so we do not defer to it.
    registerRun(alivePid(), parent, 0);
    const asOlder = findOverlappingDeliverRun(child, 999_999, Date.now() - 600_000);
    expect(asOlder).toBeNull();
  });

  it('breaks an exact timestamp tie by pid — antisymmetrically', () => {
    // This is what makes the guard a mutual exclusion. If BOTH sides yield
    // nothing delivers; if NEITHER yields we are back to the incident. Assert
    // both directions of the same tie.
    const parent = join(base, 'app');
    const child = join(parent, 'src', 'ext');
    mkdirSync(child, { recursive: true });
    const pid = alivePid();
    registerRun(pid, parent, 0);
    const theirIso = Date.parse(
      readFileSync(entryNameFor(parent), 'utf8').split('|')[1],
    );
    // We are the higher pid at the same instant → we yield.
    expect(findOverlappingDeliverRun(child, pid + 1, theirIso)).not.toBeNull();
    // We are the lower pid at the same instant → we keep going.
    expect(findOverlappingDeliverRun(child, pid - 1, theirIso)).toBeNull();
  });

  it('does not trust an entry whose holder is abandoned at its own root', () => {
    // PID reuse: the pid is alive but belongs to something else now. Believing
    // it would block every overlapping deliver on the machine, permanently —
    // the exact wedge the per-project lock already had to fix.
    const parent = join(base, 'app');
    const child = join(parent, 'src', 'ext');
    mkdirSync(child, { recursive: true });
    registerRun(alivePid(), parent, 600);
    // Strip the evidence a real holder leaves: no heartbeat, ancient lock.
    rmSync(join(parent, '.uap', 'deliver.heartbeat'));
    const ancient = new Date(Date.now() - 86_400_000).toISOString();
    writeFileSync(join(parent, '.uap', 'deliver.lock'), `${alivePid()}|${ancient}`);
    expect(findOverlappingDeliverRun(child, 999_999, Date.now())).toBeNull();
    expect(readdirSync(registry)).toHaveLength(0);
  });

  it('refuses to treat "/" as a root, which would block every project', () => {
    const child = join(base, 'app', 'src');
    mkdirSync(child, { recursive: true });
    writeFileSync(entryNameFor('/'), `${alivePid()}|${new Date().toISOString()}|/`);
    expect(findOverlappingDeliverRun(child, 999_999, Date.now())).toBeNull();
  });

  it('refuses a negative pid, which process.kill(-1,0) reports as alive forever', () => {
    const parent = join(base, 'app');
    const child = join(parent, 'src', 'ext');
    mkdirSync(child, { recursive: true });
    writeFileSync(entryNameFor(parent), `-1|${new Date().toISOString()}|${parent}`);
    expect(findOverlappingDeliverRun(child, 999_999, Date.now())).toBeNull();
    expect(readdirSync(registry)).toHaveLength(0);
  });

  it('never reads or unlinks a file it did not write', () => {
    // UAP_ACTIVE_RUNS_DIR is caller-controlled; without an allow-list the
    // sweep below is an arbitrary-file delete.
    const child = join(base, 'app', 'src');
    mkdirSync(child, { recursive: true });
    writeFileSync(join(registry, 'id_rsa'), 'PRIVATE KEY');
    writeFileSync(join(registry, 'notes.txt'), 'unrelated');
    expect(findOverlappingDeliverRun(child, 999_999, Date.now())).toBeNull();
    expect(existsSync(join(registry, 'id_rsa'))).toBe(true);
    expect(existsSync(join(registry, 'notes.txt'))).toBe(true);
  });

  it('sweeps a malformed entry rather than trusting it', () => {
    const child = join(base, 'app', 'src');
    mkdirSync(child, { recursive: true });
    writeFileSync(entryNameFor(child), 'garbage-without-fields');
    expect(findOverlappingDeliverRun(child, 999_999, Date.now())).toBeNull();
    expect(readdirSync(registry)).toHaveLength(0);
  });
});

describe('acquireDeliverLock across nested roots', () => {
  it('refuses the second run and leaves no lock behind for it', () => {
    const parent = join(base, 'app');
    const child = join(parent, 'src', 'ext');
    mkdirSync(child, { recursive: true });
    // An older live deliver already owns the parent subtree.
    registerRun(process.ppid || 1, parent, 600);
    expect(acquireDeliverLock(child)).toBeNull();
    // A lock left behind here would name a live pid with no heartbeat, so
    // every later deliver on this root defers until the wedge timeout.
    expect(existsSync(join(child, '.uap', 'deliver.lock'))).toBe(false);
    // And our own registry entry must not outlive the refusal either.
    expect(existsSync(entryNameFor(child))).toBe(false);
  });

  it('names the blocking holder so the caller can follow the right root', () => {
    // Without this the caller is told "already running for THIS project" and
    // sent to --await-run on a root with nothing in flight, which answers
    // "safe to launch" — a relaunch loop.
    const parent = join(base, 'app');
    const child = join(parent, 'src', 'ext');
    mkdirSync(child, { recursive: true });
    const pid = process.ppid || 1;
    registerRun(pid, parent, 600);
    expect(acquireDeliverLock(child)).toBeNull();
    const blocker = lastOverlapBlocker();
    expect(blocker?.root).toBe(parent);
    expect(blocker?.pid).toBe(pid);
  });

  it('still allows a run whose root does not overlap anything live', () => {
    const a = join(base, 'app');
    const b = join(base, 'other');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    registerRun(process.ppid || 1, b, 600);
    const release = acquireDeliverLock(a);
    expect(release).not.toBeNull();
    // A non-overlap refusal must not be misreported as an overlap.
    expect(lastOverlapBlocker()).toBeNull();
    release?.();
    // release() must retract the registry entry, or a FINISHED run keeps
    // owning the subtree and the next overlapping deliver defers to a ghost.
    expect(existsSync(entryNameFor(a))).toBe(false);
  });
});
