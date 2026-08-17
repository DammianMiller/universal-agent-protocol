#!/usr/bin/env python3
"""schema-diff-gate enforcer: schema/pool changes must pass uap schema-diff."""
from __future__ import annotations
import json
import os
import re
import shutil
import sqlite3
import subprocess
import tempfile
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import (  # noqa: E402
    _clean_env,
    emit,
    parse_cli,
    repo_root,
    run,
    worktree_root,
)

# DOTALL because `.` otherwise stops at a newline, and a newline is a legal
# character in a path. `migrations/a\nb.sql` matched nothing, so the gate did
# not consider it watched and never examined the column drop inside it. Git
# hides this by C-quoting such names in its default output; the -z enumeration
# above hands us the real bytes, which is where the gap became visible.
WATCHED_RE = re.compile(
    r"(migrations/.*\.sql|infra/postgres-spock/|infra/helm_charts/[^/]*pgdog|"
    r"infra/helm_charts/[^/]*cnpg|infra/helm_charts/[^/]*redis|"
    r"infra/helm_charts/[^/]*envoy|infra/helm_charts/[^/]*sentinel)",
    re.I | re.S,
)
# NOTE: bare "Bash" used to be in this set, which made EVERY shell command a
# gate point — including the `uap schema-diff` remedy itself (self-deadlock).
# Gate only actual commit/push commands (main() also inspects cmd content).
COMMIT_OPS = {"git-commit", "git commit"}
RECENT_SEC = 3600


def merge_in_progress(root: Path) -> bool:
    """Whether a merge is underway — invocation-constant, so resolved ONCE.

    This used to be re-derived per watched file, spawning a `git rev-parse`
    for each one on the hot path of every commit and push, purely to learn
    "not a merge". A merge touching 30 migrations paid 30 spawns.
    """
    rc, git_dir_out, _ = run(["git", "rev-parse", "--absolute-git-dir"], cwd=root)
    if rc != 0:
        return False
    return (Path(git_dir_out.strip()) / "MERGE_HEAD").exists()


def merge_verbatim(root: Path, path: str) -> bool:
    """During a merge, a staged watched file that is byte-identical to the
    incoming MERGE_HEAD version was not authored on this branch — it was
    reviewed and gated on its own branch and arrives verbatim. Gating it here
    forced a schema-diff re-pass for content the merge cannot change (hit on
    the 2026-08-16 pay2u #3153 conflict-resolution merge, where migrations
    from already-merged main blocked the merge commit)."""
    rc, staged_sha, _ = run(["git", "rev-parse", f":{path}"], cwd=root)
    rc2, theirs_sha, _ = run(["git", "rev-parse", f"MERGE_HEAD:{path}"], cwd=root)
    if rc != 0 or rc2 != 0 or staged_sha.strip() != theirs_sha.strip():
        return False

    # The INDEX matching theirs is not enough: `git commit -a` and
    # `git commit -- <path>` commit the WORKING TREE. Exempting on the index
    # alone let an unstaged edit ride along ungated -- reproduced: an appended
    # `DROP TABLE users;` yielded {"allowed": true, "reason": "no watched
    # schema/pool paths in diff"} while `commit -am` would have committed the
    # drop.
    #
    # `git diff --quiet` rather than hashing the file ourselves: it exits 0
    # exactly when the worktree copy matches the index, using git's own
    # comparison. Hashing followed symlinks (so a verbatim merged symlink never
    # matched), failed outright on a dangling link or a sparse/skip-worktree
    # path, and re-ran clean filters on large files against a 5s timeout --
    # every one of those a FALSE BLOCK on a legitimate merge.
    rc3, _, _ = run(["git", "diff", "--quiet", "--", path], cwd=root)
    return rc3 == 0


def touched_watched_paths(root: Path) -> list[str]:
    """Watched paths in the pending change, as their real bytes.

    `-z` rather than plain --name-only: git C-quotes any path containing a
    newline, tab, quote, backslash or non-ASCII byte, emitting the literal
    string `"migrations/a\\nb.sql"` -- quotes and escapes included. That string
    was forwarded to the checker as a filename, no such file could be opened,
    the checker reported it clean, and the gate allowed a column drop.
    Reproduced with newline, tab, quote, backslash and unicode names. `-z`
    emits NUL-terminated raw paths and never quotes.
    """
    rc, out, _ = run(["git", "diff", "--name-only", "-z", "HEAD"], cwd=root)
    if rc != 0:
        return []
    rc2, staged, _ = run(["git", "diff", "--name-only", "-z", "--cached"], cwd=root)
    all_files = (out + "\0" + (staged if rc2 == 0 else "")).split("\0")
    # dict.fromkeys dedupes while preserving order: a file that is both
    # unstaged and staged appeared twice, and the gate's reason line listed it
    # twice ("covers: x, x"), which reads like two files were covered.
    watched = list(dict.fromkeys(f for f in all_files if f and WATCHED_RE.search(f)))
    # Nothing watched is the overwhelmingly common case; probing git there
    # would make the hoist a net cost rather than a saving.
    if not watched or not merge_in_progress(root):
        return watched
    return [f for f in watched if not merge_verbatim(root, f)]


def _parse_marker_ts(raw) -> float | None:
    """Epoch seconds for a marker timestamp, or None when it cannot be read.

    Stored as UTC ISO-8601 with a trailing Z; parsed as UTC because
    time.mktime would read them as local time and expire the marker hours
    early or late depending on the host timezone.
    """
    if not isinstance(raw, str):
        return None
    try:
        import calendar
        return calendar.timegm(time.strptime(raw[:19], "%Y-%m-%dT%H:%M:%S"))
    except Exception:  # noqa: BLE001
        return None


_HEX_RE = re.compile(r"^[0-9a-f]{40}$|^[0-9a-f]{64}$")


def marker_files(content: str) -> dict | None:
    """{path: sha7} from a content-scoped marker, or None if it is not one.

    None means "cannot judge coverage": a legacy marker (written before this
    change, or by an older installed CLI), or one whose file list was truncated
    because the change was enormous. Callers must fall back to the time window
    rather than block — an operator running the documented remedy has no way to
    produce a covering marker for either case, and this gate has already
    self-deadlocked three times.
    """
    _, sep, tail = content.partition("| files: ")
    if not sep or tail.startswith("("):        # "(none changed)" / "(truncated: N files)"
        return None
    entries = [e.strip() for e in tail.split(",") if e.strip()]
    scoped = {}
    identified = 0
    for e in entries:
        path, at, sha = e.rpartition("@")
        if at and _HEX_RE.match(sha):
            scoped[path] = sha
            identified += 1
        else:
            # A bare or unparsable entry means THIS PATH has no verified
            # identity -- not that the whole marker is legacy. Returning None
            # here let one `git rm` (its path cannot be hashed, so it renders
            # bare) disable content scoping for the entire commit, and let a
            # filename containing the delimiters inject a forged entry that
            # overwrote a real one. Record the path with no sha so
            # uncovered_paths treats it as uncovered.
            scoped.setdefault(e.rpartition("@")[0] or e, "")
    # Only a marker with NO identified entry at all is a legacy marker.
    return scoped if identified else None


def uncovered_paths(root: Path, watched: list, scoped: dict, use_worktree: bool = False) -> list:
    """Watched paths whose CURRENT bytes the marker does not vouch for.

    Only paths we can positively hash are judged. One that cannot be hashed
    (deleted, unreadable, sparse) is left out: the CLI could not have recorded
    it either, so blocking on it would be unclearable.

    One `hash-object` per watched path. The watched set is what the commit
    actually touches -- a handful of files -- and _common.run() has no stdin
    channel to batch through.
    """
    bad = []
    for path in watched:
        # THE version this commit will store -- not every version that exists.
        # `git commit` stores the INDEX; `git commit -a` stores the WORKTREE.
        # Requiring one recorded sha to equal BOTH made ordinary partial
        # staging (`git add -p`, or staging then continuing to edit) an
        # unclearable block: one value cannot equal two, and re-running the
        # remedy reproduced the same marker. Verified before this fix.
        actual = ""
        if not use_worktree:
            rc, staged, _ = run(["git", "rev-parse", f":{path}"], cwd=root)
            if rc == 0:
                actual = staged.strip()
        if not actual and (root / path).is_file():
            rc2, wt, _ = run(["git", "hash-object", "--", path], cwd=root)
            if rc2 == 0:
                actual = wt.strip()
        if not actual:
            continue                       # nothing hashable: unknown, never a block
        if scoped.get(path) != actual:
            bad.append(path)
    return bad


def schema_diff_ok(root: Path) -> list | None:
    """Contents of every in-window pass marker, or None if there are none.

    A LIST, because concurrent worktrees share one database and any one of
    their markers may be the one that covers the bytes in front of us. The
    freshness window is applied here, per candidate.

    Every miss must return None, not False: main() consumes this value, and a
    stray bool crashed the enforcer. On a commit or push the hook now turns
    that crash into a refusal rather than an ALLOW, so the cost is a blocked
    commit instead of a silent bypass -- still a bug, and still worth the type.
    """
    db = root / "agents" / "data" / "memory" / "short_term.db"
    if not db.exists():
        return None
    try:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=1.0)
        # `uap memory store` writes to `memories` (type 'action'), while older
        # UAP wrote session rows to `session_memories` — accept the marker from
        # either table so the documented remedy actually clears the gate.
        newest = None
        candidates: list = []
        for table in ("memories", "session_memories"):
            try:
                # ANCHORED to the recorder's fixed prefix. The old
                # '%schema-diff%pass%' matched those substrings anywhere in any
                # memory -- including this gate's OWN refusal text ("...require
                # `uap schema-diff` to pass"), so an agent storing the blocker
                # as a lesson unblocked itself, and a note saying the diff
                # FAILED cleared it just as well. Verified both.
                # ALL recent markers, not just the newest. Every worktree
                # writes to the same main-checkout database, so with LIMIT 1 two
                # concurrent worktrees invalidated each other's markers forever:
                # A records, B records, A is blocked by B's marker, A re-records,
                # B is blocked. A livelock this repo's whole .worktrees workflow
                # would hit, and a regression versus the old time-only rule.
                cur = con.execute(
                    f"SELECT timestamp, content FROM {table} "
                    "WHERE content LIKE 'schema-diff pass: base %' "
                    "ORDER BY id DESC LIMIT 20"
                )
                _rows = cur.fetchall()
                # Compare PARSED epochs, not raw strings. The two tables need
                # not share a timestamp format, and a lexicographic winner that
                # then fails to parse returned False without ever considering
                # the runner-up: one legacy row sorting above ISO-8601 (say
                # "2026/08/17", '/' > '-') would out-rank every correct marker
                # forever, and re-running the remedy could not help because it
                # writes to the other table. Gate shut permanently, no waiver.
                # A malformed row is ignored, never authoritative.
                for r in _rows:
                    ts_val = _parse_marker_ts(r[0])
                    if ts_val is None:
                        continue
                    age = time.time() - ts_val
                    if not (-5 <= age < RECENT_SEC):
                        continue
                    candidates.append(r[1] if len(r) > 1 else "")
                    if newest is None or ts_val > newest:
                        newest = ts_val
            except sqlite3.Error:
                continue
        con.close()
        if not candidates:
            return None
        return candidates
    except sqlite3.Error:
        return None


INLINE_GUARD = "UAP_SCHEMA_DIFF_INLINE"
# Comfortably inside policy-tools' 30s enforcer budget. At 60s a slow checker
# meant the ENFORCER was killed first, which on the TS path is still an ALLOW
# and on the shell-hook path is now a hard block on the commit -- a bypass or a
# deadlock depending which caller you are under, and neither is the intended
# fallback. 400 watched files measured at 6.3s for one source. The layers nest
# innermost-shortest: this x 2 sources (20s) < the hook's per-enforcer bound
# (30s, UAP_ENFORCER_TIMEOUT) < the harness hook budget. Raising this without
# raising those turns a slow check into a killed enforcer, which on a commit is
# now a refusal.
INLINE_TIMEOUT = 10.0
# Verdict shapes this gate knows how to read (SCHEMA_DIFF_CONTRACT in the CLI).
KNOWN_CONTRACTS = (1,)
# Passed to the checker. Everything else -- API keys, tokens, proxy secrets --
# is withheld: the child is a subprocess chosen partly by filesystem contents,
# and it has no business holding the agent's credentials.
CHILD_ENV_KEEP = ("PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "NODE_OPTIONS", "NODE_PATH")


def divergent_paths(root: Path, watched: list) -> list:
    """Watched paths whose worktree copy differs from the index.

    `git diff --quiet -- <path>` exits 0 exactly when the two match, using
    git's own comparison rather than a hash (which followed symlinks, failed on
    dangling links and sparse paths, and re-ran clean filters).
    """
    out = []
    for path in watched:
        rc, _, _ = run(["git", "diff", "--quiet", "--", path], cwd=root)
        if rc != 0:
            out.append(path)
    return out


def sources_to_check(root: Path, watched: list) -> list:
    """Which byte-sources this commit could possibly store.

    Previously this was inferred from the command string, and the inference was
    wrong in both directions -- each direction a demonstrated bypass:

      * MISSED worktree forms. `git commit -- <path>`, `--only`, `--include`,
        `-o` and `-i` all store the WORKTREE copy of the named paths. None
        contains `-a` or `--all`, so the gate checked the index while git
        committed the worktree. Confirmed by committing: HEAD afterwards held
        the dropped column the gate had just cleared.
      * FALSE worktree matches. The command is lowercased whole, so the `-A` in
        `git add -A && git commit -m x` matched the short-flag pattern and the
        gate read the WORKTREE for a commit that stores the INDEX. Stage the
        break, restore the file on disk, commit: allowed.

    Enumerating git's commit forms correctly is the trap, not the fix -- the
    space is larger than it looks and the file had already litigated it twice.
    There are only ever two candidate byte-strings per path. When they are
    identical the question is moot; when they differ, check BOTH and refuse if
    either is breaking. That removes the inference, and with it the whole class.

    The cost is a second checker run only when a watched schema file is staged
    and then edited again -- and in that state a breaking worktree copy is worth
    surfacing regardless of which form the operator eventually types.
    """
    return ["index", "worktree"] if divergent_paths(root, watched) else ["index"]


def is_uap_checkout(root: Path) -> bool:
    """Is `root` the UAP repo itself, rather than a project that uses UAP?"""
    try:
        pkg = json.loads((root / "package.json").read_text())
    except Exception:  # noqa: BLE001 - missing, unreadable, not JSON
        return False
    return isinstance(pkg, dict) and pkg.get("name") == "@miller-tech/uap"


def cli_argv(root: Path) -> list | None:
    """How to invoke the checker.

    The INSTALLED cli first, deliberately. Preferring `<root>/dist/bin/cli.js`
    handed the verdict to a file inside the tree being gated: `dist/` is
    gitignored build output, is on self-protect's "reconstructible, do not
    guard" list, and is a conventional path in any Node project. Three lines
    written there and the gate reports whatever they print -- an easier forgery
    than the marker row this design replaced, and in a consumer repo it means
    committing a migration executes that project's unrelated build output.

    The local build is still preferred when `root` is the UAP checkout itself,
    because there developing the checker and running the gate are the same act
    and an installed release would be the stale copy. That is a deliberate,
    narrow exception: in the UAP repo, `dist/` is already what `npm i -g .`
    installs.
    """
    uap = shutil.which("uap")
    node = shutil.which("node")
    local = root / "dist" / "bin" / "cli.js"
    if is_uap_checkout(root) and local.is_file() and node:
        return [node, str(local)]
    if uap:
        return [uap]
    return None


def blob_sha(root: Path, path: str, source: str) -> str:
    """The blob the given source holds for `path`, or "" if there is none."""
    if source == "index":
        rc, out, _ = run(["git", "rev-parse", f":{path}"], cwd=root)
    else:
        rc, out, _ = run(["git", "hash-object", "--", path], cwd=root)
    out = (out or "").strip()
    return out if rc == 0 and re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", out) else ""


def inline_schema_diff(root: Path, watched: list, source: str) -> list | None:
    """Run the checker over `watched` and return the breaking findings.

    Returns a list (empty means "checked, nothing breaking"), or None meaning
    "no answer" -- and the caller must then fall back rather than read silence
    as a pass.

    None covers every kind of not-answered: no CLI, a crash, a timeout,
    unparseable output, an unknown contract, ran=false, a missing entry, a
    file the checker could not read, or one no analyser understood. That last
    pair is what the first version got wrong. It asked only whether the paths
    it sent came back -- a comparison between two copies of its own argument,
    which could fail on a whitespace artefact and nothing else. Meanwhile a
    helm chart (no analyser exists), a file git C-quoted (could not be opened)
    and a brand-new migration all returned an empty change list, and the gate
    published that as "no breaking changes".
    """
    argv = cli_argv(root)
    if argv is None:
        return None

    env = {k: v for k, v in _clean_env().items() if k in CHILD_ENV_KEEP}
    # Tells a nested gate to skip its own inline run. NOT an allow: forging
    # this must cost an attacker nothing more than the fallback they could
    # have had anyway.
    env[INLINE_GUARD] = "1"

    tmp = None
    try:
        # NUL-separated via a file, so no filename can corrupt the list --
        # a comma split one path into two, and git's C-quoting of newlines and
        # unicode produced paths that do not exist.
        fd, tmp = tempfile.mkstemp(prefix="uap-schema-paths-")
        with os.fdopen(fd, "w") as fh:
            fh.write("\0".join(watched))
        proc = subprocess.run(
            argv
            + [
                "schema-diff",
                "--json",
                "--base",
                "HEAD",
                "--paths-from",
                tmp,
                "--source",
                source,
            ],
            cwd=str(root),
            env=env,
            capture_output=True,
            text=True,
            timeout=INLINE_TIMEOUT,
        )
    except Exception:  # noqa: BLE001 - timeout, ENOENT, anything
        return None
    finally:
        if tmp:
            try:
                os.unlink(tmp)
            except OSError:
                pass

    lines = [ln for ln in (proc.stdout or "").splitlines() if ln.strip()]
    if not lines:
        return None
    try:
        verdict = json.loads(lines[-1])
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(verdict, dict):
        return None
    if verdict.get("contract") not in KNOWN_CONTRACTS:
        return None
    if verdict.get("ran") is not True:
        return None

    entries = verdict.get("files")
    if not isinstance(entries, list):
        return None
    by_path = {}
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("path"), str):
            return None
        by_path[entry["path"]] = entry

    findings = []
    for path in watched:
        entry = by_path.get(path)
        if entry is None:
            return None
        # It must have read the same bytes this commit will store. The sha is
        # re-derived here rather than taken on trust.
        expected = blob_sha(root, path, source)
        if entry.get("sha") != expected:
            return None
        # "Nothing breaking" is only meaningful from an analyser that
        # understood the file.
        if entry.get("analysed") is not True:
            return None
        if not expected:
            # This source holds no blob for the path -- the commit REMOVES it.
            # An empty sha is therefore not "could not read"; it is the
            # deletion itself, and the checker must have reported it as
            # breaking. If it did not, it was not looking at a deletion and we
            # have no idea what it was looking at.
            if not entry.get("breaking"):
                return None
        breaking = entry.get("breaking")
        if not isinstance(breaking, list):
            return None
        if breaking:
            findings.append(f"{path}: " + "; ".join(str(c) for c in breaking[:3]))
    return findings


def breaking_waived(root: Path, paths: list) -> bool:
    """A committed waiver that NAMES the paths whose break is intended.

    Three properties, each of which the first version lacked and each of which
    was demonstrated to matter:

      committed -- `git cat-file -e HEAD:<path>`. The previous check was
        `Path.is_file()` on the working tree, and policies/waivers/ is on
        self-protect's PROTECTED_EXEMPT list precisely so agents CAN write
        there (the carve-out was justified when a waiver only satisfied
        expert-review). `touch policies/waivers/x-schema-diff.md` -- an empty
        file, never committed -- cleared every breaking change. Verified.
      scoped -- the waiver must name each path it excuses, so one file cannot
        silently disarm the gate repo-wide and permanently.
      resolved against the WORKTREE -- the refusal tells the operator to write
        this file, this project mandates that all edits happen in a worktree,
        and the previous version read the main checkout, where the file they
        just wrote does not exist. That is the repo_root()/worktree_root()
        substitution already fixed twice, in expert_review_required and
        local_build_before_push.
    """
    waivers = root / "policies" / "waivers"
    if not waivers.is_dir() or not paths:
        return False
    for waiver in sorted(waivers.glob("*schema-diff*.md")):
        rel = waiver.relative_to(root).as_posix()
        rc, _, _ = run(["git", "cat-file", "-e", f"HEAD:{rel}"], cwd=root)
        if rc != 0:
            continue  # uncommitted: not reviewable, not a waiver
        try:
            body = waiver.read_text(errors="replace")
        except OSError:
            continue
        if all(p in body for p in paths):
            return True
    return False


def legacy_marker_covers(marker: str, named: str, watched: list) -> bool:
    """Does a marker with no per-file SHAs excuse these paths?

    Three shapes, three answers -- the previous version treated the first two
    as one and got both wrong in turn:

      `(none changed)`   The run examined ZERO files. It is evidence of the
        opposite of coverage, and accepting it made
        `git stash && uap schema-diff && git stash pop` into an hour-long
        skeleton key needing no database tampering at all.
      `(truncated: N files)`  The run examined N files but the list was too
        long to record. Coverage is unknowable, not absent; refusing it would
        block a large legitimate change with no way to make the list shorter.
      no `| files: ` section  The previous CLI release's format. Refusing it
        deadlocks every operator still on that release: the remedy the gate
        prints runs their CLI, which writes exactly this format again. Where
        that format states a count, honour it -- "0 schema file(s) checked" is
        `(none changed)` wearing an older coat.
    """
    if named.startswith("(none"):
        return False
    if named.startswith("("):
        return True  # (truncated: N files)
    if named:
        listed = {e.strip() for e in named.split(",") if e.strip()}
        # Exact membership, not substring: `migrations/1.sql` was "covered" by
        # a marker naming `migrations/1.sql.bak`.
        return set(watched) <= listed
    count = re.search(r"(\d+)\s+schema file\(s\) checked", marker)
    if count:
        return int(count.group(1)) > 0
    return True  # genuinely unknown legacy shape: PRESERVE over deadlock


def main() -> None:
    op, args = parse_cli()
    cmd = (args.get("command") or "").lower()
    is_commit = op in COMMIT_OPS or "git commit" in cmd or "git push" in cmd
    if not is_commit:
        emit(True, "not a commit/push gate point")

    # git diff runs against the working tree; short_term.db lives in MAIN_ROOT
    watched = touched_watched_paths(worktree_root())
    if not watched:
        emit(True, "no watched schema/pool paths in diff")

    # Run the checker rather than look for evidence that someone ran it.
    #
    # The stored-marker design could never close the gap between what a past
    # run examined and what this commit contains: three review rounds went into
    # binding a marker to content, commit form, and freshness, and each fix
    # exposed the next seam. Running the check here removes the gap instead of
    # narrowing it -- there is no interval in which the recorded bytes and the
    # committed bytes can diverge, because they are the same read.
    # Inside the gate's own checker run, skip the inline layer -- otherwise a
    # git hook that re-entered the policy layer would call the gate, which
    # would call the checker again. Deliberately NOT an allow: this env var
    # travels with the shell, and the first version emitted allowed:true here
    # before looking at anything, which made `UAP_SCHEMA_DIFF_INLINE=1` a
    # complete off-switch for a security control. Skipping to the fallback
    # costs a forger exactly what they already had.
    inline_ok = os.environ.get(INLINE_GUARD) != "1"

    findings = []
    answered = False
    checked = []
    if inline_ok:
        for source in sources_to_check(worktree_root(), watched):
            result = inline_schema_diff(worktree_root(), watched, source)
            if result is None:
                answered = False
                break
            answered = True
            checked.append(source)
            # Attribute the finding. When the index is clean and an unstaged
            # edit is the breaking one, the operator needs to be told that --
            # otherwise the refusal looks like it is about the change they
            # just staged, and the obvious remedies (stash it, finish it,
            # stage it) are not obvious at all.
            findings.extend(f"[{source}] {f}" for f in result)

    if answered:
        where = " and ".join(checked)
        if not findings:
            emit(
                True,
                f"schema-diff ran on the {where} content of "
                + ", ".join(watched[:5])
                + ": no breaking changes",
            )
        broken = sorted({f.split("] ", 1)[1].split(":", 1)[0] for f in findings})
        if breaking_waived(worktree_root(), broken):
            emit(
                True,
                "breaking schema change waived by a committed "
                "policies/waivers/*schema-diff*.md naming "
                + ", ".join(broken[:5])
                + ": "
                + " | ".join(findings[:5]),
            )
        emit(
            False,
            f"schema-diff-gate: BREAKING schema change in the {where} content -- "
            + " | ".join(findings[:5])
            + ". Make it additive (nullable, or NOT NULL with a DEFAULT), or commit a"
            + " policies/waivers/<name>-schema-diff.md naming "
            + ", ".join(broken[:3])
            + ".",
        )

    # The checker could not answer -- no CLI, a crash, a timeout, or an
    # examined set that did not cover everything watched. Fall through to the
    # behaviour that shipped: a recorded pass, or a refusal naming the remedy.
    # The inline check only ever ADDS precision on top of this; it never
    # subtracts a refusal, because a checker that cannot run is not evidence
    # that the change is safe.
    markers = schema_diff_ok(repo_root())
    if markers:
        stale = None
        for marker in markers:
            scoped = marker_files(marker)
            if scoped is None:
                # LEGACY or truncated marker (older CLI, or a change too large
                # to enumerate): time-window only, as before this change
                # (PRESERVE). It excuses only what it NAMES -- a blanket allow
                # meant one un-upgraded CLI anywhere in the fleet switched
                # content scoping off repo-wide for an hour.
                named = marker.partition("| files: ")[2]
                if legacy_marker_covers(marker, named, watched):
                    emit(
                        True,
                        "recent schema-diff pass on record; watched paths: "
                        + ", ".join(watched[:5]),
                    )
                continue
            # Same reasoning as sources_to_check: when the index and the
            # worktree disagree, a marker must vouch for BOTH, because the
            # command form that decides between them cannot be read reliably
            # off the command string.
            missed = []
            for src in sources_to_check(worktree_root(), watched):
                missed.extend(
                    uncovered_paths(worktree_root(), watched, scoped, src == "worktree")
                )
            if not missed:
                emit(
                    True,
                    f"schema-diff pass covers the committed content of: {', '.join(watched[:5])}",
                )
            if stale is None:
                stale = missed
        emit(
            False,
            "schema-diff-gate: no recent pass covers the CURRENT content of "
            + ", ".join((stale or watched)[:5])
            + " (changed since it ran). Re-run `uap schema-diff` and re-commit.",
        )

    emit(
        False,
        "schema-diff-gate: changes to "
        + ", ".join(watched[:5])
        + " require `uap schema-diff` to pass (within 1h). Run it and re-commit.",
    )


if __name__ == "__main__":
    # A crash must not read as consent. The hook maps a non-zero exit or
    # unparseable output to ALLOW for every enforcer except self-protect and,
    # since the fail-closed net was widened, this one on a commit or push
    # (.claude/hooks/uap-policy-gate.sh). Two reachable crashes were found by
    # review, both TypeErrors on a malformed verdict. Emitting a refusal here
    # is still the right backstop: it keeps the outcome correct on the paths
    # the hook does NOT cover, and produces a reasoned message rather than a
    # bare block on the ones it does.
    try:
        main()
    except SystemExit:
        raise  # emit() exits through here
    except Exception as exc:  # noqa: BLE001
        emit(
            False,
            "schema-diff-gate: the gate itself failed "
            f"({type(exc).__name__}: {exc}) -- refusing rather than allowing "
            "unverified. Re-run, and report this if it persists.",
        )
