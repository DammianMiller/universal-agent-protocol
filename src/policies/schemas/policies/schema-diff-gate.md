# schema-diff-gate

**Category**: infrastructure
**Level**: REQUIRED
**Enforcement Stage**: pre-exec
**Tags**: postgres, cnpg, pgdog, migrations, schema, spock, redis

## Rule

Changes to DB schema, connection pooler config, or replication topology MUST pass `uap schema-diff` before commit:

- `migrations/**/*.sql`
- `infra/postgres-spock/**`
- `infra/helm_charts/**/pgdog*`
- CNPG `Cluster` spec (pool sizes, instance count, connection limits)
- Redis Sentinel / Envoy HA-write proxy configs

## Why

Branch `fix/zitadel-pgdog-capacity-v2` exists because a prior capacity change escaped review. PgDog connection limits cascade into Zitadel auth outages. Pre-commit gating prevents "v2 hotfix" cycles.

## Enforcement

Python enforcer `schema_diff_gate.py` runs `uap schema-diff` (or checks recent successful run in memory ≤1h) when the diff touches the listed paths.

```rules
- title: "Schema/capacity changes must pass schema-diff"
  keywords: [migration, schema, pgdog, cnpg, spock, postgres, redis, sentinel, envoy, pool]
  antiPatterns: [ALTER TABLE, max_connections, pool_size, instances:, replicas:]
```
