# judgePage — inspection findings (temporary note, informs test/delivery/judge-page-motion.test.ts)

Source inspected: `src/delivery/visual-gate.ts` (the `judgePage` export; the
delivery-gate internal that turns one page's raw observations into problem
strings). `src/delivery/judge.ts` is a DIFFERENT thing — the model-backed
candidate tie-break judge (`createModelJudge`), which has no motion logic.

## Signature

```ts
export function judgePage(
  report: Omit<PageVisualReport, 'problems'>,
  targets: { minDistinctColors?: number; maxDominantRatio?: number; minMotionRatio?: number } = {}
): string[]
```

## Return type

`string[]` — the page's PROBLEMS. Empty array = page is visually sound. There is
no boolean `passed` on this function (that lives on `VisualVerdict`), so the pass
condition in tests is `problems.length === 0`.

## Branches, in evaluation order

1. `!report.loaded` → `['page did not load']` and EARLY RETURN (all later branches
   skipped, so test observations must set `loaded: true`).
2. `failedRequests.length > 0` → `"<n> external resource(s) FAILED to load: …"`.
3. `runtimeErrors.length > 0` → `"uncaught runtime error(s) during observation: …"`.
4. `hasCanvas === true`:
   - a. `distinctColors < minColors || dominantRatio > maxDominant`
     → `"canvas renders below the visual floor (…)"`
   - b. `expectsAnimation && motionRatio < minMotion` → CANVAS no-motion wording.
5. `hasCanvas === false && expectsAnimation`:
   `motionRatio < minMotion` → NO-CANVAS no-motion wording. A missing canvas is
   NOT itself a failure (rAF also drives SVG/DOM animation), so only a genuinely
   static render fails. With `expectsAnimation === false`, motion is not required.

## Exact 'no-motion' strings (the NEW wording the regression tests pin)

- no canvas:
  `page uses requestAnimationFrame but the render is not animating (no measurable motion between samples)`
- canvas:
  `page uses requestAnimationFrame but motion is 0.0% (< 2.0% required) — the scene is not animating enough`
  (percentages are `motionRatio` / `minMotion` rendered with `toFixed(1)`)

## motionRatio threshold / floor

`MIN_MOTION_RATIO = 0.02` — at least 2.0% of the 24×24 sample grid must change
between the first and last sample. The effective floor is
`minMotion = Math.max(MIN_MOTION_RATIO, targets.minMotionRatio ?? 0)`, so a
project's `.uap/visual-targets.json` can only RAISE it, never lower it.
Comparison is strict `<`: `motionRatio === 0.02` passes, `0.01` fails.
Related built-in floors: `MIN_DISTINCT_COLORS = 3`, `MAX_DOMINANT_RATIO = 0.98`.

## Test cases this note backs (all in test/delivery/judge-page-motion.test.ts)

- `expectsAnimation=true, hasCanvas=false, motionRatio=0` → fails with the
  no-canvas no-motion string (and NOT the legacy blank-page wording).
- `expectsAnimation=true, hasCanvas=true,  motionRatio=0` → fails with the
  canvas no-motion string (threshold applies regardless of canvas presence).
- `motionRatio=0.01` fails, `0.02` passes (strict `<` at the 0.02 floor).
- `expectsAnimation=false` → no motion required.
- targets can raise the floor (0.05) but never weaken it.
- `loaded=false` short-circuits to `['page did not load']`.