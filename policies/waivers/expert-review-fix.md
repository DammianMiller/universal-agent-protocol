# Waiver: expert-review-required (temporary, feature-branch only)

**Scope:** branch `fix/expert-review-usable` only.
**Reason:** This branch *fixes* the expert-review-required deadlock — its own
escape hatches (review artifact, file waiver, named skill, env override) were all
unreachable by an agent, blocking every commit/push/PR. This waiver lets the fix
itself be committed. It is the policy's designed committable bypass
(`policies/waivers/*expert-review*.md`).

**MUST be removed before merge to master** — a committed waiver here would waive
expert-review repo-wide. The final pre-PR step replaces it with a real
`.uap/reviews/<slug>.json` artifact produced by the (now-fixed) parallel-expert-review
flow.
