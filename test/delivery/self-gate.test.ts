import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { extractScript, authorAcceptanceGate } from '../../src/delivery/self-gate.js';

describe('self-gate: extractScript', () => {
  it('pulls the script from a fenced ```bash block and guarantees a shebang', () => {
    const out = extractScript('blah\n```bash\necho hi\n```\ntrailing');
    expect(out.startsWith('#!')).toBe(true);
    expect(out).toContain('echo hi');
    expect(out).not.toContain('trailing');
  });

  it('keeps an existing shebang and falls back to raw content when unfenced', () => {
    expect(extractScript('#!/bin/sh\necho ok')).toBe('#!/bin/sh\necho ok');
    const raw = extractScript('echo no-fence');
    expect(raw).toBe('#!/usr/bin/env bash\necho no-fence');
  });
});

describe('self-gate: authorAcceptanceGate', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'selfgate-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('accepts a gate that FAILS on the unsolved repo (the non-vacuity floor)', async () => {
    // Executor returns a gate that fails unless solution.txt exists (it does not yet).
    const executor = async () =>
      '```bash\ntest -f solution.txt\n```';
    const res = await authorAcceptanceGate({ instruction: 'make solution.txt', projectRoot: dir, executor });
    expect(res.rung).not.toBeNull();
    expect(res.vacuous).toBe(false);
    expect(res.attempts).toBe(1);
    expect(existsSync(join(dir, '.uap-deliver', 'verify.sh'))).toBe(true);
    expect(res.rung?.required).toBe(true);
    expect(res.rung?.command).toBe('bash');
  });

  it('rejects and regenerates a vacuous gate that passes on the unsolved repo', async () => {
    let call = 0;
    const executor = async () => {
      call += 1;
      // First a trivially-passing gate (exit 0), then a discriminating one.
      return call === 1 ? '```bash\nexit 0\n```' : '```bash\ntest -f done.txt\n```';
    };
    const res = await authorAcceptanceGate({ instruction: 'x', projectRoot: dir, executor });
    expect(call).toBe(2);
    expect(res.attempts).toBe(2);
    expect(res.vacuous).toBe(false);
    expect(res.notes.some((n) => /too weak|regenerat/i.test(n))).toBe(true);
  });

  it('flags vacuous=true when every attempt yields a trivially-passing gate', async () => {
    const executor = async () => '```bash\nexit 0\n```';
    const res = await authorAcceptanceGate({
      instruction: 'x',
      projectRoot: dir,
      executor,
      maxAuthorAttempts: 2,
    });
    expect(res.vacuous).toBe(true);
    expect(res.attempts).toBe(2);
    // A script was still produced, so a (weak) rung is returned rather than null.
    expect(res.rung).not.toBeNull();
  });
});
