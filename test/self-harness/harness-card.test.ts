import { describe, it, expect, afterEach } from 'vitest';
import { buildHarnessCard, renderHarnessCard } from '../../src/benchmarks/harness-card.js';
import { promotionGate } from '../../src/self-harness/pending.js';
import { validateMod } from '../../src/self-harness/mods.js';
import type { Mod } from '../../src/self-harness/mods.js';

afterEach(() => {
  delete process.env.UAP_EDIT_TOLERANT;
});

describe('harness disclosure card (harness plan F)', () => {
  it('discloses all seven ETCSOVG layers', () => {
    const card = buildHarnessCard({ uapVersion: '1.0.0' });
    expect(card.layers.map((l) => l.code)).toEqual(['E', 'T', 'C', 'S', 'O', 'V', 'G']);
  });

  it('reports unknown rather than inventing a plausible default', () => {
    const card = buildHarnessCard({ uapVersion: '1.0.0' });
    const tools = card.layers.find((l) => l.code === 'T')!;
    expect(tools.fields.find((f) => f.key === 'tools')!.value).toBe('unknown');
    const sched = card.layers.find((l) => l.code === 'S')!;
    expect(sched.fields.find((f) => f.key === 'max_tool_rounds')!.value).toBe('unset');
  });

  // The card must describe the RUN, not the process that renders it. Reading
  // process.env here would disclose the reporter's environment — the exact
  // miscomparison the card exists to prevent — so every varying field is
  // injected and reads 'unknown' when the caller does not supply it.
  it('takes the edit strategy from its input, never from the ambient environment', () => {
    process.env.UAP_EDIT_TOLERANT = '0';
    const injected = buildHarnessCard({ uapVersion: '1.0.0', editStrategy: 'exact, then tolerant' });
    expect(
      injected.layers.find((l) => l.code === 'T')!.fields.find((f) => f.key === 'edit_strategy')!.value,
    ).toBe('exact, then tolerant');

    const unknown = buildHarnessCard({ uapVersion: '1.0.0' });
    expect(
      unknown.layers.find((l) => l.code === 'T')!.fields.find((f) => f.key === 'edit_strategy')!.value,
    ).toBe('unknown');
  });

  it('discloses both write guards, and does not guess when unstated', () => {
    const g = buildHarnessCard({ uapVersion: '1.0.0', stubGuard: true, guttingGuard: false });
    const gov = g.layers.find((l) => l.code === 'G')!;
    expect(gov.fields.find((f) => f.key === 'stub_guard')!.value).toBe('yes');
    expect(gov.fields.find((f) => f.key === 'gutting_guard')!.value).toBe('no');
    const bare = buildHarnessCard({ uapVersion: '1.0.0' });
    expect(bare.layers.find((l) => l.code === 'G')!.fields.find((f) => f.key === 'stub_guard')!.value).toBe(
      'unknown',
    );
  });

  it('renders a markdown table carrying the comparability warning', () => {
    const md = renderHarnessCard(
      buildHarnessCard({ uapVersion: '1.2.3', model: 'qwen', tools: ['read_file', 'edit_file'] }),
    );
    expect(md).toMatch(/ETCSOVG/);
    expect(md).toMatch(/qwen/);
    expect(md).toMatch(/read_file, edit_file/);
    expect(md).toMatch(/not comparable/);
  });
});

describe('promotion tiers follow blast radius, not kind (harness plan B3)', () => {
  const cases: Array<[string, Mod, string]> = [
    ['env', { kind: 'env', key: 'LLAMA_N_PREDICT', from: '1', to: '2' }, 'auto-after-validation'],
    ['tool', { kind: 'tool', key: 'UAP_EDIT_TOLERANT', from: '1', to: '0' }, 'auto-after-validation'],
    ['middleware', { kind: 'middleware', id: 'toolcall-path-normalizer', params: {} }, 'auto-after-validation'],
    ['scaffold', { kind: 'scaffold', component: 'gates', op: 'append', text: 'x' }, 'human'],
  ];
  for (const [name, mod, gate] of cases) {
    it(`${name} -> ${gate}`, () => {
      expect(promotionGate(mod)).toBe(gate);
    });
  }
});

describe('ToolMod validation (harness plan B1)', () => {
  it('accepts an in-range tool knob', () => {
    expect(validateMod({ kind: 'tool', key: 'UAP_READ_WINDOW_BYTES', from: '8000', to: '16000' })).toEqual({
      ok: true,
    });
  });

  it('rejects an out-of-range value before it ever reaches a bench arm', () => {
    const r = validateMod({ kind: 'tool', key: 'UAP_READ_WINDOW_BYTES', from: '8000', to: '900000' });
    expect(r.ok).toBe(false);
  });

  it('rejects a value outside an enum knob', () => {
    const r = validateMod({ kind: 'tool', key: 'UAP_EDIT_TOLERANT', from: '1', to: 'maybe' });
    expect(r.ok).toBe(false);
  });

  it('rejects a knob that is not on the allow-list', () => {
    const r = validateMod({ kind: 'tool', key: 'UAP_ANYTHING' as never, from: '', to: '1' });
    expect(r.ok).toBe(false);
  });
});
