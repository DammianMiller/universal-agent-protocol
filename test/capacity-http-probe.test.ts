import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  computeHealth,
  parsePolicy,
  PolicyError,
  type ServicePolicy,
} from '../src/capacity/policy.js';
import {
  probeHttpService,
  runDoctor,
  worstHealth,
  type DoctorDeps,
} from '../src/capacity/probe.js';

/**
 * The HTTP probe source for the capacity doctor (added 2026-10-04): the
 * local Qwen3.8 backend is the strata serve layer, which has NO systemd unit
 * (launched by a plain script, reparented to systemd --user), so the doctor
 * had no way to see it at all. This suite pins the new policy shape, the
 * health matrix for http-probed services, and the curl-based probe.
 *
 * All pinned to the real /metrics document shape observed on this box.
 */

const policyWith = (...services: object[]) =>
  JSON.stringify({ version: 1, services });

const STRATA_DOC = JSON.stringify({
  engine: {
    model: 'qwen3.8-flash-next-iq3_xxs',
    kv: 'int8',
    max_context: 131072,
    vram_free_mib: 954,
  },
});

const HTTP_SVC: ServicePolicy = {
  name: 'strata-server',
  http: {
    url: 'http://127.0.0.1:8080',
    kind: 'strata',
    metricsMustMatch: { kv: 'int8', max_context: 131072 },
  },
  headroom: {
    gpuMinFreeMiB: 600,
  },
};

describe('parsePolicy — the http probe source', () => {
  it('accepts an http service with valid metricsMustMatch', () => {
    const p = parsePolicy(policyWith(HTTP_SVC));
    expect(p.services[0].http?.metricsMustMatch).toEqual({ kv: 'int8', max_context: 131072 });
  });

  it('rejects a service with neither systemd nor http', () => {
    expect(() => parsePolicy(policyWith({ name: 'x' }))).toThrow(/exactly one of "systemd" or "http"/);
  });

  it('rejects a service with both probe sources — which one is the truth?', () => {
    expect(() =>
      parsePolicy(
        policyWith({
          name: 'x',
          systemd: { unit: 'a.service', scope: 'user' },
          http: { url: 'http://127.0.0.1:8080', kind: 'strata' },
        }),
      ),
    ).toThrow(/exactly one of "systemd" or "http"/);
  });

  it('rejects an unknown parser kind', () => {
    expect(() =>
      parsePolicy(policyWith({ name: 'x', http: { url: 'http://127.0.0.1:8080', kind: 'vllm' } })),
    ).toThrow(/http\.kind/);
  });

  for (const bad of [
    'not a url',
    'ftp://127.0.0.1:8080',
    'http://user:pass@127.0.0.1:8080',
    'http://127.0.0.1:8080?x=1',
    'http://127.0.0.1:8080#frag',
    'http://127.0.0.1:8080/v1',
    // Canonicalization (2026-10-04 review): each of these PARSES clean and
    // passes every field check above, yet curl would fetch something other
    // than the validated shape — the WHATWG parser normalizes the raw form
    // away. Only a raw==canonical check catches them.
    'http://127.0.0.1:8080/%2e%2e', // %-encoded dot-segment
    'http://127.0.0.1:8080/a/..', // literal dot-segment
    'http://127.0.0.1:8080?', // empty query: parses to no-search, fetches with ?
    ' http://127.0.0.1:8080', // leading whitespace: href silently strips it
  ]) {
    it(`rejects a bad url: ${JSON.stringify(bad)}`, () => {
      expect(() =>
        parsePolicy(policyWith({ name: 'x', http: { url: bad, kind: 'strata' } })),
      ).toThrow(PolicyError);
    });
  }

  it('accepts the two canonical spellings (with and without trailing slash)', () => {
    for (const url of ['http://127.0.0.1:8080', 'http://127.0.0.1:8080/']) {
      const p = parsePolicy(policyWith({ name: 'x', http: { url, kind: 'strata' } }));
      expect(p.services[0].http?.url).toBe(url);
    }
  });

  it('rejects unit-only budgets on an http service — unverifiable is undeclarable', () => {
    // rssMiB reads MemoryCurrent and restartBudget reads NRestarts; neither
    // exists for an http-probed service, so computeHealth would silently
    // ignore them. A declared budget that cannot be checked is the exact
    // anti-pattern this policy exists to prevent.
    expect(() =>
      parsePolicy(
        policyWith({
          name: 'x',
          http: { url: 'http://127.0.0.1:8080', kind: 'strata' },
          budget: { rssMiB: 4096 },
        }),
      ),
    ).toThrow(/require a systemd unit/);
    expect(() =>
      parsePolicy(
        policyWith({
          name: 'x',
          http: { url: 'http://127.0.0.1:8080', kind: 'strata' },
          restartBudget: 3,
        }),
      ),
    ).toThrow(/require a systemd unit/);
  });

  it('rejects a metricsMustMatch value that is neither string nor number', () => {
    expect(() =>
      parsePolicy(
        policyWith({ name: 'x', http: { url: 'http://127.0.0.1:8080', kind: 'strata', metricsMustMatch: { kv: null } } }),
      ),
    ).toThrow(/metricsMustMatch/);
  });
});

describe('computeHealth — http services', () => {
  const okProbes = { systemd: false, gpu: true, http: true };
  const serving = {
    activeState: 'active',
    subState: 'serving',
    detail: 'qwen3.8-flash-next-iq3_xxs',
    metrics: { kv: 'int8', max_context: 131072 },
    gpuFreeMiB: 843,
  };

  it('GREEN when serving with matching configuration', () => {
    const h = computeHealth(HTTP_SVC, serving, okProbes);
    expect(h.health).toBe('GREEN');
    expect(h.reasons.join(' ')).toContain('qwen3.8-flash-next-iq3_xxs');
  });

  it('DARK when the probe cannot reach the service — absent, not degraded', () => {
    const h = computeHealth(HTTP_SVC, { activeState: 'unreachable' }, okProbes);
    expect(h.health).toBe('DARK');
    expect(h.reasons.join(' ')).toContain('not answering /metrics');
  });

  it('UNKNOWN when the probe tool itself failed (curl missing / timed out)', () => {
    const h = computeHealth(HTTP_SVC, {}, { systemd: false, gpu: true, http: false });
    expect(h.health).toBe('UNKNOWN');
    expect(h.reasons.join(' ')).toContain('probe unavailable');
  });

  it('RED when the live configuration drifted from metricsMustMatch', () => {
    // The relaunch with a different pool size or kv kind: the exact drift
    // execStartMustContain catches for unit services.
    const h = computeHealth(
      HTTP_SVC,
      { ...serving, metrics: { kv: 'int4', max_context: 131072 } },
      okProbes,
    );
    expect(h.health).toBe('RED');
    expect(h.reasons.join(' ')).toContain('engine.kv is "int4"');
  });

  it('RED when a declared metric is missing from the document — unverified, not compliant', () => {
    const h = computeHealth(
      HTTP_SVC,
      { ...serving, metrics: { kv: 'int8' } },
      okProbes,
    );
    expect(h.health).toBe('RED');
    expect(h.reasons.join(' ')).toMatch(/unverified/);
  });

  it('RED when GPU headroom is violated', () => {
    const h = computeHealth(HTTP_SVC, { ...serving, gpuFreeMiB: 400 }, okProbes);
    expect(h.health).toBe('RED');
    expect(h.reasons.join(' ')).toContain('headroom');
  });
});

describe('probeHttpService', () => {
  it('parses a live strata /metrics into liveness + engine facts', () => {
    const probe = probeHttpService('http://127.0.0.1:8080', 'strata', {
      exec: (_cmd, args) => {
        expect(args.at(-1)).toBe('http://127.0.0.1:8080/metrics');
        return STRATA_DOC;
      },
    });
    expect(probe?.activeState).toBe('active');
    expect(probe?.detail).toBe('qwen3.8-flash-next-iq3_xxs');
    expect(probe?.metrics?.kv).toBe('int8');
  });

  it('invokes curl WITHOUT -f — an HTTP error body must classify as DARK, not UNKNOWN', () => {
    // With -f, curl exits 22 on any 4xx/5xx and the probe read "tool
    // failed" (UNKNOWN). Without it, the error body reaches the parser and
    // an answering-but-wrong server reads DARK — the two situations the
    // health matrix exists to distinguish.
    const seenArgs: string[][] = [];
    probeHttpService('http://127.0.0.1:8080', 'strata', {
      exec: (_cmd, args) => {
        seenArgs.push(args);
        return '404 page not found';
      },
    });
    expect(seenArgs[0]).not.toContain('-f');
  });

  it('sanitizes the server-provided model string (CWE-117)', () => {
    const hostile = JSON.stringify({
      engine: { model: 'evil\x1b[31m-model', kv: 'int8', max_context: 131072 },
    });
    const probe = probeHttpService('http://127.0.0.1:8080', 'strata', {
      exec: () => hostile,
    });
    expect(probe?.detail).toBe('evil-model');
  });

  it('reports an ANSWERING-but-wrong server as unrecognized (DARK), not probe failure', () => {
    const probe = probeHttpService('http://127.0.0.1:8080', 'strata', {
      exec: () => '<html>wrong engine</html>',
    });
    expect(probe?.activeState).toBe('unrecognized');
  });

  it('returns null when curl cannot run — UNKNOWN, never a guess', () => {
    const probe = probeHttpService('http://127.0.0.1:8080', 'strata', {
      exec: () => {
        throw new Error('curl: (7) connection refused');
      },
    });
    expect(probe).toBeNull();
  });
});

describe('runDoctor — http services in the matrix', () => {
  const deps = (state: 'up' | 'down' | 'unrecognized'): DoctorDeps => ({
    probeSystemd: () => null,
    probeGpuFreeMiB: () => 843,
    probeHttp:
      state === 'up'
        ? () => ({ activeState: 'active', subState: 'serving', detail: 'm', metrics: { kv: 'int8', max_context: 131072 } })
        : state === 'unrecognized'
          ? () => ({ activeState: 'unrecognized' })
          : () => null,
  });
  const policy = parsePolicy(policyWith(HTTP_SVC));

  it('is GREEN when the strata layer is serving with the declared shape', () => {
    const reports = runDoctor(policy, deps('up'));
    expect(reports.map((r) => r.health)).toEqual(['GREEN']);
    expect(worstHealth(reports)).toBe('GREEN');
  });

  it('is DARK when the service is not answering as strata', () => {
    const reports = runDoctor(policy, deps('unrecognized'));
    expect(worstHealth(reports)).toBe('DARK');
  });

  it('is UNKNOWN when the probe tool fails — every service is unknown, not DARK', () => {
    const reports = runDoctor(policy, deps('down'));
    expect(reports.map((r) => r.health)).toEqual(['UNKNOWN']);
  });
});

describe('the shipped policy declares the strata backend', () => {
  const policy = parsePolicy(
    readFileSync(resolve(__dirname, '..', 'config', 'capacity-policy.json'), 'utf8'),
    'capacity-policy.json',
  );

  it('has the strata-server entry with the load-bearing numbers pinned', () => {
    const strata = policy.services.find((s) => s.name === 'strata-server');
    expect(strata?.http).toBeDefined();
    expect(strata?.http?.metricsMustMatch).toEqual({ kv: 'int8', max_context: 131072 });
    // 200, not 600: strata fills the card by design (steady state ~245 MiB
    // free measured 2026-10-04) and carries its own --vram-reserve-mib 1200.
    // A 600 floor would be permanently RED and get ignored.
    expect(strata?.headroom?.gpuMinFreeMiB).toBe(200);
  });
});
