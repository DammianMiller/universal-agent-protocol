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
    .policy-tools/, .uap.json, proxy env, the policy-gate hook scripts, and the
    policy DATABASE agents/data/memory/policies.db).
  - Bash commands that set/export UAP_DELIVER_BYPASS or relax UAP_ENFORCE_DELIVERY,
    write those to a file, delete/chmod a policy enforcer, or mutate the policy
    database directly (`sqlite3 … policies.db "UPDATE/DELETE/INSERT…"`).

The sanctioned COMPLIANCE artifact dir (.uap/reviews/) and the review waiver dir
(policies/waivers/) are explicitly ALLOWED — other gates DEMAND agents write
there, so blocking them would deadlock the two gates. Only the real control
surface (enforcer code, policy DB, proxy env, hook scripts, bypass flags) is
protected. Reads are never blocked.

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
    # The policy DATABASE itself — the enforcers are looked up from here
    # (isActive rows, executable_tools). A direct write to it (or a flip of a
    # policy row) disables the gate just as surely as editing an enforcer, so it
    # is the real bypass surface and must be protected.
    "policies.db",
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
# Destructive ops against the enforcer/policy surface (including the policy DB).
DESTRUCTIVE = re.compile(
    r"\b(rm|unlink|shred|truncate|mv|chmod)\b[^\n|;&]*"
    r"(\.policy-tools|src/policies|/policies/|anthropic-proxy\.env|policies\.db)",
    re.I,
)
# Direct MUTATION of the policy database via sqlite3 bypasses the enforcers
# entirely (flip isActive, delete a policy row, rewrite executable_tools). Match
# order-independently: sqlite3 present, policies.db present, and a WRITE verb
# present. SELECT / .dump / .schema (reads) carry no write verb and stay allowed.
_SQLITE_BIN_RE = re.compile(r"\bsqlite3\b", re.I)
_POLICY_DB_RE = re.compile(r"policies\.db", re.I)
_SQL_WRITE_VERB_RE = re.compile(r"\b(update|delete|insert|replace|drop|alter|create|attach|vacuum)\b", re.I)
# Quote-masking: a bypass/DB token that appears only INSIDE a quoted argument
# (e.g. a `uap memory store "...text..."`, a grep pattern, a commit message) is
# TEXT, not a command token. Blank quoted spans (length-preserving) before the
# db-mutation / destructive scans so only a REAL invocation is matched. Env
# bypass-flag assignments are normally unquoted, so those keep scanning raw.
_SP_QUOTED_RE = re.compile(r"'[^']*'|\"[^\"]*\"")
def _mask_quotes(cmd: str) -> str:
    return _SP_QUOTED_RE.sub(lambda m: " " * len(m.group(0)), cmd)

OVERRIDE = os.environ.get("UAP_SELF_PROTECT_OFF") == "1"


def _is_protected_path(rel_posix: str) -> bool:
    # Ensure a leading separator so slash-anchored markers ("/policies/",
    # "/src/policies/", …) match only a genuine path SEGMENT. Filename markers
    # ("uap-policy-gate.sh", "anthropic-proxy.env", "policies.db") still match as
    # substrings.
    low = "/" + rel_posix.lower().lstrip("/")
    # Designed-writable escape hatches that live UNDER a protected marker but are
    # NOT part of the delivery-enforcement control surface: expert-review
    # artifacts (.uap/reviews/) and the committable review waiver
    # (policies/waivers/). Writing these satisfies the SEPARATE
    # expert-review-required gate and cannot weaken delivery enforcement — the
    # markers above still guard .uap.json, proxy env, enforcer code, the policy
    # DB and hooks. Without this carve-out the two gates deadlock: expert-review
    # demands an artifact that self-protect forbids writing.
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
        # Mask quotes ONLY to detect the real sqlite3 BINARY (an unquoted command
        # token) — a quoted "sqlite3" inside memory text / a message is not a real
        # invocation. But the DB name and the SQL WRITE VERB are legitimately
        # QUOTED in a real command (`sqlite3 db "UPDATE ..."`), so match those
        # against the RAW command or a genuine write would slip through.
        _scan = _mask_quotes(cmd)
        if _SQLITE_BIN_RE.search(_scan) and _POLICY_DB_RE.search(cmd) and _SQL_WRITE_VERB_RE.search(cmd):
            emit(
                False,
                "BLOCKED: directly mutating the policy database (policies.db) with "
                "sqlite3 is not allowed for the agent — flipping a policy row or "
                "rewriting executable_tools disables the enforcers just like editing "
                "them. Reads (SELECT/.dump/.schema) are fine. "
                "(Operator-only override: UAP_SELF_PROTECT_OFF=1.)",
            )
        if DESTRUCTIVE.search(_scan):
            emit(
                False,
                "BLOCKED: modifying/removing the policy enforcers, the policy "
                "database, or the proxy env is not allowed for the agent.",
            )
        emit(True, "no enforcement-tampering in command")

    emit(True, "not a protected operation")


if __name__ == "__main__":
    main()
