import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * U-J: multimodal critique turns must carry the LIVE numeric bars from the
 * resolved tier store, not only the static visual checklist.
 *
 * The static VISUAL & SYSTEMIC CRITIQUE checklist teaches the model how to
 * look; it cannot know the project's numeric quality contract. The tier
 * store (fleet ~/.uap/quality/tiers.json + project .uap/quality/tiers.json,
 * walked up from CWD with the proxy.env trust rules) holds per-axis
 * thresholds harvested from frontier exemplars or published from the
 * built-in class priors. proxy_tier_critique.py renders them into a compact
 * trailing-user-message directive so every capture-viewing turn grades the
 * artifact against its own bar — no reference media at request time.
 *
 * The behavior is exercised for real: the module runs under python3 against
 * actual store files on disk (same doctrine as the prune-breaker test), and
 * the proxy wiring is asserted at the injection site.
 */

const scriptsDir = join(process.cwd(), 'tools', 'agents', 'scripts');
const proxyPath = join(scriptsDir, 'anthropic_proxy.py');

const FRONTIER_PROFILE = {
  key: 'visual-scene/frontier-prior',
  anchorCount: 0,
  builtin: true,
  tolerance: 0.75,
  thresholds: {
    colors12: { min: 886.5 },
    edgeFrac: { min: 0.08777 },
    glowFrac: { min: 0.00461, max: 0.3422 },
    darkFrac: { max: 0.02085 },
    contrast: { min: 0.15082, max: 0.32581 },
    valMean: { min: 0.57823 },
    satMean: { min: 0.21473, max: 0.51231 },
  },
};

const storeFile = (tiers: Record<string, unknown>): string =>
  JSON.stringify({ version: 1, tiers });

function runPython(body: string): string {
  const r = spawnSync('python3', ['-c', body], { encoding: 'utf-8', timeout: 30_000 });
  expect(r.status, `python driver failed: ${r.stderr}`).toBe(0);
  return r.stdout.trim();
}

/** Run build_digest for real against on-disk stores and return its text. */
function digest(env: Record<string, string>, cwd: string | null): string {
  const out = runPython(`
import sys, json
sys.path.insert(0, ${JSON.stringify(scriptsDir)})
import proxy_tier_critique as ptc
env = json.loads(${JSON.stringify(JSON.stringify(env))})
cwd = ${cwd === null ? 'None' : JSON.stringify(cwd)}
print(json.dumps({"digest": ptc.build_digest(env, cwd)}))
`);
  return (JSON.parse(out.split('\n').pop() ?? '{}').digest ?? '') as string;
}

describe('U-J live tier bars (proxy_tier_critique)', () => {
  const python = spawnSync('python3', ['--version'], { encoding: 'utf-8' }).status === 0;

  it.skipIf(!python)('renders the resolved fleet-store tier as a live-bars directive', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tier-critique-'));
    const fleet = join(dir, 'fleet.json');
    writeFileSync(fleet, storeFile({ 'visual-scene/frontier-prior': FRONTIER_PROFILE }));
    const d = digest({ UAP_TIER_STORE: fleet, HOME: dir }, dir);
    expect(d).toContain('LIVE QUALITY BARS');
    expect(d).toContain('- visual-scene/frontier-prior:');
    expect(d).toContain('colors12 >=886.5');
    expect(d).toContain('edgeFrac >=0.08777');
    expect(d).toContain('glowFrac in [0.00461,0.3422]');
    expect(d).toContain('darkFrac <=0.02085');
    expect(d).toContain('satMean in [0.21473,0.51231]');
    expect(d).toContain('uap quality gap --file <artifact> --tier <key>');
    expect(d).toContain('worst-first');
  });

  it.skipIf(!python)('project store overrides the fleet store and the tier cap holds', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tier-critique-'));
    const fleet = join(dir, 'fleet.json');
    writeFileSync(
      fleet,
      storeFile({
        'a/one': { thresholds: { colors12: { min: 100 } } },
        'b/two': { thresholds: { edgeFrac: { min: 0.1 } } },
      }),
    );
    const proj = join(dir, 'proj');
    mkdirSync(join(proj, '.uap', 'quality'), { recursive: true });
    writeFileSync(
      join(proj, '.uap', 'quality', 'tiers.json'),
      storeFile({
        'a/one': { thresholds: { colors12: { min: 999 } } },
        'c/three': { thresholds: { valMean: { min: 0.5 } } },
      }),
    );
    const d = digest(
      { UAP_TIER_STORE: fleet, HOME: dir, PROXY_TIER_CRITIQUE_MAX_TIERS: '2' },
      proj,
    );
    const lines = d.split('\n').filter((l) => l.startsWith('- '));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('a/one');
    expect(lines[0]).toContain('colors12 >=999'); // project value wins
    expect(lines[1]).toContain('b/two'); // sorted order; cap cuts c/three
  });

  it.skipIf(!python)('fails open: absent fleet file and corrupt project store yield no digest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tier-critique-'));
    const proj = join(dir, 'proj');
    mkdirSync(join(proj, '.uap', 'quality'), { recursive: true });
    writeFileSync(join(proj, '.uap', 'quality', 'tiers.json'), '{not json');
    const d = digest({ UAP_TIER_STORE: join(dir, 'absent.json'), HOME: dir }, proj);
    expect(d).toBe('');
  });

  it.skipIf(!python)('off switch silences the digest even with a resolved tier', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tier-critique-'));
    const fleet = join(dir, 'fleet.json');
    writeFileSync(fleet, storeFile({ 'visual-scene/frontier-prior': FRONTIER_PROFILE }));
    const d = digest({ UAP_TIER_STORE: fleet, HOME: dir, PROXY_TIER_CRITIQUE: 'off' }, dir);
    expect(d).toBe('');
  });

  it.skipIf(!python)('follows a worktree .git file to the main checkout and stops at repo roots', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tier-critique-'));
    // Decoy OUTSIDE the repo: the upward walk must never reach it.
    mkdirSync(join(dir, '.uap', 'quality'), { recursive: true });
    writeFileSync(
      join(dir, '.uap', 'quality', 'tiers.json'),
      storeFile({ 'x/outer': { thresholds: { colors12: { min: 1 } } } }),
    );
    const main = join(dir, 'main');
    mkdirSync(join(main, '.git', 'worktrees', 'wt'), { recursive: true });
    mkdirSync(join(main, '.uap', 'quality'), { recursive: true });
    writeFileSync(
      join(main, '.uap', 'quality', 'tiers.json'),
      storeFile({ 'w/tier': { thresholds: { colors12: { min: 42 } } } }),
    );
    const wt = join(main, '.worktrees', 'wt', 'deep', 'deeper');
    mkdirSync(wt, { recursive: true });
    writeFileSync(
      join(main, '.worktrees', 'wt', '.git'),
      `gitdir: ${join(main, '.git', 'worktrees', 'wt')}\n`,
    );
    const d = digest({ UAP_TIER_STORE: join(dir, 'absent.json'), HOME: dir }, wt);
    expect(d).toContain('w/tier');
    expect(d).toContain('colors12 >=42');
    expect(d).not.toContain('x/outer'); // walk stopped at the repo root
  });

  it.skipIf(!python)('formats threshold rules and rejects unusable profiles', () => {
    const out = runPython(`
import sys, json
sys.path.insert(0, ${JSON.stringify(scriptsDir)})
import proxy_tier_critique as ptc
print(json.dumps({
  "min": ptc.format_rule({"min": 5}),
  "max": ptc.format_rule({"max": 0.5}),
  "band": ptc.format_rule({"min": 0.00461, "max": 0.3422}),
  "empty": ptc.format_rule({}),
  "bad": ptc.format_rule({"min": "x"}),
  "notdict": ptc.format_rule(7),
  "tierEmpty": ptc.render_tier("k", {"thresholds": {}}),
  "tierBad": ptc.render_tier("k", {}),
}))
`);
    const cases = JSON.parse(out.split('\n').pop() ?? '{}');
    expect(cases.min).toBe('>=5');
    expect(cases.max).toBe('<=0.5');
    expect(cases.band).toBe('in [0.00461,0.3422]');
    expect(cases.empty).toBeNull();
    expect(cases.bad).toBeNull();
    expect(cases.notdict).toBeNull();
    expect(cases.tierEmpty).toBeNull();
    expect(cases.tierBad).toBeNull();
  });

  it('wires the digest into the multimodal critique turn inside the gate', () => {
    const src = readFileSync(proxyPath, 'utf-8');
    expect(src).toContain('PROXY_TIER_CRITIQUE = os.environ.get(');
    expect(src).toContain('from proxy_tier_critique import build_digest as _tier_critique_digest');
    expect(src).toContain('if PROXY_TIER_CRITIQUE and _TIER_CRITIQUE_OK:');
    expect(src).toContain('_append_directive_to_trailing_user(openai_body, tier_bars)');
    const checklist = src.indexOf('MULTIMODAL CRITIQUE: injected generalized visual/systemic checklist');
    const tierLog = src.indexOf('TIER CRITIQUE: injected live tier bars at trailing user message');
    expect(checklist).toBeGreaterThan(-1);
    expect(tierLog).toBeGreaterThan(checklist);
    // The tier injection lives INSIDE the multimodal-observation critique gate
    // and rides the trailing user message (prefix-cache invariant).
    const gate = src.lastIndexOf('cognitive_signal == "multimodal_observation"', tierLog);
    expect(gate).toBeGreaterThan(-1);
    expect(tierLog - gate).toBeLessThan(1200);
  });
});
