# Coordination Module

The coordination module enables multi-agent collaboration through agent lifecycle management, work claims, messaging, and deploy batching.

## Architecture

```
Agent A                    Agent B                    Agent C
   |                          |                          |
[Register] -> [Heartbeat 30s] -> [Announce: src/auth/]
   |                          |                          |
[Overlap Check] ---------> [Overlap Check] ---------> [Overlap Check]
   |                          |                          |
[Worktree: 001-auth]    [Worktree: 002-api]      [Worktree: 003-ui]
   |                          |                          |
[Queue deploy] ----------> [Deploy Batcher] -------> [Squash & Execute]
```

## Components (6 files)

### Core Coordination

| Component             | File                   | Purpose                                                  |
| --------------------- | ---------------------- | -------------------------------------------------------- |
| Coordination Service  | `service.ts`           | Agent lifecycle, work claims, announcements, messaging   |
| Coordination Database | `database.ts`          | SQLite with WAL: agents, claims, announcements, messages |
| Capability Router     | `capability-router.ts` | Routes tasks to droids by 18 capability types            |
| Auto-Agent            | `auto-agent.ts`        | Automatic registration, heartbeat, graceful shutdown     |

### Pattern & Deploy Management

| Component         | File                   | Purpose                                                        |
| ----------------- | ---------------------- | -------------------------------------------------------------- |
| Pattern Router    | `pattern-router.ts`    | Loads Terminal-Bench patterns, critical patterns always active |
| Deploy Batcher    | `deploy-batcher.ts`    | Squash, merge, parallelize deploy actions                      |
| Adaptive Patterns | `adaptive-patterns.ts` | Pattern success tracking with SQLite persistence               |

## Messaging System

- **Broadcast** -- all agents
- **Direct** -- specific agent
- **Channels** -- broadcast, deploy, review, coordination
- **Priority** -- normal, high, urgent
- **Read receipts** -- delivery confirmation

## Deploy Batching Windows

| Action   | Default | Urgent |
| -------- | ------- | ------ |
| commit   | 30s     | 3s     |
| push     | 5s      | 1s     |
| merge    | 10s     | 2s     |
| workflow | 5s      | 1s     |
| deploy   | 60s     | 5s     |

## Usage Examples

```typescript
import { getCoordinationService } from '@miller-tech/uap';

const coordination = getCoordinationService();

// Register agent
await coordination.register({ name: 'code-reviewer', capabilities: ['review', 'security'] });

// Announce work intent
await coordination.announce({
  intentType: 'editing',
  resource: 'src/auth/',
  description: 'Implement OAuth2 authentication',
});

// Check for overlaps
const overlaps = await coordination.checkOverlaps('src/auth/');
```

## Database Schema

### Tables

- `agent_registry` - Active agents with status and heartbeat
- `agent_messages` - Inter-agent communication
- `work_announcements` - Informational work intents
- `work_claims` - Exclusive/shared resource claims
- `deploy_queue` - CI/CD batching queue
- `deploy_batches` - Batch tracking and results

## Configuration

```typescript
interface CoordinationConfig {
  heartbeatInterval: number; // Default: 30000ms
  claimExpiry: number; // Default: 300000ms
  staleAgentCutoff: number; // Default: 3x heartbeat
  messageRetention: number; // Default: 24 hours
}
```

## See Also

- [Multi-Agent Coordination](../../docs/reference/FEATURES.md#multi-agent-coordination)
- [Deploy Batching](../../docs/deployment/DEPLOY_BATCHING.md)
- [Pattern System](../../docs/reference/PATTERN_LIBRARY.md)
