#!/bin/bash
# Start agent support services (Qdrant vector database)
#
# Usage:
#   ./agents/scripts/start-services.sh        # Start services
#   ./agents/scripts/start-services.sh stop   # Stop services
#   ./agents/scripts/start-services.sh status # Check status

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENTS_DIR="$(dirname "$SCRIPT_DIR")"

cd "$AGENTS_DIR"

case "${1:-start}" in
    start)
        echo "Starting agent services..."
        docker-compose up -d

        echo "Waiting for Qdrant to be healthy..."
        for _ in {1..30}; do
            if curl -s http://localhost:6333/healthz > /dev/null 2>&1; then
                echo "Qdrant is ready!"
                break
            fi
            sleep 1
        done

        # Check if claude_memory collection exists
        COLLECTIONS=$(curl -s http://localhost:6333/collections | grep -o '"name":"[^"]*"' | grep claude_memory || true)
        if [ -z "$COLLECTIONS" ]; then
            echo "Creating claude_memory collection..."
            curl -s -X PUT http://localhost:6333/collections/claude_memory \
                -H "Content-Type: application/json" \
                -d '{"vectors": {"size": 384, "distance": "Cosine"}}' > /dev/null

            # Check if we need to migrate memories
            MEMORY_FILE="$AGENTS_DIR/data/memory/long_term.json"
            if [ -f "$MEMORY_FILE" ]; then
                echo "Migrating long-term memories to Qdrant..."
                if [ -f "$AGENTS_DIR/.venv/bin/python" ]; then
                    "$AGENTS_DIR/.venv/bin/python" "$SCRIPT_DIR/migrate_memory_to_qdrant.py"
                else
                    echo "Warning: Virtual environment not found. Run:"
                    echo "  python3 -m venv agents/.venv"
                    echo "  agents/.venv/bin/pip install sentence-transformers qdrant-client"
                    echo "  agents/.venv/bin/python agents/scripts/migrate_memory_to_qdrant.py"
                fi
            fi
        else
            echo "claude_memory collection already exists"
        fi

        echo ""
        echo "Agent services started:"
        echo "  - Qdrant: http://localhost:6333"
        echo "  - SQLite: $AGENTS_DIR/data/memory/short_term.db"
        ;;

    stop)
        echo "Stopping agent services..."
        docker-compose down
        echo "Services stopped."
        ;;

    status)
        echo "=== Agent Services Status ==="
        echo ""

        # Qdrant status
        if curl -s http://localhost:6333/healthz > /dev/null 2>&1; then
            echo "Qdrant: RUNNING"
            POINTS=$(curl -s http://localhost:6333/collections/claude_memory 2>/dev/null | grep -o '"points_count":[0-9]*' | cut -d: -f2 || echo "0")
            echo "  - Collection: claude_memory ($POINTS points)"
        else
            echo "Qdrant: NOT RUNNING"
            echo "  Run: ./agents/scripts/start-services.sh"
        fi

        echo ""

        # SQLite status
        if [ -f "$AGENTS_DIR/data/memory/short_term.db" ]; then
            MEMORIES=$(sqlite3 "$AGENTS_DIR/data/memory/short_term.db" "SELECT COUNT(*) FROM memories;" 2>/dev/null || echo "0")
            echo "Short-term memory: $MEMORIES entries"
        else
            echo "Short-term memory: NOT INITIALIZED"
        fi
        ;;

    *)
        echo "Usage: $0 {start|stop|status}"
        exit 1
        ;;
esac
