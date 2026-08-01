"""Test package init — keeps importing the proxy from mutating this process.

`anthropic_proxy` loads `.uap/proxy.env` into the real `os.environ` at import.
That is right for a server run and wrong for a test run: it makes tests assert
the developer's proxy config instead of the shipped defaults, and it leaks
UAP_DELIVER_* settings into every enforcer subprocess the suite spawns, so
results depend on module import order.

Setting the opt-out here rather than only in `conftest.py` covers every entry
path, because all of them import this package first:

  - `python -m unittest tools.agents.tests.test_x`   (what CI runs)
  - `python -m unittest discover -s tools/agents/tests`
  - `loadTestsFromNames(...)` in test_enforcer_suite_coverage
  - pytest (which also reads conftest.py)

`python3 tools/agents/tests/test_x.py` — running a file directly by path — is
the one shape that does NOT import the package, which is why conftest.py and
the `test:enforcers` script both still set it too.

`setdefault`, so an explicit `UAP_PROXY_ENV_AUTOLOAD=1` in the environment
still wins for anyone who deliberately wants the real file loaded.
"""

import os

os.environ.setdefault("UAP_PROXY_ENV_AUTOLOAD", "0")
