#!/usr/bin/env python3
"""Wire enforcer integrity into the gate and the materializer. OPERATOR-RUN.

  python3 patches/171/apply.py --check | --into DIR | (bare = apply)

self-protect guards src/policies/ and the gate scripts, so the agent that wrote
this cannot apply it. Anchors are exact; it refuses rather than half-applying.

WHY. The gate executes `.policy-tools/<policyId>_<tool>.py` — COPIES. Nothing
verified them, so the enforcement surface had two silent failure modes:

  STALE     a merged fix never re-materialized. This repo shipped that for over
            a week, and again in the session that produced this patch: suites
            green against src/, gate running last month's code.
  DESTROYED deleting one file, `_common.py`, broke all 29 enforcers at import
            and turned the gate into a no-op. Verified live.

A text scan over shell commands cannot prevent the second — `python3 -c` can
write any file and is allowed by design — which is why the previous rounds of
parser hardening could only ever raise the cost. Repair is the durable control:
the surface restores itself on the next tool call, so destroying it buys one
call instead of permanent silence, and staleness self-corrects.

GATE COST. One `sha256sum -c` over ~30 small files, ~3-8ms, against a gate that
already spawns dozens of python3 interpreters per call. Falls back to `shasum`
on macOS, and skips verification (never blocks) when neither exists.
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
REGISTRY = "src/policies/policy-tools.ts"

# ── gate: verify + repair, replacing the _common.py-only self-heal ────────────
GATE_OLD = '''# Every materialized enforcer does `from _common import ...`, so that single
# file is a single point of failure for the WHOLE surface: remove it and all 29
# enforcers die at import, self-protect included. Repair it before enforcing
# rather than only failing closed -- a control surface that self-heals beats one
# that merely notices. If it cannot be restored, the SEC_SENSITIVE checks below
# still fail closed.
if [[ ! -f "$MAIN_ROOT/.policy-tools/_common.py" \\
      && -f "$MAIN_ROOT/src/policies/enforcers/_common.py" ]]; then
  cp "$MAIN_ROOT/src/policies/enforcers/_common.py" \\
     "$MAIN_ROOT/.policy-tools/_common.py" 2>/dev/null || true
fi'''

GATE_NEW = '''# INTEGRITY: the gate runs COPIES in .policy-tools/. Verify them against the
# manifest written at materialization and restore anything changed or missing,
# BEFORE any enforcer runs. This is the durable control: a text scan over shell
# commands cannot stop `python3 -c` from rewriting an enforcer (that is allowed
# by design), but it does not need to if the surface repairs itself on the next
# call. Covers the two observed failures — a stale copy leaving a merged fix
# inert, and deleting _common.py to kill all 29 enforcers at import.
#
# Cost is one hash pass over ~30 small files. `sha256sum` on Linux, `shasum` on
# macOS; with neither, verification is skipped rather than blocking work.
_PT="$MAIN_ROOT/.policy-tools"
if [[ -f "$_PT/.integrity.sha256" ]]; then
  _SUM=""
  command -v sha256sum >/dev/null 2>&1 && _SUM="sha256sum"
  [[ -z "$_SUM" ]] && command -v shasum >/dev/null 2>&1 && _SUM="shasum -a 256"
  if [[ -n "$_SUM" ]]; then
    # `|| true` is load-bearing: sha256sum exits non-zero when a check fails,
    # and under `set -euo pipefail` that status propagates out of the command
    # substitution and kills the gate — turning a repairable drift into a dead
    # hook. Match only the FAILED lines: they cover BOTH a changed file
    # ("x.py: FAILED") and a missing one ("x.py: FAILED open or read"), while
    # sha256sum's own stderr ("sha256sum: x.py: No such file...") would
    # otherwise be captured with its prefix and restore a file called
    # "sha256sum: x.py".
    _BAD="$( cd "$_PT" && { $_SUM --quiet -c .integrity.sha256 2>/dev/null \\
             | sed -n 's/^\\(.*\\): FAILED.*$/\\1/p'; } || true )"
    if [[ -n "$_BAD" ]]; then
      _SRC=""
      [[ -f "$_PT/.integrity.source" ]] && _SRC="$(cat "$_PT/.integrity.source" 2>/dev/null)"
      [[ -d "$_SRC" ]] || _SRC="$MAIN_ROOT/src/policies/enforcers"
      while IFS= read -r _f; do
        [[ -z "$_f" ]] && continue
        # copies are <uuid>_<tool>.py; sources are <tool>.py
        _base="${_f#*_}"; [[ "$_f" == "_common.py" ]] && _base="_common.py"
        [[ -f "$_SRC/$_base" ]] && cp "$_SRC/$_base" "$_PT/$_f" 2>/dev/null || true
      done <<< "$_BAD"
      printf '%s\\t%s\\n' "$(date +%s)" "restored: $(echo "$_BAD" | tr '\\n' ' ')" \\
        >> "$MAIN_ROOT/.uap/evidence/integrity.log" 2>/dev/null || true
    fi
  fi
fi
# Helper fallback for surfaces that predate the manifest.
if [[ ! -f "$_PT/_common.py" \\
      && -f "$MAIN_ROOT/src/policies/enforcers/_common.py" ]]; then
  cp "$MAIN_ROOT/src/policies/enforcers/_common.py" \\
     "$_PT/_common.py" 2>/dev/null || true
fi'''

# ── materializer: record the manifest after writing a tool ───────────────────
REG_OLD = """    const filePath = join(this.toolDir, `${policyId}_${toolName}.py`);
    writeFileSync(filePath, pythonCode);
    this.ensureCommonModule();

    return filePath;"""

REG_NEW = """    const filePath = join(this.toolDir, `${policyId}_${toolName}.py`);
    writeFileSync(filePath, pythonCode);
    this.ensureCommonModule();
    // Record hashes so the gate can verify — and repair — what it executes.
    // Best-effort: failing to write a manifest must never fail an install.
    try {
      const { writeIntegrityManifest } = await import('../integrity/enforcer-manifest.js');
      writeIntegrityManifest(this.toolDir);
    } catch {
      /* integrity manifest is an optimisation for the gate, not a gate itself */
    }

    return filePath;"""

EDITS = {REGISTRY: ((REG_OLD, REG_NEW),)}
for _g in GATE_COPIES:
    EDITS[_g] = ((GATE_OLD, GATE_NEW),)


def process(root: Path, into: Path | None, check_only: bool) -> int:
    problems = 0
    for rel, pairs in EDITS.items():
        src = root / rel
        if not src.is_file():
            print(f"MISSING  {rel}")
            problems += 1
            continue
        text = original = src.read_text()
        for old, new in pairs:
            if new in text:
                continue
            if old not in text:
                print(f"ANCHOR-DRIFT  {rel}")
                problems += 1
                break
            text = text.replace(old, new, 1)
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
    print(f"{problems} problem(s) — nothing applied for those files." if problems else "OK")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
