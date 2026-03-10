#!/usr/bin/env python3
"""
Record task outcome for reinforcement learning.

Called after task completion to track patterns used, success/failure,
and other metrics for self-improvement.

Usage:
    python record_task_outcome.py --task-type feature --summary "Added user auth" \
        --success --patterns P12,P13 --iterations 1 --duration 120 --tool-errors 0

    python record_task_outcome.py --task-type bug --summary "Fix login issue" \
        --failure --iterations 3 --tool-errors 2
"""

import argparse
import json
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

DB_PATH = Path(__file__).parent.parent / "data" / "memory" / "reinforcement.db"


def ensure_db():
    """Ensure reinforcement database exists with schema."""
    if not DB_PATH.exists():
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        
        conn = sqlite3.connect(DB_PATH)
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS reinforcement_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                session_id TEXT DEFAULT 'current',
                task_type TEXT NOT NULL,
                task_summary TEXT,
                patterns_selected TEXT,
                patterns_used TEXT,
                patterns_skipped TEXT,
                reward_score INTEGER DEFAULT 0,
                success BOOLEAN DEFAULT 0,
                iterations INTEGER DEFAULT 1,
                tool_errors INTEGER DEFAULT 0,
                files_changed INTEGER DEFAULT 0,
                files_needed INTEGER DEFAULT 0,
                duration_seconds INTEGER,
                memory_hits INTEGER DEFAULT 0,
                notes TEXT
            );

            CREATE TABLE IF NOT EXISTS pattern_weights (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_type TEXT NOT NULL,
                pattern TEXT NOT NULL,
                weight REAL DEFAULT 1.0,
                success_count INTEGER DEFAULT 0,
                failure_count INTEGER DEFAULT 0,
                total_uses INTEGER DEFAULT 0,
                avg_reward REAL DEFAULT 0.0,
                last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(task_type, pattern)
            );

            CREATE INDEX IF NOT EXISTS idx_reinforcement_timestamp ON reinforcement_log(timestamp);
            CREATE INDEX IF NOT EXISTS idx_reinforcement_task_type ON reinforcement_log(task_type);
        """)
        conn.commit()
        conn.close()


def calculate_reward(success: bool, iterations: int, tool_errors: int, 
                     duration_seconds: int, memory_hits: int) -> int:
    """Calculate reward score for task outcome."""
    reward = (
        +10 if success else -20
        +5 if iterations == 1 else -5 * (iterations - 1)
        -2 * tool_errors
        -0.1 * duration_seconds / 60  # Time penalty
        +3 if memory_hits > 0 else 0
    )
    return int(reward)


def record_outcome(
    task_type: str,
    task_summary: str,
    success: bool,
    patterns_selected: list[str],
    patterns_used: list[str] = None,
    patterns_skipped: list[str] = None,
    iterations: int = 1,
    tool_errors: int = 0,
    files_changed: int = 0,
    files_needed: int = 0,
    duration_seconds: int = 0,
    memory_hits: int = 0,
    notes: str = None
):
    """Record task outcome to database."""
    ensure_db()
    
    # Calculate reward
    reward = calculate_reward(success, iterations, tool_errors, 
                              duration_seconds, memory_hits)
    
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    # Insert into reinforcement log
    cursor.execute("""
        INSERT INTO reinforcement_log 
        (task_type, task_summary, patterns_selected, patterns_used, patterns_skipped,
         reward_score, success, iterations, tool_errors, files_changed, files_needed,
         duration_seconds, memory_hits, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        task_type, task_summary,
        json.dumps(patterns_selected),
        json.dumps(patterns_used or []),
        json.dumps(patterns_skipped or []),
        reward, success, iterations, tool_errors,
        files_changed, files_needed, duration_seconds,
        memory_hits, notes
    ))
    
    # Update pattern weights
    all_patterns = set((patterns_selected or []) + (patterns_used or []))
    for pattern in all_patterns:
        cursor.execute("""
            INSERT INTO pattern_weights (task_type, pattern, weight, success_count, failure_count, total_uses)
            VALUES (?, ?, 1.0, ?, ?, 1)
            ON CONFLICT(task_type, pattern) DO UPDATE SET
                success_count = success_count + ?,
                failure_count = failure_count + ?,
                total_uses = total_uses + 1,
                last_updated = CURRENT_TIMESTAMP
        """, (task_type, pattern, 
              1 if success else 0, 0 if success else 1,
              1 if success else 0, 0 if success else 1))
    
    conn.commit()
    
    # Get inserted ID
    log_id = cursor.lastrowid
    conn.close()
    
    return log_id, reward


def main():
    parser = argparse.ArgumentParser(description="Record task outcome")
    parser.add_argument("--task-type", required=True, choices=["feature", "bug", "refactor", "infra", "docs", "test"])
    parser.add_argument("--summary", required=True, help="Task summary")
    parser.add_argument("--success", action="store_true", help="Task succeeded")
    parser.add_argument("--failure", action="store_true", help="Task failed")
    parser.add_argument("--patterns", help="Comma-separated pattern IDs (e.g., P12,P13)")
    parser.add_argument("--patterns-used", help="Patterns actually used")
    parser.add_argument("--iterations", type=int, default=1, help="Number of attempts")
    parser.add_argument("--tool-errors", type=int, default=0, help="Tool failures")
    parser.add_argument("--duration", type=int, default=0, help="Duration in seconds")
    parser.add_argument("--memory-hits", type=int, default=0, help="Memory lookups")
    parser.add_argument("--notes", help="Additional notes")
    
    args = parser.parse_args()
    
    if args.success and args.failure:
        parser.error("Cannot specify both --success and --failure")
    
    success = args.success or not args.failure
    
    patterns = [p.strip() for p in (args.patterns or "").split(",") if p.strip()]
    patterns_used = [p.strip() for p in (args.patterns_used or "").split(",") if p.strip()]
    
    log_id, reward = record_outcome(
        task_type=args.task_type,
        task_summary=args.summary,
        success=success,
        patterns_selected=patterns,
        patterns_used=patterns_used,
        iterations=args.iterations,
        tool_errors=args.tool_errors,
        duration_seconds=args.duration,
        memory_hits=args.memory_hits,
        notes=args.notes
    )
    
    print(f"Recorded outcome #{log_id}")
    print(f"  Task: {args.summary}")
    print(f"  Success: {success}")
    print(f"  Reward: {reward}")
    print(f"  Patterns: {patterns}")


if __name__ == "__main__":
    main()
