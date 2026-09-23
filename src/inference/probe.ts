/**
 * Collectors for `uap inference health`.
 *
 * Every probe fails OPEN: a missing systemctl, journal, or server yields
 * undefined rather than a fabricated reading, so the analysis can say
 * UNKNOWN instead of inventing a GREEN. Same posture as src/capacity/probe.ts.
 */
import { execFileSync } from 'node:child_process';
import type { CheckpointSample, InferenceSnapshot, PrefillSample } from './analysis.js';

const EXEC_TIMEOUT_MS = 10_000;

/** systemd unit names: strict charset, never a leading dash — a name like
 * "--host=x.service" would be parsed by systemctl as a FLAG (CWE-88). */
const UNIT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9:_.@-]*\.service$/;

export interface ProbeDeps {
  /** Run a command and return stdout; throw on failure. */
  exec?: (cmd: string, args: string[]) => string;
  /** Fetch a URL and return the body; throw on failure. */
  fetchText?: (url: string) => Promise<string>;
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

export async function probeMetrics(baseUrl: string, deps?: ProbeDeps): Promise<MetricsInfo | null> {
  const fetchText = deps?.fetchText ?? defaultFetchText;
  try {
    return parseMetrics(await fetchText(`${baseUrl.replace(/\/$/, '')}/metrics`));
  } catch {
    return null;
  }
}

export interface CollectOptions {
  serverUnit: string;
  proxyUnit: string;
  baseUrl: string;
  /** journalctl --since expression; default: this process's start. */
  since?: string;
  /** journalctl --until expression — for analysing a PAST incident window. */
  until?: string;
}

export interface Collected {
  snapshot: InferenceSnapshot;
  unit: UnitState | null;
  slots: SlotsInfo | null;
  metrics: MetricsInfo | null;
  /** Probes that could not run, so the report can say so out loud. */
  unavailable: string[];
}

export async function collect(opts: CollectOptions, deps?: ProbeDeps): Promise<Collected> {
  const unavailable: string[] = [];
  const validServerUnit = UNIT_NAME_RE.test(opts.serverUnit);
  const unit = probeUnit(opts.serverUnit, deps);
  // "systemctl missing" and "you typo'd the unit name" are different problems
  // and the report should not blame the wrong one.
  if (!unit) unavailable.push(validServerUnit ? 'systemctl' : `invalid unit name: ${opts.serverUnit}`);

  const flags = unit?.execStart ? parseExecStartFlags(unit.execStart) : {};

  // Default the window to this process's own lifetime: throughput decay is a
  // property of ONE process, so mixing in a previous process's samples would
  // manufacture a cliff at the restart boundary.
  // journalctl accepts "YYYY-MM-DD HH:MM:SS"; the weekday prefix systemd adds
  // is not part of that grammar, so strip to the core before passing it on.
  const unitSince = unit?.activeEnterTimestamp
    ? (/(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/.exec(unit.activeEnterTimestamp)?.[1] ?? undefined)
    : undefined;
  // Normalised once, and with `||` not `??`: an empty --since is not nullish,
  // so it used to reach journalctl verbatim. probeJournal guarded against that
  // but countProxyTimeouts did not, so the prefill analysis proceeded while
  // the timeout evidence silently vanished.
  //
  // With --until, `unitSince` must NOT be the fallback: it is the CURRENTLY
  // running process's start, which for any past incident is LATER than the
  // window's end. journalctl then gets since > until, returns nothing, and the
  // report is a clean UNKNOWN with no hint the window was backwards.
  const since = opts.since?.trim() || (opts.until ? '-24h' : unitSince) || '-24h';

  const journal = probeJournal(opts.serverUnit, since, deps, opts.until);
  if (!journal && validServerUnit) unavailable.push('journalctl');

  const [slots, metrics, vbrFloor] = await Promise.all([
    probeSlots(opts.baseUrl, deps),
    probeMetrics(opts.baseUrl, deps),
    probeVbrFloor(opts.baseUrl, deps),
  ]);
  if (!slots) unavailable.push(redactUrl(`${opts.baseUrl.replace(/\/$/, '')}/slots`));
  if (!metrics) unavailable.push(redactUrl(`${opts.baseUrl.replace(/\/$/, '')}/metrics`));

  // Every other probe records its own failure. This one did not, and because
  // `undefined ?? 0` means "no finding", a failed read turned a RED incident
  // window into a confident GREEN that passed --strict with exit 0.
  const timeouts = countProxyTimeouts(opts.proxyUnit, since, deps, opts.until);
  if (timeouts === undefined) {
    unavailable.push(
      UNIT_NAME_RE.test(opts.proxyUnit)
        ? `journalctl (${opts.proxyUnit})`
        : `invalid proxy unit name: ${opts.proxyUnit}`,
    );
  }

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
  };

  return { snapshot, unit, slots, metrics, unavailable };
}
