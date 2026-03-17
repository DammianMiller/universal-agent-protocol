#!/usr/bin/env python3
"""
scripts/compare_benchmarks.py

Compare baseline (no UAP) vs UAP-enhanced benchmark results.
Loads both JSON result files and produces a comparison report.

Usage:
    python3 scripts/compare_benchmarks.py \\
        results/baseline_results.json \\
        results/uap_results.json

Output: JSON comparison to stdout (redirect to file as needed).
"""

import json
import sys
from pathlib import Path
from typing import Dict, Any


def load_results(path: str) -> Dict[str, Any]:
    """Load benchmark results from JSON file."""
    with open(path) as f:
        return json.load(f)


def compare_tasks(baseline_tasks: list, uap_tasks: list) -> list:
    """Compare individual task results between baseline and UAP."""
    baseline_map = {t["task_id"]: t for t in baseline_tasks if "task_id" in t}
    uap_map = {t["task_id"]: t for t in uap_tasks if "task_id" in t}

    comparisons = []
    for task_id in sorted(baseline_map.keys()):
        base = baseline_map.get(task_id, {})
        uap = uap_map.get(task_id, {})

        if not uap:
            continue

        base_tokens = base.get("tokens", 0)
        uap_tokens = uap.get("tokens", 0)
        base_time = base.get("time", 0)
        uap_time = uap.get("time", 0)
        base_errors = base.get("errors", 0)
        uap_errors = uap.get("errors", 0)

        token_diff = base_tokens - uap_tokens
        token_pct = (token_diff / base_tokens * 100) if base_tokens else 0
        time_diff = base_time - uap_time
        time_pct = (time_diff / base_time * 100) if base_time else 0
        error_diff = base_errors - uap_errors
        error_pct = (error_diff / base_errors * 100) if base_errors else 0

        comparisons.append(
            {
                "task_id": task_id,
                "task_name": base.get("task_name", ""),
                "category": base.get("category", ""),
                "baseline": {
                    "tokens": base_tokens,
                    "time": base_time,
                    "errors": base_errors,
                    "success": base.get("success", False),
                },
                "uap": {
                    "tokens": uap_tokens,
                    "time": uap_time,
                    "errors": uap_errors,
                    "success": uap.get("success", False),
                },
                "improvement": {
                    "token_reduction": token_diff,
                    "token_reduction_pct": round(token_pct, 1),
                    "time_reduction": round(time_diff, 1),
                    "time_reduction_pct": round(time_pct, 1),
                    "error_reduction": error_diff,
                    "error_reduction_pct": round(error_pct, 1),
                    "success_improved": (
                        not base.get("success", False) and uap.get("success", False)
                    ),
                },
            }
        )

    return comparisons


def calculate_summary(
    baseline: Dict[str, Any],
    uap: Dict[str, Any],
    comparisons: list,
) -> Dict[str, Any]:
    """Calculate overall comparison summary."""
    base_summary = baseline.get("summary", {})
    uap_summary = uap.get("summary", {})

    base_total_tokens = base_summary.get("total_tokens", 0)
    uap_total_tokens = uap_summary.get("total_tokens", 0)
    base_total_time = base_summary.get("total_time", 0)
    uap_total_time = uap_summary.get("total_time", 0)

    # Per-task averages from comparisons
    token_reductions = [c["improvement"]["token_reduction_pct"] for c in comparisons]
    time_reductions = [c["improvement"]["time_reduction_pct"] for c in comparisons]
    error_reductions = [
        c["improvement"]["error_reduction_pct"]
        for c in comparisons
        if c["baseline"]["errors"] > 0
    ]

    tasks_improved = sum(1 for c in comparisons if c["improvement"]["success_improved"])

    return {
        "baseline_total_tokens": base_total_tokens,
        "uap_total_tokens": uap_total_tokens,
        "total_token_savings": base_total_tokens - uap_total_tokens,
        "overall_token_reduction_pct": round(
            (1 - uap_total_tokens / base_total_tokens) * 100, 1
        )
        if base_total_tokens
        else 0,
        "avg_token_reduction": round(sum(token_reductions) / len(token_reductions), 1)
        if token_reductions
        else 0,
        "baseline_total_time": base_total_time,
        "uap_total_time": round(uap_total_time, 1),
        "total_time_savings": round(base_total_time - uap_total_time, 1),
        "avg_time_reduction": round(sum(time_reductions) / len(time_reductions), 1)
        if time_reductions
        else 0,
        "baseline_success_rate": base_summary.get("success_rate", 0),
        "uap_success_rate": uap_summary.get("success_rate", 0),
        "success_rate_improvement": round(
            (uap_summary.get("success_rate", 0) - base_summary.get("success_rate", 0))
            * 100,
            1,
        ),
        "tasks_with_improved_success": tasks_improved,
        "avg_error_reduction": round(sum(error_reductions) / len(error_reductions), 1)
        if error_reductions
        else 0,
        "baseline_avg_errors": base_summary.get("avg_errors", 0),
        "uap_avg_errors": uap_summary.get("avg_errors", 0),
    }


def main():
    """Main entry point."""
    if len(sys.argv) < 3:
        print("Usage: python3 compare_benchmarks.py <baseline.json> <uap.json>")
        print()
        print("If result files don't exist yet, run the benchmarks first:")
        print("  python3 scripts/run_baseline_benchmark.py")
        print("  python3 scripts/run_uap_benchmark.py")
        sys.exit(1)

    baseline_path = sys.argv[1]
    uap_path = sys.argv[2]

    # Load results
    baseline = load_results(baseline_path)
    uap = load_results(uap_path)

    # Compare tasks
    comparisons = compare_tasks(
        baseline.get("tasks", []),
        uap.get("tasks", []),
    )

    # Calculate summary
    summary = calculate_summary(baseline, uap, comparisons)

    # Build output
    output = {
        "comparison_timestamp": __import__("time").strftime("%Y-%m-%dT%H:%M:%S"),
        "baseline_mode": baseline.get("mode", "unknown"),
        "uap_mode": uap.get("mode", "unknown"),
        "uap_version": uap.get("uap_version", "unknown"),
        "summary": summary,
        "tasks": comparisons,
        "optimizations_applied": uap.get("optimizations_applied", {}),
    }

    # Output JSON
    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
