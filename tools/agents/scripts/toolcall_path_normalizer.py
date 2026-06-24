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

import os
import re

_PATH_ARG_KEYS = ("file_path", "path", "filePath", "notebook_path")


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
