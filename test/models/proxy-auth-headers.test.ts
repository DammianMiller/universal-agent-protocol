/**
 * proxyAuthHeaders: side-endpoint probes must authenticate too.
 *
 * The model calls went through resolveRequestCredential, but the proxy also
 * serves `/v1/context` and `/props`, which helpers probed with a bare fetch and
 * no headers. Those 401'd — and because every probe is fail-soft the breakage
 * was silent: context-window discovery fell back to a preset instead of the live
 * per-rail window, and the realtime adaptor saw no utilization at all and
 * treated a full context as nominal. Nothing errored; the numbers were wrong.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let root: string;
let cwdSpy: ReturnType<typeof vi.spyOn> | undefined;
const savedToken = process.env.PROXY_AUTH_TOKEN;
const savedXdg = process.env.XDG_CONFIG_HOME;

async function freshHeaders() {
  vi.resetModules();
  const mod = await import('../../src/models/openai-compat-client.js');
  return mod.proxyAuthHeaders;
}

beforeEach(() => {
  root = join(tmpdir(), `uap-probeauth-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(root, '.uap'), { recursive: true });
  writeFileSync(join(root, '.uap', 'proxy.env'), 'PROXY_AUTH_TOKEN=tok-probe\n');
  delete process.env.PROXY_AUTH_TOKEN;
  process.env.XDG_CONFIG_HOME = join(root, 'empty-xdg');
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(root);
});

afterEach(() => {
  cwdSpy?.mockRestore();
  cwdSpy = undefined;
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  if (savedToken === undefined) delete process.env.PROXY_AUTH_TOKEN;
  else process.env.PROXY_AUTH_TOKEN = savedToken;
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
});

describe('proxyAuthHeaders', () => {
  it('authenticates a probe to the local proxy', async () => {
    const h = await freshHeaders();
    expect(h('http://127.0.0.1:4000/v1/context')).toEqual({ Authorization: 'Bearer tok-probe' });
  });

  it('covers the non-/v1 probe path too (llama /props via the proxy)', async () => {
    const h = await freshHeaders();
    expect(h('http://127.0.0.1:4000/props')).toEqual({ Authorization: 'Bearer tok-probe' });
  });

  it('sends nothing to a non-local host — a probe must not leak the token', async () => {
    const h = await freshHeaders();
    expect(h('https://api.example.com/v1/context')).toEqual({});
  });

  it('returns {} rather than throwing on a malformed URL', async () => {
    // A probe must degrade, never take down its caller: these helpers are all
    // wrapped in fail-soft try/catch and a throw here would defeat that.
    const h = await freshHeaders();
    expect(h('not a url')).toEqual({});
  });
});
