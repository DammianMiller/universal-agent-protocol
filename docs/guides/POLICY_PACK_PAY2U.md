# pay2u Policy Pack

A selectable, example policy pack ported from the pay2u project
(`~/dev/miller-tech/pay2u/policies/`, originally extracted from its `AGENTS.md`
during `uap setup`). It bundles three project-shaped policies that demonstrate
the "custom architecture / reference" policy type — load-bearing invariants,
cluster reference cards, and an enforcement-hooks summary.

These are **advisory** policies (`RECOMMENDED`, no Python enforcer): they are
surfaced to the agent as reviewable rules and shown in the policy matrix /
`uap policy list`, but they do not hard-block tool calls. They are opt-in — not
part of the default policy set — so ordinary projects aren't burdened with
pay2u-specific content. Select the pack during `uap setup` (policy matrix →
"pay2u policy pack") or install individually with `uap policy install <name>`.

## Contents

| Policy | Category | What it captures |
|---|---|---|
| `pay2u-architecture-rules` | architecture | The non-negotiable, ADR-indexed invariants (COOKIE-ONLY, ZITADEL-IDP, OO-UNIFIED, PIPELINE-ONLY, THREE-CLUSTERS). An edit that would violate one must STOP and surface the conflict against the referenced ADR rather than silently working around it. |
| `pay2u-quick-reference` | reference | Cluster cheat-sheets (MAIN / OPENOBSERVE / ZITADEL — purpose, URLs, node sizing, TLS challenge type) and the 3-phase Istio cluster-recreation procedure. Fast orientation for infra work. |
| `pay2u-enforcement-hooks` | process | The inventory of installed enforcement hooks (policy-gate, pre/post tool-use, compaction, stop, session-end) and how gating differs per harness (hard for MCP-routed tools, advisory for Codex-native edit/bash). |

## Using the pack

- **During setup:** `uap setup` → enable the policy engine → check **"pay2u policy pack"** in the policy matrix. All three install and enable together.
- **Individually:** `uap policy install pay2u-architecture-rules` (etc.).
- **Manage:** `uap policy matrix` lists every policy (built-in + pack + installed) with its status/level/stage; adjust with `uap policy toggle|enable|disable|level|stage <id>`.

## Adapting for your own project

This pack is intentionally pay2u-specific to serve as a worked example. To make
your own architecture pack, copy these files, replace the invariants / cluster
cards / hook list with yours, keep the `**Category**` / `**Level**` /
`**Enforcement Stage**` / `**Tags**` frontmatter, and either drop them in your
project's `./policies/` (custom policies dir) or add them here as a new pack.
