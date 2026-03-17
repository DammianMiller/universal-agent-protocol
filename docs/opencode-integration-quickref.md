# OpenCode Integration Quick Reference

## File Structure

```
.project/
├── .opencode/
│   ├── plugin/
│   │   ├── your-plugin.ts          # Your custom plugin
│   │   └── index.ts                # Optional: aggregate exports
│   └── package.json                # Dependencies (add @opencode-ai/plugin)
└── opencode.json                   # OpenCode configuration
```

## Plugin Template

```typescript
import type { Plugin } from '@opencode-ai/plugin';
import { tool } from '@opencode-ai/plugin';

export const MyPlugin: Plugin = async ({ $, directory }) => {
  return {
    // Define tools
    tool: {
      my_tool: tool({
        description: 'What this tool does',
        args: {
          param: tool.schema.string().describe('Parameter'),
        },
        async execute({ param }) {
          const result = await $`command ${param}`;
          return result.stdout.toString();
        },
      }),
    },

    // Optional: Event hooks
    event: async ({ event }) => {
      if (event.type === 'session.created') {
        console.log('Session started');
      }
    },
  };
};
```

## Available Hooks

| Hook                                 | Purpose                    | Example                        |
| ------------------------------------ | -------------------------- | ------------------------------ |
| `tool`                               | Define new tools           | Custom commands for LLM        |
| `event.session.created`              | Session initialization     | Load context, initialize state |
| `event.session.compacting`           | Before context compression | Preserve important data        |
| `tool.execute.before`                | Before tool runs           | Validate args, log activity    |
| `tool.execute.after`                 | After tool completes       | Record results, update state   |
| `tool.definition`                    | Modify tool descriptions   | Add policy constraints         |
| `experimental.chat.system.transform` | Inject system context      | RAG retrieval, dynamic context |
| `middleware`                         | Transform messages         | Pre/post processing            |

## Tool Schema Types

```typescript
// String
tool.schema.string().describe('Text parameter');

// Number with constraints
tool.schema.number().min(0).max(100).default(50);

// Enum
tool.schema.enum(['read', 'write', 'execute']).default('read');

// Array
tool.schema.array().of(tool.schema.string());

// Optional
tool.schema.string().optional();
```

## Common Patterns

### 1. CLI Wrapper

```typescript
tool({
  description: 'Run external command',
  args: { cmd: tool.schema.string() },
  async execute({ cmd }) {
    return (await $`${cmd}`.quiet()).stdout.toString();
  },
});
```

### 2. File Operations

```typescript
import { readFile, writeFile } from 'fs/promises';

tool({
  description: 'Read project file',
  args: { path: tool.schema.string() },
  async execute({ path }) {
    return await readFile(join(projectDir, path), 'utf-8');
  },
});
```

### 3. Memory Query

```typescript
tool({
  description: 'Query persistent memory',
  args: { query: tool.schema.string() },
  async execute({ query }) {
    const result = await $`python3 ./scripts/query.py "${query}"`;
    return result.stdout.toString().trim();
  },
});
```

### 4. Context Injection (RAG)

```typescript
middleware: async (input, next) => {
  const lastMsg = input.messages?.[input.messages.length - 1];
  if (lastMsg?.role === 'user') {
    const context = await queryRAG(lastMsg.content);
    input.messages.push({ role: 'system', content: `<context>${context}</context>` });
  }
  return next(input);
};
```

## Plugin Examples in This Repo

| Plugin          | File                                      | Purpose                       |
| --------------- | ----------------------------------------- | ----------------------------- |
| Commands        | `.opencode/plugin/uap-commands.ts`        | CLI commands as tools         |
| Skills          | `.opencode/plugin/uap-skills.ts`          | Skill loading system          |
| Droids          | `.opencode/plugin/uap-droids.ts`          | Specialized agent droids      |
| Pattern RAG     | `.opencode/plugin/uap-pattern-rag.ts`     | On-demand pattern retrieval   |
| Task Completion | `.opencode/plugin/uap-task-completion.ts` | Track task outcomes           |
| Session Hooks   | `.opencode/plugin/uap-session-hooks.ts`   | Session lifecycle events      |
| Enforcement     | `tools/agents/plugins/uap-enforce.ts`     | Loop detection, budget limits |

## Dependencies

```json
{
  "dependencies": {
    "@opencode-ai/plugin": "1.2.16"
  }
}
```

## Debugging

```bash
# Check plugin loads
opencode run "What tools are available?"

# View logs
tail -f ~/.opencode/logs/*.log

# Test TypeScript syntax
npx tsc --noEmit .opencode/plugin/your-plugin.ts
```

## Best Practices

1. **Error Handling**: Always use `.nothrow()` and check exit codes
2. **Security**: Validate inputs, prevent command injection
3. **Caching**: Cache expensive operations between tool calls
4. **Descriptions**: Write clear, comprehensive tool descriptions
5. **Naming**: Use snake_case, prefix with domain (`mydomain_tool`)
6. **Context**: Preserve important state across compaction
7. **Performance**: Use `--quiet` to reduce output noise

## Full Example

See: `.opencode/plugin/uap-commands.ts` for a complete implementation example.
