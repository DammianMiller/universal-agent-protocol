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

import re

_PATH_ARG_KEYS = ("file_path", "path", "filePath", "notebook_path")


def _squash(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())


def _basename(p: str) -> str:
    parts = [x for x in p.split("/") if x]
    return parts[-1] if parts else p


def _parent_dir(p: str) -> str:
    parts = [x for x in p.split("/") if x]
    return "/".join(parts[:-1])


def _dir_compatible(proposed: str, candidate: str) -> bool:
    """Only fix the FILENAME / strip a wrong abs prefix — never RELOCATE across
    structurally-different directory trees. Bare (no-parent) candidates are safe;
    otherwise the parent dirs must match. Blocks the observed harm of snapping
    octopus_invaders/js/config.js to a different known dir."""
    cp = _parent_dir(candidate)
    if cp == "":
        return True
    return _squash(_parent_dir(proposed)) == _squash(cp)


def _edit_distance(a: str, b: str) -> int:
    m, n = len(a), len(b)
    if m == 0:
        return n
    if n == 0:
        return m
    prev = list(range(n + 1))
    for i in range(1, m + 1):
        cur = [i] + [0] * n
        for j in range(1, n + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
        prev = cur
    return prev[n]


def normalize_tool_path(proposed: str, known_paths, max_edit_distance=None):
    """Snap `proposed` to the nearest path in `known_paths` (paths the model used
    correctly earlier). Returns (path, changed, reason). Never invents a target:
    an unmatched path (a legitimate new file) is returned unchanged.
    """
    known = list(dict.fromkeys(known_paths))  # de-dupe, preserve order
    if not proposed or not known:
        return proposed, False, None

    trimmed = proposed.strip()
    if trimmed in known:
        if trimmed != proposed:
            return trimmed, True, "trimmed surrounding whitespace"
        return proposed, False, None

    base = _basename(trimmed)

    def snap(target, reason):
        return (target, True, reason) if target != proposed else (proposed, False, None)

    def unique(cands):
        return cands[0] if len(cands) == 1 else None

    def safe(cands):
        return [k for k in cands if _dir_compatible(trimmed, k)]

    # 1) exact basename (stray dirs)
    hit = unique(safe([k for k in known if _basename(k) == base]))
    if hit:
        return snap(hit, "stray path components removed")
    # 2) case-insensitive basename
    hit = unique(safe([k for k in known if _basename(k).lower() == base.lower()]))
    if hit:
        return snap(hit, "case-normalized to the real filename")
    # 3) punctuation/extension-squashed basename
    sb = _squash(base)
    hit = unique(safe([k for k in known if _squash(_basename(k)) == sb]))
    if hit:
        return snap(hit, "extension/punctuation-normalized to the real filename")
    # 4) edit-distance fallback (only when clearly closest)
    max_d = max_edit_distance if max_edit_distance is not None else max(2, len(base) // 3)
    ranked = sorted(
        ((k, _edit_distance(base.lower(), _basename(k).lower())) for k in safe(known)),
        key=lambda kv: kv[1],
    )
    if ranked and ranked[0][1] <= max_d and (len(ranked) < 2 or ranked[1][1] > ranked[0][1]):
        return snap(ranked[0][0], f"nearest filename by edit distance ({ranked[0][1]})")

    return proposed, False, None


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
