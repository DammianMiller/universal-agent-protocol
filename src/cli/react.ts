import { resolve, type ReactorContext, type ReactorOptions } from '../coordination/reactor.js';
import { maybeWriteRecipeSignal } from '../coordination/recipe-signal.js';
import { loadUapConfigRaw } from '../utils/config-loader.js';

/**
 * Pure core of `uap react`: parse a JSON ReactorContext payload, resolve the
 * dynamic UAP capabilities for the event, and return the JSON ReactorResult.
 * Harness adapters pipe a payload in and map `inject`/`block`/`actions` to the
 * harness's native hook output.
 */
export function runReact(payloadJson: string, opts?: ReactorOptions): string {
  const ctx = JSON.parse(payloadJson) as ReactorContext;
  // Default to the process cwd so the reactor can locate the project DESIGN.md
  // for design-system injection (hook adapters rarely set cwd explicitly).
  if (!ctx.cwd) ctx.cwd = process.cwd();
  // Reactor can be turned off via .uap.json (reactor.enabled:false) — the guided
  // setup writes this. Return a no-op result so hook adapters inject nothing.
  try {
    const cfg = loadUapConfigRaw(ctx.cwd) as { reactor?: { enabled?: boolean } } | null;
    if (cfg?.reactor?.enabled === false) {
      return JSON.stringify({
        inject: '',
        block: false,
        reason: 'reactor disabled (.uap.json)',
        actions: [],
        surfacedKeys: [],
        confidence: 0,
      });
    }
  } catch {
    /* fail open — reactor stays on */
  }
  const result = resolve(ctx, opts);
  return JSON.stringify(result);
}

export interface ReactCommandOptions {
  event?: string;
  prompt?: string;
  files?: string[];
  injectThreshold?: string;
  autoSpawnThreshold?: string;
  autoSpawnTypes?: string;
  maxInjectChars?: string;
  surfaced?: string;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf-8').trim();
}

/**
 * `uap react` — resolve dynamic capabilities for a lifecycle event. Reads a
 * JSON ReactorContext on stdin (preferred, for hook adapters) or builds one
 * from flags. Emits the JSON ReactorResult on stdout.
 */
export async function reactCommand(options: ReactCommandOptions = {}): Promise<void> {
  // Flag-driven invocation (e.g. OpenCode plugin) must not block on stdin.
  let payload: string;
  if (options.prompt !== undefined || options.event !== undefined) {
    payload = JSON.stringify({
      event: options.event ?? 'user-prompt',
      promptText: options.prompt ?? '',
      changedFiles: options.files ?? [],
      surfaced: options.surfaced
        ? options.surfaced.split(',').map((k) => k.trim()).filter(Boolean)
        : [],
    });
  } else {
    const stdin = await readStdin();
    payload =
      stdin || JSON.stringify({ event: 'user-prompt', promptText: '', changedFiles: [] });
  }

  const opts: ReactorOptions = {};
  if (options.injectThreshold) opts.injectThreshold = Number(options.injectThreshold);
  if (options.autoSpawnThreshold) opts.autoSpawnThreshold = Number(options.autoSpawnThreshold);
  if (options.autoSpawnTypes) {
    opts.autoSpawnTaskTypes = options.autoSpawnTypes
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (options.maxInjectChars) opts.maxInjectChars = Number(options.maxInjectChars);

  process.stdout.write(runReact(payload, opts) + '\n');

  // Cross-process: stamp the recipe signal for this prompt so the serving-layer
  // proxy can route on the reactor's actual capability/complexity. Best-effort.
  try {
    const promptText = (JSON.parse(payload) as { promptText?: string }).promptText ?? '';
    maybeWriteRecipeSignal(promptText);
  } catch {
    /* fail open */
  }

  // Real-time flag adaptation (P4, auto-on; opt out via realtimeAdapt.enabled or
  // UAP_REALTIME_ADAPT=0): emit a per-session adjustment from live context
  // pressure so the proxy can converge/escalate mid-session. Lazy + gated +
  // fail-open so it never slows the hook.
  try {
    const cwd = process.cwd();
    const { realtimeAdaptEnabled } = await import('../self-tuning/realtime-adaptor.js');
    if (realtimeAdaptEnabled(undefined, cwd)) {
      const { emitAdaptation, fetchSessionContext } = await import('../self-tuning/realtime-adaptor.js');
      const { defaultFlagConfig } = await import('../self-tuning/flags.js');
      const parsed = JSON.parse(payload) as { sessionId?: string };
      const ctxSignals = await fetchSessionContext();
      emitAdaptation(parsed.sessionId ?? 'session', ctxSignals, defaultFlagConfig(), { enabled: true, cwd });
    }
  } catch {
    /* fail open */
  }
}
