/**
 * Mission-named file tracking, shared by the epic split planner and the
 * convergence loop's per-turn feedback.
 *
 * Lives in its own module (not epic-mission.ts) so convergence-loop.ts can
 * import it without a runtime cycle — epic-mission imports the loop's types.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Mission-named files absent from the tree. Extracts path-like tokens and
 * bare filenames from the mission text and reports the ones with no matching
 * basename anywhere in the (bounded) tree walk. Run V (octopus variant,
 * 2026-07-18): the model shipped its own flat layout while the mission
 * prescribed js/enemies.js, js/particles.js, js/ui.js, css/styles.css — the
 * divergence only surfaced when the acceptance judge failed the run late.
 */
export function missingMissionFiles(projectRoot: string, mission: string): string[] {
  const tokens = new Set<string>();
  for (const m of mission.matchAll(/[\w.@-]+(?:\/[\w.@-]+)+/g)) {
    const t = m[0].replace(/[.,;:)]+$/, '');
    if (!t.includes('//') && !t.startsWith('http')) tokens.add(t);
  }
  for (const m of mission.matchAll(/\b[\w-]+\.(?:html|css|md|js|mjs|cjs|ts|tsx|json|py|rs|go)\b/g)) {
    tokens.add(m[0]);
  }
  const existingBases = new Set<string>();
  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return;
    let entries;
    try {
      entries = readdirSync(join(projectRoot, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist') continue;
      if (e.isDirectory()) walk(dir ? `${dir}/${e.name}` : e.name, depth + 1);
      else existingBases.add(e.name.toLowerCase());
    }
  };
  walk('', 0);
  const missing: string[] = [];
  for (const t of tokens) {
    const base = (t.split('/').pop() ?? t).toLowerCase();
    if (!base.includes('.')) continue; // directories are not deliverable files
    if (!existingBases.has(base)) missing.push(t);
  }
  return [...new Set(missing)].sort();
}

/**
 * Append a loud missing-mission-files line to a failed turn's gate feedback,
 * so the executor learns about layout divergence on the turn it happens —
 * not attempts later from a split planner or the acceptance judge. Fail-soft:
 * any error returns the feedback unchanged.
 */
export function appendMissingFilesNote(
  feedback: string | undefined,
  projectRoot: string,
  mission: string
): string | undefined {
  try {
    const missing = missingMissionFiles(projectRoot, mission).slice(0, 12);
    if (missing.length === 0) return feedback;
    const note =
      `MISSION FILES STILL MISSING: the mission names these paths but no file with that basename exists anywhere in the tree: ${missing.join(', ')}. ` +
      'Create them (or move existing code to the named paths) — the gates and the acceptance judge check the mission\'s layout.';
    return feedback ? `${feedback}\n\n${note}` : note;
  } catch {
    return feedback;
  }
}
