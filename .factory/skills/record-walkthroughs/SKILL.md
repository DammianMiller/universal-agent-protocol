| name | description |
| --- | --- |
| record-walkthroughs | Record narrated screen-capture walkthroughs of an app's critical paths, driven by browser automation. Use when asked for demo videos, product walkthroughs, or Loom-style recordings, or to refresh them after a UI change. |

# Recording Product Walkthroughs

Automated screen recordings of an app's critical paths, driven through the real
UI. Cheap to regenerate, so they stay current instead of rotting the week after
they were made.

## When to Use
| Need | Approach |
|------|----------|
| Prove a change works | Screenshot or a test |
| Show a flow to a human | Walkthrough recording |
| Assert a flow keeps working | E2E test, not a recording |

Recordings and tests are different artifacts. Keep both: the test fails the
build, the recording explains the product. Never make one do the other's job.

## Rules

- **Drive the real UI, not a script of screenshots.** If the recording cannot be
  produced by clicking through the app, it is a mockup — say so.
- **Run against seeded/mock data**, never production. Deterministic input is what
  makes a re-record reproducible.
- **Keep the video on failure.** A broken step must be visible in the footage;
  discarding failed takes hides the regression.
- **Captions as a sidecar (WebVTT), never burned in.** Timestamp narration
  against the video clock during the run. Burnt-in text cannot be toggled,
  translated, or corrected without re-recording.
- **Pace for a human.** Add explicit holds between actions and a visible cursor;
  automation-speed clicks are unwatchable.
- **State what is compressed or simulated** in a README beside the output —
  shortened waits, injected fixtures, faked devices.

## Capture Quality

Recorder output is the master; nothing downstream recovers detail it never had.
In order of impact:

1. **Pixels on the subject.** A UI scaled down to fit a frame gets few pixels and
   looks grainy. Author the stage in a fixed design space and scale the whole
   tree to the capture viewport — browsers re-rasterise a transformed subtree at
   its composited scale, so glyphs are *drawn* at final size rather than
   upscaled. Then capture well above delivery resolution.
2. **Downsample on encode.** Delivering below capture resolution averages out the
   recorder's compression noise. This is usually what removes "grain".
3. **Encode near-lossless** (x264 CRF ~16 for flat UI). Compare the output
   bitrate against the source — an encode emitting well under its input is
   destroying more than the capture did.

Measure before tuning: `ffprobe -show_entries format=bit_rate` on both ends.

## Traps

- **Fixed headers/footers swallow clicks.** Automation visibility checks pass for
  an element sitting under a fixed overlay, then the click lands on nothing and
  the step silently no-ops. Scroll the element into genuine reach.
- **Multi-device flows need an explicit handoff.** Where one actor produces
  something a second consumes (a QR code, a link, a code), have the first step
  write an artifact and the second consume it. Two independent runs prove
  nothing about the pair.
- **Simulated hardware must match what the app requests.** A fake camera feed
  below the app's requested resolution gets upscaled, and decoding turns
  intermittent.
- **Runners commonly wipe their output directory per invocation.** If flows run
  as separate invocations, stash each take before the next starts.
- **Mock layers sitting above the network are invisible to request
  interception.** Route stubs only work if a request is actually made.

## Reference Implementation

`pay2u` — `apps/web/tests/demo/` (Playwright + mock mode + a root-scaled stage
page), with a project-level skill of the same name carrying that app's selectors
and flow specifics. Copy the shape, not the selectors.
