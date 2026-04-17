# UAP Configuration Reference

Complete configuration schema and environment variables for Universal Agent Protocol.

## .uap.json Project Configuration

### Root Schema

```json
{
  "version": "1.0.0",
  "project": {
    "name": "string (required)",
    "defaultBranch": "string (optional, default: main)"
  },
  "memory": {
    "shortTerm": {
      "enabled": "boolean (default: true)",
      "path": "string (default: ./agents/data/memory/short_term.db)",
      "maxEntries": "integer (default: 50)"
    },
    "longTerm": {
      "enabled": "boolean (default: true)",
      "provider": "string (qdrant | github | local)",
      "endpoint": "string (for Qdrant cloud)",
      "apiKey": "string (for Qdrant cloud)"
    }
  },
  "multiModel": {
    "enabled": "boolean (default: true)",
    "models": "string[] (required)",
    "roles": {
      "planner": "string (model ID)",
      "executor": "string (model ID)",
      "fallback": "string (model ID)"
    },
    "routingStrategy": "string (cost-optimized | performance-first | balanced)"
  },
  "worktrees": {
    "enabled": "boolean (default: true)",
    "directory": "string (default: .worktrees)"
  },
  "policies": {
    "enabled": "boolean (default: true)",
    "auditTrail": "boolean (default: true)"
  },
  "hooks": {
    "sessionStart": "boolean (default: true)",
    "preCompact": "boolean (default: true)"
  }
}
```

### Validation Rules

| Field                       | Type     | Required | Default                            | Description                |
| --------------------------- | -------- | -------- | ---------------------------------- | -------------------------- |
| version                     | string   | Yes      | -                                  | Schema version (1.0.0)     |
| project.name                | string   | Yes      | -                                  | Project identifier         |
| project.defaultBranch       | string   | No       | main                               | Git default branch         |
| memory.shortTerm.enabled    | boolean  | No       | true                               | Enable short-term memory   |
| memory.shortTerm.path       | string   | No       | ./agents/data/memory/short_term.db | SQLite path                |
| memory.shortTerm.maxEntries | integer  | No       | 50                                 | Max working memory entries |
| memory.longTerm.provider    | string   | No       | qdrant                             | Backend provider           |
| multiModel.models           | string[] | Yes      | -                                  | Available model IDs        |
| multiModel.routingStrategy  | string   | No       | balanced                           | Routing strategy           |

## Environment Variables

### Memory Configuration

| Variable                      | Type   | Default                            | Description               |
| ----------------------------- | ------ | ---------------------------------- | ------------------------- |
| UAP_MEMORY_SHORT_TERM_PATH    | string | ./agents/data/memory/short_term.db | Short-term memory DB path |
| UAP_MEMORY_LONG_TERM_PROVIDER | string | qdrant                             | Long-term memory backend  |
| UAP_QDRANT_ENDPOINT           | string | -                                  | Qdrant cloud endpoint     |
| UAP_QDRANT_API_KEY            | string | -                                  | Qdrant API key            |

### Multi-Model Configuration

| Variable             | Type   | Default  | Description            |
| -------------------- | ------ | -------- | ---------------------- |
| UAP_MODEL_PLANNER    | string | opus-4.6 | Default planner model  |
| UAP_MODEL_EXECUTOR   | string | glm-4.7  | Default executor model |
| UAP_MODEL_FALLBACK   | string | opus-4.5 | Fallback on failure    |
| UAP_ROUTING_STRATEGY | string | balanced | Routing strategy       |

### Worktree Configuration

| Variable             | Type    | Default    | Description             |
| -------------------- | ------- | ---------- | ----------------------- |
| UAP_WORKTREE_DIR     | string  | .worktrees | Worktree directory path |
| UAP_WORKTREE_ENABLED | boolean | true       | Enable worktree system  |

### Policy Configuration

| Variable             | Type    | Default | Description               |
| -------------------- | ------- | ------- | ------------------------- |
| UAP_POLICIES_ENABLED | boolean | true    | Enable policy enforcement |
| UAP_AUDIT_TRAIL      | boolean | true    | Enable audit logging      |

### Debug & Logging

| Variable              | Type    | Default | Description                          |
| --------------------- | ------- | ------- | ------------------------------------ |
| UAP_VERBOSE           | boolean | false   | Enable verbose logging               |
| UAP_LOG_LEVEL         | string  | info    | Log level (debug, info, warn, error) |
| UAP_TELEMETRY_ENABLED | boolean | true    | Enable telemetry collection          |

## Platform-Specific Configurations

### Claude Code Integration

```json
{
  "hooks": {
    "claude": {
      "sessionStart": "templates/hooks/session-start.sh",
      "preCompact": "templates/hooks/pre-compact.sh"
    }
  }
}
```

### Factory.AI Integration

```json
{
  "hooks": {
    "factory": {
      "sessionStart": "templates/hooks/session-start.sh",
      "preCompact": "templates/hooks/pre-compact.sh"
    }
  }
}
```

### OpenCode Integration

```json
{
  "hooks": {
    "opencode": {
      "sessionStart": "templates/hooks/session-start.sh",
      "preCompact": "templates/hooks/pre-compact.sh"
    }
  }
}
```

## Example Configurations

### Minimal Configuration

```json
{
  "version": "1.0.0",
  "project": { "name": "my-project" },
  "memory": { "shortTerm": { "enabled": true } },
  "multiModel": {
    "enabled": true,
    "models": ["opus-4.6", "qwen35"],
    "roles": { "planner": "opus-4.6", "executor": "qwen35" }
  }
}
```

### Production Configuration

```json
{
  "version": "1.0.0",
  "project": { "name": "production-app", "defaultBranch": "main" },
  "memory": {
    "shortTerm": { "enabled": true, "maxEntries": 50 },
    "longTerm": { "enabled": true, "provider": "qdrant", "endpoint": "https://qdrant.example.com" }
  },
  "multiModel": {
    "enabled": true,
    "models": ["opus-4.6", "sonnet-4.6", "qwen35"],
    "roles": { "planner": "opus-4.6", "executor": "qwen35", "fallback": "sonnet-4.6" },
    "routingStrategy": "cost-optimized"
  },
  "worktrees": { "enabled": true, "directory": ".worktrees" },
  "policies": { "enabled": true, "auditTrail": true }
}
```

## Configuration Validation

Run validation:

```bash
uap compliance check
```

This verifies:

- Memory database paths exist or can be created
- Model IDs are valid
- Worktree directory is accessible
- Policy enforcement is properly configured

## See Also

- [Getting Started](../../docs/getting-started/SETUP.md)
- [Multi-Model Architecture](../../docs/reference/FEATURES.md#multi-model-architecture)
- [Memory System](../../docs/reference/FEATURES.md#memory-system)
