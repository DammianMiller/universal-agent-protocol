/**
 * `uap interaction` — mine probes from the requirements, then play the artifact
 * through them.
 *
 * `mine`   derive a manifest from the requirements + source and write it to
 *          .uap/interaction/manifest.json
 * `run`    execute the manifest against the built artifact and report
 * `status` show what is covered and whether the manifest still matches the
 *          requirements it was mined from
 */

import chalk from 'chalk';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { detectArtifactType, findWebEntry } from '../delivery/execution-gate.js';
import { runInteractionGate, interactionSummary } from '../delivery/interaction-gate.js';
import {
  coverageOf,
  loadManifest,
  manifestIsStale,
  manifestPath,
  saveManifest,
} from '../delivery/interaction/manifest.js';
import { mineManifest } from '../delivery/interaction/mine.js';
import { resolveAcceptanceSpecAuto } from './verify.js';
import type { LoopExecutor } from '../delivery/convergence-loop.js';
import type { ArtifactKind, ProbeMode } from '../delivery/interaction/types.js';

export interface InteractionOptions {
  dir?: string;
  spec?: string;
  modes?: string;
  strictCoverage?: boolean;
  model?: string;
  endpoint?: string;
  json?: boolean;
}

const SOURCE_EXTS = new Set(['.js', '.mjs', '.ts', '.jsx', '.tsx', '.html']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.uap', 'coverage']);

/**
 * A digest of the artifact's source so the miner writes probes against REAL
 * identifiers. Without it the model invents plausible-looking observables that
 * do not exist, and every probe then fails as a phantom defect.
 */
export function collectSourceDigest(root: string, budget = 24_000): string {
  const parts: string[] = [];
  let used = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > 4 || used >= budget) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (used >= budget) return;
      if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!SOURCE_EXTS.has(extname(name))) continue;
      try {
        const text = readFileSync(full, 'utf-8');
        const slice = text.slice(0, Math.max(0, Math.min(6_000, budget - used)));
        parts.push(`\n--- ${relative(root, full)} ---\n${slice}`);
        used += slice.length;
      } catch {
        /* unreadable file → skipped */
      }
    }
  };
  walk(root, 0);
  return parts.join('\n');
}

async function buildExecutor(modelPreset?: string, endpoint?: string): Promise<LoopExecutor | null> {
  try {
    const { OpenAICompatClient } = await import('../models/openai-compat-client.js');
    const { ModelPresets } = await import('../models/types.js');
    const presetId = modelPreset ?? process.env.UAP_DELIVER_MODEL ?? 'qwen35-a3b';
    const model = ModelPresets[presetId];
    if (!model) return null;
    const resolved = endpoint ? { ...model, endpoint } : model;
    const client = new OpenAICompatClient();
    return async (prompt: string) => (await client.complete(resolved, prompt, { temperature: 0.1 })).content;
  } catch {
    // No model is not an error: mining falls back to the deterministic baseline.
    return null;
  }
}

function parseModes(raw?: string): ProbeMode[] {
  if (!raw) return ['core'];
  const valid: ProbeMode[] = ['core', 'soak', 'accelerated'];
  const picked = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is ProbeMode => (valid as string[]).includes(s));
  return picked.length > 0 ? picked : ['core'];
}

export async function interactionCommand(
  action: string | undefined,
  options: InteractionOptions = {}
): Promise<void> {
  const dir = options.dir ?? process.cwd();
  const verb = action ?? 'status';

  if (verb === 'mine') {
    const specText = options.spec
      ? (() => {
          try {
            return readFileSync(options.spec as string, 'utf-8');
          } catch {
            return '';
          }
        })()
      : (resolveAcceptanceSpecAuto(dir) ?? '');
    if (!specText.trim()) {
      process.stderr.write(
        'uap interaction mine: no requirements found. Pass --spec <file>, or add ' +
          '.uap/acceptance.md / REQUIREMENTS.md so probes can be derived from something.\n'
      );
      process.exit(2);
      return;
    }
    // `detectArtifactType` returns 'web' | 'node' | 'cli' | 'lib' — a straight
    // cast to ArtifactKind would write `kind: 'lib'`, which never validates, so
    // the manifest would fail to load forever and the gate would report "no
    // manifest" (i.e. pass) on every run afterwards.
    const detected = detectArtifactType(dir);
    const web = findWebEntry(dir);
    const kind: ArtifactKind | null = web ? 'web' : detected === 'cli' ? 'cli' : null;
    if (!kind) {
      process.stderr.write(
        `uap interaction mine: no interactive artifact found in ${dir} ` +
          `(detected: ${detected ?? 'nothing'}). The interaction gate needs a web entry point.\n`
      );
      process.exit(2);
      return;
    }
    const executor = await buildExecutor(options.model, options.endpoint);
    let manifest;
    try {
      manifest = await mineManifest({
        projectRoot: dir,
        kind,
        // Never hardcode index.html: findWebEntry supports any .html, and
        // keying off index.html alone makes the driver request a path the
        // server 404s, which then reads as an artifact defect.
        entry: web?.entry ?? 'index.html',
        specText,
        sourceDigest: collectSourceDigest(web?.dir ?? dir),
        ...(executor ? { executor } : {}),
      });
    } catch (e) {
      process.stderr.write(`uap interaction mine: ${String(e)}\n`);
      process.exit(1);
      return;
    }
    const path = saveManifest(dir, manifest);
    const ledger = coverageOf(manifest);
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ path, manifest, coverage: ledger }, null, 2)}\n`);
      return;
    }
    process.stdout.write(
      `${chalk.green('✓')} mined ${manifest.probes.length} probe(s) for ${manifest.requirements.length} requirement(s) → ${path}\n`
    );
    if (!executor) {
      process.stdout.write(
        chalk.yellow(
          '  no model available — wrote the deterministic baseline only. ' +
            'Artifact-specific probes need a model preset (-m).\n'
        )
      );
    }
    if (ledger.uncovered.length > 0) {
      process.stdout.write(
        chalk.yellow(`  ${ledger.uncovered.length} requirement(s) have no probe — they are unverified.\n`)
      );
    }
    return;
  }

  if (verb === 'run') {
    const verdict = await runInteractionGate(dir, {
      modes: parseModes(options.modes),
      ...(options.strictCoverage ? { strictCoverage: true } : {}),
    });
    if (options.json) {
      process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
    } else {
      process.stdout.write(`${verdict.feedback}\n`);
    }
    // Exit non-zero on a real behavioural failure so CI and hooks can gate on
    // it; a skip (no manifest, no browser) stays 0 and says so.
    process.exit(verdict.passed || verdict.skipped ? 0 : 1);
    return;
  }

  // status
  const manifest = loadManifest(dir);
  if (!manifest) {
    const path = manifestPath(dir);
    const exists = existsSync(path);
    process.stdout.write(
      exists
        ? `${chalk.red('✗')} ${path} exists but is invalid — re-run \`uap interaction mine\`.\n`
        : `${chalk.dim('·')} no interaction manifest. Run \`uap interaction mine\` to derive probes from the requirements.\n`
    );
    process.exit(exists ? 1 : 0);
    return;
  }
  const ledger = coverageOf(manifest);
  const specText = resolveAcceptanceSpecAuto(dir);
  const stale = specText ? manifestIsStale(manifest, specText) : false;
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ manifest, coverage: ledger, stale }, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    `${chalk.bold('interaction manifest')} — ${manifest.probes.length} probe(s), ` +
      `requirements covered ${ledger.covered}/${ledger.total}\n`
  );
  for (const p of manifest.probes) {
    process.stdout.write(`  ${chalk.dim(p.mode.padEnd(11))} ${p.id} — ${p.description}\n`);
  }
  if (ledger.uncovered.length > 0) {
    process.stdout.write(chalk.yellow(`\n  unverified requirements:\n`));
    for (const r of ledger.uncovered) process.stdout.write(`    ${r.id}: ${r.text}\n`);
  }
  if (stale) {
    process.stdout.write(
      chalk.yellow('\n  ⚠ the requirements changed since these probes were mined — re-run `uap interaction mine`.\n')
    );
  }
}

export { interactionSummary };
