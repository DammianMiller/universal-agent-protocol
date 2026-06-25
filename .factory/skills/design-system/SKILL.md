---
name: design-system
description: Keep a project's UI/UX on its DESIGN.md design system. Use when building, editing, or reviewing any UI — components, CSS, styling, colors, typography, layout, themes. Auto-interrogates existing UI into a DESIGN.md and guides new UI to stay on-token.
---

# Design System (DESIGN.md)

UAP implements the [DESIGN.md](https://github.com/google-labs-code/design.md)
format — YAML design tokens (colors, typography, spacing, rounded, components)
plus prose rationale — as a project's persistent visual identity for agents.

## When to use

Before any UI/UX work: building or editing components, CSS/SCSS, Tailwind,
styling, colors, typography, layout, themes, or design reviews.

## Workflow

1. **Ensure a DESIGN.md exists.** If the project has none, derive one from the
   existing UI:
   ```bash
   uap design interrogate          # scans CSS vars, Tailwind, theme files, usage
   ```
   This writes `DESIGN.md` (refine its prose + token roles) and the gate's
   allow-list `.uap/design-tokens.json`.

2. **Apply the tokens to new UI.** Use the DESIGN.md color/spacing/typography
   tokens (or CSS `var(--…)` / `{token.ref}` references) — never hardcode
   off-token hex colors or off-scale spacing. The reactor injects the active
   design summary automatically when it detects UI work.

3. **Keep it in sync.** After editing DESIGN.md tokens, regenerate the gate
   allow-list:
   ```bash
   uap design sync
   ```

4. **Validate** against the spec (uses the OSS `@google/design.md` CLI — WCAG
   contrast, broken token refs, structure):
   ```bash
   uap design lint
   ```

## Enforcement (hard gate)

The `design-token-gate` policy **blocks** UI edits (`.css/.scss/.tsx/.jsx/.vue/
.svelte/.html/.astro`) that introduce colors or spacing not in the design
system. To resolve a block: use an existing token, add the new value to
DESIGN.md then `uap design sync`, or bypass once with `UAP_DESIGN_GATE_OFF=1`.
The gate is inactive (fails open) for projects without a DESIGN.md.

## Verification

```bash
uap design context     # what the agent is told for UI work
uap design check --file path/to/Component.tsx   # would this edit be blocked?
```
