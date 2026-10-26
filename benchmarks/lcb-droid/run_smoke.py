#!/usr/bin/env python3
"""LCB-Droid smoke driver (Phase 1, arm 2, concurrency 1).

Runs droid exec against each rendered smoke-10 workdir through the live UAP
chain (Droid -> anthropic-proxy :4000 -> strata :8080):

    droid exec --skip-permissions-unsafe \
        --model "custom:Qwen3.8-IQ3_S-(UAP-local)-0" \
        --only-tools Read,Glob,Grep,LS,Create,Edit,Execute \
        --output-format json --max-turns 60 --cwd <workdir> "$(task.txt)"

Per problem:
  - pre-flight chain snapshot (:8080/health, :8080/v1/models, :4000/v1/models,
    systemctl --user is-active for strata/tqllm/proxy units) — recorded with
    the attempt;
  - fresh attempt: a leftover solution.py from an interrupted run is wiped;
  - 60-minute wall cap: on timeout the process group is killed and
    solution.py is collected ANYWAY (collect-at-cap);
  - public gate run once post-attempt for the record (signal only — the
    official score is the hidden-test scorer, score_smoke.py);
  - one JSONL record per attempt (resumable: problems with final=true in
    records.jsonl are skipped).

System python3 (no venv needed). Usage:
    python3 run_smoke.py [--only <qid>] [--dry-run]
"""

import argparse
import hashlib
import json
import os
import shutil
import signal
import subprocess
import sys
import time
import urllib.request
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
ART = HERE.parent.parent / "benchmark-results" / "lcb-droid-smoke-20261025-175708"
PROBLEMS = ART / "problems"
LOGS = ART / "logs"
RECORDS = ART / "records.jsonl"

MODEL = "custom:Qwen3.8-IQ3_S-(UAP-local)-0"
ONLY_TOOLS = "Read,Glob,Grep,LS,Create,Edit,Execute"
WALL_CAP_S = 3600
MAX_TURNS = 60

STRATA_HEALTH = "http://127.0.0.1:8080/health"
STRATA_MODELS = "http://127.0.0.1:8080/v1/models"
PROXY_MODELS = "http://127.0.0.1:4000/v1/models"
UNITS = [
    "uap-strata-server",
    "uap-tqllm-server",
    "uap-tqllm-abliterated-server",
    "uap-anthropic-proxy",
]


def http_json(url, timeout=10):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return json.loads(r.read().decode())
    except Exception as e:  # noqa: BLE001 - snapshot must never abort the run
        return {"_error": f"{type(e).__name__}: {e}"}


def snapshot_chain():
    units = {}
    for u in UNITS:
        p = subprocess.run(
            ["systemctl", "--user", "is-active", u],
            capture_output=True, text=True, timeout=15,
        )
        units[u] = p.stdout.strip() or p.stderr.strip()
    return {
        "utc": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "strata_health": http_json(STRATA_HEALTH),
        "strata_models": http_json(STRATA_MODELS),
        "proxy_models": http_json(PROXY_MODELS),
        "units": units,
    }


def chain_ok(snap):
    problems = []
    if snap["units"].get("uap-strata-server") != "active":
        problems.append("strata not active")
    if snap["units"].get("uap-anthropic-proxy") != "active":
        problems.append("proxy not active")
    if "_error" in snap["strata_health"]:
        problems.append("strata :8080/health unreachable")
    return problems


def fresh_workdir(wid: Path):
    """Wipe leftovers from an interrupted attempt so every attempt is clean."""
    for leftover in ("solution.py", "__pycache__"):
        p = wid / leftover
        if p.is_dir():
            shutil.rmtree(p)
        elif p.exists():
            p.unlink()


def collect_solution(wid: Path):
    sol = wid / "solution.py"
    if not sol.exists():
        return None
    data = sol.read_bytes()
    return {
        "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
    }


def public_gate(wid: Path):
    if not (wid / "solution.py").exists():
        return {"ran": False, "passed": False, "why": "no solution.py"}
    try:
        r = subprocess.run(
            ["bash", "run_gate.sh"], cwd=wid,
            capture_output=True, text=True, timeout=900,
        )
        return {
            "ran": True,
            "passed": r.returncode == 0,
            "tail": (r.stdout.strip().splitlines() or [""])[-1][:200],
        }
    except subprocess.TimeoutExpired:
        return {"ran": True, "passed": False, "why": "gate itself timed out"}


def parse_droid_log(path: Path):
    """Robust, best-effort stats from the droid JSONL stream."""
    types = Counter()
    parsed = 0
    assistant_msgs = 0
    last_text = ""
    hit_cap_marker = False
    for line in path.read_text(errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        parsed += 1
        t = ev.get("type") or ev.get("event") or "?"
        types[t] += 1
        blob = json.dumps(ev)
        if "assistant" in str(t):
            assistant_msgs += 1
            msg = ev.get("message") or {}
            content = msg.get("content") if isinstance(msg, dict) else None
            if isinstance(content, list):
                for c in content:
                    if isinstance(c, dict) and c.get("type") == "text":
                        last_text = c.get("text", last_text)
            elif isinstance(content, str) and content:
                last_text = content
        for marker in ("max_turns", "turn limit", "MAX_TURNS"):
            if marker in blob:
                hit_cap_marker = True
    return {
        "events_parsed": parsed,
        "event_types": dict(types),
        "assistant_msgs": assistant_msgs,
        "last_text_tail": last_text[-500:],
        "cap_marker": hit_cap_marker,
    }


def recorded_final_ids():
    if not RECORDS.exists():
        return set()
    done = set()
    for line in RECORDS.read_text().splitlines():
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if rec.get("final"):
            done.add(rec["question_id"])
    return done


def append_record(rec):
    with RECORDS.open("a") as f:
        f.write(json.dumps(rec) + "\n")


def run_problem(man, dry=False):
    qid = man["question_id"]
    wid = Path(man["workdir"])
    log_out = LOGS / f"{qid}.droid.jsonl"
    log_err = LOGS / f"{qid}.droid.err"

    snap = snapshot_chain()
    chain_problems = chain_ok(snap)
    if chain_problems:
        print(f"[{qid}] CHAIN NOT READY: {chain_problems} — aborting this attempt", flush=True)
        return False

    fresh_workdir(wid)
    task = (wid / "task.txt").read_text()
    cmd = [
        "droid", "exec", "--skip-permissions-unsafe",
        "--model", MODEL,
        "--only-tools", ONLY_TOOLS,
        "--output-format", "json",
        "--max-turns", str(MAX_TURNS),
        "--cwd", str(wid),
        task,
    ]
    if dry:
        print(f"[{qid}] DRY-RUN cmd ok; chain: "
              f"strata={snap['strata_models'].get('data', [{}])[0].get('id', '?') if isinstance(snap['strata_models'], dict) and not snap['strata_models'].get('_error') else 'ERR'} "
              f"units={snap['units']}", flush=True)
        return True

    t0 = time.time()
    print(f"[{qid}] launching droid exec (cap {WALL_CAP_S}s)...", flush=True)
    timed_out = False
    with log_out.open("w") as fo, log_err.open("w") as fe:
        proc = subprocess.Popen(
            cmd, stdout=fo, stderr=fe,
            start_new_session=True, cwd=str(wid),
        )
        try:
            rc = proc.wait(timeout=WALL_CAP_S)
        except subprocess.TimeoutExpired:
            timed_out = True
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            rc = proc.wait()
    wall = round(time.time() - t0, 1)

    stats = parse_droid_log(log_out)
    solution = collect_solution(wid)
    gate = public_gate(wid)

    if timed_out:
        stop_reason = "wall-cap"
    elif solution is None:
        stop_reason = "no-solution"
    elif stats["cap_marker"]:
        stop_reason = "turn-cap"
    else:
        stop_reason = "done"

    rec = {
        "question_id": qid,
        "style": man["style"],
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "final": True,
        "droid_exit": rc,
        "stop_reason": stop_reason,
        "wall_s": wall,
        "solution": solution,
        "public_gate": gate,
        "served": snap,
        "droid": stats,
        "log": str(log_out),
    }
    append_record(rec)
    print(
        f"[{qid}] stop={stop_reason} wall={wall}s exit={rc} "
        f"solution={'yes' if solution else 'NO'} "
        f"public_gate={'PASS' if gate.get('passed') else gate.get('why') or 'FAIL'} "
        f"assistant_msgs={stats['assistant_msgs']}",
        flush=True,
    )
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="run a single question id")
    ap.add_argument("--dry-run", action="store_true",
                    help="verify chain + prompt plumbing without launching droid")
    args = ap.parse_args()

    if shutil.which("droid") is None:
        sys.exit("droid binary not on PATH")
    LOGS.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((PROBLEMS / "manifest.json").read_text())
    if args.only:
        manifest = [m for m in manifest if m["question_id"] == args.only]
        if not manifest:
            sys.exit(f"no manifest entry for {args.only}")
    done = recorded_final_ids()
    todo = [m for m in manifest if m["question_id"] not in done]
    print(f"smoke driver: {len(manifest)} in manifest, {len(done)} already final, "
          f"{len(todo)} to run", flush=True)
    for man in todo:
        if not run_problem(man, dry=args.dry_run):
            sys.exit(1)
    print("DRIVER COMPLETE", flush=True)


if __name__ == "__main__":
    main()
