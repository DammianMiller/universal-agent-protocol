/**
 * Rule-1 stance resolution: per project, asked once per session.
 *
 * "Do not preserve backward compatibility" is excellent advice for a side
 * project and destructive on a published one, so it is not a fixed policy
 * setting. The stance (and the project's maturity, which tunes how absolute the
 * other rules read) is resolved through:
 *
 *     env override  ->  this session's answer  ->  project default  ->  UNRESOLVED
 *
 * UNRESOLVED is a real state, distinct from an explicit 'ask'. It is what makes
 * the reactor prompt the user once, and it is why config reads go through
 * `loadUapConfigRaw`: a zod `.default()` would fabricate a stance the user never
 * chose, and the whole point is to not guess this one.
 *
 * Unattended callers (deliver) never block on it — they fall back to `preserve`,
 * the answer that cannot delete anything, and say so.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { readPrinciplesConfig } from './config.js';
import type { CompatStance, Maturity } from './rules.js';

export type StanceSource = 'env' | 'session' | 'config' | 'unresolved';

export interface ResolvedStance {
  compat: CompatStance | null;
  compatSource: StanceSource;
  maturity: Maturity | null;
  maturitySource: StanceSource;
}

interface SessionRecord {
  compat?: CompatStance;
  maturity?: Maturity;
  at?: string;
}

type SessionFile = Record<string, SessionRecord>;

const COMPAT_VALUES = new Set<string>(['preserve', 'remove']);
const MATURITY_VALUES = new Set<string>(['greenfield', 'production']);

/** Session-scoped answers live beside the other per-run state. */
export function sessionStorePath(cwd: string): string {
  return join(cwd, '.uap', 'principles-session.json');
}

/**
 * Identify the session the same way the session-start hook does, so a stance
 * recorded by the CLI is the one the reactor sees.
 *
 * The fallback is a DAY key, not the hook's `ppid-$PPID`. Hooks run as children
 * of the long-lived agent process, so their PPID is stable for the session; the
 * CLI is typically spawned from a throwaway shell, so a PPID key changes
 * between two commands a second apart — the user would answer, and be asked
 * again immediately. Degrading to once-per-project-per-day errs toward asking
 * too rarely, which is the harmless direction for a setting that changes about
 * once in a project's life.
 */
export function sessionId(env: NodeJS.ProcessEnv = process.env): string {
  const explicit =
    env.CLAUDE_SESSION_ID ||
    env.FACTORY_SESSION_ID ||
    env.CURSOR_SESSION_ID ||
    env.UAP_SESSION_ID;
  return explicit || dayKey(0);
}

function dayKey(daysAgo: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return `day-${d.toISOString().slice(0, 10)}`;
}

/**
 * Keys to look under, most specific first.
 *
 * When the key is the day fallback, yesterday's counts too. A session running
 * across UTC midnight would otherwise lose its answer: the day key rolls over,
 * the stance reads unresolved again — and because the reactor already surfaced
 * the question earlier in that session, it never asks again. The user would
 * have answered, and the run would silently revert to the assumed default.
 */
function lookupKeys(env: NodeJS.ProcessEnv): string[] {
  const id = sessionId(env);
  return id.startsWith('day-') ? [id, dayKey(1)] : [id];
}

function readSessionFile(cwd: string): SessionFile {
  const p = sessionStorePath(cwd);
  if (!existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as SessionFile) : {};
  } catch {
    // A corrupt store means "no answer yet", never a crash.
    return {};
  }
}

function asCompat(v: unknown): CompatStance | null {
  return typeof v === 'string' && COMPAT_VALUES.has(v) ? (v as CompatStance) : null;
}

function asMaturity(v: unknown): Maturity | null {
  return typeof v === 'string' && MATURITY_VALUES.has(v) ? (v as Maturity) : null;
}

/**
 * Project defaults.
 *
 * `principles.compat: 'ask'` is a deliberate "keep asking" and must not resolve
 * to a value; only 'preserve'/'remove' do. An absent key is likewise unresolved.
 */
function configStance(cwd: string): { compat: CompatStance | null; maturity: Maturity | null } {
  const config = readPrinciplesConfig(cwd);
  return { compat: asCompat(config.compat), maturity: asMaturity(config.maturity) };
}

/** Resolve the stance for this project + session. */
export function resolveStance(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env
): ResolvedStance {
  const file = readSessionFile(cwd);
  const session = lookupKeys(env).map((k) => file[k]).find((r) => r?.compat || r?.maturity) ?? {};
  const config = configStance(cwd);

  const envCompat = asCompat(env.UAP_PRINCIPLES_COMPAT);
  const envMaturity = asMaturity(env.UAP_PRINCIPLES_MATURITY);

  const compat = envCompat ?? asCompat(session.compat) ?? config.compat;
  const maturity = envMaturity ?? asMaturity(session.maturity) ?? config.maturity;

  return {
    compat,
    compatSource: envCompat
      ? 'env'
      : asCompat(session.compat)
        ? 'session'
        : config.compat
          ? 'config'
          : 'unresolved',
    maturity,
    maturitySource: envMaturity
      ? 'env'
      : asMaturity(session.maturity)
        ? 'session'
        : config.maturity
          ? 'config'
          : 'unresolved',
  };
}

/** True when the user has not answered for this session and no default applies. */
export function needsAsking(stance: ResolvedStance): boolean {
  return stance.compat === null || stance.maturity === null;
}

/**
 * The stance an UNATTENDED run should use.
 *
 * `preserve` on purpose: nobody is present to answer, and of the two answers
 * only one can delete a migration path that turns out to be load-bearing.
 */
export function stanceForUnattended(stance: ResolvedStance): {
  compat: CompatStance;
  maturity: Maturity;
  /**
   * Whether COMPAT specifically was assumed — not whether anything was.
   *
   * It drives the "assuming preserve" disclosure in the rendered block, so it
   * must track the field that disclosure is about. Keyed off `needsAsking` it
   * would fire whenever MATURITY alone was unanswered, printing "assuming
   * preserve" directly beneath a rule 1 that says to delete obsolete paths —
   * and answering the two independently is a normal flow (`uap principles
   * compat …` and `uap principles maturity …` are separate commands).
   */
  assumed: boolean;
} {
  return {
    compat: stance.compat ?? 'preserve',
    maturity: stance.maturity ?? 'production',
    assumed: stance.compat === null,
  };
}

/** Record this session's answer. Returns the path written. */
export function recordStance(
  cwd: string,
  answer: { compat?: CompatStance; maturity?: Maturity },
  env: NodeJS.ProcessEnv = process.env
): string {
  const p = sessionStorePath(cwd);
  mkdirSync(dirname(p), { recursive: true });

  const file = readSessionFile(cwd);
  const id = sessionId(env);
  file[id] = {
    ...(file[id] ?? {}),
    ...(answer.compat ? { compat: answer.compat } : {}),
    ...(answer.maturity ? { maturity: answer.maturity } : {}),
    at: new Date().toISOString(),
  };

  writeFileSync(p, JSON.stringify(file, null, 2) + '\n');
  return p;
}
