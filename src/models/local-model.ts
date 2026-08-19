/**
 * Automatic local-model identity.
 *
 * WHY THIS EXISTS. Every local model preset used to hard-code the exact string
 * the inference server answers to — `qwen35-a3b-iq4xs`, then
 * `qwen36-35b-a3b-iq4xs`, then `qwen3.8-27b`. That is a name for a file on
 * somebody's disk, pinned in four places (the preset's `apiModel`, the tool-call
 * profile's `model`, the proxy's advertised list, and every `.uap.json` that ever
 * ran `uap model routing use`), and it goes stale the moment the served model
 * changes.
 *
 * Measured on 2026-08-19, the day the backend changed: llama.cpp had always
 * IGNORED the OpenAI `model` field, so a stale id cost nothing and the drift went
 * unnoticed for two model generations. The replacement engine VALIDATES it, and
 * every stale id became
 *
 *     HTTP 404 {"code":"model_not_found","message":"model '…' not found"}
 *
 * — including four `claude-*` ids the proxy advertises for SDK compatibility, and
 * this repo's own `roles.fallback`. A pinned name is a latent outage waiting for
 * a backend that checks.
 *
 * So: a preset may declare `apiModel: '__auto__'` and have its wire name resolved
 * from the endpoint at call time. There is exactly one local model on a local
 * server, and it can simply be asked which one it is.
 *
 * CHEAP AND FAIL-SOFT. One `GET /models` per endpoint per process, cached; a
 * short negative cache so an unreachable server does not add a probe to every
 * call; and on any failure the sentinel is returned unchanged, which the proxy
 * then reconciles on the wire (see `_reconcile_wire_model` in
 * tools/agents/scripts/anthropic_proxy.py). Two independent layers resolve this,
 * on purpose: the client so the request is right, and the proxy so it is right
 * even for a client that never asked.
 */

/** Declare this as a preset's `apiModel` to have the served model resolved. */
export const AUTO_MODEL = '__auto__';

/** Is this preset asking for automatic resolution? */
export const isAutoModel = (apiModel: string | undefined): boolean => apiModel === AUTO_MODEL;

/**
 * Ids that belong to a cloud provider and therefore are never the answer to
 * "which model is this local server running".
 *
 * A prefix set, not an allowlist: it only has to recognise the names this proxy
 * advertises for SDK compatibility, and a name it fails to recognise degrades to
 * the old behaviour (pick it) rather than to no answer.
 */
const CLOUD_ID = /^(claude|gpt|o[13]|gemini|grok|mistral|command|deepseek)[-.]/i;

interface CacheEntry {
  id: string | null;
  at: number;
}

const cache = new Map<string, CacheEntry>();
/** A resolved name is stable for the life of a server process; re-ask rarely. */
const HIT_TTL_MS = 300_000;
/** An unreachable server must not add a probe to every single call. */
const MISS_TTL_MS = 15_000;
const PROBE_TIMEOUT_MS = 3_000;

/** Test seam: drop the cache so a test can change what the endpoint reports. */
export function resetLocalModelCache(): void {
  cache.clear();
}

/**
 * Ask an OpenAI-compatible endpoint which model it serves.
 *
 * Returns the FIRST advertised id. On a single-model local server that is the
 * answer; on a multi-model gateway it is a guess, which is why this is only ever
 * reached for a preset that explicitly asked for automatic resolution rather than
 * naming a model.
 */
export async function probeServedModel(endpoint: string): Promise<string | null> {
  const base = endpoint.replace(/\/$/, '');
  const cached = cache.get(base);
  if (cached && Date.now() - cached.at < (cached.id ? HIT_TTL_MS : MISS_TTL_MS)) {
    return cached.id;
  }
  let id: string | null = null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    try {
      const res = await fetch(`${base}/models`, { signal: ctrl.signal });
      if (res.ok) {
        const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
        const rows = Array.isArray(body?.data) ? body.data : [];
        const ids = rows
          .map((r) => (r && typeof r === 'object' ? (r as { id?: unknown }).id : undefined))
          // A served id is a short opaque token. Anything else is a server we do
          // not understand, and guessing from it is worse than leaving the
          // sentinel for the proxy to reconcile.
          .filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200);
        // MEASURED, not assumed: the UAP proxy advertises the four Claude
        // contract ids ALONGSIDE the local model, and it listed them first — so
        // "take the first id" resolved the LOCAL model to
        // `claude-haiku-4-5-20251001`. Skip the cloud-provider names; they are
        // never the model a local endpoint is serving.
        id = ids.find((v) => !CLOUD_ID.test(v)) ?? null;
      }
    } finally {
      clearTimeout(t);
    }
  } catch {
    id = null; // unreachable / timed out / not JSON — fail soft
  }
  cache.set(base, { id, at: Date.now() });
  return id;
}

/**
 * The model name to put on the wire for this preset.
 *
 * A preset that names a model keeps it — automatic resolution is opt-in, so an
 * operator who pinned a specific model is never silently redirected. Only the
 * `__auto__` sentinel is resolved, and only from the endpoint that request is
 * about to be sent to.
 */
export async function resolveWireModel(
  apiModel: string | undefined,
  endpoint: string
): Promise<string | undefined> {
  if (!isAutoModel(apiModel)) return apiModel;
  const served = await probeServedModel(endpoint);
  // Sentinel on failure, NOT a hard-coded guess: the proxy rewrites an id the
  // upstream does not serve, so the sentinel still reaches the right model —
  // whereas a guessed name that happens to be wrong looks like a real request
  // for a real model and 404s.
  return served ?? apiModel;
}
