# Policies Module

The policies module provides policy enforcement, audit trails, and compliance gates for AI agent operations.

## Architecture

```
+-------------------------------------------------------------------+
|  Policy Store (SQLite)                                            |
|  - Policies table with CRUD operations                            |
|  - Audit trail for all enforcement actions                        |
|  - Tag/category filtering                                         |
+-------------------------------------------------------------------+
                          |
                          v
+-------------------------------------------------------------------+
|  Policy Gate (Middleware)                                         |
|  - Blocks REQUIRED level violations                               |
|  - Logs RECOMMENDED level actions                                 |
|  - OPTIONAL level informational only                              |
+-------------------------------------------------------------------+
                          |
                          v
+-------------------------------------------------------------------+
|  Enforced Tool Router                                             |
|  - Single entry point for policy-checked tool calls               |
|  - Python enforcement tools                                       |
+-------------------------------------------------------------------+
```

## Components (8 files)

### Core Policy System

| Component        | File                  | Purpose                                        |
| ---------------- | --------------------- | ---------------------------------------------- |
| Policy Schema    | `schemas/policy.ts`   | Zod schemas for policies and executions        |
| Database Manager | `database-manager.ts` | SQLite with WAL, JSON serialization            |
| Policy Memory    | `policy-memory.ts`    | CRUD, relevance search, tag/category filtering |
| Policy Tools     | `policy-tools.ts`     | Store/execute Python enforcement tools         |

### Enforcement & Compliance

| Component            | File                          | Purpose                                          |
| -------------------- | ----------------------------- | ------------------------------------------------ |
| Policy Gate          | `policy-gate.ts`              | Middleware: blocks REQUIRED violations           |
| Enforced Tool Router | `enforced-tool-router.ts`     | Single entry point for policy-checked tool calls |
| Policy Converter     | `convert-policy-to-claude.ts` | Markdown to CLAUDE.md format                     |

## Enforcement Levels

| Level       | Behavior                                        |
| ----------- | ----------------------------------------------- |
| REQUIRED    | Blocks execution, throws `PolicyViolationError` |
| RECOMMENDED | Logged but does not block                       |
| OPTIONAL    | Informational only                              |

## Usage Examples

```typescript
import { getPolicyMemory, PolicyGate } from '@miller-tech/uap';

const policy = getPolicyMemory();

// Add a new policy
await policy.add({
  title: 'Security Review Required',
  content: 'All authentication changes require security review',
  level: 'REQUIRED',
  tags: ['security', 'authentication'],
});

// Check if operation is allowed
const gate = new PolicyGate();
const allowed = await gate.check('edit-file', { path: 'src/auth/' });
if (!allowed) {
  throw new PolicyViolationError('Security policy violation');
}
```

## CLI Commands (15 subcommands)

```bash
uap policy list                    # List all policies
uap policy install <name>          # Install built-in policy
uap policy enable <id>             # Enable a policy
uap policy disable <id>            # Disable a policy
uap policy status                  # Enforcement status
uap policy add -f <file>           # Add from markdown
uap policy convert -i <id>         # Convert to CLAUDE.md format
uap policy get-relevant -t <task>  # Find relevant policies
uap policy add-tool -p <id> -t <name> -c <file>  # Add Python tool
uap policy check -o <operation>    # Check if allowed
uap policy audit                   # View audit trail
uap policy toggle <id>             # Toggle on/off
uap policy stage <id> -s <stage>   # Set enforcement stage
uap policy level <id> -l <level>   # Set enforcement level
```

## Audit Trail

All policy actions are logged with:

- Timestamp
- Policy ID
- Action type (check, enforce, modify)
- Result (allowed/blocked)
- Violation details (if applicable)

## See Also

- [Policy Enforcement](../../docs/reference/FEATURES.md#policy-enforcement)
- [Completion Gates](../../AGENTS.md#completion-gates-mandatory)
- [Pre-Edit Build Gate](../../AGENTS.md#pre-edit-build-gate-required-ts-files-only)
