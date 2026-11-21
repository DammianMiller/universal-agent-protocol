import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildBlueprintPrompt,
  formatBlueprintContract,
  generateOutcomeBlueprint,
  maybeBlueprintInjection,
  parseOutcomeBlueprint,
  renderBlueprintMarkdown,
} from '../../src/delivery/outcome-blueprint.js';

const fullPayload = {
  summary: 'A flagship island diorama.',
  subsystems: [{ name: 'Water network', purpose: 'Springs, streams, and falls', keyArtifacts: ['water.ts'] }],
  fidelityTargets: ['Every named feature populates at runtime'],
  runtimeInvariants: [{ subsystem: 'render', invariant: 'No blank canvas', howToVerify: 'screenshot' }],
  impliedRequirements: [
    { term: 'flowing', requirement: 'Water must travel from a source to a sink', howRealized: 'stream network' },
    { term: 'rich', requirement: 'Layered detail, not bare placeholders', howRealized: 'per-element variation' },
  ],
  continuityFlows: [
    {
      element: 'the stream',
      source: 'a summit spring',
      path: 'a carved channel across the island',
      sink: 'the waterfall basin',
      howObservable: 'animated water visible along the whole channel',
    },
  ],
  verificationPerspectives: ['aerial view'],
  antiPatterns: ['stubbed arrays'],
};

describe('blueprint prompt ambition layer (U-A/U-D)', () => {
  it('instructs implied-requirement derivation and no-orphan-flows continuity', () => {
    const prompt = buildBlueprintPrompt('Build a scene with flowing waterfalls.');
    expect(prompt).toContain('impliedRequirements');
    expect(prompt).toContain('QUALITATIVE or INTENSIVE terms');
    expect(prompt).toContain('binding');
    expect(prompt).toContain('continuityFlows');
    expect(prompt).toContain('NO ORPHAN FLOWS');
    expect(prompt).toContain('"element","source","path","sink","howObservable"');
  });

  it('parses implied requirements and continuity flows', () => {
    const bp = parseOutcomeBlueprint(JSON.stringify(fullPayload));
    expect(bp).not.toBeNull();
    expect(bp!.impliedRequirements).toHaveLength(2);
    expect(bp!.impliedRequirements![0].term).toBe('flowing');
    expect(bp!.continuityFlows).toHaveLength(1);
    expect(bp!.continuityFlows![0].source).toBe('a summit spring');
  });

  it('derives a binding runtime invariant from every continuity flow', () => {
    const bp = parseOutcomeBlueprint(JSON.stringify(fullPayload))!;
    const derived = bp.runtimeInvariants.find((i) => i.subsystem === 'the stream');
    expect(derived).toBeDefined();
    expect(derived!.invariant).toContain('a summit spring');
    expect(derived!.invariant).toContain('the waterfall basin');
    expect(derived!.invariant).toContain('no orphan flow');
    expect(derived!.howToVerify).toContain('animated water');
  });

  it('stays backwards compatible with blueprints that predate the fields', () => {
    const legacy = JSON.parse(JSON.stringify(fullPayload)) as Record<string, unknown>;
    delete legacy.impliedRequirements;
    delete legacy.continuityFlows;
    const bp = parseOutcomeBlueprint(JSON.stringify(legacy));
    expect(bp).not.toBeNull();
    expect(bp!.impliedRequirements).toEqual([]);
    expect(bp!.continuityFlows).toEqual([]);
    expect(bp!.runtimeInvariants).toHaveLength(1);
  });

  it('renders the new sections into markdown and the build contract', () => {
    const bp = parseOutcomeBlueprint(JSON.stringify(fullPayload))!;
    const md = renderBlueprintMarkdown(bp);
    expect(md).toContain('## Implied Requirements (binding)');
    expect(md).toContain('**flowing**');
    expect(md).toContain('## Continuity Flows (no orphan flows)');
    expect(md).toContain('a summit spring');
    const contract = formatBlueprintContract(bp);
    expect(contract).toContain('Implied requirements');
    expect(contract).toContain('realized by stream network');
    expect(contract).toContain('Continuity');
    expect(contract).toContain('the stream: a summit spring → the stream → the waterfall basin');
  });

  it('round-trips the new fields through save/load', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'uap-bp-'));
    const bp = parseOutcomeBlueprint(JSON.stringify(fullPayload))!;
    const saved = await generateOutcomeBlueprint({
      instruction: 'irrelevant — executor returns the fixture',
      projectRoot: dir,
      // The executor stands in for the model: return the payload verbatim so
      // save/parse/persist are exercised end to end.
      executor: async () => JSON.stringify(fullPayload),
      persist: true,
    });
    expect(saved).not.toBeNull();
    const onDisk = JSON.parse(readFileSync(join(dir, '.uap', 'blueprint.json'), 'utf8'));
    expect(onDisk.impliedRequirements).toHaveLength(2);
    expect(onDisk.continuityFlows).toHaveLength(1);
    expect(readFileSync(join(dir, '.uap', 'blueprint.md'), 'utf8')).toContain('Implied Requirements');
    rmSync(dir, { recursive: true, force: true });
  });

  it('direct-session injection demands implied requirements and continuity', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uap-bp-inj-'));
    const injection = maybeBlueprintInjection(
      dir,
      'Build a floating island voxel diorama with a pagoda, cherry trees, stone bridges, waterfalls flowing into ponds, swaying foliage, and a sunset lighting pass with bloom and ambient occlusion'
    );
    expect(injection).toContain('IMPLIED requirements');
    expect(injection).toContain('CONTINUITY');
    expect(injection).toContain('source, path, and sink');
    rmSync(dir, { recursive: true, force: true });
  });
});
