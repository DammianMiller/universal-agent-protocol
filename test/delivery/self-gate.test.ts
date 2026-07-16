import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync } from 'fs';
import {
  extractScript,
  authorAcceptanceGate,
  deliverableLayout,
  detectMisTargetedGate,
  detectWeakWebProxy,
} from '../../src/delivery/self-gate.js';

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

  it('re-authors a MIS-TARGETED gate (root-anchored while the app is in a subdir)', async () => {
    // The deliverable lives in a subdirectory (the space-shooter failure mode).
    mkdirSync(join(dir, 'space-shooter'), { recursive: true });
    writeFileSync(join(dir, 'space-shooter', 'index.html'), '<html></html>');
    let call = 0;
    const executor = async () => {
      call += 1;
      // 1st: checks a ROOT index.html that does not exist (fails on unsolved, but
      // mis-targeted — the real entry is space-shooter/index.html).
      // 2nd: a correctly anchored, non-html check that fails for a real reason.
      return call === 1
        ? '```bash\ntest -f index.html\n```'
        : '```bash\ntest -f space-shooter/js/game.js\n```';
    };
    const res = await authorAcceptanceGate({ instruction: 'build space shooter', projectRoot: dir, executor });
    expect(call).toBe(2);
    expect(res.attempts).toBe(2);
    expect(res.vacuous).toBe(false);
    expect(res.notes.some((n) => /structural/i.test(n))).toBe(true);
  });
});

describe('self-gate: subdir-aware helpers', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'selfgate-h-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('deliverableLayout flags a subdirectory entry point', () => {
    mkdirSync(join(dir, 'space-shooter'), { recursive: true });
    writeFileSync(join(dir, 'space-shooter', 'index.html'), '<html></html>');
    const { entries, hint } = deliverableLayout(dir);
    expect(entries).toContain('space-shooter/index.html');
    expect(hint).toMatch(/SUBDIRECTORY/);
  });

  it('detectMisTargetedGate fires when a real entry exists elsewhere', () => {
    mkdirSync(join(dir, 'space-shooter'), { recursive: true });
    writeFileSync(join(dir, 'space-shooter', 'index.html'), '<html></html>');
    const fb = detectMisTargetedGate('grep -q x index.html', dir, ['space-shooter/index.html']);
    expect(fb).toMatch(/does not exist/);
    expect(fb).toMatch(/space-shooter\/index\.html/);
  });

  it('detectMisTargetedGate stays silent when the referenced entry exists', () => {
    mkdirSync(join(dir, 'space-shooter'), { recursive: true });
    writeFileSync(join(dir, 'space-shooter', 'index.html'), '<html></html>');
    expect(
      detectMisTargetedGate('test -f space-shooter/index.html', dir, ['space-shooter/index.html'])
    ).toBeNull();
  });

  it('detectMisTargetedGate stays silent when nothing is built yet (no real entry)', () => {
    // A gate that references a not-yet-created file must NOT be flagged.
    expect(detectMisTargetedGate('test -f index.html', dir, [])).toBeNull();
  });

  it('detectWeakWebProxy flags a text-only grep with no asset existence check', () => {
    expect(detectWeakWebProxy('grep -q "<script" index.html')).toMatch(/actually exist/);
  });

  it('detectWeakWebProxy is silent when existence is checked', () => {
    expect(detectWeakWebProxy('grep -q x index.html && test -f js/game.js')).toBeNull();
  });
});

describe('self-gate: bash -n syntax validation (P1 follow-up)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'selfgate-syn-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('rejects a syntactically-broken script instead of accepting its failure as discriminating', async () => {
    // Attempt 1: unbalanced backtick — bash -n fails (observed live
    // 2026-07-13: the loop converged against this unsatisfiable gate).
    // Attempt 2: valid script that fails on the unsolved repo.
    let call = 0;
    const executor = async () => {
      call++;
      return call === 1
        ? '```bash\necho `oops\n```'
        : '```bash\ntest -f solution.txt\n```';
    };
    const res = await authorAcceptanceGate({ instruction: 'make solution.txt', projectRoot: dir, executor });
    expect(res.vacuous).toBe(false);
    expect(res.attempts).toBe(2);
    // Upstream phrasing: the parse check reports 'gate script does not parse'.
    expect(res.notes.join(' ')).toMatch(/does not parse|bash -n/);
  });
});
