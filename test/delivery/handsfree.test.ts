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
  syncLedgerFromTodos,
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

  it('no ledger + nudge disabled => never blocks (casual sessions unaffected)', () => {
    const prev = process.env.UAP_HANDSFREE_PRELEDGER;
    process.env.UAP_HANDSFREE_PRELEDGER = '0';
    try {
      expect(decideStopCheck(dir, false).block).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.UAP_HANDSFREE_PRELEDGER;
      else process.env.UAP_HANDSFREE_PRELEDGER = prev;
    }
  });

  it('Fix C: no ledger + driven model => nudges once, then gives up (never wedges)', () => {
    // executor is qwen35-a3b (aggressive/injectAutonomy) per beforeEach.
    const first = decideStopCheck(dir, false);
    expect(first.block).toBe(true);
    expect(first.message).toMatch(/no build plan exists yet|TodoWrite/);
    const second = decideStopCheck(dir, false);
    expect(second.block).toBe(false); // bounded by PRE_LEDGER_MAX (default 1)
    expect(second.giveUp).toBe(true);
  });

  it('Fix C: pre-ledger nudge honors stop_hook_active (never re-blocks)', () => {
    expect(decideStopCheck(dir, true).block).toBe(false);
  });

  it('Fix C: Fable (trusted intrinsic persistence) is never pre-ledger blocked', () => {
    const prev = process.env.UAP_ACTIVE_MODEL;
    process.env.UAP_ACTIVE_MODEL = 'claude-fable-5';
    try {
      // Fable is light/injectAutonomy=false -> no planning nudge.
      expect(decideStopCheck(dir, false).block).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.UAP_ACTIVE_MODEL;
      else process.env.UAP_ACTIVE_MODEL = prev;
    }
  });

  it('Fix C: casual frontier session is NOT pre-ledger blocked (local-only scope)', () => {
    const prev = process.env.UAP_ACTIVE_MODEL;
    process.env.UAP_ACTIVE_MODEL = 'opus-4.8'; // frontier -> post-ledger blocker only
    try {
      expect(decideStopCheck(dir, false).block).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.UAP_ACTIVE_MODEL;
      else process.env.UAP_ACTIVE_MODEL = prev;
    }
  });

  it('Fix C: a ledger appearing after a pre-ledger nudge does not corrupt the main counters', () => {
    // executor qwen35-a3b (local) per beforeEach -> first no-ledger call nudges.
    const first = decideStopCheck(dir, false);
    expect(first.block).toBe(true);
    expect(first.message).toMatch(/no build plan exists yet|TodoWrite/);
    // The model then lays out the plan -> ledger exists. The main path must block
    // on the real remaining items (not carry the pre-ledger block count).
    initLedger(dir, 'mission', items);
    const afterLedger = decideStopCheck(dir, false);
    expect(afterLedger.block).toBe(true);
    expect(afterLedger.message).toMatch(/multi-epic build is incomplete/);
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


describe('auto-seed from todos (full automation)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-todos-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('mirrors a TodoWrite plan into the ledger with mapped statuses', () => {
    const l = syncLedgerFromTodos(dir, [
      { content: 'Design schema', status: 'completed' },
      { content: 'Build API', status: 'in_progress' },
      { content: 'Write tests', status: 'pending' },
    ])!;
    expect(l.items).toHaveLength(3);
    expect(l.items[0].status).toBe('done');
    expect(l.items[1].status).toBe('in_progress');
    expect(l.items[2].status).toBe('pending');
    expect(progress(l).pct).toBe(33);
  });

  it('preserves mission + createdAt across re-syncs and follows todo status', () => {
    const first = syncLedgerFromTodos(dir, [{ content: 'A', status: 'pending' }, { content: 'B', status: 'pending' }])!;
    const created = first.createdAt;
    const second = syncLedgerFromTodos(dir, [{ content: 'A', status: 'completed' }, { content: 'B', status: 'completed' }])!;
    expect(second.createdAt).toBe(created);
    expect(second.items.every((i) => i.status === 'done')).toBe(true);
  });

  it('de-collides duplicate slugs and ignores empty content', () => {
    const l = syncLedgerFromTodos(dir, [
      { content: 'Same task', status: 'pending' },
      { content: 'Same task', status: 'pending' },
      { content: '   ', status: 'pending' },
    ])!;
    expect(l.items).toHaveLength(2);
    expect(new Set(l.items.map((i) => i.id)).size).toBe(2);
  });

  it('returns null for an empty todo list', () => {
    expect(syncLedgerFromTodos(dir, [])).toBeNull();
  });
});
