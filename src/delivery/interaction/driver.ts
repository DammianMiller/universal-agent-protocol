/**
 * Driver abstraction — the seam that keeps the interaction gate universal.
 *
 * A probe says "drive this input, then assert this observable". That sentence is
 * identical for a canvas game, a CLI and an HTTP API; only the verbs differ. So
 * the manifest format is shared and each artifact kind supplies a driver:
 *
 *   web   → pointer/keys into a real headless browser, `read` evaluates in-page
 *   cli   → keystrokes into a pty, `read` inspects the transcript/exit state
 *   http  → requests, `read` inspects the last response
 *
 * Keeping `read(expr)` opaque is what makes assertions read the artifact's OWN
 * runtime state instead of guessing from pixels or stdout scraping.
 */

import type { Step } from './types.js';

/** Outcome of one observation: did the expression resolve, and to what. */
export interface ReadResult {
  ok: boolean;
  value?: unknown;
  error?: string;
}

export interface InteractionDriver {
  /** Launch and reach the artifact's initial state. */
  start(): Promise<void>;
  /**
   * Return the artifact to its initial state before the next probe.
   *
   * Without this every probe inherits the previous probe's state, so results
   * are order-dependent and a later probe reports failures caused by an
   * earlier one — e.g. 'colliding costs health' failing because a previous
   * probe already ended the game. Optional: a driver that cannot reset simply
   * runs probes in sequence, which is the old behaviour.
   */
  reset?(): Promise<void>;
  /** Execute one input step. Unknown step kinds must be ignored, not thrown. */
  runStep(step: Step): Promise<void>;
  /** Evaluate an observation expression in the artifact's own context. */
  read(expr: string): Promise<unknown>;
  /**
   * Evaluate an observation and say whether it RESOLVED. A probe naming
   * something the artifact does not expose is a broken probe, and reporting it
   * as a failing behaviour makes the agent "fix" working code.
   */
  readDetailed?(expr: string): Promise<ReadResult>;
  /** Mutate artifact state (accelerated probes only — the runner enforces this). */
  inject(expr: string): Promise<void>;
  /** Runtime errors observed so far (uncaught throws, console errors, 404s). */
  errors(): string[];
  /**
   * Read one watchdog sample. Owned by the DRIVER because the instrumentation
   * global is named per-run — the caller cannot know the name, which is the
   * point: a page that can guess it can forge its own liveness counters.
   */
  watchdogSample?(watchExprs: string[]): Promise<unknown>;
  /** Best-effort screenshot/transcript capture for the evidence trail. */
  capture?(path: string): Promise<void>;
  stop(): Promise<void>;
}

export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}
