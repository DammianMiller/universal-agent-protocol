import { describe, it, expect } from 'vitest';
import { RoutingPresets, ModelPresets } from '../../src/models/types';

describe('RoutingPresets — named multi-model routing options', () => {
  it('defines option 1 (fable-local-opus) with the requested roles', () => {
    const p = RoutingPresets['fable-local-opus'];
    expect(p).toBeDefined();
    expect(p.roles).toEqual({
      planner: 'fable-5',
      executor: 'qwen36-a3b',
      reviewer: 'opus-4.8',
      fallback: 'qwen36-a3b',
    });
  });

  it('defines option 2 (fable-haiku-opus) with the requested roles', () => {
    const p = RoutingPresets['fable-haiku-opus'];
    expect(p).toBeDefined();
    expect(p.roles).toEqual({
      planner: 'fable-5',
      executor: 'haiku-4.5',
      reviewer: 'opus-4.8',
      fallback: 'qwen36-a3b',
    });
  });

  it('every role + listed model references a real ModelPresets entry', () => {
    for (const preset of Object.values(RoutingPresets)) {
      for (const role of ['planner', 'executor', 'reviewer', 'fallback'] as const) {
        const id = preset.roles[role];
        expect(ModelPresets[id], `${preset.id}.${role} -> ${id}`).toBeDefined();
      }
      for (const m of preset.models) {
        expect(ModelPresets[m], `${preset.id} models -> ${m}`).toBeDefined();
      }
    }
  });

  it('exposes the new model presets with correct Anthropic apiModel ids', () => {
    expect(ModelPresets['fable-5'].apiModel).toBe('claude-fable-5');
    expect(ModelPresets['fable-5'].provider).toBe('anthropic');
    expect(ModelPresets['haiku-4.5'].apiModel).toBe('claude-haiku-4-5-20251001');
    expect(ModelPresets['opus-4.8'].apiModel).toBe('claude-opus-4-8');
    // local executor/fallback is a free custom (llama.cpp) model
    expect(ModelPresets['qwen36-a3b'].provider).toBe('custom');
    expect(ModelPresets['qwen36-a3b'].costPer1MOutput).toBe(0);
  });
});
