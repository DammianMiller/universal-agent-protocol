/**
 * Collectors for `uap inference health`.
 *
 * Every probe fails OPEN: a missing systemctl, journal, or server yields
 * undefined rather than a fabricated reading, so the analysis can say
 * UNKNOWN instead of inventing a GREEN. Same posture as src/capacity/probe.ts.
 */
import { execFileSync } from 'node:child_process';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import type { CheckpointSample, InferenceSnapshot, PrefillSample } from './analysis.js';
import {
  looksLikeStrataMetrics,
  parseStrataEngine,
  parseStrataLog,
  parseStrataRequests,
  strataKvBitsPerValue,
  type StrataEngine,
  type StrataLive,
  type StrataSamples,
} from './strata.js';

const EXEC_TIMEOUT_MS = 10_000;

/** systemd unit names: strict charset, never a leading dash — a name like
 * "--host=x.service" would be parsed by systemctl as a FLAG (CWE-88). */
const UNIT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9:_.@-]*\.service$/;

export interface ProbeDeps {
  /** Run a command and return stdout; throw on failure. */
  exec?: (cmd: string, args: string[]) => string;
  /** Fetch a URL and return the body; throw on failure. */
  fetchText?: (url: string) => Promise<string>;
  /** Read a local file and return its text; throw on failure. */
  readTextFile?: (path: string) => string;
  now?: () => number;
}

function defaultExec(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: EXEC_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024, // journals get large
    // Journal timestamps are matched with an English month abbreviation. Under
    // another LC_TIME nothing matches, every sample lands at t=0, and the
    // early/recent split silently degrades to sort stability.
    env: { ...process.env, LC_ALL: 'C' },
  });
}

/** Strata serve logs run to megabytes; cap the read the same way the HTTP
 * probes cap response bodies. A log past this size keeps its RECENT tail,
 * which is the half the trend cares about anyway. */
const MAX_LOG_BYTES = 64 * 1024 * 1024;

function defaultReadTextFile(path: string): string {
  // Read the tail for oversized logs: stat first, seek back, then read.
  const stat = statSync(path);
  const start = stat.size > MAX_LOG_BYTES ? stat.size - MAX_LOG_BYTES : 0;
  const fd = openSync(path, 'r');
  try {
    const len = stat.size - start;
    const buf = Buffer.alloc(len);
    const read = readSync(fd, buf, 0, len, start);
    return buf.toString('utf8', 0, read);
  } finally {
    closeSync(fd);
  }
}

/** These endpoints answer in kilobytes. A hostile or wedged server streaming
 *  without end would otherwise be bounded only by the abort timeout — measured
 *  at +8 GB RSS in 10s, which OOM-kills the CLI instead of degrading to
 *  UNKNOWN the way every other probe failure does. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

async function defaultFetchText(url: string): Promise<string> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), EXEC_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      throw new Error(`response too large: ${declared} bytes`);
    }
    if (!res.body) return await res.text();
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('response exceeded the size cap');
      }
      chunks.push(value);
    }
    return new TextDecoder().decode(
      chunks.reduce<Uint8Array>((acc, c) => {
        const out = new Uint8Array(acc.length + c.length);
        out.set(acc);
        out.set(c, acc.length);
        return out;
      }, new Uint8Array()),
    );
  } finally {
    clearTimeout(t);
  }
}

/** Strip userinfo before a URL reaches the report. Node's fetch turns
 *  `http://user:pass@host` into an Authorization header, and `--json` exists
 *  to be piped into monitors and stored. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = '';
      u.password = '';
      return u.toString().replace(/\/$/, '');
    }
    return url;
  } catch {
    return url;
  }
}

/** Strip ANSI escape sequences and C0 control characters from a
 * SERVER-PROVIDED string before it reaches the terminal or a JSON report
 * (CWE-117 — the strata engine model, live state, and unit details all
 * cross a trust boundary; same doctrine as merge-gate's sanitize()). */
export function sanitizeServerText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return String(text)
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

/** Pull `-np`, `-c` and `--ctx-checkpoints` out of a systemd ExecStart blob. */
export function parseExecStartFlags(execStart: string): {
  rails?: number;
  poolCells?: number;
  ctxCheckpoints?: number;
} {
  const num = (re: RegExp) => {
    const m = re.exec(execStart);
    return m ? Number(m[1]) : undefined;
  };
  return {
    rails: num(/(?:^|\s)-np\s+(\d+)/),
    poolCells: num(/(?:^|\s)-c\s+(\d+)/),
    ctxCheckpoints: num(/(?:^|\s)(?:--ctx-checkpoints|-ctxcp)\s+(\d+)/),
  };
}

export interface UnitState {
  active?: string;
  mainPid?: number;
  uptimeSeconds?: number;
  execStart?: string;
  /** ISO-ish timestamp systemd reported, passed to journalctl --since. */
  activeEnterTimestamp?: string;
}

/**
 * systemd renders timestamps as "Mon 2026-09-21 09:54:00 AEST", which
 * Date.parse rejects outright (NaN) because of the weekday prefix and the
 * non-standard zone abbreviation. Pull out the ISO-ish core and parse that as
 * local time — which is the zone systemd printed it in.
 *
 * Returns NaN for anything unparseable, so callers keep reporting "unknown"
 * rather than inventing an uptime.
 */
export function parseSystemdTimestamp(value?: string): number {
  if (!value) return NaN;
  const m = /(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})/.exec(value);
  return m ? Date.parse(m[1].replace(' ', 'T')) : NaN;
}

export function probeUnit(unit: string, deps?: ProbeDeps): UnitState | null {
  if (!UNIT_NAME_RE.test(unit)) return null;
  const exec = deps?.exec ?? defaultExec;
  const now = deps?.now ?? Date.now;
  try {
    const out = exec('systemctl', [
      '--user',
      'show',
      '-p',
      'ActiveState,MainPID,ActiveEnterTimestamp,ExecStart',
      '--',
      unit,
    ]);
    const props: Record<string, string> = {};
    for (const line of out.split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0) props[line.slice(0, eq)] = line.slice(eq + 1);
    }
    const started = parseSystemdTimestamp(props.ActiveEnterTimestamp);
    const pid = Number(props.MainPID);
    return {
      active: props.ActiveState || undefined,
      mainPid: Number.isFinite(pid) && pid > 0 ? pid : undefined,
      uptimeSeconds: Number.isFinite(started) ? Math.max(0, Math.round((now() - started) / 1000)) : undefined,
      execStart: props.ExecStart || undefined,
      activeEnterTimestamp: props.ActiveEnterTimestamp || undefined,
    };
  } catch {
    return null; // no systemctl (container, macOS) — UNKNOWN, not a guess
  }
}

const PREFILL_RE =
  /prompt eval time\s*=\s*[0-9.]+ ms\s*\/\s*(\d+) tokens[^)]{0,200}?([0-9.]+) tokens per second/;
const DIVERGENCE_RE = /edit\/divergence sample \([a-z_/]+\) = \(([0-9/]+)/;
const RESTORED_RE = /restored context checkpoint \([^)]*?n_past = (\d+)/;
const TS_RE = /^(\w{3} \d{2} \d{2}:\d{2}:\d{2})/;
/** Both the divergence and the restore line carry `| task N |`. */
const TASK_RE = /\|\s*task\s+(-?\d+)\s*\|/;
/** Bound the in-flight map: a turn whose restore never arrives is resolved at
 *  the end, but a multi-GB journal must not accumulate unboundedly. */
const MAX_PENDING = 4096;

/**
 * Scrape prefill throughput, checkpoint accounting and timeouts from the
 * journal for one unit, since `since`.
 *
 * Checkpoint accounting needs two lines correlated: the divergence sample
 * says how much WAS reusable, and a nearby "restored context checkpoint"
 * says how much was actually recovered. A divergence line with no restore
 * before the next divergence means nothing was restored — which is the
 * starvation case, so it counts as restored=0 rather than being dropped.
 */
/** `llama-server[PID]:` — a change of PID is a restart inside the window. */
const PID_RE = /llama-server\[(\d+)\]/;

export function parseServerJournal(
  text: string,
  year = new Date().getFullYear(),
): { prefill: PrefillSample[]; checkpoints: CheckpointSample[]; processCount: number } {
  const prefill: PrefillSample[] = [];
  const checkpoints: CheckpointSample[] = [];
  // Keyed by task id, NOT a single slot-blind variable. With -np > 1 both
  // slots write to the same journal and their lines interleave
  // (id 0 divergence -> id 1 divergence -> id 0 restore), so a single
  // `pending` would pair slot 0's restore with slot 1's divergence and report
  // both turns wrongly. Task ids are unique per turn and appear on both lines.
  const pending = new Map<string, { incoming: number; reusable: number }>();
  let at = 0;
  // Journal lines carry no year. Reading them oldest-first, a timestamp that
  // jumps BACKWARDS means the log crossed into a new year, so the running year
  // advances. Without this a window spanning 31 Dec scrambles the early/recent
  // split that the whole trend rests on.
  let runningYear = year;
  let prevAt = 0;
  const pids = new Set<string>();

  const settle = (key: string, restored: number) => {
    const p = pending.get(key);
    if (!p) return;
    checkpoints.push({ incoming: p.incoming, reusable: p.reusable, restored });
    pending.delete(key);
  };

  for (const line of text.split('\n')) {
    const pid = PID_RE.exec(line)?.[1];
    if (pid) pids.add(pid);

    const ts = TS_RE.exec(line);
    if (ts) {
      let parsed = Date.parse(`${ts[1]} ${runningYear}`);
      if (Number.isFinite(parsed)) {
        // More than a day backwards is a year boundary, not clock jitter.
        if (prevAt && parsed < prevAt - 86_400_000) {
          runningYear += 1;
          parsed = Date.parse(`${ts[1]} ${runningYear}`);
        }
        if (Number.isFinite(parsed)) {
          at = parsed;
          prevAt = parsed;
        }
      }
    }

    const p = PREFILL_RE.exec(line);
    if (p) {
      prefill.push({ at, tokens: Number(p[1]), tokensPerSecond: Number(p[2]) });
      continue;
    }

    const task = TASK_RE.exec(line)?.[1];

    const d = DIVERGENCE_RE.exec(line);
    if (d) {
      // (cached/incoming/lcp/reusable/rewind/append/cache_prompt)
      const parts = d[1].split('/').map(Number);
      if (parts.length >= 4 && Number.isFinite(parts[1]) && Number.isFinite(parts[3])) {
        const key = task ?? `anon:${checkpoints.length}:${pending.size}`;
        if (pending.size >= MAX_PENDING) {
          // Oldest first: a turn this stale will never see its restore.
          const oldest = pending.keys().next();
          if (!oldest.done) settle(oldest.value, 0);
        }
        pending.set(key, { incoming: parts[1], reusable: parts[3] });
      }
      continue;
    }

    const r = RESTORED_RE.exec(line);
    if (r && task !== undefined) {
      settle(task, Number(r[1]));
    }
  }
  // A divergence with no restore is the STARVATION case — the whole point of
  // this measurement — so it settles at 0 rather than being discarded.
  for (const key of [...pending.keys()]) settle(key, 0);
  return { prefill, checkpoints, processCount: pids.size };
}

export function probeJournal(
  unit: string,
  since: string | undefined,
  deps?: ProbeDeps,
  until?: string,
): { prefill: PrefillSample[]; checkpoints: CheckpointSample[]; processCount: number } | null {
  if (!UNIT_NAME_RE.test(unit)) return null;
  const exec = deps?.exec ?? defaultExec;
  try {
    const out = exec('journalctl', [
      '--user',
      '-u',
      unit,
      '--since',
      since && since.trim() ? since : '-24h',
      ...(until && until.trim() ? ['--until', until] : []),
      '--no-pager',
    ]);
    return parseServerJournal(out);
  } catch {
    return null;
  }
}

export function countProxyTimeouts(
  unit: string,
  since: string,
  deps?: ProbeDeps,
  until?: string,
): number | undefined {
  if (!UNIT_NAME_RE.test(unit)) return undefined;
  const exec = deps?.exec ?? defaultExec;
  try {
    const args = ['--user', '-u', unit, '--since', since];
    if (until && until.trim()) args.push('--until', until);
    args.push('--no-pager');
    const out = exec('journalctl', args);
    return out.split('\n').filter((l) => l.includes('GENERATION TIMEOUT')).length;
  } catch {
    return undefined;
  }
}

export interface SlotsInfo {
  slots?: number;
  nCtx?: number;
  kvBitsPerValue?: number;
  anyProcessing?: boolean;
}

export async function probeSlots(baseUrl: string, deps?: ProbeDeps): Promise<SlotsInfo | null> {
  const fetchText = deps?.fetchText ?? defaultFetchText;
  try {
    const body = await fetchText(`${baseUrl.replace(/\/$/, '')}/slots`);
    const arr = JSON.parse(body);
    if (!Array.isArray(arr) || arr.length === 0) return null;
    return {
      slots: arr.length,
      nCtx: typeof arr[0].n_ctx === 'number' ? arr[0].n_ctx : undefined,
      kvBitsPerValue: typeof arr[0].kv_bpv === 'number' ? arr[0].kv_bpv : undefined,
      anyProcessing: arr.some((s: { is_processing?: boolean }) => s.is_processing === true),
    };
  } catch {
    return null;
  }
}

/** VBR floor from /props, so the "pinned at the floor" test uses the server's
 * own configured floor rather than a hardcoded constant. */
export async function probeVbrFloor(baseUrl: string, deps?: ProbeDeps): Promise<number | undefined> {
  const fetchText = deps?.fetchText ?? defaultFetchText;
  try {
    const body = await fetchText(`${baseUrl.replace(/\/$/, '')}/props`);
    const props = JSON.parse(body);
    const floor = props?.vbr?.floor_bpv;
    return typeof floor === 'number' ? floor : undefined;
  } catch {
    return undefined;
  }
}

export interface MetricsInfo {
  promptTokens?: number;
  promptSeconds?: number;
  cachedPromptTokens?: number;
  busySlotsPerDecode?: number;
}

export function parseMetrics(text: string): MetricsInfo {
  const val = (name: string) => {
    const m = new RegExp(`^${name}\\s+([0-9.eE+-]+)`, 'm').exec(text);
    return m ? Number(m[1]) : undefined;
  };
  return {
    promptTokens: val('llamacpp:prompt_tokens_total'),
    promptSeconds: val('llamacpp:prompt_seconds_total'),
    cachedPromptTokens: val('llamacpp:prompt_tokens_cached_total'),
    busySlotsPerDecode: val('llamacpp:n_busy_slots_per_decode'),
  };
}

export interface StrataInfo {
  engine: StrataEngine;
  live: StrataLive;
  samples: StrataSamples;
}

export interface CollectOptions {
  serverUnit: string;
  proxyUnit: string;
  baseUrl: string;
  /** journalctl --since expression; default: this process's start. */
  since?: string;
  /** journalctl --until expression — for analysing a PAST incident window. */
  until?: string;
  /**
   * Which backend kind is on `baseUrl`. 'auto' (default) fetches /metrics
   * once and classifies: strata serves a JSON document with an engine block,
   * llama.cpp serves Prometheus text with llamacpp: counters.
   */
  backend?: 'auto' | 'llamacpp' | 'strata';
  /** Strata serve log path — the process-lifetime sample source (the
   * /metrics requests ring is bounded and short). No default in-repo: the
   * path is per-machine; the CLI wires $UAP_STRATA_LOG into it. */
  strataLogPath?: string;
}

export interface Collected {
  snapshot: InferenceSnapshot;
  unit: UnitState | null;
  slots: SlotsInfo | null;
  metrics: MetricsInfo | null;
  /** Strata-only readings; null on the llama.cpp path. */
  strata: StrataInfo | null;
  /** Which backend produced the snapshot. */
  backend: 'llamacpp' | 'strata' | 'auto-unresolved';
  /** Probes that could not run, so the report can say so out loud. */
  unavailable: string[];
}

/**
 * Fetch + classify /metrics in one round trip. Strata's /metrics is JSON with
 * an `engine.model`; llama.cpp's is Prometheus text. Anything else is neither.
 */
async function probeStrataMetrics(
  baseUrl: string,
  deps?: ProbeDeps,
): Promise<{ strata: StrataInfo; raw: string } | { strata: null; raw: string | null }> {
  const fetchText = deps?.fetchText ?? defaultFetchText;
  let raw: string | null = null;
  try {
    raw = await fetchText(`${baseUrl.replace(/\/$/, '')}/metrics`);
  } catch {
    return { strata: null, raw: null };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!looksLikeStrataMetrics(parsed)) return { strata: null, raw };
    const { engine, live } = parseStrataEngine(parsed);
    return {
      strata: {
        // engine.model and live.state are SERVER-PROVIDED and are printed
        // by both the doctor and the inference headline — sanitize them at
        // this boundary, the last point where the code knows their origin
        // (CWE-117). JSON consumers get the sanitized values too.
        engine: {
          ...engine,
          model: engine.model !== undefined ? sanitizeServerText(engine.model) : undefined,
        },
        live: {
          ...live,
          state: live.state !== undefined ? sanitizeServerText(live.state) : undefined,
        },
        samples: parseStrataRequests(parsed.requests),
      },
      raw,
    };
  } catch {
    return { strata: null, raw };
  }
}

/** Read + parse the strata serve log. Fails soft (null) like every probe. */
export function probeStrataLog(path: string, deps?: ProbeDeps): StrataSamples | null {
  const readTextFile = deps?.readTextFile ?? defaultReadTextFile;
  try {
    return parseStrataLog(readTextFile(path));
  } catch {
    return null;
  }
}

/**
 * Parse a journalctl-style window expression into epoch ms, for filtering
 * the strata /metrics ring in a windowed replay. Supports the two grammars a
 * caller can actually produce with this CLI: absolute "YYYY-MM-DD" or
 * "YYYY-MM-DD HH:MM[:SS]" (local time, journalctl's own grammar) and
 * relative "-<n><smhdwY>". Anything else returns undefined and the caller
 * DISCLOSES the unapplied window rather than guessing a bound.
 */
export function parseWindowExpr(expr: string | undefined): number | undefined {
  if (!expr || !expr.trim()) return undefined;
  const e = expr.trim();
  const rel = /^-(\d+)\s*([smhdwy])$/i.exec(e);
  if (rel) {
    const n = Number(rel[1]);
    if (!Number.isFinite(n) || n < 0) return undefined;
    const unitMs: Record<string, number> = {
      s: 1_000,
      m: 60_000,
      h: 3_600_000,
      d: 86_400_000,
      w: 604_800_000,
      y: 31_536_000_000,
    };
    return Date.now() - n * unitMs[rel[2].toLowerCase()];
  }
  const abs = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(e);
  if (abs) {
    const iso = `${abs[1]}T${abs[2] ?? '00'}:${abs[3] ?? '00'}:${abs[4] ?? '00'}`;
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : undefined;
  }
  return undefined;
}

export async function collect(opts: CollectOptions, deps?: ProbeDeps): Promise<Collected> {
  const unavailable: string[] = [];
  const validServerUnit = UNIT_NAME_RE.test(opts.serverUnit);
  const unit = probeUnit(opts.serverUnit, deps);
  // "systemctl missing" and "you typo'd the unit name" are different problems
  // and the report should not blame the wrong one.
  if (!unit) unavailable.push(validServerUnit ? 'systemctl' : `invalid unit name: ${opts.serverUnit}`);

  // Backend resolution: one /metrics fetch classifies strata vs llama.cpp,
  // doubles as the strata engine probe, and runs CONCURRENTLY with the
  // backend-agnostic /slots and /props probes — the old code fetched all
  // three in parallel, and serialization here would have been a latency
  // regression for every llama.cpp user.
  const wanted = opts.backend ?? 'auto';
  const [metricsProbe, slots, vbrFloor] = await Promise.all([
    probeStrataMetrics(opts.baseUrl, deps),
    probeSlots(opts.baseUrl, deps),
    probeVbrFloor(opts.baseUrl, deps),
  ]);
  const detected: 'strata' | 'llamacpp' | 'auto-unresolved' =
    wanted === 'auto'
      ? metricsProbe.strata !== null
        ? 'strata'
        : metricsProbe.raw !== null && /llamacpp:/.test(metricsProbe.raw)
          ? 'llamacpp'
          : 'auto-unresolved'
      : wanted;
  const backend: 'llamacpp' | 'strata' =
    detected === 'strata' || (detected === 'auto-unresolved' && wanted === 'strata') ? 'strata' : 'llamacpp';
  if (!slots) unavailable.push(redactUrl(`${opts.baseUrl.replace(/\/$/, '')}/slots`));
  if (detected === 'auto-unresolved' && wanted === 'auto' && metricsProbe.raw !== null) {
    unavailable.push(
      `${redactUrl(`${opts.baseUrl.replace(/\/$/, '')}/metrics`)} — neither a strata JSON document nor llama.cpp Prometheus text`,
    );
  }

  // Every other probe records its own failure. This one did not, and because
  // `undefined ?? 0` means "no finding", a failed read turned a RED incident
  // window into a confident GREEN that passed --strict with exit 0.
  const timeouts = countProxyTimeouts(opts.proxyUnit, sinceForWindow(opts, unit), deps, opts.until);
  if (timeouts === undefined) {
    unavailable.push(
      UNIT_NAME_RE.test(opts.proxyUnit)
        ? `journalctl (${opts.proxyUnit})`
        : `invalid proxy unit name: ${opts.proxyUnit}`,
    );
  }

  if (backend === 'strata') {
    return collectStrata({ opts, unit, slots, timeouts, unavailable, metricsProbe, detected: 'strata', deps });
  }
  return collectLlamacpp({
    opts,
    unit,
    slots,
    timeouts,
    unavailable,
    metricsProbe,
    detected,
    vbrFloor,
    deps,
  });
}

/**
 * Resolve the journal window once, shared by both backends. With --until, the
 * CURRENT process's start must NOT be the fallback: for any past incident it
 * is LATER than the window's end, journalctl then gets since > until, returns
 * nothing, and the report is a clean UNKNOWN with no hint the window was
 * backwards. Normalised with `||` not `??` — an empty --since is not nullish.
 */
function sinceForWindow(opts: CollectOptions, unit: UnitState | null): string {
  const unitSince = unit?.activeEnterTimestamp
    ? (/(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/.exec(unit.activeEnterTimestamp)?.[1] ?? undefined)
    : undefined;
  return opts.since?.trim() || (opts.until ? '-24h' : unitSince) || '-24h';
}

interface CollectContext {
  opts: CollectOptions;
  unit: UnitState | null;
  slots: SlotsInfo | null;
  timeouts: number | undefined;
  unavailable: string[];
  metricsProbe: Awaited<ReturnType<typeof probeStrataMetrics>>;
  /** What detection (or the explicit --backend) concluded — passed through
   * to Collected.backend so an unclassifiable server is reported as
   * 'auto-unresolved' in --json rather than silently labelled 'llamacpp'. */
  detected: 'llamacpp' | 'strata' | 'auto-unresolved';
  deps?: ProbeDeps;
}

/** llama.cpp path — unchanged behaviour except that /metrics is fetched once
 * (shared with backend detection) and ExecStart flags only count when the
 * unit is actually ACTIVE. */
async function collectLlamacpp(ctx: CollectContext & { vbrFloor: number | undefined }): Promise<Collected> {
  const { opts, unit, slots, timeouts, unavailable, metricsProbe, vbrFloor } = ctx;
  const flags = activeUnitFlags(unit);

  const journal = probeJournal(opts.serverUnit, sinceForWindow(opts, unit), ctx.deps, opts.until);
  if (!journal && UNIT_NAME_RE.test(opts.serverUnit)) unavailable.push('journalctl');

  const metrics = metricsProbe.raw !== null ? parseMetrics(metricsProbe.raw) : null;
  if (!metrics) unavailable.push(redactUrl(`${opts.baseUrl.replace(/\/$/, '')}/metrics`));

  // In a historical replay the live readings belong to a DIFFERENT process
  // than the journal window, so they are dropped rather than attributed to it.
  // (This is how an early version reported "--ctx-checkpoints 4" as the remedy
  // for a window in which it had been 1.)
  const historical = Boolean(opts.until);
  const snapshot: InferenceSnapshot = {
    uptimeSeconds: historical ? undefined : unit?.uptimeSeconds,
    // `flags` comes from the CURRENT unit's ExecStart, so in a replay it
    // describes the wrong process just as much as kv/uptime do — and it fed a
    // "N rails share one M-cell pool" finding that printed under the REPLAY
    // banner as though it described the window.
    rails: historical ? undefined : (flags.rails ?? slots?.slots),
    poolCells: historical ? undefined : (flags.poolCells ?? slots?.nCtx),
    ctxCheckpoints: historical ? undefined : flags.ctxCheckpoints,
    kvBitsPerValue: historical ? undefined : slots?.kvBitsPerValue,
    kvFloorBitsPerValue: historical ? undefined : vbrFloor,
    prefill: journal?.prefill ?? [],
    checkpoints: journal?.checkpoints ?? [],
    processCount: journal?.processCount,
    generationTimeouts: timeouts,
    backend: 'llamacpp',
  };

  return {
    snapshot,
    unit,
    slots,
    metrics,
    strata: null,
    // 'auto-unresolved' passes through on a detection miss (disclosed in
    // unavailable); the snapshot itself still describes the llama.cpp path
    // that was taken.
    backend: ctx.detected === 'llamacpp' ? 'llamacpp' : 'auto-unresolved',
    unavailable,
  };
}

/**
 * ExecStart flags are only live truth when the unit is ACTIVE. An inactive
 * unit still reports its ExecStart to systemctl, and the old code trusted it:
 * on 2026-10-04, with uap-gsq-rco-server.service dead (its -c 229376 still
 * probed) and strata serving a 131072 pool on :8080, `uap inference health`
 * printed "pool 229,376 cells" for a backend that did not exist. The /slots
 * fallback is the only live geometry for a unit-less backend.
 */
function activeUnitFlags(unit: UnitState | null): ReturnType<typeof parseExecStartFlags> {
  return unit?.active === 'active' && unit.execStart ? parseExecStartFlags(unit.execStart) : {};
}

/** Strata path — /metrics engine + serve log for samples, /slots for rails. */
async function collectStrata(ctx: CollectContext): Promise<Collected> {
  const { opts, unit, slots, timeouts, unavailable, metricsProbe, deps } = ctx;
  const strata = metricsProbe.strata;
  if (!strata) {
    // Explicitly requested but the server did not answer as strata.
    unavailable.push(redactUrl(`${opts.baseUrl.replace(/\/$/, '')}/metrics`) + ' (strata)');
    return {
      snapshot: {
        prefill: [],
        checkpoints: [],
        generationTimeouts: timeouts,
        backend: 'strata',
      },
      unit,
      slots,
      metrics: null,
      strata: null,
      backend: 'strata',
      unavailable,
    };
  }

  // Samples: the serve log is the process-lifetime record (thousands of
  // lines, no timestamps — `at` is a monotonic line index); the /metrics ring
  // is timestamped but bounded (observed 12). Live view prefers the log;
  // a windowed replay (--until) must use the ring, because log position is
  // not wall time and cannot be windowed.
  let samples: StrataSamples = strata.samples;
  let logUsed = false;
  if (!opts.until) {
    if (opts.since?.trim()) {
      // The log spans the whole process life and carries no timestamps, so a
      // --since request CANNOT be honoured there. Say so instead of silently
      // analysing a window the caller did not ask for.
      unavailable.push(
        `--since ${opts.since} was not applied: the strata serve log has no timestamps — the analysis covers the whole log`,
      );
    }
    if (opts.strataLogPath && opts.strataLogPath.trim()) {
      const fromLog = probeStrataLog(opts.strataLogPath, deps);
      if (fromLog) {
        if (fromLog.prefill.length > 0) {
          samples = fromLog;
          logUsed = true;
        } else {
          unavailable.push(`${opts.strataLogPath} — parsed, but no request lines`);
        }
      } else {
        unavailable.push(opts.strataLogPath);
      }
    }
  } else {
    // Windowed replay: the ring carries real epoch ms, so the requested
    // window CAN be applied — and must be, or a "past incident" replay would
    // quietly analyse the CURRENT process's last few requests under the
    // REPLAY banner, the exact wrong-process misattribution this command
    // exists to prevent. An unparseable expression is disclosed, never
    // silently ignored.
    const sinceMs = parseWindowExpr(opts.since);
    const untilMs = parseWindowExpr(opts.until);
    if (untilMs === undefined) {
      unavailable.push(`--until '${opts.until}' could not be parsed — ring samples left unfiltered`);
    } else if (opts.since?.trim() && sinceMs === undefined) {
      unavailable.push(`--since '${opts.since}' could not be parsed — lower bound not applied to ring samples`);
    } else {
      const inWindow = (at: number) =>
        at <= untilMs && (sinceMs === undefined || at >= sinceMs);
      samples = {
        prefill: strata.samples.prefill.filter((s) => inWindow(s.at)),
        decode: strata.samples.decode.filter((s) => inWindow(s.at)),
        reuse: strata.samples.reuse.filter((s) => inWindow(s.at)),
        // Draft records carry no timestamp, so they cannot be windowed; a
        // replay drops them rather than reporting the CURRENT process's
        // acceptance rate under the REPLAY banner.
        drafts: [],
      };
    }
  }

  const snapshot: InferenceSnapshot = {
    // Strata has no unit; the declared llama unit's uptime would describe a
    // dead process. Uptime for strata comes from the log's own line count
    // only implicitly, so leave it unset rather than attributing a wrong one.
    uptimeSeconds: undefined,
    rails: slots?.slots ?? 1,
    poolCells: strata.engine.maxContext ?? slots?.nCtx,
    kvBitsPerValue: strataKvBitsPerValue(strata.engine.kv),
    // Fixed-tier KV (int8) has no degrade floor; undefined means no
    // pinned-at-floor finding, which is correct — there is no floor to pin at.
    kvFloorBitsPerValue: undefined,
    prefill: samples.prefill,
    checkpoints: [],
    decode: samples.decode,
    reuse: samples.reuse,
    vramFreeMiB: strata.engine.vramFreeMiB,
    engineModel: strata.engine.model,
    generationTimeouts: timeouts,
    backend: 'strata',
  };
  if (!logUsed && !opts.until) {
    // The ring is bounded; a trend over it alone is usually too thin, and the
    // operator should know WHY rather than read the note as "server broken".
    unavailable.push(
      `strata serve log (set --strata-log or $UAP_STRATA_LOG for a process-lifetime trend; ` +
        `${samples.prefill.length} ring sample(s) used)`,
    );
  }

  return { snapshot, unit, slots, metrics: null, strata: { ...strata, samples }, backend: 'strata', unavailable };
}
