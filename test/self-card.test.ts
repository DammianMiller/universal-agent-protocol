/**
 * S2 · Self-knowledge card — generator, version-pinned cache, offline search,
 * and the `uap self` CLI surface.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildSelfCard,
  ensureSelfCard,
  parseCliIndex,
  parseFeatures,
  searchSelfCard,
  selfCardPath,
  selfCardPackageRoot,
  installedUapVersion,
} from '../src/generators/self-card.js';
import { selfCommand } from '../src/cli/self.js';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'uap-selfcard-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.UAP_STATE_DIR;
  process.exitCode = undefined;
});

const CLI_MD = `# UAP CLI Reference

## Command index

| Command | Purpose |
|---------|---------|
| [\`init\`](#init) | Initialize agent context in the current project |
| [\`bench\`](#bench) | Controlled paired benchmark with confidence intervals |
| [\`handsfree\`](#handsfree) (\`hf\`) | Hands-free persistence: loop any model to a 100% ledger |

## init

Details for init live here and must not pollute the command index.
`;

const FEATURES_MD = `# Feature Catalog

## Delivery (\`src/delivery/\`) — Build & QC

| Feature | Description |
|---------|-------------|
| Convergence loop (\`convergence-loop.ts\`) | The main delivery loop that keeps building until gates pass. |
| Verifier ladder (\`verifier-ladder.ts\`) | Build/typecheck/test/lint gate ladder — ${'the QC checks that prove the result actually runs rather than merely looking right. '.repeat(4)} |

## Memory (\`src/memory/\`) — Intake

| Feature | Description |
|---------|-------------|
| Write gate (\`write-gate.ts\`) | Quality filter for what gets written to memory. |
`;

/** A throwaway package root carrying minimal versions of the shipped docs. */
function fixturePackageRoot(): string {
  const root = tmp();
  mkdirSync(join(root, 'docs', 'reference'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@miller-tech/uap', version: '9.9.9-fixture' }));
  writeFileSync(join(root, 'docs', 'reference', 'CLI.md'), CLI_MD);
  writeFileSync(join(root, 'docs', 'reference', 'FEATURES.md'), FEATURES_MD);
  return root;
}

describe('self-card source parsers', () => {
  it('extracts the command index, aliases and all', () => {
    const commands = parseCliIndex(CLI_MD);
    expect(commands.map((c) => c.command)).toEqual(['init', 'bench', 'handsfree']);
    const hf = commands.find((c) => c.command === 'handsfree');
    expect(hf?.purpose).toContain('Hands-free persistence');
    expect(hf?.aliases).toEqual(['hf']);
    // The "## init" detail section must not leak into the index.
    expect(commands.every((c) => !c.purpose.includes('Details for init'))).toBe(true);
  });

  it('extracts feature rows with their subsystem, capping descriptions', () => {
    const features = parseFeatures(FEATURES_MD);
    expect(features).toHaveLength(3);
    expect(features[0].subsystem).toContain('Delivery');
    expect(features[0].feature).toBe('Convergence loop (convergence-loop.ts)');
    const ladder = features.find((f) => f.feature.startsWith('Verifier ladder'));
    expect(ladder?.description.length).toBeLessThanOrEqual(221);
    expect(ladder?.description.endsWith('…')).toBe(true);
  });
});

describe('self-card build', () => {
  it('pins the installed version and builds deterministically', () => {
    const root = fixturePackageRoot();
    expect(installedUapVersion(root)).toBe('9.9.9-fixture');
    const first = buildSelfCard(root);
    const second = buildSelfCard(root);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(first.card.fingerprint).toBe(second.card.fingerprint);
    expect(first.card.markdown).toBe(second.card.markdown);
    expect(first.card.markdown).toContain('## Command index (3)');
    expect(first.card.markdown).toContain('- `bench` — Controlled paired benchmark');
    expect(first.card.markdown).toContain('- `handsfree` (hf) — Hands-free persistence');
    expect(first.card.markdown).toContain('### Memory (`src/memory/`) — Intake');
  });

  it('fails open with a reason when the shipped docs are absent or empty', () => {
    const empty = buildSelfCard(tmp());
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.reason).toContain('shipped docs');

    const blank = tmp();
    mkdirSync(join(blank, 'docs', 'reference'), { recursive: true });
    writeFileSync(join(blank, 'docs', 'reference', 'CLI.md'), 'nothing here');
    writeFileSync(join(blank, 'docs', 'reference', 'FEATURES.md'), 'also nothing');
    const parsed = buildSelfCard(blank);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain('empty card');
  });
});

describe('self-card version-pinned cache', () => {
  it('writes once, reuses while the pin matches, regenerates on source drift', () => {
    const root = fixturePackageRoot();
    const project = tmp();
    const path = selfCardPath(project);

    const first = ensureSelfCard(project, { packageRoot: root });
    expect(first.ok).toBe(true);
    expect(first.fresh).toBe(true);
    expect(existsSync(path)).toBe(true);
    const firstBytes = readFileSync(path, 'utf-8');
    expect(firstBytes).toContain('uap-self-card version=9.9.9-fixture');

    const second = ensureSelfCard(project, { packageRoot: root });
    expect(second.fresh).toBe(false);
    expect(readFileSync(path, 'utf-8')).toBe(firstBytes);

    // Source drift (a shipped doc changed) must invalidate the pin.
    writeFileSync(join(root, 'docs', 'reference', 'FEATURES.md'), FEATURES_MD + '\n| New thing | A late addition. |\n');
    const drifted = ensureSelfCard(project, { packageRoot: root });
    expect(drifted.fresh).toBe(true);
    expect(readFileSync(path, 'utf-8')).toContain('New thing');

    // Refresh forces a rewrite even without drift.
    const refreshed = ensureSelfCard(project, { packageRoot: root, refresh: true });
    expect(refreshed.fresh).toBe(true);
  });

  it('honors an absolute UAP_STATE_DIR like the plan gate does', () => {
    const root = fixturePackageRoot();
    const project = tmp();
    const state = tmp();
    process.env.UAP_STATE_DIR = state;
    const result = ensureSelfCard(project, { packageRoot: root });
    expect(result.ok).toBe(true);
    expect(result.path).toBe(join(state, 'self-card.md'));
    expect(existsSync(join(state, 'self-card.md'))).toBe(true);
  });
});

describe('self-card offline search', () => {
  it('ranks the matching command first on keyword and prefix matches', () => {
    const root = fixturePackageRoot();
    const build = buildSelfCard(root);
    expect(build.ok).toBe(true);
    if (!build.ok) return;
    const hits = searchSelfCard(build.card.markdown, 'how do I run a controlled benchmark');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].text).toContain('`bench`');
    expect(hits[0].score).toBeGreaterThan(0);
  });

  it('finds a command by alias and respects the limit', () => {
    const root = fixturePackageRoot();
    const build = buildSelfCard(root);
    if (!build.ok) return;
    const byAlias = searchSelfCard(build.card.markdown, 'hf handsfree loop ledger');
    expect(byAlias[0].text).toContain('handsfree');
    expect(searchSelfCard(build.card.markdown, 'ledger', 1)).toHaveLength(1);
  });

  it('returns nothing for stopword-only or unknown queries', () => {
    const root = fixturePackageRoot();
    const build = buildSelfCard(root);
    if (!build.ok) return;
    expect(searchSelfCard(build.card.markdown, 'how do I the a')).toEqual([]);
    expect(searchSelfCard(build.card.markdown, 'zzzqx')).toEqual([]);
  });
});

describe('self-card regression against the REAL shipped docs', () => {
  /**
   * The card is built from docs/reference/CLI.md + FEATURES.md, which ship in
   * the npm package (package.json `files`). A docs restructure that changes
   * the `## Command index` heading or table shape would silently empty the
   * card (fail-open ok:false) while every fixture-based test stays green.
   * This canary parses the REAL docs — including this feature's own `self`
   * row — so a restructure fails HERE, at the source of truth.
   */
  it('builds a non-empty card from the repo docs, knowing its own new commands', () => {
    const build = buildSelfCard(selfCardPackageRoot());
    expect(build.ok).toBe(true);
    if (!build.ok) return;
    expect(build.card.commands.length).toBeGreaterThan(20);
    expect(build.card.features.length).toBeGreaterThan(20);
    expect(build.card.commands.some((c) => c.command === 'self')).toBe(true);
    expect(build.card.commands.some((c) => c.command === 'plan')).toBe(true);
    // Table-header rows must not leak in as features (the positional skip).
    expect(build.card.features.some((f) => f.feature === 'Subsystem' || f.feature === 'Feature')).toBe(false);
  });
});

describe('uap self CLI', () => {
  it('card --json reports the built card', async () => {
    const root = fixturePackageRoot();
    const project = tmp();
    const ensure = (cwd: string, opts: { refresh?: boolean } = {}) =>
      ensureSelfCard(cwd, { ...opts, packageRoot: root });
    let out = '';
    const orig = console.log;
    console.log = (s?: unknown) => { out += String(s); };
    try {
      await selfCommand(undefined, undefined, { json: true }, project, { ensure });
    } finally {
      console.log = orig;
    }
    const parsed = JSON.parse(out) as { ok: boolean; version: string; commands: number; fresh: boolean };
    expect(parsed.ok).toBe(true);
    expect(parsed.version).toBe('9.9.9-fixture');
    expect(parsed.commands).toBe(3);
    expect(parsed.fresh).toBe(true);
    expect(existsSync(selfCardPath(project))).toBe(true);
  });

  it('query --json returns ranked hits from the card', async () => {
    const root = fixturePackageRoot();
    const project = tmp();
    const ensure = (cwd: string, opts: { refresh?: boolean } = {}) =>
      ensureSelfCard(cwd, { ...opts, packageRoot: root });
    let out = '';
    const orig = console.log;
    console.log = (s?: unknown) => { out += String(s); };
    try {
      await selfCommand('query', 'controlled benchmark', { json: true }, project, { ensure });
    } finally {
      console.log = orig;
    }
    const parsed = JSON.parse(out) as { ok: boolean; results: { text: string }[] };
    expect(parsed.ok).toBe(true);
    expect(parsed.results[0].text).toContain('`bench`');
  });

  it('exits 1 with a reason when no card can be built', async () => {
    const project = tmp();
    const orig = console.error;
    console.error = () => {};
    try {
      await selfCommand(undefined, undefined, {}, project, {
        ensure: () => ({ ok: false as const, reason: 'shipped docs not found', path: selfCardPath(project), fresh: false }),
      });
      expect(process.exitCode).toBe(1);
    } finally {
      console.error = orig;
      process.exitCode = undefined;
    }
  });
});
