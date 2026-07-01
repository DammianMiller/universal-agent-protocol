# RTK — Rust Token Killer

`v1.91.0` · `src/cli/rtk.ts`

> **🏭 Where this fits:** Cross-cutting (keeps the belt from jamming) — every
> `git status`, test run, and file dump your agent echoes floods the context
> window, so it loses focus and burns budget on terminal noise. **What it
> delivers:** 60–90% fewer tokens on CLI-command output, transparently, so
> context stays lean at every station of the
> [delivery pipeline](../guides/DELIVERY_PIPELINE.md).

RTK (Rust Token Killer) is a fast CLI proxy that compresses and filters the
output of command-line tools — `git status`, test runs, file reads, and similar
heavy commands — to cut the tokens your agent spends echoing terminal output.
Source positions it at **60–90% token savings on CLI command output**.

RTK is a separate, open-source tool (`https://github.com/rtk-ai/rtk`,
docs at `https://www.rtk-ai.app`). UAP integrates with it but does not bundle
it; `uap rtk` manages installation and wiring.

---

## Why RTK + the MCP Router

The two integrations guard the same cross-cutting concern — keeping context lean
so no station downstream jams — but target different sources of token waste, and
they stack:

| Layer | Tool | Saves on |
|-------|------|----------|
| MCP tool definitions + tool output | [MCP Router](MCP_ROUTER.md) | ~98% of tool-definition tokens |
| Raw CLI command output | **RTK** | 60–90% of CLI-output tokens |

Source describes the combination as **95%+ total token reduction**
(`src/cli/rtk.ts`).

---

## How UAP integrates RTK

`uap rtk <command>` (`src/cli/rtk.ts`):

```bash
uap rtk install     # install RTK, auto-detecting the best method
uap rtk status      # check install + hook wiring + recent savings
uap rtk help        # usage
```

### `uap rtk install`

Auto-detects the best install method (Homebrew → Cargo → pre-built binary via
curl) and runs it. Override with flags:

```bash
uap rtk install --method homebrew     # force a method: homebrew | cargo | curl
uap rtk install --force               # reinstall
```

Equivalent manual installs:

```bash
brew install rtk                                          # Homebrew
cargo install --git https://github.com/rtk-ai/rtk        # Cargo
# or download a release binary from:
#   https://github.com/rtk-ai/rtk/releases
```

After install, initialize and verify:

```bash
rtk init --global    # set up the global rewrite hook
rtk gain             # show token savings analytics
```

### `uap rtk status`

Reports whether the `rtk` binary is installed, whether the rewrite hook
(`~/.claude/hooks/rtk-rewrite.sh`) is wired in, and recent savings from
`rtk gain`.

---

## How it works in practice

Once the rewrite hook is installed, heavy CLI commands are transparently routed
through RTK (e.g. `git status` is rewritten to `rtk git status`) with zero
extra tokens of overhead — the agent issues normal commands and RTK compresses
the output before it reaches the model. Your agent never knows the belt is being
kept clear underneath it.

UAP can nudge agents to route heavy CLIs through RTK via the `rtk_wrap.py`
policy enforcer (`src/policies/enforcers/rtk_wrap.py`).

Useful RTK meta-commands:

```bash
rtk gain              # token savings analytics
rtk gain --history    # command usage history with savings
rtk discover          # find missed savings opportunities
rtk --version         # verify the install
```

---

## Combined analytics

`uap rtk` can surface unified analytics combining MCP Router and RTK savings
(`showUnifiedAnalytics` in `src/cli/rtk.ts`), so you can see total context
reduction from both layers at once.

See also: [MCP_ROUTER.md](MCP_ROUTER.md) ·
[../architecture/OVERVIEW.md](../architecture/OVERVIEW.md) ·
[../guides/DELIVERY_PIPELINE.md](../guides/DELIVERY_PIPELINE.md)
