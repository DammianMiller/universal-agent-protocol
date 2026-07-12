# visual-verification

**Category**: quality
**Level**: REQUIRED
**Enforcement Stage**: post-exec
**Tags**: visual, ui, ux, behavior, screenshots, design, verification

## Rule

A delivery whose artifact renders (web/canvas/UI) is NOT done until its
**rendered output has been observed running**:

1. The visual gate (`uap verify` / deliver's acceptance path) must pass: every
   entry page loads, the canvas/DOM is not blank, pages that use
   `requestAnimationFrame` are actually animating (pixel motion between
   samples), and no uncaught errors occur during the observation window.
2. The screenshots the gate saves under `.uap/visual/` must be **reviewed by a
   vision-capable reviewer** (the driving agent session, a configured vision
   model, or a human) for design and aesthetic quality — composition, color,
   readability, polish — and findings applied before claiming done.
3. Behavioral claims in the spec (things spawn, collide, crush, score) must be
   confirmed against the *observed* runtime — the gate's motion/state samples
   and screenshots — never from code reading alone.

## Why

Two live deliveries passed every code-level gate while being behaviorally
wrong: a game whose enemy waves were never started (complete wave logic,
never called — 18/18 code-evidence acceptance), and physics scenes whose
animation was only presumed. Load-testing proves "does not crash"; code
evidence proves "logic exists". Only watching the rendered artifact proves
"it works and looks right". Screenshots make aesthetic taste applicable:
an agent that can see the output can improve it.

## Enforcement

- `src/delivery/visual-gate.ts` — headless render + in-page pixel-grid
  sampling (blank/static/error detection), screenshots to `.uap/visual/`.
- `uap verify` runs it by default whenever entry `.html` pages exist
  (`--no-visual` opts out); failures are REAL failures (exit 1).
- `uap deliver` (acceptance-primary path) blocks acceptance on visual
  failures and feeds the observation summary to the acceptance judge as
  runtime evidence.
- Fail-open ONLY when no headless browser is available (vm-DOM cannot
  render pixels); the skip is stated explicitly in the report.

## Agent obligations

After any delivery with a rendered artifact: run `uap verify --dir <project>`,
Read the `.uap/visual/*.png` screenshots, apply design/aesthetic judgment
(spacing, palette, hierarchy, motion feel), fix what looks wrong, and re-verify.
"It passed the gates" is not "it looks right".

## Commit-time enforcer (max fidelity)

Under maximum fidelity (`.uap.json` `fidelity.mode: max` or `UAP_FIDELITY=max`),
the Python enforcer `visual_verification.py` fires on `git commit` and **blocks**
the commit when UI files are staged but have not been visually verified since
they last changed:

- `uap verify` writes `.uap/visual/last-verdict.json` (`{passed, mode, at}`)
  whenever the visual gate actually renders.
- The enforcer blocks if that marker is missing, records a non-passing verdict,
  or is older than any staged UI file's on-disk mtime (the look changed after it
  was last observed).

This is the **non-bypassable backstop** for agentic / opencode / direct-edit
sessions that never run `uap deliver` or the Stop-hook `uap verify`. It is
INACTIVE (fails open) when fidelity is `standard`. Escape hatch (justify in the
commit message): `UAP_VISUAL_GATE_OFF=1`.
