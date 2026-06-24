"""Self-Harness middleware (proxy side) — conversation-aware tool-call path normalizer.

The mechanical fix for the `toolcall.path.garbled` failure: a small quant
fat-fingers the file path in Write/Edit/Read tool calls (case, dropped/altered
extension, stray subdirectory, trailing whitespace), so the edit lands nowhere.
No prompt/param Mod fixes it. A Claude Code PreToolUse hook can't either — it does
NOT honor `updatedInput` (verified empirically 2026-06-23). The proxy, however,
sees the whole conversation: the model almost always Reads the file with the
CORRECT path before mangling it in a later Edit. So we snap a garbled tool-call
path to the nearest path the model already used correctly earlier in the
conversation — filesystem-free, and the proxy is in the request path.

Pure functions; gated by PROXY_TOOLCALL_PATH_NORMALIZE in the proxy. Mirrors the
TS reference at src/self-harness/middleware/path-normalizer.ts.
See docs/design/SELF_HARNESS.md §4 (P2).
"""

import difflib
import os
import re

_PATH_ARG_KEYS = ("file_path", "path", "filePath", "notebook_path")

# Absolute paths a tool call might target. Used to scan/rewrite Bash commands.
_ABS_PATH_RE = re.compile(r"/(?:home|root|Users|tmp|var|opt|srv|mnt)/[A-Za-z0-9._\-/]+")


def _squash(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())


def normalize_tool_path(proposed: str, known_paths=None, max_edit_distance=None):
    """Conservatively correct a garbled file path by snapping ONLY the filename to
    a real sibling that already exists in the SAME, on-disk directory. Returns
    ``(path, changed, reason)``.

    Hardened (2026-06-24) after the heuristic version silently RELOCATED writes
    across projects/worktrees (e.g. ``octopus_invaders/js/config.js`` ->
    ``octopus-invader/space-shooter/js/config.js``), turning a loud,
    self-correcting "no such file" failure into a silent wrong-write that
    clobbered unrelated files. The rules below make a wrong-directory snap
    structurally impossible:

      * absolute paths only — the proxy cannot verify a relative path's cwd;
      * never touch a path that already exists (it is correct);
      * the directory must already exist on disk and is used VERBATIM — we never
        alter, squash, case-fold or cross a directory segment, so a garbled
        directory simply fails loud (as it did before the normalizer existed);
      * snap only when EXACTLY ONE real file in that directory matches the
        basename case-insensitively or punctuation/extension-squashed;
      * no edit-distance guessing.

    ``known_paths`` is accepted for signature/back-compat but the on-disk
    directory is the source of truth. Anything that cannot be verified on disk is
    returned unchanged (fail safe to a clean failure).
    """
    if not proposed:
        return proposed, False, None

    trimmed = proposed.strip()

    # Absolute paths only: the proxy has no reliable cwd for relative paths.
    if not os.path.isabs(trimmed):
        return proposed, False, None

    # Already real? Nothing to fix (covers files, directories, trailing slashes).
    if os.path.exists(trimmed):
        if trimmed != proposed:
            return trimmed, True, "trimmed surrounding whitespace"
        return proposed, False, None

    parent = os.path.dirname(trimmed)
    base = os.path.basename(trimmed)
    # A wrong/garbled DIRECTORY must never be guessed — only fix the filename
    # within a directory that provably exists.
    if not base or not os.path.isdir(parent):
        return proposed, False, None

    try:
        entries = [
            e for e in os.listdir(parent)
            if os.path.isfile(os.path.join(parent, e))
        ]
    except OSError:
        return proposed, False, None

    # Same-directory basename repair only.
    matches = [e for e in entries if e.lower() == base.lower()]
    reason = "case-normalized to the real filename in the same directory"
    if not matches:
        sb = _squash(base)
        matches = [e for e in entries if _squash(e) == sb]
        reason = "extension/punctuation-normalized to the real filename in the same directory"

    # 0 matches = nothing to snap to; >1 = ambiguous -> leave alone (fail safe).
    if len(matches) != 1:
        return proposed, False, None

    target = os.path.join(parent, matches[0])
    if target == proposed:
        return proposed, False, None
    return target, True, reason


def extract_known_paths(anthropic_messages) -> list:
    """Collect file paths the model has already used in the conversation — from
    prior tool_use arguments (file_path/path) and from tool_result text that
    echoes a path. These are the 'real' paths to snap garbled ones toward.
    """
    known: list[str] = []

    def add(p):
        if isinstance(p, str) and p.strip() and p.strip() not in known:
            known.append(p.strip())

    for msg in anthropic_messages or []:
        content = msg.get("content")
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "tool_use":
                inp = block.get("input") or {}
                for key in _PATH_ARG_KEYS:
                    add(inp.get(key))
    return known


def _fuzzy_eq(a: str, b: str) -> bool:
    """Two path components are 'the same intent' if they squash-match or are very
    close (handles octopus_invaders ~ octopus-invaders / octus_invaders / octpus_)."""
    if not a or not b:
        return False
    if _squash(a) == _squash(b):
        return True
    return difflib.SequenceMatcher(None, a.lower(), b.lower()).ratio() >= 0.78


def derive_workdir(known_paths, hint_text: str = "") -> str:
    """Best-effort session working directory, VALIDATED against disk: the deepest
    absolute directory that exists on disk among the paths the model used
    (known_paths) and any absolute paths in hint_text (request/tool-result text).
    Garbled variants (e.g. /home/cogtec/...) don't exist on disk, so the real
    workdir is recovered. Returns '' if none found.
    """
    _STOP = {"/", "/home", "/root", "/tmp", "/var", "/opt", "/srv", "/mnt", "/Users"}
    cands: set[str] = set()
    for p in known_paths or []:
        if isinstance(p, str) and p.startswith("/"):
            cands.add(p if os.path.isdir(p) else os.path.dirname(p))
    if hint_text:
        for m in _ABS_PATH_RE.findall(hint_text):
            cands.add(m if os.path.isdir(m) else os.path.dirname(m))

    existing: list[str] = []
    for c in cands:
        d = c
        while d and d not in _STOP and not os.path.isdir(d):
            d = os.path.dirname(d)
        if d and d not in _STOP and os.path.isdir(d):
            existing.append(d)
    if not existing:
        return ""
    # Prefer the PROJECT ROOT (a dir with .git/.uap/package.json) over a deep
    # subdir — anchoring containment on the root catches more garbles. Walk each
    # existing candidate up to its nearest project-root ancestor.
    _MARKERS = (".git", ".uap", ".uap.json", "package.json")
    roots: set[str] = set()
    for d in existing:
        x = d
        while x and x not in _STOP:
            if any(os.path.exists(os.path.join(x, mk)) for mk in _MARKERS):
                roots.add(x)
                break
            x = os.path.dirname(x)
    pool = roots or set(existing)
    # Deepest (most specific) among the chosen pool.
    return max(pool, key=lambda d: (len(d.split("/")), len(d)))


def _fs_correct_suffix(workdir: str, suffix: str) -> str:
    """Walk `suffix` under `workdir`, fuzzy-correcting each intermediate DIRECTORY
    component to an existing on-disk sibling when the exact name is absent but a
    single close match exists (space-shootr -> space-shooter once that dir
    exists). The final component (the file being created) is left as-is."""
    if not suffix:
        return suffix
    parts = [x for x in suffix.split("/") if x]
    cur = workdir
    out: list[str] = []
    for i, comp in enumerate(parts):
        nxt = os.path.join(cur, comp)
        if i == len(parts) - 1 or os.path.exists(nxt):
            out.append(comp)
            cur = nxt
            continue
        try:
            cands = [
                e for e in os.listdir(cur)
                if os.path.isdir(os.path.join(cur, e)) and _fuzzy_eq(e, comp)
            ]
        except OSError:
            cands = []
        chosen = cands[0] if len(cands) == 1 else comp
        out.append(chosen)
        cur = os.path.join(cur, chosen)
    return "/".join(out)


def contain_to_workdir(path: str, workdir: str):
    """Snap a garbled in-workdir path back onto `workdir`. Returns
    (new_path, changed, reason). Two garble classes, both handled:

      * mangled absolute PREFIX / workdir name (/home/cogtek -> /home/cogtec,
        octopus_invaders -> octus_invaders) — anchored by a fuzzy match of the
        workdir-name component;
      * mangled SUBDIR name in the suffix (space-shooter -> space-shootr) —
        fuzzy-corrected against the real directories on disk.

    Only ever relocates INTO the workdir, and never touches a path that exists
    elsewhere (the OS sandbox blocks a genuine out-of-workdir write). Safe
    precisely because the sandbox contains any mis-snap to the workdir.
    """
    if not path or not workdir or not path.startswith("/"):
        return path, False, None
    wd = workdir.rstrip("/")

    if path == wd or path.startswith(wd + "/"):
        # Already inside: only fix garbled subdir names against disk.
        suffix = path[len(wd):].lstrip("/")
        reason = "corrected garbled subdir(s) under the workdir"
    elif os.path.exists(path):
        return path, False, None  # a real path elsewhere — don't touch it
    else:
        # Garbled prefix/workdir-name: anchor on a fuzzy workdir-name match.
        wd_name = wd.rsplit("/", 1)[-1]
        parts = [x for x in path.split("/") if x]
        anchor = next(
            (i for i in range(len(parts) - 1, -1, -1) if _fuzzy_eq(parts[i], wd_name)),
            None,
        )
        if anchor is None:
            return path, False, None
        suffix = "/".join(parts[anchor + 1:])
        reason = f"contained garbled out-of-workdir path to '{wd_name}'"

    corrected = _fs_correct_suffix(wd, suffix)
    new = wd + ("/" + corrected if corrected else "")
    if new != path:
        return new, True, reason
    return path, False, None


def contain_tool_uses(tool_uses, workdir: str):
    """Contain garbled out-of-workdir paths to `workdir` — in Write/Edit path args
    AND in Bash command tokens. Returns corrections [(id, key, from, to, reason)].
    """
    corrections = []
    if not workdir:
        return corrections
    for tu in tool_uses:
        if not isinstance(tu, dict) or tu.get("type") != "tool_use":
            continue
        inp = tu.get("input")
        if not isinstance(inp, dict):
            continue
        tu_id = tu.get("id", "")
        for key in _PATH_ARG_KEYS:
            v = inp.get(key)
            if isinstance(v, str):
                nv, changed, reason = contain_to_workdir(v, workdir)
                if changed:
                    inp[key] = nv
                    corrections.append((tu_id, key, v, nv, reason))
        cmd = inp.get("command")
        if isinstance(cmd, str) and "/" in cmd:
            def _sub(m):
                nv, changed, _ = contain_to_workdir(m.group(0), workdir)
                return nv if changed else m.group(0)
            new_cmd = _ABS_PATH_RE.sub(_sub, cmd)
            if new_cmd != cmd:
                inp["command"] = new_cmd
                corrections.append((tu_id, "command", cmd, new_cmd, "contained garbled path(s) in bash command"))
    return corrections


def normalize_tool_uses(tool_uses, known_paths):
    """Normalize path args of a list of Anthropic tool_use blocks in place.
    Returns the list of corrections [(tool_use_id, key, from, to, reason)].
    """
    corrections = []
    for tu in tool_uses:
        if not isinstance(tu, dict) or tu.get("type") != "tool_use":
            continue
        inp = tu.get("input")
        if not isinstance(inp, dict):
            continue
        for key in _PATH_ARG_KEYS:
            v = inp.get(key)
            if not isinstance(v, str):
                continue
            new_v, changed, reason = normalize_tool_path(v, known_paths)
            if changed:
                inp[key] = new_v
                corrections.append((tu.get("id", ""), key, v, new_v, reason))
    return corrections
