/**
 * Dashboard bundle reader for tests.
 *
 * PR #410 (dashboard-uplift) turned web/dashboard.html into a thin shell and
 * moved the real content into web/dash/ modules (core.js, tabs.js, charts.js,
 * styles.css, tab-*.js). Tests that assert "the dashboard contains X" should
 * assert against the whole bundle so they stay robust to content moving
 * between modules in future uplift phases.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let cached: string | null = null;

/** web/dashboard.html + every web/dash/*.js|*.css file, concatenated. */
export function dashboardBundle(): string {
  if (cached !== null) return cached;
  const parts = [readFileSync(join(ROOT, 'web', 'dashboard.html'), 'utf-8')];
  const dashDir = join(ROOT, 'web', 'dash');
  for (const f of readdirSync(dashDir).sort()) {
    if (f.endsWith('.js') || f.endsWith('.css')) {
      parts.push(readFileSync(join(dashDir, f), 'utf-8'));
    }
  }
  cached = parts.join('\n');
  return cached;
}
