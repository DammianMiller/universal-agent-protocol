"""enforcement-self-protect enforcer: the model must not be able to disable
the delivery gate.

A weak local model that hits the delivery-enforcement block tends to try to
ESCAPE it — observed live (qwen <think>): "set enforcement to advisory mode",
"just use UAP_DELIVER_BYPASS=1". A single shell `export` does not persist across
tool calls, so the only way to actually weaken the gate is to PERSIST a bypass:
write it into a config/env file, or edit the policy/enforcer itself. This
enforcer blocks exactly those persistence paths.

Scope:
  - Edit/Write/MultiEdit to the enforcement control surface (policy md/enforcers,
    .policy-tools/, .uap.json, proxy env, the policy-gate hook scripts).
  - Bash commands that set/export UAP_DELIVER_BYPASS or relax UAP_ENFORCE_DELIVERY,
    write those to a file, or delete/chmod a policy enforcer.

There is intentionally NO model-reachable bypass: honoring UAP_DELIVER_BYPASS here
would reopen the hole (the model would just set it). Operator override is
out-of-band only: UAP_SELF_PROTECT_OFF=1 in the trusted launch env.
"""
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import (  # noqa: E402
    emit, parse_cli, repo_root, REVIEW_ARTIFACT_DIR, REVIEW_WAIVER_DIR,
)

EDIT_OPS = {"Edit", "Write", "MultiEdit", "edit", "write", "multiedit"}

# Path substrings that control delivery enforcement. A write touching any of
# these can weaken the gate, so it is protected regardless of file extension.
PROTECTED_MARKERS = (
    "/.policy-tools/",
    "/src/policies/",
    "/policies/",            # the policy-definition markdown dir
    "/.uap.json",
    "/.uap/",
    "anthropic-proxy.env",
    "uap-policy-gate.sh",
    "uap-reactor-prompt.sh",
    "pre-tool-use",
)

# Bash patterns that persist a bypass or relax enforcement.
BYPASS_PATTERNS = (
    re.compile(r"UAP_DELIVER_BYPASS\s*=\s*['\"]?1", re.I),
    re.compile(r"UAP_ENFORCE_DELIVERY\s*=\s*['\"]?(advisory|off|0|false|no)", re.I),
    re.compile(r"UAP_SELF_PROTECT_OFF\s*=\s*['\"]?1", re.I),
    re.compile(r"UAP_NO_WORKTREE\s*=\s*['\"]?1", re.I),
    re.compile(r"UAP_WORKDIR_SCOPE_OFF\s*=\s*['\"]?1", re.I),
    # infra-protect's hatch is environment-only by design; an inline assignment
    # would be self-grantable, so refuse it here with a clear message rather than
    # letting it look like it worked.
    re.compile(r"UAP_INFRA_PROTECT_OFF\s*=\s*['\"]?1", re.I),
    # expert-review's override is environment-only too, for the same reason: the
    # agent writes its own command strings, so an inline form waives its own
    # review. Refuse it here so the attempt is visible rather than silent.
    re.compile(r"UAP_NO_REVIEW\s*=\s*['\"]?1", re.I),
    re.compile(r"UAP_USER_VALIDATION\s*=\s*['\"]?0", re.I),
    # Single-flight is a DATA-SAFETY control, not a policy preference: deliver
    # runs each candidate in a git worktree, and two runs against one repo are
    # not safe together. Disabling it cost real work — observed live
    # (octopus_invaders_v3, 2026-07-31): the agent ran
    # `UAP_DELIVER_NO_LOCK=1 uap deliver ...`, two runs overlapped for seven
    # minutes, and the untracked space-shooter/ tree they were both building
    # disappeared. It had never been committed, so nothing could recover it.
    #
    # The env var stays a real operator hatch; only the INLINE form is refused,
    # because a switch the constrained party writes into its own command line is
    # not an override — it is an off switch, the same reasoning as every entry
    # above it.
    re.compile(r"UAP_DELIVER_NO_LOCK\s*=\s*['\"]?1", re.I),
)
# Destructive ops against the enforcer/policy surface.
#
# HONEST SCOPE: this is a NUDGE, not a boundary. An agent that can write a file
# and then run it (`Write tmp.sh` + `bash tmp.sh`), or use `python3 -c`, or hide
# a path in a variable, walks straight past anything a regex over shell text can
# see. What this catches is the naive, direct form — which is what was actually
# observed in the wild. The real control is that a missing manifest FAILS under
# max fidelity (see interaction-gate: skipped verdicts block when fidelity.max),
# so deleting the acceptance criteria is not rewarded with a pass.
#
# Matched at COMMAND POSITION, never in prose: `echo "do not rm .uap/x"` is a
# string, not a removal. This repo has already paid for that distinction once
# (5e26c66, "gates must match commands, not prose that mentions them").
DESTRUCTIVE_VERBS = (
    "rm", "unlink", "shred", "truncate", "mv", "chmod", "chown", "chattr",
    "dd", "cp", "tee", "install", "sed", "find", "ln",
)

# Paths inside a protected tree that the agent legitimately writes. Without
# these the enforcer deadlocks the workflows it exists to support: the
# expert-review gate REQUIRES writing .uap/reviews/<branch>.json, and the visual
# and interaction gates write their own screenshots and evidence.
PROTECTED_EXEMPT = (
    ".uap/interaction/evidence",
    "policies/waivers",
)

# Deliberately NARROW inside .uap/: that directory is mostly runtime state the
# tooling writes constantly (verify-cadence, pending-deliver.jsonl, autoroute.log,
# visual screenshots, deliver logs) — the repo's own hook templates do
# `echo 0 > .uap/verify-cadence`. Guarding the whole tree would block the
# project's own plumbing while adding nothing: what must survive is the
# ACCEPTANCE CRITERIA and the project config, not the scratch state.
PROTECTED_TARGETS = (
    ".policy-tools",
    "src/policies",
    "policies/",
    ".uap/interaction",
    # Gate evidence. The rest of .uap/ stays permissive on purpose (the tooling
    # writes runtime state there constantly), but these records are what the
    # plan-time gates accept as proof a required action happened. Leaving them
    # shell-writable meant a single append could satisfy a gate — which is
    # exactly how one was satisfied during development.
    ".uap/evidence",
    ".uap.json",
    "anthropic-proxy.env",
)

_SEGMENT_SPLIT = re.compile(r"(?:\|\||&&|[;\n|&])")
_ENV_ASSIGN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=\S*$")
_QUOTES = str.maketrans("", "", "\"'")


def _mentions_protected(text: str) -> bool:
    """True when the text names a protected path and no exempt sub-path."""
    low = text.translate(_QUOTES).lower()
    # Normalise ./ and leading slashes so `./.uap`, `/.uap` and `.uap` agree.
    low = low.replace("./", "/")
    if any(ex in low for ex in PROTECTED_EXEMPT):
        return False
    # The .uap DIRECTORY ITSELF: `rm -rf .uap` / `find .uap -delete` destroy the
    # manifest along with everything else, while `echo 0 > .uap/verify-cadence`
    # names a deeper path and is ordinary tooling. So the bare directory is
    # protected; a specific file under it is not (unless listed below).
    for m in re.finditer(re.escape(".uap"), low):
        if low[m.end():m.end() + 1] in ("", " ", '"', "'", "*"):
            return True
    for target in PROTECTED_TARGETS:
        t = target.lower()
        # Word-ish boundary so `.uap` matches `.uap`, `.uap/x` and `.uap.bak`
        # but not an unrelated longer name like `.uapkeep`.
        for m in re.finditer(re.escape(t), low):
            tail = low[m.end():m.end() + 1]
            if tail in ("", "/", ".", " ", '"', "'", "*"):
                return True
    return False


def _bash_destructive(command: str) -> bool:
    """Destructive op against a protected path, judged per command segment."""
    for segment in _SEGMENT_SPLIT.split(command or ""):
        seg = segment.strip()
        if not seg:
            continue
        # A redirect writes just as destructively as `rm`; the target may be
        # quoted, ./-prefixed, or fd-numbered (`1> .uap/x`).
        for m in re.finditer(r">>?", seg):
            if _mentions_protected(seg[m.end():]):
                return True
        tokens = [t for t in seg.split() if not _ENV_ASSIGN.match(t)]
        if not tokens:
            continue
        verb = tokens[0].rsplit("/", 1)[-1].lower()
        if verb == "git" and len(tokens) > 1:
            verb = f"git {tokens[1].lower()}"
            if verb not in ("git clean", "git checkout"):
                continue
        elif verb not in DESTRUCTIVE_VERBS:
            continue
        if _mentions_protected(" ".join(tokens[1:])):
            return True
    return False


OVERRIDE = os.environ.get("UAP_SELF_PROTECT_OFF") == "1"


def _is_protected_path(rel_posix: str) -> bool:
    # Ensure a leading separator so slash-anchored markers ("/policies/",
    # "/src/policies/", …) match only a genuine path SEGMENT. Filename markers
    # ("uap-policy-gate.sh", "anthropic-proxy.env") still match as substrings.
    low = "/" + rel_posix.lower().lstrip("/")
    # Designed-writable escape hatches that live UNDER a protected marker but are
    # NOT part of the delivery-enforcement control surface: expert-review
    # artifacts (.uap/reviews/) and the committable review waiver
    # (policies/waivers/). Writing these satisfies the SEPARATE
    # expert-review-required gate and cannot weaken delivery enforcement — the
    # markers above still guard .uap.json, proxy env, enforcer code and hooks.
    # Without this carve-out the two gates deadlock: expert-review demands an
    # artifact that self-protect forbids writing.
    allow = ("/" + REVIEW_ARTIFACT_DIR + "/", "/" + REVIEW_WAIVER_DIR + "/")
    if any(a in low for a in allow):
        return False
    return any(m in low for m in PROTECTED_MARKERS)


def main() -> None:
    if OVERRIDE:
        emit(True, "self-protect disabled by trusted operator override")

    op, args = parse_cli()

    if op in EDIT_OPS:
        target = args.get("file_path") or args.get("path") or args.get("target") or ""
        if not target:
            emit(True, "no file path in args")
        rp = Path(target).resolve()
        try:
            rel = str(rp.relative_to(repo_root()))
        except ValueError:
            # Out-of-repo writes (e.g. the proxy env in ~/.config) — match by name
            # against the RESOLVED path, never the raw arg: a raw
            # ".uap/reviews/../../anthropic-proxy.env" would otherwise smuggle the
            # allow-list carve-out to reach an out-of-repo control file.
            rel = str(rp)
        rel_posix = rel.replace(os.sep, "/")
        if _is_protected_path(rel_posix):
            emit(
                False,
                "BLOCKED: this file controls delivery enforcement and cannot be "
                f"edited by the agent ('{rel_posix}'). Do not try to disable or "
                "relax the gate — route your change through the `deliver` tool "
                "instead. (Operator-only override: UAP_SELF_PROTECT_OFF=1.)",
            )
        emit(True, "not an enforcement-control file")

    if op in {"Bash", "bash"}:
        cmd = args.get("command") or ""
        for pat in BYPASS_PATTERNS:
            if pat.search(cmd):
                emit(
                    False,
                    "BLOCKED: setting a delivery-enforcement bypass/advisory flag is "
                    "not allowed for the agent. Route your change through the "
                    "`deliver` tool instead of disabling the gate. "
                    "(Operator-only override: UAP_SELF_PROTECT_OFF=1.)",
                )
        if _bash_destructive(cmd):
            emit(
                False,
                "BLOCKED: modifying/removing the policy enforcers or proxy env is "
                "not allowed for the agent.",
            )
        emit(True, "no enforcement-tampering in command")

    emit(True, "not a protected operation")


if __name__ == "__main__":
    main()
