/**
 * Adapter resolution for `uap tune` — mirrors the paired-bench adapter picker so
 * the tuning loop drives the same agents (mock/opencode/claude/mini/raw/deliver)
 * over the same real-gate suite it validates against.
 */

import {
  claudeAdapter,
  DeliverCliAdapter,
  miniSweAdapter,
  MockAdapter,
  opencodeAdapter,
  RawCompletionAdapter,
  type AgentAdapter,
} from '../benchmarks/paired/index.js';

export function pickTuningAdapter(name: string, model: string): AgentAdapter {
  switch (name) {
    case 'mock':
      return new MockAdapter();
    case 'opencode':
      return opencodeAdapter(model);
    case 'claude':
      return claudeAdapter(model);
    case 'mini':
    case 'mini-swe-agent':
      return miniSweAdapter(model);
    case 'raw':
      return new RawCompletionAdapter();
    case 'deliver':
      return new DeliverCliAdapter();
    default:
      throw new Error(`Unknown adapter '${name}' (expected: mock | opencode | claude | mini | raw | deliver)`);
  }
}
