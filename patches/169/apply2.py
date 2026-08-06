#!/usr/bin/env python3
"""Round 2: fix what the 5-droid review found in the first cut. OPERATOR-RUN.

  python3 patches/169/apply2.py --check | --into DIR | (bare = apply)

The first implementation scanned the whole command TEXT for protected paths
whenever an indirection construct and a destructive verb co-occurred. Verified
by execution, that blocked six ordinary commands --

    cp package.json /tmp/x-$(date +%s).json     (package.json names src/policies/…)
    cp .gitignore /tmp/g.bak                    (.gitignore names .policy-tools/)
    cp CHANGELOG.md /tmp/c.md
    git commit -m "… xargs rm … .policy-tools/" (its own commit message)
    grep -rl policies/ docs/ | xargs sed -i …
    find docs -name "*.md" | xargs grep -l .uap.json   (read-only!)

-- while five trivial variants still walked through: one extra `policies/waivers`
line in the list file, `bash -c`, `xargs --arg-file=`, `cd <dir> && rm`, and a
redirect whose target came from $(cat f).

ROOT CAUSE: text-matching answers "is a protected path mentioned anywhere",
which is not the question. The question is "will a protected path be an
ARGUMENT to something destructive". This rewrite answers that one: it resolves
the argument set where it is knowable and refuses to guess where it is not.

`grep … | xargs sed` is now deliberately ALLOWED: grep's output is not knowable
at scan time, and guessing from the pattern text is what blocked the refactor
above. That is the same accepted residual as a path held in a shell variable.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

GATE_COPIES = (
    ".claude/hooks/uap-policy-gate.sh",
    ".factory/hooks/uap-policy-gate.sh",
    ".omp/hooks/uap-policy-gate.sh",
    "templates/hooks/uap-policy-gate.sh",
)
ENFORCER = "src/policies/enforcers/enforcement_self_protect.py"

# ── enforcer: import the canonical shell predicates instead of a local regex ──
IMP_OLD = """from _common import (  # noqa: E402
    emit, parse_cli, repo_root, REVIEW_ARTIFACT_DIR, REVIEW_WAIVER_DIR,
)"""
IMP_NEW = """from _common import (  # noqa: E402
    emit, parse_cli, repo_root, REVIEW_ARTIFACT_DIR, REVIEW_WAIVER_DIR,
    hands_text_to_shell,
)"""

BODY_OLD_START = "def _mentions_protected(text: str) -> bool:"
BODY_OLD_END = "\n\nOVERRIDE = os.environ.get"

BODY_NEW = '''def _mentions_protected(text: str) -> bool:
    """True when any UNIT of `text` names a protected path.

    Judged unit by unit, not over the whole blob. The exemption used to be
    evaluated across the entire text, so one `policies/waivers` anywhere made
    everything else invisible — appending a single innocuous line to a deletion
    list defeated the check completely (found by the review, reproduced).
    """
    for unit in text.translate(_QUOTES).lower().replace("./", "/").split():
        if any(ex in unit for ex in PROTECTED_EXEMPT):
            continue
        # The .uap DIRECTORY ITSELF: `rm -rf .uap` destroys the manifest, while
        # `echo 0 > .uap/verify-cadence` names a deeper path and is ordinary
        # tooling. Bare directory protected; a file under it is not.
        for m in re.finditer(re.escape(".uap"), unit):
            if unit[m.end():m.end() + 1] in ("", " ", '"', "'", "*"):
                return True
        for target in PROTECTED_TARGETS:
            t = target.lower()
            for m in re.finditer(re.escape(t), unit):
                if unit[m.end():m.end() + 1] in ("", "/", ".", " ", '"', "'", "*"):
                    return True
    return False


# An argument list is a list of paths; it is never a megabyte. The old 1 MiB cap
# also SKIPPED anything larger, so padding a list file past the cap was a
# one-line bypass. Read a bounded prefix instead of skipping.
_MAX_SRC_BYTES = 1 << 16
_MAX_SOURCES = 32
# Commands whose arguments are literal paths we can read now.
_FILE_READERS = ("cat", "head", "tail", "sort", "uniq", "cut", "tr", "nl", "rev")
_LITERAL_EMITTERS = ("echo", "printf")
# Wrappers that hand their remaining words back to a shell as a command.
_WRAPPERS = ("eval", "env", "exec", "source", ".")
_SHELL_C = re.compile(
    r"(?:^|[\\s;|&(])(?:ba|z|k|da|a)?sh\\s+(?:-\\w+\\s+)*-\\w*c\\s+(['\\"])(.*?)\\1", re.S)
_REDIRECT = re.compile(r">>?")
_SUBST_FILE = re.compile(r"\\$\\(\\s*(?:cat\\s+)?<?\\s*([^\\s)]+)[^)]*\\)|`\\s*cat\\s+([^`]+)`")
_ARGFILE = re.compile(r"--arg-file=([^\\s;|&]+)|(?:^|\\s)-a\\s+([^\\s;|&]+)")
_STDIN_REDIR = re.compile(r"<\\s*([^\\s;|&<>]+)")


def _read_source(tok: str) -> str:
    """A bounded prefix of `tok` if it is a readable regular file, else ""."""
    tok = (tok or "").strip("\\"'`$()").rstrip(";|&")
    if not tok or tok.startswith("-"):
        return ""
    try:
        p = Path(tok)
        if not p.is_file():          # excludes FIFOs and devices: no blocking read
            return ""
        with p.open(errors="replace") as fh:
            return fh.read(_MAX_SRC_BYTES)
    except (OSError, ValueError):
        return ""


def _resolved_arguments(command: str) -> list[str]:
    """Text that will actually REACH a command as arguments.

    Only sources knowable right now: a `< file` redirect, xargs --arg-file/-a,
    $(cat f)/`cat f`, and an upstream pipe stage that is a literal emitter
    (echo/printf) or a file reader (cat/head/tail/...).

    Deliberately NOT resolved: `grep … | xargs sed`. grep's output is unknown
    here, and inferring it from the pattern text is exactly what made ordinary
    refactors unrunnable. Unknowable means allow — the same call made for a path
    held in a shell variable.
    """
    out: list[str] = []

    def add(text: str) -> None:
        if text and len(out) < _MAX_SOURCES:
            out.append(text)

    for m in _STDIN_REDIR.finditer(command):
        add(_read_source(m.group(1)))
    for m in _ARGFILE.finditer(command):
        add(_read_source(m.group(1) or m.group(2)))
    for m in _SUBST_FILE.finditer(command):
        add(_read_source(m.group(1) or m.group(2)))

    stages = [s.strip() for s in command.split("|") if s.strip()]
    for stage in stages[:-1]:                       # producers only
        toks = [t for t in stage.split() if not _ENV_ASSIGN.match(t)]
        if not toks:
            continue
        verb = toks[0].rsplit("/", 1)[-1].lower()
        if verb in _LITERAL_EMITTERS:
            add(" ".join(toks[1:]))
        elif verb in _FILE_READERS:
            for t in toks[1:]:
                if not t.startswith("-"):
                    add(_read_source(t))
    return out


def _inner_commands(command: str) -> list[str]:
    """Command strings this command hands back to a shell to execute."""
    out = [m.group(2) for m in _SHELL_C.finditer(command or "")]
    for segment in _SEGMENT_SPLIT.split(command or ""):
        toks = [t for t in segment.split() if not _ENV_ASSIGN.match(t)]
        if toks and toks[0].rsplit("/", 1)[-1].lower() in _WRAPPERS:
            rest = " ".join(toks[1:]).strip().strip("\\"'")
            if rest:
                out.append(rest)
    return out


def _destructive_intent(command: str) -> bool:
    """A destructive verb or a redirect appears somewhere in `command`."""
    toks = {t.rsplit("/", 1)[-1].lower().strip("\\"'") for t in command.split()}
    return bool(toks & set(DESTRUCTIVE_VERBS)) or bool(_REDIRECT.search(command))


def _direct_destructive(command: str) -> bool:
    """Destructive op naming a protected path, judged per command segment."""
    cd_into_protected = False
    for segment in _SEGMENT_SPLIT.split(command or ""):
        seg = segment.strip()
        if not seg:
            continue
        # A redirect writes just as destructively as `rm`; the target may be
        # quoted, ./-prefixed, or fd-numbered (`1> .uap/x`).
        for m in _REDIRECT.finditer(seg):
            if _mentions_protected(seg[m.end():]):
                return True
        tokens = [t for t in seg.split() if not _ENV_ASSIGN.match(t)]
        if not tokens:
            continue
        verb = tokens[0].rsplit("/", 1)[-1].lower()
        # `cd .policy-tools && rm -f _common.py` put the protected path in one
        # segment and the verb in another, so neither segment looked dangerous.
        if verb == "cd":
            cd_into_protected = _mentions_protected(" ".join(tokens[1:]))
            continue
        if verb == "git" and len(tokens) > 1:
            verb = f"git {tokens[1].lower()}"
            if verb not in ("git clean", "git checkout"):
                continue
        elif verb not in DESTRUCTIVE_VERBS:
            continue
        if cd_into_protected or _mentions_protected(" ".join(tokens[1:])):
            return True
    return False


def _bash_destructive(command: str, _depth: int = 0) -> bool:
    """Destructive op against the protected surface, however the target arrives.

    Three ways a target reaches a verb, all of them observed:
      1. on the command line              -> _direct_destructive
      2. through a shell wrapper          -> _inner_commands (bash -c, eval, env)
      3. as resolved arguments            -> _resolved_arguments (xargs, $(cat))

    HONEST LIMIT: shell state this process cannot see still wins. `P=.policy-
    tools; rm $P/x` expands inside the shell, and no scan of command TEXT can
    resolve a VALUE. Refusing every destructive command containing a variable
    would block ordinary work for no real gain, so the residual is accepted and
    covered by the gate's fail-closed and the _common.py self-heal.
    """
    if not command:
        return False
    if _direct_destructive(command):
        return True
    if _depth < 2:                       # bounded: `bash -c "bash -c ..."`
        for inner in _inner_commands(command):
            if _bash_destructive(inner, _depth + 1):
                return True
    if (hands_text_to_shell(command) or "$(" in command or "`" in command) \\
            and _destructive_intent(command):
        return any(_mentions_protected(src) for src in _resolved_arguments(command))
    return False
'''

# ── gate: boundary-match the markers, ignore read-only commands ───────────────
GATE_OLD = '''low = ("/" + str(target)).lower() + " " + " ".join(
    "/" + t for t in str(cmd).lower().split())
hit = any(m in low for m in markers)'''

GATE_NEW = '''low = ("/" + str(target)).lower()
hit = any(m in low for m in markers)
# The command side needs its own pass. Markers are slash-terminated
# ("/.policy-tools/"), so a plain substring test missed the DIRECTORY forms --
# `rm -rf .policy-tools` scored 0, i.e. the single most destructive command
# against the surface did not arm the fail-closed net. Quoted paths missed too.
# Match on a path-segment boundary instead, per token, quotes stripped.
if not hit and cmd:
    words = str(cmd).lower().replace("./", "/").split()
    lead = ""
    for w in words:
        if "=" in w and not w.startswith("/"):
            continue
        lead = w.rsplit("/", 1)[-1]
        break
    # A read-only command cannot weaken anything, and arming fail-closed for it
    # turns `cat .uap.json` into a hard block on any checkout where self-protect
    # is not attached -- a state this repo has actually been in.
    readonly = ("cat", "ls", "grep", "rg", "head", "tail", "wc", "jq", "less",
                "stat", "file", "which", "wc")
    if lead not in readonly:
        for w in words:
            u = "/" + w.strip("\\"" + chr(39) + "").lstrip("/")
            for mk in markers:
                base = mk.rstrip("/")
                start = u.find(base)
                while start != -1:
                    tail = u[start + len(base):start + len(base) + 1]
                    if tail in ("", "/", ".", "*"):
                        hit = True
                        break
                    start = u.find(base, start + 1)
                if hit:
                    break
            if hit:
                break'''

EDITS = {ENFORCER: "special"}
for _g in GATE_COPIES:
    EDITS[_g] = ((GATE_OLD, GATE_NEW),)


def patch_enforcer(text: str) -> str:
    if "_resolved_arguments" in text:
        return text
    if IMP_OLD not in text:
        raise KeyError("import anchor")
    text = text.replace(IMP_OLD, IMP_NEW, 1)
    i = text.index(BODY_OLD_START)
    j = text.index(BODY_OLD_END, i)
    return text[:i] + BODY_NEW.rstrip("\n") + text[j:]


def process(root: Path, into: Path | None, check_only: bool) -> int:
    problems = 0
    for rel, pairs in EDITS.items():
        src = root / rel
        if not src.is_file():
            print(f"MISSING  {rel}")
            problems += 1
            continue
        original = src.read_text()
        try:
            if pairs == "special":
                text = patch_enforcer(original)
            else:
                text = original
                for old, new in pairs:
                    if new in text:
                        continue
                    if old not in text:
                        raise KeyError(rel)
                    text = text.replace(old, new, 1)
        except KeyError as e:
            print(f"ANCHOR-DRIFT  {rel}  ({e})")
            problems += 1
            continue
        if text == original:
            print(f"already  {rel}")
            continue
        if check_only:
            print(f"would-patch  {rel}")
            continue
        dest = (into / rel) if into else src
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(text)
        dest.chmod(src.stat().st_mode)
        print(f"patched  {dest}")
    return problems


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--into", type=Path)
    ap.add_argument("--root", type=Path, default=Path.cwd())
    a = ap.parse_args()
    problems = process(a.root, a.into, a.check)
    print(f"{problems} problem(s)" if problems else "OK")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
