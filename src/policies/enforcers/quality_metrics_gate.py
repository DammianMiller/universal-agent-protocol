#!/usr/bin/env python3
"""quality-metrics gate: edits must not introduce NEW or WORSENED metric debt.

A Write/Edit/MultiEdit to a source file whose post-edit content violates the
thresholds in `.uap/quality-metrics.json` is **blocked** — unless the violation
is already recorded in `.uap/quality-baseline.json` at an equal-or-worse value
(the ratchet: existing debt is frozen, new debt is refused).

Fast-path metrics computed here (stdlib-only mirror of src/quality/):
  - LOC per file            (maxLocPerFile, default 500)
  - cyclomatic complexity   (maxCyclomatic, default 22) — heuristic fallback
  - cognitive complexity    (maxCognitive, default 22)  — heuristic fallback
  - explicit any/unknown    (maxAnyTypes, default 0)    — TS/JS/Py

Slow metrics (coverage, CRAP, Halstead, duplication, dead code, mutation) need
external data and are enforced by `uap quality check` at commit/CI time, not
per edit.

The gate is INACTIVE (fails open) when `.uap/quality-metrics.json` is absent —
quality policing is opt-in per project via `uap quality init`. Escape hatch:
UAP_QUALITY_GATE_OFF=1. Mirrors src/quality/{scanner,complexity,baseline}.ts.
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import emit, parse_cli, repo_root, worktree_root  # noqa: E402

PATH_WRITE_OPS = {"Write", "Edit", "MultiEdit", "write", "edit", "multiedit"}

EXT_LANG = {
    ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
    ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
    ".py": "python", ".java": "java", ".cs": "csharp",
    ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp", ".hpp": "cpp", ".hxx": "cpp",
    ".c": "c", ".h": "c", ".rs": "rust", ".go": "go", ".rb": "ruby",
    ".php": "php", ".swift": "swift", ".kt": "kotlin", ".kts": "kotlin", ".scala": "scala",
}

C_DECISION_WORDS = ("if", "for", "while", "case", "catch", "elif")
C_DECISION_OPS = ("&&", "||", "?")
PY_DECISION_WORDS = ("if", "elif", "for", "while", "except", "with", "assert")
PY_DECISION_OPS = ("and", "or")

# Boolean/ternary ops get a flat +1 cognitive (no nesting bump). Keep in
# lockstep with BOOL_OPS in src/quality/complexity.ts.
_BOOL_OPS = frozenset({"&&", "||", "?", "and", "or"})

RE_FUNC_KW = re.compile(r"\b(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(")
RE_NAMED_KW = re.compile(r"\b(?:def|fn|func|fun)\s+([A-Za-z_]\w*)\s*\(")
# Arrow functions assigned to consts — pervasive in modern TS; missing them
# dumps their bodies into the <module> score.
RE_ARROW = re.compile(
    r"^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=]+?)?="
    r"\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{"
)
RE_METHOD = re.compile(
    r"^\s*(?:(?:public|private|protected|static|final|abstract|override|readonly|async|"
    r"inline|virtual|constexpr|pub|unsafe|extern|internal|sealed|partial|suspend|open|"
    r"export|default|get|set)\s+)*([A-Za-z_$][\w$]*)\s*\([^;{}]*\)\s*(?::\s*[^{;]+?)?\s*\{"
)
CONTROL_WORDS = {
    "if", "for", "while", "switch", "catch", "return", "do", "else", "case",
    "with", "synchronized", "lock", "using", "foreach", "when", "unless", "until",
}
RE_PY_DEF = re.compile(r"^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(")

ANY_PATTERNS = {
    "typescript": re.compile(r":\s*any\b|:\s*unknown\b|\bas\s+any\b|<any>|<unknown>|Array<\s*any\s*>"),
    "javascript": re.compile(r"/\*\s*@type\s*\{[^}]*\b(?:any|unknown)\b[^}]*\}\s*\*/"),
    "python": re.compile(r":\s*Any\b|->\s*Any\b|cast\(\s*Any\b"),
}

TOKEN_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*|&&|\|\||[?{}]")


def _strip_noise(content: str, comment_style: str) -> str:
    """Remove strings and comments (state machine, mirrors languages.ts)."""
    out: list[str] = []
    i, n = 0, len(content)
    state = "code"
    while i < n:
        ch = content[i]
        nxt = content[i + 1] if i + 1 < n else ""
        if state == "code":
            if ch == "/" and nxt == "/":
                state = "line"; i += 2; continue
            if ch == "/" and nxt == "*":
                state = "block"; i += 2; continue
            if comment_style == "hash" and ch == "#":
                state = "line"; i += 1; continue
            if ch in ("'", '"', "`"):
                state = ch; out.append(" "); i += 1; continue
            out.append(ch); i += 1; continue
        if state == "line":
            if ch == "\n":
                state = "code"; out.append("\n")
            i += 1; continue
        if state == "block":
            if ch == "*" and nxt == "/":
                state = "code"; i += 2; continue
            if ch == "\n":
                out.append("\n")
            i += 1; continue
        # inside a string literal
        if ch == "\\":
            i += 2; continue
        if ch == state:
            state = "code"; i += 1; continue
        if ch == "\n":
            out.append("\n")
            if state != "`":
                state = "code"
        i += 1
    return "".join(out)


def _function_header(line: str) -> str | None:
    m = RE_FUNC_KW.search(line) or RE_NAMED_KW.search(line) or RE_ARROW.match(line)
    if m:
        return m.group(1)
    m = RE_METHOD.match(line)
    if m and m.group(1) not in CONTROL_WORDS:
        return m.group(1)
    return None


def _count_decisions(segment: str, words: tuple[str, ...], ops: tuple[str, ...],
                     initial_depth: int = 0) -> tuple[int, int]:
    cyclomatic = 1
    cognitive = 0
    depth = initial_depth
    # `??` counts as ONE decision, `?.` as none — keep in lockstep with
    # src/quality/complexity.ts (countDecisions).
    segment = segment.replace("??", " ? ").replace("?.", ".")
    for m in TOKEN_RE.finditer(segment):
        tok = m.group(0)
        if tok == "{":
            depth += 1
            continue
        if tok == "}":
            depth = max(0, depth - 1)
            continue
        if tok in words or tok in ops:
            cyclomatic += 1
            cognitive += 1 if tok in _BOOL_OPS else 1 + max(0, depth)
    return cyclomatic, cognitive


def _analyze(content: str, lang: str) -> tuple[list[dict], int]:
    """Returns (functions, loc). functions: [{name,line,cyclomatic,cognitive}]."""
    style = "hash" if lang in ("python", "ruby") else "c"
    indent_based = lang == "python"
    words = PY_DECISION_WORDS if lang == "python" else C_DECISION_WORDS
    ops = PY_DECISION_OPS if lang == "python" else C_DECISION_OPS

    stripped = _strip_noise(content, style)
    lines = stripped.split("\n")
    loc = sum(1 for ln in lines if ln.strip())
    functions: list[dict] = []

    if indent_based:
        open_fn: dict | None = None
        buf: list[str] = []
        mod_buf: list[str] = []

        def flush() -> None:
            nonlocal open_fn, buf
            if open_fn is None:
                return
            seg = "\n".join(buf)
            cc, cog = _count_decisions(seg, words, ops)
            functions.append({"name": open_fn["name"], "line": open_fn["line"],
                              "cyclomatic": cc, "cognitive": cog})
            open_fn = None
            buf = []

        for idx, line in enumerate(lines):
            dm = RE_PY_DEF.match(line)
            if dm:
                flush()
                open_fn = {"name": dm.group(2), "line": idx + 1, "indent": len(dm.group(1))}
                buf.append(line)
                continue
            if open_fn is not None:
                indent = len(line) - len(line.lstrip())
                if line.strip() and indent <= open_fn["indent"]:
                    flush()
                    mod_buf.append(line)  # the dedent line is module-level
                else:
                    buf.append(line)
            else:
                mod_buf.append(line)
        flush()
        # Module-level decisions score as a pseudo-function, mirroring
        # src/quality/complexity.ts — signature parity is load-bearing.
        mcc, mcog = _count_decisions("\n".join(mod_buf), words, ops)
        if mcc > 1:
            functions.append({"name": "<module>", "line": 1,
                              "cyclomatic": mcc, "cognitive": mcog})
        return functions, loc

    depth = 0
    open_fn = None
    buf = []
    mod_buf = []
    for idx, line in enumerate(lines):
        if open_fn is None:
            name = _function_header(line)
            if name:
                delta = line.count("{") - line.count("}")
                if delta <= 0:
                    if "{" not in line:
                        # Multi-line signature — the opening brace is on a
                        # later line. Open the region now, anticipating the
                        # body one level above current depth.
                        open_fn = {"name": name, "line": idx + 1,
                                   "start_depth": depth + 1, "entered": False}
                        buf = [line]
                        continue
                    # One-line function: the brace balance never dips below
                    # start_depth, so without this branch the region stays
                    # open and swallows the REST OF THE FILE into this
                    # function's metrics. Score the header line alone.
                    cc, cog = _count_decisions(line, words, ops, 0)
                    functions.append({"name": name, "line": idx + 1,
                                      "cyclomatic": cc, "cognitive": cog})
                    depth = max(0, depth + delta)
                    continue
                open_fn = {
                    "name": name,
                    "line": idx + 1,
                    "start_depth": depth + delta,
                    "entered": True,
                }
                buf = [line]
                depth += delta
                continue
            mod_buf.append(line)
            depth += line.count("{") - line.count("}")
            if depth < 0:
                depth = 0
            continue
        buf.append(line)
        d = line.count("{") - line.count("}")
        depth += d
        if not open_fn["entered"]:
            if d > 0:
                open_fn["entered"] = True
            continue  # never close-check before the body opens
        if depth < open_fn["start_depth"]:
            seg = "\n".join(buf)
            cc, cog = _count_decisions(seg, words, ops, -1)
            functions.append({"name": open_fn["name"], "line": open_fn["line"],
                              "cyclomatic": cc, "cognitive": cog})
            open_fn = None
            buf = []
    if open_fn is not None:
        seg = "\n".join(buf)
        cc, cog = _count_decisions(seg, words, ops, -1)
        functions.append({"name": open_fn["name"], "line": open_fn["line"],
                          "cyclomatic": cc, "cognitive": cog})
    mcc, mcog = _count_decisions("\n".join(mod_buf), words, ops)
    if mcc > 1:
        functions.append({"name": "<module>", "line": 1,
                          "cyclomatic": mcc, "cognitive": mcog})
    return functions, loc


def _count_any(content: str, lang: str) -> int:
    pat = ANY_PATTERNS.get(lang)
    if not pat:
        return 0
    style = "hash" if lang in ("python", "ruby") else "c"
    stripped = _strip_noise(content, style)
    return sum(len(pat.findall(line)) for line in stripped.split("\n"))


def _violations(rel_path: str, content: str, thresholds: dict) -> list[dict]:
    lang = EXT_LANG.get(Path(rel_path).suffix.lower())
    if not lang:
        return []
    out: list[dict] = []
    functions, loc = _analyze(content, lang)

    max_loc = thresholds.get("maxLocPerFile", 500)
    if loc > max_loc:
        out.append({"signature": f"{rel_path}::locPerFile::<file>", "value": loc,
                    "message": f"{rel_path}: {loc} LOC exceeds max {max_loc}"})

    max_cc = thresholds.get("maxCyclomatic", 22)
    max_cog = thresholds.get("maxCognitive", 22)
    for fn in functions:
        if fn["cyclomatic"] > max_cc:
            out.append({"signature": f"{rel_path}::cyclomatic::{fn['name']}@{fn['line']}",
                        "value": fn["cyclomatic"],
                        "message": f"{rel_path}:{fn['line']} {fn['name']}() cyclomatic {fn['cyclomatic']} exceeds max {max_cc}"})
        if fn["cognitive"] > max_cog:
            out.append({"signature": f"{rel_path}::cognitive::{fn['name']}@{fn['line']}",
                        "value": fn["cognitive"],
                        "message": f"{rel_path}:{fn['line']} {fn['name']}() cognitive {fn['cognitive']} exceeds max {max_cog}"})

    max_any = thresholds.get("maxAnyTypes", 0)
    n_any = _count_any(content, lang)
    if n_any > max_any:
        out.append({"signature": f"{rel_path}::anyTypes::<file>", "value": n_any,
                    "message": f"{rel_path}: {n_any} explicit any/unknown usage(s) exceed max {max_any}"})
    return out


def _load_json(root: Path, name: str) -> dict | None:
    for base in (worktree_root(), root):
        p = base / ".uap" / name
        if p.exists():
            try:
                return json.loads(p.read_text())
            except Exception:  # noqa: BLE001
                return None
    return None


def _target_path(args: dict) -> str:
    for key in ("file_path", "path", "notebook_path", "filePath", "target"):
        if args.get(key):
            return str(args[key])
    return ""


def _post_edit_content(op: str, args: dict, target: str) -> str:
    """Best reconstruction of the file AFTER the edit.

    Write: the proposed content. Edit: old_string replaced by new_string in
    the on-disk file (first occurrence). MultiEdit: all edits applied in
    order. Falls back to the inserted text when reconstruction is impossible —
    partial scans still catch over-threshold inserts.
    """
    if args.get("content") is not None:
        return str(args["content"])
    disk = ""
    if target:
        try:
            disk = Path(target).read_text()
        except OSError:
            disk = ""
    edits = args.get("edits")
    if isinstance(edits, list):
        out = disk
        for e in edits:
            if not isinstance(e, dict):
                continue
            old, new = str(e.get("old_string", "")), str(e.get("new_string", ""))
            out = out.replace(old, new, 1) if old and old in out else out + "\n" + new
        return out
    if args.get("new_string") is not None:
        new = str(args["new_string"])
        old = str(args.get("old_string", ""))
        if disk and old and old in disk:
            return disk.replace(old, new, 1)
        return disk + "\n" + new if disk else new
    return ""


def _block_message(blocking: list[dict]) -> str:
    lines = ["quality-metrics gate: this edit introduces NEW or WORSENED metric debt:"]
    for v in blocking[:6]:
        lines.append(f"  ✗ {v['message']}")
    if len(blocking) > 6:
        lines.append(f"  … and {len(blocking) - 6} more")
    lines.append("  Fix the violation, keep it at/below the baselined value, or regenerate the")
    lines.append("  baseline deliberately: uap quality baseline --update (reviewable in git).")
    lines.append("  Full metrics (coverage/CRAP/duplication/mutation): uap quality check.")
    lines.append("  Escape hatch: UAP_QUALITY_GATE_OFF=1")
    return "\n".join(lines)


def _rel_path(target: str, root: Path) -> str:
    try:
        rel = str(Path(target).resolve().relative_to(root.resolve()))
    except (ValueError, OSError):
        rel = target
    return rel.replace("\\", "/")


def _in_scope(rel: str, config: dict) -> str | None:
    """Honour the config's own scope, or the enforcer is STRICTER than the CLI
    (e.g. blocking a Write into dist/ output that `uap quality check`
    ignores). Mirrors isScannableSource in src/quality/scanner.ts. Returns a
    skip reason, or None when the file is in scope."""
    source_exts = config.get("sourceExts")
    if isinstance(source_exts, list) and Path(rel).suffix.lower() not in source_exts:
        return "extension not in quality-metrics.json sourceExts"
    for excl in config.get("excludeDirs", []):
        if f"/{excl}/" in f"/{rel}" or rel.startswith(f"{excl}/"):
            return f"excluded dir ({excl})"
    return None


def main() -> None:
    op, args = parse_cli()

    if os.environ.get("UAP_QUALITY_GATE_OFF") == "1":
        emit(True, "UAP_QUALITY_GATE_OFF override set")
    if op not in PATH_WRITE_OPS:
        emit(True, "not a file-write operation")

    target = _target_path(args)
    lang = EXT_LANG.get(Path(target).suffix.lower())
    if not lang:
        emit(True, "not a scannable source file")

    config = _load_json(repo_root(), "quality-metrics.json")
    if not config:
        emit(True, "no .uap/quality-metrics.json — quality gate inactive")
    thresholds = config.get("thresholds", {})

    content = _post_edit_content(op, args, target)
    if not content:
        emit(True, "no post-edit content to scan")

    rel = _rel_path(target, worktree_root())
    skip = _in_scope(rel, config)
    if skip:
        emit(True, skip)

    violations = _violations(rel, content, thresholds)
    if not violations:
        emit(True, "within quality thresholds")

    baseline = _load_json(repo_root(), "quality-baseline.json") or {}
    entries = {e.get("signature"): e.get("value", 0)
               for e in baseline.get("entries", []) if isinstance(e, dict)}

    blocking = [v for v in violations
                if v["signature"] not in entries or v["value"] > entries[v["signature"]]]
    if not blocking:
        emit(True, f"{len(violations)} violation(s) grandfathered by the quality baseline")

    emit(False, _block_message(blocking))


if __name__ == "__main__":
    main()
