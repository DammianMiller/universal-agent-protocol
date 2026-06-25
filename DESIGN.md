---
version: alpha
name: UAP Console
description: The Universal Agent Protocol dashboard & generator UI — a calm, high-density developer console in the GitHub-dark idiom.
colors:
  bg: "#0d1117"
  surface: "#161b22"
  surface-raised: "#21262d"
  border: "#30363d"
  text: "#c9d1d9"
  text-muted: "#8b949e"
  text-subtle: "#484f58"
  primary: "#58a6ff"
  success: "#3fb950"
  danger: "#f85149"
  warning: "#d29922"
  accent-purple: "#bc8cff"
  accent-orange: "#d18616"
  on-accent: "#ffffff"
typography:
  display:
    fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace"
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.3
  heading:
    fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace"
    fontSize: 18px
    fontWeight: 600
    lineHeight: 1.3
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
  code:
    fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace"
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    fontSize: 12px
    fontWeight: 500
  micro:
    fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace"
    fontSize: 11px
    fontWeight: 400
rounded:
  xs: 3px
  sm: 4px
  md: 6px
  lg: 8px
  xl: 10px
  2xl: 12px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  2xl: 32px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.bg}"
    rounded: "{rounded.md}"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.lg}"
---

# UAP Console

## Overview

UAP Console is the operator surface for the Universal Agent Protocol — the live
dashboard and the project generator. Its job is to make a lot of fast-moving
machine state (agents, tasks, memory, gates, telemetry) legible at a glance,
without ceremony.

The aesthetic is **GitHub-dark developer console**: a near-black canvas, cool
slate panels, monospace for anything structural or numeric, and a single
confident blue for interaction. It should feel like a well-built terminal UI —
calm, dense, and trustworthy — not a marketing page. Restraint over decoration:
color is reserved for status and action, never used as ornament.

## Colors

A cool, near-monochrome slate foundation carries the UI; saturated hues are
spent only on status and interaction.

- **bg (#0d1117):** The canvas — a deep, slightly blue-black behind everything.
- **surface (#161b22):** Panels, cards, and the primary content containers.
- **surface-raised (#21262d):** Hovered rows, popovers, and raised controls —
  the next step up from `surface`.
- **border (#30363d):** Hairline separators and container outlines.
- **text (#c9d1d9):** Primary reading text on dark surfaces.
- **text-muted (#8b949e):** Secondary text — metadata, captions, timestamps.
- **text-subtle (#484f58):** Tertiary text and disabled states.
- **primary (#58a6ff):** The single interaction color — links, focus, primary
  actions, active state. Nothing else competes for "click me."
- **success (#3fb950):** Passing gates, healthy agents, completed tasks.
- **danger (#f85149):** Failures, blocked states, destructive actions.
- **warning (#d29922):** Degraded/at-risk states needing attention.
- **accent-purple (#bc8cff) / accent-orange (#d18616):** Categorical accents for
  charts, tags, and telemetry series — never for primary actions.
- **on-accent (#ffffff):** Text/icons placed on a saturated accent fill.

## Typography

Two families, used deliberately. A **monospace** stack (`SF Mono → Fira Code →
Cascadia Code`) for everything structural — headings, code, IDs, metrics,
status — because the product is about machine state and alignment matters. A
**system sans** stack for prose-like body copy and labels, for comfortable
reading. Type sizes stay tight (11–20px); hierarchy comes from weight and color
more than scale.

## Layout

High density, generous breathing room within a strict rhythm. Spacing follows a
4px base scale (`4/8/12/16/24/32`). Content lives in `surface` cards separated by
`border` hairlines on the `bg` canvas. Prefer alignment and whitespace to rules
and boxes; let the dark canvas do the separating.

## Shapes

Soft, small radii throughout (`3–12px`) — enough to feel finished, never
playful. Cards use `lg` (8px); inline controls and chips use `md`/`sm`.

## Components

- **button-primary:** `primary` fill with dark `bg` text (for AA contrast on the
  light blue), `md` radius. The only high-emphasis button on a view.
- **card:** `surface` background, `text` foreground, `border` hairline, `lg`
  radius.

## Do's and Don'ts

- **Do** use a design token (or a CSS `var(--…)`) for every color and spacing
  value in new UI.
- **Do** reserve `primary` for interaction and the status hues for status only.
- **Don't** hardcode off-token hex colors or off-scale spacing — the UAP design
  gate blocks them (`uap design check`, bypass once with `UAP_DESIGN_GATE_OFF=1`).
- **Don't** introduce a second interaction color or decorative gradients; the
  console's authority comes from restraint.
