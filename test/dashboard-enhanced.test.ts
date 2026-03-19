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
import type { DashboardEvent } from '../src/dashboard/event-stream.js';
import {
  getSessionSnapshot,
  resetStats,
  agentRegister,
  agentStart,
  agentComplete,
  skillMatch,
  skillActivate,
  patternMatch,
  patternActivate,
  memoryLookup,
  policyCheck,
  deployQueue,
  deployBatch,
  deployComplete,
  costTrack,
} from '../src/telemetry/session-telemetry.js';

describe('Dashboard Event Stream', () => {
  beforeEach(() => {
    resetDashboardEventBus();
  });

  afterEach(() => {
    resetDashboardEventBus();
  });

  it('should emit and receive events through the bus', () => {
    const bus = getDashboardEventBus();
    const received: DashboardEvent[] = [];

    bus.subscribe((event) => {
      received.push(event);
    });

    bus.emit('policy', 'check', 'success', 'Policy passed', 'worktree-gate');

    expect(received).toHaveLength(1);
    expect(received[0].category).toBe('policy');
    expect(received[0].type).toBe('check');
    expect(received[0].severity).toBe('success');
    expect(received[0].title).toBe('Policy passed');
    expect(received[0].detail).toBe('worktree-gate');
    expect(received[0].id).toBe(1);
    expect(received[0].timestamp).toBeTruthy();
  });

  it('should maintain event history with max limit', () => {
    const bus = getDashboardEventBus();

    // Emit 210 events (exceeds MAX_EVENT_HISTORY of 200)
    for (let i = 0; i < 210; i++) {
      bus.emit('system', 'test', 'info', `Event ${i}`);
    }

    const history = bus.getHistory(300);
    expect(history.length).toBeLessThanOrEqual(200);
    // The oldest events should have been trimmed
    expect(history[0].title).toBe('Event 10');
    expect(history[history.length - 1].title).toBe('Event 209');
  });

  it('should support getEventsSince for incremental fetching', () => {
    const bus = getDashboardEventBus();

    bus.emit('policy', 'check', 'success', 'Event 1');
    bus.emit('memory', 'lookup', 'info', 'Event 2');
    bus.emit('deploy', 'queue', 'info', 'Event 3');

    const sinceId1 = bus.getEventsSince(1);
    expect(sinceId1).toHaveLength(2);
    expect(sinceId1[0].title).toBe('Event 2');
    expect(sinceId1[1].title).toBe('Event 3');
  });

  it('should support unsubscribe', () => {
    const bus = getDashboardEventBus();
    const received: DashboardEvent[] = [];

    const unsub = bus.subscribe((event) => {
      received.push(event);
    });

    bus.emit('system', 'test', 'info', 'Before unsub');
    unsub();
    bus.emit('system', 'test', 'info', 'After unsub');

    expect(received).toHaveLength(1);
    expect(received[0].title).toBe('Before unsub');
  });

  it('should track subscriber count', () => {
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

  it('should use convenience emitters with correct severity mapping', () => {
    const bus = getDashboardEventBus();
    const received: DashboardEvent[] = [];
    bus.subscribe((e) => received.push(e));

    emitPolicyEvent('check', 'Policy OK', true, 'passed');
    emitPolicyEvent('block', 'Policy blocked', false, 'violation');
    emitMemoryEvent('lookup', 'Memory hit', true, 'found 3 matches');
    emitMemoryEvent('lookup', 'Memory miss', false, 'no matches');
    emitDeployEvent('queue', 'Deploy queued', 'info', 'commit to main');
    emitAgentEvent('register', 'Agent started', 'info', 'droid-1');
    emitTaskEvent('complete', 'Task done', 'success', 'task-123');
    emitSystemEvent('error', 'Build failed', 'error', 'tsc error');

    expect(received).toHaveLength(8);

    // Policy: allowed=true -> success, allowed=false -> error
    expect(received[0].severity).toBe('success');
    expect(received[1].severity).toBe('error');

    // Memory: hit=true -> success, hit=false -> info
    expect(received[2].severity).toBe('success');
    expect(received[3].severity).toBe('info');

    // Categories
    expect(received[0].category).toBe('policy');
    expect(received[2].category).toBe('memory');
    expect(received[4].category).toBe('deploy');
    expect(received[5].category).toBe('agent');
    expect(received[6].category).toBe('task');
    expect(received[7].category).toBe('system');
  });

  it('should not throw when handler errors occur', () => {
    const bus = getDashboardEventBus();
    const received: DashboardEvent[] = [];

    // First handler throws
    bus.subscribe(() => {
      throw new Error('Handler error');
    });

    // Second handler should still receive
    bus.subscribe((e) => received.push(e));

    // Should not throw
    bus.emit('system', 'test', 'info', 'Test event');

    expect(received).toHaveLength(1);
  });

  it('should include metadata in events', () => {
    const bus = getDashboardEventBus();
    const received: DashboardEvent[] = [];
    bus.subscribe((e) => received.push(e));

    bus.emit('deploy', 'batch', 'info', 'Batch created', 'squashed 3 commits', {
      batchId: 'abc-123',
      actionCount: 3,
    });

    expect(received[0].metadata).toEqual({
      batchId: 'abc-123',
      actionCount: 3,
    });
  });
});

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

  it('should return session data after telemetry events are recorded', () => {
    // Trigger session initialization by recording an event
    agentRegister('agent-1', 'TestDroid', 'droid');
    agentStart('agent-1', 'Testing dashboard');

    const snapshot = getSessionSnapshot();
    expect(snapshot).not.toBeNull();
    expect(snapshot!.sessionId).toBeTruthy();
    expect(snapshot!.agents.size).toBe(1);

    const agent = snapshot!.agents.get('agent-1');
    expect(agent).toBeDefined();
    expect(agent!.name).toBe('TestDroid');
    expect(agent!.type).toBe('droid');
    expect(agent!.status).toBe('working');
  });

  it('should track memory hits and misses in snapshot', () => {
    memoryLookup('test query', 3, 'top match', 0.95);
    memoryLookup('another query', 0);
    memoryLookup('third query', 1);

    const snapshot = getSessionSnapshot();
    expect(snapshot).not.toBeNull();
    expect(snapshot!.memoryHits).toBe(4); // 3 + 1
    expect(snapshot!.memoryMisses).toBe(1);
  });

  it('should track policy checks and blocks in snapshot', () => {
    policyCheck('worktree-gate', true, 'in worktree');
    policyCheck('build-gate', true, 'build passes');
    policyCheck('test-gate', false, 'tests failing');

    const snapshot = getSessionSnapshot();
    expect(snapshot).not.toBeNull();
    expect(snapshot!.policyChecks).toBe(3);
    expect(snapshot!.policyBlocks).toBe(1);
  });

  it('should track skills and patterns in snapshot', () => {
    skillMatch('session-context', '.claude/skills/', 'task matches');
    skillActivate('session-context');
    patternMatch('P12', 'Output Existence', 0.95, 'critical');
    patternActivate('P12');

    const snapshot = getSessionSnapshot();
    expect(snapshot).not.toBeNull();
    expect(snapshot!.skills.size).toBe(1);
    expect(snapshot!.patterns.size).toBe(1);

    const skill = snapshot!.skills.get('session-context');
    expect(skill).toBeDefined();
    expect(skill!.active).toBe(true);

    const pattern = snapshot!.patterns.get('P12');
    expect(pattern).toBeDefined();
    expect(pattern!.active).toBe(true);
    expect(pattern!.weight).toBe(0.95);
  });

  it('should track deploy actions in snapshot', () => {
    deployQueue('d1', 'commit', 'main', 'fix: dashboard');
    deployQueue('d2', 'push', 'origin/main', 'push changes');
    deployBatch(['d1', 'd2'], 'batch-1');
    deployComplete('d1', true);

    const snapshot = getSessionSnapshot();
    expect(snapshot).not.toBeNull();
    expect(snapshot!.deploys.size).toBe(2);

    const d1 = snapshot!.deploys.get('d1');
    expect(d1).toBeDefined();
    expect(d1!.status).toBe('done');
    expect(d1!.batchId).toBe('batch-1');
  });

  it('should track cost data in snapshot', () => {
    costTrack('claude-sonnet-4', 5000, 1000, 'task-execution');

    const snapshot = getSessionSnapshot();
    expect(snapshot).not.toBeNull();
    expect(snapshot!.totalCostUsd).toBeGreaterThan(0);
    expect(snapshot!.estimatedCostWithoutUap).toBeGreaterThan(snapshot!.totalCostUsd);
  });

  it('should track agent lifecycle in snapshot', () => {
    agentRegister('a1', 'Explorer', 'subagent');
    agentStart('a1', 'Exploring codebase');
    agentComplete('a1', 'Found 5 files');

    const snapshot = getSessionSnapshot();
    expect(snapshot).not.toBeNull();

    const agent = snapshot!.agents.get('a1');
    expect(agent).toBeDefined();
    expect(agent!.status).toBe('done');
    expect(agent!.endTime).not.toBeNull();
  });
});
