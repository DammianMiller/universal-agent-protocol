# P45: Superpowers Programming Methodology

**Category**: Programming
**Abbreviation**: Superpowers

## When to use

Any code-writing task: implement a feature, write the tests first, debug a
failing test, refactor a module, review code before merging, plan an
implementation, or run a larger build with subagents.

## Pattern

Match the phase. Explore → `brainstorming`. Plan → `writing-plans`, then
`executing-plans` in bite-sized verifiable tasks. Implement →
`test-driven-development` (red, green, refactor; commit on green). Stuck →
`systematic-debugging`: reproduce, isolate, find the root cause before any
fix — never fix symptoms. Wrap up → `verification-before-completion`
(evidence, not vibes), then `requesting-code-review` /
`receiving-code-review` and `finishing-a-development-branch`. Larger work →
`subagent-driven-development`, `dispatching-parallel-agents`;
`using-git-worktrees` matches the UAP worktree gate (isolation before
edits). Meta entry points: `using-superpowers`, `diagnosing-superpowers`.
In Droid activate by exact name (Skill tool); elsewhere read the SKILL.md.

**Provenance**: obra/superpowers (15 skills) at `~/.agents/skills/superpowers/`;
router-wired 2026-11-15. Methodology layer only — UAP's own gates (worktree,
build, P12 output existence, P35 decoder-first) stay the enforcement layer
and win on conflict.
