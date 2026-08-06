#!/usr/bin/env python3
"""Round 3: close the cheap pre-existing holes the re-review found. OPERATOR-RUN.

  python3 patches/169/apply3.py --check | --into DIR | (bare = apply)

All five were verified to be present in MASTER too — this PR did not introduce
them (measured: 0 regressions vs master across 14 probes). They are fixed here
because they are one-liners guarding the naive, direct forms this enforcer
exists to catch, not because the PR caused them.

  N2  `nohup rm -rf .policy-tools`, `timeout 5 rm …`, `'rm' -rf …`, `\\rm …`
      The verb was read as tokens[0] with no quote/backslash stripping and no
      launcher handling, so one token of prefix hid the removal.
  N3  `rm -rf .uap/` and `rm -rf .uap/*`
      A trailing slash was excluded from the bare-.uap boundary set (so that
      `.uap/verify-cadence` stays writable) — but `.uap/` names the DIRECTORY.
  N8  `rm -rf policies/waivers/../../.policy-tools`
      The exemption was a substring test, so traversal through an exempt path
      made the real target invisible.
  P1  `bash -c "$(cat f)"`, `cat f | bash`
      Destructive intent was judged on the OUTER text only, so when both the
      verb and the target lived in the resolved source, nothing fired.
  N1  `python3 -c 'print(".policy-tools/x")' | xargs rm`
      An unresolvable producer was always allowed. That is right for a SEARCH
      producer (grep/find output is genuinely unknowable, and guessing from the
      pattern text is what blocked ordinary refactors) but wrong for an
      arbitrary one the agent chose. Search producers stay allowed; any other
      unresolvable producer falls back to the command text.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ENFORCER = "src/policies/enforcers/enforcement_self_protect.py"

# ── N8: normalise each unit, and require the exemption to be a path prefix ────
EXEMPT_OLD = """    for unit in text.translate(_QUOTES).lower().replace("./", "/").split():
        if any(ex in unit for ex in PROTECTED_EXEMPT):
            continue"""
EXEMPT_NEW = """    for raw_unit in text.translate(_QUOTES).lower().split():
        # Normalise BEFORE matching. `policies/waivers/../../.policy-tools` was
        # exempt by substring while resolving to a protected path, and the old
        # "./" -> "/" rewrite ran first and mangled the `..` segments so a later
        # normpath could not undo it. normpath subsumes that rewrite: it maps
        # "./.uap" -> ".uap", which is what the rewrite existed to do.
        unit = posixpath.normpath(raw_unit) if "/" in raw_unit else raw_unit
        if any(ex in unit for ex in PROTECTED_EXEMPT):
            continue"""

# ── N3: the bare directory, with or without a trailing slash/glob ─────────────
UAP_OLD = """        for m in re.finditer(re.escape(".uap"), unit):
            if unit[m.end():m.end() + 1] in ("", " ", '"', "'", "*"):
                return True"""
UAP_NEW = """        for m in re.finditer(re.escape(".uap"), unit):
            rest = unit[m.end():]
            if rest[:1] in ("", " ", '"', "'", "*"):
                return True
            # `rm -rf .uap/` and `rm -rf .uap/*` name the DIRECTORY, and take
            # evidence, reviews and interaction with it. A deeper path
            # (`.uap/verify-cadence`) is ordinary tooling and stays writable.
            if rest.strip("/") in ("", "*"):
                return True"""

# ── N2: strip quoting from the verb and step over launcher prefixes ──────────
VERB_OLD = """        tokens = [t for t in seg.split() if not _ENV_ASSIGN.match(t)]
        if not tokens:
            continue
        verb = tokens[0].rsplit("/", 1)[-1].lower()"""
VERB_NEW = """        tokens = [t for t in seg.split() if not _ENV_ASSIGN.match(t)]
        # Step over launchers: `nohup rm -rf x`, `timeout 5 rm -rf x`,
        # `command rm …`, `sudo rm …` all run rm, but the verb read as the
        # launcher and the removal was invisible. Flags and their values are
        # skipped with them.
        while len(tokens) > 1 and _verb_of(tokens[0]) in _LAUNCHERS:
            tokens = tokens[1:]
            while tokens and (tokens[0].startswith("-") or tokens[0].isdigit()):
                tokens = tokens[1:]
        if not tokens:
            continue
        verb = _verb_of(tokens[0])"""

# ── P1 + N1: intent may live in the source; unknown producers are not free ────
TAIL_OLD = """    if (hands_text_to_shell(command) or "$(" in command or "`" in command) \\
            and _destructive_intent(command):
        return any(_mentions_protected(src) for src in _resolved_arguments(command))
    return False"""
TAIL_NEW = """    if not (hands_text_to_shell(command) or "$(" in command or "`" in command):
        return False
    sources = _resolved_arguments(command)
    # Intent can live in the SOURCE rather than the outer text: for
    # `bash -c "$(cat f)"` the outer words are just bash, so judging intent on
    # them alone found nothing while f held both the verb and the target.
    for src in sources:
        if _mentions_protected(src) and (
                _destructive_intent(command) or _destructive_intent(src)):
            return True
    if not _destructive_intent(command):
        return False
    # Nothing resolvable. A SEARCH producer really is unknowable here, and
    # guessing from its pattern text is what blocked ordinary refactors
    # (`grep -rl policies/ docs/ | xargs sed -i …`). An arbitrary producer the
    # agent chose is a different matter: `python3 -c 'print(".policy-tools/x")'
    # | xargs rm` carries the path in plain sight. Fall back to the text only
    # when no producer is a search tool.
    if not sources and _has_unknown_producer(command):
        return _mentions_protected(scannable_command(command))
    return False"""

HELPERS = '''

_LAUNCHERS = ("nohup", "timeout", "command", "builtin", "setsid", "sudo", "doas",
              "nice", "ionice", "stdbuf", "time", "unbuffer")
# Producers whose output genuinely cannot be known from the command text.
_SEARCH_PRODUCERS = ("grep", "egrep", "fgrep", "rg", "ag", "ack", "find", "fd",
                     "ls", "comm", "diff", "git", "locate", "which")


def _verb_of(token: str) -> str:
    """The command a token invokes, with quoting and \\\\-escaping removed."""
    return token.strip("\\"'").lstrip("\\\\").rsplit("/", 1)[-1].lower()


def _has_unknown_producer(command: str) -> bool:
    """True when a pipeline stage feeding a consumer is not a search tool."""
    stages = [s.strip() for s in command.split("|") if s.strip()]
    if len(stages) < 2:
        return False
    for stage in stages[:-1]:
        toks = [t for t in stage.split() if not _ENV_ASSIGN.match(t)]
        if toks and _verb_of(toks[0]) not in _SEARCH_PRODUCERS:
            return True
    return False
'''


def patch(text: str) -> str:
    if "_LAUNCHERS" in text:
        return text
    for old, new, name in (
        (EXEMPT_OLD, EXEMPT_NEW, "exempt"),
        (UAP_OLD, UAP_NEW, "uap-dir"),
        (VERB_OLD, VERB_NEW, "verb"),
        (TAIL_OLD, TAIL_NEW, "tail"),
    ):
        if old not in text:
            raise KeyError(name)
        text = text.replace(old, new, 1)
    text = text.replace(
        "from _common import (  # noqa: E402\n    emit, parse_cli, repo_root, "
        "REVIEW_ARTIFACT_DIR, REVIEW_WAIVER_DIR,\n    hands_text_to_shell,\n)",
        "from _common import (  # noqa: E402\n    emit, parse_cli, repo_root, "
        "REVIEW_ARTIFACT_DIR, REVIEW_WAIVER_DIR,\n    hands_text_to_shell, "
        "scannable_command,\n)", 1)
    text = text.replace("import os\nimport re\n", "import os\nimport posixpath\nimport re\n", 1)
    # helpers must exist before _direct_destructive uses them
    marker = "\ndef _read_source(tok: str) -> str:"
    text = text.replace(marker, HELPERS + marker, 1)
    return text


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--into", type=Path)
    ap.add_argument("--root", type=Path, default=Path.cwd())
    a = ap.parse_args()
    src = a.root / ENFORCER
    if not src.is_file():
        print(f"MISSING {ENFORCER}")
        return 1
    original = src.read_text()
    try:
        text = patch(original)
    except KeyError as e:
        print(f"ANCHOR-DRIFT ({e})")
        return 1
    if text == original:
        print("already")
        return 0
    if a.check:
        print(f"would-patch {ENFORCER}")
        return 0
    dest = (a.into / ENFORCER) if a.into else src
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(text)
    dest.chmod(src.stat().st_mode)
    print(f"patched {dest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
