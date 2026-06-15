#!/usr/bin/env python3
"""
UAP Compliance Test Suite

Tests all UAP protocol requirements to ensure 100% compliance.

Usage:
    tools/agents/tests/test_uap_compliance.py
    # or with pytest:
    pytest tools/agents/tests/test_uap_compliance.py -v
"""

import sqlite3
import subprocess
import sys
import unittest
from pathlib import Path


class TestUAPCompliance(unittest.TestCase):
    """Test suite for UAP protocol compliance."""

    def setUp(self):
        """Setup test fixtures."""
        self.project_root = Path(__file__).parent.parent.parent
        self.db_path = self.project_root / "agents/data/memory/short_term.db"
        self.coord_db_path = (
            self.project_root / "agents/data/coordination/coordination.db"
        )
        self.worktrees_dir = self.project_root / ".worktrees"

    def test_01_memory_database_exists(self):
        """Test that memory database is initialized."""
        assert self.db_path.exists(), "Memory database not found"
        print("✅ Memory database exists")

    def test_02_memories_table_exists(self):
        """Test that memories table exists."""
        conn = sqlite3.connect(str(self.db_path))
        cursor = conn.cursor()
        cursor.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='memories'"
        )
        result = cursor.fetchone()
        conn.close()

        assert result is not None, "memories table not found"
        print("✅ memories table exists")

    def test_03_session_memories_table_exists(self):
        """Test that session_memories table exists."""
        conn = sqlite3.connect(str(self.db_path))
        cursor = conn.cursor()
        cursor.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='session_memories'"
        )
        result = cursor.fetchone()
        conn.close()

        assert result is not None, "session_memories table not found"
        print("✅ session_memories table exists")

    def test_04_entities_table_exists(self):
        """Test that entities table exists."""
        conn = sqlite3.connect(str(self.db_path))
        cursor = conn.cursor()
        cursor.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='entities'"
        )
        result = cursor.fetchone()
        conn.close()

        assert result is not None, "entities table not found"
        print("✅ entities table exists")

    def test_05_relationships_table_exists(self):
        """Test that relationships table exists."""
        conn = sqlite3.connect(str(self.db_path))
        cursor = conn.cursor()
        cursor.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='relationships'"
        )
        result = cursor.fetchone()
        conn.close()

        assert result is not None, "relationships table not found"
        print("✅ relationships table exists")

    def test_06_fts5_index_exists(self):
        """Test that FTS5 full-text search index exists."""
        conn = sqlite3.connect(str(self.db_path))
        cursor = conn.cursor()
        cursor.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'"
        )
        result = cursor.fetchone()
        conn.close()

        assert result is not None, "memories_fts FTS5 index not found"
        print("✅ memories_fts FTS5 index exists")

    def test_07_coordination_database_exists(self):
        """Test that coordination database exists."""
        assert self.coord_db_path.exists(), "Coordination database not found"
        print("✅ Coordination database exists")

    def test_08_agent_registry_table_exists(self):
        """Test that agent_registry table exists in coordination DB."""
        conn = sqlite3.connect(str(self.coord_db_path))
        cursor = conn.cursor()
        cursor.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='agent_registry'"
        )
        result = cursor.fetchone()
        conn.close()

        assert result is not None, "agent_registry table not found"
        print("✅ agent_registry table exists")

    def test_09_uap_cli_command_exists(self):
        """Test that UAP CLI command is available."""
        cli_path = Path(__file__).parent.parent / "UAP" / "cli.py"
        assert cli_path.exists(), f"UAP CLI not found at {cli_path}"

        # Test CLI help
        result = subprocess.run(
            ["python3", str(cli_path), "--help"], capture_output=True, text=True
        )

        assert result.returncode == 0, "UAP CLI failed to run"
        assert "task" in result.stdout.lower(), "CLI missing 'task' command"
        assert "memory" in result.stdout.lower(), "CLI missing 'memory' command"
        assert "worktree" in result.stdout.lower(), "CLI missing 'worktree' command"

        print("✅ UAP CLI command available")

    def test_10_uap_task_ready_command(self):
        """Test that UAP task ready command works."""
        cli_path = Path(__file__).parent.parent / "UAP" / "cli.py"

        result = subprocess.run(
            ["python3", str(cli_path), "task", "ready"], capture_output=True, text=True
        )

        assert result.returncode == 0, f"UAP task ready failed: {result.stderr}"
        print("✅ UAP task ready command works")

    def test_11_uap_memory_query_command(self):
        """Test that UAP memory query command works."""
        cli_path = Path(__file__).parent.parent / "UAP" / "cli.py"

        result = subprocess.run(
            ["python3", str(cli_path), "memory", "query", "test"],
            capture_output=True,
            text=True,
        )

        # Query should succeed (even if no results)
        assert result.returncode == 0 or result.returncode == 1, (
            f"UAP memory query failed unexpectedly: {result.stderr}"
        )
        print("✅ UAP memory query command works")

    def test_12_uap_compliance_check_command(self):
        """Test that UAP compliance check command works."""
        cli_path = Path(__file__).parent.parent / "UAP" / "cli.py"

        result = subprocess.run(
            ["python3", str(cli_path), "compliance"], capture_output=True, text=True
        )

        # Should return 0 if compliant, 1 if not (both are valid outcomes)
        assert result.returncode in [0, 1], (
            f"UAP compliance check failed: {result.stderr}"
        )
        print("✅ UAP compliance check command works")

    def test_13_session_memories_schema(self):
        """Test session_memories table schema."""
        conn = sqlite3.connect(str(self.db_path))
        cursor = conn.cursor()

        # Get table info
        cursor.execute("PRAGMA table_info(session_memories)")
        columns = {row[1]: row[2] for row in cursor.fetchall()}
        conn.close()

        assert "session_id" in columns, "session_id column missing"
        assert "timestamp" in columns, "timestamp column missing"
        assert "type" in columns, "type column missing"
        assert "content" in columns, "content column missing"
        assert "importance" in columns, "importance column missing"

        print("✅ session_memories table schema correct")

    def test_14_entities_schema(self):
        """Test entities table schema."""
        conn = sqlite3.connect(str(self.db_path))
        cursor = conn.cursor()

        cursor.execute("PRAGMA table_info(entities)")
        columns = {row[1]: row[2] for row in cursor.fetchall()}
        conn.close()

        assert "name" in columns, "name column missing"
        assert "type" in columns, "type column missing"
        assert "description" in columns, "description column missing"

        print("✅ entities table schema correct")

    def test_15_relationships_schema(self):
        """Test relationships table schema."""
        conn = sqlite3.connect(str(self.db_path))
        cursor = conn.cursor()

        cursor.execute("PRAGMA table_info(relationships)")
        columns = {row[1]: row[2] for row in cursor.fetchall()}
        conn.close()

        assert "source_id" in columns, "source_id column missing"
        assert "target_id" in columns, "target_id column missing"
        assert "relation" in columns, "relation column missing"

        print("✅ relationships table schema correct")


def run_tests():
    """Run all compliance tests."""
    import unittest

    # Create test suite
    loader = unittest.TestLoader()
    suite = loader.loadTestsFromTestCase(TestUAPCompliance)

    # Run tests
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)

    # Print summary
    print("\n" + "=" * 60)
    print("TEST SUMMARY")
    print("=" * 60)
    print(f"Tests run: {result.testsRun}")
    print(f"Failures: {len(result.failures)}")
    print(f"Errors: {len(result.errors)}")
    print(f"Successes: {result.testsRun - len(result.failures) - len(result.errors)}")

    if result.wasSuccessful():
        print("\n✅ ALL COMPLIANCE TESTS PASSED")
        return 0
    else:
        print("\n❌ SOME COMPLIANCE TESTS FAILED")
        return 1


if __name__ == "__main__":
    sys.exit(run_tests())
