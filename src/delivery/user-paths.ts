/**
 * user-paths: the critical-path manifest behind the user-validation gate.
 *
 * `.uap/user-paths.json` declares the journeys a REAL USER takes through the
 * delivered artifact (browser clicks, HTTP calls, CLI invocations). The
 * user-validation runner (user-validation.ts) interprets these declaratively —
 * the model never writes harness code, it only names paths and selectors, so a
 * weak local executor cannot "test" its way around the gate with a vacuous
 * script.
 *
 * The manifest is planner-derived at decompose time (deriveUserPaths) and
 * merge-appended: entries a user has curated are never overwritten.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type UserPathClient = 'browser' | 'http' | 'cli';

/** One declarative step. Exactly one action key per step. */
export interface UserPathStep {
  // browser actions
  goto?: string;
  click?: string;
  fill?: { selector: string; value: string };
  press?: string;
  wait_ms?: number;
  expect_visible?: string;
  expect_text?: { selector: string; contains?: string; not_empty?: boolean };
  expect_no_console_errors?: boolean;
  // http actions
  request?: { method: string; path: string; json?: unknown; headers?: Record<string, string> };
  expect_status?: number;
  expect_json_contains?: Record<string, unknown>;
  expect_body_matches?: string;
  // cli actions
  run?: { argv: string[]; timeoutMs?: number; stdin?: string };
  expect_exit?: number;
  expect_stdout_matches?: string;
  expect_stderr_matches?: string;
}

export interface UserPath {
  id: string;
  /** The requirement/rule this path proves, in user terms. */
  rule: string;
  client: UserPathClient;
  /** Browser paths: entry file or route ('/', 'index.html', 'dist/index.html'). */
  entry?: string;
  steps: UserPathStep[];
}

/** Optional server lifecycle for http (and non-static browser) paths. */
export interface UserPathsServer {
  command: string;
  args?: string[];
  /** Path polled for readiness (default '/'). Any HTTP response counts. */
  readyPath?: string;
  readyTimeoutMs?: number;
  /** Port the server listens on. Substituted into request paths/goto URLs. */
  port: number;
  env?: Record<string, string>;
}

export interface UserPathsManifest {
  version: 1;
  server?: UserPathsServer;
  paths: UserPath[];
}

export const USER_PATHS_FILE = join('.uap', 'user-paths.json');

const KNOWN_STEP_KEYS = new Set([
  'goto', 'click', 'fill', 'press', 'wait_ms', 'expect_visible', 'expect_text',
  'expect_no_console_errors', 'request', 'expect_status', 'expect_json_contains',
  'expect_body_matches', 'run', 'expect_exit', 'expect_stdout_matches',
  'expect_stderr_matches',
]);

export interface ManifestValidation {
  ok: boolean;
  errors: string[];
  manifest?: UserPathsManifest;
}

/** Validate a parsed manifest object. Unknown step keys are rejected so a
 * typo'd expectation can never silently pass. */
export function validateManifest(raw: unknown): ManifestValidation {
  const errors: string[] = [];
  if (typeof raw !== 'object' || raw === null) return { ok: false, errors: ['manifest is not an object'] };
  const m = raw as Record<string, unknown>;
  if (m.version !== 1) errors.push(`unsupported version: ${String(m.version)}`);
  if (!Array.isArray(m.paths)) errors.push('paths: expected an array');
  const seen = new Set<string>();
  for (const [i, p] of (Array.isArray(m.paths) ? m.paths : []).entries()) {
    const path = p as Record<string, unknown>;
    const label = typeof path.id === 'string' ? path.id : `paths[${i}]`;
    if (typeof path.id !== 'string' || !path.id) errors.push(`${label}: missing id`);
    else if (seen.has(path.id)) errors.push(`${label}: duplicate id`);
    else seen.add(path.id);
    if (typeof path.rule !== 'string' || !path.rule) errors.push(`${label}: missing rule`);
    if (path.client !== 'browser' && path.client !== 'http' && path.client !== 'cli') {
      errors.push(`${label}: client must be browser|http|cli`);
    }
    if (!Array.isArray(path.steps) || path.steps.length === 0) {
      errors.push(`${label}: steps must be a non-empty array`);
      continue;
    }
    for (const [j, s] of (path.steps as unknown[]).entries()) {
      if (typeof s !== 'object' || s === null) { errors.push(`${label}.steps[${j}]: not an object`); continue; }
      const keys = Object.keys(s as object);
      if (keys.length !== 1) errors.push(`${label}.steps[${j}]: exactly one action per step (got: ${keys.join(',') || 'none'})`);
      for (const k of keys) if (!KNOWN_STEP_KEYS.has(k)) errors.push(`${label}.steps[${j}]: unknown action '${k}'`);
    }
  }
  if (m.server !== undefined) {
    const srv = m.server as Record<string, unknown>;
    if (typeof srv.command !== 'string' || !srv.command) errors.push('server.command: required');
    if (typeof srv.port !== 'number') errors.push('server.port: required number');
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, errors: [], manifest: raw as UserPathsManifest };
}

/** Load and validate the manifest. Returns null when the file is absent. */
export function loadUserPaths(projectRoot: string): ManifestValidation | null {
  const file = join(projectRoot, USER_PATHS_FILE);
  if (!existsSync(file)) return null;
  try {
    return validateManifest(JSON.parse(readFileSync(file, 'utf8')));
  } catch (e) {
    return { ok: false, errors: [`unreadable manifest: ${e instanceof Error ? e.message : String(e)}`] };
  }
}

/** Merge-append derived paths into the existing manifest: existing ids win
 * (user curation is never overwritten), new ids are appended. Atomic write. */
export function mergeUserPaths(projectRoot: string, derived: UserPathsManifest): UserPathsManifest {
  const existing = loadUserPaths(projectRoot);
  let merged: UserPathsManifest;
  if (existing?.ok && existing.manifest) {
    const have = new Set(existing.manifest.paths.map((p) => p.id));
    merged = {
      ...existing.manifest,
      server: existing.manifest.server ?? derived.server,
      paths: [...existing.manifest.paths, ...derived.paths.filter((p) => !have.has(p.id))],
    };
  } else {
    merged = derived;
  }
  const file = join(projectRoot, USER_PATHS_FILE);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  renameSync(tmp, file);
  return merged;
}

/** Extract the first JSON object or array from model output (```json fences or bare). */
export function parseManifestFromModel(text: string): UserPathsManifest | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidates = [fenced?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.search(/[[{]/);
    if (start === -1) continue;
    for (let end = c.length; end > start; end--) {
      const slice = c.slice(start, end).trim();
      if (!slice.endsWith('}') && !slice.endsWith(']')) continue;
      try {
        const parsed = JSON.parse(slice);
        const raw = Array.isArray(parsed) ? { version: 1, paths: parsed } : parsed;
        const v = validateManifest(raw);
        if (v.ok) return v.manifest ?? null;
      } catch {
        /* keep shrinking */
      }
    }
  }
  return null;
}

export type ModelExecutor = (prompt: string) => Promise<string>;

const DERIVE_PROMPT = `You are deriving USER-VALIDATION paths for a delivered software artifact.
A "user path" is a journey a real user takes through the artifact. Each path will be
executed by an automated runner against the real client (headless browser for web UIs,
HTTP client for APIs, the built binary for CLIs) — NOT by reading code.

From the mission below, output a JSON object:
{"version":1,"server":{...optional...},"paths":[{"id","rule","client","entry?","steps":[...]}]}

Step vocabulary (exactly ONE key per step):
 browser: {"goto":"/"} {"click":"#sel"} {"fill":{"selector":"#sel","value":"x"}} {"press":"Enter"}
          {"wait_ms":500} {"expect_visible":"#sel"} {"expect_text":{"selector":"#sel","contains":"x"}}
          {"expect_no_console_errors":true}
 http:    {"request":{"method":"POST","path":"/v1/x","json":{}}} {"expect_status":201}
          {"expect_json_contains":{"k":"v"}} {"expect_body_matches":"regex"}
 cli:     {"run":{"argv":["--help"]}} {"expect_exit":0} {"expect_stdout_matches":"regex"}

Rules:
- Cover each CRITICAL user-facing requirement of the mission with at least one path.
- 2-6 paths total; each 2-8 steps; every path ends with at least one expect_* step.
- Browser paths for anything with a UI; include expect_no_console_errors.
- CANVAS-rendered UIs (games/visualizations that draw via <canvas>): text and
  UI drawn on a canvas is NOT in the DOM, so expect_text can NEVER match it —
  do not use expect_text for canvas-drawn content (scores, HUDs, titles,
  menus). Assert expect_visible on the canvas selector plus
  expect_no_console_errors instead; use expect_text only for real DOM text.
- Use "server" only when the artifact needs a real server process (APIs); static
  HTML is served automatically.
- Output ONLY the JSON.

MISSION:
`;

/**
 * One evaluator-model call that proposes user paths for a mission. Fail-soft:
 * returns null on any error/parse failure so delivery never wedges on the
 * planner (the gate then reports "no manifest" instead).
 */
export async function deriveUserPaths(
  instruction: string,
  executor: ModelExecutor,
  extraContext?: string
): Promise<UserPathsManifest | null> {
  // Same weak-miner flake class as the phase planner (fixed in v1.161.2):
  // one unparseable sample and the WHOLE mission ran without its terminal
  // user-path gate ("no manifest derived" — observed twice live, runs D and
  // F). Retry once and narrate the degradation; still fail-soft to null so
  // delivery never wedges on the miner.
  const attempts = 2;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const prompt = DERIVE_PROMPT + instruction + (extraContext ? `\n\nCONTEXT:\n${extraContext}` : '');
      const out = await executor(prompt);
      const manifest = parseManifestFromModel(out);
      if (manifest) {
        return dropRedundantStaticServer(sanitizeCanvasTextAssertions(manifest, instruction));
      }
    } catch {
      /* fall through to retry/give-up */
    }
    console.log(
      `  user-validation: derive attempt ${attempt} produced no parseable manifest — ` +
        (attempt < attempts ? 'retrying the miner' : 'giving up (gate reports NA)')
    );
  }
  return null;
}

/**
 * Static-file-server commands mined into `server` are redundant AND harmful:
 * the runner serves static HTML itself (rooted at the web entry dir), while a
 * mined "python3 -m http.server ..." serves the PROJECT root on a fixed port
 * — wrong docroot, port collisions, and (before the spawn hardening) a
 * process-killing ENOENT. The prompt already says not to emit these; a weak
 * miner does anyway (run E, 2026-07-17). Real app servers (node dist/api.js,
 * uvicorn, etc.) are untouched.
 */
/**
 * Deterministic floor for the terminal user-path gate: when the miner cannot
 * produce a parseable manifest (a weak model fails this sampling in ~half of
 * live runs — observed runs D, F, G even WITH the retry), a web artifact
 * still gets a minimal real-client journey instead of the gate silently
 * reducing to NA. Loads the entry page headlessly and requires a visible
 * <canvas> (or body) plus zero console errors — weaker than a mined journey,
 * infinitely stronger than no journey at all.
 */
export function fallbackWebManifest(instruction: string): UserPathsManifest {
  const canvas = /\bcanvas\b|<canvas/i.test(instruction);
  return {
    version: 1,
    paths: [
      {
        id: 'fallback-load',
        rule: 'Artifact loads in a real browser without console errors (deterministic fallback journey — miner produced no manifest)',
        client: 'browser',
        entry: '/',
        steps: [
          { goto: '/' },
          ...(canvas ? [{ expect_visible: 'canvas' } as UserPathStep] : []),
          { wait_ms: 500 },
          { expect_no_console_errors: true },
        ],
      },
    ],
  };
}

const STATIC_SERVER_RE = /^\s*(?:python3?\s+-m\s+http\.server|npx\s+(?:serve|http-server)|http-server|serve)\b/;
export function dropRedundantStaticServer(manifest: UserPathsManifest): UserPathsManifest {
  const cmd = manifest.server?.command;
  if (typeof cmd === 'string' && STATIC_SERVER_RE.test(cmd)) {
    const { server: _dropped, ...rest } = manifest;
    return rest as UserPathsManifest;
  }
  return manifest;
}

/**
 * Deterministic backstop for the DERIVE_PROMPT canvas rule: a weak miner
 * still sometimes emits DOM expect_text assertions against body/html for
 * canvas-rendered missions (observed live: 1 of 5 mined paths on the
 * octopus retest, despite the prompt rule) — text drawn on a <canvas> is
 * never DOM text, so such a step can NEVER pass and makes the final epic's
 * user-path gate structurally unpassable. For canvas missions, drop
 * body/html expect_text steps when the path keeps at least one other
 * expect_* assertion; a path whose ONLY assertion was the doomed text check
 * gets expect_no_console_errors so it still ends in an expectation.
 * Prompt-following models are untouched (nothing to strip).
 */
export function sanitizeCanvasTextAssertions(
  manifest: UserPathsManifest,
  instruction: string
): UserPathsManifest {
  if (!/\bcanvas\b|<canvas/i.test(instruction)) return manifest;
  const SHELL_SELECTORS = new Set(['body', 'html', ':root', '*']);
  const isShellTextAssert = (s: UserPathStep): boolean => {
    const et = (s as { expect_text?: { selector?: string } }).expect_text;
    if (typeof et !== 'object' || et === null) return false;
    return SHELL_SELECTORS.has((et.selector ?? '').trim().toLowerCase());
  };
  const isAssert = (s: UserPathStep): boolean => Object.keys(s).some((k) => k.startsWith('expect_'));
  const paths = manifest.paths.map((p) => {
    if (p.client !== 'browser' || !p.steps.some(isShellTextAssert)) return p;
    const kept = p.steps.filter((s) => !isShellTextAssert(s));
    if (!kept.some(isAssert)) kept.push({ expect_no_console_errors: true } as UserPathStep);
    return { ...p, steps: kept };
  });
  return { ...manifest, paths };
}
