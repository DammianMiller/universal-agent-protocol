/**
 * Session Stats - Real-time context consumption tracking.
 *
 * Records per-tool-call byte usage (raw vs compressed) so users
 * can see where their context window budget goes.
 */

export interface ToolCallRecord {
  tool: string;
  timestamp: number;
  rawBytes: number;
  contextBytes: number;
}

export interface ToolBreakdown {
  tool: string;
  calls: number;
  contextBytes: number;
  rawBytes: number;
}

export interface StatsSummary {
  uptimeMs: number;
  totalCalls: number;
  totalContextBytes: number;
  totalRawBytes: number;
  savingsRatio: number;
  savingsPercent: string;
  byTool: ToolBreakdown[];
}

export class SessionStats {
  private startTime = Date.now();
  private calls: ToolCallRecord[] = [];

  record(tool: string, rawBytes: number, contextBytes: number): void {
    this.calls.push({
      tool,
      timestamp: Date.now(),
      rawBytes,
      contextBytes,
    });
  }

  getSummary(): StatsSummary {
    const totalRawBytes = this.calls.reduce((s, c) => s + c.rawBytes, 0);
    const totalContextBytes = this.calls.reduce((s, c) => s + c.contextBytes, 0);
    const savingsRatio = totalContextBytes > 0 ? totalRawBytes / totalContextBytes : 1;
    const savingsPercent = totalRawBytes > 0
      ? `${Math.round((1 - totalContextBytes / totalRawBytes) * 100)}%`
      : '0%';

    // Aggregate by tool
    const toolMap = new Map<string, { calls: number; contextBytes: number; rawBytes: number }>();
    for (const call of this.calls) {
      const existing = toolMap.get(call.tool) || { calls: 0, contextBytes: 0, rawBytes: 0 };
      existing.calls++;
      existing.contextBytes += call.contextBytes;
      existing.rawBytes += call.rawBytes;
      toolMap.set(call.tool, existing);
    }

    const byTool = Array.from(toolMap.entries())
      .map(([tool, data]) => ({ tool, ...data }))
      .sort((a, b) => b.contextBytes - a.contextBytes);

    return {
      uptimeMs: Date.now() - this.startTime,
      totalCalls: this.calls.length,
      totalContextBytes,
      totalRawBytes,
      savingsRatio: Math.round(savingsRatio * 10) / 10,
      savingsPercent,
      byTool,
    };
  }

  reset(): void {
    this.startTime = Date.now();
    this.calls = [];
  }

  getCalls(): ReadonlyArray<ToolCallRecord> {
    return this.calls;
  }
}

export const globalSessionStats = new SessionStats();
