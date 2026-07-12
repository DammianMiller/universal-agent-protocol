#!/usr/bin/env python3
"""visual-verification gate: under MAX fidelity, a commit that changes UI files
must be visually verified first.

The visual gate (`uap verify`) renders every entry page in a real browser,
checks it is not blank/static/erroring, scores its appearance, and — when it
runs — writes `.uap/visual/last-verdict.json` = {passed, mode, at}. This enforcer
fires on `git commit`: if maximum fidelity is active and the staged change set
touches UI files, it BLOCKS unless a *passing* verdict exists that is newer than
every staged UI file (i.e. the UI on disk has actually been observed since it
last changed).

This is the non-bypassable backstop for agentic/opencode sessions that edit
files directly and never go through `uap deliver` or the Stop-hook `uap verify`.

Active only when fidelity is `max` (`.uap.json` `fidelity.mode` or `UAP_FIDELITY`).
Escape hatch (justify in the commit message): UAP_VISUAL_GATE_OFF=1.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import emit, parse_cli, run, worktree_root  # noqa: E402

UI_EXT = {".css", ".scss", ".sass", ".less", ".tsx", ".jsx", ".vue", ".svelte", ".html", ".astro"}
UI_DIR_PREFIXES = ("web/", "src/dashboard/", "public/")
MARKER = ".uap/visual/last-verdict.json"


def _is_commit(cmd_lower: str) -> bool:
    return "git commit" in cmd_lower and " --amend" not in cmd_lower


def _fidelity_max(root: Path) -> bool:
    env = (os.environ.get("UAP_FIDELITY") or "").strip().lower()
    if env in ("max", "maximum", "strict", "high"):
        return True
    if env in ("standard", "std", "normal", "off"):
        return False
    for cfg in (root / ".uap.json", root.parent / ".uap.json"):
        if cfg.exists():
            try:
                mode = (json.loads(cfg.read_text()).get("fidelity", {}).get("mode") or "").lower()
                return mode in ("max", "maximum")
            except Exception:  # noqa: BLE001
                return False
    return False


def _staged_ui_files(root: Path) -> list[str]:
    rc, out, _ = run(["git", "diff", "--cached", "--name-only"], cwd=root)
    if rc != 0:
        return []
    files = [f for f in out.splitlines() if f]
    return [
        f
        for f in files
        if Path(f).suffix.lower() in UI_EXT or any(f.startswith(p) for p in UI_DIR_PREFIXES)
    ]


def main() -> None:
    op, args = parse_cli()
    cmd = (args.get("command") or args.get("cmd") or "").strip()
    if not cmd or op.lower() != "bash":
        emit(True, "not a Bash command")
    if not _is_commit(cmd.lower()):
        emit(True, "not a git commit")
    if os.environ.get("UAP_VISUAL_GATE_OFF") == "1":
        emit(True, "UAP_VISUAL_GATE_OFF=1 override (justify in commit msg)")

    root = worktree_root()
    if not _fidelity_max(root):
        emit(True, "fidelity is not max — visual gate advisory only")

    ui = _staged_ui_files(root)
    if not ui:
        emit(True, "no UI files staged — visual verification not required")

    marker = root / MARKER
    if not marker.exists():
        emit(
            False,
            "visual-verification: UI files are staged under max fidelity but they have "
            "never been visually verified.\n"
            f"  staged UI: {', '.join(sorted(ui)[:6])}{' …' if len(ui) > 6 else ''}\n"
            "  -> run `uap verify` (renders the UI, checks it looks right), then commit.",
        )

    try:
        verdict = json.loads(marker.read_text())
    except Exception:  # noqa: BLE001
        verdict = {}
    if not verdict.get("passed"):
        emit(
            False,
            "visual-verification: the last visual verification did NOT pass.\n"
            "  -> fix the rendered UI and re-run `uap verify` until it passes, then commit.",
        )

    verified_at = float(verdict.get("at") or 0)
    stale = []
    for f in ui:
        p = root / f
        try:
            if p.exists() and p.stat().st_mtime > verified_at + 1:  # 1s grace
                stale.append(f)
        except OSError:
            continue
    if stale:
        emit(
            False,
            "visual-verification: these UI files changed AFTER the last passing visual "
            "verification — the current look is unverified.\n"
            f"  stale: {', '.join(sorted(stale)[:6])}{' …' if len(stale) > 6 else ''}\n"
            "  -> re-run `uap verify` to observe the new UI, then commit.",
        )

    emit(True, f"visual verification current ({len(ui)} UI file(s) verified)")


if __name__ == "__main__":
    main()
