"""Keep importing the proxy from mutating the test process's environment.

`anthropic_proxy` loads `.uap/proxy.env` into the real `os.environ` at import
so a server run gets the operator's recipe/delivery/auth settings without
hand-exported env. Under test that is a liability, and it produced two real
failures:

1. Tests that assert shipped defaults (timeouts, retry budgets) instead
   asserted whatever the developer's `.uap/proxy.env` happened to contain —
   green in CI, red locally, for no code reason.
2. `UAP_DELIVER_LOCAL_MODE` from that file reached every enforcer subprocess
   the suite spawns, so `test_delivery_enforcement_worktree` passed or failed
   depending on whether a proxy-importing module had run before it.

Setting the opt-out here covers every pytest run from one place instead of
each module defending itself. `npm run test:enforcers` sets the same variable
for the unittest path, which does not read conftest.py.

This must run before any test module imports the proxy — conftest is imported
at collection time, ahead of the test modules, which is exactly that point.
Tests that specifically exercise the loader call `_load_proxy_env_file()`
directly and are unaffected.
"""

import os

os.environ.setdefault("UAP_PROXY_ENV_AUTOLOAD", "0")
