#!/usr/bin/env python3
"""
Generate a `uap bench paired` task suite from SWE-bench Pro instances.

The paired harness (src/benchmarks/paired/) scores an agent by copying a local
`repo/` fixture into an isolated scratch dir, running the agent in it, then
running a HIDDEN `verifyCmd` that exits 0 iff the task is resolved. This script
turns each SWE-bench Pro instance into exactly that shape:

  <out>/<instance_id>/
    task.json                     # TaskSpec (instruction, verify/gate/setup, timeouts)
    repo/                         # target repo checked out at base_commit (failing state)
      .swebench/spec.json         # instance_id, base_commit, FAIL_TO_PASS, PASS_TO_PASS
      .swebench/test.patch        # the instance's test patch (applied at verify time)
      .swebench/setup.sh          # best-effort local dep install (for the agent's gate loop)
      .swebench/gate.sh           # VISIBLE self-verify subset (what the UAP gate loop optimizes)
      .swebench/verify.sh         # HIDDEN ground truth — delegates to the official swebench eval

Scoring model: the agent edits the working tree in place; `verify.sh` derives
the agent's patch as `git diff` against base_commit and hands it to the official
SWE-bench evaluation harness (Docker) as a single-instance prediction. That keeps
canonical ground truth (correct per-repo test commands + log parsing) without
reimplementing it — see SWEBENCH_VERIFY_MODE in verify.sh for a Docker-free
fallback.

Usage:
  python generate.py --instances swe_bench_pro_public.jsonl --out ../swe-bench-pro-generated
  python generate.py --instances tasks.jsonl --out /tmp/sbp --limit 25 --shallow

Then run the A/B (see run-ab.sh):
  uap bench paired --suite ../swe-bench-pro-generated --adapter opencode \
      --model qwen36-a3b --epochs 5 --lazy
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

VERIFY_SH = r"""#!/usr/bin/env bash
# HIDDEN ground-truth verifier for one SWE-bench Pro instance.
# The agent has edited this working tree; we score its changes.
#   SWEBENCH_VERIFY_MODE=official  (default) -> official Docker eval, canonical
#   SWEBENCH_VERIFY_MODE=local              -> apply test patch + run tests locally
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/.." && pwd)"
cd "$repo_root" || exit 3
spec="$here/spec.json"
mode="${SWEBENCH_VERIFY_MODE:-official}"

# The agent's patch = everything it changed on top of the base working state
# (the `uap-base` ref), excluding the .swebench control dir.
iid="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["instance_id"])' "$spec")"
git -C "$repo_root" add -A >/dev/null 2>&1
pred="$(git -C "$repo_root" diff --cached uap-base -- . ':(exclude).swebench' 2>/dev/null)"
git -C "$repo_root" reset -q >/dev/null 2>&1 || true

if [ -z "$pred" ]; then
  echo "verify: agent produced no diff -> unresolved" >&2
  exit 1
fi

if [ "$mode" = "official" ]; then
  # Feed the agent's diff to the canonical evaluator as a single-instance prediction.
  work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
  printf '%s' "$pred" > "$work/model_patch.diff"
  python3 - "$iid" "$work/model_patch.diff" "$work/preds.jsonl" <<'PY'
import json, sys
iid, patch_path, out = sys.argv[1], sys.argv[2], sys.argv[3]
with open(patch_path) as f: patch = f.read()
rec = {"instance_id": iid, "model_name_or_path": "uap-bench", "model_patch": patch}
with open(out, "w") as f: f.write(json.dumps(rec) + "\n")
PY
  # Requires: pip install swebench ; Docker daemon ; the instance image pullable.
  runner="${SWEBENCH_RUNNER:-swebench.harness.run_evaluation}"
  dataset="${SWEBENCH_DATASET:-SWE-bench/SWE-bench_Pro}"
  python3 -m "$runner" \
      --dataset_name "$dataset" \
      --predictions_path "$work/preds.jsonl" \
      --instance_ids "$iid" \
      --run_id "uap-bench-$iid" \
      --max_workers 1 >/dev/null 2>&1
  # Parse the report the harness writes for this run.
  report="$(python3 - "$iid" <<'PY'
import glob, json, sys
iid = sys.argv[1]
hits = sorted(glob.glob(f"**/uap-bench-{iid}*.json", recursive=True) +
              glob.glob(f"*uap-bench*{iid}*.json"))
resolved = False
for p in hits:
    try:
        d = json.load(open(p))
    except Exception:
        continue
    for key in ("resolved_ids", "resolved"):
        v = d.get(key)
        if isinstance(v, list) and iid in v: resolved = True
        if isinstance(v, bool) and v: resolved = True
print("RESOLVED" if resolved else "UNRESOLVED")
PY
)"
  [ "$report" = "RESOLVED" ] && exit 0 || { echo "verify: official eval -> $report" >&2; exit 1; }
fi

# --- local mode (Docker-free, less faithful) ---------------------------------
git -C "$repo_root" apply -3 "$here/test.patch" 2>/dev/null \
  || patch -p1 --forward < "$here/test.patch" >/dev/null 2>&1 || true
test_cmd="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("test_cmd") or "python -m pytest -q")' "$spec")"
mapfile -t f2p < <(python3 -c 'import json,sys;[print(x) for x in json.load(open(sys.argv[1])).get("FAIL_TO_PASS",[])]' "$spec")
mapfile -t p2p < <(python3 -c 'import json,sys;[print(x) for x in json.load(open(sys.argv[1])).get("PASS_TO_PASS",[])]' "$spec")
if ! eval "$test_cmd ${f2p[*]} ${p2p[*]}" >/dev/null 2>&1; then
  echo "verify: local test run failed -> unresolved" >&2; exit 1
fi
exit 0
"""

GATE_SH = r"""#!/usr/bin/env bash
# VISIBLE self-verify the UAP gate loop iterates against (NOT authoritative).
# Runs the PASS_TO_PASS subset locally so the agent can check it hasn't
# regressed baseline behaviour. verify.sh (hidden) remains ground truth.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here/.." || exit 3
spec="$here/spec.json"
test_cmd="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("test_cmd") or "python -m pytest -q")' "$spec")"
mapfile -t p2p < <(python3 -c 'import json,sys;[print(x) for x in json.load(open(sys.argv[1])).get("PASS_TO_PASS",[])]' "$spec")
[ "${#p2p[@]}" -eq 0 ] && { echo "gate: no PASS_TO_PASS subset; skipping"; exit 0; }
eval "$test_cmd ${p2p[*]}"
"""

SETUP_SH = r"""#!/usr/bin/env bash
# Best-effort local dependency install so the agent can build/run and use gate.sh.
# NON-FATAL: official verify runs in Docker, so a partial local setup must not
# fail the cell. Always exits 0.
set -u
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 0
{
  if [ -f pyproject.toml ] || [ -f setup.py ] || [ -f setup.cfg ]; then
    pip install -e . 2>/dev/null || pip install . 2>/dev/null || true
  fi
  if [ -f package.json ]; then
    npm ci 2>/dev/null || npm install 2>/dev/null || true
  fi
  if [ -f go.mod ]; then go mod download 2>/dev/null || true; fi
  if [ -f Cargo.toml ]; then cargo fetch 2>/dev/null || true; fi
} >/dev/null 2>&1
exit 0
"""


def git_env() -> dict:
    """process env with GIT_* repo pointers stripped (GIT_DIR poisoning guard)."""
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    return env


def run(cmd: list[str], cwd: Path | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=cwd, env=git_env(), capture_output=True, text=True)


def repo_url(repo: str) -> str:
    # Pass through full URLs, ssh specs, and local/file paths untouched; treat a
    # bare "owner/name" as a GitHub repo.
    if "://" in repo or repo.startswith(("git@", "/", ".", "~")):
        return repo
    return f"https://github.com/{repo}.git"


def checkout(repo: str, base_commit: str, dest: Path, shallow: bool, keep_git: bool) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    url = repo_url(repo)
    if shallow:
        run(["git", "init", "-q"], cwd=dest)
        run(["git", "remote", "add", "origin", url], cwd=dest)
        fetched = run(["git", "fetch", "-q", "--depth", "1", "origin", base_commit], cwd=dest)
        if fetched.returncode != 0:
            # Some hosts disallow fetch-by-sha; fall back to a full fetch.
            run(["git", "fetch", "-q", "origin"], cwd=dest)
        co = run(["git", "checkout", "-q", base_commit], cwd=dest)
        if co.returncode != 0:
            run(["git", "checkout", "-q", "FETCH_HEAD"], cwd=dest)
    else:
        run(["git", "clone", "-q", url, str(dest)])
        run(["git", "checkout", "-q", base_commit], cwd=dest)
    if not keep_git:
        shutil.rmtree(dest / ".git", ignore_errors=True)
        # A fresh repo is needed at verify time to diff the agent's changes.
        run(["git", "init", "-q"], cwd=dest)
        run(["git", "add", "-A"], cwd=dest)
        run(["git", "-c", "user.email=b@uap", "-c", "user.name=uap",
             "commit", "-q", "-m", f"base@{base_commit}"], cwd=dest)
    # Stable ref the HIDDEN verifier diffs against. Must NOT be the 40-hex sha —
    # git treats a 40-hex tag/ref name as an ambiguous "bad object" and the diff
    # silently comes back empty. `uap-base` points at the base working state in
    # both modes (fresh HEAD when re-init'd; detached base_commit when kept).
    run(["git", "tag", "-f", "uap-base"], cwd=dest)


def write_exec(path: Path, content: str) -> None:
    path.write_text(content)
    path.chmod(0o755)


def emit_task(inst: dict, out: Path, shallow: bool, keep_git: bool) -> str | None:
    iid = inst.get("instance_id") or inst.get("id")
    repo = inst.get("repo")
    base = inst.get("base_commit")
    problem = inst.get("problem_statement") or inst.get("instruction") or ""
    if not (iid and repo and base and problem):
        print(f"  skip: missing required fields ({iid=} {repo=} {bool(base)=})", file=sys.stderr)
        return None

    tdir = out / iid
    repo_dir = tdir / "repo"
    sb = repo_dir / ".swebench"
    if tdir.exists():
        shutil.rmtree(tdir)
    print(f"  {iid}: checkout {repo}@{base[:10]} …", file=sys.stderr)
    checkout(repo, base, repo_dir, shallow=shallow, keep_git=keep_git)

    sb.mkdir(parents=True, exist_ok=True)
    spec = {
        "instance_id": iid,
        "repo": repo,
        "base_commit": base,
        "FAIL_TO_PASS": inst.get("FAIL_TO_PASS") or inst.get("fail_to_pass") or [],
        "PASS_TO_PASS": inst.get("PASS_TO_PASS") or inst.get("pass_to_pass") or [],
        "test_cmd": inst.get("test_cmd") or inst.get("test_command"),
    }
    (sb / "spec.json").write_text(json.dumps(spec, indent=2))
    (sb / "test.patch").write_text(inst.get("test_patch") or inst.get("test_patch_diff") or "")
    write_exec(sb / "verify.sh", VERIFY_SH)
    write_exec(sb / "gate.sh", GATE_SH)
    write_exec(sb / "setup.sh", SETUP_SH)

    short = problem.strip().splitlines()[0][:80] if problem.strip() else iid
    task = {
        "id": iid,
        "name": f"{repo} — {short}",
        "instruction": problem.strip(),
        "difficulty": "hard",
        "tags": ["swe-bench-pro", repo],
        "repoDir": "repo",
        "setupCmd": "bash .swebench/setup.sh",
        "gateCmd": "bash .swebench/gate.sh",
        "verifyCmd": "bash .swebench/verify.sh",
        "verifyTimeoutSec": int(inst.get("verify_timeout_sec", 1800)),
        "agentTimeoutSec": int(inst.get("agent_timeout_sec", 2400)),
    }
    (tdir / "task.json").write_text(json.dumps(task, indent=2))
    return iid


def load_instances(path: Path):
    text = path.read_text()
    stripped = text.lstrip()
    if stripped.startswith("["):
        yield from json.loads(text)
    else:
        for line in text.splitlines():
            line = line.strip()
            if line:
                yield json.loads(line)


def main() -> int:
    ap = argparse.ArgumentParser(description="Generate a SWE-bench Pro paired-bench suite.")
    ap.add_argument("--instances", required=True, type=Path,
                    help="SWE-bench Pro instances as JSONL or JSON array.")
    ap.add_argument("--out", required=True, type=Path, help="Output suite directory.")
    ap.add_argument("--limit", type=int, default=0, help="Only emit the first N instances (0 = all).")
    ap.add_argument("--shallow", action="store_true", help="Shallow fetch base_commit (faster, less disk).")
    ap.add_argument("--keep-git", action="store_true",
                    help="Keep upstream .git history (default: re-init a clean repo at base).")
    args = ap.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    emitted, n = [], 0
    for inst in load_instances(args.instances):
        if args.limit and n >= args.limit:
            break
        iid = emit_task(inst, args.out, shallow=args.shallow, keep_git=args.keep_git)
        if iid:
            emitted.append(iid)
        n += 1

    (args.out / "SUITE.json").write_text(json.dumps(
        {"source": str(args.instances), "count": len(emitted), "instance_ids": emitted}, indent=2))
    print(f"\n✓ emitted {len(emitted)} tasks to {args.out}", file=sys.stderr)
    if not emitted:
        print("  (no tasks emitted — check --instances format)", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
