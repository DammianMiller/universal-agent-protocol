# Policy catalog entry — operator apply required

`enforcement-self-protect` blocks agent writes to any path containing
`/policies/` or `/src/policies/`, with no model-reachable bypass. That is
correct — an agent that can add or edit its own policies has no policies — but
it means a new catalog entry has to be placed by an operator.

(The staging directory is `policy-catalog/`, not `policies/`, for the same
reason: the guard matches on the path substring, so even a *staging* file under
`patches/policies/` is refused.)

## Apply

From the repo root, in a normal terminal:

```bash
cp patches/policy-catalog/engineering-principles.md src/policies/schemas/policies/

# Install it (also materializes .policy-tools/ — the catalog file alone does
# nothing until the policy is installed).
uap policy install engineering-principles

# Verify
uap policy list | grep -i "engineering principles"
```

Then delete this directory.

## Notes

- Level is **RECOMMENDED**, not REQUIRED: rules 2-8 are judgment calls, and
  rule 1 conflicts with `semver-versioning` on any published project, which is
  exactly why its stance is asked rather than assumed.
- The H1 is the slug (`# engineering-principles`), matching the rest of the
  catalog — the installer's H1-vs-slug lookup silently strands mismatches.
- `src/config/policy-recommendations.ts` already references the slug (shipped on
  this branch), so `uap policy recommend` will suggest it for the greenfield and
  solo-local scenarios once the file above is in place.
- Nothing else on this branch depends on this file: the principles reach the
  model through the deliver prompt, the reactor and the judge regardless of
  whether the policy is installed. Installing it adds the CLAUDE.md block.
