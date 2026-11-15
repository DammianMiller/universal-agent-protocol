# P45: Superpowers Programming Methodology

**Category**: Programming
**Abbreviation**: Superpowers

**Provenance**: obra/superpowers (the widely-adopted agentic engineering
methodology), installed user-level at `~/.agents/skills/superpowers/`
(15 skills), wired into the router 2026-11-15. These skills are the
methodology layer; UAP's own gates (worktree, build, P12 output existence,
P35 decoder-first) stay the enforcement layer and win on conflict.

## Pattern

Match the phase. Exploring a problem → `brainstorming` (one option at a
time, the user picks). Planning → `writing-plans` then `executing-plans`
(bite-sized, verifiable tasks). Implementing → `test-driven-development`
(red-green-refactor, commit on green). Stuck → `systematic-debugging`
(reproduce, isolate, root cause before any fix — never fix symptoms).
Wrapping up → `verification-before-completion` (evidence, not vibes), then
`requesting-code-review` / `receiving-code-review` and
`finishing-a-development-branch`. Larger work → `subagent-driven-development`
and `dispatching-parallel-agents`; `using-git-worktrees` aligns with the UAP
worktree gate (isolation before edits). `using-superpowers` and
`diagnosing-superpowers` are the meta entry points. In Droid activate by
exact name (Skill tool); otherwise read the SKILL.md paths above.
