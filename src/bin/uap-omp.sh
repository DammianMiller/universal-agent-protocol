#!/usr/bin/env bash
# UAP CLI for Oh-My-Pi Integration
# Provides UAP commands specifically for oh-my-pi users

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UAP_OMP_DIR="${HOME}/.uap/omp"

# Helper functions
cmd() {
    echo "🔧 [UAP-Omp] $*"
}

error() {
    echo "❌ [UAP-Omp] $*" >&2
}

check_integration() {
    if [[ ! -f "$UAP_OMP_DIR/settings.json" ]]; then
        error "UAP integration not installed. Run: uap-omp install"
        exit 1
    fi
}

# UAP Dashboard command
cmd_dashboard() {
    check_integration
    "$UAP_OMP_DIR/commands/uap-dashboard.sh"
}

# Memory management
cmd_memory() {
    check_integration
    shift
    
    case "${1:-status}" in
        status)
            cmd "Memory Status"
            if [[ -f "$UAP_OMP_DIR/memory/short_term.db" ]]; then
                sqlite3 "$UAP_OMP_DIR/memory/short_term.db" <<EOF
.mode column
.headers on
SELECT 
    COUNT(*) as total_memories,
    COUNT(DISTINCT category) as categories,
    MAX(importance) as highest_importance,
    COUNT(CASE WHEN created_at >= datetime('now', '-7 days') THEN 1 END) as recent_memories
FROM memories;
EOF
            else
                echo "No memory database found. Run 'uap-omp init' to initialize."
            fi
            ;;
        query)
            if [[ -z "${2:-}" ]]; then
                error "Usage: uap memory query <search_term>"
                exit 1
            fi
            cmd "Querying memory for: $2"
            if [[ -f "$UAP_OMP_DIR/memory/short_term.db" ]]; then
                sqlite3 -header -column "$UAP_OMP_DIR/memory/short_term.db" <<EOF
SELECT 
    content,
    category,
    importance,
    created_at
FROM memories
WHERE content LIKE '%${2}%' OR category LIKE '%${2}%'
ORDER BY importance DESC, created_at DESC
LIMIT 10;
EOF
            else
                echo "No memory database found."
            fi
            ;;
        store)
            if [[ -z "${2:-}" ]]; then
                error "Usage: uap memory store <content> [--importance N]"
                exit 1
            fi
            content="$2"
            importance=7
            shift 2
            while [[ $# -gt 0 ]]; do
                case "$1" in
                    --importance)
                        importance="$2"
                        shift 2
                        ;;
                esac
            done
            cmd "Storing memory (importance: $importance)"
            # Store memory in JSONL format for easy querying
            echo "{\"content\": \"$content\", \"importance\": $importance, \"category\": \"manual\", \"created_at\": \"$(date -Iseconds)\"}" >> "$UAP_OMP_DIR/memory/lessons.jsonl"
            echo "✅ Memory stored successfully"
            ;;
        clear)
            cmd "Clearing memory..."
            read -p "Are you sure? [y/N] " -n 1 -r
            echo
            if [[ $REPLY =~ ^[Yy]$ ]]; then
                rm -f "$UAP_OMP_DIR/memory/lessons.jsonl"
                echo "✅ Memory cleared"
            fi
            ;;
        *)
            error "Unknown memory command: $1"
            echo "Usage: uap memory [status|query <term>|store <content>|clear]"
            exit 1
            ;;
    esac
}

# Task management
cmd_task() {
    check_integration
    shift
    
    case "${1:-list}" in
        list)
            cmd "Active Tasks"
            if [[ -f "$UAP_OMP_DIR/tasks.json" ]]; then
                jq '.' "$UAP_OMP_DIR/tasks.json" 2>/dev/null || echo "No tasks found"
            else
                echo "No tasks file found. Run 'uap init' first."
            fi
            ;;
        create)
            if [[ -z "${2:-}" ]]; then
                error "Usage: uap task create --title <title> [--type task|bug|feature]"
                exit 1
            fi
            cmd "Creating task..."
            title="${2:-}"
            type="task"
            shift 2
            while [[ $# -gt 0 ]]; do
                case "$1" in
                    --title) title="$2"; shift 2 ;;
                    --type) type="$2"; shift 2 ;;
                esac
            done
            # Create task entry
            task_id=$(date +%s%3N)
            task_json=$(jq -n \
                --arg id "$task_id" \
                --arg title "$title" \
                --arg type "$type" \
                '{id: $id, title: $title, type: $type, status: "pending", created_at: (now | todate), updated_at: (now | todate)}')
            jq ". += [$task_json]" "$UAP_OMP_DIR/tasks.json" > "$UAP_OMP_DIR/tasks.tmp.json" && mv "$UAP_OMP_DIR/tasks.tmp.json" "$UAP_OMP_DIR/tasks.json"
            echo "✅ Task created: $title (ID: $task_id)"
            ;;
        update)
            if [[ -z "${2:-}" ]]; then
                error "Usage: uap task update <id> [--status pending|in_progress|completed|abandoned]"
                exit 1
            fi
            cmd "Updating task $2..."
            # Update task logic here
            echo "Task update functionality coming soon"
            ;;
        ready)
            cmd "Checking task readiness..."
            if [[ -f "$UAP_OMP_DIR/tasks.json" ]]; then
                pending=$(jq '[.[] | select(.status == "pending")] | length' "$UAP_OMP_DIR/tasks.json")
                in_progress=$(jq '[.[] | select(.status == "in_progress")] | length' "$UAP_OMP_DIR/tasks.json")
                echo "✅ Task system ready"
                echo "   Pending: $pending"
                echo "   In Progress: $in_progress"
                
                # Check for common issues
                if [[ "$in_progress" -gt 3 ]]; then
                    echo "⚠️  Warning: More than 3 tasks in progress simultaneously"
                fi
            else
                echo "✅ No tasks configured. Start by creating a task with 'uap task create --title <title>'"
            fi
            ;;
        *)
            error "Unknown task command: $1"
            echo "Usage: uap task [list|create|--title <title>|update <id>|ready]"
            exit 1
            ;;
    esac
}

# Worktree management
cmd_worktree() {
    check_integration
    shift
    
    case "${1:-list}" in
        list)
            cmd "Active Worktrees"
            if [[ -f "$UAP_OMP_DIR/worktrees.json" ]]; then
                jq '.' "$UAP_OMP_DIR/worktrees.json" 2>/dev/null || echo "No worktrees found"
            else
                echo "No worktrees tracked. Run 'uap worktree create <slug>' to create one."
            fi
            ;;
        create)
            if [[ -z "${2:-}" ]]; then
                error "Usage: uap worktree create <slug>"
                exit 1
            fi
            cmd "Creating worktree: $2"
            slug="$2"
            # Create git worktree
            if command -v git &> /dev/null && git rev-parse --git-dir &> /dev/null; then
                git worktree add ".worktrees/uap-$slug" -b "uap-$slug" 2>/dev/null || {
                    error "Failed to create git worktree. Make sure you're in a git repository."
                    exit 1
                }
                # Track worktree in UAP
                worktree_json=$(jq -n \
                    --arg slug "$slug" \
                    '{slug: $slug, path: ".worktrees/uap-'$slug'", status: "active", created_at: (now | todate), last_used: (now | todate)}')
                jq ". += [$worktree_json]" "$UAP_OMP_DIR/worktrees.json" > "$UAP_OMP_DIR/worktrees.tmp.json" && mv "$UAP_OMP_DIR/worktrees.tmp.json" "$UAP_OMP_DIR/worktrees.json"
                echo "✅ Worktree created: .worktrees/uap-$slug"
            else
                error "Not in a git repository"
                exit 1
            fi
            ;;
        cleanup)
            if [[ -z "${2:-}" ]]; then
                error "Usage: uap worktree cleanup <slug>"
                exit 1
            fi
            cmd "Cleaning up worktree: $2"
            slug="$2"
            # Remove from tracking
            jq ". |= map(select(.slug != \"$slug\"))" "$UAP_OMP_DIR/worktrees.json" > "$UAP_OMP_DIR/worktrees.tmp.json" && mv "$UAP_OMP_DIR/worktrees.tmp.json" "$UAP_OMP_DIR/worktrees.json"
            # Remove git worktree if it exists
            if [[ -d ".worktrees/uap-$slug" ]]; then
                git worktree remove ".worktrees/uap-$slug" 2>/dev/null || true
                rm -rf ".worktrees/uap-$slug"
            fi
            echo "✅ Worktree cleaned up: $slug"
            ;;
        *)
            error "Unknown worktree command: $1"
            echo "Usage: uap worktree [list|create <slug>|cleanup <slug>]"
            exit 1
            ;;
    esac
}

# Agent coordination
cmd_agent() {
    check_integration
    shift
    
    case "${1:-status}" in
        status)
            cmd "Agent Status"
            if [[ -f "$UAP_OMP_DIR/agents.json" ]]; then
                jq '.' "$UAP_OMP_DIR/agents.json" 2>/dev/null || echo "No agents registered"
            else
                echo "No agents registered. Run 'uap agent register' to register an agent."
            fi
            ;;
        register)
            if [[ -z "${2:-}" ]]; then
                error "Usage: uap agent register <name>"
                exit 1
            fi
            cmd "Registering agent: $2"
            # Register agent logic here
            echo "Agent registration coming soon"
            ;;
        *)
            error "Unknown agent command: $1"
            echo "Usage: uap agent [status|register <name>]"
            exit 1
            ;;
    esac
}

# Pattern RAG
cmd_patterns() {
    check_integration
    shift
    
    case "${1:-list}" in
        list)
            cmd "Pattern Library"
            if [[ -f "$UAP_OMP_DIR/patterns.jsonl" ]]; then
                count=$(wc -l < "$UAP_OMP_DIR/patterns.jsonl")
                echo "Total patterns: $count"
                head -5 "$UAP_OMP_DIR/patterns.jsonl" | jq '.' 2>/dev/null || cat "$UAP_OMP_DIR/patterns.jsonl" | head -5
            else
                echo "No patterns indexed. Patterns are automatically indexed from your work."
            fi
            ;;
        query)
            if [[ -z "${2:-}" ]]; then
                error "Usage: uap patterns query <search_term> [--top N]"
                exit 1
            fi
            cmd "Querying patterns for: $2"
            # Pattern query logic here
            echo "Pattern search coming soon (requires Qdrant or similar)"
            ;;
        *)
            error "Unknown patterns command: $1"
            echo "Usage: uap patterns [list|query <term>]"
            exit 1
            ;;
    esac
}

# Compact memory and context
cmd_compact() {
    check_integration
    cmd "Compacting memory system..."
    
    # Compact lessons.jsonl if it exists
    if [[ -f "$UAP_OMP_DIR/memory/lessons.jsonl" ]]; then
        # Count entries
        before=$(wc -l < "$UAP_OMP_DIR/memory/lessons.jsonl")
        cmd "Before compaction: $before entries"
        
        # Keep only recent/high-importance entries
        jq -s '[.[] | select(.importance >= 5 or (.created_at | fromdateiso8601) > (now - 86400 * 30))]' "$UAP_OMP_DIR/memory/lessons.jsonl" > "$UAP_OMP_DIR/memory/lessons.compact.jsonl" 2>/dev/null && \
            mv "$UAP_OMP_DIR/memory/lessons.compact.jsonl" "$UAP_OMP_DIR/memory/lessons.jsonl"
        
        after=$(wc -l < "$UAP_OMP_DIR/memory/lessons.jsonl")
        cmd "After compaction: $after entries (removed $((before - after)) entries)"
    fi
    
    echo "✅ Memory compacted successfully"
}

# Show help
show_help() {
    cat << 'EOF'
UAP CLI for Oh-My-Pi Integration

Usage: uap <command> [options]

Commands:
  dashboard     Show UAP dashboard (tasks, agents, memory, progress)
  memory        Manage memory system (status, query, store, clear)
  task          Task management (list, create, update, ready)
  worktree      Worktree management (list, create, cleanup)
  agent         Agent coordination (status, register)
  patterns      Pattern RAG library (list, query)
  compact       Compact and optimize memory system
  help          Show this help message

Examples:
  uap dashboard              # Open UAP dashboard
  uap memory status          # Check memory health
  uap task create --title "Fix bug" --type bug
  uap worktree create fix-auth-bug
  uap patterns query authentication
  uap compact                # Optimize memory usage

For more information, see: docs/getting-started/INTEGRATION.md
EOF
}

# Main command handler
case "${1:-help}" in
    dashboard)
        cmd_dashboard
        ;;
    memory)
        cmd_memory ${@:2} 2>/dev/null || cmd_memory status
        ;;
    task)
        cmd_task ${@:2} 2>/dev/null || cmd_task list
        ;;
    worktree)
        cmd_worktree ${@:2} 2>/dev/null || cmd_worktree list
        ;;
    agent)
        cmd_agent ${@:2} 2>/dev/null || cmd_agent status
        ;;
    patterns)
        cmd_patterns ${@:2} 2>/dev/null || cmd_patterns list
        ;;
    compact)
        cmd_compact
        ;;
    help|--help|-h)
        show_help
        ;;
    *)
        # Try to execute as uap-omp command for compatibility
        if [[ -f "$SCRIPT_DIR/uap-omp.sh" ]]; then
            exec "$SCRIPT_DIR/uap-omp.sh" "${@}"
        else
            error "Unknown command: $1"
            show_help
            exit 1
        fi
        ;;
esac
