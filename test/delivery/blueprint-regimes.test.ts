/**
 * Blueprint quality-regime + art-direction tests (U-I).
 *
 * The ambition/ideation generalization: the Phase 0 blueprint must demand
 * SELF-MEASURABLE numeric regimes (no reference media) and ONE named art
 * direction, parse them tolerantly, render them as binding contract text, and
 * auto-merge the harvested frontier class prior when a rendered-visual task's
 * blueprint declared no regimes of its own.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildBlueprintPrompt,
  formatBlueprintContract,
  generateOutcomeBlueprint,
  maybeBlueprintInjection,
  parseOutcomeBlueprint,
  renderBlueprintMarkdown,
} from '../../src/delivery/outcome-blueprint.js';

const pagodaPrompt =
  'Build a beautiful, fully animated 3D voxel-style pagoda island using Three.js and React.';
const apiPrompt = 'Add a health-check endpoint to the REST API returning JSON status codes.';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'uap-blueprint-regimes-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const minimalPayload = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    summary: 'flagship scene',
    subsystems: [{ name: 'scene', purpose: 'render the island', keyArtifacts: ['scene.ts'] }],
    fidelityTargets: ['>= 45k voxels'],
    runtimeInvariants: [],
    verificationPerspectives: [],
    antiPatterns: [],
    ...over,
  });

describe('blueprint prompt (the generalized demand)', () => {
  it('demands self-measured regimes and exactly one art stance', () => {
    const p = buildBlueprintPrompt(pagodaPrompt);
    expect(p).toContain('"qualityRegimes"');
    expect(p).toContain('"artDirection"');
    expect(p).toContain('NO reference media is required');
    expect(p).toContain('exactly ONE named ideation stance');
    expect(p).toContain('restrained-premium');
    expect(p).toContain('theatrical-premium');
    // the ideation codex principles the frontier panels demonstrated
    for (const principle of [
      'composition hierarchy',
      'depth layering',
      'light story',
      'motion hierarchy',
      'detail gradient',
      'palette discipline',
    ]) {
      expect(p).toContain(principle);
    }
  });

  it('the direct-mode injection teaches regimes + stance without a blueprint executor', () => {
    const text = maybeBlueprintInjection(
      tmp,
      'Build a fully animated 3D voxel pagoda island scene with Three.js and React, detailed at every zoom level, with drifting petals and glowing lanterns'
    );
    expect(text).toContain('SELF-MEASURABLE quality regimes');
    expect(text).toContain('ONE named art direction');
    expect(text).toContain('no reference media needed');
  });
});

describe('blueprint parsing (tolerant, binding)', () => {
  it('parses regimes + art direction, snake_case tolerant', () => {
    const bp = parseOutcomeBlueprint(
      minimalPayload({
        quality_regimes: [
          { axis: 'edgeFrac', range: '>= 0.09', how_measured: 'uap quality gap on own capture' },
        ],
        art_direction: {
          stance: 'restrained-premium',
          principles: ['one focal mass', 'depth layering', 'single light story'],
        },
      })
    )!;
    expect(bp.qualityRegimes).toEqual([
      { axis: 'edgeFrac', range: '>= 0.09', howMeasured: 'uap quality gap on own capture' },
    ]);
    expect(bp.artDirection?.stance).toBe('restrained-premium');
    expect(bp.artDirection?.principles).toHaveLength(3);
  });

  it('older payloads without the fields parse unchanged', () => {
    const bp = parseOutcomeBlueprint(minimalPayload())!;
    expect(bp.qualityRegimes).toEqual([]);
    expect(bp.artDirection).toBeUndefined();
  });
});

describe('class-prior auto-merge (the reference-free floor)', () => {
  it('a visual task with no declared regimes gets the frontier prior as binding regimes', async () => {
    const bp = await generateOutcomeBlueprint({
      instruction: pagodaPrompt,
      projectRoot: tmp,
      executor: async () => minimalPayload(),
      persist: false,
    });
    expect(bp!.qualityRegimes).toHaveLength(7);
    const axes = bp!.qualityRegimes!.map((q) => q.axis);
    expect(axes).toContain('darkFrac');
    expect(axes).toContain('edgeFrac');
    const dark = bp!.qualityRegimes!.find((q) => q.axis === 'darkFrac')!;
    expect(dark.range).toBe('<= 0.02085');
    expect(dark.howMeasured).toContain('class prior');
    expect(dark.howMeasured).toContain('never a reference');
  });

  it('declared regimes are never overwritten by the prior', async () => {
    const bp = await generateOutcomeBlueprint({
      instruction: pagodaPrompt,
      projectRoot: tmp,
      executor: async () =>
        minimalPayload({
          qualityRegimes: [{ axis: 'fps', range: '>= 55', howMeasured: 'runtime sampler' }],
        }),
      persist: false,
    });
    expect(bp!.qualityRegimes).toHaveLength(1);
    expect(bp!.qualityRegimes![0].axis).toBe('fps');
  });

  it('non-visual tasks get no auto-merge', async () => {
    const bp = await generateOutcomeBlueprint({
      instruction: apiPrompt,
      projectRoot: tmp,
      executor: async () => minimalPayload(),
      persist: false,
    });
    expect(bp!.qualityRegimes).toEqual([]);
  });
});

describe('contract + markdown rendering (binding surfaces)', () => {
  it('the contract composer carries regimes and stance into the loop prompt', () => {
    const bp = parseOutcomeBlueprint(
      minimalPayload({
        qualityRegimes: [{ axis: 'glowFrac', range: '0.005..0.34', howMeasured: 'quality gap' }],
        artDirection: { stance: 'theatrical-premium', principles: ['bold focal glow'] },
      })
    )!;
    const contract = formatBlueprintContract(bp);
    expect(contract).toContain('Quality regimes (SELF-MEASURED and binding');
    expect(contract).toContain('glowFrac: 0.005..0.34');
    expect(contract).toContain('Art direction — ONE stance');
    expect(contract).toContain('theatrical-premium');
  });

  it('the persisted markdown renders both sections', () => {
    const bp = parseOutcomeBlueprint(
      minimalPayload({
        qualityRegimes: [{ axis: 'colors12', range: '>= 886', howMeasured: 'quality gap' }],
        artDirection: { stance: 'restrained-premium', principles: ['negative space'] },
      })
    )!;
    const md = renderBlueprintMarkdown(bp);
    expect(md).toContain('## Quality Regimes (self-measured, binding — no reference media)');
    expect(md).toContain('**colors12**: >= 886');
    expect(md).toContain('## Art Direction (one stance, applied consistently)');
    expect(md).toContain('**Stance**: restrained-premium');
  });
});
