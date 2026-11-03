# Verify (deliver variant — gates-only verdict)

This step runs the project's REAL completion gates and nothing else: no
executor turns, no model claims, no partial credit. Build, typecheck,
tests, lint — the same gates a human would run before shipping.

The mission is delivered if and only if this pass is green. A repair that
"should have" fixed things is not delivered until these gates say so; a
regression introduced by a late repair is caught here, not shipped.
