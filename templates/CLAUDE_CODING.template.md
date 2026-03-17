# Coding Standards Template

**Version**: 1.0.0
**Last Updated**: {{STRUCTURE_DATE}}

---

## Core Principles

1. **State assumptions** before writing code
2. **Verify correctness** -- do not claim it
3. **Handle error paths**, not just the happy path
4. **Do not import complexity** you do not need
5. **Produce code you would want to debug at 3am**

---

## Pre-Commit Checklist

- [ ] Functions <= 30 lines
- [ ] Self-documenting names
- [ ] Error paths handled explicitly
- [ ] No debug prints or commented-out code
- [ ] Consistent with surrounding code style
- [ ] No hardcoded values that should be constants
- [ ] Imports are minimal

---

{{#if HAS_MULTI_TENANCY}}

## Multi-Tenancy

All database queries must include organization scope.

### Correct Patterns

```sql
-- ✅ Organization-scoped query
SELECT * FROM products WHERE owner_id = $1;
```

### Incorrect Patterns

```sql
-- ❌ Cross-tenant access
SELECT * FROM products;
```

{{/if}}

---

## Security

### Secrets

Never hardcode secrets. Use environment variables.

```typescript
// ✅ Correct
const dbPassword = process.env.DB_PASSWORD;

// ❌ Wrong
const dbPassword = 'hardcoded_password';
```

### Input Validation

Always validate and sanitize inputs.

```typescript
// ✅ Parameterized queries
db.query('SELECT * FROM users WHERE id = $1', [userId]);
```

---

## Error Handling

Log with context for debugging.

```typescript
// ✅ Correct
logger.error('Failed to fetch', {
  error: error.message,
  correlationId: req.id,
});
```

---

## Testing

### Running Tests

```bash
{{TEST_COMMAND}}
```

---

## Code Quality Tools

```bash
{{LINT_COMMAND}}
```

---

## Naming Conventions

| Type      | Convention           | Example           |
| --------- | -------------------- | ----------------- |
| Variables | camelCase            | `userName`        |
| Constants | SCREAMING_SNAKE_CASE | `MAX_RETRY_COUNT` |
| Functions | camelCase            | `getUserById`     |
| Classes   | PascalCase           | `UserService`     |
| Files     | kebab-case           | `user-service.ts` |
| Database  | snake_case           | `user_accounts`   |

---

## See Also

- `CLAUDE_WORKFLOWS.md` - Task workflows and testing
- `.factory/skills/code-reviewer/` - Code review checklists (if applicable)
