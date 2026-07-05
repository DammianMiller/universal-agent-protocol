# bearer-lockdown

**Category**: security
**Level**: REQUIRED
**Enforcement Stage**: pre-exec
**Tags**: auth, cookie-only, bearer, security, write-gate

## Rule

Write/Edit tool calls MUST NOT reintroduce any cookie-only-frontend
(ADR-0007-style) invariant violation: frontend code setting
`Authorization: Bearer`, token keys in `localStorage`/`sessionStorage`,
`--skip-jwt-bearer-tokens=true` on oauth2-proxy, backend reading the client
`Authorization` header, `/auth/me` emitting a raw user id instead of an opaque
ref, or a committed RS256 JWT. Violating writes are **blocked** at tool-call
time.

## Why

A cookie-only auth architecture is one careless write away from regression,
and CI-time scanning catches it only after the agent has already built on top
of the mistake. Gating at write time prevents the regression from ever
entering the tree. Mirrors the originating project's bearer-lockdown CI scan.

## Enforcement

Python enforcer `bearer_lockdown.py` applies per-invariant regex checks scoped
by path (frontend trees, infra, backend). Path prefixes default to the
originating project's layout (`apps/web/`, `apps/cms/`, `apps/marketing/`,
`apps/api/`, `infra/`) — adjust the `path_include`/`path_exclude` tuples when
installing into a differently-shaped repo. Runtime-only invariants (e.g.
"Istio DENY policy alive") stay with cluster tooling, not this gate.

```rules
- title: "No write may reintroduce a bearer-token/cookie-only-frontend regression"
  keywords: [write, edit, authorization, bearer, localStorage, jwt, oauth2-proxy]
  antiPatterns: ["Authorization: Bearer in frontend code", "token in localStorage"]
```
