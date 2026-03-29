# P28: Service Smoke Test

**Category**: Verification
**Abbreviation**: Smoke-Test

## Pattern

After deploying or starting a service, run a basic smoke test to verify it's functional.

## Rule

```
Service started → Smoke test → Verify response.
```

## Smoke Test Commands

```bash
# Proxy-first coding-agent service
curl -s http://localhost:4000/health | jq

# Raw llama.cpp service
curl -s http://localhost:8080/health | jq

# Database
pg_isready -h localhost -p 5432
```
