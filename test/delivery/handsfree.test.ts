/**
 * Hands-free persistence (Options A-D): completion ledger, model-aware
 * persistence profile, the Stop-hook decision state machine (block while
 * incomplete, never wedge), and the reactor persistence injection.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initLedger,
  loadLedger,
  markItem,
  remainingItems,
  isComplete,
  progress,
  formatRemaining,
} from '../../src/delivery/completion-ledger.js';
import {
  classifyModelFamily,
  resolvePersistenceProfile,
} from '../../src/delivery/persistence-profile.js';
import { decideStopCheck } from '../../src/cli/handsfree.js';
import { maybePersistenceInjection } from '../../src/coordination/persistence-inject.js';

const items = [
  { id: 'e1', title: 'Design' },
  { id: 'e2', title: 'Build' },
  { id: 'e3', title: 'Ship' },
];

describe('completion ledger (B)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-ledger-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('init creates all items pending; isComplete only when every item done', () => {
    initLedger(dir, 'mission', items);
    const l = loadLedger(dir)!;
    expect(l.items).toHaveLength(3);
    expect(isComplete(l)).toBe(false);
    expect(remainingItems(l)).toHaveLength(3);
    markItem(dir, 'e1', 'done');
    markItem(dir, 'e2', 'done');
    expect(isComplete(loadLedger(dir)!)).toBe(false);
    markItem(dir, 'e3', 'done');
    expect(isComplete(loadLedger(dir)!)).toBe(true);
  });

  it('progress + formatRemaining reflect state', () => {
    initLedger(dir, 'mission', items);
    markItem(dir, 'e1', 'done');
    const p = progress(loadLedger(dir)!);
    expect(p).toMatchObject({ total: 3, done: 1, pct: 33 });
    expect(formatRemaining(loadLedger(dir)!)).toContain('e2');
  });

  it('re-init preserves prior item status (non-destructive re-plan)', () => {
    initLedger(dir, 'mission', items);
    markItem(dir, 'e1', 'done');
    initLedger(dir, 'mission', [...items, { id: 'e4', title: 'Extra' }]);
    const l = loadLedger(dir)!;
    expect(l.items.find((i) => i.id === 'e1')!.status).toBe('done');
    expect(l.items).toHaveLength(4);
  });
});

describe('persistence profile (C)', () => {
  it('classifies model families by name', () => {
    expect(classifyModelFamily('claude-fable-5')).toBe('fable');
    expect(classifyModelFamily('qwen35-a3b')).toBe('local');
    expect(classifyModelFamily('opus-4.8')).toBe('frontier');
  });

  it('scales forcing intensity inversely with intrinsic persistence', () => {
    expect(resolvePersistenceProfile('claude-fable-5').intensity).toBe('light');
    expect(resolvePersistenceProfile('opus-4.8').intensity).toBe('moderate');
    const local = resolvePersistenceProfile('qwen35-a3b');
    expect(local.intensity).toBe('aggressive');
    expect(local.maxBlocks).toBeGreaterThan(resolvePersistenceProfile('opus-4.8').maxBlocks);
  });

  it('disabled config yields an off profile that never blocks', () => {
    const p = resolvePersistenceProfile('opus-4.8', { enabled: false });
    expect(p.intensity).toBe('off');
    expect(p.stopHookBlocks).toBe(false);
  });
});

describe('stop-check decision (A + anti-spin)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-stopcheck-'));
    writeFileSync(join(dir, '.uap.json'), JSON.stringify({ multiModel: { roles: { executor: 'qwen35-a3b' } } }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('blocks while incomplete, allows on stop_hook_active, allows when complete', () => {
    initLedger(dir, 'mission', items);
    expect(decideStopCheck(dir, false).block).toBe(true);
    expect(decideStopCheck(dir, true).block).toBe(false); // stop_hook_active
    markItem(dir, 'e1', 'done');
    markItem(dir, 'e2', 'done');
    markItem(dir, 'e3', 'done');
    expect(decideStopCheck(dir, false).block).toBe(false); // complete
  });

  it('no ledger => never blocks (casual sessions unaffected)', () => {
    expect(decideStopCheck(dir, false).block).toBe(false);
  });

  it('gives up (allows stop) after stagnation with no progress — never wedges', () => {
    initLedger(dir, 'mission', [{ id: 'e1', title: 'A' }]);
    const outcomes: boolean[] = [];
    for (let i = 0; i < 5; i++) outcomes.push(decideStopCheck(dir, false).block);
    // aggressive profile: stagnationLimit 3 -> blocks a few times, then a give-up (false)
    expect(outcomes.slice(0, 3).every((b) => b)).toBe(true);
    expect(outcomes).toContain(false);
  });
});

describe('reactor persistence injection (D)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-inject-'));
    writeFileSync(join(dir, '.uap.json'), JSON.stringify({ multiModel: { roles: { executor: 'qwen35-a3b' } } }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('injects keep-going directive when a build is in progress', () => {
    initLedger(dir, 'mission', items);
    const out = maybePersistenceInjection(dir);
    expect(out).toBeTruthy();
    expect(out!).toMatch(/NOT complete|hands-free|REMAINING/i);
  });

  it('injects nothing when there is no ledger or the build is complete', () => {
    expect(maybePersistenceInjection(dir)).toBeNull();
    initLedger(dir, 'mission', [{ id: 'e1', title: 'A' }]);
    markItem(dir, 'e1', 'done');
    expect(maybePersistenceInjection(dir)).toBeNull();
  });
});
