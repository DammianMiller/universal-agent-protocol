# engineering-principles

**Category**: quality
**Level**: RECOMMENDED
**Enforcement Stage**: pre-exec
**Tags**: quality, simplicity, architecture, dependencies, prior-art

## Rule

Write code to these principles. Rules 2-8 always apply. Rule 1 depends on a
stance resolved per project per session — run `uap principles show` to see the
form in force, and `uap principles ask` to answer it.

1. **Backward compatibility — stance-dependent.**
   - `remove`: delete obsolete paths instead of adding compatibility layers,
     fallbacks, or migrations.
   - `preserve`: keep existing paths working and migrate callers before
     removing anything.

   Under `remove`, these surfaces are still preserved and migrated, never
   deleted, because their callers are not yours to update:
   - the public CLI surface — command names, flags, and their output contracts
   - MCP tool names and input schemas
   - database, config, and on-disk state schemas, including their migrations
   - exported types and public module entry points

2. **Choose the simplest implementation that fully meets the current
   requirements.** Avoid speculative abstractions, configuration, and
   indirection.

3. **Grow the system in layers.** Start from the smallest version that works end
   to end, and add each new capability on top of a product that already works.
   Never trade a working product for unfinished complexity.

4. **Keep components modular and concerns clearly separated.**

5. **Prefer established, well-maintained libraries** when they reduce overall
   complexity or improve reliability. Do not reimplement common functionality
   without a clear reason.

6. **Lean on the dependencies already in the project** before writing your own
   implementation or adding packages. Do not assume a library lacks a capability
   without checking its documentation and types.

7. **Make architectural decisions for the long term.** Do not accept a stopgap
   that only works for now and is meant to be replaced later.

8. **Study how established products solve the problem before designing a
   solution.** Adopt their proven patterns and conventions rather than inventing
   an approach from scratch.

## Why

Adapted from an AGENTS.md distilled from roughly 60B tokens of agent-driven
coding (x.com/MarcosHernanz/status/2083954734487212511). Its author scopes it to
side projects — "don't use it in production if you don't want to destroy your
codebase" — and rule 1 is why: deleting obsolete paths is right when you own
every caller and destructive when you do not. Rather than adopt or drop rule 1
wholesale, UAP resolves it per project per session and carves out the surfaces
other people are bound to.

The remaining rules are direction-of-travel guidance, not gates. They are
RECOMMENDED because a machine cannot tell a speculative abstraction from a
necessary one, and a blocking check that guesses would cost more than it saves.

## Enforcement

Advisory. There is no Python enforcer: these are judgment calls, and blocking
gates in this repo have repeatedly cost more in false positives than they
prevented. The principles reach the model three other ways:

- **Deliver prompts** — the compact form is injected into every convergence-loop
  and orchestrated task prompt, so generated code is held to them rather than
  only the agent's preamble.
- **Reactor** — while the rule-1 stance is unresolved, the agent is told to ask
  the user once; after that it stays silent.
- **Judge** — competing candidates are scored on reuse-over-reimplementation and
  absence of stopgaps.

Related: pattern P38 (Prior Art First) covers rules 5, 6 and 8 at plan time; the
`/simplify` and `distill` skills cover rule 2 on existing code.

```rules
- title: "Simplest implementation that meets the requirement"
  keywords: [implement, refactor, design, abstraction, config, indirection]
  antiPatterns: [speculative-abstraction, premature-config, needless-indirection]
- title: "Reuse before reimplementation"
  keywords: [library, dependency, package, util, helper, from scratch]
  antiPatterns: [reimplemented-common-functionality, unchecked-library-capability]
- title: "No stopgaps"
  keywords: [temporary, for now, placeholder, replace later, quick fix]
  antiPatterns: [stopgap-architecture, deferred-rewrite]
```
