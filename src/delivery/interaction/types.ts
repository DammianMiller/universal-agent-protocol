/**
 * Interaction gate — types.
 *
 * The gate answers a question neither the execution smoke gate nor the visual
 * gate can: does the artifact DO what it promised, under real input?
 *
 * Execution smoke proves it loads. Vision proves it looks right. Both pass on a
 * game that freezes on first contact — observed live (octopus_invaders_v3,
 * 2026-07-25): the visual gate returned `passed: true` on a build whose render
 * loop died to `player.takeDamage is not a function` three seconds in, and four
 * more defects (no kill credit, no game-over, no wave progression, a fire rate
 * 16x too slow because a millisecond constant was decremented per FRAME) sat
 * behind it. Every file passed `node --check`. Every screenshot looked correct.
 *
 * A probe is `drive this input → assert this observable`, which is the same
 * shape for a game, a CLI, or an HTTP API — hence the driver-adapter split.
 */

/** Which driver adapter executes a probe's steps. */
export type ArtifactKind = 'web' | 'cli' | 'http';

/**
 * `core` probes gate the build. `soak` probes prove sustained operation (many
 * levels, long sessions) and run on the deeper tier. `accelerated` probes inject
 * state to reach late-game paths cheaply — they can FAIL a build but never count
 * as evidence of natural progression, so they are reported separately.
 */
export type ProbeMode = 'core' | 'soak' | 'accelerated';

/** One machine-checkable promise mined from the requirements text. */
export interface Requirement {
  id: string;
  /** The requirement in its original words — quoted back in defect feedback. */
  text: string;
  /** Where it came from (requirements line, DESIGN.md, ledger item). */
  source?: string;
}

/** A single input action. `inject` is state mutation and is mode-restricted. */
export type Step =
  | { do: 'goto'; url?: string }
  | { do: 'wait'; ms: number }
  | { do: 'move'; x: number; y: number }
  | { do: 'down' }
  | { do: 'up' }
  | { do: 'click'; x?: number; y?: number; selector?: string }
  | { do: 'key'; key: string }
  /** Read-only expression evaluated in the artifact; result is recorded. */
  | { do: 'eval'; expr: string }
  /** Mutates artifact state to reach a hard-to-reach path. `accelerated` only. */
  | { do: 'inject'; expr: string }
  /** Repeat a step block N times — keeps soak probes small to express. */
  | { do: 'repeat'; times: number; steps: Step[] };

/**
 * An observable claim. `expr` is evaluated inside the artifact, so probes read
 * the artifact's OWN runtime state rather than guessing from pixels.
 */
export type Assertion =
  | { expect: 'truthy'; expr: string; label?: string }
  | { expect: 'equals'; expr: string; value: unknown; label?: string }
  | { expect: 'gte'; expr: string; value: number; label?: string }
  | { expect: 'lte'; expr: string; value: number; label?: string }
  /** Value must rise by at least `by` (default: any rise) within `overMs`. */
  | { expect: 'increases'; expr: string; overMs: number; by?: number; label?: string }
  /** Value must differ from its starting value within `overMs`. */
  | { expect: 'changes'; expr: string; overMs: number; label?: string }
  /** No uncaught errors, console errors or failed requests during the probe. */
  | { expect: 'noErrors'; label?: string };

export interface Probe {
  id: string;
  /** Requirements this probe proves — drives the coverage ledger. */
  requirementIds: string[];
  mode: ProbeMode;
  description: string;
  steps: Step[];
  asserts: Assertion[];
  timeoutMs?: number;
}

export interface InteractionManifest {
  version: 1;
  kind: ArtifactKind;
  /** Entry point: html file (web), argv (cli), base url (http). */
  entry: string;
  /** Hash of the requirements text this manifest was mined from. Re-mine on drift. */
  specHash: string;
  generatedAt: string;
  requirements: Requirement[];
  probes: Probe[];
  /**
   * Expressions yielding numbers that the watchdog samples throughout the run
   * (collection sizes, key state fields). Each one that goes NaN or grows
   * without bound is a defect no probe had to predict.
   */
  watch?: string[];
}

/** One assertion's outcome, with enough detail to be an actionable defect. */
export interface AssertionResult {
  label: string;
  passed: boolean;
  expected: string;
  observed: string;
  /**
   * The observation expression did not resolve (threw, or named something the
   * artifact does not expose) — a defect in the PROBE, not in the artifact.
   *
   * Collapsing this into an ordinary failure is how a gate sends an agent
   * chasing a phantom: a probe asserting `Particles.particles.length >= 1`
   * against a module that never exposes that array reads exactly like "the
   * particle system is broken", and the agent will happily rewrite a working
   * particle system to satisfy it.
   */
  unresolved?: boolean;
}

export interface ProbeResult {
  probeId: string;
  description: string;
  mode: ProbeMode;
  requirementIds: string[];
  passed: boolean;
  /** Set when the probe could not run at all (driver/launch failure). */
  skipped?: boolean;
  skipReason?: string;
  assertions: AssertionResult[];
  /** Runtime errors observed in the artifact during this probe. */
  errors: string[];
  durationMs: number;
}

/** Invariants checked continuously, independent of any probe's assertions. */
export interface WatchdogReport {
  /** Uncaught errors / rejections / console errors seen across the whole run. */
  errors: string[];
  /** The artifact's main loop kept ticking (rAF for web, still-alive for cli). */
  loopAlive: boolean;
  /** Ticks observed in the final sampling window (0 = frozen). */
  ticksObserved: number;
  /** State fields that went NaN — a silent corruption class nothing else sees. */
  nanFields: string[];
  /** Arrays that grew without bound — the leak class a short smoke test misses. */
  unboundedGrowth: string[];
}

/** Requirements with no probe — "present and active" made checkable. */
export interface CoverageLedger {
  total: number;
  covered: number;
  uncovered: Requirement[];
}

export interface InteractionVerdict {
  passed: boolean;
  /** True when the gate could not observe anything (no browser, no manifest). */
  skipped: boolean;
  skipReason?: string;
  results: ProbeResult[];
  watchdog?: WatchdogReport;
  coverage: CoverageLedger;
  /** Human/model-readable feedback — fed straight into the deliver loop. */
  feedback: string;
}
