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
from _common import emit, parse_cli, repo_root  # noqa: E402

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
    re.compile(r"UAP_USER_VALIDATION\s*=\s*['\"]?0", re.I),
)
# Destructive ops against the enforcer/policy surface.
DESTRUCTIVE = re.compile(
    r"\b(rm|unlink|shred|truncate|mv|chmod)\b[^\n|;&]*"
    r"(\.policy-tools|src/policies|/policies/|anthropic-proxy\.env)",
    re.I,
)

OVERRIDE = os.environ.get("UAP_SELF_PROTECT_OFF") == "1"


def _is_protected_path(rel_posix: str) -> bool:
    # Ensure a leading separator so slash-anchored markers ("/policies/",
    # "/src/policies/", …) match only a genuine path SEGMENT. Filename markers
    # ("uap-policy-gate.sh", "anthropic-proxy.env") still match as substrings.
    low = "/" + rel_posix.lower().lstrip("/")
    return any(m in low for m in PROTECTED_MARKERS)


def main() -> None:
    if OVERRIDE:
        emit(True, "self-protect disabled by trusted operator override")

    op, args = parse_cli()

    if op in EDIT_OPS:
        target = args.get("file_path") or args.get("path") or args.get("target") or ""
        if not target:
            emit(True, "no file path in args")
        try:
            rel = str(Path(target).resolve().relative_to(repo_root()))
        except ValueError:
            # Out-of-repo writes (e.g. the proxy env in ~/.config) — match by name.
            rel = target
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
        if DESTRUCTIVE.search(cmd):
            emit(
                False,
                "BLOCKED: modifying/removing the policy enforcers or proxy env is "
                "not allowed for the agent.",
            )
        emit(True, "no enforcement-tampering in command")

    emit(True, "not a protected operation")


if __name__ == "__main__":
    main()
