# P28: Service Smoke Test

**Category**: Verification
**Abbreviation**: Smoke-Test

## Pattern

After deploying or starting a service, run a basic smoke test to verify it's functional.

## Rule

```
Service started → Smoke test → Verify response.
```

## Implementation

1. Start/deploy service
2. Wait for ready state
3. Send basic request
4. Verify response

## Smoke Test Commands

```bash
# HTTP service
curl -s http://localhost:8080/health | jq

# Database
pg_isready -h localhost -p 5432

# gRPC
grpc_health_probe -addr=localhost:9090

# Generic process check
ps aux | grep service-name
```

## Smoke Test Criteria

- Service responds to basic request
- Response has expected format
- No errors in logs
- Process is running

## Anti-Pattern

❌ Starting service and assuming it works
❌ Skipping smoke test "to save time"
❌ Checking only that process is running (not functionality)
