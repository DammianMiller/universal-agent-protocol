# design-token-gate

**Category**: quality
**Level**: REQUIRED
**Enforcement Stage**: pre-exec
**Tags**: design, ui, ux, tokens, design-system

## Rule

A `Write`, `Edit`, or `MultiEdit` to a UI file (`.css`, `.scss`, `.tsx`, `.jsx`,
`.vue`, `.svelte`, `.html`, `.astro`) whose proposed content hardcodes a color
or spacing value that is NOT part of the project's DESIGN.md token system is
**blocked**. The agent must use an existing design token (or CSS var), add the
value to `DESIGN.md` and re-sync, or bypass explicitly.

On-token (allowed): values present in the token allow-list, `var(--…)` usages,
`{token.ref}` references, and structural hairlines (`0–4px`). The gate is
**inactive** (fails open) when a project has no `DESIGN.md` / token allow-list.

## Why

DESIGN.md gives agents a persistent, structured understanding of a project's
visual identity. Without enforcement, new UI drifts off-system — ad-hoc hex
colors and off-scale spacing accumulate until the design system is fiction. The
gate keeps new UI on-token so the design system stays the real source of truth.

## Enforcement

Python enforcer `design_token_gate.py` reads `.uap/design-tokens.json` (generated
by `uap design interrogate|sync` from the project DESIGN.md — no YAML parser
needed) and scans the proposed content for off-token colors/spacing. Mirrors
`src/design/gate.ts`. Escape hatch: `UAP_DESIGN_GATE_OFF=1`.

```rules
- title: "New UI must use DESIGN.md design tokens, not hardcoded colors/spacing"
  keywords: [css, color, theme, ui, ux, button, component, style, tailwind, design]
  antiPatterns: ["#hex", "rgb(", "hardcoded color", "off-scale spacing"]
```
