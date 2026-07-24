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

/** Selectors that trivially always exist — never listed as a build requirement. */
const SHELL_CONTRACT_SELECTORS = new Set(['body', 'html', ':root', '*']);

/** A string the headless client can address as a CSS selector (id/class/attr/tag). */
function isAddressableSelector(s: unknown): boolean {
  if (typeof s !== 'string') return false;
  const t = s.trim();
  if (!t) return false;
  return /^[#.[]/.test(t) || /^[a-zA-Z][\w-]*$/.test(t);
}

function collectContractSelector(sel: string | undefined, sink: Set<string>): void {
  if (isAddressableSelector(sel)) sink.add((sel as string).trim());
}

/**
 * A step's `click`/target may be a bare selector string OR an object with a
 * `selector` (e.g. canvas coordinate clicks: {selector,x,y}). The declared type
 * says string, but the runner and real manifests use both — extract robustly.
 */
function selectorOf(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const sel = (v as { selector?: unknown }).selector;
    if (typeof sel === 'string') return sel;
  }
  return undefined;
}

/** One human-readable line per step; '' for steps not worth stating (pure waits). */
/**
 * Clamp a value interpolated from the manifest into the prompt.
 *
 * The contract is injected into EVERY turn's prompt, and every field here comes
 * from `.uap/user-paths.json` — a repo file whose user-curated entries are
 * deliberately never overwritten. Unclamped, one long `fill.value` or
 * `expect_text.contains` is re-sent on every turn for the life of the run, and a
 * multi-line value can forge structure inside a section the model reads as
 * instructions. Newlines collapse, length is bounded, and the truncation is
 * visible rather than silent.
 */
export function clampContractValue(value: unknown, max = CONTRACT_FIELD_MAX): string {
  const s = String(value ?? '').replace(/[\r\n\t\u2028\u2029]+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Per-field cap for values interpolated into the acceptance contract. */
export const CONTRACT_FIELD_MAX = 200;
/** Cap for the whole rendered contract — it is re-sent every turn. */
export const CONTRACT_TOTAL_MAX = 8000;
/** Headroom reserved for the truncation notes so the cap is never exceeded. */
const NOTE_ALLOWANCE = 260;

function describeContractStep(step: UserPathStep, sink: Set<string>): string {
  if (step.goto !== undefined) return `load ${clampContractValue(step.goto) || '/'}`;
  if (step.click !== undefined) {
    const sel = selectorOf(step.click);
    collectContractSelector(sel, sink);
    const c = step.click as unknown;
    const coord =
      c && typeof c === 'object'
        ? ` at (${String((c as { x?: unknown }).x ?? '?')},${String((c as { y?: unknown }).y ?? '?')})`
        : '';
    return `click ${clampContractValue(sel ?? String(step.click))}${coord}`;
  }
  if (step.fill) {
    collectContractSelector(step.fill.selector, sink);
    return `type "${clampContractValue(step.fill.value)}" into ${clampContractValue(step.fill.selector)}`;
  }
  if (step.press) return `press ${clampContractValue(step.press)}`;
  if (step.expect_visible !== undefined) {
    collectContractSelector(step.expect_visible, sink);
    return `${clampContractValue(step.expect_visible)} must be visible`;
  }
  if (step.expect_text) {
    collectContractSelector(step.expect_text.selector, sink);
    const c = step.expect_text.contains;
    return `${clampContractValue(step.expect_text.selector)} must ${c ? `contain "${clampContractValue(c)}"` : 'have text'}`;
  }
  if (step.expect_no_console_errors) return 'no console errors';
  if (step.request) return `${clampContractValue(step.request.method)} ${clampContractValue(step.request.path)}`;
  if (step.expect_status !== undefined) return `response status ${clampContractValue(step.expect_status)}`;
  if (step.expect_json_contains) return `response JSON contains ${clampContractValue(JSON.stringify(step.expect_json_contains))}`;
  if (step.expect_body_matches) return `response body matches /${clampContractValue(step.expect_body_matches)}/`;
  if (step.run) return `run ${clampContractValue((step.run.argv ?? []).join(' '))}`;
  if (step.expect_exit !== undefined) return `exit code ${clampContractValue(step.expect_exit)}`;
  if (step.expect_stdout_matches) return `stdout matches /${clampContractValue(step.expect_stdout_matches)}/`;
  if (step.expect_stderr_matches) return `stderr matches /${clampContractValue(step.expect_stderr_matches)}/`;
  return '';
}

/**
 * Render the derived user-path manifest as an ACCEPTANCE CONTRACT for the
 * implementer — the concrete journeys + selectors the real-client validator
 * will drive. Injected into the executor's prompt every turn (convergence-loop
 * PromptContext.acceptanceContract) so the model builds a COMPLETE, drivable
 * artifact from turn 1 instead of discovering the contract only through gate
 * failures a weak model cannot act on. Generic across web/http/cli missions.
 *
 * The canvas→DOM bridge line is the completeness rail this exists for: an
 * automated client can only see/click DOM nodes, so a canvas-only UI (a common
 * small-model output for games/visualizations) must ALSO expose the referenced
 * selectors as real DOM elements. A transparent overlay preserves the visual
 * composite the aesthetic judge grades. Returns '' when there is nothing to
 * assert (no manifest / no steps) so callers can inject unconditionally.
 */
export function renderAcceptanceContract(manifest: UserPathsManifest | null | undefined): string {
  if (!manifest || !Array.isArray(manifest.paths) || manifest.paths.length === 0) return '';
  const selectors = new Set<string>();
  const journeyLines: string[] = [];
  let hasBrowser = false;
  for (const path of manifest.paths) {
    if (!path || !Array.isArray(path.steps) || path.steps.length === 0) continue;
    if (path.client === 'browser') hasBrowser = true;
    const rule = clampContractValue(path.rule ?? path.id ?? '');
    journeyLines.push(
      `- Journey "${clampContractValue(path.id)}" (${clampContractValue(path.client)})${rule ? `: ${rule}` : ''}`
    );
    for (const step of path.steps) {
      const desc = describeContractStep(step, selectors);
      if (desc) journeyLines.push(`    • ${desc}`);
    }
  }
  if (journeyLines.length === 0) return '';
  const header = [
    'ACCEPTANCE CONTRACT — the delivered artifact is exercised by an automated real-client',
    'validator (headless browser / HTTP client / built CLI) on the journeys below. Build so',
    'EVERY step passes; a step the validator cannot perform fails delivery.',
    '',
  ];
  const out: string[] = [];
  const required = [...selectors].filter((s) => !SHELL_CONTRACT_SELECTORS.has(s.toLowerCase()));
  // The selector list scales with the manifest exactly like the journey list —
  // one selector per step. Treating it as fixed overhead let it consume the whole
  // budget and evict every journey line, leaving a contract that is all
  // requirements and no journeys (and still over the cap).
  const selectorLine = (list: string[], omitted: number): string =>
    `REQUIRED DOM SELECTORS (each MUST exist in the rendered page and be visible/clickable as used above): ${list.join(', ')}.` +
    (omitted > 0 ? ` (+${omitted} more — see ${USER_PATHS_FILE})` : '');
  if (hasBrowser && required.length > 0) {
    out.push('');
    out.push(selectorLine(required, 0));
    out.push(
      'If your UI draws controls or text on a <canvas>, ALSO expose these selectors as real DOM ' +
        'elements layered over the canvas (position:absolute/fixed; background:transparent so the canvas ' +
        'shows through and the visuals are not dimmed). An automated client cannot see or click ' +
        'canvas-drawn pixels — a canvas-only build cannot be validated and will fail this gate.'
    );
    out.push(
      'STATE TRANSITIONS are part of the contract: when a journey clicks a control and a LATER step ' +
        'expects an element to be visible, the click handler MUST make that element visible (e.g. toggle ' +
        'style.display / a CSS class). Build the transition — do not just place a hidden element on the page.'
    );
    if (selectors.has('canvas') || required.some((s) => /canvas/i.test(s))) {
      out.push(
        'VISUAL QUALITY (a rendered <canvas> is graded aesthetically): the FIRST screen a user sees — the ' +
          'menu/start/idle state — must already show a rich scene. Start your render loop from load and DRAW ' +
          'the background and key visuals (starfield/parallax, title art, sprite/preview) in EVERY state, not ' +
          'only during active play; a blank/dark canvas on the first screen scores near zero. Use the vibrant ' +
          'on-theme palette and keep any full-screen DOM overlay background transparent so the canvas shows through.'
      );
    }
  }
  // Whole-contract cap. Per-field clamping bounds any single VALUE; this bounds
  // the whole thing, because the text is re-sent on EVERY turn and competes with
  // the task itself for the context budget.
  //
  // TWO sections scale with the manifest — the journey list and the selector list
  // — so both are truncated, and the fixed rails (header, canvas/state-transition
  // guidance) are the only things treated as always-kept. Journeys are truncated
  // by GROUP: dropping a "- Journey" header while keeping its indented bullets
  // would silently re-parent those steps under the previous journey, which is a
  // wrong contract rather than a shorter one.
  const rails = out.filter((l) => !l.startsWith('REQUIRED DOM SELECTORS'));
  const fixed = [...header, ...rails].join('\n').length + NOTE_ALLOWANCE;
  const full = [...header, ...journeyLines, ...out].join('\n');
  if (full.length <= CONTRACT_TOTAL_MAX) return full;

  // Split the remaining budget: journeys first (they are the contract), selectors
  // second (they are derivable from the journeys the model can still see).
  let budget = Math.max(0, CONTRACT_TOTAL_MAX - fixed);
  const journeyBudget = Math.floor(budget * 0.7);

  const groups: string[][] = [];
  for (const line of journeyLines) {
    if (line.startsWith('- Journey') || groups.length === 0) groups.push([line]);
    else groups[groups.length - 1].push(line);
  }
  const kept: string[] = [];
  let droppedGroups = 0;
  let spent = 0;
  for (const g of groups) {
    const cost = g.join('\n').length + 1;
    if (spent + cost > journeyBudget) {
      droppedGroups++;
      continue;
    }
    spent += cost;
    kept.push(...g);
  }
  budget -= spent;

  // Charge the selector LINE's own boilerplate (the long prefix and the
  // "+N more" suffix), not just the selectors — otherwise the line overshoots by
  // its own framing and the advertised cap is missed by ~100 chars.
  const selectorFraming = selectorLine([], required.length).length;
  const keptSelectors: string[] = [];
  let selectorBudget = Math.max(0, budget - selectorFraming);
  for (const sel of required) {
    if (sel.length + 2 > selectorBudget) break;
    selectorBudget -= sel.length + 2;
    keptSelectors.push(sel);
  }
  const omittedSelectors = required.length - keptSelectors.length;

  const note =
    droppedGroups > 0
      ? [
          `    … ${droppedGroups} further journey(s) omitted to bound the prompt. The validator still ` +
            `runs ALL of them — read ${USER_PATHS_FILE} for the complete contract.`,
        ]
      : [];
  const tail = out.map((l) =>
    l.startsWith('REQUIRED DOM SELECTORS') && keptSelectors.length > 0
      ? selectorLine(keptSelectors, omittedSelectors)
      : l
  );
  return [...header, ...kept, ...note, ...tail].join('\n');
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
- REACHABILITY (critical): the validator runs ONLY the literal steps you write and
  cannot play skillfully or wait for the app to progress on its own. Every assertion
  MUST be reachable by the exact steps that precede it. Do NOT assert a state that
  requires gameplay/simulation progress — a specific score or level value, a boss or
  later wave appearing, an enemy being destroyed, or the player losing / a game-over
  screen. Scripted clicks cannot deterministically reach these, so such a path can
  NEVER pass and DEADLOCKS delivery. For dynamic values assert PRESENCE/VISIBILITY
  (expect_visible), never a specific number (no expect_text "5"/"10"/"100" on a
  score/level/HUD element). Prefer asserting: the app loads; static start-screen
  content is visible; clicking a start/begin control transitions to the running
  state and REVEALS the expected controls/HUD; the canvas renders; no console errors.
- CANVAS-rendered UIs (games/visualizations that draw via <canvas>): a DOM client
  can only see the <canvas> element and genuine top-level DOM chrome — never the
  things PAINTED on the canvas. So for a canvas app:
  * expect_visible ONLY the canvas plus top-level DOM chrome you can be certain
    exists (a start/menu control, a HUD/score CONTAINER, a game-over overlay).
  * NEVER assert individual game entities as DOM — enemies, bullets, particles,
    the player ship, sprites. They are canvas pixels, not DOM nodes; a '.enemy',
    '.particle', or '#player-ship' selector can NEVER be visible and DEADLOCKS the
    gate. (Class selectors like '.foo' are almost always such entities — avoid them.)
  * text painted on a canvas is NOT in the DOM, so expect_text can NEVER match it —
    do not use expect_text for canvas-drawn content (scores, HUDs, titles, menus);
    use expect_text only for real DOM text. Keep it to 2-3 short paths: load; the
    start transition (click the start control → HUD/running chrome appears); and
    no console errors.
- Use "server" only when the artifact needs a real server process (APIs); static
  HTML is served automatically.
- Output ONLY the JSON.

MISSION:
`;

/**
 * Deterministic backstop for the canvas REACHABILITY rule (expect_visible half —
 * sanitizeCanvasTextAssertions only handles expect_text). A weak miner asserts
 * individual canvas-drawn entities as DOM nodes (observed live on the octopus
 * retest: `.enemy-rect`, `.particle`, `#player-ship`). Those are painted on the
 * <canvas>, never in the DOM, so the step can NEVER pass and DEADLOCKS the gate.
 * For canvas missions, drop steps whose target is a CLASS selector (`.foo`) —
 * per-entity collections are always classes and a canvas app has no DOM class
 * entities. Id/tag chrome (#start, #hud, #game-over, canvas) is kept; a path left
 * with no assertion gets an expect_no_console_errors floor. Non-canvas missions
 * and http/cli paths are untouched.
 */
export function sanitizeCanvasEntityAssertions(
  manifest: UserPathsManifest,
  instruction: string
): UserPathsManifest {
  if (!/\bcanvas\b|<canvas/i.test(instruction)) return manifest;
  const targetSelector = (s: UserPathStep): string | undefined => {
    if (typeof (s as { expect_visible?: unknown }).expect_visible === 'string') {
      return (s as { expect_visible: string }).expect_visible;
    }
    const et = (s as { expect_text?: { selector?: string } }).expect_text;
    if (et && typeof et === 'object') return et.selector;
    const click = (s as { click?: unknown }).click;
    if (typeof click === 'string') return click;
    if (click && typeof click === 'object') return (click as { selector?: string }).selector;
    return undefined;
  };
  const isClassEntity = (s: UserPathStep): boolean => {
    const sel = (targetSelector(s) ?? '').trim();
    return sel.startsWith('.');
  };
  const isAssert = (s: UserPathStep): boolean => Object.keys(s).some((k) => k.startsWith('expect_'));
  const paths = manifest.paths.map((p) => {
    if (p.client !== 'browser' || !p.steps.some(isClassEntity)) return p;
    const kept = p.steps.filter((s) => !isClassEntity(s));
    if (!kept.some(isAssert)) kept.push({ expect_no_console_errors: true } as UserPathStep);
    return { ...p, steps: kept };
  });
  return { ...manifest, paths };
}

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
        return dropRedundantStaticServer(
          sanitizeCanvasEntityAssertions(
            sanitizeUnreachableGameStateAssertions(sanitizeCanvasTextAssertions(manifest, instruction)),
            instruction
          )
        );
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

/**
 * Deterministic backstop for the REACHABILITY rule: a weak miner still emits
 * assertions a mechanical click-validator can NEVER satisfy — a specific score
 * or level number that requires actually playing (observed live on the octopus
 * retest: `expect_text {#hud-level:"5"}`, `{#hud-score:"10"}`, `{#hud-score:"100"}`).
 * Such a step cannot pass by scripted input, so it DEADLOCKS the user-path gate
 * (the loop spins 3 turns unchanged and gives up). Loosen each numeric-outcome
 * `expect_text` on a browser path to an `expect_visible` on the same selector —
 * the element's PRESENCE is scripted-reachable, its exact game-state value is not.
 * Word-bearing text ("OCTOPUS INVADERS", "Score", "GAME OVER") is untouched.
 * Browser paths only; http/cli numeric bodies are legitimate and left alone.
 */
export function sanitizeUnreachableGameStateAssertions(manifest: UserPathsManifest): UserPathsManifest {
  const NUMERIC_ONLY = /^[^0-9]*\d[\d\s.,%x×/-]*$/; // "5", "100", "10%", "3 / 5" — a value, not a word
  const loosen = (s: UserPathStep): UserPathStep => {
    const et = (s as { expect_text?: { selector?: string; contains?: string } }).expect_text;
    if (et && typeof et === 'object' && typeof et.contains === 'string' && NUMERIC_ONLY.test(et.contains.trim())) {
      const sel = (et.selector ?? '').trim();
      if (sel) return { expect_visible: sel } as UserPathStep;
    }
    return s;
  };
  const paths = manifest.paths.map((p) => {
    if (p.client !== 'browser') return p;
    // De-dup consecutive identical expect_visible that loosening may introduce.
    const rewritten = p.steps.map(loosen);
    const deduped: UserPathStep[] = [];
    for (const s of rewritten) {
      const prev = deduped[deduped.length - 1];
      if (
        prev &&
        typeof (s as { expect_visible?: string }).expect_visible === 'string' &&
        (prev as { expect_visible?: string }).expect_visible === (s as { expect_visible?: string }).expect_visible
      ) {
        continue;
      }
      deduped.push(s);
    }
    return { ...p, steps: deduped };
  });
  return { ...manifest, paths };
}
