/**
 * POST /api/placement/admit — the HTTP wire between the proxy and the
 * placement controller. The proxy walks the request body for non-text
 * media blocks and posts carries_image: true; the controller must READ
 * that field off the wire and park image traffic against a text-only
 * resident. A dropped or mis-parsed field silently re-opens the exact
 * degradation this gate exists to prevent: the squid5090 arm answers a
 * confident hallucination over HTTP 200 with the image dropped on the
 * floor. These tests boot the REAL server and POST the REAL route —
 * unit-level getPlacementAdmit tests cannot catch a wire-shape seam.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { startDashboardServer } from '../../src/dashboard/server.js';
import { resetColdProbeForTests } from '../../src/dashboard/placement-routes.js';
import { resetAutoSchedulerForTests } from '../../src/placement/auto.js';
import { withLedger } from '../../src/placement/ledger.js';

// The 035 fixture shape: the inkling2 family with a text-only squid arm
// (config vision "none") and a measured image-capable basalt arm.
const REGISTRY = {
  version: 1,
  devices: {
    gpu0: { kind: 'gpu', total_mib: 32607, reserved_mib: 512 },
    cpu0: { kind: 'cpu', total_mib: 182000, reserved_mib: 8192 },
  },
  models: {
    inkling2: {
      display: 'Inkling 2 Mini',
      engine: 'basalt',
      unit: 'uap-basalt-inkling2-server',
      endpoint: 'http://127.0.0.1:8080',
      advertises: ['Inkling 2 Mini'],
      affinity: { device: ['gpu0'] },
      vision: 'dynamic',
      configs: {
        'nvfp4-mx8': {
          engine: 'basalt',
          unit: 'uap-basalt-inkling2-server',
          resident_gpu_mib: 28212,
          host_rss_mib: 17480,
          context_pool_cells: 1048576,
          kv_resident_cells: 1048576,
          kv_kind: 'fp8',
          measured_at: '2026-11-25T14:05:00Z',
          measured_on: 'gpu0',
        },
        'squid-fp8': {
          engine: 'squid5090',
          unit: 'uap-squid-inkling2-server',
          vision: 'none',
          resident_gpu_mib: 24200,
          host_rss_mib: 554,
          context_pool_cells: 524288,
          kv_resident_cells: 524288,
          kv_kind: 'q4',
          measured_at: '2026-11-25T18:05:00Z',
          measured_on: 'gpu0',
        },
      },
    },
  },
};

let dir: string;
let server: { close: () => void } | undefined;
const prevEnv: Record<string, string | undefined> = {};

function saveEnv(key: string, value: string): void {
  prevEnv[key] = process.env[key];
  process.env[key] = value;
}

function boot(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('dashboard server never listened')), 5000);
    server = startDashboardServer({
      port: 0,
      host: '127.0.0.1',
      projectDir: dir,
      updateIntervalMs: 3_600_000, // no state-refresh churn inside the test
      onListening: ({ port }) => {
        clearTimeout(timer);
        resolve(port);
      },
    });
  });
}

async function postAdmit(port: number, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/placement/admit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/placement/admit — the carries_image wire seam', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-dash-admit-wire-'));
    // The server takes the project dir as an option (no chdir — vitest
    // workers forbid it) and resolves the registry from
    // <projectDir>/config/model-registry.json. Hermeticity: the ledger and
    // the local-registry overlay both read env paths, and the auto policy
    // points at a temp file (disabled by default).
    mkdirSync(join(dir, 'config'));
    writeFileSync(join(dir, 'config', 'model-registry.json'), JSON.stringify(REGISTRY));
    saveEnv('UAP_PLACEMENT_LEDGER', join(dir, 'placement.json'));
    saveEnv('UAP_MODEL_REGISTRY_LOCAL', join(dir, 'no-local-overlay.json'));
    saveEnv('UAP_PLACEMENT_AUTO', join(dir, 'no-auto-policy.json'));
    saveEnv('UAP_ATTENTION_OFF', '1');
    resetAutoSchedulerForTests();
    resetColdProbeForTests();
    withLedger(join(dir, 'placement.json'), (l) => {
      l.devices = {
        gpu0: { kind: 'gpu', total_mib: 32607, free_mib: 400, reserved_mib: 512, source: 'nvidia-smi' },
        cpu0: { kind: 'cpu', total_mib: 182000, free_mib: 76000, reserved_mib: 8192, source: 'MemAvailable' },
      };
      l.residents.push({
        model: 'inkling2', config: 'squid-fp8', device: 'gpu0',
        unit: 'uap-squid-inkling2-server', state: 'hot',
        gpu_mib: 24200, host_rss_mib: 554, holders: [], since: '2026-11-25T18:14:02Z',
      });
    });
  });

  afterEach(() => {
    server?.close();
    server = undefined;
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
      delete prevEnv[k];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('parks an image-bearing request against the text-only resident — carries_image crossed the wire', async () => {
    const port = await boot();
    const r = await postAdmit(port, {
      model_id: 'Inkling 2 Mini',
      client: 'claude-code',
      session: 's1',
      cells: 4096,
      carries_image: true,
    });
    expect(r.status).toBe(200);
    const answer = (await r.json()) as { decision: string; reason?: string };
    // The controller SAW the image flag: park, never a forward into the
    // silent drop.
    expect(answer.decision).toBe('park');
    expect(answer.reason).toBe('vision_text_only_arm');
  }, 20000);

  it('treats a non-boolean carries_image as false — the trust boundary is strict', async () => {
    const port = await boot();
    const r = await postAdmit(port, {
      model_id: 'Inkling 2 Mini',
      client: 'claude-code',
      session: 's1',
      cells: 4096,
      carries_image: 'yes', // a string must not trip the image class
    });
    expect(r.status).toBe(200);
    const answer = (await r.json()) as { decision: string; target_id?: string };
    // Text-shaped traffic forwards to the same resident (its target id
    // names the resident's device:endpoint — 'default' when the resident
    // carries no endpoint of its own).
    expect(answer.decision).toBe('forward');
    expect(answer.target_id).toBe('gpu0:default');
  }, 20000);

  it('a text request with no carries_image field forwards to the resident', async () => {
    const port = await boot();
    const r = await postAdmit(port, {
      model_id: 'Inkling 2 Mini',
      client: 'claude-code',
      cells: 4096,
    });
    expect(r.status).toBe(200);
    const answer = (await r.json()) as { decision: string };
    expect(answer.decision).toBe('forward');
  }, 20000);
});
