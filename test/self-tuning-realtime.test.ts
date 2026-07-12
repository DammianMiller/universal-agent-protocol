import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  computeAdaptation,
  emitAdaptation,
  realtimeAdaptEnabled,
  fetchSessionContext,
  type SessionSignals,
} from '../src/self-tuning/realtime-adaptor.js';
import { defaultFlagConfig } from '../src/self-tuning/flags.js';
import { adaptationSignalDir, writeAdaptationSignal } from '../src/coordination/adaptation-signal.js';
import { recordTurnQuality, recentTurnSignals } from '../src/telemetry/session-telemetry.js';

const cfg = () => defaultFlagConfig();

describe('computeAdaptation — signal → adjustment mapping', () => {
  it('returns null when everything is nominal', () => {
    const s: SessionSignals = { toolFailureRate: 0.05, contextUtilization: 0.4, reconStreak: 3, turnQuality: 80 };
    expect(computeAdaptation('sess', s, cfg(), 100)).toBeNull();
  });

  it('escalates to fusion on high tool-failure rate', () => {
    const sig = computeAdaptation('sess', { toolFailureRate: 0.6 }, cfg(), 100);
    expect(sig).not.toBeNull();
    expect(sig!.escalate).toBe(true);
    expect(sig!.recipe).toBe('fusion');
    expect(sig!.reason).toMatch(/tool-failure/);
  });

  it('escalates on low turn quality', () => {
    const sig = computeAdaptation('sess', { turnQuality: 30 }, cfg(), 100);
    expect(sig!.escalate).toBe(true);
  });

  it('lowers the recon threshold under context pressure', () => {
    const sig = computeAdaptation('sess', { contextUtilization: 0.95 }, cfg(), 100);
    expect(sig!.reconThreshold).toBeDefined();
    const cur = Number(cfg()['PROXY_RECON_CONVERGENCE_THRESHOLD']);
    expect(sig!.reconThreshold!).toBeLessThan(cur);
    expect(sig!.reconThreshold!).toBeGreaterThanOrEqual(20);
  });

  it('forces synthesis on a long RECON streak', () => {
    const sig = computeAdaptation('sess', { reconStreak: 40 }, cfg(), 100);
    expect(sig!.forceSynthesis).toBe(true);
  });

  it('combines multiple breaches into one signal', () => {
    const sig = computeAdaptation('sess', { toolFailureRate: 0.6, reconStreak: 40 }, cfg(), 100);
    expect(sig!.escalate).toBe(true);
    expect(sig!.forceSynthesis).toBe(true);
    expect(sig!.reason.split(';').length).toBeGreaterThanOrEqual(2);
  });
});

describe('emitAdaptation — gating + persistence', () => {
  it('is a no-op when disabled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uap-adapt-off-'));
    try {
      const sig = emitAdaptation('sess', { reconStreak: 40 }, cfg(), { enabled: false, dir });
      expect(sig).toBeNull();
      expect(existsSync(join(dir, 'latest.json'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes a session + latest signal file when enabled and breached', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uap-adapt-on-'));
    try {
      const sig = emitAdaptation('my-sess', { reconStreak: 40 }, cfg(), { enabled: true, dir, now: 123 });
      expect(sig).not.toBeNull();
      expect(existsSync(join(dir, 'latest.json'))).toBe(true);
      expect(existsSync(join(dir, 'my-sess.json'))).toBe(true);
      const persisted = JSON.parse(readFileSync(join(dir, 'my-sess.json'), 'utf-8'));
      expect(persisted.forceSynthesis).toBe(true);
      expect(persisted.ts).toBe(123);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not write when enabled but nominal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uap-adapt-nom-'));
    try {
      const sig = emitAdaptation('sess', { reconStreak: 1 }, cfg(), { enabled: true, dir });
      expect(sig).toBeNull();
      expect(existsSync(join(dir, 'latest.json'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('realtimeAdaptEnabled — auto-on with opt-out', () => {
  it('honors the explicit override and env', () => {
    expect(realtimeAdaptEnabled(true)).toBe(true);
    expect(realtimeAdaptEnabled(false)).toBe(false);
    const prev = process.env.UAP_REALTIME_ADAPT;
    process.env.UAP_REALTIME_ADAPT = '1';
    expect(realtimeAdaptEnabled()).toBe(true);
    process.env.UAP_REALTIME_ADAPT = '0';
    expect(realtimeAdaptEnabled()).toBe(false);
    if (prev === undefined) delete process.env.UAP_REALTIME_ADAPT;
    else process.env.UAP_REALTIME_ADAPT = prev;
  });

  it('defaults ON when env unset and no config opt-out', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uap-adapt-default-'));
    const prev = process.env.UAP_REALTIME_ADAPT;
    delete process.env.UAP_REALTIME_ADAPT;
    try {
      expect(realtimeAdaptEnabled(undefined, dir)).toBe(true); // no .uap.json → default on
    } finally {
      if (prev !== undefined) process.env.UAP_REALTIME_ADAPT = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('opts out via .uap.json realtimeAdapt.enabled:false', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uap-adapt-cfgoff-'));
    const prev = process.env.UAP_REALTIME_ADAPT;
    delete process.env.UAP_REALTIME_ADAPT;
    try {
      writeFileSync(join(dir, '.uap.json'), JSON.stringify({ realtimeAdapt: { enabled: false } }));
      expect(realtimeAdaptEnabled(undefined, dir)).toBe(false);
      // env override still wins over config
      process.env.UAP_REALTIME_ADAPT = '1';
      expect(realtimeAdaptEnabled(undefined, dir)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.UAP_REALTIME_ADAPT;
      else process.env.UAP_REALTIME_ADAPT = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('fetchSessionContext', () => {
  it('derives utilization from used/window via an injected fetch', async () => {
    const fakeFetch = (async () => ({
      ok: true,
      json: async () => ({ used: 90, window: 100 }),
    })) as unknown as typeof fetch;
    const s = await fetchSessionContext('http://x/v1', fakeFetch);
    expect(s.contextUtilization).toBeCloseTo(0.9);
  });

  it('returns {} on a failed fetch', async () => {
    const failing = (async () => { throw new Error('down'); }) as unknown as typeof fetch;
    expect(await fetchSessionContext('http://x/v1', failing)).toEqual({});
  });
});

describe('adaptation-signal channel', () => {
  it('resolves the signal dir from the env override', () => {
    const prev = process.env.UAP_ADAPTATION_SIGNAL_DIR;
    process.env.UAP_ADAPTATION_SIGNAL_DIR = '/tmp/xyz-adapt';
    expect(adaptationSignalDir()).toBe('/tmp/xyz-adapt');
    if (prev === undefined) delete process.env.UAP_ADAPTATION_SIGNAL_DIR;
    else process.env.UAP_ADAPTATION_SIGNAL_DIR = prev;
  });

  it('sanitizes the session id in the filename', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uap-adapt-fn-'));
    try {
      writeAdaptationSignal({ ts: 1, sessionId: 'a/b c*d', reason: 'x' }, dir);
      expect(existsSync(join(dir, 'a_b_c_d.json'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('session-telemetry — per-turn quality', () => {
  it('records turns and aggregates recent signals', () => {
    recordTurnQuality({ quality: 80, toolFailures: 0, toolCalls: 4 });
    recordTurnQuality({ quality: 40, toolFailures: 2, toolCalls: 4 });
    const sig = recentTurnSignals(2);
    expect(sig.turnQuality).toBeCloseTo(60);
    expect(sig.toolFailureRate).toBeCloseTo(2 / 8);
  });
});
