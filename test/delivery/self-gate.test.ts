import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { extractScript, authorAcceptanceGate, findMisanchoredPaths, listRepoFiles, usesScriptDirAnchor } from '../../src/delivery/self-gate.js';

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

describe('self-gate: path anchoring (wrong-path probes make gates unwinnable)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'selfgate-anchor-'));
    mkdirSync(join(dir, 'space-shooter', 'js'), { recursive: true });
    writeFileSync(join(dir, 'space-shooter', 'js', 'audio.js'), 'window.Audio2 = {};');
    writeFileSync(join(dir, 'space-shooter', 'index.html'), '<canvas id="game"></canvas>');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('findMisanchoredPaths flags bare-filename probes when the file lives elsewhere, leaves future files alone', () => {
    const script = '#!/usr/bin/env bash\ntest -f audio.js || exit 1\ntest -f space-shooter/js/audio.js || exit 1\ntest -f README.md || exit 1\n';
    const hits = findMisanchoredPaths(script, dir);
    expect(hits.map((h) => h.token)).toContain('audio.js');
    expect(hits.find((h) => h.token === 'audio.js')!.actual).toContain('space-shooter/js/audio.js');
    expect(hits.map((h) => h.token)).not.toContain('space-shooter/js/audio.js');
    expect(hits.map((h) => h.token)).not.toContain('README.md');
    expect(listRepoFiles(dir)).toContain('space-shooter/js/audio.js');
  });

  it('never flags skip-dir artifact probes or decimals; degrades (installs flagged) when every attempt stays mis-anchored', async () => {
    const script = '#!/usr/bin/env bash\nsleep 1.5s\ntest -f dist/audio.js || exit 1\n';
    // dist/ is a build-artifact dir the tree never contains — probing it is a
    // legitimate future-artifact check, not a mis-anchor.
    expect(findMisanchoredPaths(script, dir).length).toBe(0);

    // Persistently mis-anchored gate: after the last attempt it must INSTALL
    // (degraded, with a note), not hard-fail the run with a rung-less result.
    const executor = async () => '```bash\ntest -f audio.js || { echo missing >&2; exit 1; }\n```';
    const res = await authorAcceptanceGate({ instruction: 'game in space-shooter/', projectRoot: dir, executor, maxAuthorAttempts: 2 });
    expect(res.rung).not.toBeNull();
    expect(res.scriptPath).not.toBeNull();
    expect(res.notes.some((n) => n.includes('installing anyway'))).toBe(true);
  });

  it('authorAcceptanceGate rejects a mis-anchored gate with corrective feedback and accepts the re-anchored one', async () => {
    const prompts: string[] = [];
    const executor = async (prompt: string) => {
      prompts.push(prompt);
      if (prompts.length === 1) {
        return '```bash\ntest -f audio.js || { echo missing >&2; exit 1; }\n```';
      }
      return '```bash\nnode -e "process.exit(1)" || { echo unsolved >&2; exit 1; }\ngrep -q NEVER_THERE space-shooter/js/audio.js || { echo unsolved >&2; exit 1; }\n```';
    };
    const res = await authorAcceptanceGate({ instruction: 'finish the game in space-shooter/', projectRoot: dir, executor });
    expect(res.vacuous).toBe(false);
    expect(res.attempts).toBe(2);
    expect(res.notes.some((n) => n.includes('wrong paths'))).toBe(true);
    expect(prompts[1]).toContain('space-shooter/js/audio.js');
    expect(prompts[0]).toContain('REPOSITORY FILES');
  });
});

describe('self-gate: script-dir anchor rejection (octopus variant run, 2026-07-18)', () => {
  it('detects dirname-$0 and BASH_SOURCE anchors; plain relative scripts pass', () => {
    expect(usesScriptDirAnchor('ROOT="$(cd "$(dirname "$0")" && pwd)"\ntest -f "$ROOT/a.js"')).toBe(true);
    expect(usesScriptDirAnchor('HERE="${BASH_SOURCE[0]%/*}"')).toBe(true);
    expect(usesScriptDirAnchor('test -f space-shooter/index.html || exit 1')).toBe(false);
  });

  it('authoring rejects an anchored gate with corrective feedback, then accepts the relative rewrite', async () => {
    const { mkdtempSync: mkd, writeFileSync: wf, rmSync: rmr } = await import('node:fs');
    const { tmpdir: tmp } = await import('node:os');
    const { join: j } = await import('node:path');
    const dir = mkd(j(tmp(), 'selfgate-anchor2-'));
    try {
      wf(j(dir, 'thing.js'), 'export const t = 1;');
      const prompts: string[] = [];
      const executor = async (prompt: string) => {
        prompts.push(prompt);
        if (prompts.length === 1) {
          return '```bash\nROOT="$(cd "$(dirname "$0")" && pwd)"\ntest -f "$ROOT/thing.js" || { echo miss >&2; exit 1; }\n```';
        }
        return '```bash\nnode -e "process.exit(1)" || { echo unsolved >&2; exit 1; }\ngrep -q NEVER_HERE thing.js || { echo unsolved >&2; exit 1; }\n```';
      };
      const res = await authorAcceptanceGate({ instruction: 'finish thing.js', projectRoot: dir, executor });
      expect(res.vacuous).toBe(false);
      expect(res.attempts).toBe(2);
      expect(res.notes.some((n) => n.includes('anchors paths to its own directory'))).toBe(true);
      expect(prompts[1]).toContain('CWD = project root');
      // the prompt itself now carries the rule up front
      expect(prompts[0]).toContain('NEVER anchor to the script location');
    } finally {
      rmr(dir, { recursive: true, force: true });
    }
  });
});
