# P25: Service Configuration Pipeline

**Category**: DevOps
**Abbreviation**: Service-Config

## Pattern

For service configuration changes, follow the full pipeline: modify config → validate → reload → verify.

## Rule

```
Config change → Validate syntax → Reload service → Verify running.
```

## Implementation

1. Modify configuration file
2. Validate syntax before applying
3. Reload/restart service
4. Verify service is running correctly
5. Check logs for errors

## Configuration Pipeline

```bash
# 1. Modify config
vim /etc/service/config.conf

# 2. Validate
service configtest  # or equivalent

# 3. Reload
systemctl reload service

# 4. Verify
systemctl status service
journalctl -u service -n 20
```

## Validation Commands

- Nginx: `nginx -t`
- Apache: `apachectl configtest`
- Systemd: `systemd-analyze verify`
- HAProxy: `haproxy -c -f /etc/haproxy/haproxy.cfg`

## Anti-Pattern

❌ Modifying config and reloading without validation
❌ Assuming reload succeeded without checking status
❌ Not checking logs after configuration change
