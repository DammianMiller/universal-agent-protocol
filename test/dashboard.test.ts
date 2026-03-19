import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getDashboardEventBus,
  resetDashboardEventBus,
  emitPolicyEvent,
  emitMemoryEvent,
  emitDeployEvent,
  emitAgentEvent,
  emitTaskEvent,
  emitSystemEvent,
} from '../src/dashboard/event-stream.js';
import { getTimeSeriesHistory } from '../src/dashboard/data-service.js';
import {
  getSessionSnapshot,
  resetStats,
  memoryLookup,
  policyCheck,
  agentRegister,
  agentStart,
  agentComplete,
  skillMatch,
  skillActivate,
  patternMatch,
  patternActivate,
  deployQueue,
  deployBatch,
  deployComplete,
  costTrack,
  sessionStart,
} from '../src/telemetry/session-telemetry.js';

// ── Event Stream Tests ──

describe('DashboardEventBus', () => {
  beforeEach(() => {
    resetDashboardEventBus();
  });

  afterEach(() => {
    resetDashboardEventBus();
  });

  it('should emit and receive events via subscribe', () => {
    const bus = getDashboardEventBus();
    const received: unknown[] = [];
    bus.subscribe((event) => received.push(event));

    bus.emit('policy', 'check', 'success', 'Policy passed', 'test detail');

    expect(received).toHaveLength(1);
    const event = received[0] as Record<string, unknown>;
    expect(event.category).toBe('policy');
    expect(event.type).toBe('check');
    expect(event.severity).toBe('success');
    expect(event.title).toBe('Policy passed');
    expect(event.detail).toBe('test detail');
    expect(event.id).toBe(1);
    expect(event.timestamp).toBeDefined();
  });

  it('should maintain event history with getHistory', () => {
    const bus = getDashboardEventBus();

    bus.emit('task', 'create', 'info', 'Task 1');
    bus.emit('task', 'start', 'info', 'Task 2');
    bus.emit('task', 'complete', 'success', 'Task 3');

    const history = bus.getHistory(10);
    expect(history).toHaveLength(3);
    expect(history[0].title).toBe('Task 1');
    expect(history[2].title).toBe('Task 3');
  });

  it('should return events since a specific ID', () => {
    const bus = getDashboardEventBus();

    bus.emit('agent', 'register', 'info', 'Agent A');
    bus.emit('agent', 'start', 'info', 'Agent B');
    bus.emit('agent', 'complete', 'success', 'Agent C');

    const since = bus.getEventsSince(1);
    expect(since).toHaveLength(2);
    expect(since[0].title).toBe('Agent B');
    expect(since[1].title).toBe('Agent C');
  });

  it('should unsubscribe correctly', () => {
    const bus = getDashboardEventBus();
    const received: unknown[] = [];
    const unsub = bus.subscribe((event) => received.push(event));

    bus.emit('system', 'info', 'info', 'Before unsub');
    unsub();
    bus.emit('system', 'info', 'info', 'After unsub');

    expect(received).toHaveLength(1);
  });

  it('should cap history at MAX_EVENT_HISTORY', () => {
    const bus = getDashboardEventBus();

    for (let i = 0; i < 250; i++) {
      bus.emit('system', 'test', 'info', `Event ${i}`);
    }

    const history = bus.getHistory(300);
    expect(history.length).toBeLessThanOrEqual(200);
  });

  it('should report subscriber count', () => {
    const bus = getDashboardEventBus();
    expect(bus.subscriberCount()).toBe(0);

    const unsub1 = bus.subscribe(() => {});
    expect(bus.subscriberCount()).toBe(1);

    const unsub2 = bus.subscribe(() => {});
    expect(bus.subscriberCount()).toBe(2);

    unsub1();
    expect(bus.subscriberCount()).toBe(1);

    unsub2();
    expect(bus.subscriberCount()).toBe(0);
  });
});

describe('Convenience event emitters', () => {
  beforeEach(() => {
    resetDashboardEventBus();
  });

  afterEach(() => {
    resetDashboardEventBus();
  });

  it('emitPolicyEvent should emit policy category with correct severity', () => {
    const bus = getDashboardEventBus();
    const received: unknown[] = [];
    bus.subscribe((event) => received.push(event));

    emitPolicyEvent('check', 'Build gate passed', true);
    emitPolicyEvent('block', 'Worktree gate failed', false, 'Not in worktree');

    expect(received).toHaveLength(2);
    const pass = received[0] as Record<string, unknown>;
    const block = received[1] as Record<string, unknown>;
    expect(pass.category).toBe('policy');
    expect(pass.severity).toBe('success');
    expect(block.severity).toBe('error');
    expect(block.detail).toBe('Not in worktree');
  });

  it('emitMemoryEvent should emit memory category', () => {
    const bus = getDashboardEventBus();
    const received: unknown[] = [];
    bus.subscribe((event) => received.push(event));

    emitMemoryEvent('lookup', 'Memory hit', true);
    emitMemoryEvent('lookup', 'Memory miss', false);

    expect(received).toHaveLength(2);
    const hit = received[0] as Record<string, unknown>;
    const miss = received[1] as Record<string, unknown>;
    expect(hit.category).toBe('memory');
    expect(hit.severity).toBe('success');
    expect(miss.severity).toBe('info');
  });

  it('emitDeployEvent should emit deploy category', () => {
    const bus = getDashboardEventBus();
    const received: unknown[] = [];
    bus.subscribe((event) => received.push(event));

    emitDeployEvent('queue', 'Deploy queued', 'info');
    emitDeployEvent('complete', 'Deploy done', 'success');

    expect(received).toHaveLength(2);
    expect((received[0] as Record<string, unknown>).category).toBe('deploy');
    expect((received[1] as Record<string, unknown>).severity).toBe('success');
  });

  it('emitAgentEvent should emit agent category', () => {
    const bus = getDashboardEventBus();
    const received: unknown[] = [];
    bus.subscribe((event) => received.push(event));

    emitAgentEvent('register', 'Agent registered', 'info');
    expect(received).toHaveLength(1);
    expect((received[0] as Record<string, unknown>).category).toBe('agent');
  });

  it('emitTaskEvent should emit task category', () => {
    const bus = getDashboardEventBus();
    const received: unknown[] = [];
    bus.subscribe((event) => received.push(event));

    emitTaskEvent('create', 'Task created', 'info');
    expect(received).toHaveLength(1);
    expect((received[0] as Record<string, unknown>).category).toBe('task');
  });

  it('emitSystemEvent should emit system category', () => {
    const bus = getDashboardEventBus();
    const received: unknown[] = [];
    bus.subscribe((event) => received.push(event));

    emitSystemEvent('error', 'System error', 'error', 'Something broke');
    expect(received).toHaveLength(1);
    expect((received[0] as Record<string, unknown>).category).toBe('system');
    expect((received[0] as Record<string, unknown>).severity).toBe('error');
  });
});

// ── Session Telemetry Snapshot Tests ──

describe('Session Telemetry Snapshot', () => {
  beforeEach(() => {
    resetStats();
  });

  afterEach(() => {
    resetStats();
  });

  it('should return null when no session is initialized', () => {
    const snapshot = getSessionSnapshot();
    expect(snapshot).toBeNull();
  });

  it('should return session data after sessionStart', () => {
    sessionStart(5);
    const snapshot = getSessionSnapshot();
    expect(snapshot).not.toBeNull();
    expect(snapshot!.sessionId).toBeDefined();
    expect(snapshot!.stepsTotal).toBe(5);
    expect(snapshot!.tokensUsed).toBe(0);
    expect(snapshot!.memoryHits).toBe(0);
    expect(snapshot!.memoryMisses).toBe(0);
  });

  it('should track memory hits and misses', () => {
    sessionStart();
    memoryLookup('test query', 3, 'top match', 0.95);
    memoryLookup('another query', 0);

    const snapshot = getSessionSnapshot();
    expect(snapshot!.memoryHits).toBe(3);
    expect(snapshot!.memoryMisses).toBe(1);
  });

  it('should track policy checks and blocks', () => {
    sessionStart();
    policyCheck('build-gate', true, 'Build passed');
    policyCheck('worktree-gate', false, 'Not in worktree');
    policyCheck('test-gate', true, 'Tests passed');

    const snapshot = getSessionSnapshot();
    expect(snapshot!.policyChecks).toBe(3);
    expect(snapshot!.policyBlocks).toBe(1);
  });

  it('should track agents lifecycle', () => {
    sessionStart();
    agentRegister('a1', 'TestDroid', 'droid');
    agentStart('a1', 'Fix bug #42');
    agentComplete('a1', 'Fixed');

    const snapshot = getSessionSnapshot();
    expect(snapshot!.agents.size).toBe(1);
    const agent = snapshot!.agents.get('a1');
    expect(agent).toBeDefined();
    expect(agent!.name).toBe('TestDroid');
    expect(agent!.type).toBe('droid');
    expect(agent!.status).toBe('done');
  });

  it('should track skills and patterns', () => {
    sessionStart();
    skillMatch('hooks-session-start', '.claude/skills/', 'Session init');
    skillActivate('hooks-session-start');
    patternMatch('P12', 'Output Existence', 0.95, 'verification');
    patternActivate('P12');

    const snapshot = getSessionSnapshot();
    expect(snapshot!.skills.size).toBe(1);
    expect(snapshot!.skills.get('hooks-session-start')!.active).toBe(true);
    expect(snapshot!.patterns.size).toBe(1);
    expect(snapshot!.patterns.get('P12')!.active).toBe(true);
  });

  it('should track deploy actions and batching', () => {
    sessionStart();
    deployQueue('d1', 'commit', 'main', 'fix: dashboard');
    deployQueue('d2', 'commit', 'main', 'fix: tests');
    deployBatch(['d1', 'd2'], 'batch-1');
    deployComplete('d1', true);
    deployComplete('d2', true);

    const snapshot = getSessionSnapshot();
    expect(snapshot!.deploys.size).toBe(2);
    const d1 = snapshot!.deploys.get('d1');
    expect(d1!.status).toBe('done');
    expect(d1!.batchId).toBe('batch-1');
  });

  it('should track cost entries', () => {
    sessionStart();
    costTrack('claude-sonnet-4', 1000, 500, 'code review');

    const snapshot = getSessionSnapshot();
    expect(snapshot!.costs.length).toBe(1);
    expect(snapshot!.totalCostUsd).toBeGreaterThan(0);
    expect(snapshot!.estimatedCostWithoutUap).toBeGreaterThan(snapshot!.totalCostUsd);
  });
});

// ── Time Series History Tests ──

describe('Time Series History', () => {
  it('should be an array', () => {
    const history = getTimeSeriesHistory();
    expect(Array.isArray(history)).toBe(true);
  });
});
