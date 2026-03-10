# UAP Memory Schema

> Loaded every session alongside working memory. Teaches the agent how the memory system works.

## Memory Tiers

| Tier | Storage | Latency | Loaded |
|------|---------|---------|--------|
| L1 Working | SQLite `memories` | <1ms | Always (last 50) |
| L2 Session | SQLite `session_memories` | <5ms | Current session |
| L3 Semantic | Qdrant vectors | ~50ms | On-demand search |
| L4 Graph | SQLite `entities`/`relationships` | <20ms | On-demand |
| Daily Log | SQLite `daily_log` | <1ms | Today + yesterday |

## Write Rules

**Write Gate**: Before storing anything, it must pass at least one criterion:
1. Changes future behavior (preference, boundary, recurring pattern)
2. Commitment with consequences (deadline, deliverable, follow-up)
3. Decision with rationale (why X over Y)
4. Stable recurring fact (not transient, will matter again)
5. Explicit "remember this" request

**Default destination**: Daily log first. Promote to permanent memory later.

**Never**: silently overwrite. Mark old entries `[superseded]` with date and reason.

## Read Rules

- Working memory and this schema are always loaded
- Daily log checked for today and yesterday
- Registers/semantic memory searched on demand when topic is relevant
- Use `uap memory query` for anything older

## When to Write

| Trigger | Destination |
|---------|-------------|
| User says "remember" | Daily log + maybe working memory |
| User corrects you | Supersede old + write corrected across all tiers |
| Decision with rationale | Daily log, promote if durable |
| Preference expressed | Daily log, promote to working memory |
| Commitment/deadline | Daily log + working memory |
| Debugging details | **DISCARD** |
| Transient state | **DISCARD** |
| Acknowledgments | **DISCARD** |

## Correction Protocol

When corrected: (1) find original, (2) mark superseded with reason, (3) write corrected version to daily log + working memory + semantic memory, (4) verify next session.

## Maintenance

- Memories decay: `effective_importance = importance * (0.95 ^ days_since_access)`
- Consolidation triggers every 10 new entries
- Stale entries (>14 days unaccessed) auto-demote from hot to warm tier
- Run `uap memory maintain` periodically for health checks
