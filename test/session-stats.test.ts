import { describe, it, expect, beforeEach } from 'vitest';
import { SessionStats } from '../src/mcp-router/session-stats.js';

describe('SessionStats', () => {
  let stats: SessionStats;

  beforeEach(() => {
    stats = new SessionStats();
  });

  it('should start with empty summary', () => {
    const summary = stats.getSummary();
    expect(summary.totalCalls).toBe(0);
    expect(summary.totalContextBytes).toBe(0);
    expect(summary.totalRawBytes).toBe(0);
    expect(summary.byTool).toHaveLength(0);
    expect(summary.uptimeMs).toBeGreaterThanOrEqual(0);
  });

  it('should record tool calls', () => {
    stats.record('github.list_issues', 50000, 5000);
    stats.record('filesystem.read_file', 2000, 2000);

    const summary = stats.getSummary();
    expect(summary.totalCalls).toBe(2);
    expect(summary.totalRawBytes).toBe(52000);
    expect(summary.totalContextBytes).toBe(7000);
  });

  it('should calculate savings ratio', () => {
    stats.record('tool_a', 10000, 1000);

    const summary = stats.getSummary();
    expect(summary.savingsRatio).toBe(10);
    expect(summary.savingsPercent).toBe('90%');
  });

  it('should aggregate by tool', () => {
    stats.record('github.list_issues', 10000, 1000);
    stats.record('github.list_issues', 8000, 800);
    stats.record('filesystem.read_file', 2000, 2000);

    const summary = stats.getSummary();
    expect(summary.byTool).toHaveLength(2);

    const github = summary.byTool.find(t => t.tool === 'github.list_issues');
    expect(github).toBeDefined();
    expect(github!.calls).toBe(2);
    expect(github!.contextBytes).toBe(1800);
    expect(github!.rawBytes).toBe(18000);
  });

  it('should sort by context bytes descending', () => {
    stats.record('small_tool', 100, 100);
    stats.record('big_tool', 50000, 5000);

    const summary = stats.getSummary();
    expect(summary.byTool[0].tool).toBe('big_tool');
  });

  it('should reset all state', () => {
    stats.record('tool_a', 10000, 1000);
    stats.record('tool_b', 5000, 500);
    stats.reset();

    const summary = stats.getSummary();
    expect(summary.totalCalls).toBe(0);
    expect(summary.totalContextBytes).toBe(0);
    expect(summary.byTool).toHaveLength(0);
  });

  it('should handle 1:1 ratio (no compression)', () => {
    stats.record('passthrough', 500, 500);
    const summary = stats.getSummary();
    expect(summary.savingsRatio).toBe(1);
    expect(summary.savingsPercent).toBe('0%');
  });

  it('should expose raw calls', () => {
    stats.record('tool_a', 1000, 100);
    const calls = stats.getCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].tool).toBe('tool_a');
    expect(calls[0].timestamp).toBeGreaterThan(0);
  });
});
