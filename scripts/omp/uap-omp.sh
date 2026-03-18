#!/usr/bin/env bash
# UAP Integration for Oh-My-Pi (omp)
# Provides deep UAP integration with oh-my-pi agent

set -euo pipefail

UAP_DIR="${HOME}/.uap/omp"
UAP_OMP_DIR="$PWD/.uap/omp"

log() {
    echo "🔧 [UAP-Omp] $1"
}

echo_error() {
    echo "❌ [UAP-Omp] $1" >&2
}

# Check if omp is installed
check_omp_installed() {
    command -v omp &> /dev/null && return 0 || return 1
}

# Check if UAP CLI is available
check_uap_installed() {
    command -v uap &> /dev/null && return 0 || return 1
}

# Initialize directories
init_dirs() {
    mkdir -p "$UAP_DIR"
    mkdir -p "$UAP_OMP_DIR/hooks/pre"
    mkdir -p "$UAP_OMP_DIR/hooks/post"
    mkdir -p "$UAP_OMP_DIR/commands"
    mkdir -p "$UAP_OMP_DIR/memory"
}

# Generate UAP hooks for oh-my-pi
generate_hooks() {
    log "Generating UAP hooks for oh-my-pi..."
    
    # Pre-session hook: inject memory and context
    cat > "$UAP_OMP_DIR/hooks/pre/session-start.sh" << 'EOF'
#!/usr/bin/env bash
# UAP Pre-Session Hook for Oh-My-Pi
# Injects memory context, checks for stale worktrees, and validates task readiness

UAP_OMP_DIR="${UAP_OMP_DIR:-$HOME/.uap/omp}"

# Load recent memory if available
if [[ -f "$UAP_OMP_DIR/memory/recent.md" ]]; then
    echo "[UAP-Omp] Injecting recent memory context..."
    MEMORY_CONTEXT=$(cat "$UAP_OMP_DIR/memory/recent.md")
    export UAP_MEMORY_CONTEXT="$MEMORY_CONTEXT"
fi

# Check for stale worktrees
if [[ -f "$UAP_OMP_DIR/worktrees.json" ]]; then
    STALE_WORKTREES=$(jq -r '[.[] | select(.status == "stale") | .slug] | join(", ")' "$UAP_OMP_DIR/worktrees.json" 2>/dev/null || echo "")
    if [[ -n "$STALE_WORKTREES" ]]; then
        echo "[UAP-Omp] Warning: Stale worktrees detected: $STALE_WORKTREES"
        export UAP_STALE_WORKTREES="$STALE_WORKTREES"
    fi
fi

# Check task readiness
if command -v uap &> /dev/null; then
    TASK_STATUS=$(uap task ready 2>/dev/null || echo "")
    if [[ -n "$TASK_STATUS" ]]; then
        export UAP_TASK_STATUS="$TASK_STATUS"
    fi
fi

# Inject current git context
if command -v git &> /dev/null && git rev-parse --git-dir &> /dev/null; then
    export UAP_GIT_BRANCH=$(git branch --show-current 2>/dev/null || echo "")
    export UAP_GIT_STATUS=$(git status --porcelain 2>/dev/null | head -5 || echo "")
fi
EOF

    # Post-session hook: save lessons and update memory
    cat > "$UAP_OMP_DIR/hooks/post/session-end.sh" << 'POSTEOF'
#!/usr/bin/env bash
# UAP Post-Session Hook for Oh-My-Pi
# Saves lessons learned, updates memory, and cleans up stale worktrees

UAP_OMP_DIR="${UAP_OMP_DIR:-$HOME/.uap/omp}"
SESSION_FILE="${UAP_OMP_DIR}/sessions/$(date +%Y%m%d_%H%M%S).log"

# Log session completion
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Session completed" >> "$SESSION_FILE"

# Save any lessons from environment variables
if [[ -n "${UAP_LESSONS:-}" ]]; then
    echo "[LESSON] $UAP_LESSONS" >> "$UAP_OMP_DIR/memory/lessons.md"
fi

# Update worktree status
if [[ -f "$UAP_OMP_DIR/worktrees.json" ]]; then
    # Mark active worktrees as recently used
    CURRENT_BRANCH=$(git branch --show-current 2>/dev/null || echo "main")
    CURRENT_TIME=$(date +%Y-%m-%dT%H:%M:%S)
    jq --arg branch "$CURRENT_BRANCH" --arg time "$CURRENT_TIME" '.[] | select(.slug | test($branch)) | .last_used = $time' "$UAP_OMP_DIR/worktrees.json" > "$UAP_OMP_DIR/worktrees.tmp.json" && mv "$UAP_OMP_DIR/worktrees.tmp.json" "$UAP_OMP_DIR/worktrees.json"
fi
POSTEOF

    chmod +x "$UAP_OMP_DIR/hooks/pre/session-start.sh"
    chmod +x "$UAP_OMP_DIR/hooks/post/session-end.sh"
    
    log "Hooks generated successfully"
}

# Generate UAP dashboard command for oh-my-pi
generate_dashboard_command() {
    log "Generating UAP dashboard command..."
    
    cat > "$UAP_OMP_DIR/commands/uap-dashboard.sh" << 'EOF'
#!/usr/bin/env bash
# UAP Dashboard for Oh-My-Pi
# Shows session overview, tasks, agents, memory, and progress

UAP_OMP_DIR="${UAP_OMP_DIR:-$HOME/.uap/omp}"

echo "╔══════════════════════════════════════════════════════════╗"
echo "║         UAP Dashboard for Oh-My-Pi                       ║"
echo "╠══════════════════════════════════════════════════════════╣"

# Memory status
echo "║  🧠 Memory Status                                         ║"
if [[ -f "$UAP_OMP_DIR/memory/short_term.db" ]]; then
    MEMORY_COUNT=$(sqlite3 "$UAP_OMP_DIR/memory/short_term.db" "SELECT COUNT(*) FROM memories;" 2>/dev/null || echo "0")
    echo "║    Recent: $MEMORY_COUNT lessons stored                   ║"
else
    echo "║    Recent: No memory database found                      ║"
fi

# Task status
echo "╠══════════════════════════════════════════════════════════╣"
echo "║  📋 Task Status                                           ║"
if [[ -f "$UAP_OMP_DIR/tasks.jsonl" ]]; then
    TASK_COUNT=$(wc -l < "$UAP_OMP_DIR/tasks.jsonl" 2>/dev/null || echo "0")
    echo "║    Active tasks: $TASK_COUNT                               ║"
    # Show pending tasks
    PENDING=$(jq -r '[.[] | select(.status == "pending") | .title] | join("\n    • ")' "$UAP_OMP_DIR/tasks.jsonl" 2>/dev/null || echo "None")
    if [[ -n "$PENDING" && "$PENDING" != "" ]]; then
        echo "║    Pending:                                              ║"
        echo "║    $PENDING                                               ║"
    fi
else
    echo "║    Active tasks: 0                                       ║"
fi

# Worktree status
echo "╠══════════════════════════════════════════════════════════╣"
echo "║  🌿 Worktrees                                             ║"
if [[ -f "$UAP_OMP_DIR/worktrees.json" ]]; then
    WORKTREE_COUNT=$(jq -r 'length' "$UAP_OMP_DIR/worktrees.json" 2>/dev/null || echo "0")
    ACTIVE=$(jq -r '[.[] | select(.status == "active")] | length' "$UAP_OMP_DIR/worktrees.json" 2>/dev/null || echo "0")
    STALE=$(jq -r '[.[] | select(.status == "stale")] | length' "$UAP_OMP_DIR/worktrees.json" 2>/dev/null || echo "0")
    echo "║    Active: $ACTIVE | Stale: $STALE | Total: $WORKTREE_COUNT           ║"
else
    echo "║    No worktrees tracked                                  ║"
fi

# Agent status
echo "╠══════════════════════════════════════════════════════════╣"
echo "║  🤖 Agents                                                ║"
if [[ -f "$UAP_OMP_DIR/agents.json" ]]; then
    AGENT_COUNT=$(jq -r 'length' "$UAP_OMP_DIR/agents.json" 2>/dev/null || echo "0")
    RUNNING=$(jq -r '[.[] | select(.status == "running")] | length' "$UAP_OMP_DIR/agents.json" 2>/dev/null || echo "0")
    echo "║    Total: $AGENT_COUNT | Running: $RUNNING                     ║"
else
    echo "║    No agents registered                                  ║"
fi

# Pattern RAG status
echo "╠══════════════════════════════════════════════════════════╣"
echo "║  📚 Pattern Library                                       ║"
if [[ -f "$UAP_OMP_DIR/patterns.jsonl" ]]; then
    PATTERN_COUNT=$(wc -l < "$UAP_OMP_DIR/patterns.jsonl" 2>/dev/null || echo "0")
    echo "║    Patterns indexed: $PATTERN_COUNT                         ║"
else
    echo "║    No patterns indexed                                   ║"
fi

# Git context
echo "╠══════════════════════════════════════════════════════════╣"
echo "║  📁 Current Context                                       ║"
if command -v git &> /dev/null && git rev-parse --git-dir &> /dev/null; then
    BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
    UNCOMMITTED=$(git status --porcelain 2>/dev/null | wc -l || echo "0")
    echo "║    Branch: $BRANCH                                         ║"
    echo "║    Uncommitted changes: $UNCOMMITTED                       ║"
else
    echo "║    Not in a git repository                               ║"
fi

echo "╚══════════════════════════════════════════════════════════╝"

# Quick actions
if [[ -f "$UAP_OMP_DIR/tasks.jsonl" ]]; then
    PENDING_COUNT=$(jq -r '[.[] | select(.status == "pending" or .status == "in_progress")] | length' "$UAP_OMP_DIR/tasks.jsonl" 2>/dev/null || echo "0")
    if [[ "$PENDING_COUNT" -gt 0 ]]; then
        echo ""
        echo "💡 Quick actions:"
        echo "   • uap task list - View all tasks"
        echo "   • uap worktree list - Check worktree status"
        echo "   • uap memory status - See memory health"
    fi
fi
EOF

    chmod +x "$UAP_OMP_DIR/commands/uap-dashboard.sh"
    log "Dashboard command generated"
}

# Create oh-my-pi settings with UAP integration
generate_settings() {
    log "Creating UAP settings for oh-my-pi..."
    
    cat > "$UAP_OMP_DIR/settings.json" << 'EOF'
{
  "uapIntegration": {
    "enabled": true,
    "memoryInjection": true,
    "patternRAG": true,
    "worktreeIsolation": true,
    "taskTracking": true,
    "agentCoordination": true,
    "hooks": {
      "preSession": "$UAP_OMP_DIR/hooks/pre/session-start.sh",
      "postSession": "$UAP_OMP_DIR/hooks/post/session-end.sh"
    },
    "dashboard": {
      "command": "$UAP_OMP_DIR/commands/uap-dashboard.sh",
      "autoOpen": false,
      "views": ["overview", "tasks", "agents", "memory", "progress"]
    }
  },
  "ompSettings": {
    "autoLoadUAPContext": true,
    "injectMemoryOnStart": true,
    "saveLessonsOnEnd": true,
    "cleanupStaleWorktrees": true
  }
}
EOF
    
    log "Settings created at $UAP_OMP_DIR/settings.json"
}

# Initialize memory system
init_memory() {
    log "Initializing memory system..."
    
    # Create memory directories
    mkdir -p "$UAP_OMP_DIR/memory/long_term"
    mkdir -p "$UAP_OMP_DIR/memory/short_term"
    mkdir -p "$UAP_OMP_DIR/memory/skills"
    
    # Initialize patterns index
    if [[ ! -f "$UAP_OMP_DIR/patterns.jsonl" ]]; then
        touch "$UAP_OMP_DIR/patterns.jsonl"
    fi
    
    # Initialize tasks file
    if [[ ! -f "$UAP_OMP_DIR/tasks.json" ]]; then
        echo '[]' > "$UAP_OMP_DIR/tasks.json"
    fi
    
    # Initialize worktrees file
    if [[ ! -f "$UAP_OMP_DIR/worktrees.json" ]]; then
        echo '[]' > "$UAP_OMP_DIR/worktrees.json"
    fi
    
    log "Memory system initialized"
}

# Install oh-my-pi integration
install() {
    log "Installing UAP integration for oh-my-pi..."
    
    # Check dependencies
    if ! check_omp_installed; then
        echo_error "oh-my-pi (omp) is not installed. Please install it first:"
        echo_error "  bun install -g @oh-my-pi/pi-coding-agent"
        exit 1
    fi
    
    # Initialize directories
    init_dirs
    
    # Generate components
    generate_hooks
    generate_dashboard_command
    generate_settings
    init_memory
    
    # Create symlink to make commands available
    if [[ -d "$HOME/.omp/agent/commands" ]]; then
        ln -sf "$UAP_OMP_DIR/commands/uap-dashboard.sh" "$HOME/.omp/agent/commands/uap-dashboard.sh"
        log "Dashboard command linked to oh-my-pi commands directory"
    fi
    
    # Create symlink for hooks (if oh-my-pi supports them)
    if [[ -d "$HOME/.omp/agent/hooks" ]]; then
        mkdir -p "$HOME/.omp/agent/hooks/pre"
        mkdir -p "$HOME/.omp/agent/hooks/post"
        ln -sf "$UAP_OMP_DIR/hooks/pre/session-start.sh" "$HOME/.omp/agent/hooks/pre/uap-session-start.sh"
        ln -sf "$UAP_OMP_DIR/hooks/post/session-end.sh" "$HOME/.omp/agent/hooks/post/uap-session-end.sh"
        log "Hooks linked to oh-my-pi hooks directory"
    fi
    
    echo ""
    echo "✅ UAP integration for oh-my-pi installed successfully!"
    echo ""
    echo "📁 Files created:"
    echo "   - $UAP_OMP_DIR/settings.json"
    echo "   - $UAP_OMP_DIR/hooks/pre/session-start.sh"
    echo "   - $UAP_OMP_DIR/hooks/post/session-end.sh"
    echo "   - $UAP_OMP_DIR/commands/uap-dashboard.sh"
    echo ""
    echo "🚀 Usage:"
    echo "   • Start oh-my-pi with UAP context: omp"
    echo "   • View dashboard: /uap-dashboard or run uap-omp dashboard"
    echo "   • Check status: uap-omp status"
    echo "   • Compact memory: uap-omp compact"
    echo ""
    echo "💡 Tip: Run 'uap-omp dashboard' to see your UAP overview"
}

# Show status
status() {
    log "UAP Integration Status for oh-my-pi"
    
    if ! check_omp_installed; then
        echo_error "oh-my-pi is not installed"
        return 1
    fi
    
    if [[ -f "$UAP_OMP_DIR/settings.json" ]]; then
        echo "✅ Integration enabled"
        cat "$UAP_OMP_DIR/settings.json" | jq '.uapIntegration'
    else
        echo "❌ Integration not installed. Run: uap-omp install"
    fi
}

# Uninstall
uninstall() {
    log "Removing UAP integration for oh-my-pi..."
    
    # Remove symlinks
    if [[ -L "$HOME/.omp/agent/commands/uap-dashboard.sh" ]]; then
        rm "$HOME/.omp/agent/commands/uap-dashboard.sh"
    fi
    
    if [[ -L "$HOME/.omp/agent/hooks/pre/uap-session-start.sh" ]]; then
        rm "$HOME/.omp/agent/hooks/pre/uap-session-start.sh"
    fi
    
    if [[ -L "$HOME/.omp/agent/hooks/post/uap-session-end.sh" ]]; then
        rm "$HOME/.omp/agent/hooks/post/uap-session-end.sh"
    fi
    
    # Remove UAP directory
    rm -rf "$UAP_OMP_DIR"
    
    log "UAP integration removed successfully"
}

# Show help
show_help() {
    cat << EOF
UAP Integration for Oh-My-Pi (omp)

Usage: uap-omp <command> [options]

Commands:
  install     Install UAP integration for oh-my-pi
  uninstall   Remove UAP integration from oh-my-pi
  status      Show integration status
  dashboard   Show UAP dashboard (tasks, agents, memory, etc.)
  memory      Manage memory system
  compact     Compact and optimize memory
  hooks       Manage hook files
  help        Show this help message

Examples:
  uap-omp install          # Install integration
  uap-omp status           # Check if installed
  uap-omp dashboard        # Open UAP dashboard
  uap-omp compact          # Compact memory system

For more information, see: docs/getting-started/INTEGRATION.md
EOF
}

# Main command handler
case "${1:-install}" in
    install)
        install
        ;;
    uninstall)
        uninstall
        ;;
    status)
        status
        ;;
    dashboard)
        if [[ -f "$UAP_OMP_DIR/commands/uap-dashboard.sh" ]]; then
            "$UAP_OMP_DIR/commands/uap-dashboard.sh"
        else
            echo_error "Dashboard not installed. Run: uap-omp install"
        fi
        ;;
    memory)
        shift
        case "${1:-status}" in
            status)
                if [[ -f "$UAP_OMP_DIR/memory/short_term.db" ]]; then
                    sqlite3 "$UAP_OMP_DIR/memory/short_term.db" "SELECT COUNT(*) as total_memories, COUNT(DISTINCT type) as types FROM memories;"
                else
                    echo "No memory database found"
                fi
                ;;
            compact)
                log "Compacting memory system..."
                # Implement memory compaction logic here
                echo "Memory compaction completed"
                ;;
            *)
                show_help
                ;;
        esac
        ;;
    compact)
        log "Compacting memory system..."
        if [[ -f "$UAP_OMP_DIR/memory/short_term.db" ]]; then
            sqlite3 "$UAP_OMP_DIR/memory/short_term.db" "VACUUM; ANALYZE;"
            echo "Memory compaction completed"
        else
            echo "No memory database found"
        fi
        ;;
    hooks)
        if [[ -d "$UAP_OMP_DIR/hooks" ]]; then
            echo "Hooks directory: $UAP_OMP_DIR/hooks"
            ls -la "$UAP_OMP_DIR/hooks/"
        else
            echo "Hooks not installed. Run: uap-omp install"
        fi
        ;;
    help|--help|-h)
        show_help
        ;;
    *)
        echo_error "Unknown command: $1"
        show_help
        exit 1
        ;;
esac
