#!/usr/bin/env python3
"""bearer-lockdown enforcer — UAP gate for ADR-0007 cookie-only frontend.

Blocks Write/Edit tool calls that would reintroduce any of the seven
ADR-0007 invariants. Mirrors scripts/bearer-lockdown-scan.sh but runs at
tool-call time so agents are prevented from writing the regression in
the first place, not merely caught at CI time.

Invariants enforced (details in docs/adr/ADR-0007-cookie-only-frontend.md):
    FE-NO-BEARER           Frontend code must not set Authorization: Bearer.
    FE-NO-STORAGE          No token keys in localStorage / sessionStorage.
    PROXY-NO-BYPASS        No --skip-jwt-bearer-tokens=true on oauth2-proxy.
    BACKEND-NO-CLIENT-AUTH Backend must not read client Authorization header.
    AUTH-ME-OPAQUE         /auth/me must emit user_ref, not raw user_id.
    NO-COMMITTED-JWT       No RS256 JWT (>100 chars) anywhere.

The ISTIO-DENY-ALIVE invariant is runtime-only (Kyverno + alerts) since
tool-level detection would require reasoning about the whole cluster state.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent))
from _common import emit, parse_cli  # noqa: E402

# --------------------------------------------------------------------------
# Rule definitions. Each rule has:
#   - id: short code (matches scanner/semgrep IDs)
#   - path_include: list of glob prefixes the file must match
#   - path_exclude: list of glob substrings that veto the rule
#   - pattern: compiled regex matched against the written content
#   - message: explanation shown to the agent when blocked
# --------------------------------------------------------------------------
RULES: list[dict[str, Any]] = [
    {
        "id": "BL-001",
        "invariant": "FE-NO-BEARER",
        "path_include": ("apps/web/", "apps/cms/", "apps/marketing/"),
        "path_exclude": (
            "/tests/",
            "/test/",
            ".test.",
            ".spec.",
            "/node_modules/",
            "/dist/",
        ),
        "ext": (".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs"),
        # Match Authorization followed by Bearer on the same line, with
        # optional quoting/colon/equals between them. False positives on
        # JS comments in scoped paths are rare and easy to rephrase — the
        # scanner + semgrep catch the same, so redundancy is fine.
        "pattern": re.compile(
            r"Authorization[\"']?\s*[:=]\s*[\"'`]?Bearer\b",
        ),
        "message": (
            "ADR-0007 FE-NO-BEARER: frontend code must not set "
            "`Authorization: Bearer`. Auth rides on the httpOnly "
            "`_oauth2_proxy` cookie only. See "
            "docs/adr/ADR-0007-cookie-only-frontend.md."
        ),
    },
    {
        "id": "BL-002",
        "invariant": "FE-NO-STORAGE",
        "path_include": ("apps/web/", "apps/cms/", "apps/marketing/"),
        "path_exclude": (
            "/tests/",
            "/test/",
            ".test.",
            ".spec.",
            "/node_modules/",
        ),
        "ext": (".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs"),
        "pattern": re.compile(
            r"(local|session)Storage\.setItem\s*\(\s*[\"'](access_token|refresh_token|id_token|auth_token|authToken|bearer_token)[\"']",
        ),
        "message": (
            "ADR-0007 FE-NO-STORAGE: token-like keys must not be written to "
            "localStorage/sessionStorage (XSS-reachable). Auth is cookie-only. "
            "See docs/adr/ADR-0007-cookie-only-frontend.md."
        ),
    },
    {
        "id": "BL-003",
        "invariant": "PROXY-NO-BYPASS",
        "path_include": ("infra/",),
        "path_exclude": (
            "infra/archive/",
            "infra/k8s/archive/",
            # Policy files that reference the forbidden flag to enforce it.
            "infra/policies/rego/bearer_lockdown.rego",
            "infra/k8s/kyverno/",
            "infra/k8s/istio/authz-policy-deny-client-bearer.yaml",
        ),
        "ext": None,  # any extension
        "pattern": re.compile(r"--skip-jwt-bearer-tokens=true"),
        "message": (
            "ADR-0007 PROXY-NO-BYPASS: oauth2-proxy must not carry "
            "`--skip-jwt-bearer-tokens=true`. It lets a client-held Bearer "
            "substitute for the session cookie. See "
            "docs/adr/ADR-0007-cookie-only-frontend.md."
        ),
    },
    {
        "id": "BL-006",
        "invariant": "BACKEND-NO-CLIENT-AUTH",
        "path_include": ("apps/api/",),
        "path_exclude": ("apps/api/tests/",),
        "ext": (".hpp", ".cpp", ".h"),
        "pattern": re.compile(
            r'get_header_value\s*\(\s*"authorization"\s*\)',
        ),
        "message": (
            "ADR-0007 BACKEND-NO-CLIENT-AUTH: the backend must not read the "
            "client `Authorization` header. JWT is resolved from proxy-set "
            "headers (`X-Forwarded-Access-Token` or "
            "`x-auth-request-access-token`) only. See "
            "docs/adr/ADR-0007-cookie-only-frontend.md."
        ),
    },
    {
        "id": "BL-007",
        "invariant": "AUTH-ME-OPAQUE",
        "path_include": ("apps/api/src/handlers/auth_handler.cpp",),
        "path_exclude": (),
        "ext": None,
        "pattern": re.compile(r'response\s*\[\s*"user_id"\s*\]\s*='),
        "message": (
            "ADR-0007 AUTH-ME-OPAQUE: /auth/me must return `user_ref` "
            "(opaque HMAC of user_id), not the raw Zitadel `user_id`. See "
            "apps/api/include/pay2u/utils/token.hpp::deriveUserRef and "
            "docs/adr/ADR-0007-cookie-only-frontend.md."
        ),
    },
    {
        "id": "BL-004",
        "invariant": "NO-COMMITTED-JWT",
        "path_include": ("",),  # any path
        "path_exclude": (
            "scripts/bearer-lockdown-scan.sh",
            ".gitleaks.toml",
            ".semgrep/",
            "docs/adr/",
            ".policy-tools/bearer_lockdown.py",
        ),
        "ext": None,
        # Require >=100 chars after header to skip truncated doc examples.
        "pattern": re.compile(r"eyJhbGciOiJSUzI1NiI[A-Za-z0-9_-]{100,}"),
        "message": (
            "ADR-0007 NO-COMMITTED-JWT: RS256 JWT detected in content. "
            "Tokens must never be committed to the repository — they are "
            "real credentials with long TTLs. See "
            "docs/adr/ADR-0007-cookie-only-frontend.md."
        ),
    },
    {
        # Frontend must not READ the upstream-bound auth headers from any
        # Response. They are stripped at the gateway egress, but blocking
        # the read at write-time prevents code that would silently break
        # once the strip lands (or worse, ship before it lands).
        "id": "BL-008",
        "invariant": "XAUTH-FE-NO-READ",
        "path_include": ("apps/web/", "apps/cms/", "apps/marketing/"),
        "path_exclude": (
            "/tests/",
            "/test/",
            ".test.",
            ".spec.",
            "/node_modules/",
            "/dist/",
        ),
        "ext": (".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs"),
        # Match any reference to one of the forbidden header names in
        # string-literal form. Case-insensitive — HTTP header names are.
        "pattern": re.compile(
            r"""['"](?i:x-auth-request-(?:email|preferred-username|user|access-token|groups|jti)|x-forwarded-access-token)['"]""",
        ),
        "message": (
            "ADR-0007 XAUTH-FE-NO-READ: frontend code must not reference "
            "upstream-bound auth headers (`x-auth-request-*`, "
            "`x-forwarded-access-token`). They are stripped at the "
            "gateway egress and exist only between oauth2-proxy and the "
            "backend API. See "
            "infra/k8s/istio/envoyfilter-strip-auth-egress-headers.yaml "
            "and docs/adr/ADR-0007-cookie-only-frontend.md."
        ),
    },
    {
        # Backend must not EMIT (set as response header) any of the
        # forbidden auth-bound names. Defence-in-depth against a future
        # handler accidentally echoing an upstream header back to the caller.
        "id": "BL-009",
        "invariant": "XAUTH-BE-NO-EMIT",
        "path_include": ("apps/api/",),
        "path_exclude": ("apps/api/tests/",),
        "ext": (".hpp", ".cpp", ".h"),
        # Match `set_header("authorization", ...)`,
        # `set_header("x-auth-request-...", ...)`, etc. Case-insensitive.
        "pattern": re.compile(
            r"""set_header\s*\(\s*['"](?i:authorization|x-auth-request-(?:email|preferred-username|user|access-token|groups|jti)|x-forwarded-access-token|x-access-token|x-id-token)['"]""",
        ),
        "message": (
            "ADR-0007 XAUTH-BE-NO-EMIT: backend handlers must not write "
            "auth-bound headers (`Authorization`, `x-auth-request-*`, "
            "`x-forwarded-access-token`, `x-access-token`, `x-id-token`) "
            "into responses. The gateway strips them as a safety net but "
            "this rule prevents the source from ever being introduced. "
            "See docs/adr/ADR-0007-cookie-only-frontend.md."
        ),
    },
]


def _extract_write_target(op: str, args: dict[str, Any]) -> tuple[str, str] | None:
    """Return (file_path, content) if this call writes/edits a file, else None."""
    tool = op.lower()
    if tool == "write":
        fp = args.get("file_path") or ""
        content = args.get("content") or ""
        return fp, content
    if tool == "edit":
        fp = args.get("file_path") or ""
        # For Edit, only the new_string is the newly-introduced content.
        new = args.get("new_string") or ""
        return fp, new
    if tool == "multiedit":
        fp = args.get("file_path") or ""
        edits = args.get("edits") or []
        content = "\n".join(e.get("new_string", "") for e in edits if isinstance(e, dict))
        return fp, content
    if tool == "notebookedit":
        fp = args.get("notebook_path") or ""
        content = args.get("new_source") or ""
        return fp, content
    return None


def _path_matches(path: str, includes: tuple[str, ...], excludes: tuple[str, ...]) -> bool:
    """True if path is under any include prefix and not under any exclude."""
    # "" in includes means match any path.
    if not any(inc == "" or inc in path for inc in includes):
        return False
    for exc in excludes:
        if exc and exc in path:
            return False
    return True


def _ext_ok(path: str, exts: tuple[str, ...] | None) -> bool:
    if exts is None:
        return True
    return any(path.endswith(e) for e in exts)


def main() -> None:
    op, args = parse_cli()
    target = _extract_write_target(op, args)
    if target is None:
        emit(True, "not a write/edit operation")
    file_path, content = target
    if not file_path:
        emit(True, "no file path in args")

    # Normalize: strip leading ./ or absolute prefix to repo-relative form.
    norm = file_path.replace("\\", "/")
    # Drop a leading absolute path portion up to the first known top-level dir.
    for top in ("apps/", "infra/", "services/", "docs/", "scripts/", ".github/",
                ".semgrep/", ".policy-tools/", ".claude/", "observability/"):
        idx = norm.find(top)
        if idx >= 0:
            norm = norm[idx:]
            break

    violations: list[str] = []
    for rule in RULES:
        if not _path_matches(norm, rule["path_include"], rule["path_exclude"]):
            continue
        if not _ext_ok(norm, rule["ext"]):
            continue
        if rule["pattern"].search(content):
            violations.append(f"[{rule['id']}] {rule['message']}")

    if violations:
        emit(
            False,
            "bearer-lockdown: " + " | ".join(violations),
            violations=[v for v in violations],
            adr="docs/adr/ADR-0007-cookie-only-frontend.md",
        )
    emit(True, "no bearer-lockdown violations in write")


if __name__ == "__main__":
    main()
