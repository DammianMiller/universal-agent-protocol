#!/usr/bin/env python3
"""O-E — aggregate the delivery-gate corpus into the model x technique x tier
table (docs/plans/model-performance-proof-options.md option O1; directed by
docs/plans/droid-client-performance-options.md option O-E).

Two sources, one honest frame — everything here is DESCRIPTIVE BY
CONSTRUCTION (no controlled arm, no paired design inside this aggregation):

1. benchmark-results/<run>/report.json — the paired A/B harness reports.
   Each row is (model, condition-arm) -> n, successRate (the gate pass),
   meanTokens, meanTurns. The arm label IS the technique. The report's own
   `discrimination` verdict is carried through verbatim so no directional
   number gets quoted as a finding.

2. The [deliver] lesson corpus in the short-term memory DBs — live delivery
   outcomes, best-%-of-gates per attempt per model (src/delivery/
   task-sync.ts recordDeliveryOutcome). These are population observations,
   single-technique (the full UAP stack), n per row = 1 attempt.

Usage:
    python3 scripts/aggregate_gate_corpus.py [--root <repo>] [--markdown]

    --markdown  emit the published-table format (default); without it, JSON.
"""

import argparse
import glob
import json
import os
import re
import sqlite3
import sys

_DELIVER_RE = re.compile(
    r"^\[deliver\]\s+"
    r"(?P<verdict>delivered in \d+ turn\(s\)"
    r"|NOT delivered after \d+ turn\(s\)"
    r"|STOPPED \(interrupted, resumable — not a gate failure\) after \d+ turn\(s\))"
    # The best-% clause is comma-separated in task-sync.ts and em-dash
    # separated in team-solve-deliver.ts; delivered runs omit it entirely.
    r"(?:\s*[,—]\s*best\s+(?P<best>\d+)%\s+of\s+gates)?"
    r"\s*—\s*model\s+(?P<model>\S+)"
    r"\s*—\s*task:\s*(?P<task>.*)",
    re.DOTALL,
)

# Model -> tier. Local fleet arms are qwen-family single-box deployments;
# everything else named here is a served cloud/frontier model. Unknown ids
# stay "local" — the fleet is this corpus's home turf.
_FRONTIER_IDS = re.compile(r"(^|[-_])(opus|haiku|sonnet|claude|gpt|glm)([-_.]|$)", re.I)


def _tier(model_id: str) -> str:
    return "frontier" if _FRONTIER_IDS.search(model_id) else "local"


def _collect_paired_reports(root: str) -> list:
    # benchmark-results/ is untracked run output — always read the MAIN
    # checkout, never the worktree (which does not carry it).
    main_root = root.split(f"{os.sep}.worktrees{os.sep}")[0]
    rows = []
    for path in sorted(glob.glob(os.path.join(main_root, "benchmark-results", "*", "report.json"))):
        try:
            with open(path, encoding="utf-8") as fh:
                report = json.load(fh).get("report") or {}
        except (OSError, ValueError):
            continue  # unreadable/permission-denied run dirs are skipped, not fatal
        meta = report.get("meta") or {}
        model = meta.get("model") or "unknown"
        discrimination = report.get("discrimination")
        disc = (
            discrimination.get("status", "unlabeled")
            if isinstance(discrimination, dict)
            else (discrimination if isinstance(discrimination, str) else "unlabeled")
        )
        for cond in report.get("perCondition") or []:
            n = cond.get("n") or 0
            rate = cond.get("successRate")
            if rate is None:
                continue
            rows.append(
                {
                    "source": os.path.basename(os.path.dirname(path)),
                    "kind": "paired-benchmark",
                    "model": model,
                    "technique": str(cond.get("label") or "unlabeled-arm"),
                    "tier": _tier(model),
                    "n": n,
                    "gateRate": rate,
                    "meanTokens": cond.get("meanTokens"),
                    "meanTurns": cond.get("meanTurns"),
                    "discrimination": disc,
                }
            )
    return rows


def _collect_bridge_mirror(root: str, seen: set, rows: list) -> None:
    """The committed UAP-MEMORY-BRIDGE blocks (CLAUDE.md) are a versioned
    snapshot of the lesson corpus — the qwen35-a3b/opus delivery lessons the
    live DB no longer carries (stranded in worktree DBs of their era)."""
    main_root = root.split(f"{os.sep}.worktrees{os.sep}")[0]
    for name in ("CLAUDE.md", "AGENTS.md"):
        path = os.path.join(main_root, name)
        try:
            with open(path, encoding="utf-8") as fh:
                text = fh.read()
        except OSError:
            continue
        # Scan the whole file, not a START..END block: some historical bridge
        # blocks in the committed mirror have END markers but lost their START
        # markers (custom-sections edits absorbed them). Membership would
        # silently drop those lessons — the whole point of this collector.
        for line in text.splitlines():
            if " - (" not in line or "[deliver]" not in line:
                continue
            m = _DELIVER_RE.match(line.split(" - (", 1)[1].split(") ", 1)[-1].strip())
            if not m:
                continue
            verdict, best, model = m.group("verdict"), m.group("best"), m.group("model")
            delivered = verdict.startswith("delivered")
            gate_rate = 1.0 if delivered else (int(best) / 100.0 if best else 0.0)
            key = (verdict, best, model, m.group("task")[:120])
            if key in seen:
                continue
            seen.add(key)
            turns_m = re.search(r"(\d+) turn", verdict)
            rows.append(
                {
                    "source": f"{name}:bridge",
                    "kind": "deliver-lesson",
                    "model": model,
                    "technique": "full-uap-stack",
                    "tier": _tier(model),
                    "n": 1,
                    "gateRate": gate_rate,
                    "meanTokens": None,
                    "meanTurns": int(turns_m.group(1)) if turns_m else None,
                    "verdict": "delivered" if delivered else (
                        "stopped-interrupted" if "STOPPED" in verdict else "not-delivered"
                    ),
                    "task": m.group("task")[:120],
                    "discrimination": "descriptive (n=1)",
                }
            )


def _collect_deliver_lessons(root: str) -> list:
    """[deliver] lessons from the main + backup short-term memory DBs (deduped
    by content). Live single-attempt observations, full-stack technique."""
    rows, seen = [], set()
    # The corpus lives in the MAIN checkout (benchmark-results/ is untracked
    # run output, so worktrees do not carry it — same rule as the memory
    # paths: always the main checkout, never a worktree).
    main_root = root.split(f"{os.sep}.worktrees{os.sep}")[0]
    dbs = sorted(
        glob.glob(os.path.join(main_root, "agents", "data", "memory", "short_term.db*"))
    )
    for db in dbs:
        if not os.path.isfile(db):
            continue
        try:
            conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        except sqlite3.Error:
            continue
        try:
            cur = conn.execute(
                "SELECT content FROM memories WHERE instr(content, '[deliver]') > 0"
            )
            for (content,) in cur:
                m = _DELIVER_RE.match(content.strip())
                if not m:
                    continue
                verdict, best, model = m.group("verdict"), m.group("best"), m.group("model")
                delivered = verdict.startswith("delivered")
                gate_rate = 1.0 if delivered else (int(best) / 100.0 if best else 0.0)
                key = (verdict, best, model, m.group("task")[:120])
                if key in seen:
                    continue
                seen.add(key)
                turns_m = re.search(r"(\d+) turn", verdict)
                rows.append(
                    {
                        "source": os.path.basename(db),
                        "kind": "deliver-lesson",
                        "model": model,
                        "technique": "full-uap-stack",
                        "tier": _tier(model),
                        "n": 1,
                        "gateRate": gate_rate,
                        "meanTokens": None,  # token cost is not recorded per lesson
                        "meanTurns": int(turns_m.group(1)) if turns_m else None,
                        "verdict": "delivered" if delivered else (
                            "stopped-interrupted" if "STOPPED" in verdict else "not-delivered"
                        ),
                        "task": m.group("task")[:120],
                        "discrimination": "descriptive (n=1)",
                    }
                )
        except sqlite3.Error:
            continue
        finally:
            conn.close()
    _collect_bridge_mirror(root, seen, rows)
    return rows


def markdown_table(rows: list) -> str:
    """Group to model x technique x tier -> pooled gate rate over pooled n."""
    grouped: dict = {}
    for r in rows:
        key = (r["model"], r["technique"], r["tier"])
        g = grouped.setdefault(
            key,
            {
                "model": r["model"],
                "technique": r["technique"],
                "tier": r["tier"],
                "n": 0,
                "pass_weighted": 0.0,
                "tokens": [],
                "turns": [],
                "disc": set(),
                "kinds": set(),
            },
        )
        g["n"] += r["n"]
        g["pass_weighted"] += r["gateRate"] * r["n"]
        if r.get("meanTokens") is not None:
            g["tokens"].append((r["meanTokens"], r["n"]))
        if r.get("meanTurns") is not None:
            g["turns"].append((r["meanTurns"], r["n"]))
        if r.get("discrimination"):
            g["disc"].add(str(r["discrimination"]))
        g["kinds"].add(r["kind"])

    def _weighted(pairs):
        tot = sum(n for _, n in pairs)
        return (sum(v * n for v, n in pairs) / tot) if tot else None

    lines = [
        "| Model | Technique | Tier | n attempts | Gate pass | Mean tokens | Mean turns | Discrimination |",
        "| --- | --- | --- | ---: | ---: | ---: | ---: | --- |",
    ]
    for g in sorted(
        grouped.values(),
        key=lambda g: (g["tier"], g["model"], g["technique"]),
    ):
        tokens = _weighted(g["tokens"])
        turns = _weighted(g["turns"])
        lines.append(
            "| {model} | {tech} | {tier} | {n} | {pct}% | {tok} | {trn} | {disc} |".format(
                model=f"`{g['model']}`",
                tech=g["technique"],
                tier=g["tier"],
                n=g["n"],
                pct=round(100 * g["pass_weighted"] / g["n"], 1) if g["n"] else "-",
                tok=round(tokens) if tokens is not None else "n/r",
                trn=round(turns, 1) if turns is not None else "n/r",
                disc="; ".join(sorted(g["disc"])),
            )
        )
    return "\n".join(lines)


def main() -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    # Script lives at <repo>/scripts/ — the repo root is one dirname up.
    default_root = os.path.dirname(here)
    ap = argparse.ArgumentParser(description="Aggregate the delivery-gate corpus")
    ap.add_argument("--root", default=default_root)
    ap.add_argument("--json", dest="as_json", action="store_true")
    args = ap.parse_args()

    rows = _collect_paired_reports(args.root) + _collect_deliver_lessons(args.root)
    if args.as_json:
        print(json.dumps(rows, indent=2, sort_keys=True))
    else:
        print(markdown_table(rows))
    return 0


if __name__ == "__main__":
    sys.exit(main())
