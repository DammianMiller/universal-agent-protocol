#!/usr/bin/env python3
"""
Update pattern weights based on task outcomes.

Analyzes reinforcement_log to adjust pattern effectiveness weights.
Higher-weighted patterns are more likely to be selected for similar tasks.

Usage:
    python update_pattern_weights.py
    python update_pattern_weights.py --recalculate
"""

import argparse
import sqlite3
import sys
from pathlib import Path

DB_PATH = Path(__file__).parent.parent / "data" / "memory" / "reinforcement.db"


def update_weights(recalculate: bool = False):
    """Update pattern weights from reinforcement log."""
    if not DB_PATH.exists():
        print("No reinforcement database found. Run some tasks first.")
        return
    
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    if recalculate:
        # Recalculate all weights from scratch
        cursor.execute("""
            SELECT task_type, pattern, 
                   SUM(CASE WHEN success THEN 1 ELSE 0 END) as success_count,
                   SUM(CASE WHEN NOT success THEN 1 ELSE 0 END) as failure_count,
                   COUNT(*) as total,
                   AVG(reward_score) as avg_reward
            FROM (
                SELECT rl.task_type, 
                       value as pattern,
                       rl.success,
                       rl.reward_score
                FROM reinforcement_log rl,
                     json_each(rl.patterns_selected)
            )
            GROUP BY task_type, pattern
        """)
        
        for row in cursor.fetchall():
            task_type, pattern, success_count, failure_count, total, avg_reward = row
            
            # Calculate weight: success rate * avg reward factor
            success_rate = success_count / total if total > 0 else 0.5
            reward_factor = (avg_reward + 20) / 40  # Normalize to 0-1 range
            weight = success_rate * 0.6 + reward_factor * 0.4
            
            cursor.execute("""
                INSERT INTO pattern_weights (task_type, pattern, weight, success_count, failure_count, total_uses, avg_reward)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(task_type, pattern) DO UPDATE SET
                    weight = ?,
                    success_count = ?,
                    failure_count = ?,
                    total_uses = ?,
                    avg_reward = ?,
                    last_updated = CURRENT_TIMESTAMP
            """, (task_type, pattern, weight, success_count, failure_count, total, avg_reward,
                  weight, success_count, failure_count, total, avg_reward))
    else:
        # Incremental update - just update stats
        cursor.execute("""
            UPDATE pattern_weights SET
                weight = (success_count + 1.0) / (total_uses + 2.0),
                last_updated = CURRENT_TIMESTAMP
        """)
    
    conn.commit()
    
    # Show updated weights
    cursor.execute("""
        SELECT task_type, pattern, weight, success_count, failure_count, total_uses, avg_reward
        FROM pattern_weights
        ORDER BY task_type, weight DESC
    """)
    
    print("Pattern Weights:")
    print("-" * 80)
    print(f"{'Task Type':<12} {'Pattern':<12} {'Weight':<8} {'Success':<8} {'Failure':<8} {'Total':<6} {'Avg Reward':<10}")
    print("-" * 80)
    
    for row in cursor.fetchall():
        task_type, pattern, weight, success, failure, total, avg_reward = row
        print(f"{task_type:<12} {pattern:<12} {weight:<8.3f} {success:<8} {failure:<8} {total:<6} {avg_reward:<10.1f}")
    
    conn.close()


def show_effectiveness():
    """Show pattern effectiveness summary."""
    if not DB_PATH.exists():
        print("No reinforcement database found.")
        return
    
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    # Try to use the view if it exists
    try:
        cursor.execute("SELECT * FROM v_pattern_effectiveness LIMIT 20")
        print("\nPattern Effectiveness View:")
        for row in cursor.fetchall():
            print(row)
    except sqlite3.OperationalError:
        pass
    
    # Show recent outcomes
    cursor.execute("""
        SELECT timestamp, task_type, task_summary, success, reward_score, iterations
        FROM reinforcement_log
        ORDER BY timestamp DESC
        LIMIT 10
    """)
    
    print("\nRecent Outcomes:")
    print("-" * 80)
    for row in cursor.fetchall():
        timestamp, task_type, summary, success, reward, iterations = row
        status = "✓" if success else "✗"
        print(f"{timestamp}: [{status}] {task_type} - {summary[:40]} (reward: {reward}, iterations: {iterations})")
    
    conn.close()


def main():
    parser = argparse.ArgumentParser(description="Update pattern weights")
    parser.add_argument("--recalculate", action="store_true", help="Recalculate all weights from scratch")
    parser.add_argument("--show", action="store_true", help="Show effectiveness summary")
    
    args = parser.parse_args()
    
    if args.show:
        show_effectiveness()
    else:
        update_weights(args.recalculate)


if __name__ == "__main__":
    main()
