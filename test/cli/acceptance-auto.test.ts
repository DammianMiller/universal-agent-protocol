/**
 * --acceptance-auto spec discovery (resolveAcceptanceSpecAuto).
 *
 * The DONE-gates (opencode completion gate, Stop hook) have no explicit
 * --acceptance file, so requirements-completeness was never judged outside a
 * deliver run. This resolves a spec automatically — explicit criteria files
 * first, then the completion ledger / TodoWrite plan (the agent's own plan of
 * record) — so a DONE claim can be judged against what the agent set out to do.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveAcceptanceSpecAuto } from '../../src/cli/verify.js';

function tmpProject(): string {
  const p = mkdtempSync(join(tmpdir(), 'uap-accauto-'));
  mkdirSync(join(p, '.uap'), { recursive: true });
  return p;
}

describe('resolveAcceptanceSpecAuto', () => {
  let p: string;
  afterEach(() => p && rmSync(p, { recursive: true, force: true }));

  it('returns null when there is no spec source', () => {
    p = tmpProject();
    expect(resolveAcceptanceSpecAuto(p)).toBeNull();
  });

  it('prefers an explicit .uap/acceptance.md', () => {
    p = tmpProject();
    writeFileSync(join(p, '.uap', 'acceptance.md'), '# Acceptance\n- Login must work\n');
    writeFileSync(join(p, 'REQUIREMENTS.md'), 'other');
    const spec = resolveAcceptanceSpecAuto(p);
    expect(spec).toContain('Login must work');
  });

  it('falls back to REQUIREMENTS.md / SPEC.md', () => {
    p = tmpProject();
    writeFileSync(join(p, 'REQUIREMENTS.md'), 'The app must scramble the cube.');
    expect(resolveAcceptanceSpecAuto(p)).toContain('scramble the cube');
  });

  it('derives a spec from the completion ledger (the agents plan of record)', () => {
    p = tmpProject();
    writeFileSync(
      join(p, '.uap', 'completion-ledger.json'),
      JSON.stringify({ items: [
        { text: 'Render the cube' },
        { content: 'Scramble updates move count' },
        { title: 'Reset restores solved state' },
      ] })
    );
    const spec = resolveAcceptanceSpecAuto(p)!;
    expect(spec).toContain('Render the cube');
    expect(spec).toContain('Scramble updates move count');
    expect(spec).toContain('Reset restores solved state');
    expect(spec).toContain('EVERY requirement'); // framed as required criteria
  });

  it('handles a bare-array ledger and string items', () => {
    p = tmpProject();
    writeFileSync(join(p, '.uap', 'completion-ledger.json'), JSON.stringify(['Do A', 'Do B']));
    const spec = resolveAcceptanceSpecAuto(p)!;
    expect(spec).toContain('- Do A');
    expect(spec).toContain('- Do B');
  });

  it('returns null on an unparseable / empty ledger', () => {
    p = tmpProject();
    writeFileSync(join(p, '.uap', 'completion-ledger.json'), '{ not json');
    expect(resolveAcceptanceSpecAuto(p)).toBeNull();
  });

  it('excludes items the ledger marks done — only REMAINING work is judged', () => {
    p = tmpProject();
    writeFileSync(
      join(p, '.uap', 'completion-ledger.json'),
      JSON.stringify({ items: [
        { text: 'Shipped on a worktree branch', status: 'done' },
        { text: 'Close the follow-up', status: 'pending' },
        { text: 'Retry the failed step', status: 'failed' },
      ] })
    );
    const spec = resolveAcceptanceSpecAuto(p)!;
    expect(spec).toContain('Close the follow-up');
    expect(spec).toContain('Retry the failed step');
    expect(spec).not.toContain('Shipped on a worktree branch');
  });

  it('a fully-done ledger yields NO spec (fail-open — stop-check already allows the stop)', () => {
    p = tmpProject();
    writeFileSync(
      join(p, '.uap', 'completion-ledger.json'),
      JSON.stringify({ items: [
        { title: 'A', status: 'done' },
        { title: 'B', status: 'done' },
      ] })
    );
    expect(resolveAcceptanceSpecAuto(p)).toBeNull();
  });

  it('ledger items with no status field stay judged (TodoWrite mirrors, bare arrays)', () => {
    p = tmpProject();
    writeFileSync(
      join(p, '.uap', 'completion-ledger.json'),
      JSON.stringify({ items: [{ text: 'No status field' }] })
    );
    expect(resolveAcceptanceSpecAuto(p)).toContain('No status field');
  });
});
