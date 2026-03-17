# OpenCode Integration Guide

This guide explains how to add new integrations to OpenCode based on analysis of the Universal Agent Protocol (UAP) codebase.

## Table of Contents

1. [OpenCode Plugin Architecture](#opencode-plugin-architecture)
2. [Plugin Structure and Registration](#plugin-structure-and-registration)
3. [Defining Custom Tools](#defining-custom-tools)
4. [Hook System](#hook-system)
5. [Integration Patterns](#integration-patterns)
6. [Example: Creating a New Integration](#example-creating-a-new-integration)
7. [Best Practices](#best-practices)

---

## OpenCode Plugin Architecture

OpenCode uses a **TypeScript plugin system** via the `@opencode-ai/plugin` package (v1.2.x). Plugins are TypeScript modules that extend agent capabilities through:

- **Custom Tools**: Define new tools that the LLM can call
- **Event Hooks**: Intercept and modify agent behavior at specific points
- **Middleware**: Transform messages and context before/after processing

### Plugin Location

Plugins are stored in:

```
.opencode/plugin/
├── uap-commands.ts        # UAP CLI commands as tools
├── uap-skills.ts          # Skill loading system
├── uap-droids.ts          # Specialized agent droids
├── uap-pattern-rag.ts     # Pattern retrieval via RAG
├── uap-task-completion.ts # Task completion tracking
├── uap-session-hooks.ts   # Session lifecycle hooks
└── uap-enforce.ts         # Loop detection and enforcement
```

### Dependencies

The plugin system requires:

```json
{
  "dependencies": {
    "@opencode-ai/plugin": "1.2.16"
  }
}
```

---

## Plugin Structure and Registration

### Basic Plugin Template

```typescript
import type { Plugin } from '@opencode-ai/plugin';
import { tool } from '@opencode-ai/plugin';

export const MyPlugin: Plugin = async ({ $, directory, client }) => {
  return {
    // Tool definitions
    tool: {
      my_custom_tool: tool({
        description: 'What this tool does',
        args: {
          param1: tool.schema.string().describe('First parameter'),
        },
        async execute({ param1 }) {
          // Implementation using shell commands or other tools
          const result = await $`command ${param1}`.quiet();
          return result.stdout.toString().trim();
        },
      }),
    },

    // Event hooks
    event: async ({ event }) => {
      if (event.type === 'session.created') {
        console.log('Session started');
      }
    },

    // Middleware for message transformation
    middleware: async (input, next) => {
      // Modify input before processing
      const result = await next(input);
      // Optionally modify output
      return result;
    },
  };
};
```

### Available Plugin Context

| Parameter   | Type                | Description                                     |
| ----------- | ------------------- | ----------------------------------------------- |
| `$`         | Template string tag | Shell command execution (similar to $ in shell) |
| `directory` | string              | Project directory path                          |
| `client`    | OpenCode client     | Direct access to OpenCode client API            |

---

## Defining Custom Tools

### Tool Schema Definition

Tools are defined using the `tool()` function with a schema:

```typescript
import { tool } from '@opencode-ai/plugin';

const myTool = tool({
  description: 'Description visible to the LLM',
  args: {
    // Required string parameter
    name: tool.schema.string().describe('User name'),

    // Optional number with constraints
    age: tool.schema.number().min(0).max(150).default(18).describe('User age'),

    // Enum parameter
    mode: tool.schema.enum(['read', 'write', 'execute']).default('read').describe('Operation mode'),

    // Array parameter
    items: tool.schema.array().of(tool.schema.string()).describe('List of items'),
  },
  async execute(args) {
    // Tool implementation
    const { name, age = 18, mode = 'read', items = [] } = args;

    // Use shell commands via $ template tag
    const result = await $`echo "Processing ${name} in ${mode} mode"`;

    return result.stdout.toString().trim();
  },
});
```

### Tool Registration

Tools are registered in the `tool` property of the plugin return value:

```typescript
export const MyPlugin: Plugin = async ({ $ }) => {
  return {
    tool: {
      // Single tool
      my_tool: tool({...}),

      // Multiple tools
      another_tool: tool({...}),
    },
  };
};
```

### Tool Naming Convention

- Use **snake_case** for tool names (e.g., `my_custom_tool`)
- Prefix with domain when relevant (e.g., `uap_memory_query`, `git_worktree_create`)
- Tools become accessible to the LLM as `/tool_name` commands

---

## Hook System

OpenCode provides several hook points for customizing agent behavior:

### Event Hooks

```typescript
export const MyPlugin: Plugin = async ({ $ }) => {
  return {
    event: async ({ event }) => {
      if (event.type === 'session.created') {
        // Session initialization
        console.log('New session started');
      }

      if (event.type === 'session.compacting') {
        // Before context compression
        await $`echo "Saving critical state before compaction"`;
      }
    },
  };
};
```

#### Available Events

| Event Type           | When Fired                 | Use Case                          |
| -------------------- | -------------------------- | --------------------------------- |
| `session.created`    | New session starts         | Initialize state, load context    |
| `session.compacting` | Before context compression | Preserve important information    |
| `message.created`    | User message received      | Pre-process input, inject context |

### Tool Execution Hooks

```typescript
export const MyPlugin: Plugin = async ({ $ }) => {
  return {
    'tool.execute.before': async (input, output) => {
      // Before tool execution - can modify args or block
      if (input.tool === 'bash') {
        console.log(`Executing: ${output.args.command}`);
      }
    },

    'tool.execute.after': async (input, _output) => {
      // After tool execution - can log, record, or modify output
      const result = _output.output?.toString();
      await $`echo "Tool ${input.tool} completed" >> /tmp/tool_log.txt`;
    },
  };
};
```

### Tool Definition Hooks

```typescript
export const MyPlugin: Plugin = async ({ $ }) => {
  return {
    'tool.definition': async (_input, output) => {
      // Modify tool descriptions before they reach the LLM
      if (output.description) {
        output.description += '\n\n[Note: This tool requires admin privileges]';
      }
    },
  };
};
```

### System Transform Hooks

```typescript
export const MyPlugin: Plugin = async ({ $ }) => {
  return {
    'experimental.chat.system.transform': async (_input, output) => {
      // Inject system context into the conversation
      const context = await getRelevantContext();
      output.system.push(context);
    },
  };
};
```

### Middleware

```typescript
export const MyPlugin: Plugin = async ({ $ }) => {
  return {
    middleware: async (input, next) => {
      // Transform input messages before processing
      const lastMessage = input.messages?.[input.messages.length - 1];

      if (lastMessage?.role === 'user') {
        // Add pre-processing context
        const taskContext = await extractTaskContext(lastMessage.content);
        input.messages.splice(input.messages.length - 1, 0, {
          role: 'system',
          content: `<task-context>${taskContext}</task-context>`,
        });
      }

      // Call next middleware
      const result = await next(input);

      // Post-process output if needed
      return result;
    },
  };
};
```

---

## Integration Patterns

### Pattern 1: CLI Command Wrapper

Wrap existing CLI tools as agent tools:

```typescript
export const MyPlugin: Plugin = async ({ $ }) => {
  return {
    tool: {
      my_cli_wrapper: tool({
        description: 'Execute my-cli command with automatic error handling',
        args: {
          command: tool.schema.string().describe('CLI subcommand'),
          args: tool.schema.array().of(tool.schema.string()).optional(),
        },
        async execute({ command, args = [] }) {
          const result = await $`my-cli ${command} ${args.join(' ')}`.nothrow();

          if (result.exitCode !== 0) {
            return `Error: ${result.stderr.toString()}`;
          }

          return result.stdout.toString().trim();
        },
      }),
    },
  };
};
```

### Pattern 2: File System Operations

Create file-based tools with validation:

```typescript
import { readFile, writeFile, readdir } from 'fs/promises';

export const MyPlugin: Plugin = async ({ directory }) => {
  const projectDir = directory || '.';

  return {
    tool: {
      project_file_read: tool({
        description: 'Read a file from the project with path validation',
        args: {
          path: tool.schema.string().describe('Relative file path'),
        },
        async execute({ path }) {
          const fullPath = path.startsWith('/') ? path : join(projectDir, path);

          // Security: prevent directory traversal
          if (path.includes('..') || !fullPath.startsWith(projectDir)) {
            return 'Error: Access denied';
          }

          try {
            const content = await readFile(fullPath, 'utf-8');
            return content;
          } catch (err) {
            return `File not found: ${path}`;
          }
        },
      }),
    },
  };
};
```

### Pattern 3: Memory Integration

Integrate with persistent memory systems:

```typescript
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export const MyPlugin: Plugin = async ({ $ }) => {
  return {
    tool: {
      memory_query: tool({
        description: 'Query persistent memory for relevant context',
        args: {
          query: tool.schema.string().describe('Search query'),
          limit: tool.schema.number().default(5).describe('Max results'),
        },
        async execute({ query, limit }) {
          const result =
            await $`python3 ./agents/scripts/query_memory.py "${query}" --limit ${limit}`.quiet();
          return result.stdout.toString().trim() || 'No memories found.';
        },
      }),
    },
  };
};
```

### Pattern 4: External API Integration

Connect to external services:

```typescript
export const MyPlugin: Plugin = async ({ client }) => {
  return {
    tool: {
      github_issue_create: tool({
        description: 'Create a GitHub issue via the API',
        args: {
          title: tool.schema.string().describe('Issue title'),
          body: tool.schema.string().describe('Issue description'),
          labels: tool.schema.array().of(tool.schema.string()).optional(),
        },
        async execute({ title, body, labels = [] }) {
          const response = await client.fetch(
            'https://api.github.com/repos/{owner}/{repo}/issues',
            {
              method: 'POST',
              headers: { Authorization: `token ${process.env.GITHUB_TOKEN}` },
              body: JSON.stringify({ title, body, labels }),
            }
          );

          const data = await response.json();
          return `Issue created: ${data.html_url}`;
        },
      }),
    },
  };
};
```

### Pattern 5: Context Injection (RAG)

Inject relevant context on-demand:

```typescript
export const MyPlugin: Plugin = async ({ $ }) => {
  return {
    middleware: async (input, next) => {
      const lastMessage = input.messages?.[input.messages.length - 1];

      if (lastMessage?.role === 'user') {
        const taskText =
          typeof lastMessage.content === 'string'
            ? lastMessage.content
            : JSON.stringify(lastMessage.content);

        // Query for relevant patterns/docs
        if (taskText.length > 50) {
          const result =
            await $`python3 ./scripts/query_patterns.py "${taskText.slice(0, 200)}" --top 3`.quiet();
          const context = result.stdout.toString().trim();

          if (context) {
            input.messages.splice(input.messages.length - 1, 0, {
              role: 'system',
              content: `<relevant-context>\n${context}\n</relevant-context>`,
            });
          }
        }
      }

      return next(input);
    },
  };
};
```

---

## Example: Creating a New Integration

Let's create a complete integration example: a **Database Migration Tool** plugin.

### Step 1: Create the Plugin File

Create `.opencode/plugin/db-migrations.ts`:

```typescript
import type { Plugin } from '@opencode-ai/plugin';
import { tool } from '@opencode-ai/plugin';
import { readFile, writeFile, readdir } from 'fs/promises';
import { join } from 'path';

/**
 * Database Migration Plugin
 *
 * Provides tools for managing database migrations:
 * - db_migration_create: Create new migration files
 * - db_migration_status: Check migration status
 * - db_migration_apply: Apply pending migrations
 * - db_migration_history: View migration history
 */

export const DBMigrationsPlugin: Plugin = async ({ $, directory }) => {
  const projectDir = directory || '.';
  const migrationsDir = join(projectDir, 'migrations');

  // Track applied migrations
  let migrationCache: string[] = [];

  async function loadMigrationStatus() {
    if (migrationCache.length === 0) {
      try {
        const result =
          await $`sqlite3 ${projectDir}/db.sqlite3 "SELECT name FROM django_migrations ORDER BY id;"`.quiet();
        migrationCache = result.stdout.toString().trim().split('\n').filter(Boolean);
      } catch {
        migrationCache = [];
      }
    }
    return migrationCache;
  }

  async function getMigrationFiles() {
    try {
      const files = await readdir(migrationsDir);
      return files.filter((f) => f.endsWith('.sql') || f.endsWith('.py'));
    } catch {
      return [];
    }
  }

  return {
    tool: {
      db_migration_create: tool({
        description: 'Create a new database migration file with timestamp prefix',
        args: {
          name: tool.schema.string().describe('Migration name (will be slugified)'),
        },
        async execute({ name }) {
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          const slug = name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/(^-|-$)/g, '');
          const filename = `${timestamp}_${slug}.sql`;

          const migrationContent = `-- Migration: ${name}\n-- Created: ${new Date().toISOString()}\n\n-- Add your SQL here\n`;

          await writeFile(join(migrationsDir, filename), migrationContent);

          return `Created migration: ${filename}`;
        },
      }),

      db_migration_status: tool({
        description: 'Check which migrations have been applied and which are pending',
        args: {},
        async execute() {
          const [applied, pending] = await Promise.all([
            loadMigrationStatus(),
            getMigrationFiles(),
          ]);

          const pendingMigrations = pending
            .filter((f) => !f.replace('.sql', '').split('_')[0].includes('initial'))
            .filter((f) => {
              const timestamp = f.split('_')[0];
              return !applied.some((m) => m.includes(timestamp));
            });

          let output = '### Applied Migrations\n';
          applied.forEach((m) => (output += `- ${m}\n`));

          if (pendingMigrations.length > 0) {
            output += '\n### Pending Migrations\n';
            pendingMigrations.forEach((f) => (output += `- ${f}\n`));
          } else {
            output += '\n✅ All migrations applied!';
          }

          return output;
        },
      }),

      db_migration_apply: tool({
        description: 'Apply all pending database migrations',
        args: {
          migration: tool.schema.string().optional().describe('Specific migration to apply'),
        },
        async execute({ migration }) {
          if (migration) {
            // Apply specific migration
            const result = await $`python3 manage.py migrate app_name ${migration}`.nothrow();
            return result.stdout.toString() + result.stderr.toString();
          }

          // Apply all pending
          const result = await $`python3 manage.py migrate`.nothrow();
          return result.stdout.toString() + result.stderr.toString();
        },
      }),

      db_migration_history: tool({
        description: 'View migration history with timestamps',
        args: {
          limit: tool.schema.number().default(10).describe('Number of recent migrations'),
        },
        async execute({ limit }) {
          const result =
            await $`sqlite3 ${projectDir}/db.sqlite3 "SELECT name, datetime(first_applied) FROM django_migrations ORDER BY id DESC LIMIT ${limit};"`.quiet();
          return result.stdout.toString().trim() || 'No migration history found.';
        },
      }),
    },
  };
};
```

### Step 2: Install Dependencies

Ensure `@opencode-ai/plugin` is in your dependencies:

```bash
npm install @opencode-ai/plugin
```

### Step 3: Use the Plugin

The plugin will be automatically loaded by OpenCode when placed in `.opencode/plugin/`. The LLM can now use:

```bash
/db_migration_create --name add_user_email_index
/db_migration_status
/db_migration_apply
/db_migration_history --limit 20
```

---

## Best Practices

### 1. Error Handling

Always handle errors gracefully and provide helpful messages:

```typescript
async execute({ param }) {
  try {
    const result = await $`command ${param}`.nothrow();
    if (result.exitCode !== 0) {
      return `Error: ${result.stderr.toString() || 'Command failed'}`;
    }
    return result.stdout.toString().trim();
  } catch (error) {
    return `Failed to execute command: ${error.message}`;
  }
}
```

### 2. Security Considerations

- Validate all inputs to prevent command injection
- Use parameterized commands when possible
- Implement path traversal protection for file operations
- Sanitize output before returning to the LLM

```typescript
// Secure file path handling
const safePath = path.normalize(userPath).replace(/^\.\./, '');
if (!safePath.startsWith(projectDir)) {
  return 'Error: Access denied';
}
```

### 3. Performance Optimization

- Cache expensive operations when possible
- Use `--quiet` flag to reduce shell output
- Implement lazy loading for large datasets

```typescript
let cache: string | null = null;

async getCachedData() {
  if (!cache) {
    cache = await fetchData();
  }
  return cache;
}
```

### 4. Context Management

- Use `session.created` to initialize state
- Use `session.compacting` to preserve critical information
- Clear cache on session reset

```typescript
export const MyPlugin: Plugin = async ({ $ }) => {
  let sessionState: any = null;

  return {
    event: async ({ event }) => {
      if (event.type === 'session.created') {
        sessionState = await initializeState();
      }
    },
    'experimental.session.compacting': async (_input, output) => {
      // Save important state before compaction
      output.context.push(`<saved-state>${JSON.stringify(sessionState)}</saved-state>`);
    },
  };
};
```

### 5. Testing Your Plugin

```bash
# Test plugin loading
opencode --help

# Check if tools are registered
opencode run "List available tools"  # Should show your new tools

# Manual testing
cd .opencode/plugin && npx tsc --noEmit  # Type check
```

---

## Troubleshooting

### Plugin Not Loading

1. Check file location: must be in `.opencode/plugin/`
2. Verify TypeScript compilation: `npm run build`
3. Check plugin syntax: `node -c .opencode/plugin/your-plugin.ts`
4. Review OpenCode logs for errors

### Tool Not Appearing to LLM

1. Ensure tool description is clear and comprehensive
2. Check tool name follows snake_case convention
3. Verify tool schema has all required fields
4. Restart OpenCode session after plugin changes

### Performance Issues

1. Add caching for expensive operations
2. Use `--quiet` flag on shell commands
3. Implement pagination for large results
4. Consider async loading for heavy computations

---

## References

- **OpenCode Plugin API**: `@opencode-ai/plugin` package documentation
- **UAP Implementation**: See `.opencode/plugin/` in this repository for examples
- **Tool Schema Reference**: Check `uap-commands.ts` for tool definition patterns
- **Hook Examples**: See `uap-session-hooks.ts` and `uap-pattern-rag.ts`

---

**Last Updated:** 2026-03-17  
**Version:** 1.0.0
