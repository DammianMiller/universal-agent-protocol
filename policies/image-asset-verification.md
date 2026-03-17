# Image & Asset Verification Rules

Enforce deterministic, script-based verification for all image and asset operations. Prevents wasteful vision-based iteration loops.

## Rules

1. **Never use vision to count or measure.** If you need to count elements, measure spacing, or verify pixel positions in an image, write a script (Python/Pillow, ImageMagick) to extract that data programmatically. Do NOT repeatedly view an image to "eyeball" it.
   - Use `python -c "from PIL import Image; img = Image.open('file.png'); print(img.size)"` for dimensions
   - Use scripts for element counting, spacing measurement, pixel position verification

2. **One-shot asset edits.** When modifying images (watermarks, spacing, etc.), calculate all coordinates mathematically BEFORE making changes. Do not use iterative view-fix-view loops. If you need the image dimensions or element positions, use a script to extract them first.

3. **Batch all visual fixes in a single pass.** If multiple issues are found in one image, fix them ALL in one edit, not across separate commits/sessions.

4. **Cap visual verification.** You may view an image result a MAXIMUM of 1 time after making changes. If it's still wrong after one check, stop and ask the user to verify manually rather than entering a correction loop.

5. **Prefer deterministic over visual.** For any task that can be solved with code (counting, alignment, spacing, positioning), use code. Vision is only for subjective quality judgment, not measurable properties.

## Enforcement Level

[RECOMMENDED]

## Related Tools

- pillow: Python image processing
- imagemagick: CLI image manipulation
