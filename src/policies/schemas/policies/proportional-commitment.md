# proportional-commitment

**Category**: custom
**Level**: RECOMMENDED
**Enforcement Stage**: pre-exec
**Tags**: judgment, proportionality, restraint

## Rule

Effort and blast radius must scale with the task. Commit hard to an approach,
but never commit **everything** -- always hold a reserve of judgment and a way
back:

1. **Smallest viable intervention first.** Do not rewrite a whole file when an
   edit suffices; do not restructure a module to fix a line; do not regenerate
   what can be patched.
2. **No orchestration for small work.** Do not spawn subagents, decompose into
   epics, or fan out parallel workers for a task whose diff is small. The
   overhead must be justified by the work, not by enthusiasm.
3. **No destructive reset as a first resort.** `git reset --hard`, `rm -rf`,
   force-push, and wholesale overwrites are last resorts taken only after the
   incremental path has demonstrably failed -- and only with a backup or branch
   point held in reserve.
4. **Keep one alternative alive.** Before committing to any expensive path
   (long build, large refactor, multi-agent run), be able to state the fallback
   you will use if it fails. If there is no fallback, the commitment is too big.
5. **Stop doubling down.** If the same approach has failed twice, the third
   attempt must be a different approach, not a louder version of the same one.

## Why

Total commitment is a trap: an agent that goes all-in on one approach, one
rewrite, or one orchestration pattern surrenders the judgment needed to step
back out ("hold something back" -- the Tropic Thunder rule). Every major
incident in this project's history is a full-commitment failure: thousands of
identical subagent spawns, real implementation files deleted into stubs,
monolithic sessions overflowing their context window, gates saturated until
the remedy for a blocked action was itself blocked. Proportional commitment
keeps the recovery path open.
