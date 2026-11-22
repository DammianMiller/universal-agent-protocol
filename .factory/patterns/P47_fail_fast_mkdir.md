# P47: Fail-Fast mkdir in Fail-Soft Paths

**Category**: Reliability
**Abbreviation**: FF-Mkdir

## Pattern

Node's `fs.mkdirSync(path, { recursive: true })` NEVER RETURNS on pseudo-fs
roots (observed: `/proc/*`, node 24.19.0 / kernel 7.3.0 — 99% CPU forever, no
throw, ~16MB read over 98 minutes). A `try/catch` fail-soft wrapper around it
never fires because the call never throws — the fail-soft path becomes a
wedge. Any mkdir whose target root is not provably process-owned must fail
FAST instead.

## Rule

```
Inside a try/catch that is supposed to swallow errors, never use
recursive mkdir. Guard with existsSync and use the non-recursive call:
it throws in microseconds on any unwritable root.
```

## Implementation

```typescript
// BAD — spins forever on /proc-class roots; the catch never runs:
try {
  mkdirSync(join(root, '.uap'), { recursive: true });
  writeFileSync(stateFile, data);
} catch { /* fail soft */ }

// GOOD — fails fast (ENOENT/EACCES/EPERM in microseconds), catch runs:
try {
  const dir = join(root, '.uap');
  if (!existsSync(dir)) mkdirSync(dir);      // NOT recursive
  writeFileSync(stateFile, data);
} catch { /* fail soft */ }
```

The tripwire: a test that exercises the unwritable-root path — if the
guarded call ever regresses to recursive, the test's timeout (not an
assertion) catches it. Cover both fast-fail classes: a pseudo-fs root
(ENOENT) and a chmod-0500 real-fs root (EACCES).

## Audit state (2026-11-22, 59 recursive sites in src/)

- **Fail-soft paths**: fixed (`writePendingReplayOutcome`,
  v2.71.0) — was the live wedge.
- **Project-derived roots** (cwd/`.uap`, `.codex`, process-created tmpdirs):
  safe in practice — a project root on a pseudo-fs is not a real deployment.
- **Operator-configurable absolute roots** (memory `dbPath`, snapshot base,
  `bench --out`): residual, documented exposure — real-fs operators only;
  a `/proc` value here would hang that command. Prefer the guarded pattern
  when touching these.

## Examples

- An observability aid writes state under a caller-supplied root → guarded
  non-recursive mkdir (pending-intents, v2.71.0)
- A cache/state writer that "must never fail the mission" wraps mkdir in
  try/catch → same pattern applies
- A CLI creating dirs under its own project root → recursive is fine
