/**
 * EXECUTABLE SPEC for `dockerCargoRung` — write the implementation until this
 * file passes. Nothing else in the repo needs to change.
 *
 * WHY THIS EXISTS
 * A crate can hide its whole API behind a cargo feature (`#[cfg(feature =
 * "pgrx")]`), and `cargo check --workspace` compiles default features only — so
 * the gate reports zero errors on code that does not compile. Measured
 * 2026-08-12: 0 errors reported, 52 real ones behind the flag.
 *
 * Enabling the feature locally is not a general answer: it needed `cargo pgrx
 * init`, which builds PostgreSQL from source and failed until readline/zlib
 * were disabled. A container carries that toolchain instead, so the gate works
 * on a machine that has nothing installed.
 *
 * Verified before writing this spec — a container really can build the crate:
 *   docker run --rm -v "$PWD":/w -w /w rust:1-slim cargo --version  →  1.97.1
 *
 * WHAT TO IMPLEMENT (in src/delivery/verifier-ladder.ts, exported):
 *
 *   export function dockerCargoRung(
 *     projectRoot: string,
 *     feature: string,
 *     opts?: { image?: string; hasDocker?: boolean; timeoutMs?: number }
 *   ): GateRung | null
 *
 * Rules, each pinned by a test below:
 *   1. return null when docker is unavailable — the ladder must degrade, never break
 *   2. return null for an empty feature name
 *   3. id is `cargo-check-docker-<feature>`
 *   4. command is 'docker'
 *   5. args run: run --rm -v <projectRoot>:/w -w /w <image> cargo check --workspace --features <feature>
 *   6. default image is 'rust:1-slim'; opts.image overrides it
 *   7. required is false — a missing image or no network must not fail delivery
 *   8. timeoutMs defaults to at least 15 minutes (a cold container pulls and compiles)
 */
import { describe, it, expect } from 'vitest';
import { dockerCargoRung } from '../../src/delivery/verifier-ladder.js';

const ROOT = '/home/me/project';
const ok = { hasDocker: true };

describe('dockerCargoRung', () => {
  it('returns null when docker is unavailable, so the ladder degrades', () => {
    expect(dockerCargoRung(ROOT, 'pgrx', { hasDocker: false })).toBeNull();
  });

  it('returns null for an empty feature', () => {
    expect(dockerCargoRung(ROOT, '', ok)).toBeNull();
    expect(dockerCargoRung(ROOT, '   ', ok)).toBeNull();
  });

  it('uses a stable id naming the feature', () => {
    expect(dockerCargoRung(ROOT, 'pgrx', ok)!.id).toBe('cargo-check-docker-pgrx');
  });

  it('runs docker, not cargo', () => {
    expect(dockerCargoRung(ROOT, 'pgrx', ok)!.command).toBe('docker');
  });

  it('mounts the project and checks the feature inside the container', () => {
    const args = dockerCargoRung(ROOT, 'pgrx', ok)!.args;
    expect(args).toEqual([
      'run', '--rm',
      '-v', `${ROOT}:/w`,
      '-w', '/w',
      'rust:1-slim',
      'cargo', 'check', '--workspace', '--features', 'pgrx',
    ]);
  });

  it('lets the caller choose the image', () => {
    const args = dockerCargoRung(ROOT, 'pgrx', { ...ok, image: 'ghcr.io/example/pgrx:0.13' })!.args;
    expect(args).toContain('ghcr.io/example/pgrx:0.13');
    expect(args).not.toContain('rust:1-slim');
  });

  it('is ADVISORY — a missing image or no network must not fail delivery', () => {
    expect(dockerCargoRung(ROOT, 'pgrx', ok)!.required).toBe(false);
  });

  it('allows at least 15 minutes: a cold container pulls AND compiles', () => {
    expect(dockerCargoRung(ROOT, 'pgrx', ok)!.timeoutMs).toBeGreaterThanOrEqual(900_000);
  });

  it('honours an explicit timeout', () => {
    expect(dockerCargoRung(ROOT, 'pgrx', { ...ok, timeoutMs: 1_800_000 })!.timeoutMs).toBe(1_800_000);
  });

  it('names the feature in the human-readable name', () => {
    expect(dockerCargoRung(ROOT, 'pgrx', ok)!.name).toContain('pgrx');
  });

  it('quotes nothing and shells out to nothing — args are passed verbatim', () => {
    // The rung runner does no shell interpolation, so a path with spaces must
    // arrive as ONE argument rather than being pre-quoted by the caller.
    const args = dockerCargoRung('/home/my project', 'pgrx', ok)!.args;
    expect(args).toContain('/home/my project:/w');
    expect(args.join(' ')).not.toContain('"');
  });
});
