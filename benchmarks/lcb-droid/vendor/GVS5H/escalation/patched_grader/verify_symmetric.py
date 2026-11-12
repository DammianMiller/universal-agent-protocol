"""Symmetric re-grade of every stored generation, to verify the reported pass@1.

Unlike runs/../rescore.py, which only re-runs records that already failed, this runs
EVERY record -- pass and fail alike -- as a real subprocess against the full hidden-test
set, judged by checkers.check (special judges where defined, tolerant default otherwise).
So it can move a verdict in both directions.

The 27 call-based (starter_code) problems of LCB-100 have no stdin harness here; their
stored verdicts are carried over unchanged and counted separately.

Two things rescore.py does are deliberately not done here. It caps the address space of each
submission at 4 GiB, which the in-process evaluator being checked does not: under that cap
solutions that finish in 0.3s unlimited instead thrash to the wall-clock timeout or die with
MemoryError, and a verdict produced that way is not comparable to the one being checked. And
a 10s wall-clock limit is not safe to read under a wide fan-out on a shared box, so every
timeout is re-run at low concurrency before it is believed.
"""
import os
import sys
import json
import glob
import time
import subprocess
import tempfile
from concurrent.futures import ProcessPoolExecutor

REPO = "/home/persis/GVS5H"
sys.path.insert(0, os.path.join(REPO, "codebase", "livecodebench"))
sys.path.insert(0, os.path.join(REPO, "codebase", "v2-current", "escalation", "patched_grader"))

from checkers import check

PER_TEST_TIMEOUT = float(os.environ.get("VERIFY_TIMEOUT", "10"))
WORKERS = int(os.environ.get("VERIFY_WORKERS", "32"))
OUT = os.environ.get("VERIFY_OUT", "/tmp/verify_verdicts.json")

RUNS = os.environ.get("VERIFY_RUNS", ",".join([
    "128k-reasoning-off-1pass",
    "128k-reasoning-on-1pass",
    "16k-reasoning-off-5pass",
    "fable5-128k-reasoning-on-5pass",
    "firstparty-128k-reasoning-on-5pass",
    "q38-fn-5pass",
    "ds-v41-f-5pass",
])).split(",")


def run_one(code_path, stdin_text):
    try:
        p = subprocess.run([sys.executable, code_path], input=stdin_text,
                           capture_output=True, text=True,
                           timeout=PER_TEST_TIMEOUT)
    except subprocess.TimeoutExpired:
        return False, "", "timeout"
    except Exception as e:
        return False, "", f"error:{type(e).__name__}"
    if p.returncode != 0:
        return False, p.stdout, "runtime_error"
    return True, p.stdout, "ok"


def work(job):
    arm, qid, code, tests = job
    if not (code or "").strip():
        return arm, qid, False, "empty"
    with tempfile.TemporaryDirectory() as td:
        path = os.path.join(td, "sol.py")
        with open(path, "w") as f:
            f.write(code)
        for inp, exp in tests:
            ok, out, tag = run_one(path, inp)
            if not ok:
                return arm, qid, False, tag
            if not check(qid, inp, exp, out):
                return arm, qid, False, "wrong_answer"
    return arm, qid, True, "ok"


def main():
    from lcb_runner.benchmarks.code_generation import load_code_generation_dataset
    ds = load_code_generation_dataset(release_version=os.environ.get("LCB_RELEASE", "release_v6"))
    by_id = {p.question_id: p for p in ds}

    tests_cache = {}

    def tests_for(qid):
        if qid not in tests_cache:
            io = by_id[qid].get_evaluation_sample()["input_output"]
            io = json.loads(io) if isinstance(io, str) else io
            tests_cache[qid] = list(zip(io["inputs"], io["outputs"]))
        return tests_cache[qid]

    files = []
    for r in RUNS:
        files += [f for f in sorted(glob.glob(os.path.join(REPO, "runs", r, "results", "*.json")))
                  if ".regraded" not in f and ".patched" not in f and "corrupt" not in f]

    jobs, arms = [], {}
    for f in files:
        try:
            d = json.load(open(f))
        except Exception:
            continue
        if "lcb" not in d or not d["lcb"].get("records"):
            continue
        run = os.path.basename(os.path.dirname(os.path.dirname(f)))
        name = os.path.basename(f)[:-5]
        arm = f"{run}__{name}"
        arms[arm] = {"run": run, "name": name, "model": d.get("model"),
                     "engine": d.get("engine"), "stored": {}, "carried": {}}
        for rec in d["lcb"]["records"]:
            qid = rec["question_id"]
            arms[arm]["stored"][qid] = bool(rec.get("passed"))
            if qid not in by_id:
                arms[arm]["carried"][qid] = bool(rec.get("passed"))
                continue
            if by_id[qid].starter_code:
                arms[arm]["carried"][qid] = bool(rec.get("passed"))
                continue
            jobs.append((arm, qid, rec.get("code") or "", tests_for(qid)))

    print(f"{len(arms)} arms, {len(jobs)} records to re-run "
          f"({sum(len(a['carried']) for a in arms.values())} call-based carried over)",
          flush=True)

    fresh = {}
    done, t0 = 0, time.time()
    with ProcessPoolExecutor(max_workers=WORKERS) as ex:
        for arm, qid, passed, tag in ex.map(work, jobs, chunksize=1):
            fresh.setdefault(arm, {})[qid] = (passed, tag)
            done += 1
            if done % 200 == 0 or done == len(jobs):
                el = time.time() - t0
                rate = done / el if el else 0
                print(f"  {done}/{len(jobs)}  {el/60:.1f}m elapsed, "
                      f"~{(len(jobs)-done)/rate/60 if rate else 0:.1f}m left", flush=True)

    # A 10s wall-clock limit is not safe to read under a 48-way fan-out on a shared box:
    # the pilot turned two 0.3s solutions into timeouts. Re-run every timeout with almost
    # no contention, and keep the quiet verdict.
    retry = [j for j in jobs if fresh.get(j[0], {}).get(j[1], (None, ""))[1] == "timeout"]
    print(f"re-checking {len(retry)} timeouts at 4 workers", flush=True)
    if retry:
        with ProcessPoolExecutor(max_workers=4) as ex:
            for arm, qid, passed, tag in ex.map(work, retry, chunksize=1):
                if passed or tag != "timeout":
                    print(f"  timeout not reproduced: {arm} {qid} -> "
                          f"{'PASS' if passed else tag}", flush=True)
                fresh[arm][qid] = (passed, tag)

    out = {}
    for arm, a in arms.items():
        v = dict(a["carried"])
        for qid, (passed, _tag) in fresh.get(arm, {}).items():
            v[qid] = passed
        n = len(v)
        out[arm] = {
            "run": a["run"], "name": a["name"], "model": a["model"], "engine": a["engine"],
            "n": n,
            "stored_pass@1": round(100.0 * sum(a["stored"].values()) / n, 4),
            "verify_pass@1": round(100.0 * sum(v.values()) / n, 4),
            "n_rerun": len(fresh.get(arm, {})),
            "n_carried": len(a["carried"]),
            "fail_to_pass": sorted(q for q, (p, _) in fresh.get(arm, {}).items()
                                   if p and not a["stored"][q]),
            "pass_to_fail": sorted(q for q, (p, _) in fresh.get(arm, {}).items()
                                   if not p and a["stored"][q]),
            "tags": {q: t for q, (p, t) in fresh.get(arm, {}).items() if not p},
            "verdicts": v,
        }
    with open(OUT, "w") as f:
        json.dump(out, f, indent=1)
    print("wrote", OUT, flush=True)


if __name__ == "__main__":
    main()
