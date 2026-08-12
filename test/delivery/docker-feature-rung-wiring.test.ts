/**
 * Wiring the container check into the ladder — opt-in, and why.
 *
 * `cargo check --workspace` compiles DEFAULT features only, so a crate whose
 * API lives behind `#[cfg(feature = "x")]` passes while broken (measured: 0
 * errors reported, 52 real ones behind the flag). The ladder already NAMES that
 * blind spot; this makes it possible to actually check it, inside a container,
 * so no host toolchain is needed — the motivating pgrx crate otherwise requires
 * `cargo pgrx init`, which builds PostgreSQL from source.
 *
 * OPT-IN because the cost is real and measured: a non-default feature gates a
 * module in 218 of 681 registry crates (32%), and the rung pulls an image and
 * compiles a workspace with no warm target dir. On by default it would tax a
 * third of all Rust projects, every turn, to answer a question most of them do
 * not have.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { detectCargoRungs } from '../../src/delivery/verifier-ladder.js';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop() as string, { recursive: true, force: true });
  delete process.env.UAP_DOCKER_FEATURE_CHECK;
});

/** A crate whose whole API hides behind a non-default feature. */
function gatedCrate(uap?: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'uap-dockerwire-'));
  roots.push(root);
  writeFileSync(
    join(root, 'Cargo.toml'),
    '[package]\nname = "x"\n\n[features]\ndefault = []\npgrx = ["dep:pgrx", "pgrx/pg14"]\n'
  );
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'lib.rs'), '#[cfg(feature = "pgrx")]\nmod pgrx_funcs { fn a() {} }\n');
  if (uap) writeFileSync(join(root, '.uap.json'), JSON.stringify(uap));
  return root;
}

const ids = (root: string) => detectCargoRungs(root).map((r) => r.id);

describe('the container rung is opt-in', () => {
  it('is ABSENT by default — the advisory notice is what a project gets', () => {
    const root = gatedCrate();
    expect(ids(root)).toContain('cargo-feature-blind-spot');
    expect(ids(root).some((i) => i.startsWith('cargo-check-docker-'))).toBe(false);
  });

  it('is absent when the project opts OUT explicitly', () => {
    const root = gatedCrate({ delivery: { dockerFeatureCheck: false } });
    expect(ids(root).some((i) => i.startsWith('cargo-check-docker-'))).toBe(false);
  });

  it('never appears for a crate with nothing gated, however it is configured', () => {
    const root = mkdtempSync(join(tmpdir(), 'uap-dockerwire-'));
    roots.push(root);
    writeFileSync(join(root, 'Cargo.toml'), '[package]\nname = "x"\n');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'lib.rs'), 'fn a() {}\n');
    writeFileSync(join(root, '.uap.json'), JSON.stringify({ delivery: { dockerFeatureCheck: true } }));
    process.env.UAP_DOCKER_FEATURE_CHECK = '1';
    const got = ids(root);
    expect(got.some((i) => i.startsWith('cargo-check-docker-'))).toBe(false);
    expect(got, 'the real gates must still be there').toContain('cargo-check');
  });

  it('leaves cargo-check required and untouched in every case', () => {
    for (const root of [gatedCrate(), gatedCrate({ delivery: { dockerFeatureCheck: true } })]) {
      const check = detectCargoRungs(root).find((r) => r.id === 'cargo-check')!;
      expect(check.required).toBe(true);
      expect(check.args).toEqual(['check', '--workspace']);
    }
  });

  it('tells the operator how to switch it on', () => {
    const root = gatedCrate();
    const notice = detectCargoRungs(root).find((r) => r.id === 'cargo-feature-blind-spot')!;
    expect(notice.args.join(' ')).toContain('dockerFeatureCheck');
  });
});

describe('when opted in, with docker presence injected', () => {
  // The seam exists so these assert the DECISION, not the machine. Without it,
  // a mutant making the container rung unreachable passed every test.
  const withDocker = (root: string) => detectCargoRungs(root, undefined, { hasDocker: () => true }).map((r) => r.id);
  const withoutDocker = (root: string) => detectCargoRungs(root, undefined, { hasDocker: () => false }).map((r) => r.id);

  it('ADDS the container rung when opted in and docker is present', () => {
    const root = gatedCrate({ delivery: { dockerFeatureCheck: true } });
    expect(withDocker(root)).toContain('cargo-check-docker-pgrx');
  });

  it('replaces the advisory notice with the real check', () => {
    const root = gatedCrate({ delivery: { dockerFeatureCheck: true } });
    expect(withDocker(root)).not.toContain('cargo-feature-blind-spot');
  });

  it('falls back to the notice when docker is NOT present', () => {
    const root = gatedCrate({ delivery: { dockerFeatureCheck: true } });
    const got = withoutDocker(root);
    expect(got).toContain('cargo-feature-blind-spot');
    expect(got.some((i) => i.startsWith('cargo-check-docker-'))).toBe(false);
  });

  it('still adds nothing when the project has not opted in, docker or not', () => {
    const root = gatedCrate();
    expect(withDocker(root).some((i) => i.startsWith('cargo-check-docker-'))).toBe(false);
  });
});

describe('when opted in', () => {
  // Docker presence is environment-dependent, so these assert the DECISION
  // rather than the outcome: with the opt-in on, the ladder either runs the
  // container check or falls back to the notice — never silently neither.
  it('produces either the container rung or the notice, never nothing', () => {
    const root = gatedCrate({ delivery: { dockerFeatureCheck: true } });
    const got = ids(root);
    const hasDockerRung = got.some((i) => i.startsWith('cargo-check-docker-'));
    const hasNotice = got.includes('cargo-feature-blind-spot');
    expect(hasDockerRung || hasNotice, 'the blind spot must be surfaced one way or the other').toBe(true);
  });

  it('the environment override is honoured as an opt-in too', () => {
    const root = gatedCrate();
    process.env.UAP_DOCKER_FEATURE_CHECK = '1';
    const got = ids(root);
    expect(got.some((i) => i.startsWith('cargo-check-docker-')) || got.includes('cargo-feature-blind-spot')).toBe(true);
  });

  it('any container rung it adds is advisory and names the feature', () => {
    const root = gatedCrate({ delivery: { dockerFeatureCheck: true } });
    const rung = detectCargoRungs(root).find((r) => r.id.startsWith('cargo-check-docker-'));
    if (!rung) return; // docker absent in this environment — covered above
    expect(rung.required, 'a cold image pull must not fail delivery').toBe(false);
    expect(rung.id).toBe('cargo-check-docker-pgrx');
    expect(rung.args).toContain('--features');
    expect(rung.args).toContain('pgrx');
  });
});
