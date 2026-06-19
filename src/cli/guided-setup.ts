/**
 * Guided setup — the default arrow-key flow for `uap setup`.
 *
 * Walks the user through the essential configuration with @clack/prompts (via
 * the PromptUI abstraction), backs up their agent instruction files, offers to
 * extract unique custom content into policies/skills, then runs the same
 * in-process building blocks the scripted path uses (initCommand +
 * runSetupSteps) — no logic duplication. Smart defaults are derived from the
 * environment (docker/Qdrant, a local model endpoint) so the recommended path
 * is one Enter away.
 */

import chalk from 'chalk';
import { spawnSync } from 'child_process';
import { initCommand } from './init.js';
import { runSetupSteps, type SetupOptions } from './setup.js';
import { backupInstructionFiles } from './setup-backup.js';
import { extractInteractive } from './setup-extract.js';
import { isQdrantReachable } from './memory.js';
import { createClackUI, type PromptUI } from './prompt-ui.js';

interface HarnessChoice {
  label: string;
  value: string; // init platform token
}

const HARNESSES: HarnessChoice[] = [
  { label: 'Claude Code', value: 'claude' },
  { label: 'Factory.AI (droids)', value: 'factory' },
  { label: 'OpenCode', value: 'opencode' },
  { label: 'VS Code / Copilot', value: 'vscode' },
  { label: 'Codex', value: 'codex' },
];

function dockerAvailable(): boolean {
  try {
    return spawnSync('docker', ['--version'], { timeout: 4000, stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

/** Probe a couple of conventional local OpenAI-compatible endpoints. */
async function detectLocalModel(): Promise<string | null> {
  const candidates = [
    process.env.UAP_INFERENCE_ENDPOINT,
    process.env.OPENAI_BASE_URL,
    'http://localhost:8080/v1',
    'http://localhost:11434/v1',
  ].filter(Boolean) as string[];
  for (const base of candidates) {
    try {
      // Only probe http(s) endpoints, and never follow redirects — a misset
      // env URL shouldn't turn detection into an SSRF/redirect primitive.
      if (!/^https?:\/\//i.test(base)) continue;
      const url = base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`;
      const res = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: 'error' });
      if (res.ok) return base;
    } catch {
      /* not reachable */
    }
  }
  return null;
}

export async function runGuidedSetup(options: SetupOptions, injectedUi?: PromptUI): Promise<void> {
  const cwd = options.projectDir || process.cwd();
  const ui = injectedUi ?? (await createClackUI());

  ui.intro(chalk.bold('UAP guided setup'));

  // ── Environment detection → smart defaults ──────────────────────────
  const hasDocker = dockerAvailable();
  const localModel = await detectLocalModel();
  const qdrantUp = hasDocker ? await isQdrantReachable('http://localhost:6333', 1500) : false;

  if (localModel) ui.note(`Local model endpoint detected at ${localModel}`, 'Detected');

  // ── Harnesses ───────────────────────────────────────────────────────
  const platforms = await ui.multiselect<string>({
    message: 'Which AI coding harnesses should UAP wire up?',
    options: HARNESSES.map((h) => ({ label: h.label, value: h.value })),
    initialValues: ['claude'],
    required: true,
  });
  const platform = platforms.length > 0 ? platforms : ['claude'];

  // ── Memory (long-term / Qdrant) ─────────────────────────────────────
  const withMemory = await ui.confirm({
    message: hasDocker
      ? `Enable semantic memory (Qdrant)?${qdrantUp ? ' (already running)' : ' (Docker detected)'}`
      : 'Enable semantic memory (Qdrant)? (Docker not detected — will degrade gracefully)',
    initialValue: hasDocker,
  });

  // ── Pattern RAG ─────────────────────────────────────────────────────
  const withPatterns = await ui.confirm({
    message: 'Enable the pattern library + RAG indexing?',
    initialValue: true,
  });

  // ── Backup + extraction (operate on the ORIGINAL instruction files) ──
  if (options.backup !== false) {
    const b = backupInstructionFiles(cwd);
    if (b.backedUp.length > 0) {
      ui.note(`Backed up ${b.backedUp.length} file(s) → .uap-backups/${b.date}/`, 'Backup');
    }
  }
  if (options.extract !== false) {
    await extractInteractive(cwd, ui);
  }

  // ── Confirm + apply ─────────────────────────────────────────────────
  const proceed = await ui.confirm({
    message: `Apply setup for [${platform.join(', ')}], memory=${withMemory ? 'on' : 'off'}, patterns=${withPatterns ? 'on' : 'off'}?`,
    initialValue: true,
  });
  if (!proceed) {
    ui.outro(chalk.yellow('Setup cancelled — no further changes made.'));
    return;
  }

  // init already backed up above (pass backup:false to avoid a redundant pass).
  await initCommand({
    platform,
    memory: withMemory,
    patterns: withPatterns,
    worktrees: true,
    systemdServices: options.systemdServices,
    projectDir: cwd,
    backup: false,
  });

  await runSetupSteps(cwd, { ...options, memory: withMemory, patterns: withPatterns });

  ui.outro(chalk.green('✅ Setup complete. Your AI assistant is configured.'));
}
