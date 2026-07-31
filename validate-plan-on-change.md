# Validate Plan On Change

## Rule

The plan gate fires **BEFORE** a build, not on the plan write.

## Behavior

### Plan Writes (Write / Edit)

- Creating or editing a plan artifact is **always allowed**.
- The write records the plan file as **pending** in `.uap/plan_state.json`.

### Build / Deploy / Execute Commands (Bash)

- A build command is **blocked** while any plan is pending.
- A build command is **blocked** if a validated plan has drifted on disk (content hash mismatch).
- A build command is **allowed** when there are no pending plans and no drift.
- Non-build commands (tests, linters, reads) are always allowed.

### State File

State is stored in `.uap/plan_state.json`:

```json
{
  "pending": {
    "<repo-relative path>": <epoch timestamp>
  },
  "validated": {
    "<repo-relative path>": "<sha256 of the reviewed bytes>"
  }
}
```

### Escape Hatch

Set `UAP_PLAN_VALIDATE_OFF=1` in the environment to bypass all plan validation checks.

### Self-Prompt

When a build is blocked, the refusal message carries the inject prompt: **validate the plan**.

## Plan Artifact Patterns

Plan files are identified by these path prefixes:

- `docs/plans/`
- `plans/`
- `.uap/plans/`

## Build Command Patterns

The following command prefixes trigger the gate:

- `npm run build`
- `make`
- `cargo build`
- `go build`
- `docker build`
- `terraform apply`
- `kubectl apply`
- `uap deliver`

Quoted substrings are stripped before matching to avoid false positives.