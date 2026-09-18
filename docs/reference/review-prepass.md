# Review Pre-Pass

Deterministic ruleset scanner that runs **before** the LLM reviewers in the
parallel review protocol — item 0.2 of the
[System-1 uplift plan](../plans/system1-uplift-2026-09-18.md), after the
open-code-review precedent (deterministic rule pipelines first, LLM agent
second).

## Running

```bash
uap review prepass              # scan changed files vs upstream base
uap review prepass --files src/a.ts,src/b.py
uap review prepass --write      # merge findings into the review artifact
uap review prepass --json
```

Exit code is 1 when any HIGH finding fires (advisory — blocking stays with
the `expert-review-required` enforcer), so CI and scripts can gate on it.

## What it catches

High-precision, line-anchored rules — the bar is "almost always worth a
reviewer's glance," because a scanner that cries wolf teaches reviewers to
ignore it:

| Category | Rules |
| --- | --- |
| secrets | AWS access key ids, private key blocks, secret-named string literals, GitHub/Slack/LLM-provider/npm token prefixes, JWTs |
| injection | `eval(`, `new Function(`, interpolated or concatenated `exec`, `shell=True`, `innerHTML =` / `dangerouslySetInnerHTML` / `document.write` / `insertAdjacentHTML`, CORS wildcards (header and middleware forms) |
| sql | template interpolation or string concatenation building SQL |
| error-handling | empty `catch` (single- and multi-line forms), Python `except: pass` (single- and two-line forms) |
| concurrency | Python `threading.Thread` with no `Lock` in the file |

Secret rules scan every file type (prose leaks keys too); code rules only
fire on source extensions. Ambiguous heuristics deliberately stay with the
LLM reviewers — this pass owns pattern-matching, not judgment.

**Secrets findings are redacted**: the snippet in the artifact and on stdout
replaces the matched secret with `***redacted***`, because the artifact's
purpose is inclusion in LLM reviewer prompts — the scanner must not multiply
copies of what it detects. The file:line anchor is enough to inspect the
secret in place.

## Review protocol integration

The `parallel-expert-review` skill runs `uap review prepass --write` as step
0. Findings are written to `.uap/reviews/<branch-slug>.pre-pass.json` — a
**sibling** of the review artifact, never `<branch-slug>.json` itself, because
the expert-review enforcer treats that file's existence as "a review
happened". Writes are atomic (tmp + rename), and the slug encoding matches the
enforcer's `slug_for` exactly. At consolidation the reviewers' verdict merges
the pre-pass findings into the real artifact; every reviewer receives the
pre-filtered findings in its prompt scope and must say so explicitly when
dismissing one.

## Decisions

- **`src/review` vs reusing `src/quality/scanner.ts`:** the quality scanner is
  a pure, I/O-free *metrics* scanner (complexity/CRAP/LOC) consumed by the
  quality gate; the pre-pass is a security-*pattern* ruleset with git I/O
  consumed by the review protocol. Different consumers and failure modes.
- **Sibling artifact, not a `pre_pass` block in the enforcer's file:** the
  enforcer's checks are all conditional on keys the pre-pass never writes, so
  co-locating would let an advisory pass satisfy the blocking gate. (Found in
  parallel review of the introducing PR.)
- **Advisory exit code, blocking left to the enforcer:** HIGH findings exit 1
  for CI/scripts, but the pre-pass itself never blocks a ship action.
- **Slug encoding duplicated across TS/Python:** `branchSlug()` mirrors
  `slug_for()` byte-for-byte and is pinned by a cross-checking test.

## Proven on day one

The first dogfood scan of this repo's own CLI found a real command-injection
path (`uap worktree create <slug>` interpolating the argument into a shell
string) — fixed in the same change that introduced the scanner. Remaining
interpolated-`execSync` call sites are ticketed for a follow-up sweep.
