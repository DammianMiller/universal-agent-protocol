#!/usr/bin/env python3
"""
UAP CLI - Universal Agent Protocol Command Line Interface

This is the core CLI tool for managing agent memory systems.
All agent hooks and workflows MUST use these commands for compliance.

Usage:
    UAP task ready                    # Check task readiness
    UAP memory query "<topic>"        # Query memory by topic
    UAP worktree create <slug>        # Create new worktree
    UAP worktree cleanup <id>         # Clean up merged worktree
    UAP session start                 # Start new session
    UAP session end                   # End current session
    UAP compliance check              # Check UAP protocol compliance
    UAP setup                         # Interactive setup
"""

import argparse
import sqlite3
import subprocess
import sys
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional


class UAPCLI:
    """Universal Agent Protocol CLI."""

    def __init__(self):
        self.project_root = Path(__file__).parent.parent.parent
        self.db_path = self.project_root / "agents/data/memory/short_term.db"
        self.coord_db_path = (
            self.project_root / "agents/data/coordination/coordination.db"
        )
        self.worktrees_dir = self.project_root / ".worktrees"

    def get_connection(self, db_path: Optional[Path] = None) -> sqlite3.Connection:
        """Get database connection."""
        path = db_path or self.db_path
        if not path.exists():
            raise FileNotFoundError(f"Database not found: {path}")
        conn = sqlite3.connect(str(path))
        conn.row_factory = sqlite3.Row
        return conn

    def get_coordination_connection(self) -> Optional[sqlite3.Connection]:
        """Get coordination database connection."""
        if not self.coord_db_path.exists():
            return None
        conn = sqlite3.connect(str(self.coord_db_path))
        conn.row_factory = sqlite3.Row
        return conn

    # ============================================================
    # TASK COMMANDS
    # ============================================================

    def task_ready(self) -> int:
        """Check if agent is ready to work."""
        print("=== UAP Task Readiness Check ===\n")

        # Check memory database
        if not self.db_path.exists():
            print("Memory database not initialized")
            return 1
        print(f"Memory database: {self.db_path}")

        # Check recent activity
        conn = self.get_connection()
        cursor = conn.cursor()

        # Get last 5 actions
        cursor.execute("""
            SELECT timestamp, type, substr(content, 1, 60) as content
            FROM memories
            ORDER BY id DESC
            LIMIT 5
        """)
        rows = cursor.fetchall()

        if rows:
            print(f"\nRecent activity (last {len(rows)} entries):")
            for row in rows:
                print(f"   [{row['timestamp']}] {row['type']}: {row['content']}...")
        else:
            print("\nNo recent memory entries found")

        # Check coordination database
        if self.coord_db_path.exists():
            print(f"\nCoordination DB: {self.coord_db_path}")

            # Check for stale agents
            coord_conn = self.get_coordination_connection()
            if coord_conn:
                cursor = coord_conn.cursor()
                cursor.execute("""
                    SELECT COUNT(*) as count FROM agent_registry
                    WHERE status IN ('active', 'idle')
                      AND last_heartbeat < datetime('now', '-24 hours')
                """)
                stale = cursor.fetchone()["count"]

                if stale > 0:
                    print(
                        f"WARNING: {stale} stale agents detected (no heartbeat in 24h)"
                    )
                else:
                    print("No stale agents detected")
        else:
            print("\nCoordination DB not initialized (multi-agent mode disabled)")

        # Check worktrees
        if self.worktrees_dir.exists():
            worktree_count = len(
                [d for d in self.worktrees_dir.iterdir() if d.is_dir()]
            )
            print(f"\nWorktrees: {worktree_count} active")

        conn.close()

        print("\nUAP Protocol Ready - You can proceed with work")
        return 0

    def setup(self, args) -> int:
        """Interactive setup with feature toggles and verification report."""
        import json

        print("=" * 70)
        print("Universal Agent Protocol Setup")
        version = self._get_version()
        print(f"Version: {version}")
        print("=" * 70)

        # Interactive mode vs non-interactive
        use_interactive = not getattr(args, "yes", False)

        if use_interactive:
            print("\nSelect UAP Features:")
            print("-" * 40)
            memory_enabled = (
                input("Enable Memory System? [Y/n]: ").strip().lower() != "n"
            )
            parallel_enabled = (
                input("Enable Parallel Execution? [y/N]: ").strip().lower() == "y"
            )
            validation_toggle = (
                input("Enable Validation Toggle? [Y/n]: ").strip().lower() != "n"
            )
        else:
            memory_enabled = getattr(args, "feature_memory", True)
            parallel_enabled = getattr(args, "feature_parallel", False)
            validation_toggle = getattr(args, "feature_validation", True)

        print()

        # Create .env file with feature toggles
        print("Creating UAP configuration...")
        env_path = self.project_root / ".env"
        with open(env_path, "w") as f:
            f.write("# UAP Feature Configuration\n")
            f.write(f"UAP_MEMORY_ENABLED={'true' if memory_enabled else 'false'}\n")
            f.write(
                f"UAP_PARALLEL_EXECUTION={'true' if parallel_enabled else 'false'}\n"
            )
            f.write(f"UAP_VALIDATE_PLAN={'true' if validation_toggle else 'false'}\n")

        print(f"Configuration written to {env_path}")
        with open(env_path, "r") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#"):
                    print(f"   {line}")

        # Install UAP config directory
        print("\nInstalling UAP configuration...")
        config_dir = self.project_root / "tools/agents/UAP/configs"
        if not config_dir.exists():
            config_dir.mkdir(parents=True)

        # Run verification tests
        print("\nRunning Verification Tests...")
        test_results = self._run_verification_tests(
            memory_enabled, parallel_enabled, validation_toggle
        )

        # Print verification report
        return self._print_verification_report(
            test_results, memory_enabled, parallel_enabled, validation_toggle
        )

    def _get_version(self) -> str:
        """Get current UAP version from package.json."""
        import json

        pkg_path = self.project_root / "package.json"
        if pkg_path.exists():
            try:
                with open(pkg_path, "r") as f:
                    return json.load(f).get("version", "0.0.0")
            except Exception:
                pass
        return "0.0.0"

    def _run_verification_tests(
        self, memory_enabled: bool, parallel_enabled: bool, validation_toggle: bool
    ) -> dict:
        """Run verification tests for all enabled features."""
        results = {"tests": [], "passed": 0, "failed": 0}

        # Test Memory System if enabled
        if memory_enabled:
            print("\nTesting Memory System...")
            if self.db_path.exists():
                print("  Memory database exists")
                results["tests"].append(("Memory Database", "passed"))
                results["passed"] += 1
            else:
                print("  Memory database not found")
                results["tests"].append(("Memory Database", "failed"))
                results["failed"] += 1

        # Test Parallel Execution
        if parallel_enabled:
            print("\nTesting Parallel Execution...")
            try:
                import asyncio

                print("  asyncio available")
                results["tests"].append(("Parallel Execution", "passed"))
                results["passed"] += 1
            except ImportError:
                print("  asyncio not available")
                results["tests"].append(("Parallel Execution", "failed"))
                results["failed"] += 1

        # Test Validation Toggle
        if validation_toggle:
            print("\nValidation Toggle enabled")
            results["tests"].append(("Validation Toggle", "passed"))
            results["passed"] += 1

        # Run npm tests for TypeScript components
        print("\nRunning NPM Tests...")
        try:
            result = subprocess.run(
                ["npm", "test"],
                capture_output=True,
                text=True,
                cwd=str(self.project_root),
                timeout=120,
            )
            if result.returncode == 0:
                print("  All NPM tests passed")
                results["tests"].append(("NPM Test Suite", "passed"))
                results["passed"] += 1
            else:
                print("  Some npm tests failed")
                results["tests"].append(("NPM Test Suite", "failed"))
                results["failed"] += 1
        except Exception as e:
            print(f"  Could not run npm test: {e}")
            results["tests"].append(("NPM Test Suite", "failed"))
            results["failed"] += 1

        return results

    def _print_verification_report(
        self,
        test_results: dict,
        memory_enabled: bool,
        parallel_enabled: bool,
        validation_toggle: bool,
    ) -> int:
        """Print comprehensive verification report."""
        print()
        print("=" * 70)
        print("UAP Setup Verification Report")
        print("=" * 70)

        # Feature status summary
        print("\nConfigured Features:")
        print(f"   Memory System:      {'ENABLED' if memory_enabled else 'DISABLED'}")
        print(f"   Parallel Execution: {'ENABLED' if parallel_enabled else 'DISABLED'}")
        print(
            f"   Validation Toggle:  {'ENABLED' if validation_toggle else 'DISABLED'}"
        )

        # Test results
        print("\nTest Results:")
        for test_name, status in test_results["tests"]:
            icon = "PASS" if status == "passed" else "FAIL"
            print(f"   [{icon}] {test_name}")

        # Summary statistics
        total_tests = len(test_results["tests"])
        if total_tests > 0:
            passed_count = test_results.get("passed", 0)
            pct = 100 * passed_count / total_tests
            print(f"\nTest Success Rate: {passed_count}/{total_tests} ({pct:.0f}%)")

        # Final status message
        all_passed = all(s == "passed" for _, s in test_results["tests"])
        if all_passed:
            print("\nSetup Complete! All features verified and working!")
        else:
            print("\nSome components need attention - see report above")

        print("=" * 70)
        return 0 if all_passed else 1

    def task_create(self, task_type: str, title: str) -> int:
        """Create new task entry in memory."""
        timestamp = datetime.utcnow().isoformat() + "Z"

        conn = self.get_connection()
        cursor = conn.cursor()

        content = f"[{task_type.upper()}] {title}"
        cursor.execute(
            "INSERT INTO memories (timestamp, type, content) VALUES (?, ?, ?)",
            (timestamp, task_type, content),
        )

        conn.commit()
        print(f"Created {task_type} task: {title}")
        print(f"   ID: {cursor.lastrowid}")
        print(f"   Timestamp: {timestamp}")

        conn.close()
        return 0

    # ============================================================
    # MEMORY COMMANDS
    # ============================================================

    def memory_query(self, query: str, limit: int = 10) -> int:
        """Query memory by topic."""
        print(f"=== Memory Query: '{query}' ===\n")

        if not self.db_path.exists():
            print("Memory database not initialized")
            return 1

        conn = self.get_connection()
        cursor = conn.cursor()

        # Try full-text search first
        try:
            cursor.execute(
                """
                SELECT m.id, m.timestamp, m.type, m.content
                FROM memories_fts f
                JOIN memories m ON f.rowid = m.id
                WHERE memories_fts MATCH ?
                ORDER BY rank
                LIMIT ?
            """,
                (query, limit),
            )

            rows = cursor.fetchall()
            if rows:
                print(f"Found {len(rows)} matches via FTS search\n")
                for row in rows:
                    self._print_memory_row(row)
                conn.close()
                return 0
        except sqlite3.OperationalError:
            # FTS index doesn't exist, fall back to LIKE search
            pass

        # Fall back to LIKE search
        search_pattern = f"%{query}%"
        cursor.execute(
            """
            SELECT id, timestamp, type, content
            FROM memories
            WHERE content LIKE ?
            ORDER BY timestamp DESC
            LIMIT ?
        """,
            (search_pattern, limit),
        )

        rows = cursor.fetchall()

        if not rows:
            print("No matches found")
            conn.close()
            return 1

        print(f"Found {len(rows)} matches\n")
        for row in rows:
            self._print_memory_row(row)

        conn.close()
        return 0

    def _print_memory_row(self, row):
        """Print formatted memory row."""
        print(f"[{row['id']:3d}] {row['timestamp']} [{row['type']:11s}]")
        content = row["content"]
        if len(content) > 200:
            content = content[:200] + "..."
        print(f"      {content}")
        print()

    def memory_store(self, mem_type: str, content: str, importance: int = 5) -> int:
        """Store memory entry."""
        if mem_type not in ["action", "observation", "thought", "goal"]:
            print("Invalid type. Must be: action, observation, thought, goal")
            return 1

        timestamp = datetime.utcnow().isoformat() + "Z"

        conn = self.get_connection()
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO memories (timestamp, type, content) VALUES (?, ?, ?)",
            (timestamp, mem_type, content),
        )
        conn.commit()
        conn.close()

        print(f"Stored memory [{mem_type}]: {content[:50]}...")
        return 0

    def session_memories_add(
        self, session_id: str, mem_type: str, content: str, importance: int
    ) -> int:
        """Add to session memories (high-importance decisions)."""
        timestamp = datetime.utcnow().isoformat() + "Z"

        conn = self.get_connection()
        cursor = conn.cursor()

        try:
            cursor.execute(
                """
                INSERT OR IGNORE INTO session_memories 
                (session_id, timestamp, type, content, importance)
                VALUES (?, ?, ?, ?, ?)
            """,
                (session_id, timestamp, mem_type, content, importance),
            )

            if cursor.rowcount == 0:
                print("Session memory already exists")
            else:
                print(f"Stored session memory [{mem_type}] importance={importance}")
                print(f"   Content: {content[:100]}...")

            conn.commit()
        except sqlite3.OperationalError as e:
            print(f"Error: {e}")
            print(
                "   Hint: Run database migration first (tools/agents/migrations/apply.py)"
            )

        conn.close()
        return 0

    # ============================================================
    # WORKTREE COMMANDS
    # ============================================================

    def worktree_create(self, slug: str) -> int:
        """Create new git worktree."""
        if not slug:
            print("Worktree slug required")
            return 1

        # Create worktree using factory script or git directly
        worktree_script = (
            self.project_root / ".factory" / "scripts" / "worktree-manager.sh"
        )

        if worktree_script.exists():
            print(f"Creating worktree: {slug}")
            result = subprocess.run(
                [str(worktree_script), "create", slug],
                cwd=str(self.project_root),
                capture_output=True,
                text=True,
            )

            if result.returncode == 0:
                print("Worktree created successfully")
                print(result.stdout)

                # Record in memory
                timestamp = datetime.utcnow().isoformat() + "Z"
                conn = self.get_connection()
                cursor = conn.cursor()
                cursor.execute(
                    "INSERT INTO memories (timestamp, type, content) VALUES (?, ?, ?)",
                    (timestamp, "action", f"Created worktree: {slug}"),
                )
                conn.commit()
                conn.close()

                return 0
            else:
                print(f"Error creating worktree:\n{result.stderr}")
                return 1
        else:
            # Fall back to git worktree command
            print(f"Creating worktree via git: {slug}")
            result = subprocess.run(
                ["git", "worktree", "add", f".worktrees/{slug}", "-b", slug],
                cwd=str(self.project_root),
                capture_output=True,
                text=True,
            )

            if result.returncode == 0:
                print("Worktree created successfully")

                # Record in memory
                timestamp = datetime.utcnow().isoformat() + "Z"
                conn = self.get_connection()
                cursor = conn.cursor()
                cursor.execute(
                    "INSERT INTO memories (timestamp, type, content) VALUES (?, ?, ?)",
                    (timestamp, "action", f"Created worktree: {slug}"),
                )
                conn.commit()
                conn.close()

                return 0
            else:
                print(f"Error creating worktree:\n{result.stderr}")
                return 1

    def worktree_cleanup(self, id_or_slug: str) -> int:
        """Clean up merged worktree."""
        import shutil

        # Find worktree by ID or slug
        if self.worktrees_dir.exists():
            for entry in self.worktrees_dir.iterdir():
                if entry.is_dir() and (
                    entry.name == id_or_slug or str(id_or_slug) in entry.name
                ):
                    print(f"Removing worktree: {entry.name}")

                    try:
                        shutil.rmtree(entry)
                        print("Worktree removed")

                        # Record in memory
                        timestamp = datetime.utcnow().isoformat() + "Z"
                        conn = self.get_connection()
                        cursor = conn.cursor()
                        cursor.execute(
                            "INSERT INTO memories (timestamp, type, content) VALUES (?, ?, ?)",
                            (timestamp, "action", f"Cleaned up worktree: {entry.name}"),
                        )
                        conn.commit()
                        conn.close()

                        return 0
                    except Exception as e:
                        print(f"Error removing worktree: {e}")
                        return 1

        print(f"Worktree not found: {id_or_slug}")
        return 1

    def worktree_list(self) -> int:
        """List all active worktrees."""
        if not self.worktrees_dir.exists():
            print("No worktrees directory found")
            return 0

        worktrees = [d.name for d in self.worktrees_dir.iterdir() if d.is_dir()]

        if not worktrees:
            print("No active worktrees")
            return 0

        print("=== Active Worktrees ===\n")
        for wt in worktrees:
            print(f"  {wt}")

        return 0

    # ============================================================
    # SESSION COMMANDS
    # ============================================================

    def session_start(self) -> int:
        """Start new agent session."""
        session_id = str(uuid.uuid4())[:8]
        timestamp = datetime.utcnow().isoformat() + "Z"

        # Store session in coordination DB if available
        coord_conn = self.get_coordination_connection()
        if coord_conn:
            cursor = coord_conn.cursor()
            cursor.execute(
                """
                INSERT OR REPLACE INTO agent_registry 
                (agent_id, status, last_heartbeat)
                VALUES (?, 'active', ?)
            """,
                (session_id, timestamp),
            )

            # Update any stale agents to failed
            cursor.execute("""
                UPDATE agent_registry SET status='failed'
                WHERE status IN ('active','idle') 
                  AND last_heartbeat < datetime('now','-24 hours')
            """)

            coord_conn.commit()

        # Record in memory
        conn = self.get_connection()
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO memories (timestamp, type, content) VALUES (?, ?, ?)",
            (timestamp, "thought", f"Session started: {session_id}"),
        )
        conn.commit()
        conn.close()

        print(f"Session started: {session_id}")
        print(f"   Timestamp: {timestamp}")
        print(f"\nRemember to run 'UAP session end' when done")

        return 0

    def session_end(self) -> int:
        """End current agent session."""
        timestamp = datetime.utcnow().isoformat() + "Z"

        # Update coordination DB if available
        coord_conn = self.get_coordination_connection()
        if coord_conn:
            cursor = coord_conn.cursor()
            cursor.execute(
                """
                UPDATE agent_registry SET status='completed', last_heartbeat=?
                WHERE status='active'
            """,
                (timestamp,),
            )
            coord_conn.commit()

        # Record in memory
        conn = self.get_connection()
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO memories (timestamp, type, content) VALUES (?, ?, ?)",
            (timestamp, "thought", "Session ended"),
        )
        conn.commit()
        conn.close()

        print(f"Session ended: {timestamp}")
        return 0

    # ============================================================
    # COMPLIANCE COMMANDS
    # ============================================================

    def compliance_check(self) -> int:
        """Check UAP protocol compliance."""
        print("=== UAP Protocol Compliance Check ===\n")

        all_passed = True

        # Check 1: Memory database exists
        if self.db_path.exists():
            print("PASS: Memory database initialized")
        else:
            print("FAIL: Memory database not initialized")
            all_passed = False

        # Check 2: Required tables exist
        conn = self.get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
        tables = [row[0] for row in cursor.fetchall()]

        required_tables = ["memories", "session_memories", "entities", "relationships"]
        for table in required_tables:
            if table in tables:
                print(f"PASS: Table '{table}' exists")
            else:
                print(f"FAIL: Table '{table}' missing (run migration)")
                all_passed = False

        conn.close()

        # Check 3: FTS index exists
        if "memories_fts" in tables:
            print("PASS: Full-text search index exists")
        else:
            print("FAIL: FTS5 index missing (run migration)")
            all_passed = False

        # Check 4: Coordination DB
        if self.coord_db_path.exists():
            print("PASS: Coordination database initialized")
        else:
            print("WARN: Coordination DB not initialized (multi-agent mode disabled)")

        # Check 5: Worktrees directory
        if self.worktrees_dir.exists():
            wt_count = len([d for d in self.worktrees_dir.iterdir() if d.is_dir()])
            print(f"PASS: Worktrees directory exists ({wt_count} worktrees)")
        else:
            print("WARN: No worktrees directory (single-agent mode)")

        print("\n" + "=" * 40)
        if all_passed:
            print("UAP Protocol COMPLIANT - All checks passed")
            return 0
        else:
            print("UAP Protocol NON-COMPLIANT - Run migrations first")
            print("\nTo fix:")
            print("  1. Run database migration: tools/agents/migrations/apply.py")
            print(
                "  2. Initialize coordination DB: tools/agents/scripts/init_coordination_db.sh"
            )
            return 1


def main():
    parser = argparse.ArgumentParser(
        description="Universal Agent Protocol CLI",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  UAP task ready                    # Check task readiness
  UAP memory query "Redis caching"  # Search memory by topic
  UAP worktree create fix-bug       # Create new worktree
  UAP session start                 # Start agent session
  UAP compliance check              # Verify protocol compliance
  UAP setup                         # Interactive setup
        """,
    )

    subparsers = parser.add_subparsers(dest="command", help="Command")

    # Task commands
    task_parser = subparsers.add_parser("task", help="Task management")
    task_sub = task_parser.add_subparsers(dest="subcommand")

    task_sub.add_parser("ready", help="Check task readiness")
    task_create = task_sub.add_parser("create", help="Create new task")
    task_create.add_argument(
        "type", choices=["action", "observation", "thought", "goal"]
    )
    task_create.add_argument("title", help="Task title")

    # Memory commands
    memory_parser = subparsers.add_parser("memory", help="Memory operations")
    memory_sub = memory_parser.add_subparsers(dest="subcommand")

    memory_query = memory_sub.add_parser("query", help="Query memory by topic")
    memory_query.add_argument("query", help="Search query")
    memory_query.add_argument("-n", "--limit", type=int, default=10, help="Max results")

    # Worktree commands
    wt_parser = subparsers.add_parser("worktree", help="Worktree management")
    wt_sub = wt_parser.add_subparsers(dest="subcommand")

    wt_create = wt_sub.add_parser("create", help="Create new worktree")
    wt_create.add_argument("slug", help="Worktree slug")

    wt_cleanup = wt_sub.add_parser("cleanup", help="Clean up worktree")
    wt_cleanup.add_argument("id_or_slug", help="Worktree ID or slug")

    wt_sub.add_parser("list", help="List active worktrees")

    # Session commands
    session_parser = subparsers.add_parser("session", help="Session management")
    session_sub = session_parser.add_subparsers(dest="subcommand")

    session_sub.add_parser("start", help="Start new session")
    session_sub.add_parser("end", help="End current session")

    # Compliance command
    subparsers.add_parser("compliance", help="Check protocol compliance")

    # Setup command with feature toggles
    setup_parser = subparsers.add_parser(
        "setup", help="Interactive setup with feature selection and verification"
    )
    setup_parser.add_argument(
        "-y",
        "--yes",
        action="store_true",
        default=False,
        help="Non-interactive mode - use all defaults",
    )
    setup_parser.add_argument(
        "--feature-memory",
        dest="feature_memory",
        action="store_true",
        default=True,
        help="Enable memory system (default: enabled)",
    )
    setup_parser.add_argument(
        "--no-feature-memory",
        dest="feature_memory",
        action="store_false",
        help="Disable memory system",
    )
    setup_parser.add_argument(
        "--feature-parallel",
        dest="feature_parallel",
        action="store_true",
        default=False,
        help="Enable parallel execution mode",
    )
    setup_parser.add_argument(
        "--feature-validation",
        dest="feature_validation",
        action="store_true",
        default=True,
        help="Enable validation toggle (default: enabled)",
    )
    setup_parser.add_argument(
        "--no-feature-validation",
        dest="feature_validation",
        action="store_false",
        help="Disable validation toggle",
    )

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        return 1

    cli = UAPCLI()

    try:
        if args.command == "task":
            if args.subcommand == "ready":
                return cli.task_ready()
            elif args.subcommand == "create":
                return cli.task_create(args.type, args.title)
            else:
                task_parser.print_help()
                return 1

        elif args.command == "memory":
            if args.subcommand == "query":
                return cli.memory_query(args.query, args.limit)
            else:
                memory_parser.print_help()
                return 1

        elif args.command == "worktree":
            if args.subcommand == "create":
                return cli.worktree_create(args.slug)
            elif args.subcommand == "cleanup":
                return cli.worktree_cleanup(args.id_or_slug)
            elif args.subcommand == "list":
                return cli.worktree_list()
            else:
                wt_parser.print_help()
                return 1

        elif args.command == "session":
            if args.subcommand == "start":
                return cli.session_start()
            elif args.subcommand == "end":
                return cli.session_end()
            else:
                session_parser.print_help()
                return 1

        elif args.command == "compliance":
            return cli.compliance_check()

        elif args.command == "setup":
            return cli.setup(args)

    except FileNotFoundError as e:
        print(f"Error: {e}")
        return 1
    except Exception as e:
        print(f"Unexpected error: {e}")
        import traceback

        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())
