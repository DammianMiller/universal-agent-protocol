/**
 * Tests for scripts/lib/llama-upstream.sh — the proxy's upstream resolver.
 *
 * Regression origin (2026-08-16): the proxy env pinned LLAMA_CPP_BASE to
 * 127.0.0.1:34407 while Unsloth Studio had restarted its bundled llama-server
 * on 127.0.0.1:59879. Every local request 529'd for hours. The pin must stay
 * authoritative while it works, and only a proven-dead pin may fall through to
 * discovery.
 *
 * `curl` and `ss` are stubbed on PATH so the real resolver code runs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const LIB = join(__dirname, '../scripts/lib/llama-upstream.sh');

let stubDir: string;

/** One `ss -ltnp` row in the real column layout. */
export function ssRow(addr: string, proc = 'llama-server', pid = 2172639): string {
  return `LISTEN 0      512        ${addr}      0.0.0.0:*    users:(("${proc}",pid=${pid},fd=36)) `;
}

interface Env {
  /** Ports whose /health returns 200 AND whose /props looks like llama-server. */
  healthyPorts?: number[];
  /** Ports that answer /health but are NOT a chat server (decoy / embeddings). */
  nonChatPorts?: number[];
  /** Ports serving an OpenAI-compatible engine with NO /props (e.g. ninfer). */
  openaiPorts?: number[];
  /** Ports serving /v1/models but no chat route (an embedding-only server). */
  embedPorts?: number[];
  ss?: string;
  env?: Record<string, string>;
}

function run(args: string[], opts: Env = {}): { stdout: string; status: number | null } {
  const r = spawnSync('bash', [LIB, ...args], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      PATH: `${stubDir}:${process.env.PATH ?? ''}`,
      HEALTHY_PORTS: [
        ...(opts.healthyPorts ?? []),
        ...(opts.nonChatPorts ?? []),
        ...(opts.openaiPorts ?? []),
        ...(opts.embedPorts ?? []),
      ].join(' '),
      CHAT_PORTS: (opts.healthyPorts ?? []).join(' '),
      OPENAI_PORTS: (opts.openaiPorts ?? []).join(' '),
      EMBED_PORTS: (opts.embedPorts ?? []).join(' '),
      SS_FIXTURE: opts.ss ?? '',
      ...(opts.env ?? {}),
    },
  });
  return { stdout: (r.stdout ?? '').trim(), status: r.status };
}

const resolve = (preferred: string, opts: Env = {}) => run(['resolve', preferred], opts).stdout;

beforeAll(() => {
  stubDir = mkdtempSync(join(tmpdir(), 'uap-llama-upstream-'));

  // /health -> 200 for HEALTHY_PORTS. /props and /v1/models return llama-server
  // shaped bodies only for CHAT_PORTS, so a decoy answering 200 is rejected.
  writeFileSync(
    join(stubDir, 'curl'),
    `#!/usr/bin/env bash
url="\${@: -1}"
hostport="\${url#*://}"
path="/\${hostport#*/}"
authority="\${hostport%%/*}"
port="\${authority##*:}"
in_list() { for p in \$2; do [ "\$p" = "\$1" ] && return 0; done; return 1; }
case "\$path" in
  */health)
    if in_list "\$port" "\${HEALTHY_PORTS:-}"; then printf '200'; else printf '000'; fi ;;
  */props)
    if in_list "\$port" "\${CHAT_PORTS:-}"; then
      printf '{"default_generation_settings":{"n_ctx":199680},"modalities":{"vision":true}}'
    fi ;;
  */v1/models)
    if in_list "\$port" "\${CHAT_PORTS:-}"; then
      printf '{"data":[{"id":"unsloth/Qwen3.8-27B-GGUF","capabilities":["completion","multimodal"]}]}'
    elif in_list "\$port" "\${OPENAI_PORTS:-} \${EMBED_PORTS:-}"; then
      printf '{"data":[{"id":"served-model","object":"model"}]}'
    fi ;;
  */v1/chat/completions)
    # A chat request MUST name a model, exactly as the real engine demands: one
    # that omits it is refused with a 400 carrying no choices, which is how the
    # first version of this probe concluded "not chat-capable" about a perfectly
    # good server.
    body="\$(for a in "\$@"; do case "\$a" in '{'*) printf '%s' "\$a";; esac; done)"
    case "\$body" in *'"model"'*) ;; *) printf '{"error":{"message":"missing required field: model"}}'; exit 0;; esac
    if in_list "\$port" "\${OPENAI_PORTS:-}"; then
      printf '{"choices":[{"message":{"role":"assistant","content":"ok"}}]}'
    fi ;;
esac
exit 0
`,
  );
  writeFileSync(join(stubDir, 'ss'), `#!/usr/bin/env bash\nprintf '%s\\n' "\${SS_FIXTURE:-}"\n`);
  chmodSync(join(stubDir, 'curl'), 0o755);
  chmodSync(join(stubDir, 'ss'), 0o755);
});

afterAll(() => {
  rmSync(stubDir, { recursive: true, force: true });
});

describe('llama_upstream_resolve', () => {
  it('keeps the pinned base when it is healthy, even if another server is up', () => {
    expect(
      resolve('http://127.0.0.1:8080/v1', {
        healthyPorts: [8080, 59879],
        ss: ssRow('127.0.0.1:59879'),
      }),
    ).toBe('http://127.0.0.1:8080/v1');
  });

  it('discovers the live llama-server when the pinned base is dead', () => {
    // The exact production failure: pin on a stale Unsloth port, server on a new one.
    expect(
      resolve('http://127.0.0.1:34407/v1', {
        healthyPorts: [59879],
        ss: ssRow('127.0.0.1:59879'),
      }),
    ).toBe('http://127.0.0.1:59879/v1');
  });

  it('falls back to the pinned base when no llama-server is listening', () => {
    expect(resolve('http://127.0.0.1:34407/v1', { healthyPorts: [], ss: '' })).toBe(
      'http://127.0.0.1:34407/v1',
    );
  });

  it('falls back to the pinned base when ss itself fails', () => {
    // Distinct from "nothing listening": the tool is missing or errors (127).
    // Both must degrade to the pin, never to an empty base.
    const failDir = mkdtempSync(join(tmpdir(), 'uap-llama-nossbin-'));
    writeFileSync(join(failDir, 'ss'), '#!/usr/bin/env bash\nexit 127\n');
    chmodSync(join(failDir, 'ss'), 0o755);
    try {
      const r = spawnSync('bash', [LIB, 'resolve', 'http://127.0.0.1:34407/v1'], {
        encoding: 'utf-8',
        env: {
          ...process.env,
          PATH: `${failDir}:${stubDir}:${process.env.PATH ?? ''}`,
          HEALTHY_PORTS: '',
          CHAT_PORTS: '',
        },
      });
      expect((r.stdout ?? '').trim()).toBe('http://127.0.0.1:34407/v1');
    } finally {
      rmSync(failDir, { recursive: true, force: true });
    }
  });

  it('rejects a listener that answers /health but is not a chat server', () => {
    // A decoy, or this host's embedding llama-server. Health alone is not identity.
    expect(
      resolve('http://127.0.0.1:34407/v1', {
        healthyPorts: [],
        nonChatPorts: [8081],
        ss: ssRow('127.0.0.1:8081'),
      }),
    ).toBe('http://127.0.0.1:34407/v1');
  });

  it('prefers the lowest port numerically, not lexicographically', () => {
    // `sort -u` on strings puts "10001" before "8080"; with two healthy servers
    // that made the winner arbitrary — and attacker-selectable.
    expect(
      resolve('http://127.0.0.1:34407/v1', {
        healthyPorts: [8080, 10001],
        ss: [ssRow('127.0.0.1:10001'), ssRow('127.0.0.1:8080')].join('\n'),
      }),
    ).toBe('http://127.0.0.1:8080/v1');
  });

  it('skips a llama-server socket that is not yet answering /health', () => {
    expect(
      resolve('http://127.0.0.1:34407/v1', {
        healthyPorts: [59879],
        ss: [ssRow('127.0.0.1:50047'), ssRow('127.0.0.1:59879')].join('\n'),
      }),
    ).toBe('http://127.0.0.1:59879/v1');
  });

  it('ignores listeners that are not llama-server', () => {
    expect(
      resolve('http://127.0.0.1:34407/v1', {
        healthyPorts: [6333],
        ss: ssRow('127.0.0.1:6333', 'qdrant', 999),
      }),
    ).toBe('http://127.0.0.1:34407/v1');
  });

  it('ignores a process merely NAMED like llama-server', () => {
    // The grep is anchored to the users:(("llama-server" field, so a shim does
    // not qualify by having the string somewhere on the line.
    expect(
      resolve('http://127.0.0.1:34407/v1', {
        healthyPorts: [10001],
        ss: ssRow('127.0.0.1:10001', 'my-llama-server-shim', 4242),
      }),
    ).toBe('http://127.0.0.1:34407/v1');
  });

  it('rejects a llama-server bound to a specific non-loopback address', () => {
    // 127.0.0.1:PORT is a DIFFERENT socket, bindable by another local user.
    expect(
      resolve('http://127.0.0.1:34407/v1', {
        healthyPorts: [59879],
        ss: ssRow('192.168.1.165:59879'),
      }),
    ).toBe('http://127.0.0.1:34407/v1');
  });

  it('accepts a wildcard bind as loopback', () => {
    expect(
      resolve('http://127.0.0.1:34407/v1', {
        healthyPorts: [59879],
        ss: ssRow('0.0.0.0:59879'),
      }),
    ).toBe('http://127.0.0.1:59879/v1');
  });

  it('addresses an IPv6-only listener as [::1], not 127.0.0.1', () => {
    // A server bound only to ::1 is NOT reachable at 127.0.0.1.
    expect(
      resolve('http://127.0.0.1:34407/v1', {
        healthyPorts: [59879],
        ss: ssRow('[::1]:59879'),
      }),
    ).toBe('http://[::1]:59879/v1');
  });

  it('accepts an OpenAI-compatible engine that serves NO /props', () => {
    // MEASURED 2026-08-19. The capability check required llama.cpp's /props, so
    // it was vendor-shape detection wearing a capability check's name. The engine
    // actually serving this host (ninfer-serve) has /health and /v1/models but no
    // /props, so the live server on the documented default port was REFUSED,
    // discovery yielded nothing, the dead pin stood, and every local completion
    // returned 529.
    expect(
      resolve('http://127.0.0.1:59879/v1', { openaiPorts: [8080], ss: ssRow('127.0.0.1:8080', 'ninfer-serve') })
    ).toBe('http://127.0.0.1:8080/v1');
  });

  it('finds the default port even when NO socket is attributable to this user', () => {
    // A containerised engine's socket belongs to docker-proxy, not to this user,
    // so `ss -ltnp` attributes nothing and enumeration returns empty. That alone
    // made the live server invisible. The documented default port is tried last,
    // and still has to prove itself.
    expect(resolve('http://127.0.0.1:59879/v1', { openaiPorts: [8080], ss: '' })).toBe(
      'http://127.0.0.1:8080/v1'
    );
  });

  it('still rejects a server with /v1/models but NO chat route', () => {
    // The embedding server on this host is exactly this shape, and the trust
    // model's whole point is not to send prompts to it.
    expect(resolve('http://127.0.0.1:59879/v1', { embedPorts: [8081], ss: ssRow('127.0.0.1:8081') })).toBe(
      'http://127.0.0.1:59879/v1'
    );
  });

  it('does not override a HEALTHY pin with the default port', () => {
    // An operator pin that answers is never second-guessed — including by the
    // default-port fallback this change adds.
    expect(resolve('http://10.0.0.5:8080/v1', { healthyPorts: [8080], openaiPorts: [8080] })).toBe(
      'http://10.0.0.5:8080/v1'
    );
  });

  it('honours the autodiscover hard-off switch for the default port too', () => {
    expect(
      resolve('http://127.0.0.1:59879/v1', {
        openaiPorts: [8080],
        ss: '',
        env: { UAP_LLAMA_UPSTREAM_AUTODISCOVER: 'off' },
      })
    ).toBe('http://127.0.0.1:59879/v1');
  });

  it('honours UAP_LLAMA_UPSTREAM_AUTODISCOVER=off as a hard pin', () => {
    expect(
      resolve('http://127.0.0.1:34407/v1', {
        healthyPorts: [59879],
        ss: ssRow('127.0.0.1:59879'),
        env: { UAP_LLAMA_UPSTREAM_AUTODISCOVER: 'off' },
      }),
    ).toBe('http://127.0.0.1:34407/v1');
  });
});

describe('llama_upstream_watch', () => {
  /**
   * Runs the watcher against a real short-lived target process and reports
   * whether that process was signalled. This is the only code in the change
   * that can take the proxy down, so it is exercised for real.
   */
  function watch(base: string, opts: Env & { interval?: string } = {}): boolean {
    // The watcher runs bounded in the background: on the negative paths it
    // loops forever by design, so the test stops watching after a beat.
    // Liveness is read from /proc state, not `kill -0` — a SIGTERM'd child that
    // has not been reaped is a zombie, and `kill -0` reports zombies as alive.
    const script = `
      set -uo pipefail
      . "${LIB}"
      sleep 30 &
      target=$!
      ( llama_upstream_watch "${base}" "$target" ) &
      watcher=$!
      sleep 1.5
      kill "$watcher" 2>/dev/null || true
      state="$(awk '{print $3}' /proc/$target/stat 2>/dev/null || echo gone)"
      if [ "$state" = "gone" ] || [ "$state" = "Z" ]; then echo KILLED; else echo ALIVE; fi
      kill "$target" 2>/dev/null || true
    `;
    const r = spawnSync('bash', ['-c', script], {
      encoding: 'utf-8',
      timeout: 20000,
      env: {
        ...process.env,
        PATH: `${stubDir}:${process.env.PATH ?? ''}`,
        HEALTHY_PORTS: [...(opts.healthyPorts ?? []), ...(opts.nonChatPorts ?? [])].join(' '),
        CHAT_PORTS: (opts.healthyPorts ?? []).join(' '),
        SS_FIXTURE: opts.ss ?? '',
        UAP_LLAMA_UPSTREAM_WATCH_SECS: opts.interval ?? '0.1',
        ...(opts.env ?? {}),
      },
    });
    return (r.stdout ?? '').includes('KILLED');
  }

  it('stops the proxy once the upstream has moved to a new port', () => {
    expect(
      watch('http://127.0.0.1:34407/v1', {
        healthyPorts: [59879],
        ss: ssRow('127.0.0.1:59879'),
      }),
    ).toBe(true);
  });

  it('leaves the proxy alone while the upstream is healthy', () => {
    expect(
      watch('http://127.0.0.1:8080/v1', {
        healthyPorts: [8080],
        ss: ssRow('127.0.0.1:8080'),
      }),
    ).toBe(false);
  });

  it('does not stop the proxy when the upstream is dead with no live alternative', () => {
    // Dead upstream alone is not a reason to bounce — that is a restart loop.
    expect(watch('http://127.0.0.1:34407/v1', { healthyPorts: [], ss: '' })).toBe(false);
  });

  it('does not bounce a LAN-pinned proxy for the same server on the same port', () => {
    // The pin is documented as http://192.168.1.165:8080/v1 while discovery
    // always yields 127.0.0.1 — comparing URL strings called that "moved" and
    // SIGTERM'd a healthy proxy on every blip of the pinned address.
    expect(
      watch('http://192.168.1.165:8080/v1', {
        healthyPorts: [8080],
        ss: ssRow('0.0.0.0:8080'),
      }),
    ).toBe(false);
  });

  it('refuses a non-numeric target pid', () => {
    const r = spawnSync(
      'bash',
      ['-c', `set -uo pipefail; . "${LIB}"; llama_upstream_watch "http://127.0.0.1:1/v1" "-1"; echo RETURNED`],
      { encoding: 'utf-8', timeout: 10000, env: { ...process.env, PATH: `${stubDir}:${process.env.PATH ?? ''}`, SS_FIXTURE: '', HEALTHY_PORTS: '', CHAT_PORTS: '' } },
    );
    expect((r.stdout ?? '').trim()).toBe('RETURNED');
  });
});

describe('launcher wiring (scripts/run-anthropic-proxy-continuity.sh)', () => {
  const LAUNCHER = join(__dirname, '../scripts/run-anthropic-proxy-continuity.sh');

  /** Runs the launcher with a stub python3 that prints the env it received. */
  function launch(env: Record<string, string>, opts: Env = {}): string {
    const binDir = mkdtempSync(join(tmpdir(), 'uap-launcher-'));
    writeFileSync(
      join(binDir, 'python3'),
      `#!/usr/bin/env bash\necho "STARTED base=$LLAMA_CPP_BASE"\n`,
    );
    chmodSync(join(binDir, 'python3'), 0o755);
    try {
      const r = spawnSync('bash', [LAUNCHER], {
        encoding: 'utf-8',
        timeout: 30000,
        env: {
          ...process.env,
          PATH: `${binDir}:${stubDir}:${process.env.PATH ?? ''}`,
          HEALTHY_PORTS: [...(opts.healthyPorts ?? [])].join(' '),
          CHAT_PORTS: (opts.healthyPorts ?? []).join(' '),
          SS_FIXTURE: opts.ss ?? '',
          PROXY_CONTEXT_WINDOW: '65536',
          UAP_LLAMA_UPSTREAM_WATCH: 'off',
          ...env,
        },
      });
      return `${r.stdout ?? ''}${r.stderr ?? ''}`;
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  }

  it('hands the proxy the discovered base when the pin is dead', () => {
    const out = launch(
      { LLAMA_CPP_BASE: 'http://127.0.0.1:34407/v1' },
      { healthyPorts: [59879], ss: ssRow('127.0.0.1:59879') },
    );
    expect(out).toContain('STARTED base=http://127.0.0.1:59879/v1');
  });

  it('starts with the pin untouched when the pin is alive', () => {
    const out = launch(
      { LLAMA_CPP_BASE: 'http://127.0.0.1:8080/v1' },
      { healthyPorts: [8080], ss: ssRow('127.0.0.1:8080') },
    );
    expect(out).toContain('STARTED base=http://127.0.0.1:8080/v1');
  });

  it('still starts, on the pin, when the resolver lib is missing', () => {
    // Under `set -e` an unguarded `.` would abort before exec, and
    // Restart=always would then respawn a proxy-less script every 3 seconds.
    const moved = `${LIB}.moved`;
    spawnSync('mv', [LIB, moved]);
    try {
      const out = launch(
        { LLAMA_CPP_BASE: 'http://127.0.0.1:34407/v1' },
        { healthyPorts: [59879], ss: ssRow('127.0.0.1:59879') },
      );
      expect(out).toContain('STARTED base=http://127.0.0.1:34407/v1');
      expect(out).toContain('missing; using pinned upstream');
    } finally {
      spawnSync('mv', [moved, LIB]);
    }
  });
});

describe('bash/TS parity', () => {
  it('the shell and TS discovery agree on the same ss fixture', async () => {
    const { discoverLocalLlamaBases } = await import('../src/utils/llama-discovery.js');
    const fixture = [
      ssRow('127.0.0.1:10001'),
      ssRow('0.0.0.0:8080'),
      ssRow('192.168.1.165:9999'),
      ssRow('[::1]:7000'),
      ssRow('127.0.0.1:6333', 'qdrant', 999),
    ].join('\n');

    const shell = run(['authorities'], { ss: fixture })
      .stdout.split('\n')
      .filter(Boolean)
      .map((a) => `http://${a}/v1`);

    const prevPath = process.env.PATH;
    const prevFixture = process.env.SS_FIXTURE;
    process.env.PATH = `${stubDir}:${prevPath ?? ''}`;
    process.env.SS_FIXTURE = fixture;
    try {
      expect(discoverLocalLlamaBases()).toEqual(shell);
      // and the agreed answer is the intended one
      expect(shell).toEqual([
        'http://[::1]:7000/v1',
        'http://127.0.0.1:8080/v1',
        'http://127.0.0.1:10001/v1',
      ]);
    } finally {
      process.env.PATH = prevPath;
      if (prevFixture === undefined) delete process.env.SS_FIXTURE;
      else process.env.SS_FIXTURE = prevFixture;
    }
  });
});
