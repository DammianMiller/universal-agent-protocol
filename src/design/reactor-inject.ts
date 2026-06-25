/**
 * Reactor hook for DESIGN.md: when a prompt or changed-file set indicates UI/UX
 * work, surface the project's design-system summary so new UI stays on-token
 * ("guide new"). Returns null when it's not UI work or the project has no
 * DESIGN.md — keeping the reactor silent for non-design tasks.
 */
import { extname } from 'path';
import { loadDesign, summarizeForReactor } from './tokens.js';

const UI_EXT = new Set(['.css', '.scss', '.sass', '.less', '.tsx', '.jsx', '.vue', '.svelte', '.html', '.astro']);

const UI_PROMPT_RE =
  /\b(ui|ux|css|scss|style|styl(?:e|ing)|button|component|colou?r|palette|theme|theming|design|layout|font|typograph|spacing|tailwind|frontend|front-end|page|screen|view|modal|navbar|sidebar|header|footer|card|form|landing|hero|brand)\b/i;

/** True when the reactor context looks like UI/UX work. */
export function isUiWork(promptText?: string, changedFiles?: string[]): boolean {
  if (changedFiles?.some((f) => UI_EXT.has(extname(f).toLowerCase()))) return true;
  if (promptText && UI_PROMPT_RE.test(promptText)) return true;
  return false;
}

/**
 * Build the design-system injection string, or null if not applicable.
 * `cwd` is the project root the reactor is operating in.
 */
export function maybeDesignInjection(
  cwd: string,
  promptText?: string,
  changedFiles?: string[]
): string | null {
  if (!isUiWork(promptText, changedFiles)) return null;
  let loaded: ReturnType<typeof loadDesign>;
  try {
    loaded = loadDesign(cwd);
  } catch {
    return null;
  }
  if (!loaded) return null;
  return summarizeForReactor(loaded.parsed);
}
