/**
 * user-validation: exercise the delivered artifact through the SAME CLIENT a
 * real user would use, and refuse DELIVERED until the critical paths pass.
 *
 * - browser paths: headless Chromium (cloakbrowser via WebBrowser) — real DOM
 *   interaction with console-error capture. `curl 200` does not count.
 * - http paths:    real HTTP requests against the actually-started server.
 * - cli paths:     the built artifact spawned with real argv.
 *
 * The runner interprets the declarative manifest (user-paths.ts); the model
 * never supplies harness code. Results land in agents/data/validation/latest.json
 * with a sha256 recorded in-process (getTrustedReportHash) so the acceptance
 * judge's runtime note can refuse a report the runner did not itself write —
 * the same anti-fabrication stance as the gate-integrity guard (integrity.ts).
 *
 * Availability follows the deploy-dev precedent: a missing browser marks
 * browser paths skipped (rung non-blocking) rather than failing delivery on an
 * environment gap — but the skip is loud in the report and the judge note.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { GateRung, LadderResult, LadderRunFn, RungResult } from './verifier-ladder.js';
import { startStaticServer } from './execution-gate.js';
import {
  loadUserPaths,
  USER_PATHS_FILE,
  type UserPath,
  type UserPathsManifest,
  type UserPathsServer,
  type UserPathStep,
} from './user-paths.js';

export const VALIDATION_REPORT_FILE = join('agents', 'data', 'validation', 'latest.json');
export const USER_VALIDATION_RUNG_ID = 'user-validation';

export type UserValidationMode = 'block' | 'advisory' | 'off';

export interface StepResult {
  step: string;
  ok: boolean;
  observed: string;
}

export interface PathResult {
  id: string;
  rule: string;
  client: string;
  status: 'pass' | 'fail' | 'skipped';
  steps: StepResult[];
  screenshots: string[];
}

export interface ValidationReport {
  version: 1;
  startedAt: string;
  finishedAt: string;
  manifestHash: string | null;
  results: PathResult[];
  /** pass = every path passed; fail = ≥1 failed; na = no manifest/no paths. */
  verdict: 'pass' | 'fail' | 'na';
  naReason?: string;
  browserAvailable: boolean;
  /** Source-state stamp at run time (computeTreeStamp) — a report whose stamp
   * no longer matches the tree is STALE: code changed after validation. */
  treeStamp?: string;
}

/* ------------------------------------------------------------------ trust */

let trustedReportHash: string | null = null;

export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Hash of the report THIS process last wrote via the runner. A report on
 * disk whose hash differs was not produced by the sanctioned runner this run
 * and must not be trusted for the "ALL PASSED" judge note. */
export function getTrustedReportHash(): string | null {
  return trustedReportHash;
}

/** Test seam. */
export function resetTrustedReportHash(): void {
  trustedReportHash = null;
}

/* ------------------------------------------------------- mode resolution */

/**
 * delivery.userValidation resolution — ON BY DEFAULT ('block').
 * Precedence: explicit config value > env downgrade > default.
 * UAP_USER_VALIDATION=0 downgrades block→advisory (never to off): the
 * operator out-of-band switch is the config file, and the env var is on the
 * self-protect blocklist so the model cannot persist it.
 */
export function resolveUserValidationMode(configValue: unknown, env: NodeJS.ProcessEnv = process.env): UserValidationMode {
  const cfg = typeof configValue === 'string' ? configValue.toLowerCase() : configValue;
  let mode: UserValidationMode =
    cfg === 'off' || cfg === false ? 'off'
    : cfg === 'advisory' ? 'advisory'
    : 'block';
  if (mode === 'block' && env.UAP_USER_VALIDATION === '0') mode = 'advisory';
  return mode;
}

/* ------------------------------------------------------------- adapters */

interface BrowserLike {
  goto(url: string): Promise<string>;
  getText(selector: string): Promise<string>;
  screenshot(path: string): Promise<void>;
  getErrors(): { kind: string; message: string }[];
  clearErrors(): void;
  click(selector: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  press(key: string): Promise<void>;
  isVisible(selector: string): Promise<boolean>;
  close(): Promise<void>;
}

async function loadBrowser(): Promise<BrowserLike | null> {
  try {
    const { WebBrowser } = await import('../browser/web-browser.js');
    const b = new WebBrowser();
    await b.launch({ headless: true });
    return b as unknown as BrowserLike;
  } catch {
    return null;
  }
}

function stepLabel(step: UserPathStep): string {
  const [k] = Object.keys(step);
  const v = (step as Record<string, unknown>)[k];
  return `${k}:${typeof v === 'object' ? JSON.stringify(v) : String(v)}`.slice(0, 160);
}

interface RunContext {
  projectRoot: string;
  baseUrl: string | null;
  shotsDir: string;
  timeoutMs: number;
}

async function runBrowserPath(path: UserPath, browser: BrowserLike, ctx: RunContext): Promise<PathResult> {
  const steps: StepResult[] = [];
  const screenshots: string[] = [];
  browser.clearErrors();
  let failed = false;
  for (const [i, step] of path.steps.entries()) {
    if (failed) break;
    const label = stepLabel(step);
    try {
      if (step.goto !== undefined) {
        const target = /^https?:/.test(step.goto) ? step.goto : `${ctx.baseUrl}${step.goto.startsWith('/') ? '' : '/'}${step.goto}`;
        const status = await browser.goto(target);
        const ok = status.startsWith('2') || status.startsWith('3');
        steps.push({ step: label, ok, observed: `HTTP ${status}` });
        failed = !ok;
      } else if (step.click !== undefined) {
        await browser.click(step.click);
        steps.push({ step: label, ok: true, observed: 'clicked' });
      } else if (step.fill !== undefined) {
        await browser.fill(step.fill.selector, step.fill.value);
        steps.push({ step: label, ok: true, observed: 'filled' });
      } else if (step.press !== undefined) {
        await browser.press(step.press);
        steps.push({ step: label, ok: true, observed: 'pressed' });
      } else if (step.wait_ms !== undefined) {
        await new Promise((r) => setTimeout(r, Math.min(step.wait_ms ?? 0, 15_000)));
        steps.push({ step: label, ok: true, observed: 'waited' });
      } else if (step.expect_visible !== undefined) {
        const vis = await browser.isVisible(step.expect_visible);
        steps.push({ step: label, ok: vis, observed: vis ? 'visible' : 'NOT visible' });
        failed = !vis;
      } else if (step.expect_text !== undefined) {
        const text = await browser.getText(step.expect_text.selector);
        let ok = true;
        if (step.expect_text.contains !== undefined) ok = text.includes(step.expect_text.contains);
        if (ok && step.expect_text.not_empty) ok = text.trim().length > 0;
        steps.push({ step: label, ok, observed: `text="${text.slice(0, 120)}"` });
        failed = !ok;
      } else if (step.expect_no_console_errors !== undefined) {
        // favicon.ico 404s are browser-request noise, not app defects — the
        // exact false-positive UAP's own static server suppresses with a 204.
        const errs = browser
          .getErrors()
          .filter((e) => e.kind === 'pageerror' || e.kind === 'console')
          .filter((e) => !e.message.includes('favicon.ico'));
        const ok = errs.length === 0;
        steps.push({ step: label, ok, observed: ok ? 'no errors' : errs.map((e) => e.message).join(' | ').slice(0, 300) });
        failed = !ok;
      } else {
        steps.push({ step: label, ok: false, observed: `step not valid for browser client` });
        failed = true;
      }
    } catch (e) {
      steps.push({ step: label, ok: false, observed: `error: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300) });
      failed = true;
    }
    // Screenshot after each interaction step (evidence trail), best-effort.
    try {
      const shot = join(ctx.shotsDir, `${path.id}-${i}.png`);
      await browser.screenshot(shot);
      screenshots.push(shot);
    } catch { /* headless screenshot unavailable — evidence degrades */ }
  }
  return { id: path.id, rule: path.rule, client: 'browser', status: failed ? 'fail' : 'pass', steps, screenshots };
}

async function runHttpPath(path: UserPath, ctx: RunContext): Promise<PathResult> {
  const steps: StepResult[] = [];
  let failed = false;
  let lastStatus = 0;
  let lastBody = '';
  for (const step of path.steps) {
    if (failed) break;
    const label = stepLabel(step);
    try {
      if (step.request !== undefined) {
        const url = `${ctx.baseUrl}${step.request.path.startsWith('/') ? '' : '/'}${step.request.path}`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), ctx.timeoutMs);
        try {
          const res = await fetch(url, {
            method: step.request.method,
            headers: { ...(step.request.json !== undefined ? { 'content-type': 'application/json' } : {}), ...step.request.headers },
            body: step.request.json !== undefined ? JSON.stringify(step.request.json) : undefined,
            signal: controller.signal,
          });
          lastStatus = res.status;
          lastBody = await res.text();
        } finally {
          clearTimeout(timer);
        }
        steps.push({ step: label, ok: true, observed: `HTTP ${lastStatus} ${lastBody.slice(0, 160)}` });
      } else if (step.expect_status !== undefined) {
        const ok = lastStatus === step.expect_status;
        steps.push({ step: label, ok, observed: `HTTP ${lastStatus}` });
        failed = !ok;
      } else if (step.expect_json_contains !== undefined) {
        let ok = false;
        let observed = lastBody.slice(0, 160);
        try {
          const body = JSON.parse(lastBody);
          ok = jsonContains(body, step.expect_json_contains);
        } catch {
          observed = `non-JSON body: ${observed}`;
        }
        steps.push({ step: label, ok, observed });
        failed = !ok;
      } else if (step.expect_body_matches !== undefined) {
        const ok = new RegExp(step.expect_body_matches).test(lastBody);
        steps.push({ step: label, ok, observed: lastBody.slice(0, 160) });
        failed = !ok;
      } else {
        steps.push({ step: label, ok: false, observed: 'step not valid for http client' });
        failed = true;
      }
    } catch (e) {
      steps.push({ step: label, ok: false, observed: `error: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300) });
      failed = true;
    }
  }
  return { id: path.id, rule: path.rule, client: 'http', status: failed ? 'fail' : 'pass', steps, screenshots: [] };
}

/** Deep subset match: every key/value in `expected` appears in `actual`
 * (arrays: some element matches). */
export function jsonContains(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== 'object') return actual === expected;
  if (Array.isArray(expected)) {
    return expected.every((e) => Array.isArray(actual) && actual.some((a) => jsonContains(a, e)));
  }
  if (Array.isArray(actual)) return actual.some((a) => jsonContains(a, expected));
  if (typeof actual !== 'object' || actual === null) return false;
  return Object.entries(expected as Record<string, unknown>).every(([k, v]) =>
    jsonContains((actual as Record<string, unknown>)[k], v)
  );
}

function runCliPath(path: UserPath, ctx: RunContext): PathResult {
  const steps: StepResult[] = [];
  let failed = false;
  let lastExit: number | null = null;
  let lastStdout = '';
  let lastStderr = '';
  for (const step of path.steps) {
    if (failed) break;
    const label = stepLabel(step);
    try {
      if (step.run !== undefined) {
        const [cmd, ...rest] = step.run.argv;
        const r = spawnSync(cmd, rest, {
          cwd: ctx.projectRoot,
          timeout: Math.min(step.run.timeoutMs ?? ctx.timeoutMs, 120_000),
          input: step.run.stdin,
          encoding: 'utf8',
          shell: false,
        });
        lastExit = r.status;
        lastStdout = r.stdout ?? '';
        lastStderr = r.stderr ?? '';
        steps.push({ step: label, ok: true, observed: `exit=${String(lastExit)} stdout=${lastStdout.slice(0, 120)}` });
      } else if (step.expect_exit !== undefined) {
        const ok = lastExit === step.expect_exit;
        steps.push({ step: label, ok, observed: `exit=${String(lastExit)}` });
        failed = !ok;
      } else if (step.expect_stdout_matches !== undefined) {
        const ok = new RegExp(step.expect_stdout_matches).test(lastStdout);
        steps.push({ step: label, ok, observed: lastStdout.slice(0, 160) });
        failed = !ok;
      } else if (step.expect_stderr_matches !== undefined) {
        const ok = new RegExp(step.expect_stderr_matches).test(lastStderr);
        steps.push({ step: label, ok, observed: lastStderr.slice(0, 160) });
        failed = !ok;
      } else {
        steps.push({ step: label, ok: false, observed: 'step not valid for cli client' });
        failed = true;
      }
    } catch (e) {
      steps.push({ step: label, ok: false, observed: `error: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300) });
      failed = true;
    }
  }
  return { id: path.id, rule: path.rule, client: 'cli', status: failed ? 'fail' : 'pass', steps, screenshots: [] };
}

/* ------------------------------------------------------ server lifecycle */

interface ManagedServer {
  baseUrl: string;
  close: () => void;
}

async function startManifestServer(srv: UserPathsServer, projectRoot: string): Promise<ManagedServer | null> {
  const child = spawn(srv.command, srv.args ?? [], {
    cwd: projectRoot,
    env: { ...process.env, ...srv.env },
    stdio: 'ignore',
    detached: false,
  });
  const baseUrl = `http://127.0.0.1:${srv.port}`;
  const deadline = Date.now() + (srv.readyTimeoutMs ?? 30_000);
  const readyUrl = `${baseUrl}${srv.readyPath ?? '/'}`;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return null; // died during bring-up
    try {
      await fetch(readyUrl, { signal: AbortSignal.timeout(1_000) });
      return { baseUrl, close: () => { try { child.kill(); } catch { /* already gone */ } } };
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  try { child.kill(); } catch { /* already gone */ }
  return null;
}

/* ------------------------------------------------------------ main entry */

export interface RunUserValidationOptions {
  timeoutMs?: number;
  /** Test seam: replace the browser loader. */
  browserLoader?: () => Promise<BrowserLike | null>;
}

export async function runUserValidation(
  projectRoot: string,
  opts: RunUserValidationOptions = {}
): Promise<ValidationReport> {
  const startedAt = new Date().toISOString();
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const loaded = loadUserPaths(projectRoot);

  const finish = (report: Omit<ValidationReport, 'startedAt' | 'finishedAt' | 'treeStamp'>): ValidationReport => {
    const full: ValidationReport = {
      ...report,
      startedAt,
      finishedAt: new Date().toISOString(),
      treeStamp: computeTreeStamp(projectRoot),
    };
    try {
      const file = join(projectRoot, VALIDATION_REPORT_FILE);
      mkdirSync(join(projectRoot, 'agents', 'data', 'validation'), { recursive: true });
      const text = JSON.stringify(full, null, 2) + '\n';
      writeFileSync(file, text, 'utf8');
      trustedReportHash = sha256Text(text);
    } catch {
      trustedReportHash = null; // report unwritable — note stays untrusted
    }
    return full;
  };

  if (!loaded) {
    return finish({
      version: 1, manifestHash: null, results: [], verdict: 'na',
      naReason: `no ${USER_PATHS_FILE} manifest`, browserAvailable: false,
    });
  }
  if (!loaded.ok || !loaded.manifest) {
    return finish({
      version: 1, manifestHash: null,
      results: [{
        id: 'manifest', rule: 'manifest must be valid', client: 'cli', status: 'fail',
        steps: loaded.errors.map((e) => ({ step: 'validate', ok: false, observed: e })), screenshots: [],
      }],
      verdict: 'fail', browserAvailable: false,
    });
  }

  const manifest: UserPathsManifest = loaded.manifest;
  const manifestHash = sha256Text(JSON.stringify(manifest));
  if (manifest.paths.length === 0) {
    return finish({
      version: 1, manifestHash, results: [], verdict: 'na',
      naReason: 'manifest has no paths', browserAvailable: false,
    });
  }

  const shotsDir = join(projectRoot, 'agents', 'data', 'validation', 'shots');
  mkdirSync(shotsDir, { recursive: true });

  const needsBrowser = manifest.paths.some((p) => p.client === 'browser');
  const needsServer = manifest.paths.some((p) => p.client === 'http') || manifest.server !== undefined;

  let managed: ManagedServer | null = null;
  let staticServer: { url: string; close: () => void } | null = null;
  let browser: BrowserLike | null = null;
  const results: PathResult[] = [];

  try {
    if (needsServer && manifest.server) {
      managed = await startManifestServer(manifest.server, projectRoot);
    }
    if (needsBrowser) {
      browser = await (opts.browserLoader ?? loadBrowser)();
      if (!managed && !staticServer) {
        try { staticServer = await startStaticServer(projectRoot); } catch { staticServer = null; }
      }
    }

    for (const path of manifest.paths) {
      if (path.client === 'browser') {
        if (!browser) {
          results.push({
            id: path.id, rule: path.rule, client: 'browser', status: 'skipped',
            steps: [{ step: 'launch-browser', ok: false, observed: 'headless browser unavailable in this environment' }],
            screenshots: [],
          });
          continue;
        }
        // startStaticServer's `url` includes its own entry path (…/index.html),
        // so using it verbatim as the base doubled the path for a `goto`
        // ("…/index.html/rubiks-cube/index.html" → 404). Use the ORIGIN so
        // absolute gotos resolve against the served root (matches visual-gate).
        let base = managed?.baseUrl ?? null;
        if (!base && staticServer?.url) {
          try { base = new URL(staticServer.url).origin; } catch { base = staticServer.url; }
        }
        results.push(await runBrowserPath(path, browser, { projectRoot, baseUrl: base, shotsDir, timeoutMs }));
      } else if (path.client === 'http') {
        if (!managed) {
          results.push({
            id: path.id, rule: path.rule, client: 'http', status: 'fail',
            steps: [{ step: 'server', ok: false, observed: manifest.server ? 'server failed to become ready' : `http paths need a "server" entry in ${USER_PATHS_FILE}` }],
            screenshots: [],
          });
          continue;
        }
        results.push(await runHttpPath(path, { projectRoot, baseUrl: managed.baseUrl, shotsDir, timeoutMs }));
      } else {
        results.push(runCliPath(path, { projectRoot, baseUrl: null, shotsDir, timeoutMs }));
      }
    }
  } finally {
    try { await browser?.close(); } catch { /* already closed */ }
    managed?.close();
    staticServer?.close();
  }

  const anyFail = results.some((r) => r.status === 'fail');
  const allSkipped = results.length > 0 && results.every((r) => r.status === 'skipped');
  return finish({
    version: 1, manifestHash, results,
    verdict: anyFail ? 'fail' : allSkipped ? 'na' : 'pass',
    naReason: allSkipped ? 'all paths skipped (browser unavailable)' : undefined,
    browserAvailable: browser !== null,
  });
}

/* ------------------------------------------------------------- freshness */

const STAMP_SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', 'agents', '.uap',
  '.worktrees', 'vendor', 'target', '__pycache__',
]);
const STAMP_SRC_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|c|cc|cpp|h|hpp|cs|php|html|css|vue|svelte)$/i;

/**
 * Stamp of the current source state. Git-backed when possible (HEAD +
 * porcelain status + diff hashes), so ANY tracked edit changes the stamp;
 * non-git projects fall back to a bounded newest-source-mtime scan.
 */
export function computeTreeStamp(projectRoot: string): string {
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const status = execFileSync('git', ['status', '--porcelain=v1'], { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8_000_000 });
    // Exclude UAP's own artifacts (the validation report/screenshots, run
    // state) — writing the report must not invalidate the stamp it carries.
    // Manifest edits are caught separately via the report's manifestHash.
    const relevant = status
      .split('\n')
      .filter((line) => {
        const path = line.slice(3);
        return line.trim() !== '' && !path.startsWith('agents/') && !path.startsWith('.uap/');
      })
      .join('\n');
    const diff = execFileSync('git', ['diff', 'HEAD', '--', '.', ':(exclude)agents', ':(exclude).uap'], { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32_000_000 });
    return `git:${head}:${sha256Text(relevant + '\u0000' + diff)}`;
  } catch {
    // Non-git fallback: newest source mtime, bounded walk (depth 6).
    let newest = 0;
    const walk = (dir: string, depth: number): void => {
      if (depth > 6) return;
      let entries: string[];
      try { entries = readdirSync(dir); } catch { return; }
      for (const name of entries) {
        if (name.startsWith('.') || STAMP_SKIP_DIRS.has(name)) continue;
        const abs = join(dir, name);
        try {
          const st = statSync(abs);
          if (st.isDirectory()) walk(abs, depth + 1);
          else if (STAMP_SRC_RE.test(name) && st.mtimeMs > newest) newest = st.mtimeMs;
        } catch { /* transient */ }
      }
    };
    walk(projectRoot, 0);
    return `mtime:${Math.floor(newest)}`;
  }
}

export type UserValidationFreshness =
  | { status: 'na'; reason: string }
  | { status: 'missing' }
  | { status: 'stale' }
  | { status: 'fresh-pass'; report: ValidationReport }
  | { status: 'fresh-fail'; report: ValidationReport };

/**
 * Can the session claim "done" on the strength of the existing report?
 * fresh-pass = report matches the CURRENT tree and all paths passed.
 * Anything else means the gate must (re)run before a done-claim stands.
 */
export function checkUserValidationFreshness(projectRoot: string): UserValidationFreshness {
  const manifest = loadUserPaths(projectRoot);
  if (!manifest) return { status: 'na', reason: `no ${USER_PATHS_FILE} manifest` };
  if (manifest.ok && manifest.manifest && manifest.manifest.paths.length === 0) {
    return { status: 'na', reason: 'manifest has no paths' };
  }
  const file = join(projectRoot, VALIDATION_REPORT_FILE);
  if (!existsSync(file)) return { status: 'missing' };
  let report: ValidationReport;
  try {
    report = JSON.parse(readFileSync(file, 'utf8')) as ValidationReport;
  } catch {
    return { status: 'missing' };
  }
  if (!report.treeStamp || report.treeStamp !== computeTreeStamp(projectRoot)) return { status: 'stale' };
  // A changed manifest invalidates the report even when source is untouched —
  // new/edited journeys have not been proven yet.
  const currentManifestHash = manifest.ok && manifest.manifest ? sha256Text(JSON.stringify(manifest.manifest)) : null;
  if (currentManifestHash !== report.manifestHash) return { status: 'stale' };
  if (report.verdict === 'fail') return { status: 'fresh-fail', report };
  return { status: 'fresh-pass', report };
}

/* --------------------------------------------------------- ladder wiring */

/** Synthesize the terminal user-validation rung. `required` mirrors the
 * resolved mode: block ⇒ required, advisory ⇒ optional. */
export function synthesizeUserValidationRung(mode: UserValidationMode): GateRung | null {
  if (mode === 'off') return null;
  return {
    id: USER_VALIDATION_RUNG_ID,
    name: `User-path validation (real client${mode === 'advisory' ? ', advisory' : ''})`,
    command: 'user-validation', // executed in-process by the injected runner
    args: [],
    required: mode === 'block',
    timeoutMs: 300_000,
    tier: 'final',
  };
}

/**
 * LadderRunFn for the 'final' tier: runs the validation in-process (never
 * spawning model-writable code) and maps the report onto rung results.
 * Skipped-not-failed when every path was environment-skipped, mirroring the
 * deploy-dev docker-unavailable behavior.
 */
export function createUserValidationRunner(runOpts: RunUserValidationOptions = {}): LadderRunFn {
  return async (rungs: GateRung[], projectRoot: string): Promise<LadderResult> => {
    const rung = rungs.find((r) => r.id === USER_VALIDATION_RUNG_ID) ?? rungs[0];
    const started = Date.now();
    const report = await runUserValidation(projectRoot, runOpts);
    const failedPaths = report.results.filter((r) => r.status === 'fail');
    const passed = report.verdict === 'pass' || report.verdict === 'na';
    const skipped = report.verdict === 'na';
    const detail = report.results
      .map((r) => `${r.status.toUpperCase()} ${r.id}: ${r.rule}${r.status === 'fail' ? ` — ${r.steps.find((s) => !s.ok)?.step ?? ''} → ${r.steps.find((s) => !s.ok)?.observed ?? ''}` : ''}`)
      .join('\n');
    const result: RungResult = {
      id: rung.id,
      name: rung.name,
      // NA counts as passed (skipped-not-failed, the deploy-dev precedent):
      // a required rung with no applicable paths must not fail the aggregate.
      passed,
      skipped,
      exitCode: passed ? 0 : 1,
      // A failing user path is a REAL gate failure (the artifact is broken for
      // a user), not infra — 'exit' maps it to verify RC 1, the only code the
      // stop hook hard-blocks on.
      ...(passed ? {} : { failureReason: 'exit' as const }),
      durationMs: Date.now() - started,
      outputTail:
        (report.verdict === 'na' ? `NA: ${report.naReason ?? ''}\n` : '') +
        detail +
        (passed
          ? ''
          : `\nThe artifact does not work for a real user on these journeys. Fix the artifact so they pass; the manifest is ${USER_PATHS_FILE}.`),
    };
    return {
      passed: passed || !rung.required,
      score: passed ? 1 : Math.max(0, 1 - failedPaths.length / Math.max(1, report.results.length)),
      results: [result],
      feedback: passed
        ? ''
        : `User-path validation FAILED — the artifact does not work for a real user:\n${detail}\nFix the artifact so these journeys pass; the manifest is ${USER_PATHS_FILE}.`,
    };
  };
}

/* --------------------------------------------------------- judge support */

export interface UserPathsNote {
  note: string;
  trusted: boolean;
}

/**
 * Build the acceptance-judge runtime note from the on-disk report, refusing
 * to vouch for a report the in-process runner did not write (hash mismatch ⇒
 * fabricated/stale ⇒ say so to the judge instead of staying silent).
 */
export function buildUserPathsNote(projectRoot: string): UserPathsNote | null {
  const file = join(projectRoot, VALIDATION_REPORT_FILE);
  if (!existsSync(file)) return null;
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const trusted = trustedReportHash !== null && sha256Text(text) === trustedReportHash;
  if (!trusted) {
    return {
      note: 'A user-validation report exists but was NOT produced by the sanctioned runner this run — treat it as unverified.',
      trusted: false,
    };
  }
  try {
    const report = JSON.parse(text) as ValidationReport;
    if (report.verdict === 'pass') {
      return { note: `User-path validation ALL PASSED (${report.results.length} real-client journeys) — treat user-facing requirements covered by these paths as objectively verified.`, trusted: true };
    }
    if (report.verdict === 'fail') {
      const failed = report.results.filter((r) => r.status === 'fail').map((r) => `${r.id} (${r.rule})`).join('; ');
      return { note: `User-path validation FAILED: ${failed} — the artifact does not work for a real user on these journeys.`, trusted: true };
    }
    return { note: `User-path validation: not applicable (${report.naReason ?? 'no user-facing surface'}).`, trusted: true };
  } catch {
    return null;
  }
}
